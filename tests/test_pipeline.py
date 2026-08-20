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
    before = np.array(client.get("/api/map").json()["seed"], dtype=float)
    for index in range(5):
        response = client.post("/api/join", json={
            "icon_id": str(index),
            "name": f"drift{index}",
            "text": f"{CAMPING_A}あと、最近は{index}番目の道具を買い足しました。",
        })
        assert response.status_code == 200, response.text
    after = np.array(client.get("/api/map").json()["seed"], dtype=float)
    assert np.array_equal(before, after)


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
