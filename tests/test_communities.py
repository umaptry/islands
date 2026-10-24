"""Communities, invite links, one map per community, invite-only sign-up (2026-10-26).

MemoryStore and the /api/local/* stand-ins keep the same rules as
supabase/migrations/20261026010000_communities_and_invites.sql; these tests are the Python
half of that promise. Everybody here is made up.
"""

import re
import uuid
from datetime import datetime, timedelta, timezone

import pytest

import app as application
from conftest import CAMPING_A, CAMPING_B, Person
from core.config import (
    COMMUNITY_ERROR_POST,
    INVITE_ERROR_ADMIN_ONLY,
    INVITE_ERROR_ADMIN_ONLY_LIST,
    INVITE_ERROR_ADMIN_ONLY_REVOKE,
    INVITE_ERROR_EXPIRED,
    INVITE_ERROR_MINUTES,
    INVITE_ERROR_REQUIRED,
    INVITE_ERROR_REVOKED,
    INVITE_ERROR_UNKNOWN,
    LOCAL_DEMO_COMMUNITY_NAME,
    LOCAL_DEMO_INVITE_CODE,
)


def store():
    return application.state["store"]


def get(person, path):
    return person.client.get(path, headers=person.headers)


def post(person, path, body):
    return person.client.post(path, json=body, headers=person.headers)


def make_community(person, name="BAR", slug=None):
    """What an operator's one SQL line does: a community with this person as its admin."""
    return store().create_community(name, slug or f"c-{uuid.uuid4().hex[:8]}", person.id)


def create_invite(person, community_id, minutes=60, until_end_of_day=False):
    response = post(person, "/api/local/invites", {
        "community_id": community_id, "minutes": minutes, "until_end_of_day": until_end_of_day})
    assert response.status_code == 200, response.text
    return response.json()


def sign_in(client, email):
    """A signed-in token WITHOUT an account row (the state of a new person after the code)."""
    code = client.post("/api/local/auth/otp", json={"email": email}).json()["code"]
    token = client.post("/api/local/auth/verify", json={"email": email, "code": code}).json()
    return token["user"]["id"], {"Authorization": f"Bearer {token['access_token']}"}


def save_profile(client, headers, name):
    return client.put("/api/account/me", json={"display_name": name, "icon_id": "1"}, headers=headers)


# --------------------------------------------------------------------------
# config
# --------------------------------------------------------------------------

def test_config_tells_the_screen_about_communities_and_invite_only(fresh_client):
    config = fresh_client.get("/api/config").json()
    assert config["features"]["communities"] is True
    assert config["invite_only"] is False, "invite_only starts false: the existing tests and the old code"
    store().set_invite_only(True)
    assert fresh_client.get("/api/config").json()["invite_only"] is True


def test_config_says_communities_are_off_when_the_store_cannot(fresh_client, monkeypatch):
    monkeypatch.setattr(store(), "supports_communities", False, raising=False)
    store().set_invite_only(True)
    config = fresh_client.get("/api/config").json()
    assert config["features"]["communities"] is False
    assert config["invite_only"] is False, "no invite_only without communities"


def test_health_reports_communities_without_making_the_app_unready(fresh_client):
    response = fresh_client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["communities_ready"] is True and response.json()["ready"] is True


# --------------------------------------------------------------------------
# the demo community (local start-up only)
# --------------------------------------------------------------------------

def test_the_demo_community_and_its_fixed_code(people):
    store().seed_demo_community()
    store().seed_demo_community()  # once only
    ann = people("ann@example.com", "あん")
    check = ann.client.get(f"/api/local/invites/check/{LOCAL_DEMO_INVITE_CODE}").json()
    assert check == {"valid": True, "community_name": LOCAL_DEMO_COMMUNITY_NAME, "reason": None}
    joined = post(ann, "/api/local/invites/claim", {"code": LOCAL_DEMO_INVITE_CODE}).json()
    assert joined["community_name"] == LOCAL_DEMO_COMMUNITY_NAME
    mine = get(ann, "/api/local/communities/mine").json()["communities"]
    assert [row["name"] for row in mine] == [LOCAL_DEMO_COMMUNITY_NAME]
    assert mine[0]["role"] == "member" and mine[0]["slug"] == "demo"
    assert len(store()._communities) == 1


