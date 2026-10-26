"""ほかのコミュニティにも出す (2026-10-29): one post on the maps of several communities.

The Python half of supabase/migrations/20261029000000_share_group.sql. Each community keeps a row of
its own (its own likes, messages and joins), joined to the others by posts.share_group; editing
changes every copy, deleting takes one copy out or all of them, and a 参加者募集中 post counts its
first-come places over every copy, each person once. Local mode (MemoryStore). Everybody here is
made up.
"""

import pytest

import app as application
from conftest import BOOKKEEPING, CAMPING_A, CAMPING_B, CAMPING_C
from core.config import COMMUNITY_ERROR_POST, MEMBERS_ONLY_NOT_FOUND, RECRUIT_TAG, SHARE_ERROR_NONE, SHARE_ERROR_OFF


def store():
    return application.state["store"]


def join(person, community, admin):
    code = store().create_invite(admin.id, community, 60)["code"]
    store().claim_invite(person.id, code)


class World:
    pass


@pytest.fixture
def world(fresh_client, people):
    """A and B. host is in both (and posts), a_only in A, b_only and b_two in B, ab in both.
    The members-only switch is on."""
    w = World()
    w.client = fresh_client
    w.host = people("host@example.test", "ホスト")
    w.a_only = people("a-only@example.test", "エー")
    w.b_only = people("b-only@example.test", "ビー")
    w.b_two = people("b-two@example.test", "ビーツー")
    w.ab = people("ab@example.test", "両方")
    w.A = store().create_community("A", "a", w.host.id)
    w.B = store().create_community("B", "b", w.host.id)
    join(w.a_only, w.A, w.host)
    join(w.ab, w.A, w.host)
    for person in (w.b_only, w.b_two, w.ab):
        join(person, w.B, w.host)
    store().set_members_only(True)
    application.invalidate_islands()
    yield w
    application.state.pop("members_only_hint", None)
    application.invalidate_islands()


def share(person, post_id, *communities):
    return person.client.post(f"/api/posts/{post_id}/share", json={"community_ids": list(communities)},
                              headers=person.headers)


def by_author(viewer, author):
    """The person's posts as the viewer may read them (the posts_read policy)."""
    return store().posts_by_author(author.id, viewer=viewer.id)


def community_map(person, community):
    response = person.client.get(f"/api/local/communities/{community}/map", headers=person.headers)
    assert response.status_code == 200, response.text
    return response.json()["posts"]


# -- the switch -----------------------------------------------------------------

def test_features_share_follows_the_members_only_switch(world):
    assert world.client.get("/api/config").json()["features"]["share"] is True
    store().set_members_only(False)
    assert world.client.get("/api/config").json()["features"]["share"] is False


def test_sharing_is_refused_while_members_only_is_off(world):
    post = world.host.post(BOOKKEEPING, community_id=world.A)
    store().set_members_only(False)
    response = share(world.host, post["id"], world.B)
    assert response.status_code == 409 and response.json()["detail"] == SHARE_ERROR_OFF


# -- putting a post on another map ----------------------------------------------

def test_a_copy_stands_in_the_other_community_where_the_post_stands(world):
    post = world.host.post(BOOKKEEPING, community_id=world.A)
    response = share(world.host, post["id"], world.B)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["added"] == [world.B]
    assert result["share_group"] == post["id"]
    rows = {row["community_id"]: row for row in result["posts"]}
    assert set(rows) == {world.A, world.B}
    copy = rows[world.B]
    assert copy["id"] != post["id"]
    assert copy["body"] == post["body"] and (copy["x"], copy["y"]) == (post["x"], post["y"])
    assert copy["share_group"] == rows[world.A]["share_group"] == post["id"]
    # Each map shows its own row, and only to its members.
    assert [row["id"] for row in community_map(world.b_only, world.B) if row["author_id"] == world.host.id] == [copy["id"]]
    assert [row["id"] for row in community_map(world.a_only, world.A) if row["author_id"] == world.host.id] == [post["id"]]


def test_somebody_in_one_community_sees_one_copy_and_the_author_sees_both(world):
    post = world.host.post(BOOKKEEPING, community_id=world.A)
    share(world.host, post["id"], world.B)
    assert [row["community_id"] for row in by_author(world.a_only, world.host)] == [world.A]
    assert [row["community_id"] for row in by_author(world.b_only, world.host)] == [world.B]
    assert {row["community_id"] for row in by_author(world.host, world.host)} == {world.A, world.B}


