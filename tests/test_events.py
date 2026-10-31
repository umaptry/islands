"""会（イベント申し込み）2026-11-01 第2回a：手元モード（MemoryStore）で、DB 関数（M3）と同じ筋書きを確かめる。

会を作る（公開は管理者だけ）・申し込み（ゲスト／メンバーの1タップ／定員／期限／外された人）・取り消し→再申し込み・
お断り・遅れる・名簿・集計のぼかし・受付前の回答が地図などに出ない・probe の上限とぼかし・/e/ /c/ の noindex。
ここに出てくる人・会はみんな作り話。
"""

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

import app as application
from core import events
from core.config import EVENT_ERROR_TEXT, EVENT_SHARE_ERROR


def store():
    return application.state["store"]


def iso(days=10, hours=0):
    return (datetime.now(timezone.utc) + timedelta(days=days, hours=hours)).isoformat()


def get(person, path):
    return person.client.get(path, headers=person.headers)


def post(person, path, body=None):
    return person.client.post(path, json=body if body is not None else {}, headers=person.headers)


QUESTIONS = [
    {"prompt": "now", "label": "最近やってること", "hint": "仕事以外で"},
    {"prompt": "future", "label": "やってみたいこと", "hint": ""},
]
ANSWERS = [
    {"prompt": "now", "body": "週末は陶芸教室に通って、ろくろを回しています。"},
    {"prompt": "future", "body": "ゆるく走る仲間がほしいです。朝のランニングをしたいです。"},
]


@pytest.fixture
def world(people):
    admin = people("host@example.test", "かんり")
    cid = store().create_community("夜のBAR", f"bar-{uuid.uuid4().hex[:8]}", admin.id)
    store().upsert_account(admin.id, {"affiliation": "夜の会社"})
    return admin, cid, people


def add_member(person, cid, role="member"):
    store()._members[(cid, person.id)] = {
        "role": role, "joined_at": datetime.now(timezone.utc).isoformat(), "joined_via": "invite",
        "invite_id": None, "event_post_id": None}
    # フルネームの確認が済んでいるメンバー（確認がまだの人は、申し込みで名前と所属を聞く＝DB の event_apply と同じ）
    store().upsert_account(person.id, {"affiliation": "コクヨ", "name_confirmed_at": datetime.now(timezone.utc).isoformat()})


def create_event(admin, cid, *, visibility="community", capacity=5, questions=None, title="The Night Office BAR #2",
                 days=10, expect=200, tags=("参加者募集中",), **event_extra):
    body = {
        "body": "夜の会をひらきます。話してみたい人は来てください。", "tags": list(tags), "community_id": cid,
        "recruit_capacity": capacity,
        "event": {"title": title, "starts_at": iso(days), "ends_at": iso(days, 3), "place": "渋谷 ○○ビル 3F",
                  "visibility": visibility, "questions": QUESTIONS if questions is None else questions,
                  "agree_terms": True, **event_extra},
    }
    response = post(admin, "/api/posts", body)
    assert response.status_code == expect, response.text
    return response.json()


def apply(person, code, *, answers=ANSWERS, profile=None, expect=200, line=False, **extra):
    """line=True なら LINE ログインの人として申し込む（案内の予定ができる）。ふつうはメールの人。"""
    if line:
        with patch.object(events, "channel_and_sub", lambda claims: ("line", f"U-{person.id[:8]}")):
            return apply(person, code, answers=answers, profile=profile, expect=expect, **extra)
    body = {"agree_terms": True, **extra}
    if profile is not False:
        body["profile"] = profile or {"display_name": f"{person.account['display_name']} 太郎", "affiliation": "○○株式会社",
                                      "age_band": "30s", "job_title": "デザイナー"}
    if answers:
        body["answers"] = answers
    response = post(person, f"/api/events/{code}/apply", body)
    assert response.status_code == expect, response.text
    return response.json()


def join_count(post_id):
    return store().get_post(post_id)["join_count"]


# --------------------------------------------------------------------------
# 純粋な関数
# --------------------------------------------------------------------------

def test_bucket_folds_small_groups_into_hoka():
    assert events.bucket({"30代": 5, "20代": 2, "40代": 1}) == [
        {"label": "30代", "count": 5}, {"label": "ほか", "count": 3}]
    assert events.bucket({"30代": 3}) == [{"label": "30代", "count": 3}]
    assert events.bucket({"20代": 2, "30代": 1}) == [{"label": "ほか", "count": 3}]
    assert events.bucket({}) == []
    assert events.bucket({"a": 4, "ほか": 1}) == [{"label": "a", "count": 4}, {"label": "ほか", "count": 1}]


def test_blur_levels():
    assert events.blur(0) == {"level": "none", "count": None}
    assert events.blur(1) == {"level": "few", "count": None}
    assert events.blur(2) == {"level": "few", "count": None}
    assert events.blur(3) == {"level": "many", "count": 3}


def test_checkin_window_and_state():
    start = datetime(2026, 11, 13, 10, tzinfo=timezone.utc)
    end = start + timedelta(hours=3)
    event = {"starts_at": start, "ends_at": end}
    opens, closes = events.checkin_window(start, end)
    assert opens == start - timedelta(hours=3) and closes == end + timedelta(hours=2)
    assert events.window_state(event, start - timedelta(hours=4)) == "early"
    assert events.window_state(event, start - timedelta(hours=3)) == "open"
    assert events.window_state(event, end + timedelta(hours=3)) == "closed"


