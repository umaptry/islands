"""End-to-end checks against the frozen artifacts.

    python -m pytest tests/ -v

These are the properties the whole design exists to provide. If any of them
break, the map has stopped meaning what the UI claims it means.
"""

import os
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ["KOTOBA_DISABLE_RATE_LIMIT"] = "1"

pytest.importorskip("fastapi")

CAMPING_A = "週末はソロキャンプに出かけて、焚き火を眺めながら静かに過ごすのが好きです。"
CAMPING_B = "山で野営をするのが趣味で、薪を割って火をおこす時間がいちばん落ち着きます。"
# Shares vocabulary with A, unlike B which says the same kind of thing in
# entirely different words.
CAMPING_C = "週末はキャンプで焚き火を眺めるのが好きです。道具を少しずつ揃えています。"
BOOKKEEPING = "簿記二級の勉強をしています。毎晩、過去問を解いてから寝るのが日課になりました。"


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient

    import app as application

    with TestClient(application.app) as test_client:
        yield test_client


@pytest.fixture(scope="module")
def loaded(client):
    """The app state, guaranteed populated by the lifespan."""
    import app as application

    return application.state


# --------------------------------------------------------------------------
# the core guarantee: same text -> same coordinate, forever
# --------------------------------------------------------------------------

def test_projection_is_deterministic(loaded):
    import app as application

    results = [application.project(CAMPING_A) for _ in range(3)]
    for other in results[1:]:
        assert other[0] == results[0][0]
        assert other[1] == results[0][1]
        assert other[2] == results[0][2]


def test_joining_does_not_move_the_seed_map(client, loaded):
    """The frozen map is the whole promise: joining must not shift the terrain.

    Checked against the loaded artifacts rather than the /api/map payload. The
    map response stopped shipping the 1,000 seed points once the client stopped
    drawing them, and the invariant being protected here is about the artifacts,
    not about what happens to be on the wire.
    """
    before = np.array(loaded["seed_coords"], dtype=float).copy()
    before_bounds = list(client.get("/api/map").json()["seed_bounds"])
    for index in range(5):
        response = client.post("/api/join", json={
            "icon_id": str(index),
            "name": f"drift{index}",
            "text": f"{CAMPING_A}あと、最近は{index}番目の道具を買い足しました。",
        })
        assert response.status_code == 200, response.text
    after = np.array(loaded["seed_coords"], dtype=float)
    assert np.array_equal(before, after)
    assert client.get("/api/map").json()["seed_bounds"] == before_bounds


def test_map_payload_does_not_carry_the_seed_corpus(client):
    """1,000 points on every 15-second poll is most of the egress budget."""
    payload = client.get("/api/map").json()
    assert "seed" not in payload
    assert len(payload["seed_bounds"]) == 4


def test_encoder_single_and_batch_agree(loaded):
    encoder = loaded["encoder"]
    rng = np.random.default_rng(0)
    features = rng.normal(size=(8, encoder.input_dim))
    features /= np.linalg.norm(features, axis=1, keepdims=True)
    batch = encoder(features)
    for index, row in enumerate(features):
        assert np.abs(encoder(row) - batch[index]).max() < 1e-12


# --------------------------------------------------------------------------
# the map has to mean something
# --------------------------------------------------------------------------

def test_similar_texts_land_closer_than_unrelated_ones(loaded):
    import app as application

    a = application.project(CAMPING_A)
    b = application.project(CAMPING_B)
    c = application.project(BOOKKEEPING)
    near = np.hypot(a[0] - b[0], a[1] - b[1])
    far = np.hypot(a[0] - c[0], a[1] - c[1])
    assert near < far, f"camping pair {near:.1f}px vs camping/bookkeeping {far:.1f}px"


def test_compound_words_match_across_forms(loaded):
    """写真部 and 写真 are the same interest split by the tokeniser."""
    from core.similarity import shared_keywords

    assert "写真" in shared_keywords(
        ["写真部", "フィルムカメラ", "暗室"], ["写真", "山", "稜線"], loaded["idf"]
    )
    # ...but a one-character collision is not a shared interest.
    assert shared_keywords(["早朝", "稜線"], ["朝", "英会話"], loaded["idf"]) == []


