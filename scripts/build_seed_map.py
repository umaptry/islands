"""Build the frozen map. Run this ONCE.

Running it again re-runs the teacher UMAP and retrains the encoder, which moves
every coordinate on the map. Anyone who already joined would find themselves
somewhere else. Treat artifacts/ as immutable once the demo is live.

    python scripts/build_seed_map.py            # build
    python scripts/build_seed_map.py --verify   # re-check a build without touching it

Pipeline (following pokeDB's build_map_data):

    seed texts -> 448-dim hybrid features
               -> teacher UMAP, run once, discarded afterwards
               -> encoder f trained to reproduce it, then frozen
               -> isotropic scale into a 0-1000 box
               -> k-means over the resulting coordinates -> islands
               -> word-pair labels per island
"""

import argparse
import io
import json
import os
import pickle
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from core.clustering import select_cluster_model, sort_clusters_by_position  # noqa: E402
from core.config import (  # noqa: E402
    FEATURE_CONFIG,
    GEMINI_MODEL_NAME,
    LAYOUT_CONFIG,
    LAYOUT_VERSION,
    MODEL_VERSION,
)
from core.encoder import load_encoder, save_encoder  # noqa: E402
from core.features import build_hybrid_features, extract_label_terms  # noqa: E402
from core.geometry import (  # noqa: E402
    dejitter_exact_overlaps,
    isotropic_scale_coordinates,
    nearest_neighbor_stats,
)
from core.similarity import build_distance_quantiles, build_idf  # noqa: E402

CORPUS_PATH = ROOT / "scripts" / "seed_corpus.jsonl"
ARTIFACTS = ROOT / "artifacts"
SEED_MAP_JSON = ARTIFACTS / "seed_map.json"
VECTORIZERS_PICKLE = ARTIFACTS / "vectorizers.pkl"
ENCODER_NPZ = ARTIFACTS / "encoder.npz"


def use_paths(corpus=None, artifacts=None):
    """Point the build at a different corpus / output directory (used by tests)."""
    global CORPUS_PATH, ARTIFACTS, SEED_MAP_JSON, VECTORIZERS_PICKLE, ENCODER_NPZ
    if corpus:
        CORPUS_PATH = Path(corpus)
    if artifacts:
        ARTIFACTS = Path(artifacts)
        SEED_MAP_JSON = ARTIFACTS / "seed_map.json"
        VECTORIZERS_PICKLE = ARTIFACTS / "vectorizers.pkl"
        ENCODER_NPZ = ARTIFACTS / "encoder.npz"

# Quality gates, identical to pokeDB's.
MAX_MEAN_DRIFT_RATIO = 0.35
MIN_OVERLAP_VS_CEILING = 0.65
MAX_NUMPY_TORCH_DIFF = 1e-5
HOLDOUT_SIZE = 60

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def load_corpus(path):
    texts, domains = [], []
    with io.open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            texts.append(record["text"])
            domains.append((record.get("domain") or "未分類").strip())
    return texts, domains


def atomic_write(path, write_callback, mode="w"):
    """Write via a temp file in the same directory, then replace."""
    directory = os.path.dirname(os.path.abspath(path))
    handle = tempfile.NamedTemporaryFile(
        mode=mode, dir=directory, delete=False,
        **({"encoding": "utf-8", "newline": "\n"} if mode == "w" else {}),
    )
    temporary = handle.name
    try:
        with handle:
            write_callback(handle)
        os.replace(temporary, path)
    except Exception:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