def test_clean_event_rules():
    now = datetime(2026, 11, 1, tzinfo=timezone.utc)
    ok = {"title": " 会 ", "starts_at": "2026-11-13T10:00:00+00:00", "ends_at": "2026-11-13T12:00:00+00:00",
          "place": "渋谷", "visibility": "community"}
    clean = events.clean_event(ok, now=now)
    assert clean["title"] == "会" and clean["questions"] == []
    for bad, words in [
        ({**ok, "title": ""}, "会の名前"),
        ({**ok, "title": "あ" * 41}, "会の名前"),
        ({**ok, "place": "あ" * 61}, "場所"),
        ({**ok, "ends_at": ok["starts_at"]}, "終了は開始より後"),
        ({**ok, "starts_at": "2026-10-01T00:00:00+00:00", "ends_at": "2026-10-01T01:00:00+00:00"}, "今より後"),
        ({**ok, "visibility": "x"}, "公開の範囲"),
        ({**ok, "visibility": "public"}, "質問を2つ以上"),
        ({**ok, "questions": [{"prompt": "talk", "label": "あ"}]}, "質問の種類"),
        ({**ok, "questions": [{"prompt": "now", "label": "あ"}, {"prompt": "now", "label": "い"}]}, "同じ種類"),
        ({**ok, "questions": [{"prompt": p, "label": "あ"} for p in ("now", "past", "future", "help")]}, "質問は3つ"),
    ]:
        with pytest.raises(ValueError) as error:
            events.clean_event(bad, now=now)
        assert words in str(error.value)
    # 変更：送った項目だけ検める。開始が変わらなければ過去でも場所は直せる
    current = {"starts_at": "2026-10-01T00:00:00+00:00", "ends_at": "2026-10-01T01:00:00+00:00",
               "visibility": "community"}
    assert events.clean_event({"place": "新宿"}, now=now, current=current) == {"place": "新宿"}
    with pytest.raises(ValueError):
        events.clean_event({"ends_at": "2026-09-30T00:00:00+00:00"}, now=now, current=current)


def test_clean_profile():
    assert events.clean_profile({"display_name": "山田 花子", "affiliation": "○○", "age_band": "30s",
                                 "job_title": " デザイナー "}) == {
        "display_name": "山田 花子", "affiliation": "○○", "age_band": "30s", "job_title": "デザイナー"}
    for bad in ({}, {"display_name": "山田"}, {"display_name": "あ" * 25, "affiliation": "x"},
                {"display_name": "山田", "affiliation": "x", "age_band": "99s"}):
        with pytest.raises(ValueError):
            events.clean_profile(bad)
    with pytest.raises(ValueError):
        events.clean_profile({"display_name": "山田", "affiliation": "x"}, need_age=True)


# --------------------------------------------------------------------------
# 会を作る
# --------------------------------------------------------------------------

def test_create_event_returns_links_and_codes(world):
    admin, cid, _ = world
    made = create_event(admin, cid, visibility="public")
    info = made["event"]
    assert len(info["public_code"]) >= 22 and len(info["checkin_code"]) >= 22
    assert info["public_code"] != info["checkin_code"]
    assert info["apply_url"].endswith(f"/e/{info['public_code']}")
    assert info["checkin_url"].endswith(f"/c/{info['checkin_code']}")
    assert store().event_by_post(made["id"])["visibility"] == "public"


def test_public_event_is_for_admins_only_and_the_post_is_taken_back(world):
    admin, cid, people = world
    member = people("m@example.test", "ふつう")
    add_member(member, cid)
    before = len(store().posts_by_author(member.id))
    response = post(member, "/api/posts", {
        "body": "公開の会をひらきます。", "tags": ["参加者募集中"], "community_id": cid, "recruit_capacity": 5,
        "event": {"title": "公開BAR", "starts_at": iso(), "ends_at": iso(10, 2), "place": "",
                  "visibility": "public", "questions": QUESTIONS, "agree_terms": True}})
    assert response.status_code == 403
    assert response.json()["detail"] == EVENT_ERROR_TEXT["public_admin_only"]
    assert len(store().posts_by_author(member.id)) == before       # 投稿は保存されていない
    # メンバーは community の会なら作れる
    assert create_event(member, cid)["event"]["public_code"]


def test_create_event_checks_before_saving(world):
    admin, cid, _ = world
    count = len(store().posts_by_author(admin.id))
    create_event(admin, cid, tags=("仲間募集中",), expect=422)                    # タグが違う
    create_event(admin, cid, capacity=None, expect=422)                          # 定員が無い
    create_event(admin, cid, agree_terms=False, expect=422)                      # 規約に同意していない
    create_event(admin, cid, days=-1, expect=422)                                # 過去
    create_event(admin, cid, visibility="public", questions=[QUESTIONS[0]], expect=422)
    assert len(store().posts_by_author(admin.id)) == count


def test_event_create_failure_takes_the_post_back(world, monkeypatch):
    admin, cid, _ = world
    from core.store import EventRefused
    count = len(store().posts_by_author(admin.id))

    def boom(**_):
        raise EventRefused("この会は見つかりません。", 404, "event_not_found")

    monkeypatch.setattr(store(), "event_create", boom)
    response = post(admin, "/api/posts", {
        "body": "会をひらきます。", "tags": ["参加者募集中"], "community_id": cid, "recruit_capacity": 5,
        "event": {"title": "BAR", "starts_at": iso(), "ends_at": iso(10, 2), "place": "", "visibility": "community",
                  "questions": [], "agree_terms": True}})
    assert response.status_code == 404
    assert len(store().posts_by_author(admin.id)) == count