def test_sharing_twice_makes_no_second_copy(world):
    post = world.host.post(BOOKKEEPING, community_id=world.A)
    assert share(world.host, post["id"], world.B).json()["added"] == [world.B]
    again = share(world.host, post["id"], world.B, world.B)
    assert again.status_code == 200 and again.json()["added"] == []
    assert len(store().posts_in_group(post["id"])) == 2


def test_sharing_from_a_copy_joins_the_same_group(world):
    post = world.host.post(BOOKKEEPING, community_id=world.B)
    copy = next(row for row in share(world.host, post["id"], world.A).json()["posts"]
                if row["community_id"] == world.A)
    response = share(world.host, copy["id"], world.B)
    assert response.json()["added"] == [] and response.json()["share_group"] == post["id"]


def test_only_to_a_community_of_the_author(world):
    other = store().create_community("C", "c", world.a_only.id)
    post = world.host.post(BOOKKEEPING, community_id=world.A)
    response = share(world.host, post["id"], other)
    assert response.status_code == 403 and response.json()["detail"] == COMMUNITY_ERROR_POST
    response = share(world.host, post["id"], "not-a-uuid")
    assert response.status_code == 403
    assert share(world.host, post["id"]).json()["detail"] == SHARE_ERROR_NONE


def test_only_the_author_shares(world):
    post = world.ab.post(BOOKKEEPING, community_id=world.A)
    response = share(world.host, post["id"], world.B)
    assert response.status_code == 404 and response.json()["detail"] == MEMBERS_ONLY_NOT_FOUND
    assert store().posts_in_group(post["id"]) == []


def test_a_copy_tells_the_residents_of_its_island_that_somebody_moved_in(world):
    world.b_only.post(CAMPING_A, community_id=world.B)
    world.b_two.post(CAMPING_B, community_id=world.B)
    post = world.host.post(CAMPING_C, community_id=world.A)
    with store()._lock:
        store()._notifications.clear()
    share(world.host, post["id"], world.B)
    told = [row for row in world.b_only.inbox(["island"]) if (row["payload"] or {}).get("kind") == "resident"]
    assert len(told) == 1
    assert told[0]["actor_id"] == world.host.id and told[0]["community_id"] == world.B
    assert told[0]["payload"]["cause"] == "ホストさんが引っ越してきました"
    # Nobody in A is told about B.
    assert [row for row in world.a_only.inbox(["island"])] == []


# -- editing and deleting ---------------------------------------------------------

def test_editing_one_copy_changes_every_copy(world):
    post = world.host.post(BOOKKEEPING, community_id=world.A)
    copy = next(row for row in share(world.host, post["id"], world.B).json()["posts"]
                if row["community_id"] == world.B)
    response = world.host.client.patch(f"/api/posts/{copy['id']}",
                                       json={"body": CAMPING_A, "motivation": 90},
                                       headers=world.host.headers)
    assert response.status_code == 200, response.text
    rows = store().posts_in_group(post["id"])
    assert {row["body"] for row in rows} == {CAMPING_A}
    assert {row["motivation"] for row in rows} == {90}
    assert len({(row["x"], row["y"]) for row in rows}) == 1
    assert (rows[0]["x"], rows[0]["y"]) != (post["x"], post["y"])


def test_deleting_takes_out_one_copy_unless_all_are_asked_for(world):
    post = world.host.post(BOOKKEEPING, community_id=world.A)
    copy = next(row for row in share(world.host, post["id"], world.B).json()["posts"]
                if row["community_id"] == world.B)
    response = world.host.client.delete(f"/api/posts/{copy['id']}", headers=world.host.headers)
    assert response.status_code == 200
    assert [row["id"] for row in store().posts_in_group(post["id"])] == [post["id"]]
    # And back again, then everything at once.
    share(world.host, post["id"], world.B)
    assert len(store().posts_in_group(post["id"])) == 2
    response = world.host.client.delete(f"/api/posts/{post['id']}?scope=all", headers=world.host.headers)
    assert response.status_code == 200
    assert store().posts_in_group(post["id"]) == []
    assert by_author(world.host, world.host) == []


def test_somebody_else_cannot_delete_all_copies(world):
    post = world.host.post(BOOKKEEPING, community_id=world.A)
    share(world.host, post["id"], world.B)
    response = world.ab.client.delete(f"/api/posts/{post['id']}?scope=all", headers=world.ab.headers)
    assert response.status_code == 403
    assert len(store().posts_in_group(post["id"])) == 2


# -- 参加者募集中: the places are counted over every copy ------------------------------