def test_a_plain_fresh_store_has_no_demo_community(people):
    ann = people("ann@example.com", "あん")
    assert get(ann, "/api/local/communities/mine").json() == {"communities": []}


# --------------------------------------------------------------------------
# making, listing and stopping invites
# --------------------------------------------------------------------------

def test_an_admin_makes_an_invite_with_a_long_random_code(people):
    admin = people("admin@example.com", "かんり")
    cid = make_community(admin)
    first = create_invite(admin, cid, 60)
    second = create_invite(admin, cid, 60)
    assert set(first) == {"code", "expires_at", "id"}
    assert len(first["code"]) >= 22 and re.fullmatch(r"[0-9a-f]+", first["code"])
    assert first["code"] != second["code"]
    expires = datetime.fromisoformat(first["expires_at"])
    assert timedelta(minutes=59) < expires - datetime.now(timezone.utc) < timedelta(minutes=61)
    rows = get(admin, f"/api/local/invites?community_id={cid}").json()["invites"]
    assert [row["id"] for row in rows] == [second["id"], first["id"]], "newest first"
    assert set(rows[0]) == {"id", "code", "expires_at", "revoked_at", "uses", "created_at"}
    assert rows[0]["uses"] == 0 and rows[0]["revoked_at"] is None


def test_only_the_admin_of_that_community_makes_lists_or_stops_invites(people):
    admin = people("admin@example.com", "かんり")
    member = people("member@example.com", "めんば")
    other_admin = people("other@example.com", "べつ")
    cid = make_community(admin)
    other = make_community(other_admin, "べつの会")
    invite = create_invite(admin, cid)
    post(member, "/api/local/invites/claim", {"code": invite["code"]})

    for person in (member, other_admin):
        denied = post(person, "/api/local/invites", {"community_id": cid, "minutes": 60})
        assert denied.status_code == 403 and denied.json()["detail"] == INVITE_ERROR_ADMIN_ONLY
        listed = get(person, f"/api/local/invites?community_id={cid}")
        assert listed.status_code == 403 and listed.json()["detail"] == INVITE_ERROR_ADMIN_ONLY_LIST
        stopped = post(person, f"/api/local/invites/{invite['id']}/revoke", {})
        assert stopped.status_code == 403 and stopped.json()["detail"] == INVITE_ERROR_ADMIN_ONLY_REVOKE
    # an admin of one community cannot make invites for another
    assert post(admin, "/api/local/invites", {"community_id": other, "minutes": 60}).status_code == 403
    assert store()._invites[invite["id"]]["revoked_at"] is None


def test_invite_routes_need_login(fresh_client):
    assert fresh_client.get("/api/local/communities/mine").status_code == 401
    assert fresh_client.post("/api/local/invites/claim", json={"code": "x"}).status_code == 401
    assert fresh_client.post("/api/local/invites", json={"community_id": "x", "minutes": 5}).status_code == 401
    assert fresh_client.get("/api/local/invites?community_id=x").status_code == 401
    assert fresh_client.post("/api/local/invites/x/revoke", json={}).status_code == 401
    # checking a code does not need login (the page that asks is the one before sign-up)
    assert fresh_client.get("/api/local/invites/check/nonsense").status_code == 200


@pytest.mark.parametrize("minutes", [0, -5, 43201, 10 ** 9])
def test_the_length_of_an_invite_is_bounded(people, minutes):
    admin = people("admin@example.com", "かんり")
    cid = make_community(admin)
    response = post(admin, "/api/local/invites", {"community_id": cid, "minutes": minutes})
    assert response.status_code == 422 and response.json()["detail"] == INVITE_ERROR_MINUTES


def test_until_the_end_of_the_day_is_23_59_in_japan_and_ignores_minutes(people):
    admin = people("admin@example.com", "かんり")
    cid = make_community(admin)
    made = create_invite(admin, cid, minutes=0, until_end_of_day=True)
    expires = datetime.fromisoformat(made["expires_at"])
    jst = expires + timedelta(hours=9)
    assert (jst.hour, jst.minute) == (23, 59)
    now = datetime.now(timezone.utc)
    assert now < expires <= now + timedelta(hours=25)


