"""core/line.py：署名・二重処理・振り分け・本文を残さない・文・設定なし・429/5xx。"""

import base64
import hashlib
import hmac
import json
import logging
from datetime import datetime, timezone

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from core import line

SECRET = "test-secret"
TOKEN = "test-token"
NOW = datetime(2026, 11, 13, 1, 0, tzinfo=timezone.utc)  # 10:00 JST

REG = {"event_id": "ev-1", "status": "applied", "public_code": "CODE123", "title": "The Night Office BAR #2",
       "starts_at": "2026-11-13T10:00:00+00:00", "ends_at": "2026-11-13T13:00:00+00:00", "place": "BAR"}
EVENT = {"title": "The Night Office BAR #2", "starts_at": "2026-11-13T10:00:00+00:00",
         "ends_at": "2026-11-13T13:00:00+00:00", "place": "〇〇ビル 3階", "public_code": "CODE123", "near_count": 3}


def sign(body, secret=SECRET):
    return base64.b64encode(hmac.new(secret.encode(), body, hashlib.sha256).digest()).decode()


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv("LINE_CHANNEL_SECRET", SECRET)
    monkeypatch.setenv("LINE_CHANNEL_ACCESS_TOKEN", TOKEN)


@pytest.fixture
def unconfigured(monkeypatch):
    for name in ("LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN", "LINE_OFFICIAL_ID"):
        monkeypatch.delenv(name, raising=False)


class FakeStore:
    def __init__(self, account="acc-1", registrations=None):
        self.account = account
        self.registrations = registrations if registrations is not None else [REG]
        self.seen = set()
        self.calls = []

    def line_webhook_seen(self, webhook_event_id):
        self.calls.append(("seen", webhook_event_id))
        if webhook_event_id in self.seen:
            return False
        self.seen.add(webhook_event_id)
        return True

    def account_by_line_sub(self, sub):
        self.calls.append(("account_by_line_sub", sub))
        return self.account

    def line_link_save(self, account, line_user_id, is_friend):
        self.calls.append(("link_save", account, line_user_id, is_friend))

    def line_link_unfollow(self, line_user_id):
        self.calls.append(("unfollow", line_user_id))

    def my_event_registrations(self, account_id):
        return self.registrations

    def event_set_late(self, **kw):
        self.calls.append(("late", kw))

    def event_cancel_registration(self, **kw):
        self.calls.append(("cancel", kw))

    def event_by_post(self, post_id):
        return self.events.get(post_id) if hasattr(self, "events") else None


def body_of(*events):
    return json.dumps({"destination": "U0", "events": list(events)}).encode()


def postback(data, event_id="e1", user="Uabc"):
    return {"type": "postback", "webhookEventId": event_id, "replyToken": "tok", "source": {"userId": user},
            "postback": {"data": data}}


class Recorder:
    """httpx.Client の代わり。送られたものを覚え、決めた状態で返す。"""

    def __init__(self, *statuses, json_body=None):
        self.statuses = list(statuses) or [200]
        self.requests = []
        self.json_body = json_body

    def request(self, method, url, **kwargs):
        self.requests.append((method, url, kwargs))
        status = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
        if isinstance(status, Exception):
            raise status
        return httpx.Response(status, json=self.json_body if self.json_body is not None else {})


def dump(value):
    return json.dumps(value, ensure_ascii=False)


# --- 署名 ---------------------------------------------------------------
def test_signature_right_and_wrong():
    body = b'{"events":[]}'
    assert line.verify_signature(body, sign(body), SECRET)
    assert not line.verify_signature(body, sign(body, "other"), SECRET)
    assert not line.verify_signature(body + b" ", sign(body), SECRET)
    assert not line.verify_signature(body, "", SECRET)
    assert not line.verify_signature(body, sign(body), "")