def test_first_come_places_are_counted_over_every_copy_each_person_once(world):
    post = world.host.post("日曜の朝に公園でゆっくりジョギングをします。一緒に走りませんか",
                           community_id=world.A, tags=[RECRUIT_TAG], recruit_capacity=2)
    rows = share(world.host, post["id"], world.B).json()["posts"]
    copy = next(row for row in rows if row["community_id"] == world.B)
    assert copy["recruit_capacity"] == 2

    assert world.a_only.react(post["id"], "join").status_code == 200
    assert world.ab.react(copy["id"], "join").status_code == 200
    # ab is in already (through B): joining in A takes no new place.
    assert world.ab.react(post["id"], "join").status_code == 200
    full = world.b_only.react(copy["id"], "join")
    assert full.status_code == 409 and full.json()["detail"] == "recruit_full"

    rows = {row["community_id"]: row for row in store().posts_in_group(post["id"])}
    assert rows[world.A]["join_count"] == 2 and rows[world.B]["join_count"] == 1
    assert rows[world.A]["group_join_count"] == rows[world.B]["group_join_count"] == 2
    assert rows[world.A]["recruit_closed"] == rows[world.B]["recruit_closed"] == "full"

    # A place comes free in A: somebody in B may take it.
    assert world.a_only.unreact(post["id"], "join").status_code == 200
    assert world.b_only.react(copy["id"], "join").status_code == 200
    assert world.b_two.react(copy["id"], "join").status_code == 409


def test_a_post_on_one_map_counts_as_before(world):
    post = world.host.post("日曜の朝に公園でゆっくりジョギングをします。一緒に走りませんか",
                           community_id=world.A, tags=[RECRUIT_TAG], recruit_capacity=1)
    assert post["share_group"] is None and post["group_join_count"] is None
    assert world.a_only.react(post["id"], "join").status_code == 200
    assert world.ab.react(post["id"], "join").status_code == 409


def test_a_removed_copy_no_longer_counts(world):
    post = world.host.post("日曜の朝に公園でゆっくりジョギングをします。一緒に走りませんか",
                           community_id=world.A, tags=[RECRUIT_TAG], recruit_capacity=1)
    copy = next(row for row in share(world.host, post["id"], world.B).json()["posts"]
                if row["community_id"] == world.B)
    assert world.a_only.react(post["id"], "join").status_code == 200
    assert world.b_only.react(copy["id"], "join").status_code == 409
    world.host.client.delete(f"/api/posts/{post['id']}", headers=world.host.headers)
    assert world.b_only.react(copy["id"], "join").status_code == 200


def test_a_post_longer_than_the_limit_is_not_shared(world):
    from core.config import SHARE_ERROR_LONG
    post = world.host.post(BOOKKEEPING, community_id=world.A)
    with store()._lock:
        store()._posts[post["id"]]["body"] = "長" * 80        # written before the 60-character limit
    response = share(world.host, post["id"], world.B)
    assert response.status_code == 422 and response.json()["detail"] == SHARE_ERROR_LONG
    assert store().posts_in_group(post["id"]) == []


def test_an_edit_that_cannot_reach_every_copy_changes_none(world, monkeypatch):
    post = world.host.post(BOOKKEEPING, community_id=world.A)
    share(world.host, post["id"], world.B)
    from core.store import StoreError

    def broken(*args, **kwargs):
        raise StoreError("更新")
    monkeypatch.setattr(store(), "update_post_group", broken)
    response = world.host.client.patch(f"/api/posts/{post['id']}", json={"motivation": 10},
                                       headers=world.host.headers)
    assert response.status_code == 503
    monkeypatch.undo()
    assert {row["motivation"] for row in store().posts_in_group(post["id"])} == {50}


def test_a_copy_made_before_a_failure_still_tells_its_residents(world, monkeypatch):
    from core.store import StoreError
    world.b_only.post(CAMPING_A, community_id=world.B)
    world.b_two.post(CAMPING_B, community_id=world.B)
    third = store().create_community("C", "c", world.host.id)
    post = world.host.post(CAMPING_C, community_id=world.A)
    with store()._lock:
        store()._notifications.clear()
    real_insert = store().insert_post

    def flaky(record):
        if record.get("community_id") == third:
            raise StoreError("保存")
        return real_insert(record)
    monkeypatch.setattr(store(), "insert_post", flaky)
    response = share(world.host, post["id"], world.B, third)
    assert response.status_code == 503
    # The copy in B was made: it is there, and B's residents were told.
    assert {row["community_id"] for row in store().posts_in_group(post["id"])} == {world.A, world.B}
    told = [row for row in world.b_only.inbox(["island"]) if (row["payload"] or {}).get("kind") == "resident"]
    assert len(told) == 1 and told[0]["community_id"] == world.B
