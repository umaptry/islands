"""multilingual-e5-small via ONNX Runtime, replacing sentence-transformers.

Why: sentence-transformers pulls torch, which costs ~570MB of resident memory
before a single embedding is computed and pushes the container past every
free hosting tier. ONNX Runtime plus the model that intfloat publishes in the
same repo does the same job far more cheaply.

Why fp32 and not the int8 build, which would be four times smaller: measured on
300 seed texts against sentence-transformers,

    fp32  cosine 1.00000  15-NN overlap 1.0000  nearest-neighbour match 1.000
    int8  cosine 0.99563  15-NN overlap 0.8138  nearest-neighbour match 0.713

int8's cosine looks harmless, but it changes who your closest person is 29% of
the time - which is the one thing this app exists to show. fp32 reproduces
sentence-transformers exactly, so the frozen map stays valid with no rebuild.

The `encode` signature deliberately mirrors SentenceTransformer.encode so
core/features.py does not care which backend it is talking to.
"""

import time

import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from tokenizers import Tokenizer

from core.config import MODEL_NAME, MODEL_REVISION

ONNX_FILE = "onnx/model.onnx"
TOKENIZER_FILE = "tokenizer.json"
MAX_LENGTH = 512
PAD_ID = 1
PAD_TOKEN = "<pad>"
DEFAULT_BATCH = 16

# The serving image bakes the weights in and runs with HF_HUB_OFFLINE=1, so in
# production both calls resolve from the local cache and never touch the
# network. The Dockerfile explains why that changed: fetching on first start
# cost two deploys to HTTP 429 from the Hub.
#
# The retry stays for the paths that DO download - a fresh dev checkout, and the
# Docker build itself. A raised exception here is a container that never becomes
# healthy, so a blip should cost twenty seconds rather than the deploy.
DOWNLOAD_ATTEMPTS = 4
DOWNLOAD_BACKOFF = 2.0  # seconds, doubled each attempt


def _fetch(repo_id, filename, revision=MODEL_REVISION):
    delay = DOWNLOAD_BACKOFF
    for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
        try:
            return hf_hub_download(repo_id, filename, revision=revision)
        except Exception as error:  # noqa: BLE001 - network, disk, auth all retryable here
            if attempt == DOWNLOAD_ATTEMPTS:
                raise
            print(
                f"[embedder] {filename} の取得に失敗 ({attempt}/{DOWNLOAD_ATTEMPTS}): "
                f"{type(error).__name__}: {error}. {delay:.0f}秒後に再試行します。",
                flush=True,
            )
            time.sleep(delay)
            delay *= 2


class OnnxEmbedder:
    """Deterministic sentence embeddings. Thread count is pinned on purpose."""

    def __init__(self, repo_id=MODEL_NAME, threads=1, batch_size=DEFAULT_BATCH):
        tokenizer_path = _fetch(repo_id, TOKENIZER_FILE)
        self.tokenizer = Tokenizer.from_file(tokenizer_path)
        self.tokenizer.enable_padding(pad_id=PAD_ID, pad_token=PAD_TOKEN)
        self.tokenizer.enable_truncation(max_length=MAX_LENGTH)

        options = ort.SessionOptions()
        # Pinning threads keeps results bit-stable across machines with
        # different core counts, which matters because the map promises that
        # the same sentence always lands on the same pixel.
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = threads
        self.session = ort.InferenceSession(
            _fetch(repo_id, ONNX_FILE),
            options,
            providers=["CPUExecutionProvider"],
        )
        self.input_names = {node.name for node in self.session.get_inputs()}
        self.batch_size = batch_size

    def _forward(self, batch):
        encoded = self.tokenizer.encode_batch(batch)
        ids = np.array([item.ids for item in encoded], dtype=np.int64)
        mask = np.array([item.attention_mask for item in encoded], dtype=np.int64)
        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in self.input_names:
            feed["token_type_ids"] = np.zeros_like(ids)

        hidden = self.session.run(None, feed)[0]
        # e5 pools by averaging over real tokens only.
        weights = mask[..., None].astype(np.float32)
        return (hidden * weights).sum(axis=1) / np.clip(weights.sum(axis=1), 1e-9, None)

    def encode(self, sentences, normalize_embeddings=True, show_progress_bar=False, **_):
        if isinstance(sentences, str):
            sentences = [sentences]
        chunks = [
            self._forward(list(sentences[start:start + self.batch_size]))
            for start in range(0, len(sentences), self.batch_size)
        ]
        pooled = np.vstack(chunks) if chunks else np.zeros((0, 384), dtype=np.float32)
        if normalize_embeddings:
            pooled = pooled / np.clip(
                np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12, None
            )
        return pooled.astype(np.float32)


def load_embedder(**kwargs):
    return OnnxEmbedder(**kwargs)
