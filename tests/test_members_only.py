"""Members-only posts (2026-10-27): a post of a community is read by that community's members only.

The Python half of supabase/migrations/20261027000000_members_only_prep.sql and
...010000_members_only_lockdown.sql. MemoryStore and the /api/local/* stand-ins keep the same
rules as the SQL policies, and the server's own routes (which use the service key and so get no
protection from the database) all go through one gate. These tests walk every route for the five
kinds of caller: nobody signed in (anon), a signed-up person in no community (outsider), a member
of ANOTHER community, an ex-member (who may still read and edit their OWN post rows, nothing else
of that community) and a member. Every negative has a positive control beside it. Everybody here
is made up.

app_settings.members_only is the switch: with it OFF every route answers as it always did (the
second half of this file), with it ON non-members get the answer for a post that is not there.
"""

import json
import threading
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

import pytest

import app as application
from conftest import BOOKKEEPING, CAMPING_A, CAMPING_B, CAMPING_C, SOLDERING
from core import webpush
from core.config import (
    COMMUNITY_ERROR_POST,
    MEMBERS_ONLY_COMMUNITY_REQUIRED,
    MEMBERS_ONLY_NOT_FOUND,
    MEMBERS_ONLY_UNAVAILABLE,
    QUIET_POST_MIN_HOURS,
    RECRUIT_TAG,
)
from core.store import SERVICE, MemoryStore, StoreError, SupabaseStore


def store():
    return application.state["store"]


def call(person, method, path, **kwargs):
    """One request as `person` (None = nobody signed in)."""
    client = person.client if person else ANON_CLIENT[0]
    headers = dict(person.headers) if person else {}
    return client.request(method, path, headers=headers, **kwargs)


ANON_CLIENT = [None]


def get(person, path):
    return call(person, "GET", path)


def join(person, community, admin):
    """Become a member the real way: the admin makes an invite, the person claims it."""
    code = store().create_invite(admin.id, community, 60)["code"]
    store().claim_invite(person.id, code)


def ids(rows):
    return {row["id"] for row in rows}


class World:
    pass


@pytest.fixture
def world(fresh_client, people):
    """Two communities with their members, posts that are the same words on purpose, an ex-member
    and an outsider. The switch is OFF when this returns; `on(world)` turns it on."""
    ANON_CLIENT[0] = fresh_client
    w = World()
    w.client = fresh_client
    w.admin_a = people("admin-a@example.test", "Aの管理者")
    w.member_a = people("member-a@example.test", "Aの人")
    w.member_a2 = people("member-a2@example.test", "Aの人二")
    w.member_b = people("member-b@example.test", "Bの人")
    w.both = people("both@example.test", "両方の人")
    w.ex = people("ex@example.test", "抜けた人")
    w.outsider = people("outsider@example.test", "どこにも入っていない人")
    w.A = store().create_community("A", "a", w.admin_a.id)
    w.B = store().create_community("B", "b", w.member_b.id)
    for person in (w.member_a, w.member_a2, w.both, w.ex):
        join(person, w.A, w.admin_a)
    join(w.both, w.B, w.member_b)
    # The same sentences in both communities: a leak across them would show at once.
    w.pa = w.member_a.post(CAMPING_A, community_id=w.A)
    w.pa2 = w.member_a2.post(CAMPING_B, community_id=w.A)
    w.pa3 = w.ex.post(CAMPING_C, community_id=w.A)
    w.pa4 = w.both.post(BOOKKEEPING, community_id=w.A)
    w.pb = w.member_b.post(CAMPING_A, community_id=w.B)
    w.pb2 = w.both.post(CAMPING_B, community_id=w.B)
    w.pb3 = w.member_b.post(CAMPING_C, community_id=w.B)
    w.legacy = w.outsider.post(SOLDERING)            # a post that belongs to no community
    w.a_posts = {w.pa["id"], w.pa2["id"], w.pa3["id"], w.pa4["id"]}
    w.b_posts = {w.pb["id"], w.pb2["id"], w.pb3["id"]}
    application.invalidate_islands()
    application.invalidate_connections()
    yield w
    application.state.pop("members_only_hint", None)     # the next test starts as if nothing was on
    application.invalidate_islands()
    application.invalidate_connections()


def on(w, value=True):
    store().set_members_only(value)
    application.invalidate_islands()
    application.invalidate_connections()


def ex_member(w):
    """`ex` leaves community A (the posts they wrote stay)."""
    assert store().leave_community(w.ex.id, w.A) is True
    application.invalidate_islands()


def unknown():
    return str(uuid.uuid4())


# --------------------------------------------------------------------------
# the switch itself
# --------------------------------------------------------------------------

def test_the_switch_starts_off_and_is_read_from_the_store(fresh_client):
    assert store().members_only() is False
    assert application.members_only_on() is False
    store().set_members_only(True)
    assert application.members_only_on() is True
    assert fresh_client.get("/api/local/settings/members-only").json() == {"members_only": True}
    fresh_client.post("/api/local/settings/members-only", json={"value": False})
    assert application.members_only_on() is False


def test_communities_stay_on_while_the_switch_is_on_even_if_the_table_check_fails(world, monkeypatch):
    on(world)
    monkeypatch.setattr(store(), "supports_communities", False, raising=False)
    assert application.communities_on() is True
    # and posting still goes through the membership gate rather than becoming a post with no community
    response = call(world.member_a, "POST", "/api/posts", json={"body": CAMPING_A, "tags": []})
    assert response.status_code == 200
    assert response.json()["community_id"] == world.A
    on(world, False)
    assert application.communities_on() is False        # the old rule when the switch is off


def test_when_the_switch_cannot_be_read_every_gated_route_answers_503_and_no_data(world, monkeypatch):
    on(world)

    def broken():
        raise StoreError("app_settings")

    monkeypatch.setattr(store(), "members_only", broken)
    for path in (f"/api/neighbors?post={world.pa['id']}", f"/api/islands?community={world.A}",
                 f"/api/connections?community={world.A}", "/api/similar-people",
                 f"/api/people/{world.member_a.id}/card", "/api/changes", "/api/changes/digest",
                 f"/api/map/bounds?community={world.A}",
                 f"/api/pair?a={world.pa['id']}&b={world.pa2['id']}"):
        response = get(world.member_a, path)
        assert response.status_code == 503, path
        assert response.json()["detail"] == MEMBERS_ONLY_UNAVAILABLE
        assert CAMPING_A[:8] not in response.text
    response = call(world.member_a, "POST", "/api/posts", json={"body": CAMPING_A, "tags": []})
    assert response.status_code == 503
    # what is public stays up, and hides what it would show if it could not tell
    assert get(None, "/api/config").status_code == 200
    health = get(None, "/api/health")
    assert health.status_code == 200 and health.json()["posts"] is None


def test_the_gate_never_asks_for_every_community_at_once(world):
    on(world)
    for call_ in (lambda: store().list_terms(), lambda: store().terrain_posts(),
                  lambda: store().nearest_posts(world.pa["id"], 5),
                  lambda: store().nearest_to_vector([0.0] * 4, 5),
                  lambda: store().post_centroids(), lambda: store().count_posts()):
        with pytest.raises(ValueError):
            call_()
    # with a community it answers, and only with that community's posts
    assert {row["id"] for row in store().list_terms(community=world.A)} == world.a_posts
    assert store().count_posts(community=world.B) == len(world.b_posts)
    assert {row["id"] for row in store().terrain_posts(community=world.B)} == world.b_posts
    assert store().count_posts(everything=True) == len(world.a_posts | world.b_posts) + 1
    # off: the old calls work again
    on(world, False)
    assert len(store().list_terms()) == len(world.a_posts | world.b_posts) + 1


# --------------------------------------------------------------------------
# the reads that need membership: member 200, everybody else the answer for "not there"
# --------------------------------------------------------------------------

