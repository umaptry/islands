"""誰の名前をサーバーが出してよいか（core/visibility.py）と、線から外れること（2026-11-01）。

accounts_read を閉じたあと、ブラウザが読めるのは：本人・同じコミュニティ・DM の相手・（管理者だけ）承認待ちの人。
サーバーは自分の鍵で誰でも読めるので、名前を出す前にここを通す。ここに出てくる人はみんな作り話。
"""

import uuid

import pytest

import app as application
from conftest import CAMPING_A, CAMPING_B, CAMPING_C
from core import notifications as notices
from core import visibility
from core.config import HIDDEN_PERSON_NAME


def store():
    return application.state["store"]


def join(person, cid, admin):
    store().claim_invite(person.id, store().create_invite(admin.id, cid, 60)["code"])


@pytest.fixture
def world(people):
    """Two communities: コクヨ (admin, ann, bob) and べつ (other, cy). dee is in neither."""
    admin = people("admin@example.test", "かんり")
    ann = people("ann@example.test", "あん")
    bob = people("bob@example.test", "ぼぶ")
    other = people("other@example.test", "べつ")
    cy = people("cy@example.test", "しー")
    dee = people("dee@example.test", "でぃー")
    kokuyo = store().create_community("コクヨ", "kokuyo", admin.id)
    bar = store().create_community("BAR", "bar", other.id)
    for person in (ann, bob):
        join(person, kokuyo, admin)
    join(cy, bar, other)

    class World:
        pass

    w = World()
    w.admin, w.ann, w.bob, w.other, w.cy, w.dee = admin, ann, bob, other, cy, dee
    w.kokuyo, w.bar = kokuyo, bar
    return w


# --------------------------------------------------------------------------
# visible_ids / display_name_for
# --------------------------------------------------------------------------

def test_before_the_lockdown_everybody_is_visible(world):
    w = world
    assert store().members_only() is False
    ids = [w.ann.id, w.cy.id, w.dee.id]
    assert visibility.visible_ids(w.dee.id, ids, store=store()) == set(ids)
    assert visibility.display_name_for(w.dee.id, store().get_account(w.cy.id), store=store()) == "しー"


def test_the_viewer_and_the_same_community_are_visible_and_strangers_are_not(world):
    w = world
    store().set_members_only(True)
    everybody = [w.admin.id, w.ann.id, w.bob.id, w.other.id, w.cy.id, w.dee.id]
    assert visibility.visible_ids(w.ann.id, everybody, store=store()) == {w.admin.id, w.ann.id, w.bob.id}
    assert visibility.visible_ids(w.cy.id, everybody, store=store()) == {w.other.id, w.cy.id}
    assert visibility.visible_ids(w.dee.id, everybody, store=store()) == {w.dee.id}, "oneself, always"
    assert visibility.visible_ids(None, everybody, store=store()) == set()
    assert visibility.visible_ids(w.ann.id, [], store=store()) == set()


def test_display_name_for_gives_the_name_or_the_words_for_an_outsider(world):
    w = world
    store().set_members_only(True)
    ann_row, cy_row = store().get_account(w.ann.id), store().get_account(w.cy.id)
    assert visibility.display_name_for(w.bob.id, ann_row, store=store()) == "あん"
    assert visibility.display_name_for(w.bob.id, cy_row, store=store()) == HIDDEN_PERSON_NAME == "（このコミュニティの外の人）"
    assert visibility.display_name_for(w.bob.id, w.cy.id, store=store()) == HIDDEN_PERSON_NAME, "an id works too"
    assert visibility.display_name_for(w.dee.id, store().get_account(w.dee.id), store=store()) == "でぃー"


def test_a_dm_partner_stays_visible_across_communities(world):
    w = world
    store().set_members_only(True)
    assert w.cy.id not in visibility.visible_ids(w.ann.id, [w.cy.id], store=store())
    room = str(uuid.uuid4())
    low, high = sorted((w.ann.id, w.cy.id))
    store()._dm_rooms[room] = {"id": room, "user_a": low, "user_b": high, "event_post_id": None, "created_at": "2026-11-01T00:00:00+00:00"}
    assert visibility.visible_ids(w.ann.id, [w.cy.id], store=store()) == {w.cy.id}
    assert visibility.visible_ids(w.cy.id, [w.ann.id], store=store()) == {w.ann.id}
    assert w.bob.id not in visibility.visible_ids(w.cy.id, [w.bob.id], store=store())


