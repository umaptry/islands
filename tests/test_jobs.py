"""予約送信と片付け（2026-11-01 第2回a）：POST /api/jobs/tick、送る時刻、片付けの保存期間。

LINE は送らない：手元の代役（MemoryStore の _sent_messages）か、テストが渡す送信関数で確かめる。
ここに出てくる人・会はみんな作り話。
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest

import app as application
from core import jobs
from test_events import ANSWERS, add_member, apply, create_event, store


@pytest.fixture
def world(people):
    admin = people("host@example.test", "かんり")
    cid = store().create_community("夜のBAR", f"bar-{uuid.uuid4().hex[:8]}", admin.id)
    store().upsert_account(admin.id, {"affiliation": "夜の会社"})
    return admin, cid, people


class Result(str):
    """core.line.PushResult と同じ形：文字列として比べられ、.reason に理由。"""

    def __new__(cls, value, reason=None):
        obj = super().__new__(cls, value)
        obj.reason = reason
        return obj


def start_of(code):
    event = store().event_by_code(code)
    return datetime.fromisoformat(event["starts_at"]), datetime.fromisoformat(event["ends_at"])


def friend(person, line_user_id=None):
    store().line_link_save(person.id, line_user_id or f"U-{person.id[:8]}", True)


def outbound(code, kind=None):
    post_id = store().event_by_code(code)["post_id"]
    return [row for row in store()._outbound.values()
            if row["event_id"] == post_id and (kind is None or row["kind"] == kind)]


# --------------------------------------------------------------------------
# 秘密
# --------------------------------------------------------------------------

def test_verify_secret():
    assert jobs.verify_secret("s3cret", "s3cret")
    assert not jobs.verify_secret("s3cret", "other")
    assert not jobs.verify_secret(None, "s3cret")
    assert not jobs.verify_secret("", "s3cret")
    assert not jobs.verify_secret("s3cret", "")
    assert not jobs.verify_secret("s3cret", None)
    assert jobs.verify_secret("ひみつ", "ひみつ") and not jobs.verify_secret("ひみつ", "ひみづ")


def test_tick_needs_the_secret(fresh_client, monkeypatch):
    monkeypatch.delenv("ISLANDS_JOBS_SECRET", raising=False)
    assert fresh_client.post("/api/jobs/tick", headers={"X-Jobs-Secret": "x"}).status_code == 404    # 秘密が未設定
    monkeypatch.setenv("ISLANDS_JOBS_SECRET", "s3cret")
    missing = fresh_client.post("/api/jobs/tick")
    assert missing.status_code == 401 and missing.json()["detail"] == "認証に失敗しました。"
    assert fresh_client.post("/api/jobs/tick", headers={"X-Jobs-Secret": "wrong"}).status_code == 401
    ok = fresh_client.post("/api/jobs/tick", json={}, headers={"X-Jobs-Secret": "s3cret"})
    assert ok.status_code == 200
    body = ok.json()
    assert (body["sent"], body["failed"], body["skipped"]) == (0, 0, 0)
    assert body["cleaned"]["account_ids"] == []


# --------------------------------------------------------------------------
# 送る時刻
# --------------------------------------------------------------------------

def test_schedule_times():
    start = datetime(2026, 11, 13, 10, tzinfo=timezone.utc)
    event = {"starts_at": start.isoformat(), "ends_at": (start + timedelta(hours=3)).isoformat()}
    full = jobs.schedule_times(event, start - timedelta(days=10))
    assert full == {"week_before": start - timedelta(days=7), "day_of": start - timedelta(hours=3),
                    "after": start + timedelta(hours=3)}
    # 1週間前より後の申し込みには、1週間前を送らない（境目の同じ時刻も入れない）
    assert set(jobs.schedule_times(event, start - timedelta(days=5))) == {"day_of", "after"}
    assert set(jobs.schedule_times(event, start - timedelta(days=7))) == {"day_of", "after"}
    assert set(jobs.schedule_times(event, start - timedelta(hours=2))) == {"after"}
    assert jobs.schedule_times(event, start + timedelta(hours=4)) == {}


def test_apply_makes_the_same_reminders_as_schedule_times(world):
    admin, cid, people = world
    code = create_event(admin, cid, visibility="community")["event"]["public_code"]
    member = people("m@example.test", "メンバー")
    add_member(member, cid)
    event = store().event_by_code(code)
    start, _ = start_of(code)
    for days_before in (10, 5, 0.05):
        account = people(f"x{days_before}@example.test", f"メンバー{days_before}")
        add_member(account, cid)
        now = start - timedelta(days=days_before)
        store().event_apply(event=event["post_id"], account=account.id, now=now)
        made = {row["kind"]: datetime.fromisoformat(row["scheduled_at"])
                for row in store()._outbound.values() if row["account_id"] == account.id}
        assert made == jobs.schedule_times(event, now)


def test_tick_sends_each_message_once_at_its_time(world):
    admin, cid, people = world
    code = create_event(admin, cid, visibility="public")["event"]["public_code"]
    guest = people("g@example.test", "ゲスト")
    apply(guest, code)
    friend(guest)
    nobody = people("n@example.test", "友だちでない人")
    apply(nobody, code)                                                    # 友だちでない人には送らない
    start, end = start_of(code)
    sent_before = lambda: [m["kind"] for m in store().sent_messages()]

    early = jobs.run_tick(store(), now=start - timedelta(days=8), cleanup=False)
    assert early["sent"] == 0 and sent_before() == []
    week = start - timedelta(days=7)
    first = jobs.run_tick(store(), now=week + timedelta(minutes=1), cleanup=False)
    assert first["sent"] == 1 and sent_before() == ["week_before"]
    assert jobs.run_tick(store(), now=week + timedelta(minutes=2), cleanup=False)["sent"] == 0   # 二度は送らない
    day_of = start - timedelta(hours=3)
    assert jobs.run_tick(store(), now=day_of + timedelta(minutes=1), cleanup=False)["sent"] == 1
    assert jobs.run_tick(store(), now=end + timedelta(minutes=1), cleanup=False)["sent"] == 1
    assert sent_before() == ["week_before", "day_of", "after"]
    assert all(m["line_user_id"] == f"U-{guest.id[:8]}" for m in store().sent_messages())
    assert {m["to"] for m in store().sent_messages()} == {guest.id}
    assert all(row["sent_at"] for row in outbound(code) if row["account_id"] == guest.id)


def test_old_reminders_are_not_sent_late(world):
    admin, cid, people = world
    code = create_event(admin, cid, visibility="public")["event"]["public_code"]
    guest = people("g2@example.test", "ゲスト")
    apply(guest, code)
    friend(guest)
    start, _ = start_of(code)
    # 予定から24時間たったものは取らない
    result = jobs.run_tick(store(), now=start - timedelta(days=7) + timedelta(hours=25), cleanup=False)
    assert result["sent"] == 0 and store().sent_messages() == []


def test_declined_and_cancelled_messages_go_out_at_once(world):
    admin, cid, people = world
    made = create_event(admin, cid, visibility="public")
    code = made["event"]["public_code"]
    guest = people("g3@example.test", "ゲスト")
    apply(guest, code)
    friend(guest)
    declined = admin.client.post(f"/api/events/{code}/registrations/{guest.id}/decline", json={}, headers=admin.headers)
    assert declined.status_code == 200
    result = jobs.run_tick(store(), cleanup=False)
    assert result["sent"] == 1 and [m["kind"] for m in store().sent_messages()] == ["declined"]


def test_results_of_the_sender_decide_what_happens(world):
    admin, cid, people = world
    code = create_event(admin, cid, visibility="public")["event"]["public_code"]
    guest = people("g4@example.test", "ゲスト")
    apply(guest, code)
    friend(guest, "U-one")
    start, _ = start_of(code)
    now = start - timedelta(days=7) + timedelta(minutes=1)
    row = outbound(code, "week_before")[0]

    # retry：失敗に数え、理由を残す。貸し出しの期限（5分）までは取り直さない
    result = jobs.run_tick(store(), now=now, sender=lambda r, base_url="": Result("retry", "429"), cleanup=False)
    assert (result["sent"], result["failed"], result["skipped"]) == (0, 1, 0)
    assert row["last_error"] == "429" and row["attempts"] == 1 and row["sent_at"] is None
    assert jobs.run_tick(store(), now=now + timedelta(minutes=1), sender=lambda r, base_url="": Result("ok"),
                         cleanup=False)["sent"] == 0
    # not_configured：失敗に数えず、予約を残す
    result = jobs.run_tick(store(), now=now + timedelta(minutes=6), sender=lambda r, base_url="": Result("not_configured"),
                           cleanup=False)
    assert (result["sent"], result["failed"], result["skipped"]) == (0, 0, 1) and row["sent_at"] is None
    # 例外も失敗
    def boom(r, base_url=""):
        raise RuntimeError("x")
    result = jobs.run_tick(store(), now=now + timedelta(minutes=12), sender=boom, cleanup=False)
    assert result["failed"] == 1 and row["last_error"] == "RuntimeError"
    # blocked：友だちでなくなったと記録し、失敗として残す
    result = jobs.run_tick(store(), now=now + timedelta(minutes=18), sender=lambda r, base_url="": Result("blocked"),
                           cleanup=False)
    assert result["skipped"] == 1 and row["last_error"] == "blocked"
    assert store().line_link_of(guest.id)["is_friend"] is False
    assert jobs.run_tick(store(), now=now + timedelta(minutes=30), sender=lambda r, base_url="": Result("ok"),
                         cleanup=False)["sent"] == 0                       # もう友だちではない
    # 送る関数にはリンクの土台と行が渡る
    friend(guest, "U-two")
    seen = {}
    def spy(r, base_url=""):
        seen.update(row=r, base=base_url)
        return Result("ok")
    jobs.run_tick(store(), now=now + timedelta(minutes=40), sender=spy, base_url="https://x.test", cleanup=False)
    assert seen["base"] == "https://x.test" and seen["row"]["line_user_id"] == "U-two"
    for key in ("id", "kind", "title", "starts_at", "ends_at", "place", "public_code", "near_count"):
        assert key in seen["row"]
    assert row["sent_at"]


def test_without_line_nothing_is_claimed_in_production_shape(world, monkeypatch):
    """LINE の設定も代役も無い本番の形：取り出さない（回数だけ減るのを防ぐ）。"""
    admin, cid, people = world
    monkeypatch.setattr(jobs, "default_sender", lambda s: None)
    code = create_event(admin, cid, visibility="public")["event"]["public_code"]
    guest = people("g5@example.test", "ゲスト")
    apply(guest, code)
    friend(guest)
    start, _ = start_of(code)
    result = jobs.run_tick(store(), now=start - timedelta(days=7) + timedelta(minutes=1), cleanup=False)
    assert (result["sent"], result["failed"], result["skipped"]) == (0, 0, 0)
    assert outbound(code, "week_before")[0]["attempts"] == 0


# --------------------------------------------------------------------------
# LINE の結びつき（先に友だち追加した人）
# --------------------------------------------------------------------------

def test_friend_added_before_login_is_attached_later(world):
    admin, cid, people = world
    guest = people("late@example.test", "あとから")
    store().line_link_save(None, "U-early", True)                      # アカウントに結べないまま記録
    assert store().line_link_of(guest.id) is None
    assert store().line_link_attach(guest.id, "U-early") is True
    link = store().line_link_of(guest.id)
    assert link["line_user_id"] == "U-early" and link["is_friend"] is True
    assert store().line_link_attach(guest.id, "U-unknown") is False
    store().line_link_save(None, "U-gone", True)
    store().line_link_unfollow("U-gone")                                # 解除も記録され、結ぶと友だちではない
    assert store().line_link_attach(people("l2@example.test", "ふたり").id, "U-gone") is True
    # LINE の sub から人を探す／webhook の二重除け
    store().set_line_sub(guest.id, "U-early")
    assert store().account_by_line_sub("U-early") == guest.id and store().account_by_line_sub("nobody") is None
    assert store().line_webhook_seen("w-1") is True and store().line_webhook_seen("w-1") is False


def test_my_event_registrations_has_what_line_needs(world):
    admin, cid, people = world
    code = create_event(admin, cid, visibility="public")["event"]["public_code"]
    guest = people("g6@example.test", "ゲスト")
    apply(guest, code)
    row = store().my_event_registrations(guest.id)[0]
    for key in ("event_id", "status", "public_code", "title", "starts_at", "ends_at", "cancelled_at"):
        assert key in row
    assert row["public_code"] == code and row["status"] == "applied" and row["cancelled_at"] is None
    assert store().event_set_late(event=row["event_id"], account=guest.id, minutes=10) == {"late_minutes": 10}
    from core.store import EventRefused
    with pytest.raises(EventRefused) as refused:
        store().event_set_late(event=row["event_id"], account=guest.id, minutes=15)
    assert refused.value.code == "event_invalid" and str(refused.value)
    assert store().event_cancel_registration(event=row["event_id"], account=guest.id) == {"status": "cancelled"}
    with pytest.raises(EventRefused) as refused:
        store().event_cancel_registration(event=row["event_id"], account=guest.id)
    assert refused.value.code == "event_not_applied" and refused.value.status == 409


# --------------------------------------------------------------------------
# 片付け（保存期間）
# --------------------------------------------------------------------------

def test_cleanup_keeps_to_the_retention_periods(world):
    admin, cid, people = world
    made = create_event(admin, cid, visibility="public", capacity=20)
    code = made["event"]["public_code"]
    event_id = made["id"]
    start, end = start_of(code)
    attended = people("att@example.test", "きた人")
    apply(attended, code)
    friend(attended)
    kept_member = people("km@example.test", "メンバー")
    add_member(kept_member, cid)
    store().event_apply(event=event_id, account=kept_member.id, consent="2026-11-16")
    # この申し込みで作ったアカウント（片付けで消してよい）と、メンバーになったもの
    fresh_ids = []
    for i in range(2):
        account = str(uuid.uuid4())
        fresh_ids.append(account)
        ans = [{"prompt": "now", "body": "あ", "x": 1.0, "y": 1.0, "cluster_id": 0, "terms": [], "vec": [1.0], "vec_c": [1.0]},
               {"prompt": "future", "body": "い", "x": 1.0, "y": 1.0, "cluster_id": 0, "terms": [], "vec": [1.0],
                "vec_c": [1.0]}]
        store().event_apply(event=event_id, account=account, profile={"display_name": f"新しい人{i} 名前", "affiliation": "x"},
                            answers=ans, consent="2026-11-16")
    joined = fresh_ids[1]
    store()._members[(cid, joined)] = {"role": "member", "joined_at": "2026-11-01T00:00:00+00:00",
                                       "joined_via": "event", "invite_id": None, "event_post_id": event_id}
    store()._event_regs[(event_id, attended.id)]["status"] = "attended"
    # 保存期間のある記録
    long_ago = datetime.now(timezone.utc) - timedelta(days=40)
    assert store().line_webhook_seen("old", now=long_ago) and store().line_webhook_seen("recent")
    store().event_probe_hit(event=event_id, device="d", ip="i", now=long_ago)
    store().event_probe_hit(event=event_id, device="d", ip="i")

    # 終了から7日たつまでは何も消えない
    before = jobs.run_cleanup(store(), now=end + timedelta(days=7) - timedelta(minutes=1))
    assert (before["registrations"], before["answers"], before["outbound"]) == (0, 0, 0)
    assert before["webhook_events"] == 1 and before["probe_hits"] == 6      # 30日より古い webhook と、前日以前の probe
    assert before["account_ids"] == [] and before["deleted_accounts"] == 0
    assert outbound(code)

    after = jobs.run_cleanup(store(), now=end + timedelta(days=7) + timedelta(minutes=1))
    assert after["registrations"] == 3                          # 受付済み以外（メンバー1人と新しい人2人）
    assert after["answers"] == 4 + 2                            # attended の回答も、まだ posts に移していないので消す
    assert after["outbound"] > 0 and outbound(code) == []       # 予約は受付した人の分も含めて全部
    assert after["webhook_events"] == 0 and after["probe_hits"] == 0     # もう消してある
    assert [reg for key, reg in store()._event_regs.items() if key[0] == event_id] == [
        store()._event_regs[(event_id, attended.id)]]           # 受付した人の行は残る
    # アカウントごと消すのは、この申し込みで作り、どのコミュニティにも入っていない人だけ
    assert after["account_ids"] == [fresh_ids[0]] and after["deleted_accounts"] == 1
    assert store().get_account(fresh_ids[0]) is None
    assert store().get_account(joined) is not None and store().get_account(kept_member.id) is not None
    assert store().get_account(attended.id) is not None
    assert store().line_webhook_seen("recent") is False         # 新しい方は残っている
    # 何度流しても同じ
    again = jobs.run_cleanup(store(), now=end + timedelta(days=8))
    assert (again["registrations"], again["outbound"], again["account_ids"]) == (0, 0, [])


def test_cleanup_runs_inside_a_tick(world):
    admin, cid, people = world
    made = create_event(admin, cid, visibility="public")
    code = made["event"]["public_code"]
    guest = people("g7@example.test", "ゲスト")
    apply(guest, code)
    _, end = start_of(code)
    result = jobs.run_tick(store(), now=end + timedelta(days=8))
    assert result["cleaned"]["registrations"] == 1 and result["cleaned"]["deleted_accounts"] == 0
