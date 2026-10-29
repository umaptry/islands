"""つながりの通知 (2026-10-29): a new post that connects to an older one tells the older post's writer.

notify_matches() in app.py (the 'match' notification), built on the same pick_connections() as the
cards (GET /api/matches). Local mode (MemoryStore); the background thread is switched off by
conftest (ISLANDS_AUTO_MATCH_NOTICE=0), so a test calls notify_matches() itself. Everybody here is
made up.
"""

import logging
import threading

import pytest

import app as application
from conftest import BOOKKEEPING, CAMPING_A, CAMPING_B, CAMPING_C
from core import matching
from core.store import StoreError


def store():
    return application.state["store"]


@pytest.fixture
def low_bars(monkeypatch):
    """The ONNX cosine is on another scale than production's: let anything through."""
    monkeypatch.setattr(matching, "MATCH_COSINE_COMPLEMENT", -2.0)
    monkeypatch.setattr(matching, "MATCH_COSINE_SAME", -2.0)


@pytest.fixture
def pair(fresh_client, people, low_bars):
    """older (Q: CAMPING_B, 'past') and newer, who has not posted yet."""

    class Pair:
        pass

    p = Pair()
    p.client = fresh_client
    p.older = people("older@example.test", "せんぱい")
    p.newer = people("newer@example.test", "あたらしい")
    p.q = p.older.post(CAMPING_B, prompt="past")
    return p


def matches_of(person):
    return person.inbox(["match"])


# -- who is told, and what the row holds ---------------------------------------

def test_the_older_writer_is_told_and_nobody_else(pair, people):
    bystander = people("by@example.test", "ぼうかん")
    bystander.post(BOOKKEEPING, prompt="help")             # need x need never connects
    new_post = pair.newer.post(CAMPING_A, prompt="help")
    rows = application.notify_matches(new_post["id"])
    assert [row["recipient_id"] for row in rows] == [pair.older.id]
    inbox = matches_of(pair.older)
    assert len(inbox) == 1
    row = inbox[0]
    assert row["actor_id"] == pair.newer.id and row["post_id"] == new_post["id"] and row["type"] == "match"
    assert row["payload"] == {"kind": "need_have", "other_post": pair.q["id"],
                              "reason": "あなたの経験が役に立ちそうな困りごとが投稿されました"}
    assert matches_of(pair.newer) == [] and matches_of(bystander) == []


# kind (new post's author -> older post's author), the new post, the older post, the line the older reads.
TABLE = [
    ("need_have", ("help", []), ("past", []), "あなたの経験が役に立ちそうな困りごとが投稿されました"),
    ("have_need", ("past", []), ("help", []), "あなたの困りごとに、経験のある人が投稿しました"),
    ("want_have", ("future", []), ("past", []), "あなたがやっていたことを、やってみたい人が投稿しました"),
    ("have_want", ("past", []), ("future", []), "あなたのやってみたいことを、やっている人が投稿しました"),
    ("want_want", ("future", []), ("future", []), "あなたと同じことをやりたがっている人が投稿しました"),
    ("need_want", ("help", []), ("future", []), "あなたと同じことに取り組もうとしている人が投稿しました"),
    ("have_have", ("past", []), ("now", []), "あなたと近いことをしている人が投稿しました"),
    ("near", ("weekly", []), ("past", []), "近いことを書いている人が投稿しました"),
]


@pytest.mark.parametrize("kind,new,old,reason", TABLE)
def test_the_line_for_every_kind(fresh_client, people, low_bars, kind, new, old, reason):
    older, newer = people("o@example.test", "o"), people("n@example.test", "n")
    older.post(CAMPING_B, prompt=old[0], tags=old[1])
    new_post = newer.post(CAMPING_A, prompt=new[0], tags=new[1])
    application.notify_matches(new_post["id"])
    [row] = matches_of(older)
    assert row["payload"]["kind"] == kind and row["payload"]["reason"] == reason


def test_the_table_has_a_line_for_every_kind():
    assert set(matching.NOTICE_REASONS) == {kind for kind, _ in matching.REASONS.values()} | {"near"}
    assert {kind for kind, *_ in TABLE} == set(matching.NOTICE_REASONS)


def test_at_most_three_are_told_per_new_post(fresh_client, people, low_bars):
    olds = [people(f"o{i}@example.test", f"o{i}") for i in range(5)]
    for person in olds:
        person.post(CAMPING_B, prompt="past")
    newer = people("n@example.test", "n")
    rows = application.notify_matches(newer.post(CAMPING_A, prompt="help")["id"])
    assert len(rows) == 3 == sum(len(matches_of(person)) for person in olds)


def test_the_bars_of_the_cards_apply(fresh_client, people):
    older, newer = people("o@example.test", "o"), people("n@example.test", "n")
    older.post(BOOKKEEPING, prompt="past")             # far away on any scale
    assert application.notify_matches(newer.post(CAMPING_A, prompt="help")["id"]) == []
    assert matches_of(older) == []


