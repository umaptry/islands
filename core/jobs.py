"""予約送信と片付け（2026-11-01 第2回a。D_関数の取り決め 3-5）。

pg_cron が毎分、送るものがあるときだけ POST /api/jobs/tick を呼ぶ（秘密のヘッダー X-Jobs-Secret）。
返事を返す前に送り終える（Cloud Run は返事のあと CPU が絞られうる）。

  schedule_times   week_before（開始の7日前）・day_of（開始の3時間前）・after（終了時）の時刻。過ぎた分は作らない。
                   DB の event_apply と同じ計算（テストで両方を比べる）。
  run_tick         開催の判定（event_settle_due：判定日を過ぎた会を開催決定／中止に）→ outbound_claim →
                   1通ずつ送る → outbound_done。そのあと片付け。
  run_cleanup      event_cleanup（保存期間：予約は会の7日後に全部、webhook は30日、probe は翌日）→
                   account_ids を管理 API で消す。

送る道は core/line.py の send_outbound(row, base_url=...)（戻りは "ok"／"blocked"／"retry"／"error"／
"not_configured"。文字列として比べられ、.reason に理由）。手元（ISLANDS_LINE_FAKE=1、または LINE の設定が無い
MemoryStore）では送らず、送る文を MemoryStore の _sent_messages に積むだけ。
"""

import hmac
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request

from core import line
from core.config import (
    EVENT_REMIND_DAY_HOURS,
    EVENT_REMIND_WEEK_DAYS,
    MATCH_COSINE_SAME,
    OUTBOUND_BATCH,
)

router = APIRouter()
log = logging.getLogger("islands.jobs")

JOBS_AUTH_ERROR = "認証に失敗しました。"


def _utc(value=None):
    if value is None:
        return datetime.now(timezone.utc)
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def schedule_times(event, now=None):
    """{"week_before", "day_of", "after"} のうち、まだ来ていない時刻だけ。event は starts_at・ends_at を持つ辞書。

    1週間前より後に申し込んだ人には、1週間前の分は作られない（時刻が過ぎているから）。"""
    now = _utc(now)
    starts, ends = _utc(event["starts_at"]), _utc(event["ends_at"])
    times = {
        "week_before": starts - timedelta(days=EVENT_REMIND_WEEK_DAYS),
        "day_of": starts - timedelta(hours=EVENT_REMIND_DAY_HOURS),
        "after": ends,
    }
    return {kind: when for kind, when in times.items() if when > now}


def verify_secret(header, secret):
    """秘密のヘッダーの比べ。secret が空なら False。"""
    if not secret or not header:
        return False
    return hmac.compare_digest(str(header).encode("utf-8"), str(secret).encode("utf-8"))


def _cosine(a, b):
    import numpy as np
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    denominator = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(a @ b) / denominator if denominator else 0.0


def near_count(store, event_id, account):
    """week_before の「あなたに近い人が N 人来ます」。DB の outbound_claim は near_count を出せない（常に null）ので、
    ここで埋める。回答（event_answers）のある人どうしだけ：自分の回答が無い人（メンバー）は None。0 人も None
    （LINE の文はその行を出さない）。"""
    rows = store.event_answer_vectors(event_id)
    mine = [row["vec_c"] for row in rows if row["account_id"] == account and row.get("vec_c") is not None]
    if not mine:
        return None
    others = {}
    for row in rows:
        if row["account_id"] != account and row.get("vec_c") is not None:
            others.setdefault(row["account_id"], []).append(row["vec_c"])
    count = sum(1 for theirs in others.values()
                if any(_cosine(a, b) >= MATCH_COSINE_SAME for a in mine for b in theirs))
    return count or None


def _with_near(store, row):
    """week_before の行に near_count を足す（失敗しても送る＝その行を出さないだけ）。"""
    if row.get("kind") != "week_before" or row.get("near_count") is not None:
        return row
    try:
        count = near_count(store, row["event_id"], row["account_id"])
    except Exception:
        log.exception("could not count the people near")
        return row
    return {**row, "near_count": count}


def _fake_sender(store):
    def send(row, *, base_url="", client=None):
        store.record_sent(row, line.build_message(row["kind"], row, base_url))
        return "ok"
    return send


