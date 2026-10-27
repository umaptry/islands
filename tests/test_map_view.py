"""One view of a stored vector, for the map's encoder and for 似てる度 (2026-10-15).

A map built on the centred view (manifest schema 2) trains its teacher layout and
its encoder on core.similarity.map_view, and serving hands the encoder the same.
If build and serving ever read a vector differently, nothing raises: every post
just lands somewhere plausible and wrong. These tests are what makes that loud.
"""

import json
import shutil
from pathlib import Path

import numpy as np
import pytest

from core.artifact_manifest import PREPROCESSING_V1, SCHEMA_MAP_VIEW, SCHEMA_STORED_VECTOR, validate_manifest
from core.config import DENSE_WEIGHT, SPARSE_WEIGHT
from core.similarity import (
    CENTERED_SPACE,
    MAP_VIEW_SPACE,
    SPARSE_DIM,
    map_view,
    reads_map_view,
    resolve_scale,
    similarity_view,
)

DENSE_DIM = 384


def view_centroid(rng):
    return {
        "dense_mean": list(rng.normal(size=DENSE_DIM) * 0.02),
        "dense_weight": 0.8,
        "sparse_weight": 0.2,
        "space": MAP_VIEW_SPACE,
        "map_input": True,
    }


def unit(vector):
    return vector / np.linalg.norm(vector)


def test_the_map_view_is_the_similarity_view_of_its_artifact():
    rng = np.random.default_rng(1)
    vectors = rng.normal(size=(6, DENSE_DIM + SPARSE_DIM))
    centroid = view_centroid(rng)

    batch = map_view(vectors, centroid)
    assert np.allclose(batch, [similarity_view(vector, centroid) for vector in vectors])
    assert np.allclose(np.linalg.norm(batch, axis=1), 1.0)
    assert np.allclose(map_view(vectors[0], centroid), batch[0])

    # And it is the recipe the weights say: centred dense at 0.8, words at 0.2.
    dense, sparse = unit(vectors[0][:DENSE_DIM]), unit(vectors[0][DENSE_DIM:])
    expected = unit(np.hstack([unit(dense - np.array(centroid["dense_mean"])) * 0.8, sparse * 0.2]))
    assert np.allclose(batch[0], expected)


def test_the_map_view_refuses_what_it_cannot_read():
    rng = np.random.default_rng(2)
    centroid = view_centroid(rng)
    with pytest.raises(ValueError):
        map_view(np.ones(100), centroid)
    with pytest.raises(ValueError):
        map_view(np.ones(DENSE_DIM + SPARSE_DIM), {**centroid, "map_input": False})
    with pytest.raises(ValueError):
        map_view(np.ones(DENSE_DIM + SPARSE_DIM), None)


def test_an_older_centroid_keeps_the_old_weights():
    """Artifacts from before the map view carry no weights and mean 0.65 / 0.35."""
    rng = np.random.default_rng(3)
    older = {"dense_mean": list(rng.normal(size=DENSE_DIM) * 0.02)}
    vector = rng.normal(size=DENSE_DIM + SPARSE_DIM)
    dense, sparse = unit(vector[:DENSE_DIM]), unit(vector[DENSE_DIM:])
    expected = unit(np.hstack([
        unit(dense - np.array(older["dense_mean"])) * DENSE_WEIGHT, sparse * SPARSE_WEIGHT]))
    assert not reads_map_view(older)
    assert np.allclose(similarity_view(vector, older), expected)


def test_the_ruler_must_belong_to_the_centroids_space():
    rng = np.random.default_rng(4)
    new = view_centroid(rng)
    old = {"dense_mean": new["dense_mean"]}
    new_ruler = {"space": MAP_VIEW_SPACE, "cosine_floor": 0.0, "cosine_ceiling": 0.5}
    old_ruler = {"space": CENTERED_SPACE, "cosine_floor": 0.0, "cosine_ceiling": 0.5}

    assert resolve_scale(new_ruler, new) == (new_ruler, new)
    assert resolve_scale(old_ruler, old) == (old_ruler, old)
    # Crossed halves print plausible wrong percentages; they must not be served.
    assert resolve_scale(old_ruler, new) == (None, None)
    assert resolve_scale(new_ruler, old) == (None, None)


