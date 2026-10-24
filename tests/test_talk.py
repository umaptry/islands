"""「話してみたい」(仮名) and the DM that opens when both press (2026-10-26).

MemoryStore and the /api/local/* stand-ins keep the same rules as
supabase/migrations/20261026000000_talk_and_dm.sql; these tests are the Python half
of that promise. Everybody here is made up.
"""

from datetime import datetime, timedelta, timezone

import pytest

import app as application
from conftest import CAMPING_A, CAMPING_B, CAMPING_C
from core import notifications as notices
from core.config import (
    DM_ERROR_SEND,
    NOTIFICATION_CATEGORY_OF,
    RECRUIT_TAG,
    TALK_ERROR_LOGIN,
    TALK_ERROR_NOT_PEER,
    TALK_ERROR_SELF,
    TALK_LABEL,
)

# Words that make people think of romance: the legal check says the screen must not use them.
ROMANCE = ("恋", "好き", "デート", "告白", "カップル", "彼氏", "彼女", "愛", "モテ", "マッチ")


@pytest.fixture
def cast(people):
    """host (posts a meeting), guest and guest2 (join it), outsider (does not)."""
    host = people("host@example.com", "ホスト")
    guest = people("guest@example.com", "ゲスト")
    guest2 = people("guest2@example.com", "ゲスト二")
    outsider = people("outsider@example.com", "そと")
    meeting = host.post(CAMPING_A, tags=[RECRUIT_TAG])
    assert guest.react(meeting["id"], "join").status_code == 200
    assert guest2.react(meeting["id"], "join").status_code == 200
    return host, guest, guest2, outsider, meeting


def get(person, path):
    return person.client.get(path, headers=person.headers)


def press(person, target):
    return person.client.post("/api/local/talk/press", json={"target": target.id},
                              headers=person.headers)


def feed(person):
    return get(person, "/api/local/notifications/feed").json()["notifications"]


def room_id(person, other):
    states = get(person, "/api/local/talk/state").json()["state"]
    return next(row["room_id"] for row in states if row["target"] == other.id and row["state"] == "matched")


# --------------------------------------------------------------------------
# config
# --------------------------------------------------------------------------

def test_config_names_the_button_and_turns_the_feature_on(fresh_client):
    config = fresh_client.get("/api/config").json()
    assert config["talk"] == {"label": TALK_LABEL}
    assert config["features"]["talk"] is True
    assert not any(word in TALK_LABEL for word in ROMANCE)


def test_every_talk_sentence_is_free_of_romance_words():
    sentences = [application.PUSH_TEXT[key] for key in ("talk_wish", "talk_match", "dm")]
    sentences += [TALK_ERROR_LOGIN, TALK_ERROR_SELF, TALK_ERROR_NOT_PEER, DM_ERROR_SEND]
    for sentence in sentences:
        assert not any(word in sentence for word in ROMANCE), sentence


def test_new_types_sit_under_the_existing_switches():
    assert NOTIFICATION_CATEGORY_OF["talk_wish"] == "reaction"
    assert NOTIFICATION_CATEGORY_OF["talk_match"] == "reaction"
    assert NOTIFICATION_CATEGORY_OF["dm"] == "reply"


# --------------------------------------------------------------------------
# who can be pressed
# --------------------------------------------------------------------------

def test_peers_are_the_people_in_the_same_meeting(cast):
    host, guest, guest2, outsider, _ = cast
    assert sorted(get(guest, "/api/local/talk/peers").json()["peers"]) == sorted([host.id, guest2.id])
    assert sorted(get(host, "/api/local/talk/peers").json()["peers"]) == sorted([guest.id, guest2.id])
    assert get(outsider, "/api/local/talk/peers").json()["peers"] == []


def test_a_post_without_the_recruiting_tag_makes_no_peers(people):
    host, guest = people("h@example.com", "ホスト"), people("g@example.com", "ゲスト")
    plain = host.post(CAMPING_B)
    guest.react(plain["id"], "join")
    assert get(guest, "/api/local/talk/peers").json()["peers"] == []
    assert press(guest, host).status_code == 422