# --------------------------------------------------------------------------
# 申し込み
# --------------------------------------------------------------------------

def test_guest_applies_with_answers(world):
    admin, cid, people = world
    made = create_event(admin, cid, visibility="public")
    code = made["event"]["public_code"]
    guest = people("g1@example.test", "ゲスト")
    result = apply(guest, code)
    assert result["status"] == "applied" and result["is_member"] is False
    assert result["me_path"] == f"#/e/{code}/me" and result["remaining"] == 4
    assert join_count(made["id"]) == 1
    state = get(guest, f"/api/events/{code}").json()
    assert state["me"]["status"] == "applied" and state["is_host"] is False and state["checkin_code"] is None
    assert state["event"]["applied_count"] == 1 and state["event"]["host"]["display_name"] == "かんり"
    reg = store().event_registration(made["id"], guest.id)
    assert reg["was_guest"] and reg["channel"] == "email" and reg["consent_version"] == "2026-11-16"
    assert store().get_account(guest.id)["name_confirmed_at"]
    assert len(store().event_answer_vectors(made["id"])) == 2
    # 主催者にはふつうの join の知らせが行く
    assert len(admin.unread(["join"])) == 1
    # 二度押しても同じ
    again = apply(guest, code)
    assert again["status"] == "already" and join_count(made["id"]) == 1
    # 主催者は自分の会の情報を、受付 QR つきで読める
    host_view = get(admin, f"/api/events/{code}").json()
    assert host_view["is_host"] and host_view["checkin_code"] == made["event"]["checkin_code"]


def test_apply_needs_terms_name_and_two_answers(world):
    admin, cid, people = world
    code = create_event(admin, cid, visibility="public")["event"]["public_code"]
    guest = people("g2@example.test", "ゲスト")
    r = post(guest, f"/api/events/{code}/apply", {"profile": {"display_name": "山田 花子", "affiliation": "○○"},
                                                  "answers": ANSWERS})
    assert r.status_code == 422 and r.json()["detail"] == EVENT_ERROR_TEXT["terms_required"]
    r = post(guest, f"/api/events/{code}/apply", {"agree_terms": True, "answers": ANSWERS})
    assert r.status_code == 422 and r.json()["detail"] == EVENT_ERROR_TEXT["name_required"]
    r = post(guest, f"/api/events/{code}/apply", {
        "agree_terms": True, "profile": {"display_name": "山田 花子", "affiliation": "○○"}, "answers": ANSWERS[:1]})
    assert r.status_code == 422 and r.json()["detail"] == EVENT_ERROR_TEXT["answers_required"]
    # 質問に無い種類の答えは数えない
    r = post(guest, f"/api/events/{code}/apply", {
        "agree_terms": True, "profile": {"display_name": "山田 花子", "affiliation": "○○"},
        "answers": [ANSWERS[0], {"prompt": "past", "body": "昔はサッカーをしていました。"}]})
    assert r.status_code == 422
    assert store().event_registration(store().event_by_code(code)["post_id"], guest.id) is None
    assert apply(guest, code, profile={"display_name": "山田 花子", "affiliation": "○○"})["status"] == "applied"


def test_member_applies_with_one_tap(world):
    admin, cid, people = world
    made = create_event(admin, cid, visibility="community")
    code = made["event"]["public_code"]
    member = people("m2@example.test", "メンバー")
    add_member(member, cid)
    result = apply(member, code, answers=None, profile=False)
    assert result["status"] == "applied" and result["is_member"] is True
    reg = store().event_registration(made["id"], member.id)
    assert reg["was_guest"] is False and not store().event_answer_vectors(made["id"])
    # 申し込み画面を通らないと join は押せない（反応のボタンからは）
    other = people("m3@example.test", "メンバー2")
    add_member(other, cid)
    pressed = other.react(made["id"], "join")
    assert pressed.status_code == 403 and pressed.json()["detail"] == EVENT_ERROR_TEXT["event_use_apply"]
    assert other.unreact(made["id"], "join").status_code == 403


def test_community_only_event_refuses_guests(world):
    admin, cid, people = world
    code = create_event(admin, cid, visibility="community")["event"]["public_code"]
    guest = people("g3@example.test", "ゲスト")
    response = post(guest, f"/api/events/{code}/apply", {
        "agree_terms": True, "profile": {"display_name": "山田 花子", "affiliation": "○○"}, "answers": ANSWERS})
    assert response.status_code == 403 and response.json()["detail"] == EVENT_ERROR_TEXT["event_members_only"]


def test_capacity_and_deadline(world):
    admin, cid, people = world
    made = create_event(admin, cid, visibility="public", capacity=2)
    code = made["event"]["public_code"]
    first, second, third = (people(f"c{i}@example.test", f"ゲスト{i}") for i in range(3))
    apply(first, code)
    apply(second, code)
    r = apply(third, code, expect=409)
    assert r["detail"] == EVENT_ERROR_TEXT["recruit_full"]
    assert join_count(made["id"]) == 2
    assert store().event_registration(made["id"], third.id) is None            # 全部なし（アカウントも作らない）
    # 取り消すと空きができる
    assert post(first, f"/api/events/{code}/cancel").status_code == 200
    assert apply(third, code)["status"] == "applied"
    # 期限
    store()._posts[made["id"]]["recruit_deadline"] = "2000-01-01"
    late = people("c9@example.test", "おくれ")
    assert apply(late, code, expect=409)["detail"] == EVENT_ERROR_TEXT["recruit_closed"]