def build(args):
    import train_parametric
    import umap

    from core.embedder import load_embedder

    if not CORPUS_PATH.exists():
        print(f"[NG] シードコーパスがありません: {CORPUS_PATH}")
        print("     先に python scripts/validate_corpus.py で検証してください。")
        return 1

    texts, domains = load_corpus(CORPUS_PATH)
    print(f"[1/8] コーパス読み込み: {len(texts)} 件 / {len(set(domains))} ドメイン")

    _label = f"Gemini API ({GEMINI_MODEL_NAME})" if os.environ.get("GEMINI_API_KEY", "").strip() else "ONNX (e5-small)"
    print(f"[2/8] 埋め込みモデル読み込み: {_label}")
    model = load_embedder()

    print("[3/8] 448次元ベクトルを構築中...")
    features, token_lists, zero_rows, sparse_artifacts = build_hybrid_features(
        texts, model, fit_sparse=True
    )
    if zero_rows:
        print(f"[NG] 内容語が一つも残らない行が {zero_rows} 件あります。ビルドを中断します。")
        print("     python scripts/validate_corpus.py で該当行を特定してください。")
        return 1
    print(f"      shape={features.shape}")

    print("[4/8] 教師UMAPを1回だけ実行中（この結果はお手本として使い、以後破棄）...")
    reducer = umap.UMAP(n_components=2, **LAYOUT_CONFIG)
    reference_coords = reducer.fit_transform(features)

    print("[5/8] エンコーダ f を学習中（448 -> 512 -> 256 -> 128 -> 2）...")
    ab_params = train_parametric._umap_ab(LAYOUT_CONFIG["spread"], LAYOUT_CONFIG["min_dist"])
    encoder, torch_artifacts, train_stats = train_parametric.train_encoder(
        features, reference_coords, graph=None, ab_params=ab_params
    )
    print(f"      {train_stats}")

    predicted = train_parametric.predict(encoder, torch_artifacts, features)
    scaled, scale_bounds = isotropic_scale_coordinates(predicted)
    coords, moved = dejitter_exact_overlaps(scaled)
    print(f"[6/8] 等方スケール: scale={scale_bounds['scale']:.4f} / 完全重複を{moved}点ずらしました")

    print("[7/8] 島を選定中...")
    # Coordinates come from token_lists (nouns + verbs + adjectives); island
    # NAMES come from nouns only. See extract_label_terms.
    label_tokens = [extract_label_terms(text) for text in texts]
    best = select_cluster_model(coords, label_tokens, model)
    cluster_ids, islands = _finalize_islands(best, coords)
    for island in islands:
        print(f"      島{island['id']}: {island['name']}  ({island['size']}件)")

    print("[8/8] 品質ゲートを検証中...")
    gates, passed = run_gates(
        features, reference_coords, encoder, torch_artifacts, train_stats, ab_params,
        skip_holdout=args.fast,
    )
    for name, (ok, detail) in gates.items():
        print(f"      [{'OK' if ok else 'NG'}] {name}: {detail}")
    if not passed:
        print("\n[NG] 品質ゲートを通過しませんでした。artifacts は書き込みません。")
        return 1

    # --- persist -----------------------------------------------------------
    ARTIFACTS.mkdir(exist_ok=True)
    save_encoder(
        ENCODER_NPZ, torch_artifacts["encoder_state_dict"], torch_artifacts["encoder_arch"],
        torch_artifacts["coord_mean"], torch_artifacts["coord_scale"], scale_bounds,
    )
    atomic_write(VECTORIZERS_PICKLE, lambda h: pickle.dump(sparse_artifacts, h), mode="wb")

    payload = {
        "meta": {
            "model_version": MODEL_VERSION,
            "layout_version": LAYOUT_VERSION,
            "embedding_model": GEMINI_MODEL_NAME,
            "feature_config": FEATURE_CONFIG,
            "layout_config": LAYOUT_CONFIG,
            "seed_count": len(texts),
            "feature_dim": int(features.shape[1]),
            "train_stats": train_stats,
            "gates": {name: detail for name, (_, detail) in gates.items()},
            "nearest_neighbor_stats": nearest_neighbor_stats(coords),
        },
        "scale_bounds": scale_bounds,
        "islands": islands,
        # Terrain: coordinates and island only. Seed texts are never published.
        "seed": [
            [round(float(x), 2), round(float(y), 2), int(cluster_id)]
            for (x, y), cluster_id in zip(coords, cluster_ids)
        ],
        "distance_quantiles": build_distance_quantiles(coords),
        "idf": build_idf(token_lists),
    }
    atomic_write(
        SEED_MAP_JSON,
        lambda h: json.dump(payload, h, ensure_ascii=False, separators=(",", ":")),
    )

    print()
    print(f"完了: {SEED_MAP_JSON.name} / {VECTORIZERS_PICKLE.name} / {ENCODER_NPZ.name}")
    print(f"      近傍距離 {payload['meta']['nearest_neighbor_stats']}")
    print("\n*** このスクリプトは今後実行しないでください（実行するとマップが動きます） ***")
    return 0