def test_shared_keywords_are_content_not_grammar(loaded):
    from core.features import extract_label_terms
    from core.similarity import shared_keywords

    # extract_label_terms is what app.project stores for display.
    shared = shared_keywords(
        extract_label_terms(CAMPING_A), extract_label_terms(CAMPING_C), loaded["idf"]
    )
    assert "焚き火" in shared
    for junk in ("する", "いる", "ある", "なる", "こと", "もの", "好き", "週末"):
        assert junk not in shared, f"{junk} is filler and must not be offered as a shared word"


def test_rare_shared_words_outrank_common_ones(loaded):
    from core.similarity import shared_keywords

    shared = shared_keywords(
        ["キャンプ", "焚き火", "自作キーボード"],
        ["キャンプ", "自作キーボード", "山"],
        loaded["idf"],
    )
    assert shared.index("自作キーボード") < shared.index("キャンプ")


def test_lexically_disjoint_but_semantically_close_pair(loaded):
    """The interesting case: same topic, no word in common.

    A and B are both about making a fire outdoors and share literally zero
    content words. They must still land near each other, and the UI must have
    something to say instead of an empty chip row.
    """
    import app as application
    from core.features import extract_label_terms
    from core.similarity import describe_relation, shared_keywords, similarity_percent

    terms_a = set(extract_label_terms(CAMPING_A))
    terms_b = set(extract_label_terms(CAMPING_B))
    assert not terms_a & terms_b, "this test is only meaningful for a disjoint pair"

    a = application.project(CAMPING_A)
    b = application.project(CAMPING_B)
    c = application.project(BOOKKEEPING)
    similarity_ab = similarity_percent(np.hypot(a[0] - b[0], a[1] - b[1]), loaded["quantiles"])
    similarity_ac = similarity_percent(np.hypot(a[0] - c[0], a[1] - c[1]), loaded["quantiles"])
    assert similarity_ab > similarity_ac

    shared = shared_keywords(list(terms_a), list(terms_b), loaded["idf"])
    assert shared == []
    assert describe_relation(similarity_ab, shared), "a caption is required when there are no chips"


def test_similarity_is_calibrated(loaded):
    from core.similarity import similarity_percent

    quantiles = loaded["quantiles"]
    assert similarity_percent(0.0, quantiles) == 100
    assert similarity_percent(quantiles[-1] * 2, quantiles) == 0
    assert similarity_percent(quantiles[50], quantiles) == pytest.approx(50, abs=2)


# --------------------------------------------------------------------------
# API contract
# --------------------------------------------------------------------------

def test_short_text_is_rejected(client):
    response = client.post("/api/join", json={"icon_id": "1", "name": "x", "text": "短いです"})
    assert response.status_code == 422
    assert "30" in response.json()["detail"]


def test_map_never_exposes_profile_text(client):
    client.post("/api/join", json={
        "icon_id": "2", "name": "秘密", "text": BOOKKEEPING,
    })
    payload = client.get("/api/map").json()
    assert payload["users"], "expected at least one user"
    for user in payload["users"]:
        assert "text" not in user
        assert "vec" not in user
        assert "edit_token" not in user


def test_contact_details_are_stripped(client):
    response = client.post("/api/join", json={
        "icon_id": "3",
        "name": "連絡先",
        "text": f"{CAMPING_A} 連絡は https://example.com/me か me@example.com までどうぞ。",
    })
    assert response.status_code == 200
    text = response.json()["text"]
    assert "example.com" not in text
    assert "[リンク]" in text and "[メール]" in text


def test_leave_requires_the_edit_token(client):
    created = client.post("/api/join", json={
        "icon_id": "4", "name": "退出", "text": CAMPING_B,
    }).json()

    denied = client.post("/api/leave", json={
        "id": created["id"], "edit_token": "00000000-0000-0000-0000-000000000000",
    })
    assert denied.status_code == 403

    allowed = client.post("/api/leave", json={
        "id": created["id"], "edit_token": created["edit_token"],
    })
    assert allowed.status_code == 200
    assert client.get(f"/api/user/{created['id']}").status_code == 404


