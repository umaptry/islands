"""Calibrate 似てる度 against the seed corpus. Safe to re-run.

    python scripts/build_similarity_calibration.py --dry-run   # numbers only
    python scripts/build_similarity_calibration.py             # write

Unlike build_seed_map.py this script trains NOTHING and moves NO coordinate. It
re-encodes the seed corpus with the vectorizers that are already shipped
(fit_sparse=False, exactly as serving does), measures the distribution of cosine
similarity over all seed pairs, and adds three keys to seed_map.json:

    cosine_centroid the mean direction of the seed corpus's dense block, which
                    似てる度 subtracts before comparing (see `centre` below)
    cosine_floor    a pair this far apart is as unremarkable as the 5th
                    percentile of random seed pairs      -> 似てる度 0
    cosine_ceiling  a pair this close is as close as a typical seed document
                    is to its own nearest neighbour      -> 似てる度 100

The anchors are stamped with the space they were measured in, and core.similarity
only centres when it sees that stamp, so the ruler and the space cannot come
apart across artifact versions.

Every other key in seed_map.json is copied through untouched. Verified: the
features rebuilt here reproduce the shipped seed coordinates to within 0.005px,
so these cosines are the same ones serving computes.

Why this exists at all: 似てる度 used to be read off the 2-D map distance. The
map is a 2-D shadow of a 448-dim space and this build's own gate records that
only 34% of true neighbours survive the projection (meta.gates.generalization,
achieved=0.3422). Measured on four topic groups of three people each, ranking by
2-D distance put a different topic at the top for 3 of 12 people; ranking by
448-dim cosine got 12 of 12 right. Similarity is now measured before the
squash; the map stays a picture.
"""

import argparse
import json
import pickle
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import build_seed_map as build  # noqa: E402

from core.config import DENSE_WEIGHT, SPARSE_WEIGHT  # noqa: E402
from core.features import build_hybrid_features  # noqa: E402
from core.similarity import (  # noqa: E402
    CENTERED_SPACE,
    QUANTILE_STEPS,
    SPARSE_DIM,
    cosine_percent,
)

# The anchors, as percentiles of the measured seed distribution. Chosen so a
# pair of strangers reads around 18% rather than 0%: a flat 0 next to somebody's
# name is a harsher thing to show than the difference is worth.
FLOOR_PERCENTILE = 5.0  # of all seed pairs
CEILING_PERCENTILE = 50.0  # of each seed's nearest-neighbour cosine

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def seed_features():
    """The 448-dim vectors for the seed corpus, built the way serving builds them."""
    from core.embedder import load_embedder

    texts, _domains = build.load_corpus(build.CORPUS_PATH)
    print(f"[1/3] コーパス読み込み: {len(texts)} 件")

    with open(build.VECTORIZERS_PICKLE, "rb") as handle:
        sparse_artifacts = pickle.load(handle)

    print("[2/3] 448次元ベクトルを再構築中（学習はしません / fit_sparse=False）...")
    features, _tokens, zero_rows, _ = build_hybrid_features(
        texts, load_embedder(), fit_sparse=False, sparse_artifacts=sparse_artifacts
    )
    if zero_rows:
        raise SystemExit(f"[NG] 内容語が残らない行が {zero_rows} 件あります。")
    return features


def centre(features):
    """The seed centroid, and the features re-expressed relative to it.

    multilingual-e5-small is anisotropic: 90% of the dense block's pairwise
    cosines land between 0.847 and 0.905, a cone 0.058 wide. Nothing is
    distinguished in there, which left the 64-dim sparse block deciding roughly
    72% of the spread in 似てる度 while keeping only 13% of the TF-IDF variance.
    Subtracting the centroid removes the shared direction the crowding is made
    of and reopens the scale (usable range 0.231 -> 0.574).

    This moves NO coordinate. The map is drawn from the uncentred vector by a
    frozen encoder and never sees this function; only 似てる度 does.
    """
    dense = normalise(features[:, :-SPARSE_DIM])
    sparse = normalise(features[:, -SPARSE_DIM:])
    dense_mean = dense.mean(axis=0)

    residual = normalise(dense - dense_mean)
    centred = normalise(np.hstack([residual * DENSE_WEIGHT, sparse * SPARSE_WEIGHT]))
    centroid = {
        "dense_mean": [round(float(value), 8) for value in dense_mean],
        "dense_dim": int(dense.shape[1]),
        "sparse_dim": int(SPARSE_DIM),
        "seed_count": int(len(features)),
    }
    return centroid, centred


def normalise(matrix):
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return matrix / np.where(norms == 0.0, 1.0, norms)