def _finalize_islands(best, coords):
    """Renumber clusters by position and attach their names and centroids."""
    cluster_ids, _ = sort_clusters_by_position(best["labels"], coords, best["cluster_count"])
    remap = {}
    for old_id in range(best["cluster_count"]):
        members = np.where(best["labels"] == old_id)[0]
        remap[int(cluster_ids[members[0]])] = old_id

    islands = []
    for new_id in range(best["cluster_count"]):
        members = np.where(cluster_ids == new_id)[0]
        centroid = coords[members].mean(axis=0)
        meta = best["keyword_meta"][remap[new_id]]
        islands.append({
            "id": new_id,
            "name": meta["keywords"],
            "top_words": meta["top_words"],
            "cx": round(float(centroid[0]), 2),
            "cy": round(float(centroid[1]), 2),
            "size": int(len(members)),
            "coherence_score": meta["coherence_score"],
        })
    return cluster_ids, islands


def run_gates(features, reference_coords, encoder, torch_artifacts, train_stats, ab_params,
              skip_holdout=False):
    """The checks that decide whether this build is publishable."""
    import train_parametric

    gates = {}

    drift = train_stats["mean_drift_ratio"]
    gates["mean_drift_ratio"] = (
        drift < MAX_MEAN_DRIFT_RATIO, f"{drift} (< {MAX_MEAN_DRIFT_RATIO})"
    )

    # Determinism: the same features must project to bit-identical coordinates.
    first = train_parametric.predict(encoder, torch_artifacts, features[:32])
    second = train_parametric.predict(encoder, torch_artifacts, features[:32])
    identical = bool(np.array_equal(first, second))
    gates["determinism"] = (identical, "同一入力の再実行がビット一致" if identical else "不一致")

    # The numpy encoder used in production must agree with the torch original.
    with tempfile.TemporaryDirectory() as directory:
        path = os.path.join(directory, "check.npz")
        save_encoder(
            path, torch_artifacts["encoder_state_dict"], torch_artifacts["encoder_arch"],
            torch_artifacts["coord_mean"], torch_artifacts["coord_scale"],
            {"center_x": 0.0, "center_y": 0.0, "scale": 1.0, "world_center": 500.0},
        )
        numpy_encoder, _ = load_encoder(path)
        difference = float(np.abs(numpy_encoder(features[:32]) - first).max())
    gates["numpy_matches_torch"] = (
        difference < MAX_NUMPY_TORCH_DIFF, f"max diff {difference:.2e} (< {MAX_NUMPY_TORCH_DIFF:.0e})"
    )

    if skip_holdout:
        gates["generalization"] = (True, "--fast のためスキップ")
    else:
        print("      ホールドアウト検証中（60点を隠して再学習）...")
        result = train_parametric.evaluate_generalization(
            features, reference_coords, LAYOUT_CONFIG["n_neighbors"], ab_params,
            holdout=HOLDOUT_SIZE,
        )
        ratio = result["overlap_vs_ceiling"]
        gates["generalization"] = (
            ratio >= MIN_OVERLAP_VS_CEILING,
            f"overlap_vs_ceiling={ratio} (>= {MIN_OVERLAP_VS_CEILING}), "
            f"achieved={result['holdout_neighborhood_overlap']}, "
            f"ceiling={result['reference_layout_ceiling']}",
        )

    return gates, all(ok for ok, _ in gates.values())


