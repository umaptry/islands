"""承認制（2026-11-01）：MemoryStore と /api/local/* の道が、A の設計（supabase M1）と同じ筋書きで動く。

pgTAP（supabase/tests/22_join_approval.sql）と同じ筋書きを手元モードで：承認待ち・承認・断る・取り消し・
オフのリンクで承認待ちが消える・断った人はどのリンクでも承認待ち・通知の間引き・メールは承認待ちの間だけ。
ここに出てくる人はみんな作り話。
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest

import app as application
from conftest import CAMPING_A
from core import config, notifications as notices
from core.config import (
    APPROVAL_ERROR_DECIDE_ADMIN_ONLY,
    APPROVAL_ERROR_INVITE_ADMIN_ONLY,
    APPROVAL_ERROR_LIST_ADMIN_ONLY,
    APPROVAL_ERROR_POST_NOT_IN_COMMUNITY,
    CONSENT_VERSION,
)


def store():
    return application.state["store"]


def get(person, path):
    return person.client.get(path, headers=person.headers)


def post(person, path, body=None):
    return person.client.post(path, json=body or {}, headers=person.headers)


def make_community(admin, name="BAR"):
    return store().create_community(name, f"c-{uuid.uuid4().hex[:8]}", admin.id)


def make_invite(admin, cid, approval=False, **extra):
    response = post(admin, "/api/local/invites", {
        "community_id": cid, "minutes": 60, "needs_approval": approval, **extra})
    assert response.status_code == 200, response.text
    return response.json()


def claim(person, code, consent=None):
    body = {"code": code}
    if consent:
        body["consent"] = consent
    response = post(person, "/api/local/invites/claim", body)
    assert response.status_code == 200, response.text
    return response.json()


def waiting(admin, cid):
    response = get(admin, f"/api/local/communities/{cid}/join-requests")
    assert response.status_code == 200, response.text
    return response.json()["requests"]


def decide(admin, cid, person, approve):
    response = post(admin, f"/api/local/communities/{cid}/join-requests/{person.id}/decide", {"approve": approve})
    assert response.status_code == 200, response.text
    return response.json()["result"]


def is_member(cid, person):
    return store().is_community_member(cid, person.id)


@pytest.fixture
def world(people):
    admin = people("admin@example.test", "かんり")
    cid = make_community(admin, "コクヨ")
    return admin, cid, people


# --------------------------------------------------------------------------
# the link
# --------------------------------------------------------------------------

def test_a_link_that_is_off_lets_people_in_and_records_how(world):
    admin, cid, people = world
    ann = people("ann@example.test", "あん")
    invite = make_invite(admin, cid)
    assert invite["needs_approval"] is False and invite["post_id"] is None
    assert claim(ann, invite["code"]) == {
        "community_id": cid, "community_name": "コクヨ", "status": "joined", "post_id": None}
    member = store()._members[(cid, ann.id)]
    assert member["joined_via"] == "invite" and member["invite_id"] == invite["id"]
    assert store()._members[(cid, admin.id)]["joined_via"] == "founder"
    assert claim(ann, invite["code"])["status"] == "already"
    assert store()._invites[invite["id"]]["uses"] == 1


def test_a_link_that_is_on_makes_a_waiting_person_and_the_screen_is_told(world):
    admin, cid, people = world
    ann = people("ann@example.test", "あん")
    invite = make_invite(admin, cid, approval=True)
    assert invite["needs_approval"] is True
    checked = ann.client.get(f"/api/local/invites/check/{invite['code']}").json()
    assert checked == {"valid": True, "community_name": "コクヨ", "reason": None,
                       "needs_approval": True, "post_id": None}
    answer = claim(ann, invite["code"], consent=CONSENT_VERSION)
    assert answer["status"] == "pending" and not is_member(cid, ann)
    assert store()._join_requests[(cid, ann.id)]["consent_version"] == CONSENT_VERSION == "2026-11-16"
    assert ann.id in store()._invite_claims, "a new account may still be made"
    # using the link again does not add a row or a use
    assert claim(ann, invite["code"])["status"] == "pending"
    assert store()._invites[invite["id"]]["uses"] == 1 and len(store()._join_requests) == 1


def test_a_bad_link_says_null_for_the_two_new_keys(world):
    admin, cid, _ = world
    invite = make_invite(admin, cid, approval=True)
    post(admin, f"/api/local/invites/{invite['id']}/revoke")
    checked = admin.client.get(f"/api/local/invites/check/{invite['code']}").json()
    assert checked["valid"] is False and checked["needs_approval"] is None and checked["post_id"] is None


def test_the_switch_turns_on_every_usable_link_and_off_only_this_one(world):
    admin, cid, _ = world
    one, two, stopped = make_invite(admin, cid), make_invite(admin, cid), make_invite(admin, cid)
    post(admin, f"/api/local/invites/{stopped['id']}/revoke")
    assert post(admin, f"/api/local/invites/{two['id']}/approval", {"approval": True}).status_code == 200
    rows = {row["id"]: row for row in get(admin, f"/api/local/invites?community_id={cid}").json()["invites"]}
    assert rows[one["id"]]["needs_approval"] and rows[two["id"]]["needs_approval"]
    assert not rows[stopped["id"]]["needs_approval"], "a stopped link is left alone"
    post(admin, f"/api/local/invites/{one['id']}/approval", {"approval": False})
    rows = {row["id"]: row for row in get(admin, f"/api/local/invites?community_id={cid}").json()["invites"]}
    assert not rows[one["id"]]["needs_approval"] and rows[two["id"]]["needs_approval"]


def test_only_an_admin_changes_the_switch(world):
    admin, cid, people = world
    member = people("m@example.test", "めんば")
    invite = make_invite(admin, cid)
    claim(member, invite["code"])
    refused = post(member, f"/api/local/invites/{invite['id']}/approval", {"approval": True})
    assert refused.status_code == 403 and refused.json()["detail"] == APPROVAL_ERROR_INVITE_ADMIN_ONLY
    assert post(member, f"/api/local/invites/{uuid.uuid4()}/approval", {"approval": True}).status_code == 404


def test_a_link_can_carry_a_post_of_that_community_and_only_the_saved_one_comes_back(world):
    admin, cid, people = world
    ann = people("ann@example.test", "あん")
    mine = admin.post(CAMPING_A, community_id=cid)
    other_cid = make_community(people("o@example.test", "べつ"), "べつの会")
    theirs = store().insert_post({"id": str(uuid.uuid4()), "author_id": admin.id, "body": "x", "community_id": other_cid,
                                  "x": 0, "y": 0, "cluster_id": 0, "tags": [], "created_at": datetime.now(timezone.utc).isoformat()})
    bad = post(admin, "/api/local/invites", {"community_id": cid, "post": theirs["id"]})
    assert bad.status_code == 422 and bad.json()["detail"] == APPROVAL_ERROR_POST_NOT_IN_COMMUNITY
    assert post(admin, "/api/local/invites", {"community_id": cid, "post": str(uuid.uuid4())}).status_code == 422
    invite = make_invite(admin, cid, post=mine["id"])
    assert invite["post_id"] == mine["id"]
    assert ann.client.get(f"/api/local/invites/check/{invite['code']}").json()["post_id"] == mine["id"]
    assert claim(ann, invite["code"])["post_id"] == mine["id"]
    plain = make_invite(admin, cid)
    assert claim(people("b@example.test", "びー"), plain["code"])["post_id"] is None, "a ?post= in the URL is not trusted"


# --------------------------------------------------------------------------
# waiting -> approved / turned down / cancelled
# --------------------------------------------------------------------------

def test_the_admin_sees_who_waits_with_the_email_and_approves(world):
    admin, cid, people = world
    ann = people("ann@example.test", "あん")
    claim(ann, make_invite(admin, cid, approval=True)["code"])
    rows = waiting(admin, cid)
    assert [(row["account_id"], row["display_name"], row["email"], row["provider"]) for row in rows] == [
        (ann.id, "あん", "ann@example.test", "email")]
    assert rows[0]["was_removed"] is False and rows[0]["rejected_before"] is False
    told = admin.inbox(["join_request"])
    assert len(told) == 1 and told[0]["actor_id"] == ann.id
    assert told[0]["payload"] == {"community_id": cid, "community_name": "コクヨ"}, "no e-mail in the notice"
    assert told[0]["community_id"] == cid

    assert decide(admin, cid, ann, True) == "approved"
    assert is_member(cid, ann)
    member = store()._members[(cid, ann.id)]
    assert member["role"] == "member" and member["joined_via"] == "approval"
    assert admin.inbox(["join_request"]) == [], "the waiting notice goes"
    joined = ann.inbox(["join_approved"])
    assert len(joined) == 1 and joined[0]["payload"] == {"community_id": cid, "community_name": "コクヨ"}
    assert waiting(admin, cid) == [], "and so does the e-mail"
    assert decide(admin, cid, ann, True) == "already", "a second admin pressing it too"
    assert decide(admin, cid, ann, False) == "already"


def test_turning_down_keeps_a_record_and_the_person_waits_again_on_any_link(world):
    admin, cid, people = world
    ann = people("ann@example.test", "あん")
    code = make_invite(admin, cid, approval=True)["code"]
    claim(ann, code)
    assert decide(admin, cid, ann, False) == "rejected"
    assert not is_member(cid, ann) and admin.inbox(["join_request"]) == []
    assert ann.inbox(["join_approved"]) == []
    assert waiting(admin, cid) == [] and store().my_join_status(ann.id)[0]["status"] == "rejected"

    off = make_invite(admin, cid, approval=False)
    checked = ann.client.get(f"/api/local/invites/check/{off['code']}", headers=ann.headers).json()
    assert checked["needs_approval"] is True, "a link that is off still holds back somebody who was turned down"
    assert ann.client.get(f"/api/local/invites/check/{off['code']}").json()["needs_approval"] is False
    assert claim(ann, off["code"])["status"] == "pending"
    row = waiting(admin, cid)[0]
    assert row["rejected_before"] is True
    assert len(admin.inbox(["join_request"])) == 1, "told again: the earlier notice went with the decision"
    assert store()._join_requests[(cid, ann.id)]["notified_at"]


def test_taking_back_the_application_removes_the_row_and_the_notice(world):
    admin, cid, people = world
    ann = people("ann@example.test", "あん")
    claim(ann, make_invite(admin, cid, approval=True)["code"])
    assert len(admin.inbox(["join_request"])) == 1
    assert post(ann, "/api/local/join/cancel", {"community_id": cid}).status_code == 200
    assert waiting(admin, cid) == [] and admin.inbox(["join_request"]) == []
    assert get(ann, "/api/local/join/status").json() == {"statuses": []}
    # nothing to cancel is not an error
    assert post(ann, "/api/local/join/cancel", {"community_id": cid}).status_code == 200


def test_a_waiting_person_who_uses_a_link_that_is_off_is_simply_in(world):
    admin, cid, people = world
    ann = people("ann@example.test", "あん")
    claim(ann, make_invite(admin, cid, approval=True)["code"])
    assert len(admin.inbox(["join_request"])) == 1
    off = make_invite(admin, cid, approval=False)
    assert claim(ann, off["code"])["status"] == "joined"
    assert is_member(cid, ann) and (cid, ann.id) not in store()._join_requests
    assert admin.inbox(["join_request"]) == []
    assert store()._members[(cid, ann.id)]["joined_via"] == "invite"


def test_somebody_who_was_removed_waits_even_on_a_link_that_is_off_and_comes_back_as_before(world):
    admin, cid, people = world
    ann = people("ann@example.test", "あん")
    invite = make_invite(admin, cid)
    claim(ann, invite["code"])
    # what remove_member (the later release) leaves behind
    before = store()._members.pop((cid, ann.id))
    store()._removals[(cid, ann.id)] = {
        "community_id": cid, "account_id": ann.id, "removed_at": datetime.now(timezone.utc).isoformat(),
        "removed_by": admin.id, "joined_at_before": before["joined_at"], "hidden_post_ids": [], "hidden_comment_ids": []}
    assert store().my_join_status(ann.id)[0]["status"] == "removed"
    assert claim(ann, invite["code"])["status"] == "pending"
    assert waiting(admin, cid)[0]["was_removed"] is True
    assert store().my_join_status(ann.id)[0]["status"] == "pending", "removed shows only when there is no other row"
    assert decide(admin, cid, ann, True) == "approved"
    assert store()._members[(cid, ann.id)]["joined_at"] == before["joined_at"], "the old joining day"
    assert (cid, ann.id) not in store()._removals


def test_my_join_status_lists_where_the_person_stands(world):
    admin, cid, people = world
    ann = people("ann@example.test", "あん")
    other = make_community(people("b@example.test", "びー"), "べつの会")
    claim(ann, make_invite(admin, cid, approval=True)["code"])
    rows = get(ann, "/api/local/join/status").json()["statuses"]
    assert [(r["community_id"], r["community_name"], r["status"]) for r in rows] == [(cid, "コクヨ", "pending")]
    assert other not in [r["community_id"] for r in rows]
    assert get(people("c@example.test", "しー"), "/api/local/join/status").json() == {"statuses": []}


# --------------------------------------------------------------------------
# who may do what, and the words of a refusal
# --------------------------------------------------------------------------

def test_only_an_admin_lists_or_decides_and_the_words_are_the_databases(world):
    admin, cid, people = world
    ann, member = people("ann@example.test", "あん"), people("m@example.test", "めんば")
    claim(member, make_invite(admin, cid)["code"])
    claim(ann, make_invite(admin, cid, approval=True)["code"])
    listed = get(member, f"/api/local/communities/{cid}/join-requests")
    assert listed.status_code == 403 and listed.json()["detail"] == APPROVAL_ERROR_LIST_ADMIN_ONLY
    decided = post(member, f"/api/local/communities/{cid}/join-requests/{ann.id}/decide", {"approve": True})
    assert decided.status_code == 403 and decided.json()["detail"] == APPROVAL_ERROR_DECIDE_ADMIN_ONLY
    assert not is_member(cid, ann)
    for path, method in (("/api/local/join/status", "get"), ("/api/local/join/cancel", "post"),
                         (f"/api/local/communities/{cid}/join-requests", "get")):
        response = getattr(ann.client, method)(path, **({"json": {"community_id": cid}} if method == "post" else {}))
        assert response.status_code == 401, path


def test_a_waiting_person_is_not_a_member_and_sees_nothing_of_the_community(world):
    admin, cid, people = world
    ann = people("ann@example.test", "あん")
    admin.post(CAMPING_A, community_id=cid)
    store().set_members_only(True)
    claim(ann, make_invite(admin, cid, approval=True)["code"])
    assert store().community_info(cid, viewer=ann.id) is None
    assert store().community_map_posts(cid, -9999, -9999, 9999, 9999, 100, viewer=ann.id) == []
    assert get(ann, "/api/local/communities/mine").json()["communities"] == []


# --------------------------------------------------------------------------
# the notice to the admins: a name first, and once a day
# --------------------------------------------------------------------------

def sign_in(client, email):
    code = client.post("/api/local/auth/otp", json={"email": email}).json()["code"]
    token = client.post("/api/local/auth/verify", json={"email": email, "code": code}).json()
    return token["user"]["id"], {"Authorization": f"Bearer {token['access_token']}"}


def test_nobody_is_told_until_the_person_has_a_name(world, fresh_client):
    admin, cid, _ = world
    new_id, headers = sign_in(fresh_client, "new@example.test")
    code = make_invite(admin, cid, approval=True)["code"]
    assert fresh_client.post("/api/local/invites/claim", json={"code": code}, headers=headers).json()["status"] == "pending"
    assert admin.inbox(["join_request"]) == [] and waiting(admin, cid) == [], "no name, no row in the list"
    saved = fresh_client.put("/api/account/me", json={"display_name": "しんいり", "icon_id": "1"}, headers=headers)
    assert saved.status_code == 200
    assert len(admin.inbox(["join_request"])) == 1
    assert waiting(admin, cid)[0]["display_name"] == "しんいり"
    # saving the profile again does not tell them again
    fresh_client.put("/api/account/me", json={"bio": "よろしく"}, headers=headers)
    assert len(admin.inbox(["join_request"])) == 1


def test_the_notice_is_thinned_to_once_a_day_for_the_same_person_and_community(world):
    admin, cid, people = world
    ann = people("ann@example.test", "あん")
    code = make_invite(admin, cid, approval=True)["code"]
    claim(ann, code)
    post(ann, "/api/local/join/cancel", {"community_id": cid})
    claim(ann, code)
    assert len(admin.inbox(["join_request"])) == 0, "cancelled and applied again within a day: not told twice"
    assert waiting(admin, cid), "but the application is in the list"
    # a day later it may be told again
    store()._join_notified[(cid, ann.id)] = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat()
    post(ann, "/api/local/join/cancel", {"community_id": cid})
    claim(ann, code)
    assert len(admin.inbox(["join_request"])) == 1


def test_every_admin_is_told_and_the_applicant_never_is(world):
    admin, cid, people = world
    second = people("second@example.test", "ふたりめ")
    claim(second, make_invite(admin, cid)["code"])
    store()._members[(cid, second.id)]["role"] = "admin"
    ann = people("ann@example.test", "あん")
    claim(ann, make_invite(admin, cid, approval=True)["code"])
    assert len(admin.inbox(["join_request"])) == 1 and len(second.inbox(["join_request"])) == 1
    assert ann.inbox(["join_request"]) == []


# --------------------------------------------------------------------------
# the two new kinds of notice
# --------------------------------------------------------------------------

def test_the_two_kinds_are_always_on_whatever_the_settings(world):
    off = notices.merge_settings([{"category": c, "push": False, "in_app": False}
                                  for c in config.NOTIFICATION_CATEGORIES])
    for kind in ("join_request", "join_approved"):
        assert kind in config.ALWAYS_ON_NOTIFICATION_TYPES
        assert notices.allows(off, kind, "push") and notices.allows(off, kind, "in_app")
        assert notices.category_of(kind) == kind
    assert not notices.allows(off, "like", "push")
    assert config.ALWAYS_ON_NOTIFICATION_TYPES == frozenset({"join_request", "join_approved"})


def test_the_feed_marks_them_as_interrupting_and_counts_them_unread(world):
    admin, cid, people = world
    ann = people("ann@example.test", "あん")
    claim(ann, make_invite(admin, cid, approval=True)["code"])
    post(admin, "/api/local/notifications/read", {"ids": []})
    store().put_notification_settings(admin.id, [{"category": c, "push": False, "in_app": False}
                                                 for c in config.NOTIFICATION_CATEGORIES])
    feed = get(admin, "/api/local/notifications/feed").json()
    entry = next(e for e in feed["notifications"] if e["type"] == "join_request")
    assert entry["interrupts"] is True and feed["unread"] >= 1 and entry["category"] == "join_request"


def test_push_words_and_where_they_lead(world):
    admin, cid, people = world
    ann = people("ann@example.test", "あん")
    claim(ann, make_invite(admin, cid, approval=True)["code"])
    entry = next(e for e in notices.group_feed(store().list_notifications(admin.id)) if e["type"] == "join_request")
    message = application.push_message(entry)
    assert message["body"] == "あんさんが『コクヨ』への参加を待っています"
    assert message["url"] == f"/#/community/{cid}"
    decide(admin, cid, ann, True)
    entry = next(e for e in notices.group_feed(store().list_notifications(ann.id)) if e["type"] == "join_approved")
    message = application.push_message(entry)
    assert message["body"] == "『コクヨ』に参加できました" and message["url"] == "/#/notifications"
    assert "あん" not in message["title"] and "かんり" not in repr(message), "it names nobody"


def test_the_waiting_notice_is_pushed_to_the_admin_even_when_settings_are_off(world):
    admin, cid, people = world
    ann = people("ann@example.test", "あん")
    store().put_notification_settings(admin.id, [{"category": c, "push": False, "in_app": False}
                                                 for c in config.NOTIFICATION_CATEGORIES])
    claim(ann, make_invite(admin, cid, approval=True)["code"])
    rows = [row for row in store().claim_pending_pushes() if row["type"] == "join_request"]
    assert len(rows) == 1
    settings = notices.merge_settings(store().notification_settings_for([admin.id]).get(admin.id))
    assert notices.allows(settings, "join_request", "push")
    # it is about this community, so a recipient who is still in it passes pushes_still_readable
    assert application.pushes_still_readable(rows) == rows


# --------------------------------------------------------------------------
# 名前の確認 and /api/config
# --------------------------------------------------------------------------

def test_name_confirmed_needs_a_name_and_an_affiliation_and_the_server_sets_the_time(world):
    admin, cid, people = world
    ann = people("ann@example.test", "あん")
    refused = ann.client.put("/api/account/me", json={"name_confirmed": True}, headers=ann.headers)
    assert refused.status_code == 422 and refused.json()["detail"] == config.NAME_CONFIRM_ERROR
    assert store().get_account(ann.id)["name_confirmed_at"] is None
    saved = ann.client.put("/api/account/me", json={
        "display_name": "山田 花子", "affiliation": "コクヨ", "name_confirmed": True}, headers=ann.headers)
    assert saved.status_code == 200
    account = saved.json()["account"]
    assert account["display_name"] == "山田 花子" and account["name_confirmed_at"]
    assert "name_confirmed" not in account
    first = account["name_confirmed_at"]
    # false / left out changes nothing
    ann.client.put("/api/account/me", json={"name_confirmed": False, "bio": "x"}, headers=ann.headers)
    assert store().get_account(ann.id)["name_confirmed_at"] == first
    assert get(ann, "/api/account/me").json()["account"]["name_confirmed_at"] == first


def test_names_may_be_24_characters(world):
    admin, cid, people = world
    ann = people("ann@example.test", "あん")
    long_name = "あ" * 24
    saved = ann.client.put("/api/account/me", json={"display_name": long_name + "い"}, headers=ann.headers)
    assert saved.json()["account"]["display_name"] == long_name
    assert ann.client.get("/api/config").json()["limits"]["name_max"] == 24 == config.MAX_NAME_LENGTH


def test_config_carries_the_consent_version_and_the_day_the_remove_button_appears(fresh_client, monkeypatch):
    body = fresh_client.get("/api/config").json()
    assert body["consent_version"] == "2026-11-16" == config.CONSENT_VERSION
    assert config.MEMBER_REMOVAL_FROM.isoformat() == "2026-11-16"
    from datetime import date
    monkeypatch.setattr(application, "today_jst", lambda: date(2026, 11, 15))
    body = fresh_client.get("/api/config").json()
    assert body["features"]["member_removal"] is False and body["fullname"] == {"required": False, "from": "2026-11-16"}
    monkeypatch.setattr(application, "today_jst", lambda: date(2026, 11, 16))
    body = fresh_client.get("/api/config").json()
    assert body["features"]["member_removal"] is True and body["fullname"]["required"] is True
    assert {"key": "20s", "label": "20代"} in body["age_bands"] and body["limits"]["job_title_max"] == 32
    assert "notice" not in body, "the お知らせ帯 comes with the other PR"


def test_the_new_account_columns_exist_in_local_mode(world):
    admin, cid, people = world
    row = store().get_account(admin.id)
    assert row["age_band"] is None and row["job_title"] is None and row["name_confirmed_at"] is None