def reads(w):
    pa, pa2 = w.pa["id"], w.pa2["id"]
    return {
        "islands": f"/api/islands?community={w.A}",
        "connections": f"/api/connections?community={w.A}",
        "bounds": f"/api/map/bounds?community={w.A}",
        "terrain": f"/api/terrain?min_x=-5000&min_y=-5000&max_x=5000&max_y=5000&community={w.A}",
        "changes": f"/api/changes?community={w.A}",
        "neighbors": f"/api/neighbors?post={pa}",
        "pair": f"/api/pair?a={pa}&b={pa2}",
    }


def lookalike(w, name):
    """The same request for something that does not exist."""
    nowhere, ghost = unknown(), unknown()
    return reads(w)[name].replace(w.A, nowhere).replace(w.pa["id"], ghost).replace(w.pa2["id"], unknown())


@pytest.mark.parametrize("name", ["islands", "connections", "bounds", "terrain", "changes", "neighbors", "pair"])
def test_a_member_reads_and_nobody_else_does(world, name):
    on(world)
    ex_member(world)
    path = reads(world)[name]
    assert get(world.member_a, path).status_code == 200                       # positive control
    assert get(world.admin_a, path).status_code == 200
    assert get(None, path).status_code == 401                                  # signed out
    missing = get(world.outsider, lookalike(world, name))
    assert missing.status_code == 404
    for person in (world.outsider, world.member_b, world.ex):
        answer = get(person, path)
        assert answer.status_code == 404, (name, person.email)
        # the very answer for a post / community that is not there: nothing tells them apart
        assert answer.json() == missing.json()
    # the member of a SECOND community that includes this one still reads (control for member_b)
    assert get(world.both, path).status_code == 200


def test_the_community_is_required_for_a_read_that_is_about_one(world):
    on(world)
    for path in ("/api/islands", "/api/map/bounds",
                 "/api/terrain?min_x=-1&min_y=-1&max_x=1&max_y=1"):
        response = get(world.member_a, path)
        assert response.status_code == 422
        assert response.json()["detail"] == MEMBERS_ONLY_COMMUNITY_REQUIRED
    assert get(world.member_a, "/api/islands?community=not-a-uuid").status_code == 404


def test_a_post_is_a_post_of_the_community_it_was_posted_to_and_neighbours_stay_inside(world):
    on(world)
    body = get(world.member_a, f"/api/neighbors?post={world.pa['id']}&limit=50").json()
    found = ids(body["neighbors"])
    assert found and found <= world.a_posts - {world.pa["id"]}
    # the same words stand in B, and B's post is not one of the neighbours
    assert world.pb["id"] not in found
    other = get(world.member_b, f"/api/neighbors?post={world.pb['id']}&limit=50").json()
    assert ids(other["neighbors"]) <= world.b_posts - {world.pb["id"]}
    assert ids(other["neighbors"]) and not (ids(other["neighbors"]) & world.a_posts)
    # a member of both asks about each post and gets each community on its own
    both = get(world.both, f"/api/neighbors?post={world.pb2['id']}&limit=50").json()
    assert ids(both["neighbors"]) <= world.b_posts


def test_pair_needs_two_posts_of_one_community(world):
    on(world)
    cross = f"/api/pair?a={world.pa['id']}&b={world.pb['id']}"
    for person in (world.both, world.member_a, world.member_b):
        assert get(person, cross).status_code == 404       # even a member of both: one map at a time
    assert get(world.both, f"/api/pair?a={world.pa['id']}&b={world.pa4['id']}").status_code == 200


def test_an_author_who_left_cannot_seed_neighbours_pair_or_view_with_an_old_post(world):
    on(world)
    mine = world.pa3["id"]
    assert get(world.ex, f"/api/neighbors?post={mine}").status_code == 200        # control: still a member
    ex_member(world)
    assert get(world.ex, f"/api/neighbors?post={mine}").status_code == 404
    assert get(world.ex, f"/api/pair?a={mine}&b={world.pa['id']}").status_code == 404
    assert call(world.ex, "POST", f"/api/posts/{mine}/view", json={}).status_code == 404
    assert get(world.member_a, f"/api/neighbors?post={mine}").status_code == 200


def test_a_post_with_no_community_is_read_by_nobody_through_the_server(world):
    on(world)
    legacy = world.legacy["id"]
    for person in (world.outsider, world.member_a, world.both):
        assert get(person, f"/api/neighbors?post={legacy}").status_code == 404, person.email
        assert call(person, "POST", f"/api/posts/{legacy}/view", json={}).status_code == 404
    # nor does it land on any map
    for community in (world.A, world.B):
        terrain = get(world.both, f"/api/map/bounds?community={community}").json()
        assert terrain["count"] == len(world.a_posts if community == world.A else world.b_posts)
    # the database refuses to write one
    with pytest.raises(StoreError):
        store().insert_post({"author_id": world.outsider.id, "body": "x", "x": 0.0, "y": 0.0,
                             "vec_c": [0.1] * 4, "terms": []})


# --------------------------------------------------------------------------
# islands: per community, two viewers two answers, ids never cross
# --------------------------------------------------------------------------

def test_islands_are_made_from_one_communitys_posts_and_cached_per_community(world):
    on(world)
    first = get(world.both, f"/api/islands?community={world.A}")
    second = get(world.both, f"/api/islands?community={world.B}")
    assert first.status_code == second.status_code == 200
    assert first.headers["cache-control"] == "private, no-store"
    in_a = {pid for island in first.json()["islands"] for pid in island["post_ids"]}
    in_b = {pid for island in second.json()["islands"] for pid in island["post_ids"]}
    assert in_a and in_b, "three look-alike posts a side must make an island each"
    assert in_a <= world.a_posts and in_b <= world.b_posts
    # asked again, from the cache: still not mixed
    again = get(world.member_a, f"/api/islands?community={world.A}").json()
    assert {pid for island in again["islands"] for pid in island["post_ids"]} == in_a
    # the radius the map is drawn with is that community's own
    assert isinstance(again["radius_factor"], float)


def test_tracking_runs_per_community_and_an_island_never_takes_another_communitys_id(world):
    on(world)
    result = application.track_islands()
    states = store().island_states()
    assert states and all(row.get("community_id") in (world.A, world.B) for row in states)
    by_community = {}
    for row in states:
        by_community.setdefault(row["community_id"], []).append(row)
    assert set(by_community) == {world.A, world.B}
    assert {pid for row in by_community[world.A] for pid in row["post_ids"]} <= world.a_posts
    assert {pid for row in by_community[world.B] for pid in row["post_ids"]} <= world.b_posts
    assert all(event.get("community_id") in (world.A, world.B) for event in result["events"])
    ids_before = {row["id"] for row in states}
    assert len(ids_before) == len(states)
    # a second step finds the same islands again, with the same ids, each in its own community
    application.invalidate_islands()
    application.track_islands()
    again = store().island_states()
    assert {row["id"] for row in again if row.get("active", True)} == ids_before
    assert {(row["id"], row["community_id"]) for row in again} == {(row["id"], row["community_id"]) for row in states}


def test_the_islands_a_viewer_gets_continue_only_their_communitys_saved_islands(world):
    on(world)
    application.track_islands()
    mine = get(world.member_a, f"/api/islands?community={world.A}").json()["islands"]
    saved = {row["id"]: row for row in store().island_states()}
    named = [island for island in mine if island.get("island_id")]
    assert named, "the island is a tracked one"
    assert all(saved[island["island_id"]]["community_id"] == world.A for island in named)


def test_changes_and_the_digest_show_only_the_events_of_a_community_you_are_in(world):
    on(world)
    application.track_islands()
    own = get(world.member_a, f"/api/changes?community={world.A}").json()["changes"]
    other = get(world.member_b, f"/api/changes?community={world.B}").json()["changes"]
    assert own and other
    everything = store().list_island_events(limit=500)
    a_events = {row["id"] for row in everything if row["community_id"] == world.A}
    b_events = {row["id"] for row in everything if row["community_id"] == world.B}
    assert ids(own) <= a_events and ids(other) <= b_events
    # no community given: every community the caller is in, nothing else
    assert ids(get(world.member_a, "/api/changes").json()["changes"]) <= a_events
    assert ids(get(world.both, "/api/changes").json()["changes"]) <= a_events | b_events
    assert ids(get(world.both, "/api/changes").json()["changes"]) & a_events
    assert ids(get(world.both, "/api/changes").json()["changes"]) & b_events
    assert get(None, "/api/changes").status_code == 401
    assert get(world.outsider, "/api/changes").json() == {"changes": []}
    digest = get(world.member_b, "/api/changes/digest")
    assert digest.status_code == 200
    assert {row["id"] for row in digest.json()["changes"]} <= b_events
    assert get(None, "/api/changes/digest").status_code == 401


