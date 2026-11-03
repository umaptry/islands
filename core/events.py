"""会（イベント申し込み）の API（2026-11-01 第2回a。D_関数の取り決め 3 章）。

  純粋な関数   clean_event・clean_questions・clean_profile・checkin_window・window_state・bucket・blur・event_view
               （DB にも app.py にも触らない。tests/test_events.py が直接試す）
  ルート       /e/{code}・/c/{code}（index.html + OGP + noindex）、/api/public/events/{code}（集計・60秒）、
               probe、会の取得・変更、申し込み・取り消し・遅れる、名簿、お断り
  作る         create_for_post：POST /api/posts の `event` を受ける（app.py が 1 回呼ぶ）
  第2回b       開催の条件（最小開催人数・判定日・キャンセル期限・会のあとの入り方。純粋な関数 go_state・cancel_open）、
               参加者リスト（近い人は申し込みの回答どうしだけ。near_map）、受付（QR・飛び入り・主催者の受付）、
               コミュニティへの参加、会のあと（会えてよかった）。設計 G（11/4）。
               第2回b の SQL が無い DB（events_b_on() が False）では、新しい項目を送らず、新しい API は 503。

app.py の道具（current_user・project・state など）は、app.py が自分を読み込むので、使うときに取りに行く（_host()）。
"""

import hashlib
import html
import secrets
import sys
import time
from collections import Counter
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from typing import Any

from core import matching
from core.config import (
    AGE_BANDS,
    BREAKDOWN_MIN_COUNT,
    BREAKDOWN_OTHER,
    CHECKIN_CLOSES_AFTER_HOURS,
    CHECKIN_OPENS_BEFORE_HOURS,
    CONSENT_VERSION,
    EVENT_CLEANUP_DAYS,
    EVENT_ERROR_TEXT,
    EVENT_LIVE_STATUSES,
    EVENT_PLACE_MAX,
    EVENT_QUESTION_HINT_MAX,
    EVENT_QUESTION_LABEL_MAX,
    EVENT_QUESTION_PROMPTS,
    EVENT_QUESTIONS_MAX,
    EVENT_ANSWERS_MIN,
    EVENT_B_OFF_ERROR,
    EVENT_JOIN_POLICIES,
    EVENT_JOIN_POLICY_DEFAULT,
    EVENT_MIN_PARTICIPANTS,
    EVENT_NEAR_HIGH,
    EVENT_NEAR_LOW,
    EVENT_NEAR_MID,
    EVENT_NEAR_TOP,
    EVENT_PARTICIPANTS_CACHE_SECONDS,
    EVENT_TITLE_MAX,
    ISLAND_COLORS,
    ISLAND_GENRES,
    JOB_TITLE_MAX,
    LATE_CHOICES,
    MAX_AFFILIATION_LENGTH,
    MAX_NAME_LENGTH,
    PROBE_COOKIE,
    PROBE_COSINE,
    PROBE_FEW_MAX,
    PROBE_INTEREST_LENGTH,
    PROBE_INTERESTS_MAX,
    PUBLIC_EVENT_CACHE_SECONDS,
    RECRUIT_TAG,
    WALKIN_REJECT_MAX,
)
from core.post_extras import closed_state
from core.store import Refused, StoreError
from core.store_events import day_text, decide_deadline

router = APIRouter()

JST = timezone(timedelta(hours=9))
DB_ERROR = "読み込みに失敗しました。もう一度お試しください。"
WEEKDAYS = "月火水木金土日"
ROBOTS = {"X-Robots-Tag": "noindex"}
EVENT_OFF_ERROR = "会の申し込みは、まだ使えません。"


def _host():
    """app.py（`app` として読み込まれたもの）。"""
    return sys.modules.get("app") or sys.modules.get("__main__")


def _store():
    return _host().state["store"]


def events_on(store=None):
    """会の機能が使えるか：ISLANDS_EVENTS が 0 でなく、DB に表がある（手元モードは常に True）。"""
    import os
    if os.environ.get("ISLANDS_EVENTS", "").strip() == "0":
        return False
    store = store or _store()
    return bool(getattr(store, "supports_events", False))


def events_b_on(store=None):
    """第2回b（開催の条件・受付・参加者リスト・会のあと）が使えるか：会が使えて、DB に新しい列がある（手元は常に True）。"""
    store = store or _store()
    return events_on(store) and bool(getattr(store, "supports_events_b", False))


def _utc(value=None):
    if value is None:
        return datetime.now(timezone.utc)
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if value.tzinfo is None:
        value = value.replace(tzinfo=JST)        # 時刻に差が付いていなければ日本時間
    return value.astimezone(timezone.utc)


# ---------------------------------------------------------------------------
# 純粋な関数
# ---------------------------------------------------------------------------

def _datetime_field(value, message):
    if isinstance(value, bool) or not isinstance(value, (str, datetime)) or not value:
        raise ValueError(message)
    try:
        return _utc(value)
    except ValueError:
        raise ValueError(message)


def clean_questions(raw):
    """質問（最大3問・now/past/future）。[{"prompt","label","hint"}]。ValueError は日本語の文。"""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("質問の形が正しくありません。")
    if len(raw) > EVENT_QUESTIONS_MAX:
        raise ValueError(f"質問は{EVENT_QUESTIONS_MAX}つまでです。")
    out, seen = [], set()
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("質問の形が正しくありません。")
        prompt = item.get("prompt")
        if prompt not in EVENT_QUESTION_PROMPTS:
            raise ValueError("質問の種類が正しくありません。")
        if prompt in seen:
            raise ValueError("同じ種類の質問は1つまでです。")
        seen.add(prompt)
        label = str(item.get("label") or "").strip()
        hint = str(item.get("hint") or "").strip()
        if not 1 <= len(label) <= EVENT_QUESTION_LABEL_MAX:
            raise ValueError(f"質問の見出しは1〜{EVENT_QUESTION_LABEL_MAX}字で入力してください。")
        if len(hint) > EVENT_QUESTION_HINT_MAX:
            raise ValueError(f"質問のヒントは{EVENT_QUESTION_HINT_MAX}字以内で入力してください。")
        out.append({"prompt": prompt, "label": label, "hint": hint})
    return out


def clean_event(raw, *, now=None, current=None):
    """会の中身を検証して整える。ValueError は日本語の文（API は 422 にする）。

    current が無いとき（新しく作る）：title・starts_at・ends_at が必須で、開始は今より後。質問は公開の会なら2つ以上。
    current があるとき（変更）：送られた項目だけ検めて、その項目だけ返す。開始が変わらないなら過去でもよい
    （場所だけ直せるように）。"""
    if not isinstance(raw, dict):
        raise ValueError("会の内容を入力してください。")
    now = _utc(now)
    out = {}
    if current is None or "title" in raw:
        title = str(raw.get("title") or "").strip()
        if not 1 <= len(title) <= EVENT_TITLE_MAX:
            raise ValueError(f"会の名前は1〜{EVENT_TITLE_MAX}字で入力してください。")
        out["title"] = title
    if current is None or "place" in raw:
        place = str(raw.get("place") or "").strip()
        if len(place) > EVENT_PLACE_MAX:
            raise ValueError(f"場所は{EVENT_PLACE_MAX}字以内で入力してください。")
        out["place"] = place
    start_text, end_text = "開始の日時を入力してください。", "終了の日時を入力してください。"
    if current is None or "starts_at" in raw:
        out["starts_at"] = _datetime_field(raw.get("starts_at"), start_text)
    if current is None or "ends_at" in raw:
        out["ends_at"] = _datetime_field(raw.get("ends_at"), end_text)
    starts = out.get("starts_at") or _utc((current or {}).get("starts_at"))
    ends = out.get("ends_at") or _utc((current or {}).get("ends_at"))
    if ends <= starts:
        raise ValueError("終了は開始より後にしてください。")
    if "starts_at" in out and (current is None or out["starts_at"] != _utc(current.get("starts_at"))) \
            and out["starts_at"] <= now:
        raise ValueError("開始は今より後の日時にしてください。")
    if current is None:
        visibility = raw.get("visibility", "community")
        if visibility not in ("public", "community"):
            raise ValueError("公開の範囲が正しくありません。")
        out["visibility"] = visibility
    if current is None or "questions" in raw:
        out["questions"] = clean_questions(raw.get("questions"))
        visibility = out.get("visibility") or (current or {}).get("visibility")
        if visibility == "public" and len(out["questions"]) < EVENT_ANSWERS_MIN:
            raise ValueError(f"公開の会には、質問を{EVENT_ANSWERS_MIN}つ以上入れてください。")
    out.update(clean_rules(raw, starts=starts, now=now, current=current, starts_changed="starts_at" in out))
    return out


