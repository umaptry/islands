"""Islands as places to belong to (2026-10-28): the 'moved in' notice, the one-line intro and the
residents. Local mode (MemoryStore); the namer is never called. Everybody here is made up."""

import time
from datetime import datetime, timezone

import app as application
from conftest import BOOKKEEPING, CAMPING_A, CAMPING_B, CAMPING_C
from core import notifications as notices
from core.config import ISLAND_RESIDENTS_SHOWN


def store():
    return application.state["store"]


def resident_rows(person):
    return [row for row in person.inbox(["island"]) if (row["payload"] or {}).get("kind") == "resident"]


def camp(people):
    """a and b on one camping island (a was first)."""
    a = people("a@example.test", "アキ")
    b = people("b@example.test", "ビー")
    a.post(CAMPING_A)
    b.post(CAMPING_B)
    return a, b


# -- the 'moved in' notice ---------------------------------------------------

def test_the_first_post_of_a_new_island_tells_nobody(fresh_client, people):
    a = people("a@example.test", "アキ")
    a.post(CAMPING_A)
    assert a.inbox() == []


def test_a_newcomer_on_an_island_tells_its_residents_not_itself(fresh_client, people):
    a, b = camp(people)
    assert len(resident_rows(a)) == 1 and resident_rows(b) == []
    row = resident_rows(a)[0]
    assert row["type"] == "island" and row["actor_id"] == b.id and row["post_id"]
    assert row["payload"]["cause"] == "ビーさんが引っ越してきました"
    assert row["payload"]["name"]
    assert row["community_id"] is None  # members_only is off


def test_a_second_post_by_the_same_person_on_the_island_tells_nobody(fresh_client, people):
    a, b = camp(people)
    b.post(CAMPING_C)
    assert len(resident_rows(a)) == 1


def test_a_post_on_another_island_tells_nobody_here(fresh_client, people):
    a, b = camp(people)
    c = people("c@example.test", "シー")
    c.post(BOOKKEEPING)
    assert len(resident_rows(a)) == 1 and resident_rows(c) == []


def test_nobody_on_either_side_of_a_block_is_told(fresh_client, people):
    a = people("a@example.test", "アキ")
    b = people("b@example.test", "ビー")
    a.post(CAMPING_A)
    b.post(CAMPING_B)                       # a is told about b
    c = people("c@example.test", "シー")
    store().block_dm(a.id, c.id)            # a blocked c ...
    d = people("d@example.test", "ディ")
    store().block_dm(d.id, b.id)            # ... and d blocked b
    c.post(CAMPING_C)
    assert [row["actor_id"] for row in resident_rows(a)] == [b.id]      # not told about c
    assert [row["actor_id"] for row in resident_rows(b)] == [c.id]
    d.post(CAMPING_A)
    assert [row["actor_id"] for row in resident_rows(b)] == [c.id]      # b is not told about d either
    assert d.id in [row["actor_id"] for row in resident_rows(a)]


def test_one_person_gets_at_most_the_daily_total_over_all_islands(fresh_client, people, monkeypatch):
    a, b = camp(people)
    monkeypatch.setattr(application, "RESIDENT_NOTIFY_PER_PERSON_DAY", 2)
    c = people("c@example.test", "シー")
    d = people("d@example.test", "ディ")
    c.post(CAMPING_C)
    d.post(CAMPING_A)
    assert len(resident_rows(a)) == 2       # b, then c: the total stops d
    assert len(resident_rows(b)) == 2       # c and d


def test_each_resident_is_told_but_only_up_to_the_daily_limit(fresh_client, people, monkeypatch):
    a, b = camp(people)
    monkeypatch.setattr(application, "RESIDENT_NOTIFY_PER_DAY", 2)
    c = people("c@example.test", "シー")
    d = people("d@example.test", "ディ")
    c.post(CAMPING_C)
    assert len(resident_rows(a)) == 2 and len(resident_rows(b)) == 1
    d.post(CAMPING_A)
    assert len(resident_rows(a)) == 2          # a is at the limit
    assert len(resident_rows(b)) == 2 and len(resident_rows(c)) == 1