def test_somebody_waiting_is_seen_by_the_admins_of_that_community_only(world):
    w = world
    store().set_members_only(True)
    invite = store().create_invite(w.admin.id, w.kokuyo, 60, needs_approval=True)
    store().claim_invite(w.dee.id, invite["code"])
    assert visibility.visible_ids(w.admin.id, [w.dee.id], store=store()) == {w.dee.id}
    assert visibility.visible_ids(w.ann.id, [w.dee.id], store=store()) == set(), "a plain member does not"
    assert visibility.visible_ids(w.other.id, [w.dee.id], store=store()) == set()
    store().decide_join_request(w.admin.id, w.kokuyo, w.dee.id, False)
    assert visibility.visible_ids(w.admin.id, [w.dee.id], store=store()) == set(), "gone once decided"


def test_mask_person_hides_the_name_the_face_and_the_profile(world):
    w = world
    store().set_members_only(True)
    row = {"id": w.cy.id, "display_name": "しー", "icon_id": "5", "avatar_path": "a/b.png",
           "affiliation": "どこか", "bio": "こんにちは", "topics": ["x"], "goal": "g"}
    masked = visibility.mask_person(w.ann.id, row, store=store())
    assert masked["display_name"] == HIDDEN_PERSON_NAME and masked["icon_id"] == "0" and masked["avatar_path"] is None
    assert masked["affiliation"] is None and masked["bio"] is None and masked["topics"] == [] and masked["goal"] is None
    assert row["display_name"] == "しー", "the original is not touched"
    assert visibility.mask_person(w.bob.id, dict(row, id=w.ann.id), store=store())["display_name"] == "しー"


# --------------------------------------------------------------------------
# where the server prints names
# --------------------------------------------------------------------------

def feed_entry(recipient, kind, **extra):
    rows = [r for r in store().list_notifications(recipient.id) if r["type"] == kind]
    return notices.group_feed(rows)[0] | extra


def test_a_push_does_not_name_somebody_the_recipient_cannot_see(world):
    w = world
    post_row = w.ann.post(CAMPING_A, community_id=w.kokuyo)
    store().add_reaction(post_row["id"], w.bob.id, "join")
    entry = feed_entry(w.ann, "join")
    assert application.push_message(entry)["title"] == "ぼぶ"
    store().set_members_only(True)
    assert application.push_message(entry)["title"] == "ぼぶ", "bob is in コクヨ with ann"
    store().leave_community(w.bob.id, w.kokuyo)
    message = application.push_message(entry)
    assert message["title"] == HIDDEN_PERSON_NAME and "ぼぶ" not in repr(message)


def test_a_push_to_an_admin_names_the_person_waiting_but_not_to_a_plain_member(world):
    w = world
    store().set_members_only(True)
    invite = store().create_invite(w.admin.id, w.kokuyo, 60, needs_approval=True)
    store().claim_invite(w.dee.id, invite["code"])
    entry = feed_entry(w.admin, "join_request")
    assert application.push_message(entry)["body"] == "でぃーさんが『コクヨ』への参加を待っています"
    forged = dict(entry, recipient_id=w.ann.id)
    assert "でぃー" not in application.push_message(forged)["body"]


def test_a_bare_entry_without_a_recipient_is_left_alone():
    entry = {"type": "like", "category": "reaction", "id": "n1", "created_at": "2026-11-01T00:00:00+00:00",
             "actors": [{"id": "x", "display_name": "ミナ"}], "others": 0, "post_id": "p1"}
    assert application.push_message(entry)["title"] == "ミナ"