def test_the_end_of_the_day_moves_to_tomorrow_when_it_is_almost_over():
    from core.store import MemoryStore
    late = datetime(2026, 10, 24, 14, 55, tzinfo=timezone.utc)  # 23:55 in Japan
    end = MemoryStore._end_of_day_jst(late)
    assert end == datetime(2026, 10, 24, 14, 59, tzinfo=timezone.utc)
    early = datetime(2026, 10, 24, 15, 1, tzinfo=timezone.utc)  # 00:01 on the 25th in Japan
    assert MemoryStore._end_of_day_jst(early) == datetime(2026, 10, 25, 14, 59, tzinfo=timezone.utc)


# --------------------------------------------------------------------------
# check_invite: that and nothing else
# --------------------------------------------------------------------------

def test_check_invite_answers_three_keys_and_the_reason(people):
    admin = people("admin@example.com", "かんり")
    cid = make_community(admin, "ひみつの会")
    good = create_invite(admin, cid)
    expired = create_invite(admin, cid)
    stopped = create_invite(admin, cid)
    store().expire_invite(expired["id"])
    post(admin, f"/api/local/invites/{stopped['id']}/revoke", {})

    def check(code):
        return admin.client.get(f"/api/local/invites/check/{code}").json()

    assert check(good["code"]) == {"valid": True, "community_name": "ひみつの会", "reason": None}
    assert check(expired["code"]) == {"valid": False, "community_name": "ひみつの会", "reason": "expired"}
    assert check(stopped["code"]) == {"valid": False, "community_name": "ひみつの会", "reason": "revoked"}
    assert check("nonsense") == {"valid": False, "community_name": None, "reason": "unknown"}
    assert cid not in repr(check(good["code"])), "no community id"


# --------------------------------------------------------------------------
# claiming
# --------------------------------------------------------------------------

def test_claiming_joins_once_and_counts_the_use_once(people):
    admin = people("admin@example.com", "かんり")
    ann = people("ann@example.com", "あん")
    cid = make_community(admin, "BAR")
    invite = create_invite(admin, cid)
    for _ in range(2):
        claimed = post(ann, "/api/local/invites/claim", {"code": invite["code"]})
        assert claimed.status_code == 200
        assert claimed.json() == {"community_id": cid, "community_name": "BAR"}
    mine = get(ann, "/api/local/communities/mine").json()["communities"]
    assert [(row["community_id"], row["role"]) for row in mine] == [(cid, "member")]
    rows = get(admin, f"/api/local/invites?community_id={cid}").json()["invites"]
    assert rows[0]["uses"] == 1
    assert ann.id in store()._invite_claims


def test_a_person_can_be_in_several_communities(people):
    admin = people("admin@example.com", "かんり")
    ann = people("ann@example.com", "あん")
    first, second = make_community(admin, "ひとつめ"), make_community(admin, "ふたつめ")
    post(ann, "/api/local/invites/claim", {"code": create_invite(admin, first)["code"]})
    post(ann, "/api/local/invites/claim", {"code": create_invite(admin, second)["code"]})
    names = [row["name"] for row in get(ann, "/api/local/communities/mine").json()["communities"]]
    assert names == ["ひとつめ", "ふたつめ"]


def test_an_expired_stopped_or_unknown_invite_cannot_be_used(people):
    admin = people("admin@example.com", "かんり")
    ann = people("ann@example.com", "あん")
    cid = make_community(admin)
    expired, stopped = create_invite(admin, cid), create_invite(admin, cid)
    store().expire_invite(expired["id"])
    post(admin, f"/api/local/invites/{stopped['id']}/revoke", {})
    for code, words in ((expired["code"], INVITE_ERROR_EXPIRED), (stopped["code"], INVITE_ERROR_REVOKED),
                        ("nonsense", INVITE_ERROR_UNKNOWN)):
        response = post(ann, "/api/local/invites/claim", {"code": code})
        assert response.status_code == 422 and response.json()["detail"] == words
    assert get(ann, "/api/local/communities/mine").json()["communities"] == []
    assert ann.id not in store()._invite_claims, "a failed claim leaves no mark"