def test_cancel_then_apply_again_reuses_the_row(world):
    admin, cid, people = world
    made = create_event(admin, cid, visibility="public")
    code = made["event"]["public_code"]
    guest = people("g4@example.test", "ゲスト")
    apply(guest, code)
    assert post(guest, f"/api/events/{code}/cancel").json() == {"status": "cancelled"}
    assert join_count(made["id"]) == 0
    assert [row["kind"] for row in store()._outbound.values() if row["sent_at"] is None] == []   # 未送信の予約は消えた
    assert len(admin.unread(["event_cancel"])) == 1
    assert store().event_registration(made["id"], guest.id)["status"] == "cancelled"
    assert apply(guest, code)["status"] == "applied"
    assert join_count(made["id"]) == 1
    assert store().event_registration(made["id"], guest.id)["cancelled_at"] is None
    # もう一度取り消せる／申し込んでいない人は 409
    other = people("g5@example.test", "ほか")
    r = post(other, f"/api/events/{code}/cancel")
    assert r.status_code == 409 and r.json()["detail"] == EVENT_ERROR_TEXT["event_not_applied"]
    # 受付のあとは取り消せない
    store()._event_regs[(made["id"], guest.id)]["status"] = "attended"
    r = post(guest, f"/api/events/{code}/cancel")
    assert r.status_code == 409 and r.json()["detail"] == EVENT_ERROR_TEXT["event_attended"]


def test_declined_removed_and_rejected_people_cannot_apply(world):
    admin, cid, people = world
    made = create_event(admin, cid, visibility="public")
    code = made["event"]["public_code"]
    guest = people("g6@example.test", "ゲスト")
    apply(guest, code, line=True)
    # 主催者だけが断れる
    r = post(guest, f"/api/events/{code}/registrations/{guest.id}/decline")
    assert r.status_code == 403 and r.json()["detail"] == EVENT_ERROR_TEXT["event_not_host"]
    assert post(admin, f"/api/events/{code}/registrations/{guest.id}/decline").json() == {"status": "declined"}
    assert join_count(made["id"]) == 0
    sent = [row for row in store()._outbound.values() if row["kind"] == "declined"]
    assert len(sent) == 1 and sent[0]["account_id"] == guest.id
    r = post(guest, f"/api/events/{code}/apply", {"agree_terms": True, "answers": ANSWERS,
                                                  "profile": {"display_name": "山田 花子", "affiliation": "○○"}})
    assert r.status_code == 403 and r.json()["detail"] == EVENT_ERROR_TEXT["event_banned"]
    # 前に外された人
    removed = people("g7@example.test", "はずされ")
    store()._removals[(cid, removed.id)] = {"removed_at": datetime.now(timezone.utc).isoformat()}
    assert apply(removed, code, expect=403)["detail"] == EVENT_ERROR_TEXT["event_banned"]
    # 前に断られた人
    refused = people("g8@example.test", "ことわられ")
    store()._join_requests[(cid, refused.id)] = {"status": "rejected"}
    assert apply(refused, code, expect=403)["detail"] == EVENT_ERROR_TEXT["event_banned"]
    # 断る相手がいない／受付済みは断れない
    r = post(admin, f"/api/events/{code}/registrations/{uuid.uuid4()}/decline")
    assert r.status_code == 409
    other = people("g9@example.test", "うけつけ")
    apply(other, code)
    store()._event_regs[(made["id"], other.id)]["status"] = "attended"
    r = post(admin, f"/api/events/{code}/registrations/{other.id}/decline")
    assert r.status_code == 409 and r.json()["detail"] == EVENT_ERROR_TEXT["event_attended"]


def test_late_notice(world):
    admin, cid, people = world
    made = create_event(admin, cid, visibility="public")
    code = made["event"]["public_code"]
    guest = people("g10@example.test", "ゲスト")
    r = post(guest, f"/api/events/{code}/late", {"minutes": 10})
    assert r.status_code == 409                                                   # 申し込んでいない
    apply(guest, code)
    assert post(guest, f"/api/events/{code}/late", {"minutes": 15}).status_code == 422
    assert post(guest, f"/api/events/{code}/late", {"minutes": 10}).json() == {"late_minutes": 10}
    assert post(guest, f"/api/events/{code}/late", {"minutes": 30}).json() == {"late_minutes": 30}
    late = admin.unread(["event_late"])
    assert len(late) == 1 and late[0]["payload"] == {"minutes": 30}               # 古い未読は消える
    assert get(guest, f"/api/events/{code}").json()["me"]["late_minutes"] == 30


def test_roster_is_for_the_host_and_admins(world):
    admin, cid, people = world
    member_host = people("mh@example.test", "しゅさい")
    add_member(member_host, cid)
    made = create_event(member_host, cid, visibility="community")
    code = made["event"]["public_code"]
    guest_member = people("gm@example.test", "メンバー")
    add_member(guest_member, cid)
    apply(guest_member, code, answers=None, profile=False, referral="友だちに聞いた")
    data = get(member_host, f"/api/events/{code}/roster").json()
    assert data["counts"]["applied"] == 1 and data["counts"]["capacity"] == 5
    person = data["people"][0]
    assert person["referral"] == "友だちに聞いた" and person["joined_via"] == "invite" and person["channel"] == "email"
    assert data["waiting"] == [] and data["line_quota"] is None
    assert get(admin, f"/api/events/{code}/roster").status_code == 200               # コミュニティの管理者
    assert get(guest_member, f"/api/events/{code}/roster").status_code == 403