def _min_field(value):
    if value in (None, ""):
        return None
    low, high = EVENT_MIN_PARTICIPANTS
    text = f"最小開催人数は{low}〜{high}人の数で入力してください。"
    if isinstance(value, bool):
        raise ValueError(text)
    try:
        number = int(str(value).strip())
    except ValueError:
        raise ValueError(text)
    if not low <= number <= high:
        raise ValueError(text)
    return number


def _day_field(value):
    if value in (None, ""):
        return None
    try:
        return date.fromisoformat(str(value).strip()[:10]).isoformat()
    except ValueError:
        raise ValueError("判定日の形が正しくありません。")


def clean_rules(raw, *, starts, now, current=None, starts_changed=False):
    """開催の条件（第2回b）：min_participants・decide_on・cancel_deadline・join_policy。
    新しく作るとき：送られなければ「なし」、入り方は「本人に確認」。変更のとき：送られた項目だけ返す
    （最小人数を消したら判定日も消す）。開始日時が変わったら、今の判定日・キャンセル期限とも比べ直す。
    定員との比べは prepare と PATCH（投稿の定員を知っている所）でする。"""
    out = {}
    if current is None or "min_participants" in raw:
        out["min_participants"] = _min_field(raw.get("min_participants"))
    if current is None or "decide_on" in raw:
        out["decide_on"] = _day_field(raw.get("decide_on"))
    if current is not None and "min_participants" in out and out["min_participants"] is None \
            and "decide_on" not in raw:
        out["decide_on"] = None                       # 最小人数と判定日は組
    minimum = out["min_participants"] if "min_participants" in out else (current or {}).get("min_participants")
    day = out["decide_on"] if "decide_on" in out else day_text((current or {}).get("decide_on"))
    if minimum is not None and day is None:
        raise ValueError("最小開催人数を入れたときは、判定日も入れてください。")
    if minimum is None and day is not None:
        raise ValueError("判定日は、最小開催人数を入れたときだけ入れられます。")
    start_day = starts.astimezone(JST).date().isoformat()
    if day is not None and ("decide_on" in out or starts_changed):
        if "decide_on" in out and day != day_text((current or {}).get("decide_on")) \
                and day < now.astimezone(JST).date().isoformat():
            raise ValueError("判定日は今日以降の日にしてください。")
        if day >= start_day:
            raise ValueError("判定日は、会の開始日より前の日にしてください。")
    if current is None or "cancel_deadline" in raw:
        value = raw.get("cancel_deadline")
        out["cancel_deadline"] = None if value in (None, "") else _datetime_field(
            value, "キャンセル期限の日時を入力してください。")
        if current is None and out["cancel_deadline"] is not None and out["cancel_deadline"] <= now:
            raise ValueError("キャンセル期限は今より後の日時にしてください。")
    deadline = out["cancel_deadline"] if "cancel_deadline" in out else (current or {}).get("cancel_deadline")
    if deadline is not None and ("cancel_deadline" in out or starts_changed) and _utc(deadline) >= starts:
        raise ValueError("キャンセル期限は、会の開始より前にしてください。")
    if current is None or "join_policy" in raw:
        policy = raw.get("join_policy")
        policy = EVENT_JOIN_POLICY_DEFAULT if current is None and policy in (None, "") else policy
        if policy not in EVENT_JOIN_POLICIES:
            raise ValueError("会のあとの入り方が正しくありません。")
        out["join_policy"] = policy
    return out


RULE_KEYS = ("min_participants", "decide_on", "cancel_deadline", "join_policy")


def go_state(event, live_count, now=None):
    """開催の段階。最小人数が無ければ None。{"phase","min","decide_on","deadline","needed"}。
    phase：記録済み（decision）ならそれ、届いていれば held、締め（判定日の翌 0:00 JST）を過ぎていれば not_held、
    それ以外は recruiting。needed は held／not_held なら 0。"""
    minimum = event.get("min_participants")
    if minimum is None or not event.get("decide_on"):
        return None
    minimum = int(minimum)
    deadline = decide_deadline(event["decide_on"])
    phase = event.get("decision")
    if not phase:
        phase = ("held" if live_count >= minimum else
                 "not_held" if _utc(now) >= deadline else "recruiting")
    return {"phase": phase, "min": minimum, "decide_on": day_text(event["decide_on"]),
            "deadline": deadline.isoformat(),
            "needed": 0 if phase in ("held", "not_held") else max(0, minimum - live_count)}


def cancel_open(event, now=None):
    """まだ自分で取り消せるか：期限があれば期限まで、無ければ会の開始まで。"""
    now = _utc(now)
    if event.get("cancel_deadline"):
        return now <= _utc(event["cancel_deadline"])
    return now < _utc(event["starts_at"])


def rule_fields(event, live_count, now=None):
    """会の見え方（event_view・公開ページ）に足す開催の条件。"""
    go = go_state(event, live_count, now)
    deadline = event.get("cancel_deadline")
    return {"min_participants": event.get("min_participants"), "decide_on": day_text(event.get("decide_on")),
            "phase": go["phase"] if go else None, "needed": go["needed"] if go else None,
            "cancel_deadline": _utc(deadline).isoformat() if deadline else None,
            "cancel_open": cancel_open(event, now), "join_policy": event.get("join_policy") or "auto"}


def checkin_me(reg, banned):
    """受付の画面の「わたし」：none|applied|attended|waiting|rejected|banned|cancelled。"""
    if banned or (reg and reg["status"] == "declined"):
        return "banned"
    if not reg:
        return "none"
    if reg["status"] in ("applied", "attended", "waiting"):
        return reg["status"]
    rejects = int(reg.get("walkin_rejects") or 0)
    if reg.get("channel") == "walkin" and rejects:
        return new_walkin_state(rejects)
    return "cancelled"


def near_level(cosine):
    if cosine >= EVENT_NEAR_HIGH:
        return "high"
    if cosine >= EVENT_NEAR_MID:
        return "mid"
    if cosine >= EVENT_NEAR_LOW:
        return "low"
    return None


def near_reason(level, mine, theirs, genre=None):
    """理由の1行（C 2-6 の3段）。①向きが合う（matching.judge）②同じ話題（ジャンル）③ゆるい。
    近さが低い（low）相手には強い言い方をしない。mine・theirs は回答の行（prompt を見る）。"""
    verdict = matching.judge({"prompt": mine.get("prompt")}, {"prompt": theirs.get("prompt")})
    if level in ("high", "mid") and verdict and verdict[0] in matching.COMPLEMENT:
        return verdict[1]
    if genre:
        return f"どちらも「{genre}」の話題です"
    if level == "high" and verdict:
        return verdict[1]
    if level == "mid":
        return matching.NEAR[1]
    return "話してみると、共通点があるかもしれません"