def test_pressing_needs_login_a_peer_and_somebody_else(cast, fresh_client):
    host, guest, _, outsider, _ = cast
    assert fresh_client.post("/api/local/talk/press", json={"target": host.id}).status_code == 401
    refused = press(guest, guest)
    assert refused.status_code == 422 and refused.json()["detail"] == TALK_ERROR_SELF
    refused = press(outsider, host)
    assert refused.status_code == 422 and refused.json()["detail"] == TALK_ERROR_NOT_PEER
    assert press(guest, outsider).json()["detail"] == TALK_ERROR_NOT_PEER
    assert press(guest, type("Nobody", (), {"id": "no-such-person"})).json()["detail"] == TALK_ERROR_NOT_PEER


def test_leaving_the_meeting_does_not_make_a_new_press_possible(cast):
    host, guest, *_ = cast
    meeting = cast[4]
    assert guest.unreact(meeting["id"], "join").status_code == 200
    # the author is still in; the guest no longer is
    assert press(guest, host).status_code == 422
    assert press(host, guest).status_code == 422


# --------------------------------------------------------------------------
# a one-sided press stays invisible, and tells the other person nothing about who
# --------------------------------------------------------------------------

def test_a_one_sided_press_answers_the_same_every_time(cast):
    host, guest, *_ = cast
    first, second = press(guest, host), press(guest, host)
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json() == {"matched": False, "room_id": None}
    assert get(guest, "/api/local/talk/state").json()["state"] == [
        {"target": host.id, "state": "pressed", "room_id": None}]
    # the host is not told who: nothing in their state, their peers or their rooms
    assert get(host, "/api/local/talk/state").json()["state"] == []
    assert get(host, "/api/local/dm/rooms").json()["rooms"] == []


def test_the_nameless_notice_has_nobody_in_it(cast):
    host, guest, guest2, *_ = cast
    press(guest, host)
    press(guest, host)
    press(guest2, host)
    rows = host.inbox({"talk_wish"})
    assert len(rows) == 1, "twice, and two people: still one line, so the number tells nothing"
    row = rows[0]
    assert row["actor_id"] is None and row["actor"] is None
    for column in ("post_id", "comment_id", "island_id", "event_id", "payload"):
        assert row[column] is None
    entry = next(item for item in feed(host) if item["type"] == "talk_wish")
    assert entry["others"] == 0 and entry["category"] == "reaction"
    assert entry["actors"] == [{"id": None}]
    assert get(guest, "/api/local/notifications").json()["notifications"] == []


def read_all(person, kinds):
    ids = [row["id"] for row in person.inbox(kinds)]
    person.client.post("/api/local/notifications/read", json={"ids": ids}, headers=person.headers)


def test_after_it_is_read_the_next_person_who_presses_is_told_at_once(cast):
    host, guest, guest2, *_ = cast
    press(guest, host)
    press(guest2, host)
    assert len(host.inbox({"talk_wish"})) == 1, "unread: any number of people, one line"
    read_all(host, {"talk_wish"})
    guest2.client.post("/api/local/talk/withdraw", json={"target": host.id}, headers=guest2.headers)
    press(guest2, host)
    rows = host.inbox({"talk_wish"})
    assert len(rows) == 2, "read, so the next press makes a new line right away (no 24 hours)"
    assert sum(1 for row in rows if not row["read_at"]) == 1
    assert all(row["actor_id"] is None for row in rows)


def test_one_person_cannot_keep_notifying_the_same_person(cast):
    host, guest, *_ = cast
    store = application.state["store"]
    press(guest, host)
    for _ in range(3):
        read_all(host, {"talk_wish"})
        guest.client.post("/api/local/talk/withdraw", json={"target": host.id}, headers=guest.headers)
        press(guest, host)
    assert len(host.inbox({"talk_wish"})) == 1, "press, withdraw, press: once per 14 days"
    # after 14 days the record is gone and the same person can notify again
    store._talk_wish_notices[(guest.id, host.id)] = (
        datetime.now(timezone.utc) - timedelta(days=15)).isoformat()
    read_all(host, {"talk_wish"})
    guest.client.post("/api/local/talk/withdraw", json={"target": host.id}, headers=guest.headers)
    press(guest, host)
    assert len(host.inbox({"talk_wish"})) == 2


