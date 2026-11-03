"""会（イベント申し込み）2026-11-11 第2回b：開催の条件・受付・参加者リスト・会のあと（設計 G）。

純粋な関数（go_state・cancel_open・clean_event の開催の条件・checkin_me・near_map・participants_payload）、
手元モード（MemoryStore）での筋書き（判定・キャンセル期限・入り方3つ・飛び入り・参加者リスト・会えてよかった）、
API の権限と、第2回b の SQL がまだの DB での動き（新しい項目を送らない・新しい API は 503）。
ここに出てくる人・会はみんな作り話。
"""

import re
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

import app as application
from core import events, jobs
from core.config import EVENT_B_OFF_ERROR, EVENT_ERROR_TEXT
from core.store import SupabaseStore

JST = timezone(timedelta(hours=9))


def store():
    return application.state["store"]


def iso(days=10, hours=0):
    return (datetime.now(timezone.utc) + timedelta(days=days, hours=hours)).isoformat()


def jst_day(days=0):
    return (datetime.now(JST) + timedelta(days=days)).date().isoformat()


def get(person, path):
    return person.client.get(path, headers=person.headers)


def post(person, path, body=None):
    return person.client.post(path, json=body if body is not None else {}, headers=person.headers)


def patch_(person, path, body):
    return person.client.patch(path, json=body, headers=person.headers)