def test_island_notifications_go_to_current_members_of_that_community_and_name_it(world):
    on(world)
    events = [{"kind": "birth", "island_id": "i-a", "id": "e1", "cause": "島ができました"}]
    states = [{"id": "i-a", "active": True, "author_ids": [world.member_a.id, world.member_b.id, world.ex.id]}]
    ex_member(world)
    rows = application.notify_islands(events, states, datetime.now(timezone.utc), community=world.A)
    assert [row["recipient_id"] for row in rows] == [world.member_a.id]       # not B's person, not the one who left
    assert rows[0]["community_id"] == world.A
    [stored] = store().list_notifications(world.member_a.id, viewer=world.member_a.id)
    assert stored["community_id"] == world.A


def test_quiet_post_notices_stay_inside_one_community_and_go_to_its_members(world):
    on(world)
    later = datetime.now(timezone.utc) + timedelta(hours=QUIET_POST_MIN_HOURS + 1)
    for person in (world.member_a, world.member_a2, world.both, world.member_b, world.ex):
        store().touch_last_seen(person.id)
    application.invalidate_islands()
    rows = application.notify_quiet_posts(now=later)
    assert rows, "look-alike posts a side, every one quiet"
    member_of = {world.A: {world.admin_a.id, world.member_a.id, world.member_a2.id, world.both.id, world.ex.id},
                 world.B: {world.member_b.id, world.both.id}}
    post_community = {**{pid: world.A for pid in world.a_posts}, **{pid: world.B for pid in world.b_posts}}
    for row in rows:
        assert row["community_id"] == post_community[row["post_id"]]
        assert row["recipient_id"] in member_of[row["community_id"]]
    # in the person's inbox too
    for person in (world.member_a, world.member_b):
        for row in store().list_notifications(person.id, viewer=person.id):
            if row["type"] == "quiet_post":
                assert row["community_id"] in store().viewer_communities(person.id)


def test_similar_notifications_are_off_and_stay_off():
    assert application.SIMILAR_NOTIFY_ENABLED is False
    assert application.notify_similar("anyone") == []


# --------------------------------------------------------------------------
# connections, similar people, person card
# --------------------------------------------------------------------------

def talk_between(w):
    """Comments draw a line (a like does not): one on each map."""
    assert w.both.comment(w.pa["id"], "はじめまして").status_code == 200       # both -> member_a on A's map
    assert w.member_a2.comment(w.pa["id"], "こんにちは").status_code == 200
    assert w.both.comment(w.pb["id"], "はじめまして").status_code == 200       # both -> member_b on B's map
    application.invalidate_connections()


def test_connections_are_per_community_and_a_person_filter_cannot_widen_them(world):
    talk_between(world)
    on(world)
    a_lines = get(world.member_a, f"/api/connections?community={world.A}").json()["connections"]
    assert a_lines and all({line["a"], line["b"]} <= {p.id for p in (world.member_a, world.member_a2, world.both)}
                           for line in a_lines)
    assert not any(world.member_b.id in (line["a"], line["b"]) for line in a_lines)
    b_lines = get(world.member_b, f"/api/connections?community={world.B}").json()["connections"]
    assert b_lines and all(world.member_a.id not in (line["a"], line["b"]) for line in b_lines)
    # no community: the lines of the caller's communities, never the whole world
    mine = get(world.member_a, "/api/connections").json()["connections"]
    assert mine == a_lines
    # ?person= answers only from communities the CALLER is in
    seen_by_a = get(world.member_a, f"/api/connections?person={world.both.id}").json()["connections"]
    assert seen_by_a and all(world.both.id in (line["a"], line["b"]) for line in seen_by_a)
    assert not any(world.member_b.id in (line["a"], line["b"]) for line in seen_by_a)
    assert get(world.outsider, f"/api/connections?person={world.both.id}").json()["connections"] == []
    assert get(None, "/api/connections").status_code == 401
    assert get(world.outsider, f"/api/connections?community={world.A}").status_code == 404


def test_similar_people_comes_from_your_communities_and_ignores_who_you_ask_about(world):
    for person, text in ((world.member_a, "キャンプと焚き火が好きです"), (world.member_a2, "山で野営をするのが趣味です"),
                         (world.member_b, "キャンプと焚き火が好きです")):
        assert call(person, "PUT", "/api/account/me",
                    json={"display_name": person.account["display_name"], "topics": ["キャンプ"],
                          "goal": text}).status_code == 200
    on(world)
    mine = get(world.member_a, "/api/similar-people").json()["people"]
    assert world.member_b.id not in {row["id"] for row in mine}               # exists, but in no shared community
    # `?account=` is ignored: asking about somebody else answers about yourself
    assert get(world.member_a, f"/api/similar-people?account={world.member_b.id}").json() == {"people": mine}
    assert get(None, "/api/similar-people").status_code == 401
    assert get(world.outsider, "/api/similar-people").json() == {"people": []}
    # and the people list of B holds no member of A
    assert world.member_a.id not in {row["id"] for row in get(world.member_b, "/api/similar-people").json()["people"]}
    on(world, False)
    off = get(world.member_a, "/api/similar-people").json()["people"]
    assert world.member_b.id in {row["id"] for row in off}                     # the old, open answer


def test_a_centroid_only_counts_the_posts_in_the_asked_communities(world):
    on(world)
    a_only = store().post_centroids(community=world.A)
    b_only = store().post_centroids(community=world.B)
    assert world.member_b.id not in a_only and world.member_a.id not in b_only
    merged = application.people_index({world.A, world.B})
    assert merged[world.both.id]["centroid"] is not None
    a_count = a_only[world.both.id]["post_count"]
    b_count = b_only[world.both.id]["post_count"]
    assert a_count == b_count == 1
    assert application.people_index({world.A}).get(world.member_b.id) is None   # not a member of A


def test_the_person_card_shows_only_what_the_viewer_shares_with_the_person(world):
    talk_between(world)
    on(world)
    card = get(world.member_a, f"/api/people/{world.both.id}/card").json()
    assert card["latest_post"]["id"] == world.pa4["id"]                       # the post in A, not the ones in B
    assert card["post_count"] == 1
    assert world.member_b.id not in {c["id"] for c in card["connections"]}
    # a viewer in B only sees the B side of the same person
    card_b = get(world.member_b, f"/api/people/{world.both.id}/card").json()
    assert card_b["latest_post"]["id"] == world.pb2["id"] and card_b["post_count"] == 1
    # no community in common: the profile alone
    alone = get(world.member_b, f"/api/people/{world.member_a.id}/card").json()
    assert alone["person"]["display_name"] == world.member_a.account["display_name"]
    assert alone["post_count"] == 0 and alone["latest_post"] is None and alone["connections"] == []
    assert alone["island"] is None
    # your own card shows all of your own posts
    own = get(world.both, f"/api/people/{world.both.id}/card").json()
    assert own["post_count"] == 2
    # `?viewer=` no longer makes a signed-out visitor somebody, and a signed-out request is refused
    assert get(None, f"/api/people/{world.both.id}/card?viewer={world.member_a.id}").status_code == 401
    # a viewer with no accounts row yet is still answered (profile only)
    fresh_id, fresh_headers = new_token(world.client, "fresh@example.test")
    answer = world.client.get(f"/api/people/{world.both.id}/card", headers=fresh_headers)
    assert answer.status_code == 200 and answer.json()["post_count"] == 0


def new_token(client, email):
    code = client.post("/api/local/auth/otp", json={"email": email}).json()["code"]
    token = client.post("/api/local/auth/verify", json={"email": email, "code": code}).json()
    return token["user"]["id"], {"Authorization": f"Bearer {token['access_token']}"}