def test_expiry_is_checked_at_the_moment_of_use(people):
    admin = people("admin@example.com", "かんり")
    ann = people("ann@example.com", "あん")
    cid = make_community(admin)
    invite = create_invite(admin, cid)
    assert post(ann, "/api/local/invites/claim", {"code": invite["code"]}).status_code == 200
    bob = people("bob@example.com", "ぼぶ")
    store().expire_invite(invite["id"])  # it was fine when it was made; not any more
    assert post(bob, "/api/local/invites/claim", {"code": invite["code"]}).status_code == 422


def test_a_stopped_invite_keeps_the_first_stop_time(people):
    admin = people("admin@example.com", "かんり")
    cid = make_community(admin)
    invite = create_invite(admin, cid)
    assert post(admin, f"/api/local/invites/{invite['id']}/revoke", {}).json() == {"ok": True}
    first = store()._invites[invite["id"]]["revoked_at"]
    post(admin, f"/api/local/invites/{invite['id']}/revoke", {})
    assert store()._invites[invite["id"]]["revoked_at"] == first


# --------------------------------------------------------------------------
# invite-only sign-up
# --------------------------------------------------------------------------

def test_while_invite_only_is_off_anybody_can_register(fresh_client):
    _id, headers = sign_in(fresh_client, "free@example.com")
    assert save_profile(fresh_client, headers, "じゆう").status_code == 200


def test_invite_only_stops_a_new_account_without_an_invite(fresh_client):
    store().set_invite_only(True)
    user_id, headers = sign_in(fresh_client, "newbie@example.com")
    for path in ("/api/account/me", "/api/local/account"):
        response = fresh_client.put(path, json={"display_name": "しんき"}, headers=headers)
        assert response.status_code == 403 and response.json()["detail"] == INVITE_ERROR_REQUIRED
    assert store().get_account(user_id) is None, "nothing was written"


def test_a_claimed_invite_lets_the_new_account_be_made(fresh_client):
    admin = Person(fresh_client, "admin@example.com", "かんり")
    cid = make_community(admin)
    invite = create_invite(admin, cid)
    store().set_invite_only(True)
    user_id, headers = sign_in(fresh_client, "newbie@example.com")
    assert save_profile(fresh_client, headers, "しんき").status_code == 403
    claimed = fresh_client.post("/api/local/invites/claim", json={"code": invite["code"]}, headers=headers)
    assert claimed.status_code == 200, "the claim works before the account row exists"
    assert save_profile(fresh_client, headers, "しんき").status_code == 200
    assert store().get_account(user_id)["display_name"] == "しんき"
    mine = fresh_client.get("/api/local/communities/mine", headers=headers).json()["communities"]
    assert [row["community_id"] for row in mine] == [cid]


def test_a_claim_only_helps_the_person_who_made_it(fresh_client):
    admin = Person(fresh_client, "admin@example.com", "かんり")
    invite = create_invite(admin, make_community(admin))
    store().set_invite_only(True)
    _a, claimer = sign_in(fresh_client, "a@example.com")
    _b, other = sign_in(fresh_client, "b@example.com")
    fresh_client.post("/api/local/invites/claim", json={"code": invite["code"]}, headers=claimer)
    assert save_profile(fresh_client, claimer, "あ").status_code == 200
    assert save_profile(fresh_client, other, "い").status_code == 403


def test_existing_accounts_keep_working_when_invite_only_is_on(fresh_client):
    ann = Person(fresh_client, "ann@example.com", "あん")  # registered before the switch
    store().set_invite_only(True)
    saved = fresh_client.put("/api/account/me", json={"display_name": "あん改", "bio": "よろしく"},
                             headers=ann.headers)
    assert saved.status_code == 200 and saved.json()["account"]["display_name"] == "あん改"
    assert ann.post(CAMPING_A)["id"], "and they still post"
    # logging in again is the same OTP flow
    _id, headers = sign_in(fresh_client, "ann@example.com")
    assert fresh_client.get("/api/account/me", headers=headers).json()["account"]["display_name"] == "あん改"