def test_webhook_route_checks_signature(configured):
    app = FastAPI()
    app.include_router(line.router)
    store = FakeStore()
    line.configure(lambda: store)
    client = TestClient(app)
    body = body_of({"type": "unfollow", "webhookEventId": "w1", "source": {"userId": "U1"}})
    assert client.post("/api/line/webhook", content=body, headers={"x-line-signature": "bad"}).status_code == 401
    assert client.post("/api/line/webhook", content=body).status_code == 401
    ok = client.post("/api/line/webhook", content=body, headers={"x-line-signature": sign(body)})
    assert ok.status_code == 200 and ok.json()["handled"] == 1
    assert ("unfollow", "U1") in store.calls
    junk = b"not json"
    assert client.post("/api/line/webhook", content=junk, headers={"x-line-signature": sign(junk)}).status_code == 400


def test_webhook_route_503_when_not_configured(unconfigured):
    app = FastAPI()
    app.include_router(line.router)
    line.configure(lambda: FakeStore())
    assert TestClient(app).post("/api/line/webhook", content=b"{}").status_code == 503


# --- 二重処理・振り分け ----------------------------------------------------
def test_duplicate_event_is_processed_once(configured):
    store = FakeStore()
    body = body_of({"type": "follow", "webhookEventId": "same", "source": {"userId": "U1"}})
    first = line.handle_webhook(body, sign(body), store)
    second = line.handle_webhook(body, sign(body), store)
    assert first["handled"] == 1 and second["duplicates"] == 1 and second["handled"] == 0
    assert [c for c in store.calls if c[0] == "link_save"] == [("link_save", "acc-1", "U1", True)]


def test_follow_unfollow_dispatch(configured):
    store = FakeStore()
    body = body_of({"type": "follow", "webhookEventId": "a", "source": {"userId": "U1"}},
                   {"type": "unfollow", "webhookEventId": "b", "source": {"userId": "U2"}})
    assert line.handle_webhook(body, sign(body), store)["handled"] == 2
    assert ("link_save", "acc-1", "U1", True) in store.calls
    assert ("unfollow", "U2") in store.calls


def test_follow_without_account_links_nothing(configured):
    store = FakeStore(account=None)
    assert line.handle_follow({"source": {"userId": "U1"}}, store) is False
    # 結べない友だちは、アカウント無し（None）で記録だけする（DB の line_pending_friends。あとで line_link_attach が結ぶ）
    assert [c for c in store.calls if c[0] == "link_save"] == [("link_save", None, "U1", True)]


def test_postback_late_cancel_flow(configured):
    store, http = FakeStore(), Recorder(200)
    line.handle_postback(postback("a=late&m=30"), store, now=NOW, client=http)
    assert ("late", {"event": "ev-1", "account": "acc-1", "minutes": 30}) in store.calls
    sent = http.requests[-1]
    assert sent[1].endswith("/v2/bot/message/reply") and "主催者に伝えました" in dump(sent[2]["json"])

    # キャンセルは、まず確認だけ。取り消しは cancel_yes のとき
    line.handle_postback(postback("a=cancel"), store, now=NOW, client=http)
    assert not [c for c in store.calls if c[0] == "cancel"]
    template = http.requests[-1][2]["json"]["messages"][0]["template"]
    assert template["type"] == "confirm" and template["actions"][0]["data"] == "a=cancel_yes&e=CODE123"
    line.handle_postback(postback("a=cancel_yes&e=CODE123"), store, now=NOW, client=http)
    assert ("cancel", {"event": "ev-1", "account": "acc-1"}) in store.calls


def test_postback_without_registration_or_bad_data(configured):
    http = Recorder(200)
    store = FakeStore(registrations=[])
    line.handle_postback(postback("a=late&m=10"), store, now=NOW, client=http)
    assert not [c for c in store.calls if c[0] == "late"]
    assert "見つかりませんでした" in dump(http.requests[-1][2]["json"])
    n = len(http.requests)
    line.handle_postback(postback("a=late&m=99"), store, now=NOW, client=http)
    line.handle_postback(postback("a=drop_table"), store, now=NOW, client=http)
    assert len(http.requests) == n


def test_postback_store_refusal_is_answered(configured):
    class Refused(Exception):
        code = "event_not_applied"

    def refuse(**kw):
        raise Refused("この会に申し込んでいません。")

    store, http = FakeStore(), Recorder(200)
    store.event_set_late = refuse
    line.handle_postback(postback("a=late&m=10"), store, now=NOW, client=http)
    assert "申し込んでいません" in dump(http.requests[-1][2]["json"])