def test_a_just_claimed_invite_reads_the_community_on_the_very_next_request(world):
    on(world)
    newcomer = type("P", (), {})()
    newcomer.id, newcomer.headers = new_token(world.client, "newcomer@example.test")
    newcomer.client = world.client
    assert get(newcomer, f"/api/islands?community={world.A}").status_code == 404
    code = store().create_invite(world.admin_a.id, world.A, 60)["code"]
    claim = call(newcomer, "POST", "/api/local/invites/claim", json={"code": code})
    assert claim.status_code == 200
    assert get(newcomer, f"/api/islands?community={world.A}").status_code == 200


# --------------------------------------------------------------------------
# writing: create, preview, patch, view
# --------------------------------------------------------------------------

def test_create_post_defaults_to_the_only_community_and_never_mixes_neighbours(world):
    on(world)
    response = call(world.member_a, "POST", "/api/posts", json={"body": CAMPING_A, "tags": []})
    assert response.status_code == 200, response.text
    made = response.json()
    assert made["community_id"] == world.A
    assert made["neighbors"] and ids(made["neighbors"]) <= world.a_posts
    assert made["island"] is None or set(made["island"]["post_ids"]) <= world.a_posts | {made["id"]}
    # a retry with the same key finds the same post, still without another community's rows
    key = {"Idempotency-Key": str(uuid.uuid4())}
    first = world.client.post("/api/posts", json={"body": CAMPING_B, "tags": []},
                              headers={**world.member_a.headers, **key})
    second = world.client.post("/api/posts", json={"body": CAMPING_B, "tags": []},
                               headers={**world.member_a.headers, **key})
    assert first.json()["id"] == second.json()["id"] and second.json()["neighbors"] == []


def test_create_post_needs_a_community_you_are_in(world):
    on(world)
    body = {"body": CAMPING_A, "tags": []}
    assert call(None, "POST", "/api/posts", json=body).status_code == 401
    refused = call(world.outsider, "POST", "/api/posts", json=body)
    assert refused.status_code == 403 and refused.json()["detail"] == COMMUNITY_ERROR_POST
    wrong = call(world.member_a, "POST", "/api/posts", json={**body, "community_id": world.B})
    assert wrong.status_code == 403 and wrong.json()["detail"] == COMMUNITY_ERROR_POST
    bad = call(world.member_a, "POST", "/api/posts", json={**body, "community_id": "nope"})
    assert bad.status_code == 403
    several = call(world.both, "POST", "/api/posts", json=body)
    assert several.status_code == 422 and several.json()["detail"] == MEMBERS_ONLY_COMMUNITY_REQUIRED
    chosen = call(world.both, "POST", "/api/posts", json={**body, "community_id": world.B})
    assert chosen.status_code == 200 and chosen.json()["community_id"] == world.B
    assert ids(chosen.json()["neighbors"]) <= world.b_posts
    left = world.ex
    ex_member(world)
    assert call(left, "POST", "/api/posts", json={**body, "community_id": world.A}).status_code == 403


def test_preview_places_a_text_among_one_communitys_posts_only(world):
    on(world)
    body = {"body": CAMPING_A}
    ok = call(world.member_a, "POST", "/api/posts/preview", json=body)
    assert ok.status_code == 200, ok.text
    assert ok.json()["neighbors"] and ids(ok.json()["neighbors"]) <= world.a_posts
    in_b = call(world.both, "POST", "/api/posts/preview", json={**body, "community_id": world.B})
    assert in_b.status_code == 200 and ids(in_b.json()["neighbors"]) <= world.b_posts
    assert call(world.both, "POST", "/api/posts/preview", json=body).status_code == 422
    assert call(None, "POST", "/api/posts/preview", json=body).status_code == 401
    assert call(world.member_a, "POST", "/api/posts/preview",
                json={**body, "community_id": world.B}).status_code == 404
    assert call(world.outsider, "POST", "/api/posts/preview", json=body).status_code == 403
    # the island of a preview is read from the community's posts too
    island = ok.json()["island"]
    assert island is None or set(island["post_ids"]) <= world.a_posts


def test_the_preview_island_uses_the_community_function_not_the_member_filtered_map(world, monkeypatch):
    on(world)
    asked = []
    real = store().map_posts_for_community
    monkeypatch.setattr(store(), "map_posts_for_community",
                        lambda community, *rest: asked.append(community) or real(community, *rest))
    monkeypatch.setattr(store(), "map_posts", lambda *a, **k: pytest.fail("map_posts has no viewer here"))
    assert call(world.member_a, "POST", "/api/posts/preview", json={"body": CAMPING_A}).status_code == 200
    assert asked == [world.A]


def test_patching_somebody_elses_post_and_a_post_that_is_not_there_answer_alike(world):
    on(world)
    nowhere = call(world.member_a, "PATCH", f"/api/posts/{unknown()}", json={"tags": []})
    assert nowhere.status_code == 404
    for victim in (world.pa2["id"], world.pb["id"], world.legacy["id"]):
        answer = call(world.member_a, "PATCH", f"/api/posts/{victim}", json={"tags": []})
        assert (answer.status_code, answer.json()) == (nowhere.status_code, nowhere.json()), victim
        answer = call(world.member_a, "PATCH", f"/api/posts/{victim}", json={"body": CAMPING_B})
        assert (answer.status_code, answer.json()) == (nowhere.status_code, nowhere.json()), victim
    # control: your own post
    mine = call(world.member_a, "PATCH", f"/api/posts/{world.pa['id']}", json={"tags": []})
    assert mine.status_code == 200 and mine.json()["community_id"] == world.A


def test_an_ex_member_keeps_editing_and_deleting_their_own_post_and_gets_no_island(world):
    on(world)
    ex_member(world)
    mine = world.pa3["id"]
    edited = call(world.ex, "PATCH", f"/api/posts/{mine}", json={"body": CAMPING_B})
    assert edited.status_code == 200 and edited.json()["island"] is None
    assert call(world.ex, "PATCH", f"/api/posts/{world.pa['id']}", json={"tags": []}).status_code == 404
    assert call(world.ex, "DELETE", f"/api/posts/{mine}").status_code == 200
    assert call(world.ex, "DELETE", f"/api/posts/{world.pa['id']}").status_code == 403


def test_view_counts_only_a_signed_in_member_of_the_posts_community(world):
    on(world)
    post = world.pa["id"]
    assert call(None, "POST", f"/api/posts/{post}/view", json={"viewer": "anon:" + "a" * 16}).status_code == 401
    assert call(world.member_b, "POST", f"/api/posts/{post}/view", json={}).status_code == 404
    assert call(world.outsider, "POST", f"/api/posts/{post}/view", json={}).status_code == 404
    seen = call(world.member_a2, "POST", f"/api/posts/{post}/view", json={})
    assert seen.status_code == 200 and seen.json() == {"counted": True}
    assert call(world.member_a, "GET", "/api/me/views").json()["views"] == {post: 1}


def test_health_and_config_do_not_hand_out_the_size_of_the_service(world):
    on(world, False)
    assert isinstance(get(None, "/api/health").json()["posts"], int)
    on(world)
    assert get(None, "/api/health").json()["posts"] is None
    config = get(None, "/api/config").json()
    assert config["energy"]["radius_factor"] == 1.0                  # a constant, not a band of the corpus size
    for _ in range(40):
        world.member_a.post(CAMPING_A, community_id=world.A)
    assert get(None, "/api/config").json()["energy"]["radius_factor"] == 1.0


def test_config_tells_the_screens_whether_the_switch_is_on(world):
    """The screens read features.members_only to decide what a signed-out visitor sees (a notice, not a map).
    It follows the switch, is readable without signing in, and says nothing else about the service."""
    on(world, False)
    assert get(None, "/api/config").json()["features"]["members_only"] is False
    on(world)
    features = get(None, "/api/config").json()["features"]
    assert features["members_only"] is True
    assert features["communities"] is True


# --------------------------------------------------------------------------
# the stand-ins for PostgREST (/api/local/*): the SQL policies, in Python
# --------------------------------------------------------------------------