def test_the_local_dev_switch_for_invite_only(fresh_client):
    assert fresh_client.get("/api/local/settings/invite-only").json() == {"invite_only": False}
    assert fresh_client.post("/api/local/settings/invite-only", json={"value": True}).json() == {"invite_only": True}
    assert fresh_client.get("/api/config").json()["invite_only"] is True
    fresh_client.post("/api/local/settings/invite-only", json={"value": False})
    assert fresh_client.get("/api/config").json()["invite_only"] is False


# --------------------------------------------------------------------------
# posting into a community, and one map per community
# --------------------------------------------------------------------------

def test_a_member_posts_into_the_community_and_the_post_says_so(people):
    admin = people("admin@example.com", "かんり")
    ann = people("ann@example.com", "あん")
    cid = make_community(admin)
    post(ann, "/api/local/invites/claim", {"code": create_invite(admin, cid)["code"]})
    made = ann.post(CAMPING_A, community_id=cid)
    assert made["community_id"] == cid
    one = ann.client.get(f"/api/local/post/{made['id']}").json()
    assert one["community_id"] == cid, "opening one post says which community's map it is on"
    # the old way (no community_id) still works and says null
    plain = ann.post(CAMPING_B)
    assert plain["community_id"] is None
    assert ann.client.get(f"/api/local/post/{plain['id']}").json()["community_id"] is None


def test_a_non_member_cannot_post_into_a_community(people):
    admin = people("admin@example.com", "かんり")
    outsider = people("out@example.com", "そと")
    cid = make_community(admin)
    for community_id in (cid, str(uuid.uuid4()), "not-a-uuid"):
        response = post(outsider, "/api/posts", {"body": CAMPING_A, "tags": [], "motivation": 50,
                                                 "community_id": community_id})
        assert response.status_code == 403 and response.json()["detail"] == COMMUNITY_ERROR_POST
    assert store().count_posts() == 0


def test_leaving_the_community_stops_posting_to_it(people):
    admin = people("admin@example.com", "かんり")
    cid = make_community(admin)
    del store()._members[(cid, admin.id)]
    response = post(admin, "/api/posts", {"body": CAMPING_A, "tags": [], "motivation": 50, "community_id": cid})
    assert response.status_code == 403


def test_community_id_is_ignored_while_communities_are_off(people, monkeypatch):
    admin = people("admin@example.com", "かんり")
    outsider = people("out@example.com", "そと")
    cid = make_community(admin)
    monkeypatch.setattr(store(), "supports_communities", False, raising=False)
    made = outsider.post(CAMPING_A, community_id=cid)
    assert made["community_id"] is None, "the old behaviour: one map, no check"


def test_each_community_has_its_own_map(people):
    admin = people("admin@example.com", "かんり")
    ann = people("ann@example.com", "あん")
    bar, other = make_community(admin, "BAR"), make_community(admin, "べつ")
    post(ann, "/api/local/invites/claim", {"code": create_invite(admin, bar)["code"]})
    a = admin.post(CAMPING_A, community_id=bar)
    b = ann.post(CAMPING_B, community_id=bar)
    c = admin.post(CAMPING_B + "べつの会で。", community_id=other)
    nowhere = admin.post("どこにも属さない投稿です。静かな図書館で本を読むのが好きで、週末は散歩もします。")

    def ids(community_id):
        posts = ann.client.get(f"/api/local/communities/{community_id}/map").json()["posts"]
        return {row["id"] for row in posts}

    assert ids(bar) == {a["id"], b["id"]}
    assert ids(other) == {c["id"]}
    assert ids(str(uuid.uuid4())) == set()
    everything = {row["id"] for row in ann.client.get("/api/local/map").json()["posts"]}
    assert everything >= {a["id"], b["id"], c["id"], nowhere["id"]}, "the old map is unchanged"
    assert nowhere["id"] not in ids(bar) | ids(other)
    row = ann.client.get(f"/api/local/communities/{bar}/map").json()["posts"][0]
    old_row = next(r for r in ann.client.get("/api/local/map").json()["posts"] if r["id"] == row["id"])
    assert row == old_row, "the same shape as the old map"