def test_update_event_notifies_and_reschedules(world):
    admin, cid, people = world
    made = create_event(admin, cid, visibility="public")
    code = made["event"]["public_code"]
    guest = people("g11@example.test", "ゲスト")
    apply(guest, code, line=True)
    mail = people("g11b@example.test", "メールの人")
    apply(mail, code)                                   # メールの人には案内の予定を作らない（E の 14）
    kinds = sorted(row["kind"] for row in store()._outbound.values())
    assert kinds == ["after", "day_of", "week_before"]
    assert {row["account_id"] for row in store()._outbound.values()} == {guest.id}
    r = post(guest, f"/api/events/{code}/cancel")      # 取り消しで予約は消える
    apply(guest, code, line=True)
    other = people("g12@example.test", "ゲスト2")
    assert other.client.patch(f"/api/events/{code}", json={"place": "新宿"}, headers=other.headers).status_code == 403
    changed = admin.client.patch(f"/api/events/{code}", json={"place": "新宿 △△ビル", "title": "BAR #3"},
                                 headers=admin.headers)
    assert changed.status_code == 200 and changed.json()["notified"] == 1
    assert store().event_by_code(code)["place"] == "新宿 △△ビル"
    assert any(row["kind"] == "event_changed" and row["account_id"] == guest.id for row in store()._outbound.values())
    only_title = admin.client.patch(f"/api/events/{code}", json={"title": "BAR #4"}, headers=admin.headers)
    assert only_title.json()["notified"] == 0
    bad = admin.client.patch(f"/api/events/{code}", json={"ends_at": iso(-3)}, headers=admin.headers)
    assert bad.status_code == 422
    # 日時を動かすと予約が作り直される
    new_start = datetime.now(timezone.utc) + timedelta(days=20)
    moved = admin.client.patch(f"/api/events/{code}", json={
        "starts_at": new_start.isoformat(), "ends_at": (new_start + timedelta(hours=2)).isoformat()},
        headers=admin.headers)
    assert moved.status_code == 200 and moved.json()["notified"] == 1
    week = next(row for row in store()._outbound.values() if row["kind"] == "week_before")
    assert abs(datetime.fromisoformat(week["scheduled_at"]) - (new_start - timedelta(days=7))).total_seconds() < 1


def test_capacity_edit_and_sharing_of_an_event_post(world):
    admin, cid, people = world
    made = create_event(admin, cid, visibility="public", capacity=3)
    code = made["event"]["public_code"]
    for i in range(2):
        apply(people(f"cap{i}@example.test", f"ゲスト{i}"), code)
    r = admin.client.patch(f"/api/posts/{made['id']}", json={"recruit_capacity": 1}, headers=admin.headers)
    assert r.status_code == 422 and r.json()["detail"] == EVENT_ERROR_TEXT["capacity_below_joins"]
    r = admin.client.patch(f"/api/posts/{made['id']}", json={"recruit_capacity": None}, headers=admin.headers)
    assert r.status_code == 422
    r = admin.client.patch(f"/api/posts/{made['id']}", json={"recruit_capacity": 2}, headers=admin.headers)
    assert r.status_code == 200
    # ほかのコミュニティには出せない
    store().set_members_only(True)
    other = store().create_community("もう1つ", f"o-{uuid.uuid4().hex[:6]}", admin.id)
    shared = post(admin, f"/api/posts/{made['id']}/share", {"community_ids": [other]})
    assert shared.status_code == 409 and shared.json()["detail"] == EVENT_SHARE_ERROR


def test_deleting_the_post_calls_the_event_off(world):
    admin, cid, people = world
    made = create_event(admin, cid, visibility="public")
    code = made["event"]["public_code"]
    guest = people("g13@example.test", "ゲスト")
    apply(guest, code, line=True)
    member = people("m4@example.test", "メンバー")
    add_member(member, cid)
    # ゲストが LINE の友だちなら、中止の LINE が予約される
    store().line_link_save(guest.id, "U-guest-1", True)
    pending = apply(member, code, answers=None, profile=False)
    assert pending["status"] == "applied"
    assert admin.client.delete(f"/api/posts/{made['id']}", headers=admin.headers).status_code == 200
    assert store().event_by_code(code)["cancelled_at"]
    kinds = {(row["account_id"], row["kind"]) for row in store()._outbound.values()}
    # 週前などの未送信は消えた。中止の LINE は LINE で申し込んだ人だけ（メールのメンバーにはアプリの中の通知）
    assert kinds == {(guest.id, "event_cancelled")}
    # メンバーにはアプリの中の通知
    notices = member.unread(["event_cancelled"])
    assert len(notices) == 1 and notices[0]["payload"]["title"] == "The Night Office BAR #2"
    assert guest.unread(["event_cancelled"]) == []
    # ゲスト用ページは 200 で closed=cancelled、中身は出さない。新しい申し込みは 409
    public = get(guest, f"/api/public/events/{code}").json()
    assert public["closed"] == "cancelled" and public["applied_count"] == 0 and public["host_name"] == ""
    late = people("g14@example.test", "おそい")
    assert apply(late, code, expect=409)["detail"] == EVENT_ERROR_TEXT["event_cancelled"]


