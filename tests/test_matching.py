"""Match cards (2026-10-29): core/matching.py (pure) and GET /api/matches."""

import pytest

import app as application
from conftest import BOOKKEEPING, CAMPING_A, CAMPING_B, CAMPING_C
from core import matching
from core.matching import pick_matches, stance_of
from core.store import StoreError


def cand(n, prompt=None, tags=(), cosine=0.9, author=None):
    return {"id": f"p{n}", "author_id": author or f"a{n}", "prompt": prompt, "tags": list(tags), "cosine": cosine}


def mine(prompt=None, tags=()):
    return {"author_id": "me", "prompt": prompt, "tags": list(tags)}


# -- stance_of ------------------------------------------------------------

def test_stance_of_reads_prompt_and_tags():
    assert stance_of("help", []) == {"need": True, "want": False, "have": None}
    assert stance_of(None, ["助けてほしい"])["need"] is True
    assert stance_of("future", [])["want"] is True
    assert stance_of(None, ["仲間募集中"])["want"] is True
    assert stance_of(None, ["参加者募集中"])["want"] is True
    assert stance_of("past", [])["have"] == "past"
    assert stance_of("now", [])["have"] == "now"
    other = {"need": False, "want": False, "have": None}
    assert stance_of("weekly", []) == other
    assert stance_of(None, None) == other
    assert stance_of(None, ["気軽に話しかけて"]) == other


# -- the table, row by row ------------------------------------------------

ROWS = [
    # me, other, kind, reason, bar
    (("help", []), ("past", []), "need_have", "あなたの困りごとを、この人は経験しています", 0.40),
    (("help", []), ("now", []), "need_have", "あなたの困りごとに、この人はいま取り組んでいます", 0.40),
    (("past", []), ("help", []), "have_need", "この人の困りごとに、あなたの経験が役に立つかもしれません", 0.40),
    (("now", []), (None, ["助けてほしい"]), "have_need", "この人の困りごとに、あなたの経験が役に立つかもしれません", 0.40),
    (("future", []), ("past", []), "want_have", "あなたのやってみたいことを、この人は前にやっていました", 0.40),
    (("future", []), ("now", []), "want_have", "あなたのやってみたいことを、この人はいまやっています", 0.40),
    (("past", []), ("future", []), "have_want", "あなたがしていることを、この人はやってみたいそうです", 0.40),
    (("now", []), (None, ["仲間募集中"]), "have_want", "あなたがしていることを、この人はやってみたいそうです", 0.40),
    (("future", []), ("future", []), "want_want", "この人も、同じことをやりたがっています", 0.45),
    (("help", []), ("future", []), "need_want", "この人も、同じことに取り組もうとしています", 0.45),
    (("future", []), ("help", []), "need_want", "この人も、同じことに取り組もうとしています", 0.45),
    (("past", []), ("now", []), "have_have", "あなたと近いことをしている人です", 0.45),
    (("now", []), ("now", []), "have_have", "あなたと近いことをしている人です", 0.45),
    (("weekly", []), ("past", []), "near", "近いことを書いている人です", 0.45),
    (("help", []), (None, ["気軽に話しかけて"]), "near", "近いことを書いている人です", 0.45),
    ((None, []), (None, []), "near", "近いことを書いている人です", 0.45),
]


@pytest.mark.parametrize("me,other,kind,reason,bar", ROWS)
def test_every_row_of_the_table(me, other, kind, reason, bar):
    me = mine(*me)
    below = pick_matches(me, [cand(1, *other, cosine=bar - 0.001)])
    at = pick_matches(me, [cand(1, *other, cosine=bar)])
    assert below == []
    assert len(at) == 1 and at[0]["kind"] == kind and at[0]["reason"] == reason
    assert at[0]["id"] == "p1" and at[0]["cosine"] == bar        # the candidate's own fields stay


def test_need_with_need_is_never_shown():
    assert pick_matches(mine("help"), [cand(1, "help", cosine=0.99)]) == []
    assert pick_matches(mine(None, ["助けてほしい"]), [cand(1, "help", cosine=0.99)]) == []


def test_need_comes_first_when_a_post_is_on_several_sides():
    both = cand(1, "help", ["仲間募集中"], cosine=0.9)          # need and want: need wins
    assert pick_matches(mine("past"), [both])[0]["kind"] == "have_need"
    assert pick_matches(mine("future"), [both])[0]["kind"] == "need_want"
    assert pick_matches(mine("help"), [both]) == []


# -- picking --------------------------------------------------------------

def test_me_and_excluded_authors_are_dropped():
    rows = [cand(1, "past", author="me"), cand(2, "past", author="x"), cand(3, "past", author="y")]
    got = pick_matches(mine("help"), rows, excluded_authors={"x"})
    assert [row["id"] for row in got] == ["p3"]


def test_one_per_author_the_best_one():
    rows = [cand(1, "now", cosine=0.6, author="z"),
            cand(2, "past", cosine=0.5, author="z"),
            cand(3, "past", cosine=0.7, author="z")]
    assert [row["id"] for row in pick_matches(mine("help"), rows)] == ["p3"]
    # a better kind beats a higher cosine of a worse one
    rows = [cand(1, "future", cosine=0.9, author="z"), cand(2, "past", cosine=0.5, author="z")]
    assert [row["id"] for row in pick_matches(mine("future"), rows)] == ["p2"]