def test_members_only_tells_current_members_of_that_community_only(fresh_client, people):
    admin = people("admin@example.test", "かんり")
    a = people("a@example.test", "アキ")
    ex = people("ex@example.test", "ぬけた")
    other = people("other@example.test", "べつの会")
    new = people("new@example.test", "あたらしい")
    community = store().create_community("A", "a", admin.id)
    elsewhere = store().create_community("B", "b", other.id)
    for person in (a, ex, new):
        store().claim_invite(person.id, store().create_invite(admin.id, community, 60)["code"])
    a.post(CAMPING_A, community_id=community)
    ex.post(CAMPING_B, community_id=community)
    other.post(CAMPING_C, community_id=elsewhere)
    store().set_members_only(True)
    application.invalidate_islands()
    assert store().leave_community(ex.id, community) is True
    application.invalidate_islands()

    new.post(CAMPING_C, community_id=community)
    # (ex posted while the switch was off; that older notice is not what is being checked)
    told = [row for row in resident_rows(a) if row["actor_id"] == new.id]
    assert len(told) == 1 and told[0]["community_id"] == community
    assert [row for row in resident_rows(ex) if row["actor_id"] == new.id] == []
    assert resident_rows(other) == [] and resident_rows(new) == []


def test_the_notice_is_found_by_the_feed_and_pushes_with_the_new_words(fresh_client, people):
    a, b = camp(people)
    feed = notices.group_feed(store().list_notifications(a.id))
    entry = next(e for e in feed if e["type"] == "island")
    message = application.push_message(entry)
    assert message["title"] == "新しい住人"
    assert message["body"] == f"{entry['payload']['name']}にビーさんが引っ越してきました"
    assert message["url"] == "/#/map"
    assert notices.allows(notices.merge_settings([]), "island", "push")
    switched_off = notices.merge_settings([{"category": "island", "push": False, "in_app": True}])
    assert not notices.allows(switched_off, "island", "push")


def test_push_words_do_not_double_san_and_other_pushes_keep_their_url():
    entry = {"type": "island", "category": "island", "id": "n1", "created_at": "2026-10-28T00:00:00+00:00",
             "payload": {"kind": "resident", "name": "キャンプ島"},
             "actors": [{"id": "x", "display_name": "ミナさん"}], "others": 0, "post_id": "p1"}
    message = application.push_message(entry)
    assert message["body"] == "キャンプ島にミナさんが引っ越してきました" and message["url"] == "/#/map"
    plain = dict(entry, payload={"kind": "tier", "name": "キャンプ", "cause": "島が育ちました"})
    assert application.push_message(plain)["url"] == "/#/notifications"
    assert application.push_message(dict(entry, type="like", category="reaction"))["url"] == "/#/notifications"


def test_the_tracking_step_skips_a_person_just_told_a_resident_moved_in(fresh_client, people, monkeypatch):
    a = people("a@example.test", "アキ")
    monkeypatch.setattr(application, "ISLAND_NOTIFY_PER_DAY", 5)
    now = datetime.now(timezone.utc)
    states = [{"id": "11111111-1111-4111-8111-111111111111", "author_ids": [a.id], "active": True}]
    event = {"id": "22222222-2222-4222-8222-222222222222", "kind": "tier", "cause": "tier",
             "island_id": states[0]["id"], "after": {"name": "キャンプ"}}
    assert len(application.notify_islands([event], states, now)) == 1
    store().insert_notifications([{
        "recipient_id": a.id, "actor_id": None, "type": "island", "island_id": states[0]["id"],
        "payload": {"kind": "resident", "name": "キャンプ島", "cause": "x"}}])
    again = dict(event, id="33333333-3333-4333-8333-333333333333")
    assert application.notify_islands([again], states, now) == []


# -- quiet_post is off -------------------------------------------------------