def test_mine_and_by_post(world):
    admin, cid, people = world
    made = create_event(admin, cid, visibility="public")
    code = made["event"]["public_code"]
    guest = people("g15@example.test", "ゲスト")
    assert get(guest, "/api/events/mine").json() == {"events": []}
    apply(guest, code)
    mine = get(guest, "/api/events/mine").json()["events"]
    assert len(mine) == 1 and mine[0]["code"] == code and mine[0]["status"] == "applied"
    post(guest, f"/api/events/{code}/cancel")
    assert get(guest, "/api/events/mine").json() == {"events": []}
    member = people("m5@example.test", "メンバー")
    add_member(member, cid)
    assert get(member, f"/api/events/by-post/{made['id']}").json()["event"]["code"] == code
    assert get(guest, f"/api/events/by-post/{made['id']}").status_code == 404        # メンバーではない
    assert get(guest, f"/api/events/{uuid.uuid4().hex}").status_code == 404
    assert get(admin, "/api/events/mine").json() == {"events": []}


# --------------------------------------------------------------------------
# ゲスト用ページの集計（ぼかし）
# --------------------------------------------------------------------------

def test_public_summary_blurs_small_groups_and_hides_people(world):
    admin, cid, people = world
    made = create_event(admin, cid, visibility="public", capacity=20)
    code = made["event"]["public_code"]
    specs = [("30s", "デザイナー")] * 3 + [("20s", "エンジニア")] * 2
    for i, (age, job) in enumerate(specs):
        guest = people(f"s{i}@example.test", f"ゲスト{i}")
        apply(guest, code, profile={"display_name": f"秘密の名前{i}", "affiliation": "秘密株式会社",
                                    "age_band": age, "job_title": job},
              answers=[{"prompt": "now", "body": f"誰にも言えない趣味の話{i}で、毎晩ひとりで盛り上がっています。"}, ANSWERS[1]])
    client = admin.client
    response = client.get(f"/api/public/events/{code}")                # ログインなし
    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=60"
    assert response.headers["x-robots-tag"] == "noindex"
    body = response.json()
    assert body["applied_count"] == 5 and body["capacity"] == 20 and body["closed"] is None
    assert body["host_name"] == "かんり" and body["community_name"] == "夜のBAR"
    assert body["breakdown"]["age"] == [{"label": "30代", "count": 3}, {"label": "ほか", "count": 2}]
    assert body["breakdown"]["job"] == [{"label": "デザイナー", "count": 3}, {"label": "ほか", "count": 2}]
    labels = [row["label"] for row in body["breakdown"]["genre"]]
    assert all(row["count"] >= 3 or row["label"] == "ほか" for row in body["breakdown"]["genre"])
    assert sum(row["count"] for row in body["breakdown"]["genre"]) == 5 and labels
    text = response.text
    for secret in ("秘密の名前", "秘密株式会社", "誰にも言えない", "ゲスト0", "陶芸"):
        assert secret not in text
    assert client.get("/api/public/events/nothing").status_code == 404


def test_public_summary_is_cached_for_a_minute_but_follows_writes(world):
    admin, cid, people = world
    code = create_event(admin, cid, visibility="public")["event"]["public_code"]
    assert admin.client.get(f"/api/public/events/{code}").json()["applied_count"] == 0
    apply(people("k1@example.test", "ゲスト"), code)
    assert admin.client.get(f"/api/public/events/{code}").json()["applied_count"] == 1     # 書き込みで入れ替わる


# --------------------------------------------------------------------------
# 受付前の回答は、地図・近い投稿・住人の顔に出ない
# --------------------------------------------------------------------------

def test_answers_before_checkin_stay_off_the_map(world):
    admin, cid, people = world
    made = create_event(admin, cid, visibility="public")
    code = made["event"]["public_code"]
    guest = people("hidden@example.test", "ひみつ")
    unique = "古い切手を集めて、台紙に貼るのが静かな楽しみです。"
    apply(guest, code, profile={"display_name": "隠れ 切手", "affiliation": "○○"},
          answers=[{"prompt": "now", "body": unique}, ANSWERS[1]])
    member = people("view@example.test", "みる")
    add_member(member, cid)
    seen = []
    seen.append(get(member, f"/api/local/communities/{cid}/map").text)
    seen.append(get(member, "/api/local/map").text)
    seen.append(get(member, "/api/local/cells").text)
    seen.append(get(member, f"/api/islands?community={cid}").text)
    seen.append(get(member, f"/api/neighbors?post={made['id']}&community={cid}").text)
    seen.append(get(member, f"/api/connections?community={cid}").text)
    seen.append(get(member, f"/api/matches?post={made['id']}").text)
    seen.append(get(member, f"/api/local/posts?author={guest.id}").text)
    for text in seen:
        assert "切手" not in text and "隠れ" not in text
    assert all(row["author_id"] != guest.id for row in store()._posts.values())
    assert store().count_posts(community=cid) == 1                       # 主催者の会の投稿だけ


# --------------------------------------------------------------------------
# probe
# --------------------------------------------------------------------------