def test_the_notice_record_is_kept_only_when_a_notice_was_written(cast):
    host, guest, guest2, *_ = cast
    store = application.state["store"]
    press(guest, host)
    press(guest2, host)  # covered by the unread line: nothing written, nothing recorded
    assert (guest.id, host.id) in store._talk_wish_notices
    assert (guest2.id, host.id) not in store._talk_wish_notices


def test_an_old_unread_dm_notice_does_not_mute_a_new_one(cast):
    host, guest, *_ = cast
    store = application.state["store"]
    press(guest, host)
    room = press(host, guest).json()["room_id"]
    send = lambda text: guest.client.post(f"/api/local/dm/rooms/{room}/messages",
                                          json={"body": text}, headers=guest.headers)
    send("one"); send("two")
    assert len(host.inbox({"dm"})) == 1
    old = (datetime.now(timezone.utc) - timedelta(minutes=11)).isoformat()
    for row in store._notifications.values():
        if row["type"] == "dm":
            row["created_at"] = old
    send("three")
    assert len(host.inbox({"dm"})) == 2


def test_the_push_for_a_one_sided_press_names_nobody(cast):
    host, guest, *_ = cast
    press(guest, host)
    entry = next(item for item in feed(host) if item["type"] == "talk_wish")
    message = application.push_message(entry)
    assert message["title"] == "だれか"
    assert message["body"] == f"誰かが、あなたと{TALK_LABEL}と言っています"
    assert "ゲスト" not in repr(message)
    # even a row that (wrongly) carried an actor would not be read for the text
    entry["actors"] = [{"id": guest.id, "display_name": "ゲスト"}]
    assert "ゲスト" not in repr(application.push_message(entry))


def test_a_press_is_withdrawn_and_the_notice_stays(cast):
    host, guest, *_ = cast
    press(guest, host)
    done = guest.client.post("/api/local/talk/withdraw", json={"target": host.id}, headers=guest.headers)
    assert done.status_code == 200 and done.json() == {"ok": True}
    assert get(guest, "/api/local/talk/state").json()["state"] == []
    assert len(host.inbox({"talk_wish"})) == 1
    # withdrawn: the host pressing now is a first press, not a match
    assert press(host, guest).json() == {"matched": False, "room_id": None}


def test_presses_older_than_two_weeks_are_swept(cast, loaded):
    host, guest, guest2, *_ = cast
    store = application.state["store"]
    press(guest, host)
    old = (datetime.now(timezone.utc) - timedelta(days=15)).isoformat()
    store._talk_wishes[(guest.id, host.id)]["created_at"] = old
    assert get(guest, "/api/local/talk/state").json()["state"] == []
    # the sweep happens on the next press by anybody; the old wish can no longer match
    assert press(guest2, host).json() == {"matched": False, "room_id": None}
    assert (guest.id, host.id) not in store._talk_wishes
    assert press(host, guest).json() == {"matched": False, "room_id": None}


# --------------------------------------------------------------------------
# both press: the room opens
# --------------------------------------------------------------------------

def test_both_pressing_opens_a_room_and_tells_both_by_name(cast):
    host, guest, *_ = cast
    meeting = cast[4]
    press(guest, host)
    answer = press(host, guest).json()
    assert answer["matched"] is True and answer["room_id"]
    assert press(guest, host).json() == answer, "pressing again after the match says the same"
    guest_rows, host_rows = guest.inbox({"talk_match"}), host.inbox({"talk_match"})
    assert [row["actor_id"] for row in guest_rows] == [host.id]
    assert [row["actor_id"] for row in host_rows] == [guest.id]
    assert guest_rows[0]["actor"]["display_name"] == "ホスト"
    assert room_id(host, guest) == room_id(guest, host) == answer["room_id"]
    # the pressed state turned into matched for both
    assert get(host, "/api/local/talk/state").json()["state"] == [
        {"target": guest.id, "state": "matched", "room_id": answer["room_id"]}]
    rooms = get(guest, "/api/local/dm/rooms").json()["rooms"]
    assert len(rooms) == 1
    assert rooms[0]["other_id"] == host.id and rooms[0]["other_name"] == "ホスト"
    assert rooms[0]["event_post_id"] == meeting["id"]
    assert rooms[0]["event_excerpt"] == meeting["body"][:30]
    assert rooms[0]["blocked_by_me"] is False and rooms[0]["last_body"] is None
    # the nameless notice for the first press is still only a nameless notice
    assert [row["actor_id"] for row in host.inbox({"talk_wish"})] == [None]
    store = application.state["store"]
    assert store._talk_wishes == {}
    assert sum(day["matched"] for day in store._talk_stats.values()) == 1