def test_join_reports_neighbours_with_shared_words(client):
    client.post("/api/join", json={"icon_id": "5", "name": "野営", "text": CAMPING_B})
    response = client.post("/api/join", json={"icon_id": "6", "name": "焚き火", "text": CAMPING_A})
    assert response.status_code == 200
    payload = response.json()

    assert payload["island"] is not None
    assert payload["neighbors"], "expected neighbours once others exist"
    for neighbour in payload["neighbors"]:
        assert 0 <= neighbour["similarity"] <= 100
        assert "shared" in neighbour
    similarities = [neighbour["similarity"] for neighbour in payload["neighbors"]]
    assert similarities == sorted(similarities, reverse=True)


# --------------------------------------------------------------------------
# 似てる度 comes from the 448-dim cosine, not from the 2-D map distance
# --------------------------------------------------------------------------

# Four people, two topics. The point of the split is that the pair inside each
# topic must beat every pair across topics - which is exactly what ranking by
# map distance failed to do.
CAMERA_A = "週末はフィルムカメラを持って街を歩いています。写真を撮るのが好きで、暗室で現像するのも楽しいです。"
CAMERA_B = "写真が趣味です。一眼レフで風景写真を撮りに山へ出かけます。カメラの機材を集めるのも好きです。"
COOK_A = "料理をするのが好きです。週末は家族のためにパンを焼いたりカレーを煮込んだりしています。"
COOK_B = "毎日自炊しています。和食が得意で、出汁からきちんと取った味噌汁を作るのが好きです。"


def test_artifacts_carry_the_cosine_anchors(loaded):
    """Without these the whole cosine path silently stays switched off."""
    anchors = loaded["cosine_anchors"]
    assert anchors is not None, "run scripts/build_similarity_calibration.py"
    # The floor is NEGATIVE in the centred space: two unrelated people point in
    # slightly opposite directions once the corpus-wide direction is removed.
    assert -1.0 <= anchors["cosine_floor"] < anchors["cosine_ceiling"] <= 1.0


def test_the_scale_and_the_space_are_stamped_together(loaded):
    """The anchors and the centroid have to describe the same space.

    A centred cosine read off an uncentred ruler would be silently wrong rather
    than obviously broken, so serving only centres when the anchors say they
    were measured that way.
    """
    from core.similarity import CENTERED_SPACE, resolve_scale

    anchors = loaded["cosine_anchors"]
    centroid = loaded["cosine_centroid"]
    assert centroid is not None, "run scripts/build_similarity_calibration.py"
    assert anchors["space"] == CENTERED_SPACE
    assert len(centroid["dense_mean"]) == centroid["dense_dim"]

    # The three honest states.
    assert resolve_scale(anchors, centroid) == (anchors, centroid)
    unstamped = {key: value for key, value in anchors.items() if key != "space"}
    assert resolve_scale(unstamped, None) == (unstamped, None), "an old artifact still serves"
    assert resolve_scale(None, None) == (None, None)

    # A half-upgraded artifact must abandon the cosine path rather than read a
    # centred cosine off an uncentred ruler, or the reverse. Both print a
    # plausible wrong number instead of failing, which is why this is checked.
    assert resolve_scale(anchors, None) == (None, None)
    assert resolve_scale(anchors, {"dense_mean": []}) == (None, None)
    assert resolve_scale(unstamped, centroid) == (None, None)


def test_the_similarity_view_recovers_the_blocks_it_splits(loaded):
    """The whole no-migration design rests on this being exact.

    A stored vec is normalize(hstack([dense * 0.65, sparse * 0.35])). Centring
    re-normalises each half to recover the original blocks, so if that recovery
    drifts, every 似てる度 drifts with it.
    """
    import numpy as np

    import app as application
    from core.config import DENSE_WEIGHT, SPARSE_WEIGHT
    from core.similarity import SPARSE_DIM, similarity_view

    vector = application.project(CAMPING_A)[4]
    dense = vector[:-SPARSE_DIM] / np.linalg.norm(vector[:-SPARSE_DIM])
    sparse = vector[-SPARSE_DIM:] / np.linalg.norm(vector[-SPARSE_DIM:])
    rebuilt = np.hstack([dense * DENSE_WEIGHT, sparse * SPARSE_WEIGHT])
    rebuilt /= np.linalg.norm(rebuilt)
    assert np.abs(rebuilt - vector).max() < 1e-6

    centred = similarity_view(vector, loaded["cosine_centroid"])
    assert centred.shape == vector.shape
    assert abs(float(np.linalg.norm(centred)) - 1.0) < 1e-9
    # An unexpected width must degrade to the old behaviour, not raise.
    assert similarity_view([0.1, 0.2], loaded["cosine_centroid"]).size == 2
    assert similarity_view(vector, None) is not None