def near_map(vectors, me, genres=None):
    """{account_id: {"level","reason","score"}}：お互いの申し込みの回答（event_answer_vectors）だけで比べる。
    メンバーの投稿は使わない。自分の回答が無ければ {}（near なし）。genres は {account_id: ジャンル名}。"""
    genres = genres or {}
    mine = [row for row in vectors if row["account_id"] == me and row.get("vec_c") is not None]
    if not mine:
        return {}
    others = {}
    for row in vectors:
        if row["account_id"] != me and row.get("vec_c") is not None:
            others.setdefault(row["account_id"], []).append(row)
    out = {}
    for account, theirs in others.items():
        score, a, b = max(((_cosine(a["vec_c"], b["vec_c"]), a, b) for a in mine for b in theirs),
                          key=lambda item: item[0])
        level = near_level(score)
        if level is None:
            continue
        same = genres.get(me) if genres.get(me) and genres.get(me) == genres.get(account) else None
        out[account] = {"level": level, "reason": near_reason(level, a, b, same), "score": round(score, 4)}
    return out


def participants_payload(event, rows, answers, vectors, me, genres=None):
    """GET /api/events/{code}/participants の中身。年代は返さない。
    並び：自分 → 主催者 → 近い順（high・mid・low の中は近い順）→ 申し込み順。near3 は自分以外の近い3人。"""
    labels = {item["prompt"]: item.get("label") or "" for item in event.get("questions") or []}
    said = {}
    for row in answers:
        said.setdefault(row["account_id"], []).append(
            {"prompt": row["prompt"], "label": labels.get(row["prompt"], ""), "body": row["body"]})
    order_of = {prompt: index for index, prompt in enumerate(labels)}
    for items in said.values():
        items.sort(key=lambda item: order_of.get(item["prompt"], len(order_of)))   # 質問の順に
    near = near_map(vectors, me, genres)
    people = []
    for order, row in enumerate(rows):
        account = row["account_id"]
        found = near.get(account) if account != me else None
        people.append((order, found["score"] if found else None, {
            "account_id": account, "name": row.get("display_name") or "", "affiliation": row.get("affiliation"),
            "job_title": row.get("job_title"), "icon_id": row.get("icon_id") or "0",
            "avatar_path": row.get("avatar_path"),
            "state": row["status"], "is_me": account == me, "is_host": bool(row.get("is_host")),
            "is_member": bool(row.get("is_member")), "late_minutes": row.get("late_minutes"),
            "answers": said.get(account, []),
            "near": {"level": found["level"], "reason": found["reason"]} if found else None}))
    people.sort(key=lambda item: (not item[2]["is_me"], not item[2]["is_host"],
                                  -(item[1] if item[1] is not None else -1), item[0]))
    ranked = sorted((item for item in people if item[1] is not None and not item[2]["is_me"]),
                    key=lambda item: -item[1])
    return {"counts": {"applied": sum(1 for row in rows if row["status"] == "applied"),
                       "attended": sum(1 for row in rows if row["status"] == "attended")},
            "people": [item[2] for item in people],
            "near3": [item[2]["account_id"] for item in ranked[:EVENT_NEAR_TOP]]}


def clean_profile(raw, *, need_age=False, need_job=False):
    """申し込む人のプロフィール：フルネーム・所属は必須。年代・職種は入っていれば検める。"""
    raw = raw if isinstance(raw, dict) else {}
    name = str(raw.get("display_name") or "").strip()
    affiliation = str(raw.get("affiliation") or "").strip()
    if not name or not affiliation:
        raise ValueError(EVENT_ERROR_TEXT["name_required"])
    if len(name) > MAX_NAME_LENGTH:
        raise ValueError(f"フルネームは{MAX_NAME_LENGTH}字以内で入力してください。")
    if len(affiliation) > MAX_AFFILIATION_LENGTH:
        raise ValueError(f"所属は{MAX_AFFILIATION_LENGTH}字以内で入力してください。")
    out = {"display_name": name, "affiliation": affiliation}
    age = raw.get("age_band")
    if age not in (None, ""):
        if age not in dict(AGE_BANDS):
            raise ValueError("年代が正しくありません。")
        out["age_band"] = age
    elif need_age:
        raise ValueError("年代を選んでください。")
    job = str(raw.get("job_title") or "").strip()
    if len(job) > JOB_TITLE_MAX:
        raise ValueError(f"職種は{JOB_TITLE_MAX}字以内で入力してください。")
    if job:
        out["job_title"] = job
    elif need_job:
        raise ValueError("職種を入力してください。")
    return out


def checkin_window(starts_at, ends_at):
    """受付の時間：開始3時間前〜終了2時間後。"""
    return (_utc(starts_at) - timedelta(hours=CHECKIN_OPENS_BEFORE_HOURS),
            _utc(ends_at) + timedelta(hours=CHECKIN_CLOSES_AFTER_HOURS))


def window_state(event, now=None):
    """"early"（まだ）／"open"／"closed"（終わった）。"""
    opens, closes = checkin_window(event["starts_at"], event["ends_at"])
    now = _utc(now)
    return "early" if now < opens else "closed" if now > closes else "open"


def bucket(counts, *, floor=BREAKDOWN_MIN_COUNT):
    """内訳。floor 人に満たない項目（と元からの「ほか」）は「ほか」にまとめる。多い順。E の 8。"""
    shown = [(label, n) for label, n in counts.items() if n >= floor and label != BREAKDOWN_OTHER]
    other = sum(n for label, n in counts.items() if n < floor or label == BREAKDOWN_OTHER)
    shown.sort(key=lambda item: (-item[1], item[0]))
    out = [{"label": label, "count": n} for label, n in shown]
    if other:
        out.append({"label": BREAKDOWN_OTHER, "count": other})
    return out


def blur(count):
    """probe の答え：0 人は none、1〜2 人は few（数は返さない）、3 人以上は many（数を返す）。"""
    if count <= 0:
        return {"level": "none", "count": None}
    if count <= PROBE_FEW_MAX:
        return {"level": "few", "count": None}
    return {"level": "many", "count": count}


def new_walkin_state(rejects):
    """"waiting"／"rejected"（まだやり直せる）／"banned"（3回目）。第2回b の受付で使う。"""
    return "banned" if rejects >= WALKIN_REJECT_MAX else "rejected" if rejects else "waiting"


def event_view(event, post=None, *, host=None, community_name=None, applied_count=0, me=None, is_host=False,
               now=None):
    """GET /api/events/{code} の `event`。post は会の投稿（消えていれば None）。
    closed は null／full／deadline／cancelled／not_held（人数が集まらず中止）。"""
    cancelled = bool(event.get("cancelled_at")) or post is None
    capacity = (post or {}).get("recruit_capacity")
    capacity = None if capacity is None else int(capacity)      # 画面は整数で比べる
    rules = rule_fields(event, applied_count, now)
    closed = "cancelled" if cancelled else "not_held" if rules["phase"] == "not_held" else closed_state(
        (post or {}).get("recruit_deadline"), capacity, (post or {}).get("join_count"))
    view = {
        "code": event["public_code"], "post_id": event["post_id"], "title": event["title"],
        "starts_at": _utc(event["starts_at"]).isoformat(), "ends_at": _utc(event["ends_at"]).isoformat(),
        "place": event["place"], "community_id": event["community_id"], "community_name": community_name,
        "host": {"id": host.get("id"), "display_name": host.get("display_name") or ""} if host else None,
        "capacity": capacity, "applied_count": applied_count, "closed": closed, "cancelled": cancelled,
        "visibility": event["visibility"], "questions": event.get("questions") or [],
        **rules,
    }
    return view


# ---------------------------------------------------------------------------
# しくみ
# ---------------------------------------------------------------------------

@contextmanager
def guarded(label=DB_ERROR):
    """ストアの断りは日本語の文つきの HTTP エラーに、DB が答えないときは 503 に。"""
    try:
        yield
    except Refused as error:
        raise HTTPException(status_code=error.status, detail=str(error))
    except StoreError:
        raise HTTPException(status_code=503, detail=label)


def _fail(code):
    from core.config import EVENT_STATUS_OF
    return HTTPException(status_code=EVENT_STATUS_OF[code], detail=EVENT_ERROR_TEXT[code])


def _require_events():
    if not events_on():
        raise _fail("event_not_found")