def test_local_map_cells_and_community_map_show_members_their_communities_only(world):
    on(world)
    assert call(None, "GET", "/api/local/map").status_code == 401
    assert ids(get(world.member_a, "/api/local/map").json()["posts"]) == world.a_posts
    assert ids(get(world.member_b, "/api/local/map").json()["posts"]) == world.b_posts
    assert ids(get(world.both, "/api/local/map").json()["posts"]) == world.a_posts | world.b_posts
    assert get(world.outsider, "/api/local/map").json() == {"posts": []}
    # the post with no community is on nobody's map, not even its author's
    assert world.legacy["id"] not in ids(get(world.outsider, "/api/local/map").json()["posts"])
    assert call(None, "GET", f"/api/local/communities/{world.A}/map").status_code == 401
    assert ids(get(world.member_a, f"/api/local/communities/{world.A}/map").json()["posts"]) == world.a_posts
    assert get(world.member_b, f"/api/local/communities/{world.A}/map").json() == {"posts": []}
    assert get(world.outsider, f"/api/local/communities/{world.A}/map").json() == {"posts": []}
    # the energy cells are made from every community's posts: they answer nothing for anybody
    assert call(None, "GET", "/api/local/cells").status_code == 401
    assert get(world.member_a, "/api/local/cells").json() == {"cells": []}


def test_local_post_row_is_for_members_and_for_its_author_only(world):
    on(world)
    ex_member(world)
    mine, theirs = world.pa["id"], world.pa3["id"]
    assert get(world.member_a, f"/api/local/post/{mine}").status_code == 200
    assert call(None, "GET", f"/api/local/post/{mine}").status_code == 401
    nowhere = get(world.member_b, f"/api/local/post/{unknown()}")
    for person in (world.member_b, world.outsider):
        answer = get(person, f"/api/local/post/{mine}")
        assert (answer.status_code, answer.json()) == (nowhere.status_code, nowhere.json())
    # the author who left reads their OWN row, and nobody else's row of that community
    assert get(world.ex, f"/api/local/post/{theirs}").status_code == 200
    assert get(world.ex, f"/api/local/post/{mine}").status_code == 404
    # a post with no community: its author only
    legacy = world.legacy["id"]
    assert get(world.outsider, f"/api/local/post/{legacy}").status_code == 200
    assert get(world.member_a, f"/api/local/post/{legacy}").status_code == 404


def test_the_own_page_lists_all_my_posts_and_another_persons_page_only_what_we_share(world):
    on(world)
    ex_member(world)
    assert call(None, "GET", f"/api/local/posts?author={world.both.id}").status_code == 401
    own = get(world.both, f"/api/local/posts?author={world.both.id}").json()["posts"]
    assert ids(own) == {world.pa4["id"], world.pb2["id"]}
    seen_by_a = get(world.member_a, f"/api/local/posts?author={world.both.id}").json()["posts"]
    assert ids(seen_by_a) == {world.pa4["id"]}
    assert get(world.outsider, f"/api/local/posts?author={world.both.id}").json() == {"posts": []}
    # an ex-member's own page still lists their own post of the community they left; others see none of it
    assert ids(get(world.ex, f"/api/local/posts?author={world.ex.id}").json()["posts"]) == {world.pa3["id"]}
    # ...while a person in A still sees that post of A on the page (we share the community), and a person
    # who shares none sees nothing
    assert ids(get(world.member_a, f"/api/local/posts?author={world.ex.id}").json()["posts"]) == {world.pa3["id"]}
    assert get(world.member_b, f"/api/local/posts?author={world.ex.id}").json() == {"posts": []}


def test_comments_and_reactions_are_for_members_and_end_the_moment_you_leave(world):
    on(world)
    mine = world.pa3["id"]
    assert world.member_a.comment(mine, "いいですね").status_code == 200
    assert world.member_a.react(mine, "like").status_code == 200
    assert world.member_a2.react(mine, "join").status_code == 200
    for person in (world.member_a, world.ex):                                   # the author is still a member
        assert [c["body"] for c in get(person, f"/api/local/comments?post={mine}").json()["comments"]] == ["いいですね"]
    ex_member(world)
    assert call(None, "GET", f"/api/local/comments?post={mine}").status_code == 401
    # the author who left: no new comments / reactions / joiners on their old post, and can't add any
    assert get(world.ex, f"/api/local/comments?post={mine}").json() == {"comments": []}
    assert get(world.member_b, f"/api/local/comments?post={mine}").json() == {"comments": []}
    assert get(world.ex, f"/api/local/posts/{mine}/joiners").json() == {"joiners": []}
    assert get(world.ex, f"/api/local/posts/{mine}/reactors?kind=like").json() == {"reactors": []}
    assert get(world.member_a, f"/api/local/posts/{mine}/joiners").json() == {"joiners": [world.member_a2.id]}
    assert [r["id"] for r in get(world.member_a, f"/api/local/posts/{mine}/reactors?kind=like").json()["reactors"]] \
        == [world.member_a.id]
    assert world.ex.comment(mine, "まだ書ける?").status_code == 404
    assert world.ex.react(mine, "like").json()["created"] is False
    assert world.outsider.comment(mine, "のぞき").status_code == 404
    assert world.member_b.comment(mine, "のぞき").status_code == 404
    assert world.outsider.react(world.pa["id"], "like").json()["created"] is False
    assert world.pa["like_count"] == 0 and store().get_post(world.pa["id"])["like_count"] == 0


def test_a_reaction_i_made_can_still_be_taken_back_after_i_left(world):
    on(world)
    assert world.ex.react(world.pa["id"], "like").json()["created"] is True
    ex_member(world)
    mine = get(world.ex, f"/api/local/reactions/mine").json()["reactions"]
    assert {"post_id": world.pa["id"], "kind": "like"} in mine
    assert get(world.ex, f"/api/local/posts/{world.pa['id']}/reactors?kind=like").json()["reactors"][0]["id"] == world.ex.id
    assert world.ex.unreact(world.pa["id"], "like").json() == {"ok": True}
    assert store().get_post(world.pa["id"])["like_count"] == 0


def test_a_closed_recruitment_tells_an_outsider_nothing_the_member_error_comes_first(world):
    on(world)
    deadline = (datetime.now(timezone.utc) - timedelta(days=1)).date().isoformat()
    meeting = world.member_a.post(CAMPING_A, tags=[RECRUIT_TAG], community_id=world.A)
    row = store()._posts[meeting["id"]]
    row["recruit_deadline"] = deadline
    # a member is told it is closed; a person outside the community is told nothing at all
    with pytest.raises(StoreError):
        store().add_reaction(meeting["id"], world.member_a2.id, "join")
    assert store().add_reaction(meeting["id"], world.outsider.id, "join") is False
    assert store().add_reaction(unknown(), world.outsider.id, "join") is False


def test_reports_need_a_post_and_a_comment_you_are_a_member_of(world):
    on(world)
    mine = world.pa["id"]
    comment = world.member_a.comment(mine, "ふつうのメッセージ").json()
    ok = call(world.member_a2, "POST", "/api/local/reports", json={"post_id": mine, "comment_id": comment["id"]})
    assert ok.status_code == 200
    for person in (world.member_b, world.outsider):
        for body in ({"post_id": mine}, {"comment_id": comment["id"]}, {"post_id": mine, "comment_id": comment["id"]}):
            assert call(person, "POST", "/api/local/reports", json=body).status_code == 404
    bogus = call(world.member_b, "POST", "/api/local/reports", json={"comment_id": unknown()})
    assert bogus.status_code == 404                                  # same as a foreign comment


def test_a_deleted_comment_cannot_be_reported_like_one_that_is_not_there(world):
    on(world)
    comment = world.member_a.comment(world.pa["id"], "ふつうのメッセージ").json()
    store()._comments[comment["id"]]["deleted_at"] = "2026-10-01T00:00:00+00:00"
    gone = call(world.member_a2, "POST", "/api/local/reports", json={"comment_id": comment["id"]})
    missing = call(world.member_a2, "POST", "/api/local/reports", json={"comment_id": unknown()})
    assert gone.status_code == missing.status_code == 404


