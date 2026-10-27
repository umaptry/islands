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
from core.features import build_hybrid_features, use_preprocessing
from core.similarity import map_view, reads_map_view, similarity_view
from core.placement import place_by_seeds, placement_spots
from benchmark_embeddings import score_probe


# Posts on one topic in different stances - did it, do it, want to, looking for somebody
# who can (scripts/probe_stances.jsonl) - should stand together, not with other topics in
# the same stance. A candidate map must reach these shares on its own, whatever the baseline
# does (2026-10-28: the islands-gemini-20261016-v6 map reached 0.79 and 0.75, its stop-word
# rebuild islands-gemini-20261028-v7 FIXME).
STANCE_FLOORS = {"topic_top3": 0.85, "map_topic_nearest": 0.85}


def stance_scores(vectors, coords, topics):
    """Of each post's three nearest in meaning, and of its nearest on the map, the share on
    its own topic."""
    vectors = np.asarray(vectors, dtype=float)
    vectors = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
    similarity = vectors @ vectors.T
    np.fill_diagonal(similarity, -np.inf)
    nearest_three = np.argsort(-similarity, axis=1)[:, :3]
    distances = ((coords[:, None, :] - coords[None, :, :]) ** 2).sum(axis=2)
    np.fill_diagonal(distances, np.inf)
    return {"topic_top3": float(np.mean(topics[nearest_three] == topics[:, None])),
            "map_topic_nearest": float(np.mean(topics[distances.argmin(axis=1)] == topics))}


def evaluate(directory, provider, texts, labels, cache, stances=None):
    directory = Path(directory)
    manifest = validate_manifest(directory, provider)
    use_preprocessing(manifest["embedding"]["preprocessing"])   # this map's stop words
    seed = json.loads((directory / "seed_map.json").read_text(encoding="utf-8"))
    if provider == "gemini" and seed["meta"].get("quality_checked") is not True:
        raise RuntimeError("Gemini build must pass all four gates without --fast")
    model = load_embedder(provider=provider)
    if provider == "gemini":
        model = CachedEmbedder(model, SQLiteEmbeddingCache(cache), manifest["embedding"])
    with (directory / "vectorizers.pkl").open("rb") as handle:
        sparse = pickle.load(handle)
    encoder, _ = load_encoder(directory / "encoder.npz")
    centroid = seed.get("cosine_centroid")
    placement = seed.get("placement") or {}

    def read(texts):
        """(vectors in the space the map is scored in, where the map puts them)."""
        vectors, _, zero, _ = build_hybrid_features(texts, model, fit_sparse=False, sparse_artifacts=sparse)
        if zero:
            raise RuntimeError("Evaluation contains empty feature rows")
        raw_vectors = vectors
        # Each map is scored in the space it serves: its 似てる度 view for the
        # feature metrics, and for the map whatever its encoder actually reads.
        if reads_map_view(centroid):
            vectors = map_view(vectors, centroid)
        elif centroid:
            vectors = np.array([similarity_view(vector, centroid) for vector in vectors])
        if placement.get("method") == "seed_mode":
            coords = place_by_seeds(vectors, np.load(directory / "seed_vectors.npy").astype(float),
                                    placement_spots(seed), k=placement["k"],
                                    temperature=placement["temperature"], bandwidth=placement["bandwidth"])
        else:
            coords = encoder(vectors if reads_map_view(centroid) else raw_vectors)
        return vectors, coords

    partners = min(int(np.sum(labels == label)) - 1 for label in set(labels))
    if partners < 1 or len(set(labels)) < 2:
        raise RuntimeError("Evaluation needs multiple topics with at least two examples each")
    vectors, coords = read(texts)
    score = score_probe(vectors, labels, partners)
    distances = ((coords[:, None, :] - coords[None, :, :]) ** 2).sum(axis=2)
    np.fill_diagonal(distances, np.inf)
    neighbors = np.argsort(distances, axis=1)[:, :partners]
    score["map_precision_at_k"] = float(np.mean(labels[neighbors] == labels[:, None]))
    result = {"manifest_sha256": digest(directory / "manifest.json"), "version": manifest["artifact_version"],
              "metrics": {k: score[k] for k in ("auc", "top1", "precision_at_k", "map_precision_at_k")}}
    if stances:
        result["stances"] = stance_scores(*read([row["text"] for row in stances]),
                                          np.asarray([row["topic"] for row in stances]))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", default="artifacts")
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--corpus", default=str(ROOT / "scripts/probe_topics.jsonl"))
    parser.add_argument("--stances", default=str(ROOT / "scripts/probe_stances.jsonl"))
    parser.add_argument("--cache", default=str(ROOT / ".cache/embeddings.sqlite3"))
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    if output.exists():
        raise FileExistsError("Choose a new quality report path")
    records = [json.loads(line) for line in Path(args.corpus).read_text(encoding="utf-8").splitlines() if line.strip()]
    texts = [row["text"] for row in records]
    labels = np.asarray([row["domain"] for row in records])
    stances = [json.loads(line) for line in Path(args.stances).read_text(encoding="utf-8").splitlines() if line.strip()]
    baseline = evaluate(args.baseline, "onnx", texts, labels, args.cache, stances)
    candidate = evaluate(args.candidate, "gemini", texts, labels, args.cache, stances)
    passed = all(np.isfinite(value) and value >= baseline["metrics"][name]
                 for name, value in candidate["metrics"].items())
    passed = passed and all(candidate["stances"][name] >= floor for name, floor in STANCE_FLOORS.items())
    report = {"corpus_sha256": digest(args.corpus), "samples": len(texts), "baseline": baseline,
              "candidate": candidate, "stances_sha256": digest(args.stances), "stance_floors": STANCE_FLOORS,
              "passed": bool(passed)}
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, allow_nan=False)
    print(json.dumps(report, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