def test_the_manifest_says_how_the_encoder_reads(tmp_path):
    listed = json.loads(Path("artifacts/manifest.json").read_text(encoding="utf-8"))["files"]
    for name in ("manifest.json", *listed):
        shutil.copyfile("artifacts/" + name, tmp_path / name)
    manifest = validate_manifest(tmp_path, "onnx")
    seed = json.loads((tmp_path / "seed_map.json").read_text(encoding="utf-8"))
    expected = SCHEMA_MAP_VIEW if reads_map_view(seed.get("cosine_centroid")) else SCHEMA_STORED_VECTOR
    assert manifest["schema_version"] == expected

    # A manifest claiming the other schema is refused, not trusted.
    manifest["schema_version"] = SCHEMA_STORED_VECTOR + SCHEMA_MAP_VIEW - expected
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(RuntimeError, match="schema"):
        validate_manifest(tmp_path, "onnx")


def test_serving_places_the_seeds_where_the_build_put_them(loaded):
    """Golden check of build/serve parity. Serving computes a post's position
    from its text alone; fed the first seed texts it must read them in the same
    view the build stored, and place them where the build's own data says - a
    missed map_view, a wrong centroid or a different recipe would move them by
    tens of pixels, not by rounding."""
    import app as application
    from core.placement import place_by_seeds

    # The committed map is built on the map view, so this walks the path
    # production will take, not only the older one (2026-10-15).
    assert reads_map_view(loaded["seed_map"]["cosine_centroid"])
    assert loaded["map_centroid"] is not None
    with open("scripts/seed_corpus.jsonl", encoding="utf-8") as handle:
        texts = [json.loads(line)["text"] for line in handle if line.strip()][:24]
    projected = [application.project(text) for text in texts]
    served = np.array([row[:2] for row in projected], dtype=float)

    placement = loaded.get("placement")
    if placement is None:
        # Placed by the student: the seeds land on their own spots.
        built = np.asarray(loaded["seed_coords"][:24], dtype=float)
        # 0.5 is the most the build's dejitter moves an exact duplicate.
        assert float(np.max(np.hypot(*(served - built).T))) < 1.0
        return
    # Placed by the seeds: the text read now is the vector the build shipped...
    views = np.array([application.map_input(row[4]) for row in projected])
    shipped = placement["vectors"][:24]
    cosines = np.sum(views * shipped, axis=1) / np.linalg.norm(shipped, axis=1)
    assert float(cosines.min()) > 0.999      # float16 storage costs about 1e-4
    # ...and lands where the shipped data places it.
    expected = place_by_seeds(shipped, placement["vectors"], placement["spots"], k=placement["k"],
                              temperature=placement["temperature"], bandwidth=placement["bandwidth"])
    assert float(np.max(np.hypot(*(served - expected).T))) < 1.0


def test_a_post_between_two_groups_of_seeds_joins_the_bigger_one():
    """Two groups of seeds near a text in meaning: it lands in the heavier one,
    not in the sea halfway between them."""
    from core.placement import place_by_seeds

    rng = np.random.default_rng(6)
    centre = unit(rng.normal(size=8))
    near = [unit(centre + rng.normal(scale=0.05, size=8)) for _ in range(9)]
    vectors = np.array(near + [unit(rng.normal(size=8)) for _ in range(20)])
    spots = np.array([[100.0 + i, 100.0] for i in range(5)] + [[400.0 + i, 400.0] for i in range(4)]
                     + [[800.0, 800.0]] * 20)
    x, y = place_by_seeds(centre, vectors, spots, k=9, temperature=1.0, bandwidth=25.0)
    assert 95 < x < 110 and abs(y - 100) < 1
    # Same text, same spot.
    assert (x, y) == tuple(place_by_seeds(centre, vectors, spots, k=9, temperature=1.0, bandwidth=25.0))


def test_island_reach_shrinks_as_the_map_fills():
    from core.config import ISLAND_REACH_FLOOR, ISLAND_REACH_FULL_POSTS
    from core.energy import influence_radius, reach_factor

    assert reach_factor(0) == reach_factor(3) == reach_factor(ISLAND_REACH_FULL_POSTS) == 1.0
    # The fitted points: about x0.9 at ~240 posts and x0.7 at ~480.
    assert abs(reach_factor(240) - 0.9) < 0.01
    assert abs(reach_factor(480) - 0.7) < 0.01
    assert reach_factor(480) < reach_factor(240) < reach_factor(200) < 1
    assert reach_factor(10 ** 7) == ISLAND_REACH_FLOOR
    assert influence_radius(50, 0.5) == influence_radius(50) / 2


def test_the_browser_is_served_the_reach_factor(client):
    energy = client.get("/api/config").json()["energy"]
    assert 0 < energy["radius_factor"] <= 1


