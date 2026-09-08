"""Versioned contract between the embedder, preprocessing and frozen map."""
import hashlib
import json
from pathlib import Path

from core.config import FEATURE_CONFIG

FILES = ("seed_map.json", "encoder.npz", "vectorizers.pkl")
PREPROCESSING = "hybrid-raw35-concept65-dense65-sparse35-v1"


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
    manifest = {
        "schema_version": 1, "artifact_version": seed["meta"]["model_version"],
        "embedding": spec, "feature_config": FEATURE_CONFIG,
        "feature_dimensions": seed["meta"]["feature_dim"],
        "files": {name: digest(directory / name) for name in FILES},
    }
    target = directory / "manifest.json"
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(target)
    return manifest


def validate_manifest(directory, provider):
    directory = Path(directory)
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema_version") != 1 or not manifest.get("artifact_version"):
        raise RuntimeError("Unsupported or unversioned artifact manifest")
    if manifest["embedding"] != embedding_spec(provider):
        raise RuntimeError("Embedding backend does not match the artifact manifest")
    if manifest["feature_config"] != FEATURE_CONFIG or manifest["feature_dimensions"] != 448:
        raise RuntimeError("Feature configuration does not match the artifact manifest")
    for name in FILES:
        if manifest["files"].get(name) != digest(directory / name):
            raise RuntimeError(f"Artifact checksum mismatch: {name}")
    seed = json.loads((directory / "seed_map.json").read_text(encoding="utf-8"))
    if seed["meta"]["embedding_model"] != manifest["embedding"]["model"]:
        raise RuntimeError("Seed embedding model does not match manifest")
    if seed["meta"]["model_version"] != manifest["artifact_version"]:
        raise RuntimeError("Seed map version does not match manifest")
    return manifest