def test_the_community_map_honours_the_box_and_the_limit_and_hides_deleted_posts(people):
    admin = people("admin@example.com", "かんり")
    cid = make_community(admin)
    first = admin.post(CAMPING_A, community_id=cid)
    admin.post(CAMPING_B, community_id=cid)
    base = f"/api/local/communities/{cid}/map"
    assert len(admin.client.get(base).json()["posts"]) == 2
    assert len(admin.client.get(base + "?limit=1").json()["posts"]) == 1
    assert admin.client.get(base + "?min_x=100000&min_y=100000").json()["posts"] == []
    assert admin.client.delete(f"/api/posts/{first['id']}", headers=admin.headers).status_code == 200
    assert first["id"] not in {r["id"] for r in admin.client.get(base).json()["posts"]}


def test_the_community_map_is_public_like_the_old_map(fresh_client):
    assert fresh_client.get(f"/api/local/communities/{uuid.uuid4()}/map").status_code == 200


def test_idempotent_retry_with_a_community_gives_the_same_post(people):
    admin = people("admin@example.com", "かんり")
    cid = make_community(admin)
    key = str(uuid.uuid4())
    body = {"body": CAMPING_A, "tags": [], "motivation": 50, "community_id": cid}
    first = admin.client.post("/api/posts", json=body, headers={**admin.headers, "Idempotency-Key": key})
    again = admin.client.post("/api/posts", json=body, headers={**admin.headers, "Idempotency-Key": key})
    assert first.json()["id"] == again.json()["id"]
    assert again.json()["community_id"] == cid


# --------------------------------------------------------------------------
# production surface stays closed
# --------------------------------------------------------------------------

def test_local_community_routes_do_not_exist_in_production(fresh_client, monkeypatch):
    monkeypatch.setitem(application.state, "local_mode", False)
    bodies = {"/api/local/invites/claim": {"code": "x"}, "/api/local/invites": {"community_id": "x"},
              "/api/local/communities": {"name": "x"}, "/api/local/settings/invite-only": {"value": True}}
    for method, path in (("get", "/api/local/communities/mine"),
                         ("get", "/api/local/invites/check/x"),
                         ("post", "/api/local/invites/claim"),
                         ("post", "/api/local/invites"),
                         ("get", "/api/local/invites?community_id=x"),
                         ("post", "/api/local/invites/x/revoke"),
                         ("get", f"/api/local/communities/{uuid.uuid4()}/map"),
                         ("post", "/api/local/communities"),
                         ("get", "/api/local/settings/invite-only"),
                         ("post", "/api/local/settings/invite-only"),
                         ("post", "/api/local/invites/x/expire")):
        kwargs = {"json": bodies.get(path, {})} if method == "post" else {}
        response = getattr(fresh_client, method)(path, **kwargs)
        assert response.status_code == 404, (method, path, response.status_code)


def test_a_community_name_is_readable_by_id_without_signing_in(people, fresh_client):
    cid = store().seed_demo_community()
    assert fresh_client.get(f"/api/local/communities/{cid}").json() == {"id": cid, "name": LOCAL_DEMO_COMMUNITY_NAME}
    assert fresh_client.get(f"/api/local/communities/{uuid.uuid4()}").status_code == 404


# --------------------------------------------------------------------------
# lines and neighbours stay inside one community's map
# --------------------------------------------------------------------------

def join(person, admin, cid):
    assert post(person, "/api/local/invites/claim", {"code": create_invite(admin, cid)["code"]}).status_code == 200


