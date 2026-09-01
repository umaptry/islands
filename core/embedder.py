"""Sentence embeddings for the map.

Two backends:

  GeminiEmbedder  — production. Calls the Gemini API (gemini-embedding-2) with
                    Matryoshka truncation to 384 dims. Active when GEMINI_API_KEY
                    is set.

  OnnxEmbedder    — test fallback. multilingual-e5-small via ONNX Runtime, no
                    network required. Active when GEMINI_API_KEY is absent.

Both expose the same `encode(sentences, normalize_embeddings=True)` interface so
core/features.py does not care which backend it is talking to.
"""

import os
import re
import time

import numpy as np


# =========================================================================
# Gemini
# =========================================================================

GEMINI_RETRIES = 8
GEMINI_BACKOFF = 2.0
GEMINI_BATCH = 20
GEMINI_BATCH_DELAY = 13.0


class GeminiEmbedder:
    """Gemini API embeddings via REST (httpx). Bypasses the SDK's internal
    tenacity retry so we have full control over rate-limit pacing."""

    _API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:embedContent"

    def __init__(self, api_key, model="gemini-embedding-2", dimensions=384,
                 task="sentence similarity"):
        import httpx

        self._api_key = api_key
        self._model = model
        self._dimensions = dimensions
        self._task = task
        self._http = httpx.Client(timeout=120)

    def _prompt(self, text):
        return f"task: {self._task} | query: {text}"

    def _call_batch(self, chunk):
        prompted = [self._prompt(s) for s in chunk]
        body = {
            "requests": [
                {
                    "model": f"models/{self._model}",
                    "content": {"parts": [{"text": text}]},
                    "outputDimensionality": self._dimensions,
                }
                for text in prompted
            ],
        }
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self._model}:batchEmbedContents?key={self._api_key}"
        )

        last_error = None
        for attempt in range(GEMINI_RETRIES):
            resp = self._http.post(url, json=body)
            if resp.status_code == 200:
                data = resp.json()
                values = [emb["values"] for emb in data["embeddings"]]
                if len(values) != len(chunk):
                    raise RuntimeError(
                        f"{len(chunk)} 件送って {len(values)} 本返りました。"
                        "集約されている可能性があります。"
                    )
                return values

            if resp.status_code == 400:
                raise ValueError(resp.text[:200])

            last_error = resp.text
            if attempt == GEMINI_RETRIES - 1:
                break
            hint = re.search(r'"retryDelay"\s*:\s*"([\d.]+)s"', resp.text)
            delay = float(hint.group(1)) if hint else GEMINI_BACKOFF * (2 ** attempt)
            if resp.status_code == 429:
                delay = max(delay, 60)
            print(
                f"[embedder] Gemini API {resp.status_code} ({attempt + 1}/{GEMINI_RETRIES}): "
                f"{delay:.0f}秒後に再試行します。",
                flush=True,
            )
            time.sleep(delay)

        raise RuntimeError(
            f"Gemini API への {GEMINI_RETRIES} 回の試行がすべて失敗しました: {last_error}"
        )

    def encode(self, sentences, normalize_embeddings=True, **_):
        if isinstance(sentences, str):
            sentences = [sentences]

        all_values = []
        for i, start in enumerate(range(0, len(sentences), GEMINI_BATCH)):
            if i > 0:
                time.sleep(GEMINI_BATCH_DELAY)
            all_values.extend(self._call_batch(sentences[start:start + GEMINI_BATCH]))

        pooled = np.array(all_values, dtype=np.float32)
        if normalize_embeddings:
            pooled = pooled / np.clip(
                np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12, None
            )
        return pooled


# =========================================================================
# ONNX (test fallback)
# =========================================================================

ONNX_MODEL_NAME = "intfloat/multilingual-e5-small"
ONNX_MODEL_REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3"
ONNX_FILE = "onnx/model.onnx"
TOKENIZER_FILE = "tokenizer.json"
MAX_LENGTH = 512
PAD_ID = 1
PAD_TOKEN = "<pad>"
DEFAULT_BATCH = 16

DOWNLOAD_ATTEMPTS = 4
DOWNLOAD_BACKOFF = 2.0


def _fetch(repo_id, filename, revision=ONNX_MODEL_REVISION):
    delay = DOWNLOAD_BACKOFF
    for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
        try:
            from huggingface_hub import hf_hub_download
            return hf_hub_download(repo_id, filename, revision=revision)
        except Exception as error:
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
    """Deterministic sentence embeddings via ONNX Runtime."""

    def __init__(self, repo_id=ONNX_MODEL_NAME, threads=1, batch_size=DEFAULT_BATCH):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        tokenizer_path = _fetch(repo_id, TOKENIZER_FILE)
        self.tokenizer = Tokenizer.from_file(tokenizer_path)
        self.tokenizer.enable_padding(pad_id=PAD_ID, pad_token=PAD_TOKEN)
        self.tokenizer.enable_truncation(max_length=MAX_LENGTH)

        options = ort.SessionOptions()
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
        weights = mask[..., None].astype(np.float32)
        return (hidden * weights).sum(axis=1) / np.clip(weights.sum(axis=1), 1e-9, None)

    def encode(self, sentences, normalize_embeddings=True, show_progress_bar=False, **_):
        if isinstance(sentences, str):
            sentences = [sentences]
        prefixed = [f"passage: {s}" for s in sentences]
        chunks = [
            self._forward(list(prefixed[start:start + self.batch_size]))
            for start in range(0, len(prefixed), self.batch_size)
        ]
        pooled = np.vstack(chunks) if chunks else np.zeros((0, 384), dtype=np.float32)
        if normalize_embeddings:
            pooled = pooled / np.clip(
                np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12, None
            )
        return pooled.astype(np.float32)


# =========================================================================
# Factory
# =========================================================================

def load_embedder(**kwargs):
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if api_key:
        return GeminiEmbedder(api_key=api_key)
    return OnnxEmbedder(**kwargs)