def test_no_limit_per_day(pair, people):
    """Many new posts the same day tell the same older writer every time (the founder's decision)."""
    for _ in range(4):
        new_post = pair.newer.post(CAMPING_A, prompt="help")
        assert len(application.notify_matches(new_post["id"])) == 1
    assert len(matches_of(pair.older)) == 4


def test_the_same_post_and_person_are_told_once(pair):
    new_post = pair.newer.post(CAMPING_A, prompt="help")
    assert len(application.notify_matches(new_post["id"])) == 1
    assert application.notify_matches(new_post["id"]) == []
    assert len(matches_of(pair.older)) == 1


def test_one_person_with_two_older_posts_is_told_once(pair):
    pair.older.post(CAMPING_C, prompt="past")
    new_post = pair.newer.post(CAMPING_A, prompt="help")
    assert len(application.notify_matches(new_post["id"])) == 1


def test_a_second_post_of_the_writer_is_not_a_notice_to_themselves(pair):
    pair.newer.post(CAMPING_C, prompt="past")           # newer's own older post
    new_post = pair.newer.post(CAMPING_A, prompt="help")
    application.notify_matches(new_post["id"])
    assert matches_of(pair.newer) == []


# -- who is never told -----------------------------------------------------------

@pytest.mark.parametrize("blocker_is_newer", [True, False])
def test_nobody_on_either_side_of_a_block_is_told(pair, blocker_is_newer):
    first, second = (pair.newer, pair.older) if blocker_is_newer else (pair.older, pair.newer)
    store().block_dm(first.id, second.id)
    application.notify_matches(pair.newer.post(CAMPING_A, prompt="help")["id"])
    assert matches_of(pair.older) == []


def test_a_deleted_older_post_tells_nobody(pair):
    assert pair.older.client.delete(f"/api/posts/{pair.q['id']}", headers=pair.older.headers).status_code == 200
    assert application.notify_matches(pair.newer.post(CAMPING_A, prompt="help")["id"]) == []


def test_a_deleted_new_post_tells_nobody(pair):
    new_post = pair.newer.post(CAMPING_A, prompt="help")
    assert pair.newer.client.delete(f"/api/posts/{new_post['id']}", headers=pair.newer.headers).status_code == 200
    assert application.notify_matches(new_post["id"]) == []


class Communities:
    pass


@pytest.fixture
def communities(fresh_client, people, low_bars):
    """Communities A (admin, older, newer, leaver) and B (far). The members-only switch is on."""
    w = Communities()
    w.client = fresh_client
    w.admin = people("admin@example.test", "かんり")
    w.far_admin = people("faradmin@example.test", "かんりB")
    w.older = people("older@example.test", "せんぱい")
    w.newer = people("newer@example.test", "あたらしい")
    w.leaver = people("leaver@example.test", "ぬけた")
    w.far = people("far@example.test", "とおい")
    w.A = store().create_community("A", "a", w.admin.id)
    w.B = store().create_community("B", "b", w.far_admin.id)
    for person, community, admin in ((w.older, w.A, w.admin), (w.newer, w.A, w.admin),
                                     (w.leaver, w.A, w.admin), (w.far, w.B, w.far_admin)):
        store().claim_invite(person.id, store().create_invite(admin.id, community, 60)["code"])
    store().set_members_only(True)
    application.invalidate_islands()
    yield w
    application.state.pop("members_only_hint", None)
    application.invalidate_islands()


def test_only_members_of_the_same_community_are_told(communities):
    w = communities
    w.older.post(CAMPING_B, prompt="past", community_id=w.A)
    w.far.post(CAMPING_B, prompt="past", community_id=w.B)
    new_post = w.newer.post(CAMPING_A, prompt="help", community_id=w.A)
    [row] = application.notify_matches(new_post["id"])
    assert row["recipient_id"] == w.older.id and str(row["community_id"]) == str(w.A)
    assert matches_of(w.far) == []


def test_somebody_who_left_the_community_is_not_told(communities):
    w = communities
    w.leaver.post(CAMPING_B, prompt="past", community_id=w.A)
    store().leave_community(w.leaver.id, w.A)
    new_post = w.newer.post(CAMPING_A, prompt="help", community_id=w.A)
    assert application.notify_matches(new_post["id"]) == []
    assert matches_of(w.leaver) == []


def test_a_member_who_left_does_not_use_up_one_of_the_three(communities, people):
    w = communities
    w.leaver.post(CAMPING_B, prompt="past", community_id=w.A)
    store().leave_community(w.leaver.id, w.A)
    stayers = [people(f"s{i}@example.test", f"s{i}") for i in range(3)]
    for person in stayers:
        store().claim_invite(person.id, store().create_invite(w.admin.id, w.A, 60)["code"])
        person.post(CAMPING_B, prompt="past", community_id=w.A)
    rows = application.notify_matches(w.newer.post(CAMPING_A, prompt="help", community_id=w.A)["id"])
    assert sorted(row["recipient_id"] for row in rows) == sorted(person.id for person in stayers)


