"""Build the frozen map. Run this ONCE.

Running it again re-runs the teacher UMAP and retrains the encoder, which moves
every coordinate on the map. Anyone who already joined would find themselves
somewhere else. Treat artifacts/ as immutable once the demo is live.

    python scripts/build_seed_map.py            # build
    python scripts/build_seed_map.py --verify   # re-check a build without touching it
    python scripts/build_seed_map.py --add-variants --artifacts DIR
        # an existing build, under a new MAP_BUILD_VERSION: the seed variants
        # (scripts/seed_variants.jsonl) and the current SEED_PLACEMENT. No point
        # of the layout moves.
    python scripts/build_seed_map.py --keep-layout OLD --artifacts NEW
        # the layout of the build in OLD, every vector recomputed by the current
        # code (e.g. new stop words), under a new MAP_BUILD_VERSION. No point of
        # the layout moves; new texts are read the new way.

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
    SEED_PLACEMENT,
    SEED_VARIANTS_FILE,
    MODEL_VERSION,
)
from core.encoder import load_encoder, save_encoder  # noqa: E402
from core.features import build_hybrid_features, extract_label_terms, use_preprocessing  # noqa: E402
from core.geometry import (  # noqa: E402
    dejitter_exact_overlaps,
    isotropic_scale_coordinates,
    nearest_neighbor_stats,
)
from core.similarity import build_distance_quantiles, build_idf, map_view  # noqa: E402
from core.placement import neighbourhood_recall, place_by_seeds  # noqa: E402
from core.artifact_manifest import SEED_VECTORS  # noqa: E402

CORPUS_PATH = ROOT / "scripts" / "seed_corpus.jsonl"
VARIANTS_PATH = ROOT / "scripts" / SEED_VARIANTS_FILE
ARTIFACTS = ROOT / "artifacts"
SEED_MAP_JSON = ARTIFACTS / "seed_map.json"
VECTORIZERS_PICKLE = ARTIFACTS / "vectorizers.pkl"
ENCODER_NPZ = ARTIFACTS / "encoder.npz"


def use_paths(corpus=None, artifacts=None, variants=None):
    """Point the build at a different corpus / output directory (used by tests)."""
    global CORPUS_PATH, ARTIFACTS, SEED_MAP_JSON, VECTORIZERS_PICKLE, ENCODER_NPZ, VARIANTS_PATH
    if corpus:
        CORPUS_PATH = Path(corpus)
        # Variants point at rows of the real corpus: another corpus brings its own or none.
        VARIANTS_PATH = None
    if variants:
        VARIANTS_PATH = Path(variants)
    if artifacts:
        ARTIFACTS = Path(artifacts)
        SEED_MAP_JSON = ARTIFACTS / "seed_map.json"
        VECTORIZERS_PICKLE = ARTIFACTS / "vectorizers.pkl"
        ENCODER_NPZ = ARTIFACTS / "encoder.npz"

# Quality gates, identical to pokeDB's.
MAX_MEAN_DRIFT_RATIO = 0.35
MIN_OVERLAP_VS_CEILING = 0.65
# The generalization gate compares each held-out seed's nearest neighbours in the
# feature space and on the map. Its neighbourhood was 15 seeds when there were
# 1,000 of them: 1.5% of the map. At 10,182 seeds, 15 is 0.15% - a far finer
# question, and one even UMAP's own transform only answers at 0.74 of the
# ceiling (the student: 0.37). So the neighbourhood is that same 1.5% share,
# never under 15; the threshold is unchanged, and the k=15 figure is still
# recorded next to it (2026-10-15, measured on the Gemini 10k build).
GATE_NEIGHBOUR_SHARE = 0.015
GATE_MIN_NEIGHBOURS = 15
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


def load_variants(path, seed_count):
    """Same-topic rewrites of seeds as other kinds of post (core.placement).
    None when there is no variants file: a build without them, as before v4."""
    if path is None or not Path(path).exists():
        return None
    sources, texts = [], []
    with io.open(path, encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                record = json.loads(line)
                sources.append(int(record["source"]))
                texts.append(record["text"])
    if not sources or min(sources) < 0 or max(sources) >= seed_count:
        raise SystemExit(f"[NG] {Path(path).name} の source がシードの範囲外です（シード {seed_count} 件）。")
    return np.array(sources, dtype=int), texts


def variant_views(texts, model, sparse_artifacts, centroid):
    """The variants in the map view, read exactly as serving reads a new post."""
    features, _, _, _ = build_hybrid_features(texts, model, fit_sparse=False, sparse_artifacts=sparse_artifacts)
    return map_view(features, centroid)


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
    if (ARTIFACTS / "manifest.json").exists():
        print("[NG] 版付き成果物は上書きできません。--artifacts で新しい出力先を指定してください。")
        return 1
    import train_parametric
    import umap

    from core.embedder import load_embedder

    if not CORPUS_PATH.exists():
        print(f"[NG] シードコーパスがありません: {CORPUS_PATH}")
        print("     先に python scripts/validate_corpus.py で検証してください。")
        return 1

    texts, domains = load_corpus(CORPUS_PATH)
    print(f"[1/8] コーパス読み込み: {len(texts)} 件 / {len(set(domains))} ドメイン")

    _label = os.environ.get("EMBEDDING_PROVIDER", "onnx")
    print(f"[2/8] 埋め込みモデル読み込み: {_label}")
    from core.artifact_manifest import embedding_spec, write_manifest
    provider = os.environ.get("EMBEDDING_PROVIDER", "onnx")
    spec = embedding_spec(provider)
    use_preprocessing(spec["preprocessing"])
    model = load_embedder()
    if provider == "gemini":
        from core.embedding_cache import CachedEmbedder, SQLiteEmbeddingCache
        model = CachedEmbedder(model, SQLiteEmbeddingCache(os.environ.get(
            "EMBEDDING_CACHE_PATH", str(ROOT / ".cache" / "embeddings.sqlite3"))), spec)

    print("[3/8] 448次元ベクトルを構築中...")
    features, token_lists, zero_rows, sparse_artifacts = build_hybrid_features(
        texts, model, fit_sparse=True
    )
    if zero_rows:
        print(f"[NG] 内容語が一つも残らない行が {zero_rows} 件あります。ビルドを中断します。")
        print("     python scripts/validate_corpus.py で該当行を特定してください。")
        return 1
    print(f"      shape={features.shape}")
    # Everything from here on - teacher, student, gates, 似てる度 - reads the
    # centred view (core.similarity.map_view), the vector serving will hand the
    # encoder. The stored 448-dim vector itself is unchanged.
    import build_similarity_calibration as calibration
    centroid, view = calibration.map_view_centroid(features)
    print(f"      中心化した見方（密 {centroid['dense_weight']} / 単語 {centroid['sparse_weight']}）で地図を作ります")

    print("[4/8] 教師UMAPを1回だけ実行中（この結果はお手本として使い、以後破棄）...")
    reducer = umap.UMAP(n_components=2, **LAYOUT_CONFIG)
    reference_coords = reducer.fit_transform(view)

    print("[5/8] エンコーダ f を学習中（448 -> 512 -> 256 -> 128 -> 2）...")
    ab_params = train_parametric._umap_ab(LAYOUT_CONFIG["spread"], LAYOUT_CONFIG["min_dist"])
    encoder, torch_artifacts, train_stats = train_parametric.train_encoder(
        view, reference_coords, graph=None, ab_params=ab_params
    )
    print(f"      {train_stats}")

    predicted = train_parametric.predict(encoder, torch_artifacts, view)
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

    # New posts are placed by their seeds (core.placement), from the vectors as
    # shipped: float16, so the gate below measures exactly what serving does.
    # The variants follow the seeds' rows, each at its source seed's spot.
    variants = load_variants(VARIANTS_PATH, len(texts))
    sources = np.zeros(0, dtype=int)
    rows = view
    if variants is not None:
        sources, variant_texts = variants
        print(f"      種類ちがいの例文 {len(sources)} 件（元のシードの位置に置く）")
        rows = np.vstack([view, variant_views(variant_texts, model, sparse_artifacts, centroid)])
    seed_vectors = rows.astype(np.float16)
    print("[8/8] 品質ゲートを検証中...")
    gates, passed = run_gates(
        view, reference_coords, encoder, torch_artifacts, train_stats, ab_params,
        skip_holdout=args.fast,
    )
    gates["placement"] = placement_gate(seed_vectors.astype(float), coords, sources)
    passed = passed and gates["placement"][0]
    for name, (ok, detail) in gates.items():
        print(f"      [{'OK' if ok else 'NG'}] {name}: {detail}")
    if not passed:
        print("\n[NG] 品質ゲートを通過しませんでした。artifacts は書き込みません。")
        return 1

    # --- persist -----------------------------------------------------------
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    save_encoder(
        ENCODER_NPZ, torch_artifacts["encoder_state_dict"], torch_artifacts["encoder_arch"],
        torch_artifacts["coord_mean"], torch_artifacts["coord_scale"], scale_bounds,
    )
    atomic_write(VECTORIZERS_PICKLE, lambda h: pickle.dump(sparse_artifacts, h), mode="wb")
    atomic_write(ARTIFACTS / SEED_VECTORS, lambda h: np.save(h, seed_vectors), mode="wb")

    payload = {
        "meta": {
            "model_version": os.environ.get("MAP_BUILD_VERSION") or (MODEL_VERSION if provider == "gemini" else "kotoba-map-e5-rebuilt-v1"),
            "layout_version": LAYOUT_VERSION,
            "embedding_model": spec["model"],
            "feature_config": FEATURE_CONFIG,
            "layout_config": LAYOUT_CONFIG,
            "seed_count": len(texts),
            "feature_dim": int(features.shape[1]),
            "train_stats": train_stats,
            "gates": {name: detail for name, (_, detail) in gates.items()},
            "quality_checked": not args.fast and passed,
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
        # How a new text is placed: by its nearest seeds (core.placement), whose
        # spots are "seed" above and whose vectors are seed_vectors.npy; the
        # variants' rows follow, each at its source seed's spot.
        "placement": dict(SEED_PLACEMENT, variant_sources=sources.tolist()),
    }
    # The centroid is part of the map now (the encoder reads through it), and
    # 似てる度 is calibrated in the same view: all of it goes out in one write.
    anchors, quantiles, _pairs, _nearest = calibration.measure(view, space=centroid["space"])
    payload["cosine_anchors"] = anchors
    payload["cosine_centroid"] = centroid
    payload["cosine_quantiles"] = quantiles
    atomic_write(
        SEED_MAP_JSON,
        lambda h: json.dump(payload, h, ensure_ascii=False, separators=(",", ":")),
    )
    write_manifest(ARTIFACTS, spec)

    print()
    print(f"完了: {SEED_MAP_JSON.name} / {VECTORIZERS_PICKLE.name} / {ENCODER_NPZ.name}")
    print(f"      近傍距離 {payload['meta']['nearest_neighbor_stats']}")
    print(f"      似てる度の目盛り floor={anchors['cosine_floor']} ceiling={anchors['cosine_ceiling']}")
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
        neighbours = max(GATE_MIN_NEIGHBOURS, round(GATE_NEIGHBOUR_SHARE * (len(features) - HOLDOUT_SIZE)))
        result = train_parametric.evaluate_generalization(
            features, reference_coords, LAYOUT_CONFIG["n_neighbors"], ab_params,
            holdout=HOLDOUT_SIZE, k=neighbours,
            also_k=(GATE_MIN_NEIGHBOURS,) if neighbours != GATE_MIN_NEIGHBOURS else (),
        )
        ratio = result["overlap_vs_ceiling"]
        detail = (
            f"overlap_vs_ceiling={ratio} (>= {MIN_OVERLAP_VS_CEILING}) at k={neighbours}, "
            f"achieved={result['holdout_neighborhood_overlap']}, "
            f"ceiling={result['reference_layout_ceiling']}"
        )
        finer = result.get(f"at_k{GATE_MIN_NEIGHBOURS}")
        if finer:
            detail += (f"; at k={GATE_MIN_NEIGHBOURS}: overlap_vs_ceiling={finer['overlap_vs_ceiling']}, "
                       f"achieved={finer['achieved']}, ceiling={finer['ceiling']}")
        gates["generalization"] = (ratio >= MIN_OVERLAP_VS_CEILING, detail)

    return gates, all(ok for ok, _ in gates.values())


GATE_SEED = 42   # train_parametric.SEED: the same 300 seeds as every build before


def placement_gate(vectors, coords, sources=(), holdout=300):
    """Hold seeds out, place them by the others, and compare their nearest
    neighbours in meaning with their nearest on the map - the student's
    generalization measure, for the placement serving actually uses.

    `vectors` holds the seeds' rows and then the variants' (`sources`: each
    variant's seed). A held-out seed's own variants are held out with it: they
    stand on its spot and would hand it the answer."""
    coords = np.asarray(coords, dtype=float)
    sources = np.asarray(sources, dtype=int)
    seeds = vectors[:len(coords)]
    rng = np.random.default_rng(GATE_SEED)
    order = rng.permutation(len(coords))
    test, train = np.sort(order[:holdout]), np.sort(order[holdout:])
    kept = np.where(~np.isin(sources, test))[0]
    placed = place_by_seeds(seeds[test], np.vstack([seeds[train], vectors[len(coords) + kept]]),
                            np.vstack([coords[train], coords[sources[kept]]]), k=SEED_PLACEMENT["k"],
                            temperature=SEED_PLACEMENT["temperature"], bandwidth=SEED_PLACEMENT["bandwidth"])
    neighbours = max(GATE_MIN_NEIGHBOURS, round(GATE_NEIGHBOUR_SHARE * len(train)))
    ratios = {}
    for k in sorted({GATE_MIN_NEIGHBOURS, neighbours}):
        got = neighbourhood_recall(seeds[train], coords[train], seeds[test], placed, k=k)
        top = neighbourhood_recall(seeds[train], coords[train], seeds[test], coords[test], k=k)
        ratios[k] = (round(got, 4), round(top, 4), round(got / max(top, 1e-6), 4))
    detail = "; ".join(f"k={k}: overlap_vs_ceiling={r[2]}, achieved={r[0]}, ceiling={r[1]}" for k, r in ratios.items())
    return ratios[neighbours][2] >= MIN_OVERLAP_VS_CEILING, f"{detail} (>= {MIN_OVERLAP_VS_CEILING} at k={neighbours})"


def relabel(_args):
    """Recompute islands and their names from the SAVED coordinates.

    Labels do not feed the encoder, so this never moves a point. Use it to fix a
    bad island name without the 25-minute retrain that build() would cost.
    """
    from core.embedder import load_embedder
    from core.artifact_manifest import validate_manifest, write_manifest
    manifest = validate_manifest(ARTIFACTS, os.environ.get("EMBEDDING_PROVIDER", "onnx"))
    use_preprocessing(manifest["embedding"]["preprocessing"])

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

    _label = manifest["embedding"]["model"]
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
    write_manifest(ARTIFACTS, manifest["embedding"])
    print(f"完了: {SEED_MAP_JSON.name} の島情報のみ更新しました。座標は不変です。")
    return 0


def add_variants(_args):
    """An existing build with the seed variants and the current SEED_PLACEMENT.

    Nothing of the layout moves: the seeds keep their spots and vectors, the
    student and the islands stay, and the variants only join the placement. It
    is still a different map for new posts, so it needs a new version name
    (MAP_BUILD_VERSION) and is written over a COPY of the build it starts from.
    """
    from core.artifact_manifest import validate_manifest, write_manifest
    from core.embedder import load_embedder

    provider = os.environ.get("EMBEDDING_PROVIDER", "onnx")
    manifest = validate_manifest(ARTIFACTS, provider)
    use_preprocessing(manifest["embedding"]["preprocessing"])
    version = os.environ.get("MAP_BUILD_VERSION", "")
    if not version or version == manifest["artifact_version"]:
        print(f"[NG] MAP_BUILD_VERSION に新しい版の名前を指定してください（いまは {manifest['artifact_version']}）。")
        return 1
    with io.open(SEED_MAP_JSON, encoding="utf-8") as handle:
        payload = json.load(handle)
    if (payload.get("placement") or {}).get("method") != "seed_mode":
        print("[NG] お手本で置く地図（v3 以降）にだけ使えます。")
        return 1
    seed_count = payload["meta"]["seed_count"]
    seeds = np.load(ARTIFACTS / SEED_VECTORS)[:seed_count]
    variants = load_variants(VARIANTS_PATH, seed_count)
    if variants is None:
        print(f"[NG] {VARIANTS_PATH} がありません。")
        return 1
    sources, texts = variants
    print(f"[1/3] 種類ちがいの例文 {len(sources)} 件を、{manifest['embedding']['model']} で読みます")
    model = load_embedder(provider=provider)
    if provider == "gemini":
        from core.embedding_cache import CachedEmbedder, SQLiteEmbeddingCache
        model = CachedEmbedder(model, SQLiteEmbeddingCache(os.environ.get(
            "EMBEDDING_CACHE_PATH", str(ROOT / ".cache" / "embeddings.sqlite3"))), manifest["embedding"])
    with io.open(VECTORIZERS_PICKLE, "rb") as handle:
        sparse_artifacts = pickle.load(handle)
    rows = np.vstack([seeds.astype(float), variant_views(texts, model, sparse_artifacts, payload["cosine_centroid"])])
    seed_vectors = rows.astype(np.float16)

    print("[2/3] 置き方の品質ゲート...")
    coords = np.array([[row[0], row[1]] for row in payload["seed"]], dtype=float)
    ok, detail = placement_gate(seed_vectors.astype(float), coords, sources)
    print(f"      [{'OK' if ok else 'NG'}] placement: {detail}")
    if not ok:
        print("[NG] 品質ゲートを通過しませんでした。書き込みません。")
        return 1

    print("[3/3] 書き込み...")
    payload["meta"]["model_version"] = version
    payload["meta"]["gates"]["placement"] = detail
    payload["meta"]["variants_from"] = manifest["artifact_version"]
    payload["placement"] = dict(SEED_PLACEMENT, variant_sources=sources.tolist())
    atomic_write(ARTIFACTS / SEED_VECTORS, lambda h: np.save(h, seed_vectors), mode="wb")
    atomic_write(SEED_MAP_JSON, lambda h: json.dump(payload, h, ensure_ascii=False, separators=(",", ":")))
    write_manifest(ARTIFACTS, manifest["embedding"])
    print(f"完了: {version}（{manifest['artifact_version']} の座標のまま、例文 {len(sources)} 件と置き方 {SEED_PLACEMENT}）")
    return 0


def keep_layout(args):
    """A new build on the layout of an existing one (--keep-layout DIR), every vector
    recomputed by the current code: after a change to the stop words, say.

    The seeds keep their spots and the islands their names, so nothing on the map moves.
    What is new is how a text is read - the TF-IDF and its projection, the centroid, the
    seeds' and variants' vectors, 似てる度's scale, the idf of shared words - and so where
    a NEW text lands. The student is retrained to the same spots (it only stands in for a
    map without seed placement) and the gates run as in a build. It needs a new
    --artifacts directory and a new MAP_BUILD_VERSION; posts already on the map are moved
    by scripts/migrate_map.py like any other change of map.

    The embedding cache is read under the old build's spec: a cached vector depends only
    on the text sent and the model, its task and dimensions. The preprocessing decides
    which texts are sent, not what any one of them is embedded as.
    """
    import train_parametric

    import build_similarity_calibration as calibration
    from core.artifact_manifest import embedding_spec, validate_manifest, write_manifest
    from core.embedder import load_embedder
    from core.geometry import unscale_coordinates

    source = Path(args.keep_layout)
    provider = os.environ.get("EMBEDDING_PROVIDER", "onnx")
    old = validate_manifest(source, provider)
    version = os.environ.get("MAP_BUILD_VERSION", "")
    if not version or version == old["artifact_version"]:
        print(f"[NG] MAP_BUILD_VERSION に新しい版の名前を指定してください（元は {old['artifact_version']}）。")
        return 1
    if (ARTIFACTS / "manifest.json").exists():
        print("[NG] 版付き成果物は上書きできません。--artifacts で新しい出力先を指定してください。")
        return 1
    with io.open(source / "seed_map.json", encoding="utf-8") as handle:
        payload = json.load(handle)
    if (payload.get("placement") or {}).get("method") != "seed_mode":
        print("[NG] お手本で置く地図（v3 以降）にだけ使えます。")
        return 1
    texts, _ = load_corpus(CORPUS_PATH)
    if len(texts) != payload["meta"]["seed_count"]:
        print("[NG] コーパスの件数が元の地図と一致しません。--keep-layout は使えません。")
        return 1

    spec = embedding_spec(provider)
    use_preprocessing(spec["preprocessing"])
    print(f"[1/6] {old['artifact_version']} の座標のまま、{spec['preprocessing']} で作り直します（{len(texts)} 件）")
    model = load_embedder(provider=provider)
    if provider == "gemini":
        from core.embedding_cache import CachedEmbedder, SQLiteEmbeddingCache
        model = CachedEmbedder(model, SQLiteEmbeddingCache(os.environ.get(
            "EMBEDDING_CACHE_PATH", str(ROOT / ".cache" / "embeddings.sqlite3"))), old["embedding"])

    print("[2/6] 448次元ベクトルを構築中...")
    features, token_lists, zero_rows, sparse_artifacts = build_hybrid_features(texts, model, fit_sparse=True)
    if zero_rows:
        print(f"[NG] 内容語が一つも残らない行が {zero_rows} 件あります。ビルドを中断します。")
        return 1
    centroid, view = calibration.map_view_centroid(features)

    coords = np.array([[row[0], row[1]] for row in payload["seed"]], dtype=float)
    scale_bounds = payload["scale_bounds"]
    reference_coords = unscale_coordinates(coords, scale_bounds)
    print("[3/6] エンコーダ f を同じ座標に合わせて学習中...")
    ab_params = train_parametric._umap_ab(LAYOUT_CONFIG["spread"], LAYOUT_CONFIG["min_dist"])
    encoder, torch_artifacts, train_stats = train_parametric.train_encoder(
        view, reference_coords, graph=None, ab_params=ab_params
    )
    print(f"      {train_stats}")

    variants = load_variants(VARIANTS_PATH, len(texts))
    sources = np.zeros(0, dtype=int)
    rows = view
    if variants is not None:
        sources, variant_texts = variants
        print(f"[4/6] 種類ちがいの例文 {len(sources)} 件（元のシードの位置に置く）")
        rows = np.vstack([view, variant_views(variant_texts, model, sparse_artifacts, centroid)])
    seed_vectors = rows.astype(np.float16)

    print("[5/6] 品質ゲートを検証中...")
    gates, passed = run_gates(
        view, reference_coords, encoder, torch_artifacts, train_stats, ab_params,
        skip_holdout=args.fast,
    )
    gates["placement"] = placement_gate(seed_vectors.astype(float), coords, sources)
    passed = passed and gates["placement"][0]
    for name, (ok, detail) in gates.items():
        print(f"      [{'OK' if ok else 'NG'}] {name}: {detail}")
    if not passed:
        print("\n[NG] 品質ゲートを通過しませんでした。artifacts は書き込みません。")
        return 1

    print("[6/6] 書き込み...")
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    save_encoder(
        ENCODER_NPZ, torch_artifacts["encoder_state_dict"], torch_artifacts["encoder_arch"],
        torch_artifacts["coord_mean"], torch_artifacts["coord_scale"], scale_bounds,
    )
    atomic_write(VECTORIZERS_PICKLE, lambda h: pickle.dump(sparse_artifacts, h), mode="wb")
    atomic_write(ARTIFACTS / SEED_VECTORS, lambda h: np.save(h, seed_vectors), mode="wb")
    # The layout ("seed", "islands", "scale_bounds", "distance_quantiles") is the old one.
    payload["meta"].update({
        "model_version": version,
        "layout_from": old["artifact_version"],
        "feature_config": FEATURE_CONFIG,
        "feature_dim": int(features.shape[1]),
        "train_stats": train_stats,
        "gates": {name: detail for name, (_, detail) in gates.items()},
        "quality_checked": not args.fast and passed,
    })
    payload["idf"] = build_idf(token_lists)
    payload["placement"] = dict(SEED_PLACEMENT, variant_sources=sources.tolist())
    anchors, quantiles, _pairs, _nearest = calibration.measure(view, space=centroid["space"])
    payload["cosine_anchors"] = anchors
    payload["cosine_centroid"] = centroid
    payload["cosine_quantiles"] = quantiles
    atomic_write(SEED_MAP_JSON, lambda h: json.dump(payload, h, ensure_ascii=False, separators=(",", ":")))
    write_manifest(ARTIFACTS, spec)
    print(f"完了: {version}（{old['artifact_version']} の座標のまま、{spec['preprocessing']}）")
    return 0


def verify(_args):
    """Re-check an existing build without rebuilding anything."""
    from core.artifact_manifest import validate_manifest
    validate_manifest(ARTIFACTS, os.environ.get("EMBEDDING_PROVIDER", "onnx"))
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
    parser.add_argument("--add-variants", action="store_true",
                        help="既存の地図に種類ちがいの例文と今の置き方を足して新しい版にする（座標は不変）")
    parser.add_argument("--keep-layout", metavar="DIR",
                        help="DIR の地図の座標のまま、今のコード（除外語など）で数値を作り直して新しい版にする")
    parser.add_argument("--fast", action="store_true", help="ホールドアウト検証を省略（開発用）")
    parser.add_argument("--corpus", help="別のコーパスを使う（開発用）")
    parser.add_argument("--artifacts", help="別の出力先を使う（開発用）")
    parser.add_argument("--variants", help="別の種類ちがい例文を使う（--corpus を変えたときは指定しないと使わない）")
    args = parser.parse_args()
    use_paths(args.corpus, args.artifacts, args.variants)
    if args.verify:
        return verify(args)
    if args.relabel:
        return relabel(args)
    if args.add_variants:
        return add_variants(args)
    if args.keep_layout:
        return keep_layout(args)
    return build(args)


if __name__ == "__main__":
    sys.exit(main())