QUESTIONS = [
    {"prompt": "now", "label": "最近やってること", "hint": ""},
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


def add_member(person, cid):
    store()._members[(cid, person.id)] = {
        "role": "member", "joined_at": datetime.now(timezone.utc).isoformat(), "joined_via": "invite",
        "invite_id": None, "event_post_id": None}
    store().upsert_account(person.id, {"affiliation": "コクヨ",
                                       "name_confirmed_at": datetime.now(timezone.utc).isoformat()})


def create_event(admin, cid, *, capacity=5, expect=200, days=10, **rules):
    body = {
        "body": "夜の会をひらきます。話してみたい人は来てください。", "tags": ["参加者募集中"], "community_id": cid,
        "recruit_capacity": capacity,
        "event": {"title": "The Night Office BAR #3", "starts_at": iso(days), "ends_at": iso(days, 3),
                  "place": "渋谷 ○○ビル 3F", "visibility": "public", "questions": QUESTIONS,
                  "agree_terms": True, **rules},
    }
    response = post(admin, "/api/posts", body)
    assert response.status_code == expect, response.text
    return response.json()


def apply(person, code, *, expect=200, line=False, answers=ANSWERS):
    if line:
        with patch.object(events, "channel_and_sub", lambda claims: ("line", f"U-{person.id[:8]}")):
            return apply(person, code, expect=expect, answers=answers)
    body = {"agree_terms": True,
            "profile": {"display_name": f"{person.account['display_name']} 太郎", "affiliation": "○○株式会社",
                        "age_band": "30s", "job_title": "デザイナー"}}
    if answers:
        body["answers"] = answers
    response = post(person, f"/api/events/{code}/apply", body)
    assert response.status_code == expect, response.text
    return response.json()


def open_checkin(admin, code):
    """受付の時間にする：開始を1時間後に動かす（手元だけの道）。"""
    response = post(admin, f"/api/local/events/{code}/set-times", {"starts_at": iso(0, 1), "ends_at": iso(0, 3)})
    assert response.status_code == 200, response.text


def force(admin, code, **fields):
    response = post(admin, f"/api/local/events/{code}/force", fields)
    assert response.status_code == 200, response.text


# --------------------------------------------------------------------------
# 純粋な関数
# --------------------------------------------------------------------------

def test_go_state_phases():
    event = {"min_participants": 3, "decide_on": "2026-11-10", "decision": None}
    before = datetime(2026, 11, 10, 14, 59, tzinfo=timezone.utc)      # 11/10 23:59 JST
    after = datetime(2026, 11, 10, 15, 0, tzinfo=timezone.utc)        # 11/11 0:00 JST
    assert events.go_state({"min_participants": None}, 5) is None
    state = events.go_state(event, 1, before)
    assert state["phase"] == "recruiting" and state["needed"] == 2 and state["min"] == 3
    assert state["decide_on"] == "2026-11-10" and state["deadline"] == after.isoformat()
    assert events.go_state(event, 3, before)["phase"] == "held"
    assert events.go_state(event, 3, before)["needed"] == 0
    assert events.go_state(event, 2, after) == {**events.go_state(event, 2, after), "phase": "not_held", "needed": 0}
    # 記録された判定がいちばん強い（開催決定のあとに人数が減っても開催決定）
    assert events.go_state({**event, "decision": "held"}, 0, after)["phase"] == "held"
    assert events.go_state({**event, "decision": "not_held"}, 9, before)["phase"] == "not_held"


def test_cancel_open():
    start = datetime(2026, 11, 13, 10, tzinfo=timezone.utc)
    event = {"starts_at": start.isoformat(), "cancel_deadline": None}
    assert events.cancel_open(event, start - timedelta(minutes=1))
    assert not events.cancel_open(event, start)
    limited = {**event, "cancel_deadline": (start - timedelta(days=1)).isoformat()}
    assert events.cancel_open(limited, start - timedelta(days=1))
    assert not events.cancel_open(limited, start - timedelta(days=1) + timedelta(seconds=1))


def test_clean_event_rules_for_a_new_event():
    now = datetime(2026, 11, 1, 3, tzinfo=timezone.utc)
    ok = {"title": "会", "starts_at": "2026-11-13T10:00:00+00:00", "ends_at": "2026-11-13T12:00:00+00:00",
          "place": "", "visibility": "community"}
    clean = events.clean_event(ok, now=now)
    assert clean["join_policy"] == "ask"                   # 新しい会の初期値は「本人に確認」
    assert clean["min_participants"] is None and clean["decide_on"] is None and clean["cancel_deadline"] is None
    full = events.clean_event({**ok, "min_participants": "4", "decide_on": "2026-11-12",
                               "cancel_deadline": "2026-11-12T12:00:00+09:00", "join_policy": "none"}, now=now)
    assert full["min_participants"] == 4 and full["decide_on"] == "2026-11-12" and full["join_policy"] == "none"
    assert full["cancel_deadline"] == datetime(2026, 11, 12, 3, tzinfo=timezone.utc)
    for bad, words in [
        ({**ok, "min_participants": 1, "decide_on": "2026-11-10"}, "最小開催人数"),
        ({**ok, "min_participants": True, "decide_on": "2026-11-10"}, "最小開催人数"),
        ({**ok, "min_participants": 3}, "判定日も"),
        ({**ok, "decide_on": "2026-11-10"}, "最小開催人数を入れたときだけ"),
        ({**ok, "min_participants": 3, "decide_on": "2026-10-31"}, "今日以降"),
        # 開始日（JST の 11/13）と同じ日は不可：判定の締め（翌0時）が会のあとになるため
        ({**ok, "min_participants": 3, "decide_on": "2026-11-13"}, "開始日より前"),
        ({**ok, "min_participants": 3, "decide_on": "11/10"}, "判定日の形"),
        ({**ok, "cancel_deadline": "2026-11-13T10:00:00+00:00"}, "開始より前"),
        ({**ok, "cancel_deadline": "2026-10-31T00:00:00+00:00"}, "今より後"),
        ({**ok, "join_policy": "maybe"}, "入り方"),
    ]:
        with pytest.raises(ValueError) as error:
            events.clean_event(bad, now=now)
        assert words in str(error.value), (bad, str(error.value))


def test_clean_event_rules_for_a_change():
    now = datetime(2026, 11, 1, tzinfo=timezone.utc)
    current = {"starts_at": "2026-11-13T10:00:00+00:00", "ends_at": "2026-11-13T12:00:00+00:00",
               "visibility": "public", "min_participants": 3, "decide_on": "2026-11-10",
               "cancel_deadline": "2026-11-12T00:00:00+00:00", "join_policy": "ask"}
    assert events.clean_event({"join_policy": "auto"}, now=now, current=current) == {"join_policy": "auto"}
    # 最小人数を消すと判定日も消える（組）
    assert events.clean_event({"min_participants": None}, now=now, current=current) == {
        "min_participants": None, "decide_on": None}
    with pytest.raises(ValueError):
        events.clean_event({"decide_on": None}, now=now, current=current)
    # 開始日時を判定日より前に動かすと断る（判定日・キャンセル期限と比べ直す）
    with pytest.raises(ValueError) as error:
        events.clean_event({"starts_at": "2026-11-10T03:00:00+00:00", "ends_at": "2026-11-10T05:00:00+00:00"},
                           now=now, current=current)
    assert "判定日" in str(error.value)
    with pytest.raises(ValueError) as error:
        events.clean_event({"starts_at": "2026-11-11T20:00:00+00:00", "ends_at": "2026-11-11T22:00:00+00:00"},
                           now=now, current={**current, "min_participants": None, "decide_on": None})
    assert "キャンセル期限" in str(error.value)


def test_checkin_me_words():
    assert events.checkin_me(None, False) == "none"
    assert events.checkin_me(None, True) == "banned"
    assert events.checkin_me({"status": "declined"}, False) == "banned"
    for status in ("applied", "attended", "waiting"):
        assert events.checkin_me({"status": status}, False) == status
    assert events.checkin_me({"status": "cancelled", "channel": "walkin", "walkin_rejects": 1}, False) == "rejected"
    assert events.checkin_me({"status": "cancelled", "channel": "walkin", "walkin_rejects": 3}, False) == "banned"
    assert events.checkin_me({"status": "cancelled", "channel": "line", "walkin_rejects": 0}, False) == "cancelled"


def _vec(*values):
    return list(values) + [0.0] * (4 - len(values))


def test_near_map_uses_only_the_answers():
    vectors = [
        {"account_id": "me", "prompt": "future", "vec_c": _vec(1, 0)},
        {"account_id": "close", "prompt": "past", "vec_c": _vec(0.95, 0.1)},
        {"account_id": "mid", "prompt": "now", "vec_c": _vec(0.5, 0.9)},
        {"account_id": "far", "prompt": "now", "vec_c": _vec(0, 1)},
    ]
    near = events.near_map(vectors, "me")
    assert near["close"]["level"] == "high"
    # 向きが合う（やってみたい→前にやっていた）
    assert near["close"]["reason"] == "あなたのやってみたいことを、この人は前にやっていました"
    assert near["mid"]["level"] == "mid" and "far" not in near
    # 回答の無い人（1タップのメンバー・主催者）は near なし
    assert events.near_map(vectors, "someone-without-answers") == {}
    # 同じジャンルなら、ゆるい言い方で話題を言う
    low = [{"account_id": "me", "prompt": "now", "vec_c": _vec(1, 0)},
           {"account_id": "x", "prompt": "now", "vec_c": _vec(0.35, 0.94)}]
    found = events.near_map(low, "me", {"me": "アウトドア", "x": "アウトドア"})["x"]
    assert found["level"] == "low" and found["reason"] == "どちらも「アウトドア」の話題です"
    assert "あなた" not in events.near_map(low, "me")["x"]["reason"]          # 低い相手に強く言わない


def test_participants_payload_order_and_fields():
    event = {"questions": QUESTIONS}
    rows = [
        {"account_id": "a", "status": "applied", "display_name": "A", "is_host": False},
        {"account_id": "b", "status": "attended", "display_name": "B", "is_host": False, "is_member": True},
        {"account_id": "me", "status": "applied", "display_name": "わたし", "is_host": False},
        {"account_id": "h", "status": "host", "display_name": "主催", "is_host": True},
    ]
    answers = [{"account_id": "b", "prompt": "now", "body": "陶芸"}]
    vectors = [{"account_id": "me", "prompt": "now", "vec_c": _vec(1, 0)},
               {"account_id": "b", "prompt": "now", "vec_c": _vec(1, 0.1)}]
    out = events.participants_payload(event, rows, answers, vectors, "me")
    assert [p["account_id"] for p in out["people"]] == ["me", "h", "b", "a"]
    assert out["counts"] == {"applied": 2, "attended": 1} and out["near3"] == ["b"]
    b = out["people"][2]
    assert b["answers"] == [{"prompt": "now", "label": "最近やってること", "body": "陶芸"}]
    assert b["near"]["level"] == "high" and "score" not in b["near"] and b["is_member"] is True
    assert out["people"][0]["is_me"] and out["people"][0]["near"] is None
    assert out["people"][1]["state"] == "host"
    assert all("age_band" not in person for person in out["people"])


# --------------------------------------------------------------------------
# 開催の判定（手元モード）
# --------------------------------------------------------------------------

def test_reaching_the_minimum_holds_the_event_for_good(world):
    admin, cid, people = world
    made = create_event(admin, cid, min_participants=2, decide_on=jst_day(3))
    code = made["event"]["public_code"]
    view = get(admin, f"/api/events/{code}").json()["event"]
    assert view["phase"] == "recruiting" and view["needed"] == 2 and view["min_participants"] == 2
    assert view["join_policy"] == "ask" and view["decide_on"] == jst_day(3) and view["cancel_open"]
    a, b = people("a@example.test", "えー"), people("b@example.test", "びー")
    apply(a, code)
    assert get(admin, f"/api/public/events/{code}").json()["needed"] == 1
    result = apply(b, code)
    assert result["phase"] == "held"
    public = get(admin, f"/api/public/events/{code}").json()
    assert public["phase"] == "held" and public["needed"] == 0 and public["closed"] is None
    # 開催決定のあとに人数が減っても、開催決定のまま
    assert post(b, f"/api/events/{code}/cancel").status_code == 200
    assert get(a, f"/api/events/{code}").json()["event"]["phase"] == "held"
    assert store().event_by_post(made["id"])["decision"] == "held"


def test_missing_the_minimum_calls_the_event_off(world):
    admin, cid, people = world
    made = create_event(admin, cid, min_participants=3, decide_on=jst_day(3))
    code = made["event"]["public_code"]
    a = people("a@example.test", "えー")
    apply(a, code, line=True)
    assert any(row["event_id"] == made["id"] for row in store()._outbound.values())
    public = get(admin, f"/api/public/events/{code}").json()             # まだ募集中（キャッシュされる）
    assert public["phase"] == "recruiting"
    store().event_force(code, {"decide_on": jst_day(-1)})                 # 判定日を過去に（キャッシュは消さない）
    view = get(a, f"/api/events/{code}").json()                           # 読んだ所で判定が書かれ、キャッシュも消える
    assert view["event"]["phase"] == "not_held" and view["event"]["closed"] == "not_held"
    assert view["me"]["can_cancel"] is False
    assert get(admin, f"/api/public/events/{code}").json()["closed"] == "not_held"
    # 未送信の案内は消え、新しい申し込み・遅れる・受付はできない
    assert not any(row["event_id"] == made["id"] and not row["sent_at"] for row in store()._outbound.values())
    b = people("b@example.test", "びー")
    response = post(b, f"/api/events/{code}/apply", {"agree_terms": True, "answers": ANSWERS,
                                                    "profile": {"display_name": "び 太郎", "affiliation": "○○"}})
    assert response.status_code == 409 and response.json()["detail"] == EVENT_ERROR_TEXT["event_not_held"]
    assert post(a, f"/api/events/{code}/late", {"minutes": 10}).status_code == 409
    open_checkin(admin, code)
    assert post(a, f"/api/checkin/{made['event']['checkin_code']}").json()["detail"] == \
        EVENT_ERROR_TEXT["event_not_held"]
    # 中止の会でも、申し込みの取り消しはできる（期限は見ない）
    assert post(a, f"/api/events/{code}/cancel").status_code == 200


def test_tick_settles_events_past_their_day(world):
    admin, cid, people = world
    made = create_event(admin, cid, min_participants=3, decide_on=jst_day(3))
    store().event_force(made["event"]["public_code"], {"decide_on": jst_day(-1)})
    result = jobs.run_tick(store(), sender=lambda row, base_url="": "ok", cleanup=False)
    assert result["settled"] == 1
    assert store().event_by_post(made["id"])["decision"] == "not_held"
    assert jobs.run_tick(store(), sender=lambda row, base_url="": "ok", cleanup=False)["settled"] == 0


def test_cancel_deadline(world):
    admin, cid, people = world
    made = create_event(admin, cid, cancel_deadline=iso(5))
    code = made["event"]["public_code"]
    a = people("a@example.test", "えー")
    apply(a, code)
    me = get(a, f"/api/events/{code}").json()["me"]
    assert me["can_cancel"] is True and me["can_join"] is False
    force(admin, code, cancel_deadline=iso(-1))
    view = get(a, f"/api/events/{code}").json()
    assert view["event"]["cancel_open"] is False and view["me"]["can_cancel"] is False
    response = post(a, f"/api/events/{code}/cancel")
    assert response.status_code == 409 and response.json()["detail"] == EVENT_ERROR_TEXT["cancel_closed"]


def test_rules_on_create_are_checked_against_the_capacity(world):
    admin, cid, _ = world
    create_event(admin, cid, capacity=3, min_participants=4, decide_on=jst_day(3), expect=422)
    create_event(admin, cid, min_participants=3, expect=422)                     # 判定日が無い
    create_event(admin, cid, min_participants=3, decide_on=jst_day(10), expect=422)   # 開始日と同じ日
    made = create_event(admin, cid, join_policy="auto")
    assert store().event_by_post(made["id"])["join_policy"] == "auto"


def test_change_rules_and_the_decided_lock(world):
    admin, cid, people = world
    made = create_event(admin, cid, min_participants=2, decide_on=jst_day(3))
    code = made["event"]["public_code"]
    response = patch_(admin, f"/api/events/{code}", {"min_participants": 6})
    assert response.status_code == 422                                           # 定員（5）より多い
    assert patch_(admin, f"/api/events/{code}", {"min_participants": 3}).json()["event"]["min_participants"] == 3
    force(admin, code, decision="held")
    response = patch_(admin, f"/api/events/{code}", {"min_participants": 4})
    assert response.status_code == 409 and response.json()["detail"] == EVENT_ERROR_TEXT["event_decided"]
    assert patch_(admin, f"/api/events/{code}", {"decide_on": jst_day(4)}).status_code == 409
    # 入り方とキャンセル期限は、判定のあとも変えられる
    body = patch_(admin, f"/api/events/{code}", {"join_policy": "none", "cancel_deadline": iso(2)}).json()
    assert body["event"]["join_policy"] == "none" and body["event"]["cancel_deadline"]
    # 開始を判定日より前に動かすことはできない
    response = patch_(admin, f"/api/events/{code}", {"starts_at": iso(1), "ends_at": iso(1, 2)})
    assert response.status_code == 422


# --------------------------------------------------------------------------
# 受付と入り方3つ
# --------------------------------------------------------------------------

def test_checkin_with_auto_makes_a_member_and_moves_answers_to_the_map(world):
    admin, cid, people = world
    made = create_event(admin, cid, join_policy="auto")
    code, qr = made["event"]["public_code"], made["event"]["checkin_code"]
    a = people("a@example.test", "えー")
    apply(a, code)
    info = get(a, f"/api/checkin/{qr}").json()
    assert info["window"] == "early" and info["me"] == "applied" and info["event"]["join_policy"] == "auto"
    response = post(a, f"/api/checkin/{qr}")
    assert response.status_code == 409 and response.json()["detail"] == EVENT_ERROR_TEXT["checkin_closed"]
    open_checkin(admin, code)
    with patch.object(application, "invalidate_islands") as islands, \
            patch.object(application, "invalidate_connections") as lines:
        assert post(a, f"/api/checkin/{qr}").json() == {"result": "attended", "joined": True}
    assert islands.called and lines.called
    assert store().is_community_member(cid, a.id)
    assert store()._members[(cid, a.id)]["joined_via"] == "event"
    moved = [p for p in store().posts_by_author(a.id) if p.get("community_id") == cid]
    assert sorted(p["body"] for p in moved) == sorted(item["body"] for item in ANSWERS)
    assert post(a, f"/api/checkin/{qr}").json() == {"result": "already", "joined": False}
    assert get(a, f"/api/checkin/{qr}").json()["me"] == "attended"
    roster = get(admin, f"/api/events/{code}/roster").json()
    assert roster["people"][0]["is_member"] is True and roster["counts"]["phase"] is None


def test_joining_tells_residents_like_a_new_post(world):
    """community_members には DB のトリガーが無いので、写った投稿ごとに Python が「新しい住人」を出す。"""
    admin, cid, people = world
    made = create_event(admin, cid)
    code, qr = made["event"]["public_code"], made["event"]["checkin_code"]
    a = people("a@example.test", "えー")
    apply(a, code)
    open_checkin(admin, code)
    post(a, f"/api/checkin/{qr}")
    with patch.object(application, "notify_resident") as told:
        post(a, f"/api/events/{code}/join")
    assert told.call_count == len(ANSWERS)
    assert {call.args[1] for call in told.call_args_list} == {a.id}
    assert all(call.kwargs["post_community"] == cid for call in told.call_args_list)


def test_ask_policy_needs_the_join_button(world):
    admin, cid, people = world
    made = create_event(admin, cid)                                             # 初期値は ask
    code, qr = made["event"]["public_code"], made["event"]["checkin_code"]
    a = people("a@example.test", "えー")
    apply(a, code)
    response = post(a, f"/api/events/{code}/join")
    assert response.status_code == 403 and response.json()["detail"] == EVENT_ERROR_TEXT["event_not_attended"]
    open_checkin(admin, code)
    assert post(a, f"/api/checkin/{qr}").json() == {"result": "attended", "joined": False}
    assert not store().is_community_member(cid, a.id)
    assert get(a, f"/api/events/{code}").json()["me"]["can_join"] is True
    with patch.object(application, "invalidate_connections") as lines:
        assert post(a, f"/api/events/{code}/join").json() == {"status": "joined", "community_id": cid}
    assert lines.called and store().is_community_member(cid, a.id)
    assert get(a, f"/api/events/{code}").json()["me"]["can_join"] is False
    assert post(a, f"/api/events/{code}/join").json()["status"] == "already"


def test_none_policy_never_joins(world):
    admin, cid, people = world
    made = create_event(admin, cid, join_policy="none")
    code, qr = made["event"]["public_code"], made["event"]["checkin_code"]
    a = people("a@example.test", "えー")
    apply(a, code)
    open_checkin(admin, code)
    assert post(a, f"/api/checkin/{qr}").json()["joined"] is False
    response = post(a, f"/api/events/{code}/join")
    assert response.status_code == 409 and response.json()["detail"] == EVENT_ERROR_TEXT["join_not_allowed"]
    assert not store().is_community_member(cid, a.id)


def test_removed_person_is_not_admitted(world):
    admin, cid, people = world
    made = create_event(admin, cid)
    code, qr = made["event"]["public_code"], made["event"]["checkin_code"]
    a = people("a@example.test", "えー")
    apply(a, code)
    open_checkin(admin, code)
    post(a, f"/api/checkin/{qr}")
    store()._removals[(cid, a.id)] = {"removed_at": iso(0)}
    response = post(a, f"/api/events/{code}/join")
    assert response.status_code == 403 and response.json()["detail"] == EVENT_ERROR_TEXT["event_banned"]


def test_member_without_an_application_checks_in_at_once(world):
    admin, cid, people = world
    made = create_event(admin, cid)
    m = people("m@example.test", "めんばー")
    add_member(m, cid)
    open_checkin(admin, made["event"]["public_code"])
    qr = made["event"]["checkin_code"]
    assert get(m, f"/api/checkin/{qr}").json()["is_member"] is True
    assert post(m, f"/api/checkin/{qr}").json() == {"result": "attended", "joined": False}
    reg = store().event_registration(made["id"], m.id)
    assert reg["status"] == "attended" and reg["channel"] == "walkin"


def test_cancelled_application_cannot_check_in(world):
    admin, cid, people = world
    made = create_event(admin, cid)
    code, qr = made["event"]["public_code"], made["event"]["checkin_code"]
    a = people("a@example.test", "えー")
    apply(a, code)
    post(a, f"/api/events/{code}/cancel")
    open_checkin(admin, code)
    assert get(a, f"/api/checkin/{qr}").json()["me"] == "cancelled"
    response = post(a, f"/api/checkin/{qr}")
    assert response.status_code == 409 and response.json()["detail"] == EVENT_ERROR_TEXT["checkin_cancelled_reg"]


def test_walkin_waits_for_the_host(world):
    admin, cid, people = world
    made = create_event(admin, cid, join_policy="auto")
    code, qr = made["event"]["public_code"], made["event"]["checkin_code"]
    open_checkin(admin, code)
    w = people("w@example.test", "とびいり")
    assert post(w, f"/api/checkin/{qr}").json() == {"result": "need_walkin", "joined": False}
    response = post(w, f"/api/checkin/{qr}/walkin", {"display_name": "飛び 入り", "affiliation": "△△"})
    assert response.status_code == 422                                          # 規約への同意が無い
    body = {"display_name": "飛び 入り", "affiliation": "△△", "agree_terms": True}
    assert post(w, f"/api/checkin/{qr}/walkin", body).json() == {"status": "waiting"}
    assert get(w, f"/api/checkin/{qr}").json()["me"] == "waiting"
    assert post(w, f"/api/checkin/{qr}").json()["result"] == "waiting"
    roster = get(admin, f"/api/events/{code}/roster").json()
    assert [row["display_name"] for row in roster["waiting"]] == ["飛び 入り"]
    # 主催者でない人は受付できない
    other = people("o@example.test", "ほか")
    assert post(other, f"/api/events/{code}/registrations/{w.id}/checkin").status_code == 403
    result = post(admin, f"/api/events/{code}/registrations/{w.id}/checkin").json()
    assert result == {"status": "attended", "joined": True}
    assert get(w, f"/api/checkin/{qr}").json()["me"] == "attended"
    # 受付済みの人を、もう一度受付・却下はできない
    assert post(admin, f"/api/events/{code}/registrations/{w.id}/reject-walkin").json()["detail"] == \
        EVENT_ERROR_TEXT["not_waiting"]


def test_walkin_rejected_three_times_is_stopped(world):
    admin, cid, people = world
    made = create_event(admin, cid)
    code, qr = made["event"]["public_code"], made["event"]["checkin_code"]
    open_checkin(admin, code)
    w = people("w@example.test", "とびいり")
    body = {"display_name": "飛び 入り", "affiliation": "△△", "agree_terms": True}
    for count in (1, 2, 3):
        assert post(w, f"/api/checkin/{qr}/walkin", body).json()["status"] == "waiting"
        assert post(admin, f"/api/events/{code}/registrations/{w.id}/reject-walkin").json() == \
            {"walkin_rejects": count}
        assert get(w, f"/api/checkin/{qr}").json()["me"] == ("banned" if count == 3 else "rejected")
    response = post(w, f"/api/checkin/{qr}/walkin", body)
    assert response.status_code == 429 and response.json()["detail"] == EVENT_ERROR_TEXT["walkin_limit"]


def test_host_can_check_in_an_applicant_outside_the_window(world):
    admin, cid, people = world
    made = create_event(admin, cid)
    code = made["event"]["public_code"]
    a = people("a@example.test", "えー")
    apply(a, code)
    assert post(admin, f"/api/events/{code}/registrations/{a.id}/checkin").json()["status"] == "attended"


# --------------------------------------------------------------------------
# 参加者リスト
# --------------------------------------------------------------------------

def test_participants_who_may_look_and_what_they_see(world):
    admin, cid, people = world
    made = create_event(admin, cid)
    code = made["event"]["public_code"]
    a, b = people("a@example.test", "えー"), people("b@example.test", "びー")
    apply(a, code)
    apply(b, code)
    outsider = people("x@example.test", "そと")
    response = get(outsider, f"/api/events/{code}/participants")
    assert response.status_code == 404 and response.json()["detail"] == EVENT_ERROR_TEXT["event_not_found"]
    member = people("m@example.test", "めんばー")
    add_member(member, cid)
    for viewer in (a, admin, member):
        assert get(viewer, f"/api/events/{code}/participants").status_code == 200
    out = get(a, f"/api/events/{code}/participants").json()
    assert out["counts"] == {"applied": 2, "attended": 0}
    ids = [p["account_id"] for p in out["people"]]
    assert ids[0] == a.id and ids[1] == admin.id and set(ids) == {a.id, b.id, admin.id}
    host_row = out["people"][1]
    assert host_row["state"] == "host" and host_row["is_host"] and host_row["near"] is None
    other = next(p for p in out["people"] if p["account_id"] == b.id)
    assert other["name"] == "びー 太郎" and other["affiliation"] == "○○株式会社" and other["job_title"] == "デザイナー"
    assert [item["label"] for item in other["answers"]] == ["最近やってること", "やってみたいこと"]
    assert "age_band" not in other and "30s" not in str(out)
    assert other["near"] is not None and out["near3"] == [b.id]                 # 同じ回答どうしは近い
    # 回答の無いメンバー（1タップ）は near なし
    assert all(p["near"] is None for p in get(member, f"/api/events/{code}/participants").json()["people"])
    # 取り消した人は出ない
    post(b, f"/api/events/{code}/cancel")
    application.state["event_participants_cache"].clear()
    assert b.id not in [p["account_id"] for p in get(a, f"/api/events/{code}/participants").json()["people"]]


# --------------------------------------------------------------------------
# 会のあと
# --------------------------------------------------------------------------

def test_after_and_met(world):
    admin, cid, people = world
    made = create_event(admin, cid)
    code, qr = made["event"]["public_code"], made["event"]["checkin_code"]
    a, b, c = (people(f"{n}@example.test", n) for n in ("a", "b", "c"))
    for person in (a, b, c):
        apply(person, code)
    response = get(a, f"/api/events/{code}/after")
    assert response.status_code == 403 and response.json()["detail"] == EVENT_ERROR_TEXT["event_not_attended"]
    open_checkin(admin, code)
    post(a, f"/api/checkin/{qr}")
    post(b, f"/api/checkin/{qr}")
    out = get(a, f"/api/events/{code}/after").json()
    assert [p["account_id"] for p in out["people"]] == [b.id]                   # 受付済みの人だけ・自分は出ない
    assert out["me_is_member"] is False and out["join_policy"] == "ask"
    assert out["people"][0]["met"] is False and out["people"][0]["talk"] is False
    assert post(a, f"/api/events/{code}/met", {"to": b.id, "on": True}).json() == {"on": True}
    assert get(a, f"/api/events/{code}/after").json()["people"][0]["met"] is True
    assert get(b, f"/api/events/{code}/after").json()["people"][0]["met"] is False   # 相手には知らせない
    assert post(a, f"/api/events/{code}/met", {"to": b.id, "on": False}).json() == {"on": False}
    response = post(a, f"/api/events/{code}/met", {"to": c.id, "on": True})      # 受付していない相手
    assert response.status_code == 403
    assert post(a, f"/api/events/{code}/met", {"to": a.id, "on": True}).status_code == 422


def test_after_shows_talk_for_members(world):
    admin, cid, people = world
    made = create_event(admin, cid, join_policy="auto")
    code, qr = made["event"]["public_code"], made["event"]["checkin_code"]
    a, b = people("a@example.test", "えー"), people("b@example.test", "びー")
    apply(a, code)
    apply(b, code)
    open_checkin(admin, code)
    post(a, f"/api/checkin/{qr}")
    post(b, f"/api/checkin/{qr}")
    store().press_talk(a.id, b.id)
    out = get(a, f"/api/events/{code}/after").json()
    assert out["me_is_member"] is True and out["people"][0]["talk"] is True and out["people"][0]["is_member"]


# --------------------------------------------------------------------------
# 第2回b の SQL がまだの DB・手元だけの道
# --------------------------------------------------------------------------

def test_without_the_new_sql_new_apis_answer_503_and_rules_are_not_sent(world, monkeypatch):
    admin, cid, people = world
    monkeypatch.setattr(store(), "supports_events_b", False, raising=False)
    made = create_event(admin, cid, min_participants=2, decide_on=jst_day(3), join_policy="none")
    code, qr = made["event"]["public_code"], made["event"]["checkin_code"]
    event = store().event_by_post(made["id"])
    assert event["min_participants"] is None and event["join_policy"] == "auto"   # 新しい項目は送っていない
    view = get(admin, f"/api/events/{code}").json()["event"]
    assert view["phase"] is None and view["join_policy"] == "auto"
    for method, path in (("get", f"/api/events/{code}/participants"), ("post", f"/api/events/{code}/join"),
                         ("get", f"/api/checkin/{qr}"), ("post", f"/api/checkin/{qr}"),
                         ("get", f"/api/events/{code}/after"), ("post", f"/api/events/{code}/met")):
        response = getattr(admin.client, method)(path, headers=admin.headers, **({"json": {}} if method == "post" else {}))
        assert response.status_code == 503 and response.json()["detail"] == EVENT_B_OFF_ERROR, path
    response = patch_(admin, f"/api/events/{code}", {"min_participants": 3, "decide_on": jst_day(3)})
    assert response.status_code == 422                                          # 送らない → 変更点なし


def test_local_force_is_local_only(world, monkeypatch):
    admin, cid, _ = world
    code = create_event(admin, cid)["event"]["public_code"]
    assert post(admin, f"/api/local/events/{code}/force", {"decision": "maybe"}).status_code == 422
    monkeypatch.setitem(application.state, "local_mode", False)
    assert post(admin, f"/api/local/events/{code}/force", {"decision": "held"}).status_code == 404


# --------------------------------------------------------------------------
# Python と DB（20261111000000_events_b.sql）の約束
# --------------------------------------------------------------------------

UID = "00000000-0000-4000-8000-000000000001"
NOW = "2026-11-10T00:00:00+00:00"


class Recorder(SupabaseStore):
    def __init__(self, ready=True):                      # 繋がない
        self.rpcs, self.reads, self.ready = [], [], ready

    @property
    def supports_events_b(self):
        return self.ready

    def _send(self, method, path, label=None, json=None, allow_statuses=(), **kwargs):
        name = path.removeprefix("rpc/")
        self.rpcs.append((name, json))
        body = 1 if name == "event_settle_due" else {"status": "attended", "joined": False, "on": True}

        class Response:
            status_code = 200
            content = b"x"
            text = "x"

            def json(self):
                return body
        return Response()

    def _get(self, table, params=None, label=None, **kwargs):
        self.reads.append((table, dict(params or {})))
        return []


B_CALLS = [
    ("event_create", dict(post=UID, actor=UID, title="t", starts=NOW, ends=NOW, place="", visibility="public",
                          questions=[], min_participants=3, decide_on="2026-11-09", cancel_deadline=NOW,
                          join_policy="ask")),
    ("event_settle", dict(event=UID)),
    ("event_settle_due", dict()),
    ("event_checkin", dict(event=UID, account=UID)),
    ("event_walkin_request", dict(event=UID, account=UID, profile={"display_name": "x"}, consent="v")),
    ("event_checkin_by_host", dict(event=UID, host=UID, account=UID)),
    ("event_reject_walkin", dict(event=UID, host=UID, account=UID)),
    ("event_join_community", dict(event=UID, account=UID)),
    ("event_participants", dict(event_id=UID)),
    ("event_participant_answers", dict(event_id=UID)),
    ("event_after_people", dict(event=UID, account=UID)),
    ("event_meet", dict(event=UID, from_id=UID, to_id=UID, on=True)),
]
B_PAYLOADS = {
    "event_create": {"p_post", "p_actor", "p_title", "p_starts", "p_ends", "p_place", "p_visibility",
                     "p_questions", "p_min", "p_decide_on", "p_cancel_deadline", "p_join_policy"},
    "event_settle": {"p_event"}, "event_settle_due": set(), "event_checkin": {"p_event", "p_account"},
    "event_walkin_request": {"p_event", "p_account", "p_profile", "p_consent"},
    "event_checkin_by_host": {"p_event", "p_host", "p_account"},
    "event_reject_walkin": {"p_event", "p_host", "p_account"},
    "event_join_community": {"p_event", "p_account"}, "event_participants": {"p_event"},
    "event_participant_answers": {"p_event"}, "event_after_people": {"p_event", "p_account"},
    "event_meet": {"p_event", "p_from", "p_to", "p_on"},
}


def test_python_sends_the_argument_names_of_design_g():
    recorder = Recorder()
    for name, kwargs in B_CALLS:
        getattr(recorder, name)(**kwargs)
    sent = dict(recorder.rpcs)
    for name, keys in B_PAYLOADS.items():
        assert set(sent[name]) == keys, (name, set(sent[name]) ^ keys)
    assert sent["event_create"]["p_decide_on"] == "2026-11-09"


def test_old_database_gets_the_eight_arguments_and_no_new_fields():
    recorder = Recorder(ready=False)
    recorder.event_create(**dict(B_CALLS[0][1]))
    recorder.event_update(post=UID, actor=UID, fields={"title": "x", "join_policy": "auto", "min_participants": 3})
    sent = dict(recorder.rpcs)
    assert set(sent["event_create"]) == B_PAYLOADS["event_create"] - {
        "p_min", "p_decide_on", "p_cancel_deadline", "p_join_policy"}
    assert sent["event_update"]["p_fields"] == {"title": "x"}


def test_new_rpcs_exist_in_the_sql_with_the_same_argument_names():
    path = Path(__file__).resolve().parent.parent / "supabase" / "migrations" / "20261111000000_events_b.sql"
    if not path.exists():
        pytest.skip("20261111000000_events_b.sql はまだ無い（DB 担当が並行で作っている）")
    sql = path.read_text(encoding="utf-8")
    found = {}
    for match in re.finditer(r"create (?:or replace )?function public\.(\w+)\((.*?)\)\s*returns", sql, re.S):
        found[match.group(1)] = {part.strip().split()[0]: " default " in part
                                 for part in match.group(2).split(",") if part.strip()}
    for name, keys in B_PAYLOADS.items():
        assert name in found, f"DB に {name} が無い"
        assert keys <= set(found[name]), (name, keys - set(found[name]))
        required = {arg for arg, has_default in found[name].items() if not has_default}
        assert required <= keys, (name, required - keys)
