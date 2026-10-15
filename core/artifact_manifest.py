"""Versioned contract between the embedder, preprocessing and frozen map."""
import hashlib
import json
from pathlib import Path

from core.config import FEATURE_CONFIG

FILES = ("seed_map.json", "encoder.npz", "vectorizers.pkl")
# A map placed by its seeds (core.placement) also ships their map-view vectors.
SEED_VECTORS = "seed_vectors.npy"
PREPROCESSING = "hybrid-raw35-concept65-dense65-sparse35-v1"

# 1: the encoder reads the stored vector itself. 2 (2026-10-15): it reads
# core.similarity.map_view of it, through the centroid in seed_map.json. The
# stored vector and its embedding cache are the same in both, so PREPROCESSING
# does not move; the schema does, so code older than map_view - which accepts
# only 1 - refuses a version-2 map loudly instead of feeding its encoder the
# wrong vector and placing every post somewhere plausible and wrong.
SCHEMA_STORED_VECTOR = 1
SCHEMA_MAP_VIEW = 2


def digest(path):
    with open(path, "rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def embedding_spec(provider="onnx"):
    from core.embedder import ONNX_MODEL_NAME, ONNX_MODEL_REVISION
    from core.config import GEMINI_MODEL_NAME, GEMINI_DIMENSIONS, GEMINI_TASK
    if provider not in ("onnx", "gemini"):
        raise ValueError("EMBEDDING_PROVIDER must be onnx or gemini")
    return {
        "provider": provider,
        "model": GEMINI_MODEL_NAME if provider == "gemini" else ONNX_MODEL_NAME,
        "dimensions": GEMINI_DIMENSIONS if provider == "gemini" else 384,
        "task": GEMINI_TASK if provider == "gemini" else "passage",
        "revision": None if provider == "gemini" else ONNX_MODEL_REVISION,
        "preprocessing": PREPROCESSING,
    }


def write_manifest(directory, spec):
    directory = Path(directory)
    seed = json.loads((directory / "seed_map.json").read_text(encoding="utf-8"))
    from core.similarity import reads_map_view
    schema = SCHEMA_MAP_VIEW if reads_map_view(seed.get("cosine_centroid")) else SCHEMA_STORED_VECTOR
    manifest = {
        "schema_version": schema, "artifact_version": seed["meta"]["model_version"],
        "embedding": spec, "feature_config": FEATURE_CONFIG,
        "feature_dimensions": seed["meta"]["feature_dim"],
        "files": {name: digest(directory / name) for name in FILES + ((SEED_VECTORS,) if (directory / SEED_VECTORS).exists() else ())},
    }
    target = directory / "manifest.json"
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(target)
    return manifest


def validate_manifest(directory, provider):
    directory = Path(directory)
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema_version") not in (SCHEMA_STORED_VECTOR, SCHEMA_MAP_VIEW) \
            or not manifest.get("artifact_version"):
        raise RuntimeError("Unsupported or unversioned artifact manifest")
    if manifest["embedding"] != embedding_spec(provider):
        raise RuntimeError("Embedding backend does not match the artifact manifest")
    if manifest["feature_config"] != FEATURE_CONFIG or manifest["feature_dimensions"] != 448:
        raise RuntimeError("Feature configuration does not match the artifact manifest")
    for name in sorted(set(FILES) | set(manifest["files"])):
        if not (directory / name).is_file():
            raise RuntimeError(f"Artifact file missing: {name}")
        if manifest["files"].get(name) != digest(directory / name):
            raise RuntimeError(f"Artifact checksum mismatch: {name}")
    seed = json.loads((directory / "seed_map.json").read_text(encoding="utf-8"))
    if seed["meta"]["embedding_model"] != manifest["embedding"]["model"]:
        raise RuntimeError("Seed embedding model does not match manifest")
    if seed["meta"]["model_version"] != manifest["artifact_version"]:
        raise RuntimeError("Seed map version does not match manifest")
    from core.similarity import reads_map_view
    if reads_map_view(seed.get("cosine_centroid")) != (manifest["schema_version"] == SCHEMA_MAP_VIEW):
        raise RuntimeError("Manifest schema does not match how the seed map's encoder reads vectors")
    placed_by_seeds = (seed.get("placement") or {}).get("method") == "seed_mode"
    if placed_by_seeds and (SEED_VECTORS not in manifest["files"] or manifest["schema_version"] != SCHEMA_MAP_VIEW):
        raise RuntimeError("A map placed by its seeds needs seed_vectors.npy and the map view")
    return manifest