def test_nearest_posts_needs_the_origin_to_be_in_the_asked_community(world):
    on(world)
    assert store().nearest_posts(world.pa["id"], 5, community=world.B) == []
    assert store().nearest_posts(world.pa["id"], 5, community=world.A) != []


def test_neighbors_for_answers_empty_when_no_community_is_given_while_on(world):
    on(world)
    assert application.neighbors_for(world.pa["id"], [], 5, community=None) == []


def test_notifications_about_a_post_you_are_not_a_member_of_are_not_readable(world):
    on(world)
    world.member_a.react(world.pa3["id"], "like")                  # tells ex (the author)
    assert [r["type"] for r in get(world.ex, "/api/local/notifications").json()["notifications"]] == ["like"]
    # the membership row goes without the cleanup of leave_community: the READ rule hides it
    del store()._members[(world.A, world.ex.id)]
    assert get(world.ex, "/api/local/notifications").json() == {"notifications": []}
    assert get(world.ex, "/api/local/notifications/feed").json()["notifications"] == []
    assert call(None, "GET", "/api/local/notifications").status_code == 401
    # marking a notification read still works on the row that is no longer shown
    assert call(world.ex, "POST", "/api/local/notifications/read", json={"ids": None}).json()["updated"] == 1


def test_leaving_only_hides_the_notifications_of_that_community_and_rejoining_shows_them_again(world):
    on(world)
    world.member_a.react(world.pa3["id"], "like")
    store().insert_notifications([{"recipient_id": world.ex.id, "actor_id": None, "type": "island",
                                   "community_id": world.A, "payload": {}},
                                  {"recipient_id": world.ex.id, "actor_id": None, "type": "island",
                                   "community_id": world.B, "payload": {}}])
    assert store().viewer_communities(world.ex.id) == {world.A}
    ex_member(world)
    # the rows stay (as in SQL, where leaving deletes nothing); the read rule is what hides them
    assert len(store().list_notifications(world.ex.id)) == 3
    assert store().list_notifications(world.ex.id, viewer=world.ex.id) == []
    join(world.ex, world.A, world.admin_a)
    back = store().list_notifications(world.ex.id, viewer=world.ex.id)
    assert sorted(row["type"] for row in back) == ["island", "like"]


def test_island_like_notifications_without_a_community_are_never_written_or_read_while_on(world):
    on(world)
    rows = [{"recipient_id": world.member_a.id, "actor_id": None, "type": kind, "payload": {}}
            for kind in ("island", "quiet_post", "similar")]
    assert store().insert_notifications(rows) == []
    assert store().list_notifications(world.member_a.id) == []
    scoped = store().insert_notifications([dict(rows[0], community_id=world.A)])
    assert len(scoped) == 1
    on(world, False)                                   # with the switch off the old behaviour stays
    assert len(store().insert_notifications(rows)) == 3


def test_the_last_admin_cannot_leave(world):
    assert store().leave_community(world.admin_a.id, world.A) is False
    assert store().leave_community(world.outsider.id, world.A) is False


def test_the_local_community_row_is_for_members(world):
    on(world)
    assert get(world.member_a, f"/api/local/communities/{world.A}").status_code == 200
    assert get(world.member_b, f"/api/local/communities/{world.A}").status_code == 404
    assert call(None, f"GET", f"/api/local/communities/{world.A}").status_code == 401


def test_talk_needs_both_people_to_be_in_the_community_the_meeting_was_posted_to(world):
    meeting = world.member_a.post(CAMPING_A, tags=[RECRUIT_TAG], community_id=world.A)
    assert world.member_a2.react(meeting["id"], "join").status_code == 200
    assert world.ex.react(meeting["id"], "join").status_code == 200
    on(world)
    assert get(world.member_a, "/api/local/talk/peers").json()["peers"] == sorted([world.member_a2.id, world.ex.id])
    ex_member(world)
    # peers: the one who left is out of both ends
    assert get(world.member_a, "/api/local/talk/peers").json()["peers"] == [world.member_a2.id]
    assert get(world.ex, "/api/local/talk/peers").json()["peers"] == []
    refused = call(world.member_a, "POST", "/api/local/talk/press", json={"target": world.ex.id})
    assert refused.status_code == 422                               # the words of "this person cannot be pressed"
    assert call(world.ex, "POST", "/api/local/talk/press", json={"target": world.member_a.id}).status_code == 422
    assert call(world.member_a, "POST", "/api/local/talk/press", json={"target": world.member_a2.id}).status_code == 200
    # the meeting's excerpt in the DM room list is for members of its community only
    assert call(world.member_a2, "POST", "/api/local/talk/press", json={"target": world.member_a.id}).json()["matched"]
    rooms = get(world.member_a2, "/api/local/dm/rooms").json()["rooms"]
    assert rooms[0]["event_excerpt"] == meeting["body"][:30] and rooms[0]["event_post_id"] == meeting["id"]
    del store()._members[(world.A, world.member_a2.id)]
    rooms = get(world.member_a2, "/api/local/dm/rooms").json()["rooms"]
    assert rooms[0]["event_excerpt"] is None and rooms[0]["event_post_id"] is None


def test_storage_listing_is_one_s_own_folder_while_an_object_url_still_opens(world):
    on(world)
    uploaded = world.client.post("/api/local/upload", content=b"\x89PNG", headers={
        **world.member_a.headers, "content-type": "image/png"}).json()
    name = uploaded["path"].split("/")[1]
    listing = get(world.member_a, f"/api/local/storage/list?folder={world.member_a.id}").json()["objects"]
    assert listing == [name]                                                  # positive control
    assert get(world.outsider, f"/api/local/storage/list?folder={world.member_a.id}").json() == {"objects": []}
    assert get(world.member_b, f"/api/local/storage/list?folder={world.member_a.id}").json() == {"objects": []}
    assert get(world.outsider, "/api/local/storage/list").json() == {"objects": []}
    assert call(None, "GET", f"/api/local/storage/list?folder={world.member_a.id}").status_code == 401
    # phase 1: whoever holds the exact URL can still open it
    assert call(None, "GET", uploaded["url"]).status_code == 200
    on(world, False)
    assert get(world.outsider, f"/api/local/storage/list?folder={world.member_a.id}").json()["objects"] == [name]


def test_local_routes_do_not_exist_in_production(world, monkeypatch):
    on(world)
    monkeypatch.setenv("K_SERVICE", "islands")
    monkeypatch.delenv("ISLANDS_LOCAL", raising=False)
    for path in ("/api/local/map", f"/api/local/post/{world.pa['id']}", "/api/local/storage/list",
                 "/api/local/settings/members-only"):
        assert get(world.member_a, path).status_code == 404, path


# --------------------------------------------------------------------------
# push
# --------------------------------------------------------------------------

class Courier:
    def __init__(self):
        self.sent = []

    def post(self, url, content, headers, timeout):
        self.sent.append({"url": url, "body": content, "headers": headers})

        class Reply:
            status_code = 201
        return Reply()


def subscribe(person):
    from test_push import Browser
    browser = Browser()
    response = person.client.post("/api/push/subscribe", json=browser.subscription(), headers=person.headers)
    assert response.status_code == 200, response.text
    return browser


def test_a_push_says_nothing_about_the_post_and_is_dropped_once_the_recipient_left(world):
    on(world)
    author = world.member_a
    browser = subscribe(author)
    world.member_a2.react(world.pa["id"], "like")
    courier = Courier()
    tally = application.dispatch_pushes(client=courier)
    assert tally["sent"] == 1 and tally["dropped_not_member"] == 0           # control: a member is pushed
    message = browser.decrypt(courier.sent[0]["body"])
    assert message["tag"] == webpush.topic_for(f"reaction-{world.pa['id']}")  # a hash, not the post id
    assert world.pa["id"] not in json.dumps(message)
    for text in (CAMPING_A, CAMPING_B, CAMPING_C):
        assert text[:6] not in json.dumps(message, ensure_ascii=False)
    # now the same kind of row for a recipient who has left in the meantime
    world.member_a2.unreact(world.pa["id"], "like")
    world.member_a2.react(world.pa["id"], "help")
    del store()._members[(world.A, author.id)]
    courier = Courier()
    tally = application.dispatch_pushes(client=courier)
    assert courier.sent == [] and tally["dropped_not_member"] == 1