def test_the_match_push_names_the_other_person(cast):
    host, guest, *_ = cast
    press(guest, host)
    press(host, guest)
    entry = next(item for item in feed(guest) if item["type"] == "talk_match")
    message = application.push_message(entry)
    assert message["title"] == "ホスト"
    assert message["body"] == f"ホストさんと、お互いに『{TALK_LABEL}』でした。DMが開きました"


def test_talk_rows_are_never_folded_together(cast):
    host, guest, guest2, *_ = cast
    press(guest, host)
    press(host, guest)
    press(guest2, host)
    press(host, guest2)
    kinds = [item["type"] for item in feed(host)]
    # two matches, one line each; the second wish was not added to the unread first one
    assert kinds.count("talk_match") == 2 and kinds.count("talk_wish") == 1


def test_group_feed_keeps_likes_chained_but_not_talk_rows():
    now = datetime.now(timezone.utc)
    rows = []
    for index, kind in enumerate(["like", "like", "talk_wish", "talk_wish"]):
        rows.append({"id": str(index), "type": kind, "post_id": None if kind == "talk_wish" else "p",
                     "actor_id": None if kind == "talk_wish" else f"a{index}", "read_at": None,
                     "created_at": (now + timedelta(seconds=index)).isoformat()})
    entries = notices.group_feed(rows)
    assert sorted(entry["type"] for entry in entries) == ["like", "talk_wish", "talk_wish"]
    assert next(entry for entry in entries if entry["type"] == "like")["others"] == 1
    assert all(entry["others"] == 0 for entry in entries if entry["type"] == "talk_wish")


def test_the_settings_switches_cover_the_new_types():
    settings = notices.merge_settings([{"category": "reaction", "push": False, "in_app": True}])
    assert notices.allows(settings, "talk_wish", "in_app") and not notices.allows(settings, "talk_wish", "push")
    assert notices.allows(settings, "dm", "push")


# --------------------------------------------------------------------------
# the DM
# --------------------------------------------------------------------------

@pytest.fixture
def matched(cast):
    host, guest, guest2, outsider, _ = cast
    press(guest, host)
    press(host, guest)
    return host, guest, guest2, outsider, room_id(host, guest)


def send(person, room, body):
    return person.client.post(f"/api/local/dm/rooms/{room}/messages", json={"body": body},
                              headers=person.headers)


def test_two_people_talk_and_nobody_else_reads(matched):
    host, guest, guest2, outsider, room = matched
    first = send(guest, room, "こんにちは")
    assert first.status_code == 200
    message = first.json()["message"]
    assert set(message) == {"id", "room_id", "sender_id", "body", "created_at"}
    assert message["sender_id"] == guest.id and message["room_id"] == room
    assert send(host, room, "どうも").status_code == 200
    seen = get(host, f"/api/local/dm/rooms/{room}/messages").json()["messages"]
    assert [m["body"] for m in seen] == ["こんにちは", "どうも"]
    later = host.client.get(f"/api/local/dm/rooms/{room}/messages", headers=host.headers,
                            params={"after": message["created_at"]}).json()["messages"]
    assert [m["body"] for m in later] == ["どうも"]
    for stranger in (outsider, guest2):
        assert get(stranger, f"/api/local/dm/rooms/{room}/messages").status_code == 404
        refused = send(stranger, room, "のぞき")
        assert refused.status_code == 403 and refused.json()["detail"] == DM_ERROR_SEND
        assert get(stranger, "/api/local/dm/rooms").json()["rooms"] == []
    rooms = get(host, "/api/local/dm/rooms").json()["rooms"]
    assert rooms[0]["last_body"] == "どうも"


def test_message_length_is_checked_after_trimming(matched):
    _, guest, _, _, room = matched
    assert send(guest, room, "  \n　 ").status_code == 422
    assert send(guest, room, "あ" * 1001).status_code == 422
    assert send(guest, room, "あ" * 1000).status_code == 200
    assert send(guest, room, "  は  ").status_code == 200


