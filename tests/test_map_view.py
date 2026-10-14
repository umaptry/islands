"""One view of a stored vector, for the map's encoder and for 似てる度 (2026-10-15).

A map built on the centred view (manifest schema 2) trains its teacher layout and
its encoder on core.similarity.map_view, and serving hands the encoder the same.
If build and serving ever read a vector differently, nothing raises: every post
just lands somewhere plausible and wrong. These tests are what makes that loud.
"""

import json
import shutil

import numpy as np
import pytest

from core.artifact_manifest import SCHEMA_MAP_VIEW, SCHEMA_STORED_VECTOR, validate_manifest
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
    for name in ("manifest.json", "seed_map.json", "encoder.npz", "vectorizers.pkl"):
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
    """Golden check of build/serve parity. The build wrote each seed's position
    from the student's output on the build's own features; serving computes a
    post's position from its text alone. Fed the first seed texts, serving must
    land on the same spots - a missed map_view, a wrong centroid or a different
    recipe would move them by tens of pixels, not by rounding."""
    import app as application

    # The committed map is built on the map view, so this walks the path
    # production will take, not only the older one (2026-10-15).
    assert reads_map_view(loaded["seed_map"]["cosine_centroid"])
    assert loaded["map_centroid"] is not None
    with open("scripts/seed_corpus.jsonl", encoding="utf-8") as handle:
        texts = [json.loads(line)["text"] for line in handle if line.strip()][:24]
    built = np.asarray(loaded["seed_coords"][:24], dtype=float)
    served = np.array([application.project(text)[:2] for text in texts], dtype=float)
    # 0.5 is the most the build's dejitter moves an exact duplicate.
    assert float(np.max(np.hypot(*(served - built).T))) < 1.0


def as_map_view_artifact(directory):
    """The committed artifact, re-stamped as if built on the map view: its own
    dense mean, the 0.8 / 0.2 weights, map_input, and a fresh manifest."""
    from core.artifact_manifest import embedding_spec, write_manifest
    for name in ("manifest.json", "seed_map.json", "encoder.npz", "vectorizers.pkl"):
        shutil.copyfile("artifacts/" + name, directory / name)
    seed = json.loads((directory / "seed_map.json").read_text(encoding="utf-8"))
    centroid = dict(seed["cosine_centroid"], dense_weight=0.8, sparse_weight=0.2,
                    space=MAP_VIEW_SPACE, map_input=True)
    seed["cosine_centroid"] = centroid
    seed["cosine_anchors"] = dict(seed["cosine_anchors"], space=MAP_VIEW_SPACE)
    (directory / "seed_map.json").write_text(json.dumps(seed, ensure_ascii=False), encoding="utf-8")
    write_manifest(directory, embedding_spec("onnx"))
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
    write_manifest(tmp_path, embedding_spec("onnx"))
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
