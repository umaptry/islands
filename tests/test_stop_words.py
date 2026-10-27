"""A map is read with the stop words it was built with (2026-10-28).

Preprocessing "-v2" also drops how and when somebody does a thing (探す, 募集, 学生時代 ...).
Maps built before keep "-v1" and must place posts exactly as before, so the stop words
follow the map's manifest, not the code.
"""

import json
import shutil
import sys
from pathlib import Path

import numpy as np
import pytest

from core import features
from core.artifact_manifest import (
    PREPROCESSING,
    PREPROCESSING_V1,
    SUPPORTED_PREPROCESSING,
    embedding_spec,
    matches_spec,
    validate_manifest,
)
from core.features import extract_content_terms, extract_label_terms, use_preprocessing
from core.geometry import scale_projected_coordinate, unscale_coordinates

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

SEEKING = "社内イベントの写真を撮ってくれる人を探しています。"


@pytest.fixture(autouse=True)
def keep_the_active_stop_words(monkeypatch):
    # Process-wide: put back whatever the loaded map chose.
    monkeypatch.setattr(features, "_stop_words", features._stop_words)


def test_every_readable_preprocessing_has_its_stop_words():
    assert set(features.STOP_WORDS_BY_PREPROCESSING) == set(SUPPORTED_PREPROCESSING)
    assert features.STOP_WORDS_BY_PREPROCESSING[PREPROCESSING_V1] < features.STOP_WORDS_BY_PREPROCESSING[PREPROCESSING]


def test_v1_reads_a_text_as_every_map_before_did():
    use_preprocessing(PREPROCESSING_V1)
    assert extract_content_terms(SEEKING) == ["社内イベント", "写真", "撮る", "呉れる", "探す"]


def test_v2_keeps_what_the_post_is_about_and_drops_how_it_is_put():
    use_preprocessing(PREPROCESSING)
    assert extract_content_terms(SEEKING) == ["社内イベント", "写真", "撮る"]
    assert extract_content_terms("学生時代は写真部で、イベントの撮影をよくしていました。") == ["写真部", "イベント", "撮影"]
    # Entries that never matched before: Sudachi looks up 行く and 嵌まる, not いく and はまる.
    assert extract_content_terms("最近ボルダリングにはまって、毎週ジムに行く") == ["ボルダリング", "ジム"]
    # Island names drop them as well.
    assert "募集" not in extract_label_terms("陶芸体験の参加者を募集します")


def test_an_unknown_preprocessing_is_refused():
    with pytest.raises(RuntimeError):
        use_preprocessing("hybrid-something-else")
    with pytest.raises(ValueError):
        embedding_spec("gemini", "hybrid-something-else")


def test_serving_reads_the_stop_words_of_its_map(loaded):
    # The bundled map (artifacts/) was built with "-v1".
    import app as application

    assert application.state["manifest"]["embedding"]["preprocessing"] == PREPROCESSING_V1
    assert features.active_stop_words() == features.STOP_WORDS_BY_PREPROCESSING[PREPROCESSING_V1]


def test_a_map_of_either_preprocessing_is_valid(tmp_path):
    shutil.copytree(ROOT / "artifacts", tmp_path, dirs_exist_ok=True)
    manifest_path = tmp_path / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for preprocessing in SUPPORTED_PREPROCESSING:
        manifest["embedding"]["preprocessing"] = preprocessing
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        assert validate_manifest(tmp_path, "onnx")["embedding"]["preprocessing"] == preprocessing
    manifest["embedding"]["preprocessing"] = "hybrid-something-else"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(RuntimeError, match="Embedding backend"):
        validate_manifest(tmp_path, "onnx")


def test_a_release_of_either_preprocessing_passes_the_release_check():
    from verify_release import validate

    for preprocessing in SUPPORTED_PREPROCESSING:
        assert matches_spec(embedding_spec("gemini", preprocessing), "gemini")
        health = {"store": "supabase", "store_ok": True, "embedding": embedding_spec("gemini", preprocessing),
                  "artifact_version": "v", "active_map_version": "v", "artifact_compatible": True,
                  "maintenance": False, "ready": True}
        validate(health, {"mode": "supabase", "map_version": "v", "supabase": {"url": "https://x", "anon_key": "k"}},
                 "gemini", "v", "https://x")
    assert not matches_spec(embedding_spec("onnx", PREPROCESSING), "gemini")
    assert not matches_spec(dict(embedding_spec("gemini"), preprocessing="hybrid-something-else"), "gemini")


@pytest.mark.parametrize("turn", [0.0, 1.0])
def test_unscaling_undoes_the_map_transform(turn):
    bounds = {"center_x": 3.2, "center_y": -1.7, "scale": 41.5, "world_center": 500.0, "quarter_turn": turn}
    raw = np.random.default_rng(0).normal(size=(50, 2)) * 4 + [3.2, -1.7]
    on_map = np.array([scale_projected_coordinate(x, y, bounds) for x, y in raw])
    assert np.allclose(unscale_coordinates(on_map, bounds), raw)
