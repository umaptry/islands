"""Stage 4 of the islands redesign: meeting people.

A suggested person always comes with a reason (Q15), the people most like you
come first (Q52), a first line is offered to start talking (Q44), the person
card shows who somebody is and who they talk to, and the away digest names
the people behind a change. Every person and post here is made up for the test.
"""

from datetime import datetime, timedelta, timezone

import pytest

from conftest import BOOKKEEPING, CAMPING_A, CAMPING_B
from core import introductions
from test_people_layer import CAMPER, app_module, fake_island, put_profile  # noqa: F401

NEAR = {"topics": ["キャンプ", "アウトドア", "焚き火"], "goal": "テント泊に慣れて山で一晩過ごしたい"}


# --------------------------------------------------------------------------
# pure functions
# --------------------------------------------------------------------------

def test_a_shared_island_leads_and_at_most_three_reasons_are_given():
    found = introductions.reasons(
        {"seeking": "火のおこし方"}, {"offering": "焚き火のこつ", "seeking": "写真の撮り方"},
        {"topics": 0.9, "goal": 0.8, "posts": 0.7},
        seeking=0.9, offering=0.9, shared_islands=["焚き火山島"], shared_topics=["キャンプ", "焚き火"],
    )
    assert [row["kind"] for row in found] == ["island", "topics", "seeking"]
    assert found[0]["text"] == "同じ焚き火山島にいます"
    assert found[1]["text"] == "共通の話題「キャンプ」「焚き火」"


def test_helping_is_only_said_in_the_direction_that_holds():
    me, other = {"seeking": "簿記の勉強法"}, {"offering": "簿記の教え方"}
    found = introductions.reasons(me, other, {}, seeking=0.8, offering=0.8)
    assert [row["kind"] for row in found] == ["seeking"], "the other person seeks nothing"
    found = introductions.reasons(me, {}, {}, seeking=0.8, offering=0.8)
    assert found == [], "the other person offers nothing, and nothing else is known"


def test_a_weak_match_still_comes_with_a_reason():
    found = introductions.reasons({}, {}, {"topics": 0.1, "goal": 0.3, "posts": None})
    assert found == [{"kind": "goal", "text": "目標が少し近いです"}]
    assert introductions.reasons({}, {}, {}) == []


def test_the_first_line_follows_the_leading_reason():
    topics = [{"kind": "topics", "text": "共通の話題「焚き火」"}]
    assert introductions.opener(topics, {}, ["焚き火"]).startswith("私も「焚き火」が")
    assert "同じ島" in introductions.opener([{"kind": "island", "text": ""}], {})
    assert introductions.opener([], {}) == "投稿を読んで声をかけました。よろしくお願いします。"


def test_the_people_behind_a_change_are_counted_before_it():
    now = datetime(2026, 11, 1, tzinfo=timezone.utc)

    def event(actor, post, days):
        return {"actor_id": actor, "post_id": post, "created_at": (now - timedelta(days=days)).isoformat()}

    events = [event("mio", "p1", 3), event("mio", "p2", 2), event("kenta", "p1", 1),
              event("me", "p1", 1), event("late", "p1", -1), event("other", "q9", 1)]
    found = introductions.contributors(["p1", "p2"], events, before=now, exclude={"me"})
    assert found == ["mio", "kenta"]


# --------------------------------------------------------------------------
# through the app
# --------------------------------------------------------------------------

def test_every_similar_person_comes_with_a_reason_and_their_island(people, app_module):
    me = people("me@example.com", "わたし")
    near = people("near@example.com", "ちかい")
    books = people("books@example.com", "ぼき")
    c = me.client
    put_profile(c, me, **CAMPER)
    put_profile(c, near, **NEAR)
    put_profile(c, books, topics=["簿記", "会計"], goal="来年の春に簿記二級に合格する")
    me.post(CAMPING_A)
    near.post(CAMPING_B)

    ranked = c.get("/api/similar-people", headers=me.headers).json()["people"]
    assert ranked[0]["id"] == near.id
    for row in ranked:
        assert row["reasons"], row
        assert len(row["reasons"]) <= 3
        assert all(set(reason) == {"kind", "text"} for reason in row["reasons"])
    assert "topics" in [reason["kind"] for reason in ranked[0]["reasons"]]
    assert "island" in ranked[0]


