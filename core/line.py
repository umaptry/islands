"""LINE 公式アカウントの部分（イベント申し込み）。送る・受け取る・結ぶ。

- 送る：Messaging API の push（httpx）。種類ごとの文は `build_message`。
- 受け取る：`POST /api/line/webhook`。署名を確かめ、`webhookEventId` で二重処理を防ぎ、
  follow（結ぶ）・unfollow・postback（遅れる・キャンセル）を振り分ける。
- 規約（E の 1〜3・14）：message の本文は保存もログもしない。プロフィール API は呼ばない。
  送る文は会の名前・日時・場所・リンク（と近い人の数）だけで、人の名前を入れない。
  案内の種類は 1週間前・開始3時間前・終了時・お断り・中止・変更だけ。
- 返事（reply）は通数に数えない。遅れる・キャンセルの自動の返事はこちらを使う。

webhook の関数は `store`（core/store_events.py のストア）を引数で受け取る。使うメソッドは D 3-6 の名前どおり：
account_by_line_sub / line_link_save / line_link_unfollow / line_webhook_seen / my_event_registrations /
event_set_late / event_cancel_registration。

LINE の結びつき：follow の userId を account_by_line_sub で引く。見つかれば line_link_save(account, userId, True)、
見つからなければ line_link_save(None, userId, True)（line_pending_friends に記録。あとで申し込み・ログインのときに
core/events.py が line_link_attach で結ぶ）。userId ＝ ログインの sub という前提は未確認（D の 7 章 23・24）。
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from core.config import (
    LATE_CHOICES,
    LINE_API_BASE,
    LINE_DATA_API_BASE,
    LINE_TEXT_LIMIT as TEXT_LIMIT,
    LINE_TIMEOUT_SECONDS,
    LINE_WEBHOOK_MAX_BYTES,
    OUTBOUND_KINDS as KINDS,
)

log = logging.getLogger("islands.line")

JST = timezone(timedelta(hours=9))
WEEKDAYS = "月火水木金土日"


def channel_secret():
    return os.environ.get("LINE_CHANNEL_SECRET", "").strip()


def access_token():
    return os.environ.get("LINE_CHANNEL_ACCESS_TOKEN", "").strip()


def official_id():
    """公式アカウントの ID（@から始まる）。友だち追加のリンクを組み立てたい画面側が使う。"""
    return os.environ.get("LINE_OFFICIAL_ID", "").strip()


def configured():
    """送る・受け取るのに必要な 2 つ（秘密とトークン）がそろっているか。"""
    return bool(channel_secret() and access_token())


class PushResult(str):
    """push の結果。文字列として比べられ（"ok" など）、`reason` に失敗の理由が入る。

    "ok"（送れた）／"blocked"（友だちでない）／"retry"（あとで送り直す）／
    "error"（直さないと送れない）／"not_configured"（設定なし。何も送っていない）。
    reason に本文や人の名前は入れない。
    """

    def __new__(cls, value, reason=None):
        obj = super().__new__(cls, value)
        obj.reason = reason
        return obj


# ---------------------------------------------------------------------------
# 署名
# ---------------------------------------------------------------------------
def verify_signature(body, signature, secret):
    """x-line-signature（本文の HMAC-SHA256 を base64 にしたもの）を確かめる。"""
    if not secret or not signature:
        return False
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).digest()
    expected = base64.b64encode(digest).decode("ascii")
    return hmac.compare_digest(expected.encode("ascii"), str(signature).strip().encode("utf-8"))


# ---------------------------------------------------------------------------
# HTTP の下回り
# ---------------------------------------------------------------------------
def _headers(extra=None):
    headers = {"Authorization": f"Bearer {access_token()}"}
    if extra:
        headers.update(extra)
    return headers


def _request(method, url, *, client=None, **kwargs):
    kwargs.setdefault("timeout", LINE_TIMEOUT_SECONDS)
    if client is not None:
        return client.request(method, url, **kwargs)
    return httpx.request(method, url, **kwargs)


def _error_text(response):
    """LINE の返事の message だけ取り出す（本文全体や送り先は残さない）。"""
    try:
        return str(response.json().get("message", ""))[:200]
    except (ValueError, AttributeError):
        return ""


def push(line_user_id, messages, *, client=None, retry_key=None):
    """1 人に push する。PushResult を返す（"ok"／"blocked"／"retry"／"error"／"not_configured"）。

    retry_key を同じ値で送り直せば、LINE 側で二重配信にならない（409＝すでに受け付け済み＝ok）。
    """
    if not configured():
        return PushResult("not_configured", "LINE の設定がありません")
    headers = _headers({"Content-Type": "application/json"})
    if retry_key:
        headers["X-Line-Retry-Key"] = retry_key
    payload = {"to": line_user_id, "messages": messages}
    try:
        response = _request("POST", f"{LINE_API_BASE}/v2/bot/message/push", client=client,
                            json=payload, headers=headers)
    except httpx.HTTPError as error:
        return PushResult("retry", f"通信に失敗しました（{type(error).__name__}）")
    code = response.status_code
    if 200 <= code < 300 or code == 409:
        return PushResult("ok")
    if code == 429 or code >= 500:
        return PushResult("retry", f"LINE が {code} を返しました")
    detail = _error_text(response)
    if code == 403:
        return PushResult("blocked", f"友だちではありません（{code}）")
    if code == 400 and "'to'" in detail:
        return PushResult("blocked", "送り先が正しくありません（友だちではない）")
    return PushResult("error", f"LINE が {code} を返しました：{detail}")


def reply(reply_token, messages, *, client=None):
    """reply API（通数に数えない）。失敗しても例外にしない。True なら届いた。"""
    if not configured() or not reply_token:
        return False
    try:
        response = _request("POST", f"{LINE_API_BASE}/v2/bot/message/reply", client=client,
                            json={"replyToken": reply_token, "messages": messages},
                            headers=_headers({"Content-Type": "application/json"}))
    except httpx.HTTPError as error:
        log.warning("LINE reply failed: %s", type(error).__name__)
        return False
    if not 200 <= response.status_code < 300:
        log.warning("LINE reply failed: %s", response.status_code)
        return False
    return True


def monthly_quota(*, client=None):
    """{"limit":200,"used":52,"remaining":148}。取れなければ None。limit が無制限なら limit/remaining は None。"""
    if not configured():
        return None
    try:
        quota = _request("GET", f"{LINE_API_BASE}/v2/bot/message/quota", client=client, headers=_headers())
        used = _request("GET", f"{LINE_API_BASE}/v2/bot/message/quota/consumption", client=client,
                        headers=_headers())
        if quota.status_code != 200 or used.status_code != 200:
            return None
        quota_json, used_json = quota.json(), used.json()
        count = int(used_json.get("totalUsage", 0))
    except (httpx.HTTPError, ValueError, TypeError):
        return None
    if quota_json.get("type") != "limited":
        return {"limit": None, "used": count, "remaining": None}
    limit = int(quota_json.get("value", 0))
    return {"limit": limit, "used": count, "remaining": max(limit - count, 0)}


# ---------------------------------------------------------------------------
# 送る文
# ---------------------------------------------------------------------------
def _dt(value):
    if isinstance(value, datetime):
        moment = value
    else:
        text = str(value).strip().replace("Z", "+00:00")
        moment = datetime.fromisoformat(text)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(JST)


def _clock(moment):
    return f"{moment.hour}:{moment.minute:02d}"


def _day(moment):
    return f"{moment.month}/{moment.day}({WEEKDAYS[moment.weekday()]})"


def _clip(text, limit):
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _link(base_url, code, page):
    return f"{base_url.rstrip('/')}/#/e/{code}/{page}"


def _template(text, label, uri):
    text = _clip(text, TEXT_LIMIT)
    return [{
        "type": "template",
        "altText": _clip(text.replace("\n", " "), 400),
        "template": {
            "type": "buttons",
            "text": text,
            "actions": [{"type": "uri", "label": label[:20], "uri": uri}],
        },
    }]


def _near_line(event):
    count = event.get("near_count")
    if isinstance(count, int) and not isinstance(count, bool) and count > 0:
        return f"あなたに近い人が {count} 人来ます"
    return ""


def build_message(kind, event, base_url):
    """種類ごとの文＋ボタン。event は title・starts_at・ends_at・place・public_code（と near_count）。

    人の名前は入れない。新しい文に「島」は使わない。
    """
    if kind not in KINDS:
        raise ValueError(f"unknown kind: {kind}")
    title = str(event.get("title") or "この会")
    code = event["public_code"]
    place = str(event.get("place") or "").strip()
    start = _dt(event["starts_at"]) if event.get("starts_at") else None
    when = f"{_day(start)} {_clock(start)}" if start else ""
    near = _near_line(event)

    if kind == "week_before":
        lines = [f"{title} は来週 {when} から。"]
        if place:
            lines.append(f"場所：{place}")
        if near:
            lines.append(near)
        label = "近い人を見る" if near else "会のページを開く"
        return _template("\n".join(lines), label, _link(base_url, code, "me"))

    if kind == "day_of":
        lines = [f"{title} は今日 {_clock(start)} から。"]
        if place:
            lines.append(f"場所：{place}")
        lines.append("遅れるときは、トークの下のボタンを押してください。")
        return _template("\n".join(lines), "会のページを開く", _link(base_url, code, "me"))

    if kind == "after":
        lines = [f"{title} はお疲れさまでした。", "今日会った人を選んでみませんか。"]
        return _template("\n".join(lines), "会った人を選ぶ", _link(base_url, code, "after"))

    if kind == "declined":
        text = (f"{title} について。\n定員などの都合により、今回はご参加をお受けできないことになりました。"
                "またの機会にぜひお越しください。")
        return [{"type": "text", "text": text}]

    if kind == "event_cancelled":
        lines = [f"{title}（{_day(start)}）は中止になりました。" if start else f"{title} は中止になりました。",
                 "申し込みは取り消されています。"]
        return _template("\n".join(lines), "ページを開く", _link(base_url, code, "me"))

    # event_changed
    lines = [f"{title} の日時・場所が変わりました。"]
    if start:
        lines.append(f"新しい日時：{when} から")
    if place:
        lines.append(f"場所：{place}")
    return _template("\n".join(lines), "会のページを開く", _link(base_url, code, "me"))


def send_outbound(row, *, base_url, client=None):
    """outbound_claim の 1 行を送る。PushResult を返す。

    "blocked" のときは呼び出し側が line_link_unfollow を呼ぶ。
    "not_configured" のときは何も送っていない（呼び出し側は失敗に数えず、予約を残す）。
    """
    if not configured():
        return PushResult("not_configured", "LINE の設定がありません")
    try:
        messages = build_message(row["kind"], row, base_url)
    except (KeyError, ValueError, TypeError) as error:
        return PushResult("error", f"文を作れませんでした（{type(error).__name__}）")
    # 同じ行（予約の id）は、送り直しても LINE 側で 1 通にまとまる。
    retry_key = str(uuid.uuid5(uuid.NAMESPACE_URL, str(row["id"]))) if row.get("id") else None
    return push(row["line_user_id"], messages, client=client, retry_key=retry_key)


# ---------------------------------------------------------------------------
# postback
# ---------------------------------------------------------------------------
def parse_postback(data):
    """"a=late&e=<code>&m=10" → {"action","code","minutes"}。決まりに合わなければ None。

    action は late・cancel・cancel_yes・cancel_no。e（会のコード）は無くてもよい
    （リッチメニューは会を決めずに押されるので、その人の今日か次の会を探す）。
    """
    if not isinstance(data, str) or len(data) > 300:
        return None
    pairs = {}
    for part in data.split("&"):
        key, _, value = part.partition("=")
        if key in pairs:
            return None
        pairs[key] = value
    action = pairs.get("a")
    if action not in ("late", "cancel", "cancel_yes", "cancel_no"):
        return None
    code = pairs.get("e") or None
    if code is not None and not all(ch.isalnum() or ch in "-_" for ch in code):
        return None
    minutes = None
    if action == "late":
        try:
            minutes = int(pairs.get("m", ""))
        except ValueError:
            return None
        if minutes not in LATE_CHOICES:
            return None
    return {"action": action, "code": code, "minutes": minutes}


def _text(text):
    return [{"type": "text", "text": text}]


def _registration_event_id(reg):
    return reg.get("event_id") or reg.get("post_id")


def pick_registration(registrations, code=None, now=None):
    """申し込み中（applied）で、まだ終わっていない会のうち、コードが合うもの。
    コードが無ければ、始まりがいちばん近い（今日か次の）会。無ければ None。"""
    now = now or datetime.now(timezone.utc)
    best = None
    for reg in registrations or []:
        if reg.get("status") != "applied" or reg.get("cancelled_at"):
            continue
        if reg.get("ends_at") and _dt(reg["ends_at"]) < now:
            continue
        if code is not None and reg.get("public_code") != code:
            continue
        key = _dt(reg["starts_at"]) if reg.get("starts_at") else datetime.max.replace(tzinfo=JST)
        if best is None or key < best[0]:
            best = (key, reg)
    return best[1] if best else None


def _refusal_text(error):
    """ストアが断ったときの文（日本語の 1 文）。無ければ決まり文句。"""
    text = str(error).strip()
    if getattr(error, "code", None) and text and len(text) <= 80:
        return text
    return "受け付けられませんでした。会のページから操作してください。"


def handle_postback(event, store, *, now=None, client=None):
    """遅れる・キャンセル。主催者への通知は DB 関数が入れる。返事は reply API（通数に数えない）。"""
    token = event.get("replyToken")
    user_id = (event.get("source") or {}).get("userId")
    parsed = parse_postback((event.get("postback") or {}).get("data"))
    if not user_id or parsed is None:
        return

    def say(text):
        reply(token, _text(text), client=client)

    account = store.account_by_line_sub(user_id)
    if not account:
        say("islands のログインとつながっていないため、操作できませんでした。会のページから操作してください。")
        return
    # 友だちなのに結べていなかった人も、ボタンを押した時点で結ぶ（本文は読まない）。
    store.line_link_save(account, user_id, True)

    action = parsed["action"]
    if action == "cancel_no":
        say("そのままにしました。")
        return
    reg = pick_registration(store.my_event_registrations(account), parsed["code"], now)
    if reg is None:
        say("申し込み中の会が見つかりませんでした。")
        return
    event_id = _registration_event_id(reg)
    title = str(reg.get("title") or "この会")

    try:
        if action == "late":
            store.event_set_late(event=event_id, account=account, minutes=parsed["minutes"])
            say(f"受け取りました。{title} の主催者に伝えました。")
        elif action == "cancel":
            code = reg.get("public_code") or ""
            confirm = [{
                "type": "template",
                "altText": f"{title} の申し込みを取り消しますか？",
                "template": {
                    "type": "confirm",
                    "text": _clip(f"{title} の申し込みを取り消しますか？", 240),
                    "actions": [
                        {"type": "postback", "label": "取り消す", "data": f"a=cancel_yes&e={code}",
                         "displayText": "取り消す"},
                        {"type": "postback", "label": "やめる", "data": "a=cancel_no",
                         "displayText": "やめる"},
                    ],
                },
            }]
            reply(token, confirm, client=client)
        else:  # cancel_yes
            store.event_cancel_registration(event=event_id, account=account)
            say(f"{title} の申し込みを取り消しました。")
    except Exception as error:  # ストアの断り（Refused）もここへ。理由の文だけ返し、本文は残さない
        log.info("LINE postback refused: %s", type(error).__name__)
        say(_refusal_text(error))


# ---------------------------------------------------------------------------
# follow / unfollow
# ---------------------------------------------------------------------------
def handle_follow(event, store):
    """友だち追加。LINE の userId を、ログインの sub と同じとみて islands のアカウントに結ぶ（True）。
    結べなければ（まだログインしていない人）、記録だけして False。"""
    user_id = (event.get("source") or {}).get("userId")
    if not user_id:
        return False
    account = store.account_by_line_sub(user_id)
    if not account:
        # まだログインしていない友だち：userId と友だちの状態だけ記録する（あとで line_link_attach が結ぶ）
        log.info("LINE follow: no matching account")
        store.line_link_save(None, user_id, True)
        return False
    store.line_link_save(account, user_id, True)
    return True


def handle_unfollow(event, store):
    user_id = (event.get("source") or {}).get("userId")
    if user_id:
        store.line_link_unfollow(user_id)


# ---------------------------------------------------------------------------
# webhook
# ---------------------------------------------------------------------------
class InvalidSignature(ValueError):
    pass


class BadPayload(ValueError):
    pass


def handle_webhook(body, signature, store, *, now=None, client=None, secret=None):
    """署名 → 各イベントを line_webhook_seen で二重除け → follow／unfollow／postback。

    署名が違えば InvalidSignature、JSON でなければ BadPayload。message などほかのイベントは
    中身を読まずに無視する。戻りは {"handled","duplicates","ignored","failed"} の数。
    """
    secret = channel_secret() if secret is None else secret
    if not verify_signature(body, signature, secret):
        raise InvalidSignature("signature mismatch")
    try:
        payload = json.loads(body.decode("utf-8"))
        events = payload.get("events", [])
        if not isinstance(events, list):
            raise ValueError
    except (ValueError, UnicodeDecodeError, AttributeError) as error:
        raise BadPayload("invalid json") from error

    result = {"handled": 0, "duplicates": 0, "ignored": 0, "failed": 0}
    for event in events:
        if not isinstance(event, dict):
            result["ignored"] += 1
            continue
        kind = event.get("type")
        if kind not in ("follow", "unfollow", "postback"):
            result["ignored"] += 1  # message などは中身を見ない・残さない
            continue
        event_id = event.get("webhookEventId")
        if event_id and not store.line_webhook_seen(str(event_id)):
            result["duplicates"] += 1
            continue
        try:
            if kind == "follow":
                handle_follow(event, store)
            elif kind == "unfollow":
                handle_unfollow(event, store)
            else:
                handle_postback(event, store, now=now, client=client)
            result["handled"] += 1
        except Exception as error:  # 1 件の失敗で残りを止めない。理由の種類だけ記録
            log.warning("LINE webhook %s failed: %s", kind, type(error).__name__)
            result["failed"] += 1
    return result


router = APIRouter()
_store_getter = None
_base_url_getter = None


def configure(store_getter, base_url_getter=None):
    """app.py が起動のときに 1 回呼ぶ：line.configure(lambda: state["store"])。"""
    global _store_getter, _base_url_getter
    _store_getter = store_getter
    _base_url_getter = base_url_getter


@router.post("/api/line/webhook")
async def line_webhook(request: Request):
    secret = channel_secret()
    if not secret or _store_getter is None:
        return JSONResponse({"detail": "LINE は設定されていません。"}, status_code=503)
    body = await request.body()
    if len(body) > LINE_WEBHOOK_MAX_BYTES:
        return JSONResponse({"detail": "too large"}, status_code=413)
    signature = request.headers.get("x-line-signature", "")
    store = _store_getter()
    try:
        result = await run_in_threadpool(handle_webhook, body, signature, store, secret=secret)
    except InvalidSignature:
        return JSONResponse({"detail": "bad signature"}, status_code=401)
    except BadPayload:
        return JSONResponse({"detail": "bad request"}, status_code=400)
    return result


# ---------------------------------------------------------------------------
# リッチメニュー（作るのは scripts/line_richmenu.py。API ではない）
# ---------------------------------------------------------------------------
RICH_MENU_SIZE = (2500, 843)
RICH_MENU_BUTTONS = (
    ("10分くらい遅れる", "a=late&m=10"),
    ("30分くらい遅れる", "a=late&m=30"),
    ("1時間以上遅れる", "a=late&m=60"),
    ("キャンセル", "a=cancel"),
)


def rich_menu_payload():
    width, height = RICH_MENU_SIZE
    cell = width // len(RICH_MENU_BUTTONS)
    areas = []
    for index, (label, data) in enumerate(RICH_MENU_BUTTONS):
        areas.append({
            "bounds": {"x": index * cell, "y": 0, "width": cell, "height": height},
            "action": {"type": "postback", "label": label[:20], "data": data, "displayText": label},
        })
    return {
        "size": {"width": width, "height": height},
        "selected": True,
        "name": "islands イベント（遅れる・キャンセル）",
        "chatBarText": "遅れる・キャンセル",
        "areas": areas,
    }


def setup_rich_menu(image=None, *, client=None):
    """リッチメニューを作り、画像（PNG のバイト列）を付け、全員の既定にする。メニューの id を返す。
    実際に LINE へ送るので、呼ぶのは scripts/line_richmenu.py の --apply だけ。"""
    if not configured():
        raise RuntimeError("LINE_CHANNEL_ACCESS_TOKEN がありません。")
    created = _request("POST", f"{LINE_API_BASE}/v2/bot/richmenu", client=client, json=rich_menu_payload(),
                       headers=_headers({"Content-Type": "application/json"}))
    created.raise_for_status()
    menu_id = created.json()["richMenuId"]
    if image is not None:
        _request("POST", f"{LINE_DATA_API_BASE}/v2/bot/richmenu/{menu_id}/content", client=client,
                 content=image, headers=_headers({"Content-Type": "image/png"})).raise_for_status()
    _request("POST", f"{LINE_API_BASE}/v2/bot/user/all/richmenu/{menu_id}", client=client,
             headers=_headers()).raise_for_status()
    return menu_id