def test_limit_and_order():
    rows = [cand(1, "past", cosine=0.5), cand(2, "past", cosine=0.8), cand(3, "future", cosine=0.99),
            cand(4, "past", cosine=0.6), cand(5, "help", cosine=0.97)]
    # priority 1 (want_have) by cosine, then priority 2 (want_want, need_want) by cosine
    assert [row["id"] for row in pick_matches(mine("future"), rows)] == ["p2", "p4", "p1"]
    assert [row["id"] for row in pick_matches(mine("future"), rows, limit=5)] == ["p2", "p4", "p1", "p3", "p5"]
    assert len(pick_matches(mine("future"), rows, limit=1)) == 1
    assert pick_matches(mine("future"), rows, limit=0) == []


def test_a_candidate_without_a_cosine_is_skipped():
    row = cand(1, "past")
    row["cosine"] = None
    assert pick_matches(mine("help"), [row]) == []


# -- GET /api/matches -----------------------------------------------------

@pytest.fixture
def low_bars(monkeypatch):
    """The ONNX cosine is on another scale than production's: let anything through."""
    monkeypatch.setattr(matching, "MATCH_COSINE_COMPLEMENT", -2.0)
    monkeypatch.setattr(matching, "MATCH_COSINE_SAME", -2.0)


@pytest.fixture
def camp(fresh_client, people, low_bars):
    class Camp:
        pass

    c = Camp()
    c.client = fresh_client
    c.me = people("me@example.test", "わたし")
    c.you = people("you@example.test", "あなた")
    c.other = people("other@example.test", "ほか")
    c.mine = c.me.post(CAMPING_A, prompt="help")
    c.theirs = c.you.post(CAMPING_B, prompt="past")
    return c


def get_matches(person, post):
    return person.client.get(f"/api/matches?post={post['id']}", headers=person.headers)


def test_the_author_gets_the_cards_with_a_reason(camp):
    response = get_matches(camp.me, camp.mine)
    assert response.status_code == 200
    body = response.json()
    assert body["post"] == camp.mine["id"]
    assert [row["id"] for row in body["matches"]] == [camp.theirs["id"]]
    row = body["matches"][0]
    for key in ("author_id", "display_name", "icon_id", "avatar_path", "body", "tags", "motivation", "x", "y",
                "cluster_id", "similarity", "cosine", "shared", "note", "prompt", "reason", "kind"):
        assert key in row, key
    assert row["kind"] == "need_have" and row["prompt"] == "past" and row["display_name"] == "あなた"
    assert row["reason"] == "あなたの困りごとを、この人は経験しています"


def test_somebody_else_is_told_404_and_nobody_401(camp):
    assert get_matches(camp.you, camp.mine).status_code == 404
    assert get_matches(camp.other, camp.mine).status_code == 404
    assert camp.client.get(f"/api/matches?post={camp.mine['id']}").status_code == 401
    assert camp.client.get("/api/matches?post=nope", headers=camp.me.headers).status_code == 404
    assert camp.client.get("/api/matches", headers=camp.me.headers).status_code == 422


def test_my_other_posts_are_not_cards(camp):
    camp.me.post(CAMPING_C, prompt="past")
    ids = [row["author_id"] for row in get_matches(camp.me, camp.mine).json()["matches"]]
    assert ids == [camp.you.id]


def test_a_blocked_person_is_not_a_card(camp):
    application.state["store"]._dm_blocks.add((camp.you.id, camp.me.id))     # blocked either way
    assert get_matches(camp.me, camp.mine).json()["matches"] == []


def test_the_bars_are_applied(fresh_client, people):
    me, you = people("m@example.test", "m"), people("y@example.test", "y")
    mine_ = me.post(CAMPING_A, prompt="help")
    you.post(BOOKKEEPING, prompt="past")               # far away on any scale
    assert fresh_client.get(f"/api/matches?post={mine_['id']}", headers=me.headers).json()["matches"] == []


def test_the_switch_off_answers_empty(camp, monkeypatch):
    monkeypatch.setenv("ISLANDS_MATCH_CARDS", "0")
    response = get_matches(camp.me, camp.mine)
    assert response.status_code == 200
    assert response.json() == {"post": camp.mine["id"], "matches": []}
    assert get_matches(camp.you, camp.mine).status_code == 404       # the author check still holds


def test_a_failing_store_answers_empty_and_200(camp, monkeypatch):
    def broken(*args, **kwargs):
        raise StoreError("down")

    monkeypatch.setattr(application.state["store"], "nearest_posts", broken)
    response = get_matches(camp.me, camp.mine)
    assert response.status_code == 200 and response.json()["matches"] == []


def test_a_failing_name_lookup_still_answers_200(camp, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(application, "neighbor_rows", broken)
    assert get_matches(camp.me, camp.mine).json()["matches"] == []


def test_another_community_is_not_mixed_in(fresh_client, people, low_bars):
    admin_a, admin_b = people("aa@example.test", "aa"), people("bb@example.test", "bb")
    me, you, far = people("m@example.test", "m"), people("y@example.test", "y"), people("f@example.test", "f")
    store = application.state["store"]
    A = store.create_community("A", "a", admin_a.id)
    B = store.create_community("B", "b", admin_b.id)
    for person, community, admin in ((me, A, admin_a), (you, A, admin_a), (far, B, admin_b)):
        store.claim_invite(person.id, store.create_invite(admin.id, community, 60)["code"])
    store.set_members_only(True)
    application.invalidate_islands()
    try:
        mine_ = me.post(CAMPING_A, prompt="help", community_id=A)
        near = you.post(CAMPING_B, prompt="past", community_id=A)
        far.post(CAMPING_B, prompt="past", community_id=B)
        body = fresh_client.get(f"/api/matches?post={mine_['id']}", headers=me.headers).json()
        assert [row["id"] for row in body["matches"]] == [near["id"]]
        assert fresh_client.get(f"/api/matches?post={mine_['id']}", headers=far.headers).status_code == 404
    finally:
        application.state.pop("members_only_hint", None)
        application.invalidate_islands()