def test_the_person_card_shows_who_they_are_and_what_you_share(people, app_module):
    me = people("me@example.com", "わたし")
    near = people("near@example.com", "ちかい")
    friend = people("f@example.com", "ともだち")
    put_profile(me.client, me, **CAMPER)
    put_profile(me.client, near, bio="週末は山にいます。", seeking="冬の寝袋選び", offering="焚き火のこつ", **NEAR)
    near.post(BOOKKEEPING)
    latest = near.post(CAMPING_B)
    friend.react(latest["id"], "like")

    card = me.client.get(f"/api/people/{near.id}/card", headers=me.headers)
    assert card.status_code == 200, card.text
    card = card.json()
    assert card["person"]["display_name"] == "ちかい"
    assert card["person"]["bio"] == "週末は山にいます。"
    assert (card["person"]["seeking"], card["person"]["offering"]) == ("冬の寝袋選び", "焚き火のこつ")
    assert card["latest_post"]["id"] == latest["id"]
    assert card["post_count"] == 2
    assert [row["id"] for row in card["connections"]] == [friend.id]
    assert card["connections"][0]["display_name"] == "ともだち"
    assert card["connected"] is False
    assert card["reasons"] and card["opener"]
    assert "vec_topics" not in card["person"]

    # Nobody looking: the card still opens, with nothing to share.
    plain = me.client.get(f"/api/people/{near.id}/card").json()
    assert plain["reasons"] == [] and plain["opener"] is None
    # Looking at yourself gives no reasons either.
    assert me.client.get(f"/api/people/{me.id}/card", headers=me.headers).json()["opener"] is None
    # The public `viewer` question, as /api/similar-people's `account`.
    asked = me.client.get(f"/api/people/{near.id}/card", params={"viewer": me.id}).json()
    assert asked["reasons"] == card["reasons"]
    assert me.client.get("/api/people/nobody/card").status_code == 404


def test_the_card_lists_at_most_five_connections(people, app_module):
    host = people("host@example.com", "ぬし")
    own = host.post(CAMPING_A)
    guests = [people(f"g{i}@example.com", f"きゃく{i}") for i in range(7)]
    for guest in guests:
        guest.react(own["id"], "like")
    card = host.client.get(f"/api/people/{host.id}/card").json()
    assert len(card["connections"]) == 5
    assert card["connection_count"] == 7


def test_the_digest_names_the_people_behind_a_change(people, app_module, monkeypatch):
    akari = people("a@example.com", "あかり")
    mio = people("m@example.com", "みお")
    kenta = people("k@example.com", "けんた")
    quiet = people("q@example.com", "しずか")
    ids = [akari.post(f"{CAMPING_A} その{i}")["id"] for i in range(2)]
    ids.append(quiet.post(BOOKKEEPING)["id"])
    mio.react(ids[0], "like")
    mio.comment(ids[1], "いいですね")
    kenta.react(ids[1], "like")
    steps = iter([
        [fake_island("山", ids[:1], 0.2), fake_island("火", ids[1:2], 0.8), fake_island("簿記", ids[2:], 0.5)],
        [fake_island("山 / 火", ids[:2], 0.5), fake_island("簿記", ids[2:], 0.5)],
    ])
    monkeypatch.setattr(app_module, "live_islands", lambda force=False: next(steps))
    app_module.track_islands()
    app_module.track_islands()

    changes = akari.client.get("/api/changes/digest", headers=akari.headers).json()["changes"]
    merge = next(row for row in changes if row["kind"] == "merge")
    assert [person["display_name"] for person in merge["people"]] == ["みお", "けんた"]
    assert merge["people_role"] == "interaction"
    assert all(person["id"] != akari.id for row in changes for person in row["people"]), \
        "you are not the news"
    born = [row for row in changes if row["kind"] == "birth" and row["people"]
            and row["people"][0]["id"] == quiet.id]
    for row in born:
        assert row["people_role"] == "posts", "an island nobody touched names who posted there"


@pytest.mark.parametrize("path", ["/api/similar-people"])
def test_asking_without_signing_in_or_naming_anybody_is_refused(people, app_module, path):
    me = people("me@example.com", "わたし")
    assert me.client.get(path).status_code == 401