def test_quiet_posts_are_not_made_unless_switched_on(fresh_client, monkeypatch):
    calls = []
    monkeypatch.setattr(application, "track_islands", lambda *a, **k: None)
    monkeypatch.setattr(application, "notify_quiet_posts", lambda *a, **k: calls.append(1) or [])
    monkeypatch.setattr(application, "ISLAND_AUTO_TRACK", True)
    monkeypatch.setattr(store(), "claim_island_run", lambda seconds: True)

    def run():
        assert application.maybe_track_islands() is True
        for _ in range(100):
            if application._island_run_lock.acquire(blocking=False):
                application._island_run_lock.release()
                return
            time.sleep(0.05)

    from core import config
    assert config.QUIET_POST_ENABLED is False
    run()
    assert calls == []
    monkeypatch.setattr(application, "QUIET_POST_ENABLED", True)
    run()
    assert calls == [1]


# -- intro and residents -----------------------------------------------------

def test_the_fallback_intro_uses_topic_words_other_than_the_islands_own_name():
    make = application.island_intro
    assert make({"name": "キャンプ", "label": "キャンプ島", "topics": ["焚き火", "山"]}) == \
        "「焚き火」「山」の話をする人たちが住んでいます"
    assert make({"name": "キャンプ", "label": "キャンプ島", "topics": ["キャンプ", "焚き火", "山"]}) == \
        "「焚き火」「山」の話をする人たちが住んでいます"
    assert make({"name": "キャンプ", "topics": ["焚き火"]}) == "「焚き火」の話をする人たちが住んでいます"
    assert make({"name": "キャンプ", "label": "キャンプ島", "topics": ["キャンプ"]}) is None
    assert make({"name": "キャンプ", "topics": []}) is None


def test_the_ai_intro_wins_and_a_held_name_does_not_show_its_intro():
    island = {"name": "キャンプ", "topics": ["焚き火"], "intro": "焚き火を囲む人たち"}
    assert application.public_island(island)["intro"] == "焚き火を囲む人たち"
    held = dict(island, name_hold="キャンプ")
    assert application.public_island(held)["intro"] == "「焚き火」の話をする人たちが住んでいます"


def test_islands_carry_intro_and_residents_newest_first(fresh_client, people):
    a, b = camp(people)
    c = people("c@example.test", "シー")
    c.post(CAMPING_C)
    body = fresh_client.get("/api/islands").json()["islands"]
    island = next(i for i in body if i["people"] == 3)
    assert [r["display_name"] for r in island["residents"]] == ["シー", "ビー", "アキ"]
    assert set(island["residents"][0]) == {"id", "display_name", "icon_id", "avatar_path"}
    assert island["intro"] is None or isinstance(island["intro"], str)
    for hidden in ("resident_ids", "author_counts", "name_hold"):
        assert hidden not in island
    assert all("residents" in i and "intro" in i for i in body)


def test_residents_are_at_most_five(fresh_client, people):
    for number in range(ISLAND_RESIDENTS_SHOWN + 2):
        people(f"p{number}@example.test", f"人{number}").post(CAMPING_A)
    island = max(fresh_client.get("/api/islands").json()["islands"], key=lambda i: i["people"])
    assert island["people"] == ISLAND_RESIDENTS_SHOWN + 2 and len(island["residents"]) == ISLAND_RESIDENTS_SHOWN


def test_a_saved_ai_intro_reaches_the_island_through_the_overlay(fresh_client, people):
    a, b = camp(people)
    application.track_islands()
    saved = store().island_states()
    assert saved and all("intro" in row for row in saved)
    store().save_island_states([dict(row, name="キャンプ", name_source="ai",
                                     name_basis=row["post_ids"], intro="焚き火を囲む人たち")
                                for row in saved])
    application.invalidate_islands()
    island = next(i for i in fresh_client.get("/api/islands").json()["islands"] if i["people"] == 2)
    assert island["name"] == "キャンプ" and island["intro"] == "焚き火を囲む人たち"