def test_a_shared_copy_tells_nobody(communities):
    w = communities
    store().claim_invite(w.newer.id, store().create_invite(w.far_admin.id, w.B, 60)["code"])
    w.far.post(CAMPING_B, prompt="past", community_id=w.B)         # B's older post that the copy would join
    original = w.newer.post(CAMPING_A, prompt="help", community_id=w.A)
    application.notify_matches(original["id"])
    assert matches_of(w.far) == []
    response = w.client.post(f"/api/posts/{original['id']}/share", json={"community_ids": [w.B]},
                             headers=w.newer.headers)
    assert response.status_code == 200, response.text
    assert [row for row in response.json()["posts"] if str(row["community_id"]) == str(w.B)]
    assert matches_of(w.far) == []                                 # sharing is not a new post for this


# -- it never costs the post -----------------------------------------------------

def join_notice_threads():
    for thread in threading.enumerate():
        if thread.name == "match-notice":
            thread.join(timeout=10)


def test_the_post_goes_through_and_the_notice_follows_in_the_background(pair, monkeypatch):
    monkeypatch.setenv("ISLANDS_AUTO_MATCH_NOTICE", "1")
    new_post = pair.newer.post(CAMPING_A, prompt="help")
    join_notice_threads()
    [row] = matches_of(pair.older)
    assert row["post_id"] == new_post["id"]


def test_a_database_that_refuses_the_row_leaves_the_post_alone(pair, monkeypatch, caplog):
    """The SQL of 20261029020000 not run yet: notifications_type_check refuses 'match'."""
    monkeypatch.setenv("ISLANDS_AUTO_MATCH_NOTICE", "1")

    def refuse(rows):
        raise StoreError("通知の保存に失敗しました (23514)")

    monkeypatch.setattr(store(), "insert_notifications", refuse)
    with caplog.at_level(logging.WARNING, logger="app"):
        response = pair.client.post("/api/posts", json={"body": CAMPING_A, "tags": [], "motivation": 50,
                                                        "prompt": "help"}, headers=pair.newer.headers)
        join_notice_threads()
    assert response.status_code == 200, response.text
    assert any("match notice failed" in record.getMessage() for record in caplog.records)
    assert store().get_post(response.json()["id"]) is not None
    assert matches_of(pair.older) == []


def test_a_failing_thread_start_leaves_the_post_alone(pair, monkeypatch):
    def broken(post_id):
        raise RuntimeError("cannot start")

    monkeypatch.setattr(application, "start_match_notice", broken)
    assert pair.newer.post(CAMPING_A, prompt="help")["id"]


def test_any_failure_inside_is_swallowed(pair, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(application, "pick_connections", broken)
    assert application.notify_matches(pair.newer.post(CAMPING_A, prompt="help")["id"]) == []


def test_the_switch_stops_it(pair, monkeypatch):
    monkeypatch.setenv("ISLANDS_MATCH_NOTICE", "0")
    monkeypatch.setenv("ISLANDS_AUTO_MATCH_NOTICE", "1")
    new_post = pair.newer.post(CAMPING_A, prompt="help")
    join_notice_threads()
    assert application.start_match_notice(new_post["id"]) is None
    assert application.notify_matches(new_post["id"]) == []
    assert matches_of(pair.older) == []


def test_the_answer_to_the_writer_does_not_wait_for_the_notice(pair, monkeypatch):
    monkeypatch.setenv("ISLANDS_AUTO_MATCH_NOTICE", "1")
    gate = threading.Event()
    seen = []
    real = application.notify_matches

    def slow(post_id, now=None):
        gate.wait(timeout=10)
        seen.append(post_id)
        return real(post_id, now)

    monkeypatch.setattr(application, "notify_matches", slow)
    new_post = pair.newer.post(CAMPING_A, prompt="help")          # returns while the notice is still waiting
    assert seen == [] and matches_of(pair.older) == []
    gate.set()
    join_notice_threads()
    assert seen == [new_post["id"]] and len(matches_of(pair.older)) == 1


def test_the_cards_and_the_notice_agree(pair):
    """Same pick_connections: the card shown to the new writer names the person who is told."""
    new_post = pair.newer.post(CAMPING_A, prompt="help")
    cards = pair.client.get(f"/api/matches?post={new_post['id']}", headers=pair.newer.headers).json()["matches"]
    rows = application.notify_matches(new_post["id"])
    assert [card["author_id"] for card in cards] == [row["recipient_id"] for row in rows]
    assert cards[0]["kind"] == rows[0]["payload"]["kind"]