def test_a_new_message_notifies_once_and_never_carries_the_text(matched):
    host, guest, *_ , room = matched
    send(guest, room, "秘密の本文その一")
    send(guest, room, "秘密の本文その二")
    rows = host.inbox({"dm"})
    assert len(rows) == 1 and rows[0]["actor_id"] == guest.id
    assert rows[0]["post_id"] is None and rows[0]["comment_id"] is None and rows[0]["payload"] is None
    assert "秘密" not in repr(rows)
    entry = next(item for item in feed(host) if item["type"] == "dm")
    message = application.push_message(entry)
    assert message["title"] == "ゲスト" and message["body"] == "ゲストさんからメッセージが届きました"
    assert "秘密" not in repr(message)
    assert guest.inbox({"dm"}) == []
    # read, then another message: a new line
    host.client.post("/api/local/notifications/read", json={"ids": [rows[0]["id"]]}, headers=host.headers)
    send(guest, room, "三つ目")
    assert len(host.inbox({"dm"})) == 2


def test_blocking_stops_both_directions_quietly(matched):
    host, guest, *_, room = matched
    assert guest.client.post("/api/local/dm/blocks", json={"blocked_id": host.id},
                             headers=guest.headers).json() == {"ok": True}
    assert send(guest, room, "?").status_code == 403
    refused = send(host, room, "?")
    assert refused.status_code == 403 and refused.json()["detail"] == DM_ERROR_SEND
    assert get(guest, "/api/local/dm/rooms").json()["rooms"][0]["blocked_by_me"] is True
    assert get(host, "/api/local/dm/rooms").json()["rooms"][0]["blocked_by_me"] is False
    # the blocked person can still read what was said, and is told nothing
    assert get(host, f"/api/local/dm/rooms/{room}/messages").status_code == 200
    assert host.inbox({"dm"}) == []
    assert guest.id not in get(host, "/api/local/talk/peers").json()["peers"]
    assert host.id not in get(guest, "/api/local/talk/peers").json()["peers"]
    assert press(host, guest).json()["detail"] == TALK_ERROR_NOT_PEER
    assert press(guest, host).json()["detail"] == TALK_ERROR_NOT_PEER
    # lifting it
    done = guest.client.delete(f"/api/local/dm/blocks/{host.id}", headers=guest.headers)
    assert done.json() == {"ok": True}
    assert send(host, room, "また").status_code == 200
    assert host.id in get(guest, "/api/local/talk/peers").json()["peers"]


def test_a_block_by_the_other_side_alone_also_stops_sending(matched):
    host, guest, *_, room = matched
    host.client.post("/api/local/dm/blocks", json={"blocked_id": guest.id}, headers=host.headers)
    assert send(guest, room, "?").status_code == 403
    host.client.delete(f"/api/local/dm/blocks/{guest.id}", headers=host.headers)
    assert send(guest, room, "!").status_code == 200


def test_blocking_yourself_or_nobody_is_refused(matched):
    host, *_ = matched
    assert host.client.post("/api/local/dm/blocks", json={"blocked_id": host.id},
                            headers=host.headers).status_code == 422
    assert host.client.post("/api/local/dm/blocks", json={"blocked_id": "nobody"},
                            headers=host.headers).status_code == 422


def test_dm_routes_need_login(matched, fresh_client):
    *_, room = matched
    assert fresh_client.get("/api/local/dm/rooms").status_code == 401
    assert fresh_client.get("/api/local/talk/peers").status_code == 401
    assert fresh_client.get("/api/local/talk/state").status_code == 401
    assert fresh_client.post(f"/api/local/dm/rooms/{room}/messages", json={"body": "x"}).status_code == 401
    assert fresh_client.post("/api/local/dm/blocks", json={"blocked_id": "x"}).status_code == 401


def test_health_reports_talk_without_making_the_app_unready(fresh_client):
    body = fresh_client.get("/api/health").json()
    assert body["talk_ready"] is True and body["ready"] is True


def test_features_talk_follows_the_store(fresh_client, monkeypatch):
    monkeypatch.setattr(application.state["store"], "supports_talk", False, raising=False)
    assert fresh_client.get("/api/config").json()["features"]["talk"] is False