def test_parse_postback():
    assert line.parse_postback("a=late&e=abc&m=10") == {"action": "late", "code": "abc", "minutes": 10}
    assert line.parse_postback("a=late&e=abc") == {"action": "late", "code": "abc", "minutes": None}
    assert line.parse_postback("a=page") == {"action": "page", "code": None, "minutes": None}
    assert line.parse_postback("a=cancel")["code"] is None
    assert line.parse_postback("a=late&m=5") is None
    assert line.parse_postback("a=late&e=a/b&m=10") is None
    assert line.parse_postback("a=cancel&a=cancel_yes") is None
    assert line.parse_postback(None) is None


def test_pick_registration_prefers_next_event():
    later = dict(REG, event_id="ev-2", public_code="LATER", starts_at="2026-11-20T10:00:00+00:00",
                 ends_at="2026-11-20T13:00:00+00:00")
    done = dict(REG, event_id="ev-0", starts_at="2026-11-01T10:00:00+00:00", ends_at="2026-11-01T13:00:00+00:00")
    gone = dict(REG, event_id="ev-9", status="cancelled")
    regs = [later, REG, done, gone]
    assert line.pick_registration(regs, None, NOW)["event_id"] == "ev-1"
    assert line.pick_registration(regs, "LATER", NOW)["event_id"] == "ev-2"
    assert line.pick_registration([done, gone], None, NOW) is None


# --- message の本文は残さない --------------------------------------------
def test_message_text_is_never_stored_or_logged(configured, caplog):
    store = FakeStore()
    secret_text = "ひみつの本文ABC123"
    message = {"type": "message", "webhookEventId": "m1", "replyToken": "t", "source": {"userId": "U1"},
               "message": {"type": "text", "id": "1", "text": secret_text}}
    body = body_of(message)
    with caplog.at_level(logging.DEBUG):
        result = line.handle_webhook(body, sign(body), store)
    assert result["ignored"] == 1 and result["handled"] == 0
    assert secret_text not in caplog.text and "U1" not in caplog.text
    assert store.calls == []  # 二重除けの記録にも入れない


def test_failures_log_no_user_or_body(configured, caplog):
    store = FakeStore()

    def boom(sub):
        raise RuntimeError("boom Uabc")

    store.account_by_line_sub = boom
    body = body_of(postback("a=late&m=10"))
    with caplog.at_level(logging.DEBUG):
        result = line.handle_webhook(body, sign(body), store, client=Recorder(200))
    assert result["failed"] == 1
    assert "Uabc" not in caplog.text and "boom" not in caplog.text


# --- 送る文 ---------------------------------------------------------------
@pytest.mark.parametrize("kind", line.KINDS)
def test_messages_have_no_island_no_names_and_fit(kind):
    event = dict(EVENT, display_name="山田花子", full_name="山田 花子")
    messages = line.build_message(kind, event, "https://example.test/")
    text = dump(messages)
    assert "島" not in text and "山田" not in text
    assert EVENT["title"] in text
    for message in messages:
        if message["type"] == "template":
            assert len(message["template"]["text"]) <= line.TEXT_LIMIT


def test_message_contents():
    week = dump(line.build_message("week_before", EVENT, "https://example.test"))
    assert "来週 11/13(金) 19:00 から" in week and "あなたに近い人が 3 人来ます" in week
    assert "https://example.test/#/e/CODE123/me" in week
    assert "近い人" not in dump(line.build_message("week_before", dict(EVENT, near_count=0), "https://x.test"))
    assert "今日 19:00 から" in dump(line.build_message("day_of", EVENT, "https://x.test"))
    after = dump(line.build_message("after", EVENT, "https://x.test"))
    assert "今日会った人を選んでみませんか" in after and "/#/e/CODE123/after" in after
    declined = dump(line.build_message("declined", EVENT, "https://x.test"))
    assert ("定員などの都合により、今回はご参加をお受けできないことになりました。"
            "またの機会にぜひお越しください。") in declined
    cancelled = dump(line.build_message("event_cancelled", EVENT, "https://x.test"))
    assert "中止になりました" in cancelled and "またお知らせ" not in cancelled
    assert "日時・場所が変わりました" in dump(line.build_message("event_changed", EVENT, "https://x.test"))