def measure(features):
    """Anchors plus the full quantile table, from every seed pair."""
    gram = features @ features.T
    upper = np.triu_indices(len(features), k=1)
    pairs = gram[upper]

    np.fill_diagonal(gram, -2.0)
    nearest = gram.max(axis=1)

    anchors = {
        "cosine_floor": round(float(np.percentile(pairs, FLOOR_PERCENTILE)), 6),
        "cosine_ceiling": round(float(np.percentile(nearest, CEILING_PERCENTILE)), 6),
        "floor_percentile": FLOOR_PERCENTILE,
        "ceiling_percentile": CEILING_PERCENTILE,
        "pair_count": int(len(pairs)),
        # Says which space these two numbers were measured in. core.similarity
        # only centres when it sees this, so an artifact can never end up
        # reading a centred cosine off an uncentred ruler.
        "space": CENTERED_SPACE,
    }
    quantiles = [
        round(float(value), 6)
        for value in np.percentile(pairs, np.linspace(0.0, 100.0, QUANTILE_STEPS))
    ]
    return anchors, quantiles, pairs, nearest


def report(anchors, quantiles, pairs, nearest):
    print(f"      全ペア数: {anchors['pair_count']:,}")
    print("      全ペアのコサイン   p5 %.4f  p50 %.4f  p95 %.4f  p100 %.4f"
          % tuple(np.percentile(pairs, [5, 50, 95, 100])))
    print("      最近傍のコサイン   p5 %.4f  p50 %.4f  p95 %.4f"
          % tuple(np.percentile(nearest, [5, 50, 95])))
    print()
    print("      cosine_floor   = %.6f  -> 似てる度 0"   % anchors["cosine_floor"])
    print("      cosine_ceiling = %.6f  -> 似てる度 100" % anchors["cosine_ceiling"])
    print()
    sample = np.random.default_rng(42).choice(pairs, min(40_000, len(pairs)), replace=False)
    spread = np.array([cosine_percent(value, anchors) for value in sample])
    print("      この目盛りでのシード全ペアの分布: p25 %d%%  p50 %d%%  p75 %d%%  p95 %d%%"
          % tuple(np.percentile(spread, [25, 50, 75, 95]).astype(int)))
    near = np.array([cosine_percent(value, anchors) for value in nearest])
    print("      シードの最近傍ペアの分布:         p25 %d%%  p50 %d%%  p75 %d%%"
          % tuple(np.percentile(near, [25, 50, 75]).astype(int)))


# Everything the map is made of. If any of these changed, points would move.
FROZEN_KEYS = ("meta", "scale_bounds", "islands", "seed", "distance_quantiles", "idf")


def write(anchors, quantiles, centroid):
    with open(build.SEED_MAP_JSON, encoding="utf-8") as handle:
        payload = json.load(handle)

    before = {key: json.dumps(payload.get(key), ensure_ascii=False, sort_keys=True)
              for key in FROZEN_KEYS}
    payload["cosine_anchors"] = anchors
    payload["cosine_quantiles"] = quantiles
    payload["cosine_centroid"] = centroid
    after = {key: json.dumps(payload.get(key), ensure_ascii=False, sort_keys=True)
             for key in FROZEN_KEYS}
    changed = [key for key in FROZEN_KEYS if before[key] != after[key]]
    if changed:  # cannot happen; the assert is the point
        raise SystemExit(f"[NG] 地図側のキーが変化しました: {changed}。書き込みを中止します。")

    build.atomic_write(
        build.SEED_MAP_JSON,
        lambda handle: json.dump(payload, handle, ensure_ascii=False, separators=(",", ":")),
    )
    print(f"      {build.SEED_MAP_JSON.name} に cosine_anchors / cosine_quantiles / "
          "cosine_centroid を追記しました")
    print("      地図側のキー（meta / scale_bounds / islands / seed / distance_quantiles / idf）は無変更です")


def main():
    parser = argparse.ArgumentParser(description="似てる度の目盛りをシードコーパスから校正します")
    parser.add_argument("--dry-run", action="store_true", help="書き込まずに数値だけ出す")
    parser.add_argument("--corpus", help="別のコーパスを使う（開発用）")
    parser.add_argument("--artifacts", help="別の artifacts ディレクトリを使う（開発用）")
    args = parser.parse_args()
    build.use_paths(args.corpus, args.artifacts)

    if not build.CORPUS_PATH.exists():
        print(f"[NG] シードコーパスがありません: {build.CORPUS_PATH}")
        return 1
    if not build.SEED_MAP_JSON.exists() or not build.VECTORIZERS_PICKLE.exists():
        print(f"[NG] artifacts がありません: {build.ARTIFACTS}")
        return 1

    centroid, centred = centre(seed_features())
    anchors, quantiles, pairs, nearest = measure(centred)
    print(f"[3/3] 分布を測定しました（シード{centroid['seed_count']}件の重心で中心化した空間）")
    report(anchors, quantiles, pairs, nearest)

    if args.dry_run:
        print("\n--dry-run のため書き込みません。")
        return 0
    write(anchors, quantiles, centroid)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