def _require_b():
    """第2回b の新しい API：会が使えなければ 404（今までどおり）、SQL がまだなら 503。"""
    _require_events()
    if not events_b_on():
        raise HTTPException(status_code=503, detail=EVENT_B_OFF_ERROR)


def _settled(store, event):
    """最小人数あり・未判定の会は、見え方を返す前に判定を書く（何度呼んでも同じ）。判定が出たら公開ページの
    キャッシュを消して、読み直した会を返す。"""
    if event.get("min_participants") is None or event.get("decision") or not events_b_on(store):
        return event
    with guarded():
        phase = store.event_settle(event=event["post_id"])
    if phase in ("held", "not_held"):
        clear_cache(event["public_code"])
        with guarded():
            return store.event_by_post(event["post_id"]) or event
    return event


def _member_added(store, event, account):
    """受付・参加ボタンでメンバーが増えた：島（回答が posts に写る）とつながりの線を作り直し、写った投稿ごとに
    島の住人へ「新しい住人」を知らせる（「ほかのコミュニティにも出す」で投稿が増えたときと同じ。
    community_members には DB のトリガーが無いので Python が出す）。知らせの失敗で加入は止めない。"""
    host = _host()
    host.invalidate_islands()
    host.invalidate_connections()
    community = event["community_id"]
    try:
        account_row = store.get_account(account) or {}
        moved = [row for row in store.posts_by_author(account) if str(row.get("community_id")) == str(community)]
        scoped = host.members_only_on()
    except Exception:
        host._logger.exception("could not read the posts moved from the answers")
        return
    for row in moved:
        try:
            host.notify_resident(row["id"], account, account_row.get("display_name", ""),
                                 community=community if scoped else None, post_community=community)
        except Exception:  # a failed notice never costs the membership
            host._logger.exception("resident notice failed")


def _event_or_404(store, code):
    with guarded():
        event = store.event_by_code(str(code or ""))
    if not event:
        raise _fail("event_not_found")
    return event


def _post_of(store, event):
    """会の投稿（消されていれば None）。"""
    with guarded():
        return store.get_post(event["post_id"])


def _host_event(store, code, user_id, *, admin_ok=False):
    event = _event_or_404(store, code)
    post = _post_of(store, event)
    if post and post["author_id"] == user_id:
        return event, post
    if admin_ok:
        with guarded():
            if store.is_community_admin(event["community_id"], user_id):
                return event, post
    raise _fail("event_not_host")


def base_url_of(request):
    import os
    return os.environ.get("ISLANDS_PUBLIC_BASE_URL", "").strip().rstrip("/") or str(request.base_url).rstrip("/")


def urls_for(event, base_url):
    return {"public_code": event["public_code"], "checkin_code": event["checkin_code"],
            "apply_url": f"{base_url}/e/{event['public_code']}",
            "checkin_url": f"{base_url}/c/{event['checkin_code']}"}


def clear_cache(code=None):
    """公開ページ（会ごと）と参加者リスト（会ごと・見る人ごと）のキャッシュを消す。code が None なら全部。"""
    state = _host().state
    cache = state.setdefault("event_public_cache", {})
    people = state.setdefault("event_participants_cache", {})
    if code is None:
        cache.clear()
        people.clear()
    else:
        cache.pop(code, None)
        for key in [key for key in people if key[0] == code]:
            people.pop(key, None)


def is_event_post(store, post_id):
    """この投稿は会の投稿か（共有・参加ボタン・定員の直しの判断）。"""
    if not events_on(store):
        return False
    try:
        return bool(store.event_by_post(post_id))
    except StoreError:
        return False


# ---------------------------------------------------------------------------
# 会を作る（POST /api/posts の event）
# ---------------------------------------------------------------------------

def prepare(store, user_id, raw, *, tags, capacity, community_id, agree_terms, now=None):
    """投稿を保存する前の確かめ。HTTPException を投げる。整えた会の中身を返す。"""
    if not events_on(store):
        raise HTTPException(status_code=409, detail=EVENT_OFF_ERROR)
    if RECRUIT_TAG not in tags:
        raise HTTPException(status_code=422, detail="会を作るには、タグ「参加者募集中」を選んでください。")
    if capacity is None:
        raise HTTPException(status_code=422, detail="会には先着人数が必要です。")
    if not community_id:
        raise HTTPException(status_code=422, detail="会は、コミュニティの中で作ってください。")
    if not agree_terms:
        raise HTTPException(status_code=422, detail=EVENT_ERROR_TEXT["terms_required"])
    try:
        clean = clean_event(raw, now=now)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
    if not events_b_on(store):
        # 第2回b の SQL がまだの DB：開催の条件は送らない（今までどおりの会になる）
        clean = {key: value for key, value in clean.items() if key not in RULE_KEYS}
    elif clean.get("min_participants") is not None and clean["min_participants"] > capacity:
        raise HTTPException(status_code=422, detail="最小開催人数は、先着人数以下にしてください。")
    if clean["visibility"] == "public":
        with guarded():
            if not store.is_community_admin(community_id, user_id):
                raise _fail("public_admin_only")
    return clean


def create_for_post(store, user_id, post_row, clean, base_url):
    """投稿を保存したあとに会の行を作る（D 7 章 10）。失敗したら投稿を戻して、日本語の断りを投げる。"""
    try:
        rules = {key: clean[key] for key in RULE_KEYS if key in clean}
        result = store.event_create(
            post=post_row["id"], actor=user_id, title=clean["title"], starts=clean["starts_at"],
            ends=clean["ends_at"], place=clean["place"], visibility=clean["visibility"],
            questions=clean["questions"], **rules)
    except (Refused, StoreError) as error:
        try:
            store.soft_delete_post(post_row["id"], user_id)
        except Exception:
            pass
        _host().invalidate_islands()
        if isinstance(error, Refused):
            raise HTTPException(status_code=error.status, detail=str(error))
        raise HTTPException(status_code=503, detail="会を保存できませんでした。もう一度お試しください。")
    clear_cache()
    return urls_for(result, base_url)


def existing_info(store, post_row, base_url):
    """同じ再試行キーでもう一度来たとき、その投稿の会の情報（作者本人だけが受け取る）。"""
    if not events_on(store):
        return {}
    try:
        event = store.event_by_post(post_row["id"])
    except StoreError:
        return {}
    return {"event": urls_for(event, base_url)} if event else {}


# ---------------------------------------------------------------------------
# 集計
# ---------------------------------------------------------------------------

def genres_of_answers(rows):
    """{account_id: ジャンル名}：回答の座標から、いちばん近い種の多数決（app.py の located_genre）。"""
    host = _host()
    posts, owner = [], {}
    for index, row in enumerate(rows):
        if row.get("x") is None or row.get("y") is None:
            continue
        ident = f"answer:{index}"
        posts.append({"id": ident, "x": row["x"], "y": row["y"]})
        owner[ident] = row["account_id"]
    try:
        found = host.located_genre(posts, host.state["model"])
    except Exception:
        return {}
    votes = {}
    for ident, genre in found.items():
        if genre is not None:
            votes.setdefault(owner[ident], Counter())[genre] += 1
    return {account: ISLAND_GENRES[min(counter, key=lambda g: (-counter[g], g))]
            for account, counter in votes.items()}


def genre_color(label):
    return ISLAND_COLORS[ISLAND_GENRES.index(label) % len(ISLAND_COLORS)]


def breakdown_of(roster, answer_rows):
    """年代・職種・ジャンルの内訳。どれも2人以下は「ほか」。名前・文は入れない。"""
    live = [row for row in roster if row["status"] in ("applied", "attended")]
    ages = dict(AGE_BANDS)
    age, job, genre = Counter(), Counter(), Counter()
    genres = genres_of_answers([row for row in answer_rows
                                if row["account_id"] in {r["account_id"] for r in live}])
    for row in live:
        age[ages.get(row.get("age_band"), BREAKDOWN_OTHER)] += 1
        title = " ".join(str(row.get("job_title") or "").split()).lower()
        job[title or BREAKDOWN_OTHER] += 1
        genre[genres.get(row["account_id"], BREAKDOWN_OTHER)] += 1
    # 職種は書かれたとおり（小文字にそろえた形）ではなく、いちばん多い書き方で出す
    spelled = {}
    for row in live:
        title = " ".join(str(row.get("job_title") or "").split())
        if title:
            spelled.setdefault(title.lower(), Counter())[title] += 1
    job_out = Counter()
    for key, n in job.items():
        job_out[max(spelled[key], key=lambda t: (spelled[key][t], t)) if key in spelled else key] += n
    return {"age": bucket(age), "job": bucket(job_out), "genre": bucket(genre)}