def test_unknown_kind_is_refused():
    with pytest.raises(ValueError):
        line.build_message("promo", EVENT, "https://x.test")


# --- 設定なし・429/5xx -----------------------------------------------------
def row():
    return dict(EVENT, id="out-1", kind="week_before", line_user_id="U1")


def test_unconfigured_sends_nothing(unconfigured):
    http = Recorder(200)
    assert not line.configured()
    result = line.send_outbound(row(), base_url="https://x.test", client=http)
    assert result == "not_configured" and http.requests == []
    assert line.push("U1", [{"type": "text", "text": "x"}], client=http) == "not_configured"
    assert line.reply("t", [], client=http) is False and line.monthly_quota(client=http) is None
    assert http.requests == []


def test_push_ok_sends_auth_and_retry_key(configured):
    http = Recorder(200)
    assert line.send_outbound(row(), base_url="https://x.test", client=http) == "ok"
    method, url, kw = http.requests[0]
    assert url.endswith("/v2/bot/message/push") and kw["headers"]["Authorization"] == f"Bearer {TOKEN}"
    assert kw["json"]["to"] == "U1" and kw["headers"]["X-Line-Retry-Key"]
    again = Recorder(200)
    line.send_outbound(row(), base_url="https://x.test", client=again)
    assert again.requests[0][2]["headers"]["X-Line-Retry-Key"] == kw["headers"]["X-Line-Retry-Key"]


@pytest.mark.parametrize("status, expected", [(429, "retry"), (500, "retry"), (503, "retry"),
                                              (403, "blocked"), (401, "error"), (200, "ok"), (409, "ok")])
def test_push_status_mapping(configured, status, expected):
    result = line.push("U1", [{"type": "text", "text": "x"}], client=Recorder(status))
    assert result == expected
    if expected in ("retry", "blocked", "error"):
        assert result.reason


def test_push_400_blocked_only_for_bad_recipient(configured):
    bad_to = Recorder(400, json_body={"message": "The property, 'to', in the request body is invalid"})
    assert line.push("U1", [], client=bad_to) == "blocked"
    other = Recorder(400, json_body={"message": "Invalid messages"})
    assert line.push("U1", [], client=other) == "error"


def test_push_network_error_is_retry(configured):
    result = line.push("U1", [], client=Recorder(httpx.ConnectTimeout("t")))
    assert result == "retry" and "ConnectTimeout" in result.reason


def test_monthly_quota(configured):
    class Two(Recorder):
        def request(self, method, url, **kw):
            body = {"type": "limited", "value": 200} if url.endswith("/quota") else {"totalUsage": 52}
            return httpx.Response(200, json=body)

    assert line.monthly_quota(client=Two()) == {"limit": 200, "used": 52, "remaining": 148}
    assert line.monthly_quota(client=Recorder(500)) is None


def test_rich_menu_payload():
    payload = line.rich_menu_payload()
    assert payload["size"] == {"width": 2500, "height": 843}
    datas = [a["action"]["data"] for a in payload["areas"]]
    assert datas == ["a=late", "a=cancel", "a=page"]
    assert all(line.parse_postback(d) for d in datas)
    assert sum(a["bounds"]["width"] for a in payload["areas"]) == 2500
    assert payload["areas"][-1]["bounds"]["x"] + payload["areas"][-1]["bounds"]["width"] == 2500
    assert len(payload["chatBarText"]) <= 14


def test_delete_other_rich_menus_only_touches_ours(configured):
    class Menus(Recorder):
        def request(self, method, url, **kw):
            self.requests.append((method, url, kw))
            if method == "GET":
                return httpx.Response(200, json={"richmenus": [
                    {"richMenuId": "new", "name": "islands イベント（遅れる・キャンセル・会のページ）"},
                    {"richMenuId": "old", "name": "islands イベント（遅れる・キャンセル）"},
                    {"richMenuId": "other", "name": "キャンペーン"}]}, request=httpx.Request(method, url))
            return httpx.Response(200, json={}, request=httpx.Request(method, url))

    http = Menus()
    assert line.delete_other_rich_menus("new", client=http) == 1
    assert [(m, u.rsplit("/", 1)[-1]) for m, u, _ in http.requests if m == "DELETE"] == [("DELETE", "old")]