def test_cosine_percent_is_calibrated_and_monotone(loaded):
    from core.similarity import cosine_percent

    anchors = loaded["cosine_anchors"]
    assert cosine_percent(anchors["cosine_floor"], anchors) == 0
    assert cosine_percent(anchors["cosine_ceiling"], anchors) == 100
    assert cosine_percent(anchors["cosine_floor"] - 0.5, anchors) == 0, "must clip, not go negative"
    assert cosine_percent(1.0, anchors) == 100
    steps = np.linspace(anchors["cosine_floor"], anchors["cosine_ceiling"], 25)
    values = [cosine_percent(step, anchors) for step in steps]
    assert values == sorted(values)


def test_same_topic_outranks_every_cross_topic_pair(loaded):
    """The regression this whole change exists for.

    Ranking on the 2-D coordinates put a different topic at the top for a third
    of the people we measured. The 448-dim cosine has to keep the two camera
    people, and the two cooking people, ahead of any camera/cooking pair.
    """
    import app as application
    from core.similarity import cosine_between, cosine_percent

    anchors = loaded["cosine_anchors"]
    vectors = {
        name: application.project(text)[4]
        for name, text in (
            ("camera_a", CAMERA_A), ("camera_b", CAMERA_B),
            ("cook_a", COOK_A), ("cook_b", COOK_B),
        )
    }

    centroid = loaded["cosine_centroid"]

    def percent(left, right):
        return cosine_percent(
            cosine_between(vectors[left], vectors[right], centroid), anchors
        )

    within = [percent("camera_a", "camera_b"), percent("cook_a", "cook_b")]
    across = [
        percent("camera_a", "cook_a"), percent("camera_a", "cook_b"),
        percent("camera_b", "cook_a"), percent("camera_b", "cook_b"),
    ]
    assert min(within) > max(across), f"within={within} across={across}"


def test_neighbours_are_ordered_by_cosine_not_by_map_distance(loaded):
    from core.similarity import rank_neighbors

    import app as application

    anchors = loaded["cosine_anchors"]
    people = []
    for index, (name, text) in enumerate((
        ("camera_b", CAMERA_B), ("cook_a", COOK_A), ("cook_b", COOK_B),
    )):
        x, y, cluster_id, _terms, vector = application.project(text)
        people.append({"id": name, "x": x, "y": y, "cluster_id": cluster_id, "vec": vector})

    x, y, _cluster, _terms, mine = application.project(CAMERA_A)
    ranked = rank_neighbors(
        {"x": x, "y": y}, people, loaded["quantiles"], limit=3,
        origin_vector=mine, anchors=anchors, centroid=loaded["cosine_centroid"],
    )
    assert ranked[0]["id"] == "camera_b"
    assert [item["similarity"] for item in ranked] == sorted(
        (item["similarity"] for item in ranked), reverse=True
    )
    assert all("vec" not in item for item in ranked), "vectors must not ride along"