def public_payload(store, event):
    post = store.get_post(event["post_id"])
    cancelled = bool(event.get("cancelled_at")) or post is None
    base = {"code": event["public_code"], "title": event["title"],
            "starts_at": _utc(event["starts_at"]).isoformat(), "ends_at": _utc(event["ends_at"]).isoformat(),
            "place": event["place"], "visibility": event["visibility"]}
    if cancelled:
        # 中止された会は、中身を出さない（ゲスト用ページが「中止になりました」を出す）
        return {**base, "host_name": "", "community_name": "", "applied_count": 0, "capacity": None,
                "closed": "cancelled", "questions": [], "breakdown": {"age": [], "job": [], "genre": []},
                **rule_fields(event, 0)}
    roster = store.event_roster(event["post_id"])
    answers = store.event_answer_vectors(event["post_id"])
    host = store.get_account(post["author_id"]) or {}
    applied = sum(1 for row in roster if row["status"] in ("applied", "attended"))
    rules = rule_fields(event, applied)
    return {
        **base, "host_name": host.get("display_name") or "",
        "community_name": store.event_community_name(event["community_id"]) or "",
        "applied_count": applied,
        "capacity": post.get("recruit_capacity"),
        "closed": "not_held" if rules["phase"] == "not_held" else closed_state(
            post.get("recruit_deadline"), post.get("recruit_capacity"), post.get("join_count")),
        "questions": event.get("questions") or [],
        "breakdown": breakdown_of(roster, answers),
        **rules,
    }


@router.get("/api/public/events/{code}")
def get_public_event(code: str, response: Response):
    store = _store()
    _require_events()
    cache = _host().state.setdefault("event_public_cache", {})
    hit = cache.get(code)
    if hit and time.monotonic() - hit[0] < PUBLIC_EVENT_CACHE_SECONDS:
        payload = hit[1]
    else:
        event = _settled(store, _event_or_404(store, code))
        with guarded():
            payload = public_payload(store, event)
        cache[code] = (time.monotonic(), payload)
    response.headers["Cache-Control"] = f"public, max-age={PUBLIC_EVENT_CACHE_SECONDS}"
    response.headers["X-Robots-Tag"] = "noindex"
    return payload


# ---------------------------------------------------------------------------
# probe（近い人が来るか見てみる）
# ---------------------------------------------------------------------------

class ProbeBody(BaseModel):
    interests: list[Any] = Field(default_factory=list)


def _digest(text):
    return hashlib.sha256(str(text).encode("utf-8")).hexdigest()


def _cosine(a, b):
    import numpy as np
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    denominator = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(a @ b) / denominator if denominator else 0.0


def clean_interests(raw):
    items = [str(item).strip() for item in (raw or []) if isinstance(item, str) and str(item).strip()]
    if not 1 <= len(items) <= PROBE_INTERESTS_MAX or len(items) != len(raw or []) \
            or any(len(item) > PROBE_INTEREST_LENGTH for item in items):
        raise ValueError(f"興味は1〜{PROBE_INTERESTS_MAX}個、{PROBE_INTEREST_LENGTH}字までで入力してください。")
    return items


@router.post("/api/public/events/{code}/probe")
def probe(code: str, payload: ProbeBody, request: Request, response: Response):
    """興味を埋め込み（Gemini 1回）、申し込み済みの人の回答と比べて、人数のぼかした段階とジャンルの色だけ返す。
    入れた文は残さない。名前・文は返さない。"""
    store = _store()
    _require_events()
    try:
        interests = clean_interests(payload.interests)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
    event = _event_or_404(store, code)
    response.headers["X-Robots-Tag"] = "noindex"
    response.headers["Cache-Control"] = "private, no-store"
    cookie = request.cookies.get(PROBE_COOKIE) or secrets.token_urlsafe(16)
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    address = forwarded or (request.client.host if request.client else "")
    response.set_cookie(PROBE_COOKIE, cookie, max_age=2 * 86400, httponly=True, samesite="lax",
                        secure=request.url.scheme == "https")
    with guarded():
        hit = store.event_probe_hit(event=event["post_id"], device=_digest(cookie), ip=_digest(address))
    if not hit.get("ok"):
        raise _fail("probe_limit")
    with guarded():
        post = store.get_post(event["post_id"])
        if event.get("cancelled_at") or post is None:
            return {**blur(0), "genres": []}
        rows = store.event_answer_vectors(event["post_id"])
    centred = _host().project("、".join(interests))[5]
    near = [row for row in rows if row.get("vec_c") is not None and _cosine(centred, row["vec_c"]) >= PROBE_COSINE]
    people = {row["account_id"] for row in near}
    found = blur(len(people))
    genres = []
    if people:
        labels = sorted(set(genres_of_answers(near).values()))
        genres = [{"genre": label, "color": genre_color(label)} for label in labels]
    return {**found, "genres": genres}


# ---------------------------------------------------------------------------
# 会を見る・変える
# ---------------------------------------------------------------------------

def _is_member(store, event, user_id):
    return bool(store.is_community_member(event["community_id"], user_id))


def _me_block(store, event, user_id, view=None):
    """例 B の `me`。view（event_view）があれば can_cancel・can_join も入れる。
    can_cancel：申し込み中で、期限内で、中止でない。can_join：「本人に確認」の会で受付済み・まだメンバーでない。"""
    reg = store.event_registration(event["post_id"], user_id)
    link = store.line_link_of(user_id)
    status = reg["status"] if reg else "none"
    is_member = _is_member(store, event, user_id)
    me = {"status": status, "is_member": is_member,
          "late_minutes": reg["late_minutes"] if reg else None, "line_friend": bool(link and link.get("is_friend"))}
    if view is not None:
        me["can_cancel"] = bool(status == "applied" and view["cancel_open"] and not view["cancelled"]
                                and view["phase"] != "not_held")
        me["can_join"] = bool(view["join_policy"] == "ask" and status == "attended" and not is_member)
    return me


def _applied_count(store, event):
    return sum(1 for row in store.event_roster(event["post_id"]) if row["status"] in ("applied", "attended"))


def _view_for(store, event, user_id):
    event = _settled(store, event)
    post = store.get_post(event["post_id"])
    host = store.get_account(post["author_id"]) if post else None
    is_host = bool(post and post["author_id"] == user_id)
    view = event_view(event, post, host=host, community_name=store.event_community_name(event["community_id"]),
                      applied_count=_applied_count(store, event), is_host=is_host)
    return {"event": view, "me": _me_block(store, event, user_id, view), "is_host": is_host,
            "checkin_code": event["checkin_code"] if is_host else None}


@router.get("/api/events/mine")
def my_events(request: Request, all: int = 0):
    """生きている申し込みだけ（起動時の振り分けが使う）。?all=1 なら取り消し・お断り・中止も含めて全部返す
    （コミュニティに入っていない人を、最後の会のゲスト用ページに戻すのに使う）。"""
    host = _host()
    user_id = host.current_user(request)
    store = _store()
    _require_events()
    now = _utc()
    with guarded():
        rows = store.my_event_registrations(user_id)
    if all:
        live = list(rows)
    else:
        live = [row for row in rows
                if row["status"] in EVENT_LIVE_STATUSES and not row.get("cancelled_at")
                and _utc(row["ends_at"]) + timedelta(days=EVENT_CLEANUP_DAYS) > now]
    return {"events": [{"code": row["public_code"], "title": row["title"],
                        "starts_at": _utc(row["starts_at"]).isoformat(), "status": row["status"]}
                       for row in live]}