def _plant(made, count, vector):
    """vector に近い回答を持つ申し込みを、store に直接 count 件入れる（Gemini を使わずに試す）。"""
    for i in range(count):
        account = str(uuid.uuid4())
        store().event_apply(
            event=made["id"], account=account, profile={"display_name": f"人{i} 名前", "affiliation": "x"},
            channel="email", referral=None, consent="2026-11-16", answers=[
                {"prompt": "now", "body": "あ", "x": 1.0, "y": 1.0, "cluster_id": 0, "terms": [], "vec": vector,
                 "vec_c": vector},
                {"prompt": "future", "body": "い", "x": 1.0, "y": 1.0, "cluster_id": 0, "terms": [], "vec": vector,
                 "vec_c": vector}])


@pytest.mark.parametrize("planted,level,count", [(0, "none", None), (1, "few", None), (2, "few", None), (3, "many", 3),
                                                  (7, "many", 7)])
def test_probe_blurs_the_count(world, monkeypatch, planted, level, count):
    admin, cid, people = world
    made = create_event(admin, cid, visibility="public", capacity=50)
    code = made["event"]["public_code"]
    vector = [1.0] + [0.0] * 447
    _plant(made, planted, vector)
    monkeypatch.setattr(application, "project", lambda text: (0.0, 0.0, 0, [], vector, vector))
    response = admin.client.post(f"/api/public/events/{code}/probe", json={"interests": ["キャンプ", "写真"]})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["level"] == level and body["count"] == count
    assert set(body) == {"level", "count", "genres"}
    assert response.headers["x-robots-tag"] == "noindex"


def test_probe_far_answers_are_not_counted_and_input_is_checked(world, monkeypatch):
    admin, cid, people = world
    made = create_event(admin, cid, visibility="public", capacity=50)
    code = made["event"]["public_code"]
    _plant(made, 4, [0.0, 1.0] + [0.0] * 446)
    monkeypatch.setattr(application, "project",
                        lambda text: (0.0, 0.0, 0, [], [1.0] + [0.0] * 447, [1.0] + [0.0] * 447))
    assert admin.client.post(f"/api/public/events/{code}/probe", json={"interests": ["山登り"]}).json()["level"] == "none"
    for bad in ([], ["a", "b", "c"], ["あ" * 31], [""], [5]):
        r = admin.client.post(f"/api/public/events/{code}/probe", json={"interests": bad})
        assert r.status_code == 422 and "興味は1〜2個、30字まで" in r.json()["detail"]
    assert admin.client.post("/api/public/events/zzz/probe", json={"interests": ["あ"]}).status_code == 404


def test_probe_daily_limit_per_device(world, monkeypatch):
    admin, cid, people = world
    code = create_event(admin, cid, visibility="public")["event"]["public_code"]
    monkeypatch.setattr(application, "project",
                        lambda text: (0.0, 0.0, 0, [], [1.0] + [0.0] * 447, [1.0] + [0.0] * 447))
    results = [admin.client.post(f"/api/public/events/{code}/probe", json={"interests": ["写真"]}) for _ in range(6)]
    assert [r.status_code for r in results] == [200] * 5 + [429]
    assert results[-1].json()["detail"] == EVENT_ERROR_TEXT["probe_limit"]
    # cookie が違っても、同じ IP なら同じ（ここではテストクライアントが同じ IP）
    admin.client.cookies.clear()
    assert admin.client.post(f"/api/public/events/{code}/probe", json={"interests": ["写真"]}).status_code == 429


def test_probe_limits_per_event_and_resets_next_day(world):
    admin, cid, _ = world
    made = create_event(admin, cid, visibility="public")
    now = datetime(2026, 11, 20, 3, 0, tzinfo=timezone.utc)
    for i in range(300):
        assert store().event_probe_hit(event=made["id"], device=f"d{i}", ip=f"i{i}", now=now)["ok"]
    assert store().event_probe_hit(event=made["id"], device="dx", ip="ix", now=now) == {"ok": False, "remaining": 0}
    next_day = now + timedelta(days=1)
    assert store().event_probe_hit(event=made["id"], device="dx", ip="ix", now=next_day)["ok"]
    # 同じ IP から cookie を変えても5回まで
    for i in range(5):
        assert store().event_probe_hit(event=made["id"], device=f"e{i}", ip="same", now=next_day)["ok"]
    assert not store().event_probe_hit(event=made["id"], device="e9", ip="same", now=next_day)["ok"]


# --------------------------------------------------------------------------
# /e/ と /c/、設定
# --------------------------------------------------------------------------

def test_pages_are_noindex_with_og_tags(world):
    admin, cid, _ = world
    made = create_event(admin, cid, visibility="public", title='夜の"BAR" <b>')
    event = made["event"]
    for path in (f"/e/{event['public_code']}", f"/c/{event['checkin_code']}", "/e/unknown-code", "/c/unknown-code"):
        response = admin.client.get(path)
        assert response.status_code == 200, path
        assert response.headers["x-robots-tag"] == "noindex" and response.headers["cache-control"] == "no-cache"
        assert '<meta name="robots" content="noindex">' in response.text
        assert "<html" in response.text.lower()
    page = admin.client.get(f"/e/{event['public_code']}").text
    assert 'og:title" content="夜の&quot;BAR&quot; &lt;b&gt;"' in page and "渋谷" in page
    assert 'og:title" content="islands"' in admin.client.get(f"/c/{event['checkin_code']}").text   # 受付の画面に会の名前は出さない