def test_similarity_falls_back_to_map_distance(loaded):
    """No anchors, or a row without a vector, must degrade rather than raise."""
    from core.similarity import cosine_between, farthest_neighbor, rank_neighbors

    import app as application

    x, y, cluster_id, _terms, mine = application.project(CAMERA_A)
    other_x, other_y, other_cluster, _t, other_vec = application.project(COOK_A)
    origin = {"x": x, "y": y}

    for entry in (
        {"id": "no-vec", "x": other_x, "y": other_y, "cluster_id": other_cluster, "vec": []},
        {"id": "null-vec", "x": other_x, "y": other_y, "cluster_id": other_cluster, "vec": None},
        {"id": "wrong-size", "x": other_x, "y": other_y, "cluster_id": other_cluster, "vec": [0.1, 0.2]},
    ):
        for anchors in (loaded["cosine_anchors"], None):
            for centroid in (loaded["cosine_centroid"], None, {"dense_mean": [], "dense_dim": 0}):
                ranked = rank_neighbors(
                    origin, [entry], loaded["quantiles"], origin_vector=mine,
                    anchors=anchors, centroid=centroid,
                )
                assert 0 <= ranked[0]["similarity"] <= 100
                assert farthest_neighbor(
                    origin, [entry], loaded["quantiles"], origin_vector=mine,
                    anchors=anchors, centroid=centroid,
                ) is not None

    assert cosine_between(mine, []) is None
    assert cosine_between(None, other_vec) is None
    assert rank_neighbors(origin, [], loaded["quantiles"]) == []


def test_map_similarity_matches_the_profile_sheet(client):
    """The orbit and the bottom sheet must not print two different numbers."""
    me = client.post("/api/join", json={
        "icon_id": "7", "name": "カメラ", "text": CAMERA_A,
    }).json()
    them = client.post("/api/join", json={
        "icon_id": "8", "name": "料理", "text": COOK_A,
    }).json()

    payload = client.get(f"/api/map?viewer={me['id']}").json()
    assert "similarity" in payload
    assert me["id"] not in payload["similarity"], "your own row is not a neighbour"

    sheet = client.get(f"/api/user/{them['id']}?viewer={me['id']}").json()
    assert payload["similarity"][them["id"]] == sheet["similarity"]

    # and no viewer means no table, which is what keeps an old client working
    assert "similarity" not in client.get("/api/map").json()
    for user in payload["users"]:
        assert "vec" not in user


# --------------------------------------------------------------------------
# concurrency: everybody submits at once
# --------------------------------------------------------------------------

def test_tokenizer_survives_concurrent_use():
    """SudachiPy's Tokenizer is a Rust RefCell - sharing one across threads
    raises `RuntimeError: Already borrowed`.

    This is not hypothetical. FastAPI runs sync endpoints in a threadpool and
    Cloud Run gives one process a concurrency of 12, so with a shared singleton
    a room full of people submitting together lost half their joins to 500s
    (measured: 6 of 12). get_tokenizer() hands out one instance per thread.
    """
    from concurrent.futures import ThreadPoolExecutor

    from core.features import extract_content_terms, extract_label_terms

    texts = [CAMPING_A, CAMPING_B, CAMPING_C, BOOKKEEPING, CAMERA_A, COOK_A] * 6

    def tokenize(text):
        return extract_content_terms(text), extract_label_terms(text)

    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(tokenize, texts))

    assert len(results) == len(texts)
    assert all(content for content, _label in results)
    # Same text must tokenize identically no matter which thread got it.
    single = tokenize(CAMPING_A)
    assert all(results[i] == single for i, text in enumerate(texts) if text == CAMPING_A)


def test_concurrent_joins_all_succeed(client):
    """Twelve people pressing the button at the same moment."""
    from concurrent.futures import ThreadPoolExecutor

    people = [
        (f"同時{index}", f"{index % 30}", text)
        for index, text in enumerate([CAMERA_A, CAMERA_B, COOK_A, COOK_B] * 3)
    ]

    def join(person):
        name, icon, text = person
        return client.post("/api/join", json={"icon_id": icon, "name": name, "text": text})

    with ThreadPoolExecutor(max_workers=len(people)) as pool:
        responses = list(pool.map(join, people))

    failed = [(r.status_code, r.text[:120]) for r in responses if r.status_code != 200]
    assert not failed, f"{len(failed)}/{len(people)} joins failed: {failed[:3]}"

    bodies = [r.json() for r in responses]
    assert all(body["island"] for body in bodies), "island naming also tokenizes"
    assert len({body["id"] for body in bodies}) == len(people)
    for body in bodies:
        for neighbour in body["neighbors"]:
            assert 0 <= neighbour["similarity"] <= 100