def test_the_islands_poll_carries_the_reach_factor_too(client):
    """A page open while the map grows keeps its ground in step with the names."""
    energy = client.get("/api/config").json()["energy"]
    assert client.get("/api/islands").json()["radius_factor"] == energy["radius_factor"]


def as_map_view_artifact(directory):
    """The committed artifact, re-stamped as if built on the map view: its own
    dense mean, the 0.8 / 0.2 weights, map_input, and a fresh manifest."""
    from core.artifact_manifest import embedding_spec, write_manifest
    listed = json.loads(Path("artifacts/manifest.json").read_text(encoding="utf-8"))["files"]
    for name in ("manifest.json", *listed):
        shutil.copyfile("artifacts/" + name, directory / name)
    seed = json.loads((directory / "seed_map.json").read_text(encoding="utf-8"))
    centroid = dict(seed["cosine_centroid"], dense_weight=0.8, sparse_weight=0.2,
                    space=MAP_VIEW_SPACE, map_input=True)
    seed["cosine_centroid"] = centroid
    seed["cosine_anchors"] = dict(seed["cosine_anchors"], space=MAP_VIEW_SPACE)
    (directory / "seed_map.json").write_text(json.dumps(seed, ensure_ascii=False), encoding="utf-8")
    write_manifest(directory, embedding_spec("onnx", PREPROCESSING_V1))   # the bundled map is -v1
    return centroid


def test_a_map_view_artifact_is_schema_2_and_older_code_refuses_it(tmp_path):
    as_map_view_artifact(tmp_path)
    manifest = validate_manifest(tmp_path, "onnx")
    assert manifest["schema_version"] == SCHEMA_MAP_VIEW
    # What code from before map_view checked: anything but 1 is refused. That
    # refusal is what keeps an old image from misplacing every post silently.
    assert manifest["schema_version"] != 1

    # And the stamp cannot be talked down to 1 while the centroid says map_input.
    manifest["schema_version"] = SCHEMA_STORED_VECTOR
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(RuntimeError, match="schema"):
        validate_manifest(tmp_path, "onnx")


def test_serving_feeds_the_encoder_the_map_view_of_such_an_artifact(tmp_path, monkeypatch, loaded):
    import app as application

    centroid = as_map_view_artifact(tmp_path)
    monkeypatch.setattr(application, "ARTIFACTS", tmp_path)
    artifacts = application.load_artifacts()
    assert artifacts["map_centroid"] == centroid

    monkeypatch.setitem(application.state, "map_centroid", artifacts["map_centroid"])
    vector = np.random.default_rng(5).normal(size=DENSE_DIM + SPARSE_DIM)
    assert np.allclose(application.map_input(vector), map_view(vector, centroid))
    assert not np.allclose(application.map_input(vector), vector)

    monkeypatch.setitem(application.state, "map_centroid", None)
    assert application.map_input(vector) is vector


def test_a_centroid_that_does_not_fit_the_encoder_stops_the_load(tmp_path, monkeypatch, loaded):
    import app as application
    from core.artifact_manifest import embedding_spec, write_manifest

    as_map_view_artifact(tmp_path)
    seed = json.loads((tmp_path / "seed_map.json").read_text(encoding="utf-8"))
    seed["cosine_centroid"]["dense_mean"] = seed["cosine_centroid"]["dense_mean"][:100]
    (tmp_path / "seed_map.json").write_text(json.dumps(seed, ensure_ascii=False), encoding="utf-8")
    write_manifest(tmp_path, embedding_spec("onnx", PREPROCESSING_V1))
    monkeypatch.setattr(application, "ARTIFACTS", tmp_path)
    with pytest.raises(RuntimeError, match="cosine_centroid"):
        application.load_artifacts()


def test_island_names_need_a_share_of_the_island_but_never_more_than_twenty():
    """Islands of 1,000+ short seeds named nothing at 4% (2026-10-15)."""
    from core import clustering

    labels = np.array([0] * 1500 + [1] * 10)
    tokens = [["写真", "撮影"]] * 25 + [["料理"]] * 1475 + [["読書", "図書館"]] * 10

    class Model:
        def encode(self, texts, **_):
            return np.ones((len(texts), 3)) / np.sqrt(3)

    meta = clustering.rank_cluster_keywords(labels, 0, tokens, Model(), {})
    assert meta["minimum_support"] == clustering.LABEL_SUPPORT_CAP
    small = clustering.rank_cluster_keywords(labels, 1, tokens, Model(), {})
    assert small["minimum_support"] == max(2, int(np.ceil(10 * clustering.LABEL_SUPPORT_RATIO)))