def test_the_near_posts_card_hides_an_author_who_has_left(world):
    w = world
    mine = w.ann.post(CAMPING_A, community_id=w.kokuyo)
    theirs = w.bob.post(CAMPING_B, community_id=w.kokuyo)
    store().set_members_only(True)
    rows = application.neighbor_rows([(theirs["id"], 0.9)], mine.get("terms") or [], community=w.kokuyo, viewer=w.ann.id)
    assert rows[0]["display_name"] == "ぼぶ"
    store().leave_community(w.bob.id, w.kokuyo)
    rows = application.neighbor_rows([(theirs["id"], 0.9)], mine.get("terms") or [], viewer=w.ann.id)
    assert rows[0]["display_name"] == HIDDEN_PERSON_NAME and rows[0]["avatar_path"] is None and rows[0]["icon_id"] == "0"
    assert rows[0]["author_id"] == w.bob.id and rows[0]["body"], "the post itself is still the community's"
    # with no viewer named nothing is changed (the older callers)
    assert application.neighbor_rows([(theirs["id"], 0.9)], [])[0]["display_name"] == "ぼぶ"


def test_the_faces_on_an_island_are_hidden_per_viewer_without_touching_the_shared_copy(world):
    w = world
    store().set_members_only(True)
    residents = [{"id": w.ann.id, "display_name": "あん", "icon_id": "1", "avatar_path": None},
                 {"id": w.cy.id, "display_name": "しー", "icon_id": "2", "avatar_path": "x.png"}]
    islands = [{"name": "島", "residents": residents}]
    shown = application.hide_unseen_residents(islands, w.bob.id)
    assert [r["display_name"] for r in shown[0]["residents"]] == ["あん", HIDDEN_PERSON_NAME]
    assert [r["display_name"] for r in islands[0]["residents"]] == ["あん", "しー"], "the cached island is shared"
    assert application.hide_unseen_residents(islands, None) is islands


def test_the_person_card_of_a_stranger_has_no_name(world):
    w = world
    store().set_members_only(True)
    w.cy.post(CAMPING_C, community_id=w.bar)
    own = w.ann.client.get(f"/api/people/{w.bob.id}/card", headers=w.ann.headers).json()
    assert own["person"]["display_name"] == "ぼぶ"
    card = w.ann.client.get(f"/api/people/{w.cy.id}/card", headers=w.ann.headers).json()
    assert card["person"]["display_name"] == HIDDEN_PERSON_NAME and card["person"]["avatar_path"] is None
    assert card["post_count"] == 0


def test_the_local_notice_list_hides_a_stranger_who_reacted(world):
    w = world
    post_row = w.ann.post(CAMPING_A, community_id=w.kokuyo)
    store().add_reaction(post_row["id"], w.bob.id, "like")
    store().set_members_only(True)
    store().leave_community(w.bob.id, w.kokuyo)
    feed = w.ann.client.get("/api/local/notifications/feed", headers=w.ann.headers).json()["notifications"]
    entry = next(e for e in feed if e["type"] == "like")
    assert [a["display_name"] for a in entry["actors"]] == [HIDDEN_PERSON_NAME]


# --------------------------------------------------------------------------
# 線とカード：今のメンバーだけ
# --------------------------------------------------------------------------

def lines_of(cid):
    return application.connection_lines(force=True, community=cid)


def test_a_person_who_left_has_no_line_on_that_communitys_map(world):
    w = world
    mine = w.ann.post(CAMPING_A, community_id=w.kokuyo)
    w.bob.post(CAMPING_B, community_id=w.kokuyo)
    assert w.bob.comment(mine["id"], "いいですね").status_code == 200
    application.invalidate_connections()
    rows = lines_of(w.kokuyo)
    assert [{r["a"], r["b"]} for r in rows] == [{w.ann.id, w.bob.id}]
    assert store().leave_community(w.bob.id, w.kokuyo) is True
    application.invalidate_connections()
    assert lines_of(w.kokuyo) == [], "nothing runs to somebody who is no longer in"


def test_a_reply_to_a_person_who_left_still_counts_towards_the_post_owner(world):
    w = world
    mine = w.ann.post(CAMPING_A, community_id=w.kokuyo)
    w.admin.post(CAMPING_B, community_id=w.kokuyo)
    store().add_comment(mine["id"], w.bob.id, "最初のコメント")
    first = next(c for c in store()._comments.values() if c["author_id"] == w.bob.id)
    store().add_comment(mine["id"], w.admin.id, "返信です", reply_to=first["id"])
    store().leave_community(w.bob.id, w.kokuyo)
    application.invalidate_connections()
    pairs = [{r["a"], r["b"]} for r in lines_of(w.kokuyo)]
    assert {w.admin.id, w.ann.id} in pairs
    assert all(w.bob.id not in pair for pair in pairs)