@router.get("/api/events/by-post/{post_id}")
def get_event_by_post(post_id: str, request: Request):
    host = _host()
    user_id = host.current_user(request)
    store = _store()
    _require_events()
    pid = host._norm_uuid(post_id)
    event = None
    if pid:
        with guarded():
            event = store.event_by_post(pid)
    if not event:
        raise _fail("event_not_found")
    host.require_member(user_id, event["community_id"])
    with guarded():
        return _view_for(store, event, user_id)


@router.get("/api/events/{code}")
def get_event(code: str, request: Request):
    user_id = _host().current_user(request)
    store = _store()
    _require_events()
    event = _event_or_404(store, code)
    with guarded():
        return _view_for(store, event, user_id)


class EventPatch(BaseModel):
    title: str | None = None
    starts_at: Any = None
    ends_at: Any = None
    place: str | None = None
    questions: Any = None
    # 第2回b：null を送れば消す（最小開催人数と判定日は組）
    min_participants: Any = None
    decide_on: Any = None
    cancel_deadline: Any = None
    join_policy: Any = None


@router.patch("/api/events/{code}")
def update_event(code: str, payload: EventPatch, request: Request):
    host = _host()
    user_id = host.current_user(request)
    store = _store()
    _require_events()
    if not host.check_rate_limit(user_id):
        raise HTTPException(status_code=429, detail="少し時間をおいてからお試しください。")
    event, post = _host_event(store, code, user_id)
    if post is None or event.get("cancelled_at"):
        raise _fail("event_cancelled")
    sent = {key: getattr(payload, key) for key in payload.model_fields_set}
    if not events_b_on(store):
        sent = {key: value for key, value in sent.items() if key not in RULE_KEYS}   # SQL がまだの DB には送らない
    if not sent:
        raise HTTPException(status_code=422, detail="変更点がありません。")
    event = _settled(store, event)
    try:
        fields = clean_event(sent, current=event)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
    if event.get("decision") and any(
            key in fields and fields[key] != (day_text(event.get(key)) if key == "decide_on" else event.get(key))
            for key in ("min_participants", "decide_on")):
        raise _fail("event_decided")
    if fields.get("min_participants") is not None and post.get("recruit_capacity") is not None \
            and fields["min_participants"] > post["recruit_capacity"]:
        raise HTTPException(status_code=422, detail="最小開催人数は、先着人数以下にしてください。")
    with guarded("保存に失敗しました。もう一度お試しください。"):
        result = store.event_update(post=event["post_id"], actor=user_id, fields=fields)
        fresh = store.event_by_post(event["post_id"])
    clear_cache()
    return {"event": event_view(fresh, post, community_name=None, applied_count=_applied_count(store, fresh),
                                is_host=True), "notified": result.get("notified", 0), "changed": result.get("changed")}


# ---------------------------------------------------------------------------
# 申し込み・取り消し・遅れる
# ---------------------------------------------------------------------------

class EventApply(BaseModel):
    profile: dict | None = None
    referral: str | None = None
    answers: list[dict] | None = None
    agree_terms: bool = False


def channel_and_sub(claims):
    """("line"|"email", LINE の sub または None)：サーバーが JWT から決める（画面からは受け取らない）。

    sub は JWT の user_metadata.sub（なければ provider_id＝同じ値）。DB の account_by_line_sub と同じ前提：
    auth.identities の identity_data->>'sub' ＝ LINE の userId。この前提は未確認（D の 7 章 23・24。
    LINE_実機確認の手順で、検証用のチャネルで確かめる）。違っていたらここと DB 関数だけ直す。"""
    app_meta = (claims or {}).get("app_metadata") or {}
    user_meta = (claims or {}).get("user_metadata") or {}
    if "line" in str(app_meta.get("provider") or "").lower():
        return "line", user_meta.get("sub") or user_meta.get("provider_id")
    return "email", None


def prepare_answers(raw, event):
    """答えを整えて、埋め込みと座標を付ける（Python で作って DB 関数に渡す）。メンバーでない人だけ。"""
    host = _host()
    allowed = {item["prompt"] for item in event.get("questions") or []}
    out, seen = [], set()
    for item in raw or []:
        prompt = item.get("prompt") if isinstance(item, dict) else None
        if prompt not in allowed or prompt in seen or not str(item.get("body") or "").strip():
            continue
        seen.add(prompt)
        body = host.clean_body(item.get("body"))
        x, y, cluster_id, terms, vector, centred = host.project(body)
        out.append({"prompt": prompt, "body": body, "x": x, "y": y, "cluster_id": cluster_id, "terms": terms,
                    "vec": [round(float(v), 6) for v in vector], "vec_c": [round(float(v), 6) for v in centred]})
    return out


@router.post("/api/events/{code}/apply")
def apply(code: str, payload: EventApply, request: Request):
    host = _host()
    user_id = host.current_user(request)
    store = _store()
    _require_events()
    if not host.check_rate_limit(user_id):
        raise HTTPException(status_code=429, detail="少し時間をおいてからお試しください。")
    if not payload.agree_terms:
        raise _fail("terms_required")
    event = _event_or_404(store, code)
    with guarded():
        account = store.get_account(user_id)
        is_member = _is_member(store, event, user_id)
    # フルネームと所属：確認済み（name_confirmed_at がある）人だけ省いてよい。メンバーでも、確認がまだなら要る
    # （DB の event_apply と同じ。要らないのに送らないと name_required で断られる）
    settled = bool(account and account.get("display_name") and account.get("affiliation")
                   and account.get("name_confirmed_at"))
    profile = None
    if payload.profile or not settled:
        try:
            profile = clean_profile(payload.profile)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error))
    answers = []
    if not is_member:
        answers = prepare_answers(payload.answers, event)
        # 質問が1つしか無い会は1つ、無い会は0（DB の event_apply と同じ）
        if len(answers) < min(EVENT_ANSWERS_MIN, len(event.get("questions") or [])):
            raise _fail("answers_required")
    _auth_user, claims = host.auth.identify(request)
    channel, sub = channel_and_sub(claims)
    with guarded("保存に失敗しました。もう一度お試しください。"):
        result = store.event_apply(event=event["post_id"], account=user_id, profile=profile, channel=channel,
                                   referral=payload.referral, answers=answers, consent=CONSENT_VERSION)
    if channel == "line" and sub:
        # 先に友だち追加していた人の取りこぼし対策：記録済みの userId をここで結ぶ
        try:
            store.line_link_attach(user_id, sub)
        except Exception:
            host._logger.warning("could not attach the LINE friend to the account")
    clear_cache()
    host.invalidate_connections()
    return {"status": result["status"], "is_member": result.get("is_member"), "remaining": result.get("remaining"),
            "phase": result.get("phase"), "me_path": f"#/e/{event['public_code']}/me"}


@router.post("/api/events/{code}/cancel")
def cancel_registration(code: str, request: Request):
    host = _host()
    user_id = host.current_user(request)
    store = _store()
    _require_events()
    if not host.check_rate_limit(user_id):
        raise HTTPException(status_code=429, detail="少し時間をおいてからお試しください。")
    event = _event_or_404(store, code)
    with guarded("取り消しに失敗しました。もう一度お試しください。"):
        result = store.event_cancel_registration(event=event["post_id"], account=user_id)
    clear_cache()
    host.invalidate_connections()
    return {"status": result["status"]}


class LateBody(BaseModel):
    minutes: Any = None


@router.post("/api/events/{code}/late")
def set_late(code: str, payload: LateBody, request: Request):
    host = _host()
    user_id = host.current_user(request)
    store = _store()
    _require_events()
    if isinstance(payload.minutes, bool) or payload.minutes not in LATE_CHOICES:
        raise HTTPException(status_code=422, detail="遅れる時間は10分・30分・60分から選んでください。")
    event = _event_or_404(store, code)
    with guarded("保存に失敗しました。もう一度お試しください。"):
        result = store.event_set_late(event=event["post_id"], account=user_id, minutes=payload.minutes)
    return {"late_minutes": result["late_minutes"]}