def test_a_map_missing_one_of_its_files_is_refused_by_name(tmp_path):
    listed = json.loads(Path("artifacts/manifest.json").read_text(encoding="utf-8"))["files"]
    for name in ("manifest.json", *listed):
        if name != "seed_vectors.npy":
            shutil.copyfile("artifacts/" + name, tmp_path / name)
    assert "seed_vectors.npy" in listed
    with pytest.raises(RuntimeError, match="missing: seed_vectors.npy"):
        validate_manifest(tmp_path, "onnx")


# -- seeds of every kind of post (2026-10-16) ---------------------------------

def test_each_variant_stands_on_its_source_seed():
    """seed_vectors.npy holds the seeds, then the variants; the placement reads
    a spot per row, the variant's being its source seed's."""
    from core.placement import placement_spots

    seed = json.loads(Path("artifacts/seed_map.json").read_text(encoding="utf-8"))
    sources = seed["placement"]["variant_sources"]
    rows = np.load("artifacts/seed_vectors.npy")
    spots = placement_spots(seed)
    count = seed["meta"]["seed_count"]
    assert len(sources) > 1000
    assert rows.shape[0] == len(spots) == count + len(sources)
    assert np.array_equal(spots[count:], spots[np.array(sources)])
    seed["placement"]["variant_sources"] = [count]
    with pytest.raises(RuntimeError, match="範囲外"):
        placement_spots(seed)


def test_the_variants_file_says_what_each_one_is():
    rows = [json.loads(line) for line in Path("scripts/seed_variants.jsonl").read_text(encoding="utf-8").splitlines()]
    corpus = sum(1 for line in Path("scripts/seed_corpus.jsonl").read_text(encoding="utf-8").splitlines() if line.strip())
    assert {row["type"] for row in rows} == {"past", "present", "future", "event"}
    assert all(0 <= row["source"] < corpus and 8 <= len(row["text"]) <= 120 for row in rows)
    # The kinds the seeds lacked: the past and announcements.
    kinds = {kind: sum(row["type"] == kind for row in rows) for kind in ("past", "event")}
    assert min(kinds.values()) > 1000


def test_the_placement_gate_holds_a_seeds_variants_out_with_it(monkeypatch):
    """A variant stands on its seed's spot: left in, it would hand a held-out
    seed its own answer and the gate would measure nothing."""
    import scripts.build_seed_map as build

    rng = np.random.default_rng(3)
    seeds = rng.normal(size=(400, 8))
    seeds /= np.linalg.norm(seeds, axis=1, keepdims=True)
    coords = rng.uniform(0, 1000, size=(400, 2))
    sources = np.arange(400)                  # one variant per seed: a copy of it
    seen = {}

    def spy(views, vectors, spots, **kwargs):
        seen["rows"], seen["spots"] = vectors, spots
        return np.zeros((len(views), 2))

    monkeypatch.setattr(build, "place_by_seeds", spy)
    build.placement_gate(np.vstack([seeds, seeds]), coords, sources, holdout=50)
    # 350 seeds and their 350 copies: no copy of the 50 held out.
    assert len(seen["rows"]) == 2 * (400 - 50)
    assert len(np.unique(np.round(seen["rows"], 9), axis=0)) == 400 - 50


def test_a_variant_pointing_past_the_seeds_stops_the_build(tmp_path):
    import scripts.build_seed_map as build

    path = tmp_path / "variants.jsonl"
    path.write_text(json.dumps({"source": 5, "type": "past", "text": "昔は毎週末に山へ登っていました"}, ensure_ascii=False) + "\n", encoding="utf-8")
    assert build.load_variants(path, 6)[0].tolist() == [5]
    with pytest.raises(SystemExit):
        build.load_variants(path, 5)
    assert build.load_variants(tmp_path / "none.jsonl", 5) is None


def test_another_corpus_does_not_pick_up_the_real_variants(monkeypatch):
    """Variants name rows of scripts/seed_corpus.jsonl; a build of another corpus
    (tests, experiments) uses none unless it is given its own."""
    import scripts.build_seed_map as build

    for name in ("CORPUS_PATH", "VARIANTS_PATH", "ARTIFACTS", "SEED_MAP_JSON", "VECTORIZERS_PICKLE", "ENCODER_NPZ"):
        monkeypatch.setattr(build, name, getattr(build, name))
    build.use_paths(corpus="other.jsonl")
    assert build.VARIANTS_PATH is None and build.load_variants(build.VARIANTS_PATH, 10) is None
    build.use_paths(corpus="other.jsonl", variants="mine.jsonl")
    assert build.VARIANTS_PATH.name == "mine.jsonl"
