"""Sentence embeddings for the map.

Two backends:

  GeminiEmbedder  — Gemini API (gemini-embedding-2), 384 dimensions.
                    Selected explicitly with EMBEDDING_PROVIDER=gemini.

  OnnxEmbedder    — current distributed E5 map; EMBEDDING_PROVIDER=onnx (default).
                    We never fall back to another model on a provider error.

Both expose the same `encode(sentences, normalize_embeddings=True)` interface so
core/features.py does not care which backend it is talking to.
"""

import os
import re
import time
import threading

import numpy as np


# =========================================================================
# Gemini
# =========================================================================

GEMINI_RETRIES = 3
GEMINI_BACKOFF = 2.0
GEMINI_BATCH = 20
GEMINI_BATCH_DELAY = 0.0


class EmbeddingUnavailable(RuntimeError):
    """Safe public error; never includes provider response bodies or credentials."""


class RequestPacer:
    """Per-process pacing; 429 handling remains necessary across replicas."""

    def __init__(self, requests_per_minute, items_per_minute):
        if requests_per_minute <= 0 or items_per_minute <= 0:
            raise ValueError("Gemini rate limits must be positive")
        self.requests, self.items = requests_per_minute, items_per_minute
        self.next_at = 0.0
        self.lock = threading.Lock()

    def take(self, count, deadline):
        with self.lock:
            now = time.monotonic()
            start = max(now, self.next_at)
            if start >= deadline:
                raise EmbeddingUnavailable("埋め込みの待機上限に達しました。再試行してください。")
            self.next_at = start + max(60 / self.requests, 60 * count / self.items)
        if start > now:
            time.sleep(start - now)


class GeminiEmbedder:
    """Gemini API embeddings via REST (httpx). Bypasses the SDK's internal
    tenacity retry so we have full control over rate-limit pacing."""

    def __init__(self, api_key, model="gemini-embedding-2", dimensions=384,
                 task="sentence similarity"):
        import httpx

        self._api_key = api_key
        self._model = model
        self._dimensions = dimensions
        self._task = task
        self._http = httpx.Client(timeout=20)
        self.provider = "gemini"
        self._pacer = RequestPacer(
            float(os.environ.get("GEMINI_REQUESTS_PER_MINUTE", "60")),
            float(os.environ.get("GEMINI_ITEMS_PER_MINUTE", "90")),
        )

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
            f"{self._model}:batchEmbedContents"
        )

        import httpx
        deadline = time.monotonic() + 45.0
        for attempt in range(GEMINI_RETRIES):
            self._pacer.take(len(chunk), deadline)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                resp = self._http.post(url, json=body, headers={"x-goog-api-key": self._api_key},
                                       timeout=min(12.0, remaining / 4))
            except httpx.TransportError:
                resp = None
            if resp is None:
                if attempt < GEMINI_RETRIES - 1:
                    time.sleep(min(2 ** attempt, max(0, deadline - time.monotonic())))
                continue
            if resp.status_code == 200:
                try:
                    values = np.asarray([emb["values"] for emb in resp.json()["embeddings"]], dtype=np.float32)
                    valid = values.shape == (len(chunk), self._dimensions) and np.isfinite(values).all()
                    norms = np.linalg.norm(values, axis=1) if valid else np.array([])
                    valid = valid and bool(np.isfinite(norms).all() and (norms > 0).all())
                except (KeyError, TypeError, ValueError):
                    valid = False
                if not valid:
                    raise EmbeddingUnavailable("埋め込みの応答形式が不正です。")
                return values

            if resp.status_code not in (429, 500, 502, 503, 504):
                raise EmbeddingUnavailable("埋め込みサービスを利用できません。")

            if attempt == GEMINI_RETRIES - 1:
                break
            hint = re.search(r'"retryDelay"\s*:\s*"([\d.]+)s"', resp.text)
            delay = float(hint.group(1)) if hint else GEMINI_BACKOFF * (2 ** attempt)
            try:
                delay = max(delay, float(resp.headers.get("retry-after", "0")))
            except ValueError:
                pass
            if delay >= deadline - time.monotonic():
                break
            time.sleep(delay)

        raise EmbeddingUnavailable("埋め込みサービスが混み合っています。時間をおいて再試行してください。")

    def encode(self, sentences, normalize_embeddings=True, **_):
        if isinstance(sentences, str):
            sentences = [sentences]

        all_values = []
        for i, start in enumerate(range(0, len(sentences), GEMINI_BATCH)):
            if i > 0:
                time.sleep(GEMINI_BATCH_DELAY)
            all_values.extend(self._call_batch(sentences[start:start + GEMINI_BATCH]))

        pooled = np.array(all_values, dtype=np.float32).reshape((-1, self._dimensions))
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

def load_embedder(provider=None, **kwargs):
    provider = provider or os.environ.get("EMBEDDING_PROVIDER", "onnx")
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if provider == "gemini":
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY is required for EMBEDDING_PROVIDER=gemini")
        return GeminiEmbedder(api_key=api_key)
    if provider == "onnx":
        return OnnxEmbedder(**kwargs)
    raise ValueError("Unknown EMBEDDING_PROVIDER")