# ---------------------------------------------------------------------------
# 主催者：名簿・お断り
# ---------------------------------------------------------------------------

@router.get("/api/events/{code}/roster")
def roster(code: str, request: Request):
    user_id = _host().current_user(request)
    store = _store()
    _require_events()
    event, post = _host_event(store, code, user_id, admin_ok=True)
    event = _settled(store, event)
    with guarded():
        rows = store.event_roster(event["post_id"])
    counts = Counter(row["status"] for row in rows)
    go = go_state(event, counts.get("applied", 0) + counts.get("attended", 0))
    quota = None
    try:
        from core import line
        if line.configured():
            quota = line.monthly_quota()
    except Exception:
        quota = None
    people = []
    for row in rows:
        if row["status"] == "waiting":
            continue
        people.append({**{key: row.get(key) for key in (
            "account_id", "display_name", "affiliation", "job_title", "age_band", "referral", "joined_via",
            "channel", "status", "late_minutes", "banned_before", "line_friend")},
            "is_member": bool(row.get("is_member"))})
    return {
        "counts": {**{status: counts.get(status, 0) for status in
                      ("applied", "attended", "waiting", "cancelled", "declined")},
                   "capacity": (post or {}).get("recruit_capacity"),
                   "phase": go["phase"] if go else None, "min": go["min"] if go else None,
                   "needed": go["needed"] if go else None, "decide_on": go["decide_on"] if go else None},
        "line_quota": quota,
        "waiting": [{"account_id": row["account_id"], "display_name": row["display_name"],
                     "affiliation": row["affiliation"], "rejects": row.get("rejects", 0),
                     "is_member": bool(row.get("is_member"))}
                    for row in rows if row["status"] == "waiting"],
        "people": people,
    }


@router.post("/api/events/{code}/registrations/{account_id}/decline")
def decline(code: str, account_id: str, request: Request):
    host = _host()
    user_id = host.current_user(request)
    store = _store()
    _require_events()
    event, _post = _host_event(store, code, user_id)
    target = host._norm_uuid(account_id)
    if not target:
        raise _fail("event_not_applied")
    with guarded("保存に失敗しました。もう一度お試しください。"):
        result = store.event_decline(event=event["post_id"], host=user_id, account=target)
    clear_cache()
    host.invalidate_connections()
    return {"status": result["status"]}


@router.post("/api/events/{code}/registrations/{account_id}/checkin")
def host_checkin(code: str, account_id: str, request: Request):
    """主催者が名簿で受付する（受付待ち・申し込み済みの人。受付の時間は見ない）。"""
    host = _host()
    user_id = host.current_user(request)
    store = _store()
    _require_b()
    if not host.check_rate_limit(user_id):
        raise HTTPException(status_code=429, detail="少し時間をおいてからお試しください。")
    event, _post = _host_event(store, code, user_id)
    target = host._norm_uuid(account_id)
    if not target:
        raise _fail("not_waiting")
    with guarded("保存に失敗しました。もう一度お試しください。"):
        result = store.event_checkin_by_host(event=event["post_id"], host=user_id, account=target)
    joined = bool(result.get("joined"))
    clear_cache(event["public_code"])
    if joined:
        _member_added(store, event, target)
    return {"status": result.get("status", "attended"), "joined": joined}


@router.post("/api/events/{code}/registrations/{account_id}/reject-walkin")
def host_reject_walkin(code: str, account_id: str, request: Request):
    host = _host()
    user_id = host.current_user(request)
    store = _store()
    _require_b()
    event, _post = _host_event(store, code, user_id)
    target = host._norm_uuid(account_id)
    if not target:
        raise _fail("not_waiting")
    with guarded("保存に失敗しました。もう一度お試しください。"):
        result = store.event_reject_walkin(event=event["post_id"], host=user_id, account=target)
    return {"walkin_rejects": result["walkin_rejects"]}


# ---------------------------------------------------------------------------
# 参加者リスト・コミュニティへの参加（第2回b）
# ---------------------------------------------------------------------------

@router.get("/api/events/{code}/participants")
def participants(code: str, request: Request, response: Response):
    """見られるのは、その会の申し込み中・受付済みの人、主催者、コミュニティのメンバーだけ（ほかは 404）。
    近い人はお互いの申し込みの回答だけで出す。60秒キャッシュ（会ごと・見る人ごと）。"""
    user_id = _host().current_user(request)
    store = _store()
    _require_b()
    event = _settled(store, _event_or_404(store, code))
    response.headers["Cache-Control"] = "private, no-store"
    cache = _host().state.setdefault("event_participants_cache", {})
    key = (event["public_code"], user_id)
    hit = cache.get(key)
    if hit and time.monotonic() - hit[0] < EVENT_PARTICIPANTS_CACHE_SECONDS:
        return hit[1]
    with guarded():
        post = store.get_post(event["post_id"])
        reg = store.event_registration(event["post_id"], user_id)
        allowed = (bool(post and post["author_id"] == user_id)
                   or bool(reg and reg["status"] in ("applied", "attended"))
                   or _is_member(store, event, user_id))
    if not allowed:
        raise _fail("participants_forbidden")
    with guarded():
        rows = store.event_participants(event["post_id"])
        answers = store.event_participant_answers(event["post_id"])
        vectors = [row for row in store.event_answer_vectors(event["post_id"])
                   if row["account_id"] in {r["account_id"] for r in rows}]
    genres = genres_of_answers(vectors) if vectors else {}
    payload = participants_payload(event, rows, answers, vectors, user_id, genres)
    cache[key] = (time.monotonic(), payload)
    return payload


@router.post("/api/events/{code}/join")
def join_community(code: str, request: Request):
    """「本人に確認」の会で、受付が済んだ人が自分でコミュニティに入る。"""
    host = _host()
    user_id = host.current_user(request)
    store = _store()
    _require_b()
    if not host.check_rate_limit(user_id):
        raise HTTPException(status_code=429, detail="少し時間をおいてからお試しください。")
    event = _event_or_404(store, code)
    with guarded("保存に失敗しました。もう一度お試しください。"):
        result = store.event_join_community(event=event["post_id"], account=user_id)
    if result["status"] == "joined":
        clear_cache(event["public_code"])
        _member_added(store, event, user_id)
    return {"status": result["status"], "community_id": event["community_id"]}


# ---------------------------------------------------------------------------
# 受付（QR）・飛び入り（第2回b。D の #17〜#19）
# ---------------------------------------------------------------------------

def _checkin_event_or_404(store, checkin_code):
    with guarded():
        event = store.event_by_checkin_code(str(checkin_code or ""))
    if not event:
        raise _fail("event_not_found")
    return event


@router.get("/api/checkin/{checkin_code}")
def checkin_info(checkin_code: str, request: Request):
    """受付の画面が読む（受付待ちの画面は数秒ごとに）。"""
    user_id = _host().current_user(request)
    store = _store()
    _require_b()
    event = _settled(store, _checkin_event_or_404(store, checkin_code))
    with guarded():
        post = store.get_post(event["post_id"])
        reg = store.event_registration(event["post_id"], user_id)
        is_member = _is_member(store, event, user_id)
        banned = store.event_banned_for(event["post_id"], user_id)
        community_name = store.event_community_name(event["community_id"])
        live = _applied_count(store, event)
    go = go_state(event, live)
    return {
        "event": {"code": event["public_code"], "title": event["title"],
                  "starts_at": _utc(event["starts_at"]).isoformat(), "ends_at": _utc(event["ends_at"]).isoformat(),
                  "place": event["place"], "community_name": community_name,
                  "join_policy": event.get("join_policy") or "auto",
                  "cancelled": bool(event.get("cancelled_at")) or post is None,
                  "phase": go["phase"] if go else None},
        "window": window_state(event),
        "me": checkin_me(reg, banned),
        "rejects": int((reg or {}).get("walkin_rejects") or 0),
        "is_member": is_member,
    }