def test_config_exposes_events(world):
    admin, _, _ = world
    config = admin.client.get("/api/config").json()
    assert config["features"]["events"] is True and config["features"]["probe"] is True
    assert config["features"]["line_messaging"] is False
    assert config["limits"]["event_title_max"] == 40 and config["limits"]["event_questions_max"] == 3
    assert config["limits"]["late_choices"] == [10, 30, 60] and config["limits"]["name_max"] == 24
    assert config["line"] == {"add_friend_url": None}
    assert config["referral_choices"]


def test_events_can_be_switched_off(world, monkeypatch):
    admin, cid, _ = world
    code = create_event(admin, cid, visibility="public")["event"]["public_code"]
    monkeypatch.setenv("ISLANDS_EVENTS", "0")
    assert admin.client.get("/api/config").json()["features"]["events"] is False
    assert admin.client.get(f"/api/public/events/{code}").status_code == 404
    assert get(admin, f"/api/events/{code}").status_code == 404


def test_map_runtime_guard_leaves_public_jobs_and_line_alone(monkeypatch):
    """地図の更新中でも /api/public/・/api/jobs/・/api/line/ は止めない（遅れ連絡・LINE を取りこぼさない）。"""
    from fastapi.testclient import TestClient
    monkeypatch.setattr(application, "runtime_status", lambda: {"maintenance": True, "active_version": "other"})
    with TestClient(application.app) as client:
        monkeypatch.setattr(application, "runtime_status", lambda: {"maintenance": True, "active_version": "other"})
        assert client.get("/api/events/mine").status_code == 503
        assert client.get("/api/public/events/zzz").status_code == 404
        assert client.post("/api/jobs/tick").status_code in (401, 404)


# --------------------------------------------------------------------------
# DB の event_apply・event_cancel_registration などと同じ動き（pgTAP 24_events.sql と見比べる）
# --------------------------------------------------------------------------

def test_member_who_has_not_confirmed_the_full_name_must_give_it(world):
    admin, cid, people = world
    code = create_event(admin, cid, visibility="community")["event"]["public_code"]
    member = people("m6@example.test", "メンバー")
    add_member(member, cid)
    store().upsert_account(member.id, {"name_confirmed_at": None})          # フルネームの確認がまだ
    assert apply(member, code, answers=None, profile=False, expect=422)["detail"] == EVENT_ERROR_TEXT["name_required"]
    done = apply(member, code, answers=None, profile={"display_name": "山田 花子", "affiliation": "コクヨ"})
    assert done["status"] == "applied"
    account = store().get_account(member.id)
    assert account["display_name"] == "山田 花子" and account["name_confirmed_at"]


def test_only_line_applications_get_reminders(world):
    admin, cid, people = world
    code = create_event(admin, cid, visibility="public")["event"]["public_code"]
    mail, via_line = people("e1@example.test", "メール"), people("e2@example.test", "ライン")
    apply(mail, code)
    assert store()._outbound == {}
    apply(via_line, code, line=True)
    assert sorted(row["kind"] for row in store()._outbound.values()) == ["after", "day_of", "week_before"]


def test_event_with_one_question_needs_one_answer(world):
    admin, cid, people = world
    made = create_event(admin, cid, visibility="public")
    code = made["event"]["public_code"]
    store()._events[made["id"]]["questions"] = QUESTIONS[:1]          # 作るときは公開の会に2問以上いる。ここで1問にして確かめる
    guest = people("e3@example.test", "ゲスト")
    assert apply(guest, code, answers=ANSWERS[:1])["status"] == "applied"
    store()._events[made["id"]]["questions"] = []
    assert apply(people("e4@example.test", "ゲスト"), code, answers=None)["status"] == "applied"


def test_waiting_cancel_keeps_the_row_as_cancelled(world):
    """DB の event_cancel_registration：受付待ちの本人の取り下げも cancelled にして行を残す（通知は出さない）。"""
    admin, cid, people = world
    made = create_event(admin, cid, visibility="public")
    guest = people("e5@example.test", "ゲスト")
    store().upsert_account(guest.id, {"affiliation": "x", "name_confirmed_at": datetime.now(timezone.utc).isoformat()})
    store()._event_regs[(made["id"], guest.id)] = {
        "event_id": made["id"], "account_id": guest.id, "status": "waiting", "consent_version": None,
        "was_guest": True, "created_account": False, "channel": "walkin", "referral": None, "late_minutes": None,
        "late_at": None, "applied_at": datetime.now(timezone.utc).isoformat(), "checked_in_at": None,
        "cancelled_at": None, "declined_at": None, "declined_by": None, "walkin_rejects": 2}
    r = post(guest, f"/api/events/{made['event']['public_code']}/cancel")
    assert r.status_code == 200 and r.json() == {"status": "cancelled"}
    row = store()._event_regs[(made["id"], guest.id)]
    assert row["status"] == "cancelled" and row["walkin_rejects"] == 2 and row["cancelled_at"]
    assert admin.unread(["event_cancel"]) == []


def test_declining_twice_sends_one_notice(world):
    admin, cid, people = world
    made = create_event(admin, cid, visibility="public")
    code = made["event"]["public_code"]
    guest, mail = people("e6@example.test", "ゲスト"), people("e7@example.test", "メール")
    apply(guest, code, line=True)
    apply(mail, code)
    for person in (guest, mail, guest):
        post(admin, f"/api/events/{code}/registrations/{person.id}/decline")
    assert [(row["account_id"], row["kind"]) for row in store()._outbound.values()] == [(guest.id, "declined")]