@pytest.fixture
def two_maps(people, monkeypatch):
    """BAR (ann posts, ben joined and commented) and another community (cho posts, dai commented)."""
    monkeypatch.setattr(application, "CONNECTIONS_SINCE", "2000-01-01T00:00:00+00:00")
    application.invalidate_connections()
    admin = people("admin@example.com", "かんり")
    ann, ben, cho, dai = (people(f"{n}@example.com", n) for n in ("ann", "ben", "cho", "dai"))
    bar, other = make_community(admin, "BAR"), make_community(admin, "もう一つの会")
    join(ann, admin, bar)
    join(ben, admin, bar)
    join(cho, admin, other)
    join(dai, admin, other)
    bar_post = ann.post(CAMPING_A, community_id=bar)
    ben.post(CAMPING_B, community_id=bar)
    other_post = cho.post(CAMPING_B, community_id=other)
    dai.post(CAMPING_A, community_id=other)
    ben.comment(bar_post["id"], "いいですね")
    dai.comment(other_post["id"], "いいですね")
    application.invalidate_connections()
    yield {"bar": bar, "other": other, "ann": ann, "ben": ben, "cho": cho, "dai": dai,
           "bar_post": bar_post, "other_post": other_post}
    application.invalidate_connections()


def line_pairs(client, community=None):
    params = {"community": community} if community else {}
    response = client.get("/api/connections", params=params)
    assert response.status_code == 200, response.text
    return {frozenset((row["a"], row["b"])) for row in response.json()["connections"]}


def test_the_lines_of_a_community_map_are_that_communitys_only(two_maps):
    m = two_maps
    client = m["ann"].client
    assert line_pairs(client, m["bar"]) == {frozenset((m["ann"].id, m["ben"].id))}
    assert line_pairs(client, m["other"]) == {frozenset((m["cho"].id, m["dai"].id))}
    assert len(line_pairs(client)) == 2, "without a community: every line, as before"
    # both ends of a BAR line stand on BAR posts
    posts = {m["bar_post"]["id"]}
    posts |= {p["id"] for p in client.get("/api/local/posts", params={"author": m["ben"].id}).json()["posts"]}
    for row in client.get("/api/connections", params={"community": m["bar"]}).json()["connections"]:
        assert row["a_post"] in posts and row["b_post"] in posts


def test_a_bad_community_for_lines_is_refused_and_ignored_while_communities_are_off(two_maps, monkeypatch):
    client = two_maps["ann"].client
    assert client.get("/api/connections", params={"community": "not-a-uuid"}).status_code == 422
    monkeypatch.setattr(store(), "supports_communities", False, raising=False)
    assert client.get("/api/connections", params={"community": "not-a-uuid"}).status_code == 200


def test_the_neighbours_of_a_community_post_are_in_that_community(two_maps):
    m = two_maps
    near = m["ann"].client.get(f"/api/neighbors?post={m['bar_post']['id']}&limit=10").json()["neighbors"]
    assert near, "ben's BAR post is near"
    assert {row["author_id"] for row in near} == {m["ben"].id}, "not cho's or dai's, though they write alike"
    plain = m["ann"].post(CAMPING_B)   # a post with no community: everybody's, as before
    everybody = m["ann"].client.get(f"/api/neighbors?post={plain['id']}&limit=10").json()["neighbors"]
    assert {row["author_id"] for row in everybody} >= {m["cho"].id, m["dai"].id}


# --------------------------------------------------------------------------
# local mode is refused on Cloud Run
# --------------------------------------------------------------------------

def test_local_mode_is_refused_on_cloud_run_unless_asked_for(fresh_client, monkeypatch):
    monkeypatch.delenv("K_SERVICE", raising=False)
    monkeypatch.delenv("ISLANDS_LOCAL", raising=False)
    assert application.local_mode_allowed() is True
    assert fresh_client.get("/api/local/settings/invite-only").status_code == 200
    monkeypatch.setenv("K_SERVICE", "islands")
    assert application.local_mode_allowed() is False
    # the dev switches need no login, so they must not exist there (a lost SUPABASE_* would open them)
    assert fresh_client.post("/api/local/settings/invite-only", json={"value": False}).status_code == 404
    assert fresh_client.post("/api/local/invites/x/expire").status_code == 404
    assert fresh_client.post("/api/local/auth/otp", json={"email": "x@example.com"}).status_code == 404
    monkeypatch.setenv("ISLANDS_LOCAL", "1")
    assert application.local_mode_allowed() is True