@router.post("/api/checkin/{checkin_code}")
def checkin(checkin_code: str, request: Request):
    host = _host()
    user_id = host.current_user(request)
    store = _store()
    _require_b()
    if not host.check_rate_limit(user_id):
        raise HTTPException(status_code=429, detail="少し時間をおいてからお試しください。")
    event = _checkin_event_or_404(store, checkin_code)
    with guarded("受付に失敗しました。もう一度お試しください。"):
        result = store.event_checkin(event=event["post_id"], account=user_id)
    joined = bool(result.get("joined"))
    if result["result"] == "attended":
        clear_cache(event["public_code"])
    if joined:
        _member_added(store, event, user_id)
    return {"result": result["result"], "joined": joined}


class WalkinBody(BaseModel):
    display_name: str | None = None
    affiliation: str | None = None
    agree_terms: bool = False


@router.post("/api/checkin/{checkin_code}/walkin")
def checkin_walkin(checkin_code: str, payload: WalkinBody, request: Request):
    """申し込みの無い人が受付待ちになる（主催者が名簿で受付する）。フルネームと会社は、確認済みの人なら省いてよい。"""
    host = _host()
    user_id = host.current_user(request)
    store = _store()
    _require_b()
    if not host.check_rate_limit(user_id):
        raise HTTPException(status_code=429, detail="少し時間をおいてからお試しください。")
    if not payload.agree_terms:
        raise _fail("terms_required")
    event = _checkin_event_or_404(store, checkin_code)
    with guarded():
        account = store.get_account(user_id)
    settled = bool(account and account.get("display_name") and account.get("affiliation")
                   and account.get("name_confirmed_at"))
    profile = None
    if payload.display_name or payload.affiliation or not settled:
        try:
            profile = clean_profile({"display_name": payload.display_name, "affiliation": payload.affiliation})
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error))
    with guarded("保存に失敗しました。もう一度お試しください。"):
        result = store.event_walkin_request(event=event["post_id"], account=user_id, profile=profile,
                                            consent=CONSENT_VERSION)
    return {"status": result["status"]}


# ---------------------------------------------------------------------------
# 会のあと（第2回b。D の #20・#21）
# ---------------------------------------------------------------------------

@router.get("/api/events/{code}/after")
def after(code: str, request: Request):
    """受付済みの人だけ。会えてよかった（met）と、もっと話してみたい（talk。押す API は今の press_talk）。"""
    user_id = _host().current_user(request)
    store = _store()
    _require_b()
    event = _event_or_404(store, code)
    with guarded():
        rows = store.event_after_people(event=event["post_id"], account=user_id)
        me_is_member = _is_member(store, event, user_id)
        try:
            talking = set(store.event_talk_targets(user_id)) if me_is_member else set()
        except Exception:
            talking = set()           # 「もっと話してみたい」の表がまだの DB：押していないことにする
    return {"people": [{"account_id": row["account_id"], "display_name": row.get("display_name") or "",
                        "affiliation": row.get("affiliation"), "job_title": row.get("job_title"),
                        "icon_id": row.get("icon_id") or "0", "avatar_path": row.get("avatar_path"),
                        "is_member": bool(row.get("is_member")), "met": bool(row.get("met")),
                        "talk": row["account_id"] in talking}
                       for row in rows],
            "me_is_member": me_is_member, "join_policy": event.get("join_policy") or "auto"}


class MetBody(BaseModel):
    to: str | None = None
    on: bool = True


@router.post("/api/events/{code}/met")
def met(code: str, payload: MetBody, request: Request):
    host = _host()
    user_id = host.current_user(request)
    store = _store()
    _require_b()
    if not host.check_rate_limit(user_id):
        raise HTTPException(status_code=429, detail="少し時間をおいてからお試しください。")
    event = _event_or_404(store, code)
    target = host._norm_uuid(payload.to)
    if not target or target == user_id:
        raise HTTPException(status_code=422, detail="相手を選んでください。")
    with guarded("保存に失敗しました。もう一度お試しください。"):
        result = store.event_meet(event=event["post_id"], from_id=user_id, to_id=target, on=payload.on)
    return {"on": bool(result.get("on"))}


# ---------------------------------------------------------------------------
# /e/{code}・/c/{code}：index.html（OGP・noindex）
# ---------------------------------------------------------------------------

def when_text(starts_at, ends_at):
    start, end = _utc(starts_at).astimezone(JST), _utc(ends_at).astimezone(JST)
    return (f"{start.month}月{start.day}日({WEEKDAYS[start.weekday()]}) "
            f"{start:%H:%M}〜{end:%H:%M}")


def _page(code, field, request):
    host = _host()
    text = (host.WEB / "index.html").read_text(encoding="utf-8")
    title, description = "islands", "islands の会"
    try:
        store = host.state["store"]
        event = (store.event_by_code(code) if field == "public_code" else store.event_by_checkin_code(code)) \
            if events_on(store) else None
    except Exception:
        event = None
    if event and field == "public_code" and not event.get("cancelled_at"):
        title = event["title"]
        description = " ／ ".join(part for part in (when_text(event["starts_at"], event["ends_at"]), event["place"]) if part)
    tags = (
        '<meta name="robots" content="noindex">'
        f'<meta property="og:site_name" content="islands">'
        f'<meta property="og:type" content="website">'
        f'<meta property="og:title" content="{html.escape(title, quote=True)}">'
        f'<meta property="og:description" content="{html.escape(description, quote=True)}">'
    )
    text = text.replace("</head>", tags + "</head>", 1)
    return HTMLResponse(text, headers={"Cache-Control": "no-cache", **ROBOTS})


@router.get("/e/{code}")
def apply_page(code: str, request: Request):
    return _page(code, "public_code", request)


@router.get("/c/{code}")
def checkin_page(code: str, request: Request):
    return _page(code, "checkin_code", request)


# ---------------------------------------------------------------------------
# 手元だけのテスト用の道（本番は 404）
# ---------------------------------------------------------------------------

class SetTimes(BaseModel):
    starts_at: Any
    ends_at: Any


class LineFollow(BaseModel):
    line_user_id: str


@router.post("/api/local/events/{code}/set-times")
def local_set_times(code: str, payload: SetTimes):
    _host().require_local()
    try:
        _store().event_set_times(code, _utc(payload.starts_at), _utc(payload.ends_at))
    except Refused as error:
        raise HTTPException(status_code=error.status, detail=str(error))
    clear_cache()
    return {"ok": True}


class ForceBody(BaseModel):
    decide_on: Any = None
    cancel_deadline: Any = None
    decision: str | None = None
    min_participants: Any = None
    join_policy: str | None = None


@router.post("/api/local/events/{code}/force")
def local_force(code: str, payload: ForceBody):
    """判定日・キャンセル期限・判定（と最小人数・入り方）を検めずに入れる（判定日や期限を過去にして試すため）。
    送った項目だけ。decision に null を送れば判定を消す。"""
    _host().require_local()
    fields = {key: getattr(payload, key) for key in payload.model_fields_set}
    if "decision" in fields and fields["decision"] not in (None, "held", "not_held"):
        raise HTTPException(status_code=422, detail="decision は held・not_held・null です。")
    try:
        _store().event_force(code, fields)
    except Refused as error:
        raise HTTPException(status_code=error.status, detail=str(error))
    clear_cache()
    return {"ok": True}


@router.get("/api/local/line/outbox")
def local_line_outbox():
    _host().require_local()
    return {"messages": _store().sent_messages()}


@router.post("/api/local/line/follow")
def local_line_follow(payload: LineFollow, request: Request):
    """友だち追加を真似る：ログイン中ならその人に結ぶ。ログインしていなければ userId だけ記録する。"""
    host = _host()
    host.require_local()
    user_id = host.optional_user(request)
    _store().line_link_save(user_id, payload.line_user_id, True)
    return {"ok": True}
