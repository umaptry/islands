"""Compare frozen E5/Gemini pipelines using the same labelled evaluation corpus."""
import argparse
import json
import pickle
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from core.embedder import load_embedder
import numpy as np
from core.artifact_manifest import validate_manifest, digest
from core.embedding_cache import CachedEmbedder, SQLiteEmbeddingCache
from core.encoder import load_encoder
from core.features import build_hybrid_features
from benchmark_embeddings import score_probe


def evaluate(directory, provider, texts, labels, cache):
    directory = Path(directory)
    manifest = validate_manifest(directory, provider)
    seed = json.loads((directory / "seed_map.json").read_text(encoding="utf-8"))
    if provider == "gemini" and seed["meta"].get("quality_checked") is not True:
        raise RuntimeError("Gemini build must pass all four gates without --fast")
    model = load_embedder(provider=provider)
    if provider == "gemini":
        model = CachedEmbedder(model, SQLiteEmbeddingCache(cache), manifest["embedding"])
    with (directory / "vectorizers.pkl").open("rb") as handle:
        sparse = pickle.load(handle)
    vectors, _, zero, _ = build_hybrid_features(texts, model, fit_sparse=False, sparse_artifacts=sparse)
    if zero:
        raise RuntimeError("Evaluation contains empty feature rows")
    partners = min(int(np.sum(labels == label)) - 1 for label in set(labels))
    if partners < 1 or len(set(labels)) < 2:
        raise RuntimeError("Evaluation needs multiple topics with at least two examples each")
    score = score_probe(vectors, labels, partners)
    encoder, _ = load_encoder(directory / "encoder.npz")
    coords = encoder(vectors)
    distances = ((coords[:, None, :] - coords[None, :, :]) ** 2).sum(axis=2)
    np.fill_diagonal(distances, np.inf)
    neighbors = np.argsort(distances, axis=1)[:, :partners]
    score["map_precision_at_k"] = float(np.mean(labels[neighbors] == labels[:, None]))
    return {"manifest_sha256": digest(directory / "manifest.json"), "version": manifest["artifact_version"],
            "metrics": {k: score[k] for k in ("auc", "top1", "precision_at_k", "map_precision_at_k")}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", default="artifacts")
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--corpus", default=str(ROOT / "scripts/probe_topics.jsonl"))
    parser.add_argument("--cache", default=str(ROOT / ".cache/embeddings.sqlite3"))
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    if output.exists():
        raise FileExistsError("Choose a new quality report path")
    records = [json.loads(line) for line in Path(args.corpus).read_text(encoding="utf-8").splitlines() if line.strip()]
    texts = [row["text"] for row in records]
    labels = np.asarray([row["domain"] for row in records])
    baseline = evaluate(args.baseline, "onnx", texts, labels, args.cache)
    candidate = evaluate(args.candidate, "gemini", texts, labels, args.cache)
    passed = all(np.isfinite(value) and value >= baseline["metrics"][name]
                 for name, value in candidate["metrics"].items())
    report = {"corpus_sha256": digest(args.corpus), "samples": len(texts), "baseline": baseline,
              "candidate": candidate, "passed": bool(passed)}
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, allow_nan=False)
    print(json.dumps(report, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