# --- ボタン（2026-11-05） -----------------------------------------------------
def actions_of(messages):
    return messages[0]["template"]["actions"]


def test_applied_message_has_page_and_cancel():
    messages = line.build_message("applied", EVENT, "https://x.test")
    text = messages[0]["template"]["text"]
    assert "申し込みを受け付けました" in text and "11/13(金) 19:00 から" in text and "〇〇ビル 3階" in text
    actions = actions_of(messages)
    assert [a["label"] for a in actions] == ["会のページを開く", "申し込みを取り消す"]
    assert actions[0]["uri"] == "https://x.test/#/e/CODE123/me"
    assert actions[1]["data"] == "a=cancel&e=CODE123"


def test_week_and_day_buttons_carry_the_event_code():
    week = actions_of(line.build_message("week_before", EVENT, "https://x.test"))
    assert [a["label"] for a in week] == ["近い人を見る", "予定が合わなくなったら取り消す"]
    assert week[1]["data"] == "a=cancel&e=CODE123"
    day = line.build_message("day_of", EVENT, "https://x.test")
    assert "トークの下" not in dump(day)
    assert [a["label"] for a in actions_of(day)] == ["遅れる", "キャンセル", "会のページを開く"]
    assert [a.get("data") for a in actions_of(day)][:2] == ["a=late&e=CODE123", "a=cancel&e=CODE123"]
    for kind in line.KINDS:
        for action in line.build_message(kind, EVENT, "https://x.test")[0].get("template", {}).get("actions", []):
            assert len(action["label"]) <= 20
            if action["type"] == "postback":
                assert line.parse_postback(action["data"])["code"] == "CODE123"


def test_no_cancel_button_after_the_deadline():
    closed = dict(EVENT, cancel_deadline="2026-11-12T10:00:00+00:00")
    before = datetime(2026, 11, 12, 9, 0, tzinfo=timezone.utc)
    after = datetime(2026, 11, 12, 10, 0, tzinfo=timezone.utc)
    for kind in ("applied", "week_before", "day_of"):
        assert "a=cancel" in dump(line.build_message(kind, closed, "https://x.test", before))
        assert "a=cancel" not in dump(line.build_message(kind, closed, "https://x.test", after))
    assert "a=cancel" not in dump(line.build_message("day_of", dict(EVENT, can_cancel=False), "https://x.test"))
    assert [a["label"] for a in actions_of(line.build_message("day_of", closed, "https://x.test", after))] == [
        "遅れる", "会のページを開く"]


def test_late_without_minutes_asks_how_late(configured):
    store, http = FakeStore(), Recorder(200)
    line.handle_postback(postback("a=late&e=CODE123"), store, now=NOW, client=http)
    assert not [c for c in store.calls if c[0] == "late"]
    message = http.requests[-1][2]["json"]["messages"][0]
    assert "どのくらい遅れますか" in message["text"]
    items = [i["action"] for i in message["quickReply"]["items"]]
    assert [i["label"] for i in items] == ["10分くらい", "30分くらい", "1時間以上"]
    assert [i["data"] for i in items] == ["a=late&e=CODE123&m=10", "a=late&e=CODE123&m=30", "a=late&e=CODE123&m=60"]
    line.handle_postback(postback(items[1]["data"]), store, now=NOW, client=http)
    assert ("late", {"event": "ev-1", "account": "acc-1", "minutes": 30}) in store.calls


def test_rich_menu_with_two_events_asks_which_one_first(configured):
    later = dict(REG, event_id="ev-2", public_code="LATER", title="もう1つの会",
                 starts_at="2026-11-20T10:00:00+00:00", ends_at="2026-11-20T13:00:00+00:00")
    store, http = FakeStore(registrations=[later, REG]), Recorder(200)
    for data in ("a=late", "a=cancel"):
        line.handle_postback(postback(data), store, now=NOW, client=http)
        message = http.requests[-1][2]["json"]["messages"][0]
        assert message["text"] == "どの会ですか？"
        items = [i["action"] for i in message["quickReply"]["items"]]
        assert [i["data"] for i in items] == [f"{data}&e=CODE123", f"{data}&e=LATER"]
        assert items[0]["label"].startswith("11/13(金) ") and all(len(i["label"]) <= 20 for i in items)
    # どれも、選ぶまでは何も変えない
    assert not [c for c in store.calls if c[0] in ("late", "cancel")]
    # 会のページは、選んだらそのまま開くリンク
    line.handle_postback(postback("a=page"), store, now=NOW, client=http, base_url="https://x.test")
    items = [i["action"] for i in http.requests[-1][2]["json"]["messages"][0]["quickReply"]["items"]]
    assert [i["uri"] for i in items] == ["https://x.test/#/e/CODE123/me", "https://x.test/#/e/LATER/me"]