def test_push_rows_without_a_post_need_their_own_community(world):
    on(world)
    rows = [
        {"recipient_id": world.member_a.id, "type": "island", "post_id": None, "community_id": world.A},
        {"recipient_id": world.member_a.id, "type": "island", "post_id": None, "community_id": world.B},
        {"recipient_id": world.member_a.id, "type": "island", "post_id": None, "community_id": None},
        {"recipient_id": world.member_a.id, "type": "talk_wish", "post_id": None, "community_id": None},
        {"recipient_id": world.member_a.id, "type": "quiet_post", "post_id": world.pb["id"], "community_id": None},
    ]
    kept = application.pushes_still_readable(rows)
    assert kept == [rows[0], rows[3]]


# --------------------------------------------------------------------------
# every route: the inventory
# --------------------------------------------------------------------------

# Routes that are meant to answer a signed-out caller while members_only is on.
OPEN_ROUTES = {
    ("GET", "/api/config"), ("GET", "/api/health"),
    ("POST", "/api/push/dispatch"),                    # the database's poke: carries nothing
    ("POST", "/api/local/auth/otp"), ("POST", "/api/local/auth/verify"),
    ("GET", "/api/local/account/{account_id}"),        # accounts stay public
    ("GET", "/api/local/invites/check/{code}"),        # an invite page must work before sign-up
    ("GET", "/api/local/image/{account_id}/{name}"),   # an object URL, as in the public bucket (phase 1)
    ("GET", "/api/local/settings/invite-only"), ("POST", "/api/local/settings/invite-only"),
    ("GET", "/api/local/settings/members-only"), ("POST", "/api/local/settings/members-only"),
    ("POST", "/api/local/invites/{invite_id}/expire"),  # dev helpers (local mode only)
    ("POST", "/api/local/communities"),                # needs a login (checked below), listed to be explicit
}


def route_table():
    out = []
    for route in application.app.routes:
        path = getattr(route, "path", "")
        if path.startswith("/api/"):
            for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
                out.append((method, path))
    return out


def fill(path, w):
    return (path.replace("{person_id}", w.member_a.id).replace("{post_id}", w.pa["id"])
            .replace("{comment_id}", unknown()).replace("{account_id}", w.member_a.id)
            .replace("{community_id}", w.A).replace("{invite_id}", unknown())
            .replace("{room_id}", unknown()).replace("{blocked_id}", w.member_b.id)
            .replace("{code}", "x").replace("{name}", "x"))


def test_every_route_refuses_a_signed_out_caller_unless_it_is_on_the_open_list(world):
    on(world)
    query = (f"?min_x=-10&min_y=-10&max_x=10&max_y=10&post={world.pa['id']}&a={world.pa['id']}"
             f"&b={world.pa2['id']}&community={world.A}&author={world.member_a.id}&folder={world.member_a.id}"
             f"&community_id={world.A}")
    seen = 0
    for method, path in route_table():
        if (method, path) in OPEN_ROUTES:
            continue
        seen += 1
        response = world.client.request(method, fill(path, world) + query, json={} if method != "GET" else None)
        # 401 (no login) - or 422 where the body is validated before the handler is reached - but never data
        assert response.status_code in (401, 422), (method, path, response.status_code, response.text[:120])
    assert seen > 40
    # the list is not stale: everything on it still exists
    assert OPEN_ROUTES <= set(route_table())


def test_the_open_routes_answer_without_any_post_derived_data(world):
    on(world)
    for path in ("/api/config", "/api/health", f"/api/local/account/{world.member_a.id}"):
        text = get(None, path).text
        for post in (world.pa, world.pb, world.legacy):
            assert post["id"] not in text
        assert CAMPING_A[:6] not in text and SOLDERING[:6] not in text
    assert call(None, "POST", "/api/local/communities", json={"name": "x"}).status_code == 401


# --------------------------------------------------------------------------
# the switch OFF: nothing changes
# --------------------------------------------------------------------------

def test_with_the_switch_off_every_read_is_as_open_as_before(world):
    on(world, False)
    assert ids(get(None, "/api/local/map").json()["posts"]) == world.a_posts | world.b_posts | {world.legacy["id"]}
    assert get(None, f"/api/local/post/{world.pa['id']}").status_code == 200
    assert get(None, f"/api/local/posts?author={world.member_a.id}").json()["posts"]
    assert get(None, f"/api/local/comments?post={world.pa['id']}").status_code == 200
    assert get(None, "/api/local/cells").json()["cells"]
    assert get(None, f"/api/local/communities/{world.A}").status_code == 200
    assert get(None, "/api/neighbors?post=" + world.pa["id"]).status_code == 200
    assert get(None, f"/api/pair?a={world.pa['id']}&b={world.pa2['id']}").status_code == 200
    assert get(None, "/api/islands").status_code == 200
    assert get(None, "/api/connections").status_code == 200
    assert get(None, f"/api/connections?community={world.A}").status_code == 200
    assert get(None, "/api/changes").status_code == 200
    assert get(None, "/api/map/bounds").json()["count"] == len(world.a_posts | world.b_posts) + 1
    assert get(None, "/api/terrain?min_x=-9999&min_y=-9999&max_x=9999&max_y=9999").status_code == 200
    assert get(None, "/api/health").json()["posts"] == len(world.a_posts | world.b_posts) + 1
    assert call(None, "POST", f"/api/posts/{world.pa['id']}/view", json={"viewer": "anon:" + "b" * 16}).status_code == 200
    assert get(None, f"/api/people/{world.member_a.id}/card?viewer={world.member_b.id}").status_code == 200
    # the old, wider answers: an outsider's reaction counts, a non-member's comment lands
    assert world.outsider.comment(world.pa["id"], "のぞき").status_code == 200
    assert world.outsider.react(world.pa["id"], "like").json()["created"] is True


def test_with_the_switch_off_the_old_error_codes_and_posting_rules_stay(world):
    on(world, False)
    assert call(world.member_a, "PATCH", f"/api/posts/{world.pa2['id']}", json={"tags": []}).status_code == 403
    assert call(world.member_a, "PATCH", f"/api/posts/{unknown()}", json={"tags": []}).status_code == 403
    assert call(world.member_a, "PATCH", f"/api/posts/{unknown()}", json={"body": CAMPING_A}).status_code == 404
    # a post with no community is still allowed, and a retry key still works
    plain = call(world.outsider, "POST", "/api/posts", json={"body": CAMPING_A, "tags": []})
    assert plain.status_code == 200 and plain.json()["community_id"] is None
    assert plain.json()["neighbors"]
    # a post of a community has its neighbours inside that community (the 2026-10-26 rule, unchanged)
    neighbors = get(None, f"/api/neighbors?post={world.pa['id']}&limit=50").json()["neighbors"]
    assert ids(neighbors) and ids(neighbors) <= world.a_posts
    # leaving a community changes nothing for the author of a post, and nothing is gated
    ex_member(world)
    assert get(world.ex, f"/api/neighbors?post={world.pa3['id']}").status_code == 200
    assert world.ex.comment(world.pa3["id"], "まだ書ける").status_code == 200
    # no notification is dropped on the way out
    world.member_a.react(world.pa3["id"], "like")
    browser = subscribe(world.ex)
    courier = Courier()
    assert application.dispatch_pushes(client=courier)["sent"] >= 1
    tags = [browser.decrypt(sent["body"])["tag"] for sent in courier.sent]
    assert f"reaction-{world.pa3['id']}" in tags                              # the old, plain tag


def test_with_the_switch_off_tracking_is_one_step_for_everybody(world):
    on(world, False)
    application.track_islands()
    assert all(row.get("community_id") is None for row in store().island_states())


# --------------------------------------------------------------------------
# SupabaseStore: the same switch, read through PostgREST
# --------------------------------------------------------------------------