def default_sender(store):
    """送る関数。使えないとき（LINE の設定も代役も無い）は None。"""
    configured = line.configured()
    if os.environ.get("ISLANDS_LINE_FAKE") == "1" or (
            getattr(store, "backend", "") == "memory" and not configured and hasattr(store, "record_sent")):
        return _fake_sender(store)
    if not configured:
        return None
    return line.send_outbound


def run_cleanup(store, *, now=None):
    """保存期間の片付け。アカウントごと消す人は管理 API で（失敗は記録して続ける）。"""
    result = store.event_cleanup(now) if now is not None else store.event_cleanup()
    deleted = 0
    for account_id in result.get("account_ids") or []:
        try:
            store.delete_auth_user(account_id)
            deleted += 1
        except Exception:
            log.exception("could not delete an account made by an event application")
    return {**result, "deleted_accounts": deleted}


def settle_due(store, *, now=None):
    """判定日を過ぎた会を判定する（中止になった会の未送信は DB 関数が消すので、このあと取り出されない）。
    第2回b の SQL がまだの DB では何もしない。判定した会があれば公開ページのキャッシュを消す。"""
    if not getattr(store, "supports_events_b", False):
        return 0
    try:
        settled = store.event_settle_due(now) if now is not None and getattr(store, "backend", "") == "memory"             else store.event_settle_due()
    except Exception:
        log.exception("settling the events failed")
        return 0
    if settled:
        try:
            from core import events
            events.clear_cache()
        except Exception:
            pass
    return int(settled or 0)


def run_tick(store, *, now=None, sender=None, base_url="", budget_seconds=20, cleanup=True):
    """判定日を過ぎた会を判定し、送る時刻が来た予約を送り、片付ける。
    戻りは {"sent","failed","skipped","cleaned","settled"}。"""
    settled = settle_due(store, now=now)
    sender = sender or default_sender(store)
    sent = failed = skipped = 0
    if sender is None:
        # LINE の設定が無い：取り出さない（取り出すと回数だけ減る）。設定が入れば次の tick で送る。
        log.info("LINE is not configured; nothing was claimed")
    else:
        started = time.monotonic()
        kwargs = {"now": now} if now is not None and getattr(store, "backend", "") == "memory" else {}
        for row in store.outbound_claim(OUTBOUND_BATCH, **kwargs):
            if time.monotonic() - started > budget_seconds:
                break      # 残りは貸し出しの期限（5分）がすぎたら次の tick が取り戻す
            row = _with_near(store, row)
            try:
                result = sender(row, base_url=base_url)
            except Exception as error:
                log.exception("sending an outbound message failed")
                result = "error"
                reason = type(error).__name__
            else:
                reason = getattr(result, "reason", None)
            outcome = str(result)
            if outcome == "ok":
                store.outbound_done(row["id"], True)
                sent += 1
            elif outcome == "blocked":
                store.line_link_unfollow(row["line_user_id"])
                store.outbound_done(row["id"], False, "blocked")
                skipped += 1
            elif outcome == "not_configured":
                skipped += 1          # 失敗に数えない。予約は残る
            else:
                store.outbound_done(row["id"], False, reason or outcome)
                failed += 1
    cleaned = {"registrations": 0, "answers": 0, "outbound": 0, "webhook_events": 0, "probe_hits": 0,
               "account_ids": []}
    if cleanup:
        try:
            cleaned = run_cleanup(store, now=now)
        except Exception:
            log.exception("event cleanup failed")
    return {"sent": sent, "failed": failed, "skipped": skipped, "cleaned": cleaned, "settled": settled}


def _host():
    return sys.modules.get("app") or sys.modules.get("__main__")


@router.post("/api/jobs/tick")
def jobs_tick(request: Request):
    secret = os.environ.get("ISLANDS_JOBS_SECRET", "").strip()
    if not secret:
        raise HTTPException(status_code=404, detail="not found")
    if not verify_secret(request.headers.get("x-jobs-secret"), secret):
        raise HTTPException(status_code=401, detail=JOBS_AUTH_ERROR)
    base_url = os.environ.get("ISLANDS_PUBLIC_BASE_URL", "").strip().rstrip("/") or str(request.base_url).rstrip("/")
    return run_tick(_host().state["store"], base_url=base_url)