def relabel(_args):
    """Recompute islands and their names from the SAVED coordinates.

    Labels do not feed the encoder, so this never moves a point. Use it to fix a
    bad island name without the 25-minute retrain that build() would cost.
    """
    from core.embedder import load_embedder

    if not SEED_MAP_JSON.exists():
        print(f"[NG] {SEED_MAP_JSON.name} がありません。")
        return 1
    with io.open(SEED_MAP_JSON, encoding="utf-8") as handle:
        payload = json.load(handle)

    texts, _ = load_corpus(CORPUS_PATH)
    if len(texts) != payload["meta"]["seed_count"]:
        print("[NG] コーパスの件数が既存ビルドと一致しません。--relabel は使えません。")
        return 1

    coords = np.array([[row[0], row[1]] for row in payload["seed"]], dtype=float)
    print(f"[1/3] 保存済み座標を読み込み: {len(coords)} 点（座標は一切変更しません）")

    _label = f"Gemini API ({GEMINI_MODEL_NAME})" if os.environ.get("GEMINI_API_KEY", "").strip() else "ONNX (e5-small)"
    print(f"[2/3] 埋め込みモデル読み込み: {_label}")
    model = load_embedder()

    print("[3/3] 島を選び直し中...")
    label_tokens = [extract_label_terms(text) for text in texts]
    best = select_cluster_model(coords, label_tokens, model)
    cluster_ids, islands = _finalize_islands(best, coords)
    for island in islands:
        print(f"      島{island['id']}: {island['name']}  ({island['size']}件)")

    payload["islands"] = islands
    payload["seed"] = [
        [row[0], row[1], int(cluster_id)]
        for row, cluster_id in zip(payload["seed"], cluster_ids)
    ]
    atomic_write(
        SEED_MAP_JSON,
        lambda h: json.dump(payload, h, ensure_ascii=False, separators=(",", ":")),
    )
    print()
    print(f"完了: {SEED_MAP_JSON.name} の島情報のみ更新しました。座標は不変です。")
    return 0


def verify(_args):
    """Re-check an existing build without rebuilding anything."""
    for path in (SEED_MAP_JSON, VECTORIZERS_PICKLE, ENCODER_NPZ):
        if not path.exists():
            print(f"[NG] {path.name} がありません。先にビルドしてください。")
            return 1

    with io.open(SEED_MAP_JSON, encoding="utf-8") as handle:
        payload = json.load(handle)
    numpy_encoder, scale_bounds = load_encoder(ENCODER_NPZ)

    print(f"model_version : {payload['meta']['model_version']}")
    print(f"seed_count    : {payload['meta']['seed_count']}")
    print(f"islands       : {[island['name'] for island in payload['islands']]}")
    print(f"encoder       : {numpy_encoder.input_dim} -> {list(numpy_encoder.hidden_sizes)} -> 2")
    print(f"scale_bounds  : {scale_bounds}")

    if scale_bounds != payload["scale_bounds"]:
        print("[NG] encoder.npz と seed_map.json の scale_bounds が食い違っています。")
        return 1
    if len(payload["seed"]) != payload["meta"]["seed_count"]:
        print("[NG] seed の件数が meta と食い違っています。")
        return 1
    print("[OK] artifacts は整合しています。")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="既存ビルドの整合性だけ確認する")
    parser.add_argument("--relabel", action="store_true",
                        help="座標はそのままに、島の分け方と名前だけ付け直す")
    parser.add_argument("--fast", action="store_true", help="ホールドアウト検証を省略（開発用）")
    parser.add_argument("--corpus", help="別のコーパスを使う（開発用）")
    parser.add_argument("--artifacts", help="別の出力先を使う（開発用）")
    args = parser.parse_args()
    use_paths(args.corpus, args.artifacts)
    if args.verify:
        return verify(args)
    if args.relabel:
        return relabel(args)
    return build(args)


if __name__ == "__main__":
    sys.exit(main())
