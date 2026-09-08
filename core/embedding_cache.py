"""Server-only persistent cache, keyed by model contract and exact input text."""
import hashlib
import json
import sqlite3
import threading
from pathlib import Path

import numpy as np


class SQLiteEmbeddingCache:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.lock = threading.RLock()
        self.db.execute("CREATE TABLE IF NOT EXISTS embeddings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self.db.commit()

    def get_embedding(self, key):
        with self.lock:
            row = self.db.execute("SELECT value FROM embeddings WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def put_embedding(self, key, value):
        with self.lock:
            self.db.execute("INSERT OR IGNORE INTO embeddings VALUES (?, ?)", (key, json.dumps(value)))
            self.db.commit()
            return self.get_embedding(key)


class CachedEmbedder:
    def __init__(self, model, cache, spec):
        self.model, self.cache = model, cache
        self.prefix = json.dumps(spec, sort_keys=True, separators=(",", ":"))

    def encode(self, sentences, normalize_embeddings=True, **kwargs):
        if isinstance(sentences, str):
            sentences = [sentences]
        keys = [hashlib.sha256((self.prefix + "\0" + text).encode()).hexdigest() for text in sentences]
        values = {key: self.cache.get_embedding(key) for key in dict.fromkeys(keys)}
        missing = {key: text for key, text in zip(keys, sentences) if values[key] is None}
        entries = list(missing.items())
        # Persist each completed batch so a build can resume after a rate limit.
        for start in range(0, len(entries), 20):
            batch = entries[start:start + 20]
            encoded = self.model.encode([text for _, text in batch], normalize_embeddings=True, **kwargs)
            for (key, _), value in zip(batch, encoded):
                values[key] = self.cache.put_embedding(key, value.tolist())
        from core.embedder import EmbeddingUnavailable
        try:
            result = np.asarray([values[key] for key in keys], dtype=np.float32).reshape((-1, 384))
        except (TypeError, ValueError) as exc:
            raise EmbeddingUnavailable("保存済み埋め込みの形式が不正です。") from exc
        if not np.isfinite(result).all() or (np.linalg.norm(result, axis=1) == 0).any():
            raise EmbeddingUnavailable("保存済み埋め込みの値が不正です。")
        return result
