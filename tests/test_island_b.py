"""地図B案の土台（core/island_b.py）と、その API（/api/map-b/base・/api/islands?map=b）。"""

import base64
import json

import numpy as np
import pytest
from scipy import ndimage

from conftest import Person
from core import island_b
from core.config import MAP_B_REGIONS

MOUNTAINS_A = "山登りが好きで、週末は低山を歩いています。山頂で湯を沸かしてコーヒーを飲む時間が好きです。"


@pytest.fixture(scope="module")
def base():
    from pathlib import Path

    path = Path(__file__).resolve().parent.parent / "artifacts" / "seed_map.json"
    seed = np.array(json.loads(path.read_text(encoding="utf-8"))["seed"], dtype=float)
    return seed, island_b.build(seed)


def test_the_coast_encloses_the_seed_points(base):
    seed, b = base
    iy = ((seed[:, 1] - island_b.Y0) // island_b.CELL).astype(int)
    ix = ((seed[:, 0] - island_b.X0) // island_b.CELL).astype(int)
    assert (b["coast"][iy, ix] >= 15).mean() >= 0.995
    assert b["seed_share"] >= 0.995
    # 陸は1かたまり
    assert ndimage.label(b["mask"])[1] == 1


def test_region_numbers_are_right_near_the_centres(base):
    for number, x, y, _name in MAP_B_REGIONS:
        assert island_b.region_of(x, y) == number
    assert island_b.region_of(-140, -140) is None
    assert island_b.region_of(5000, 5000) is None


def test_no_small_enclaves_remain(base):
    _, b = base
    for rid in range(len(MAP_B_REGIONS)):
        lab, count = ndimage.label(b["region"] == rid)
        if count > 1:
            sizes = np.bincount(lab.ravel())[1:]
            assert sorted(sizes)[:-1] and min(sorted(sizes)[:-1]) >= island_b.MIN_ENCLAVE


def test_start_and_region_anchors_are_on_land(base):
    _, b = base
    g = island_b._axis()
    for point in [b["start"]] + b["regions"]:
        assert island_b.region_of(point["x"], point["y"]) is not None
    assert len(b["regions"]) == 16


def test_payload_shape_and_decoding(base):
    p = island_b.payload()
    assert p["grid"] == {"x0": -150, "y0": -150, "cell": 5, "n": 260}
    assert p["forest"] in ("grove", "mass") and len(p["version"]) >= 8
    n = p["grid"]["n"]
    coast = np.frombuffer(base64.b64decode(p["coast"]), dtype=np.int8)
    region = np.frombuffer(base64.b64decode(p["region"]), dtype=np.uint8)
    near = np.frombuffer(base64.b64decode(p["near"]), dtype=np.uint8)
    assert coast.size == region.size == near.size == n * n
    assert set(np.unique(near)) <= {0, 1}
    assert (coast[region != 255] > 0).all()
    assert set(p["extent"]) == {"minX", "minY", "maxX", "maxY"}
    json.dumps(p)


def test_map_b_base_route_and_config_feature(client):
    response = client.get("/api/map-b/base")
    assert response.status_code == 200
    assert "max-age=3600" in response.headers["cache-control"]
    assert response.json()["grid"]["n"] == 260
    assert client.get("/api/config").json()["features"]["map_b"] is False


def test_islands_with_map_b_become_villages(fresh_client):
    akari = Person(fresh_client, "akari@example.com", "あかり")
    akari.post(MOUNTAINS_A)
    plain = fresh_client.get("/api/islands").json()["islands"]
    assert "region_id" not in plain[0]
    assert plain[0]["label"].endswith("島")
    islands = fresh_client.get("/api/islands?map=b").json()["islands"]
    assert len(islands) == 1
    island = islands[0]
    assert island["label"] == island["name"] + "村"
    assert island["regions"] == []
    assert island["region_id"] is None or 0 <= island["region_id"] < 16
    if island["region_id"] is not None:
        assert island["region_name"] == island_b.region_name(island["region_id"])


def test_base_is_built_on_first_use_when_the_flag_is_off(client):
    import app as application

    island_b._cache.clear()
    assert island_b.base() is None
    assert client.get("/api/map-b/base").status_code == 200
    assert island_b.base() is not None


def test_a_name_already_ending_in_mura_gets_no_second_mura(fresh_client):
    import app as application

    out = application.as_map_b([{"name": "山村", "label": "山村島", "cx": 500, "cy": 500},
                                {"name": "山", "label": "山島", "cx": 500, "cy": 500}])
    assert [i["label"] for i in out] == ["山村", "山村"]