def test_rich_menu_with_one_event_goes_straight_on(configured):
    store, http = FakeStore(), Recorder(200)
    line.handle_postback(postback("a=page"), store, now=NOW, client=http, base_url="https://x.test")
    template = http.requests[-1][2]["json"]["messages"][0]["template"]
    assert template["actions"][0]["uri"] == "https://x.test/#/e/CODE123/me"
    line.handle_postback(postback("a=cancel"), store, now=NOW, client=http)
    template = http.requests[-1][2]["json"]["messages"][0]["template"]
    assert template["type"] == "confirm" and template["text"] == "The Night Office BAR #2 の申し込みを取り消しますか？"


def test_cancel_after_the_deadline_points_to_the_host(configured):
    store, http = FakeStore(), Recorder(200)
    store.events = {"ev-1": {"cancel_deadline": "2026-11-12T10:00:00+00:00"}}
    for data in ("a=cancel&e=CODE123", "a=cancel_yes&e=CODE123"):
        line.handle_postback(postback(data), store, now=NOW, client=http)
        assert "期限後のキャンセルは主催者に連絡してください" in dump(http.requests[-1][2]["json"])
    assert not [c for c in store.calls if c[0] == "cancel"]
    # 期限の前なら、いつもどおり確認が出る
    store.events = {"ev-1": {"cancel_deadline": "2026-11-13T09:00:00+00:00"}}
    line.handle_postback(postback("a=cancel&e=CODE123"), store, now=NOW, client=http)
    assert http.requests[-1][2]["json"]["messages"][0]["template"]["type"] == "confirm"


def test_webhook_route_passes_the_page_link(configured, monkeypatch):
    monkeypatch.setenv("ISLANDS_PUBLIC_BASE_URL", "https://islands.example/")
    seen = {}
    monkeypatch.setattr(line, "handle_webhook", lambda *a, **kw: seen.update(kw) or {"handled": 0})
    app = FastAPI()
    app.include_router(line.router)
    line.configure(lambda: FakeStore())
    body = body_of()
    response = TestClient(app).post("/api/line/webhook", content=body, headers={"x-line-signature": sign(body)})
    assert response.status_code == 200
    assert seen["base_url"] == "https://islands.example"


def test_old_rich_menu_minutes_survive_choosing_the_event(configured):
    later = dict(REG, event_id="ev-2", public_code="LATER", starts_at="2026-11-20T10:00:00+00:00",
                 ends_at="2026-11-20T13:00:00+00:00")
    store, http = FakeStore(registrations=[later, REG]), Recorder(200)
    line.handle_postback(postback("a=late&m=10"), store, now=NOW, client=http)
    items = [i["action"] for i in http.requests[-1][2]["json"]["messages"][0]["quickReply"]["items"]]
    assert [i["data"] for i in items] == ["a=late&e=CODE123&m=10", "a=late&e=LATER&m=10"]


def test_public_base_url_uses_https_outside_this_machine(monkeypatch):
    monkeypatch.delenv("ISLANDS_PUBLIC_BASE_URL", raising=False)

    class Req:
        def __init__(self, base):
            self.base_url = base

    assert line.public_base_url(Req("http://islands-x.a.run.app/")) == "https://islands-x.a.run.app"
    assert line.public_base_url(Req("https://islands-x.a.run.app/")) == "https://islands-x.a.run.app"
    assert line.public_base_url(Req("http://localhost:7860/")) == "http://localhost:7860"
    assert line.public_base_url(Req("http://testserver/")) == "http://testserver"