class Recorder(BaseHTTPRequestHandler):
    """A PostgREST that records every request and answers from `answers` (table -> (status, body))."""

    calls = []
    answers = {}

    def log_message(self, *args):
        pass

    def _answer(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else None
        name = parsed.path.rsplit("/", 1)[-1]
        Recorder.calls.append({"method": self.command, "name": name, "query": parse_qs(parsed.query), "body": body})
        status, payload = Recorder.answers.get(name, (200, []))
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    do_GET = do_POST = do_PATCH = _answer


@pytest.fixture
def remote():
    Recorder.calls = []
    Recorder.answers = {}
    server = HTTPServer(("127.0.0.1", 0), Recorder)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield SupabaseStore(f"http://127.0.0.1:{server.server_address[1]}", "test-service-role-key")
    finally:
        server.shutdown()


def calls_to(name):
    return [c for c in Recorder.calls if c["name"] == name]


def test_supabase_reads_the_switch_caches_it_and_fails_closed(remote):
    Recorder.answers["app_settings"] = (200, [{"value": True}])
    assert remote.members_only() is True and remote.members_only() is True
    assert len(calls_to("app_settings")) == 1                                       # cached for a few seconds
    assert calls_to("app_settings")[0]["query"]["key"] == ["eq.members_only"]
    # not set yet (every release before the lockdown SQL): off
    fresh = SupabaseStore(remote._root.replace("/rest/v1", ""), "test-service-role-key")
    Recorder.answers["app_settings"] = (200, [])
    assert fresh.members_only() is False
    # a table the database does not have yet: off
    missing = SupabaseStore(remote._root.replace("/rest/v1", ""), "test-service-role-key")
    Recorder.answers["app_settings"] = (404, {"code": "PGRST205", "message": "no table"})
    assert missing.members_only() is False
    # anything else that goes wrong: an error, never a guess
    broken = SupabaseStore(remote._root.replace("/rest/v1", ""), "test-service-role-key")
    Recorder.answers["app_settings"] = (400, {"code": "XX000", "message": "boom"})
    with pytest.raises(StoreError):
        broken.members_only()


def test_supabase_refuses_all_posts_once_the_switch_is_on_and_scopes_every_call(remote):
    Recorder.answers["app_settings"] = (200, [{"value": True}])
    Recorder.answers["communities"] = (200, [{"id": "c"}])
    community = str(uuid.uuid4())
    # off (or never read): the old unscoped calls
    cold = SupabaseStore(remote._root.replace("/rest/v1", ""), "test-service-role-key")
    cold.list_terms()
    cold.nearest_posts("p", 3)
    cold.post_centroids()
    assert "p_community" not in calls_to("nearest_posts")[0]["body"]
    assert calls_to("account_post_centroids")[0]["body"] == {}
    # on: nothing is asked without a community, and nothing goes out for it
    assert remote.members_only() is True
    Recorder.calls.clear()
    for ask in (lambda: remote.list_terms(), lambda: remote.terrain_posts(), lambda: remote.count_posts(),
                lambda: remote.nearest_posts("p", 3), lambda: remote.nearest_to_vector([0.1, 0.2], 3),
                lambda: remote.post_centroids()):
        with pytest.raises(ValueError):
            ask()
    assert Recorder.calls == []
    # with one: the community travels with the call, in the database function's own parameter
    remote.nearest_posts("p", 3, community=community)
    remote.nearest_to_vector([0.1, 0.2], 3, community=community)
    remote.post_centroids(community=community)
    remote.map_posts_for_community(community, 0, 0, 1, 1, 50)
    remote.list_terms(community=community)
    remote.count_posts(community=community)
    assert calls_to("nearest_posts")[0]["body"] == {"from_post": "p", "k": 3, "p_community": community}
    assert calls_to("nearest_to_vector")[0]["body"]["p_community"] == community
    assert calls_to("account_post_centroids")[0]["body"] == {"p_community": community}
    assert calls_to("map_posts_for_community")[0]["body"] == {
        "p_community": community, "min_x": 0, "min_y": 0, "max_x": 1, "max_y": 1, "limit_n": 50}
    posts = [c for c in calls_to("posts") if c["method"] == "GET"]
    assert all(c["query"]["community_id"] == [f"eq.{community}"] for c in posts)
    assert "community_id" in posts[0]["query"]["select"][0]
    # the preview function refuses a missing community in Python too
    with pytest.raises(ValueError):
        remote.map_posts_for_community(None, 0, 0, 1, 1, 50)


def test_supabase_reads_a_persons_communities_fresh_every_time(remote):
    Recorder.answers["community_members"] = (200, [{"community_id": "c1"}])
    assert remote.viewer_communities("me") == {"c1"}
    assert remote.viewer_communities("me") == {"c1"}
    assert len(calls_to("community_members")) == 2
    assert remote.viewer_communities(None) == set()
    assert calls_to("community_members")[0]["query"]["account_id"] == ["eq.me"]


def test_supabase_island_and_notification_rows_carry_the_community_only_while_the_switch_is_on(remote):
    Recorder.answers["app_settings"] = (200, [{"value": False}])
    remote.members_only()
    remote.insert_notifications([{"recipient_id": "r", "type": "island", "community_id": "c"}])
    assert "community_id" not in calls_to("notifications")[0]["body"][0]
    remote.island_states()
    assert "community_id" not in calls_to("islands_state")[0]["query"]["select"][0]
    Recorder.answers["app_settings"] = (200, [{"value": True}])
    Recorder.calls.clear()
    on_store = SupabaseStore(remote._root.replace("/rest/v1", ""), "test-service-role-key")
    on_store.members_only()
    on_store.insert_notifications([{"recipient_id": "r", "type": "island", "community_id": "c"}])
    assert calls_to("notifications")[0]["body"][0]["community_id"] == "c"
    on_store.island_states(communities={"c"})
    last = calls_to("islands_state")[-1]["query"]
    assert last["community_id"] == ["in.(c)"] and "community_id" in last["select"][0]
    on_store.list_island_events(communities={"c"})
    assert calls_to("island_events")[-1]["query"]["community_id"] == ["in.(c)"]
    assert on_store.list_island_events(communities=set()) == []
    assert on_store.island_states(communities=set()) == []


def test_the_two_stores_have_the_same_members_only_surface():
    memory = MemoryStore()
    for method in ("members_only", "viewer_communities", "community_member_ids", "community_ids",
                   "map_posts_for_community", "list_terms", "terrain_posts", "nearest_posts",
                   "nearest_to_vector", "post_centroids", "count_posts", "island_states",
                   "list_island_events"):
        assert hasattr(memory, method) and hasattr(SupabaseStore, method), method
    assert SERVICE is not None


def test_nothing_derived_from_posts_is_left_to_a_shared_cache(world):
    on(world)
    for path in (f"/api/neighbors?post={world.pa['id']}", f"/api/map/bounds?community={world.A}",
                 f"/api/people/{world.member_a.id}/card", "/api/local/map"):
        assert get(world.member_a, path).headers["cache-control"] == "private, no-store", path
    assert get(world.outsider, f"/api/neighbors?post={world.pa['id']}").headers["cache-control"] == "private, no-store"
    on(world, False)
    assert "no-store" not in get(world.member_a, f"/api/neighbors?post={world.pa['id']}").headers.get("cache-control", "")


def test_the_sql_files_give_up_on_a_lock_and_hide_unscoped_island_notifications():
    """Text guards for what only a real database can run (pgTAP does the behaviour)."""
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent / "supabase"
    files = [root / "migrations" / "20261027000000_members_only_prep.sql",
             root / "migrations" / "20261027010000_members_only_lockdown.sql",
             root / "rollback" / "20261027010000_members_only_rollback.sql"]
    for path in files:
        text = path.read_text(encoding="utf-8")
        assert "set local lock_timeout = '3s'" in text, path.name
    lockdown = files[1].read_text(encoding="utf-8")
    assert lockdown.count("'island', 'quiet_post', 'similar') or") == 2   # the policy and the feed
    assert "count(*) = 1" not in lockdown                                   # legacy rows are never dropped by a head count
    assert "_mo_legacy_owner" in lockdown
