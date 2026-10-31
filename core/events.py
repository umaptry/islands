"""会（イベント申し込み）の API（2026-11-01 第2回a。D_関数の取り決め 3 章）。

  純粋な関数   clean_event・clean_questions・clean_profile・checkin_window・window_state・bucket・blur・event_view
               （DB にも app.py にも触らない。tests/test_events.py が直接試す）
  ルート       /e/{code}・/c/{code}（index.html + OGP + noindex）、/api/public/events/{code}（集計・60秒）、
               probe、会の取得・変更、申し込み・取り消し・遅れる、名簿、お断り
  作る         create_for_post：POST /api/posts の `event` を受ける（app.py が 1 回呼ぶ）

app.py の道具（current_user・project・state など）は、app.py が自分を読み込むので、使うときに取りに行く（_host()）。
受付・参加者リスト・会のあと（M4）は第2回b。
"""

import hashlib
import html
import secrets
import sys
import time
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from typing import Any

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
    return out


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


def event_view(event, post=None, *, host=None, community_name=None, applied_count=0, me=None, is_host=False):
    """GET /api/events/{code} の `event`。post は会の投稿（消えていれば None）。"""
    cancelled = bool(event.get("cancelled_at")) or post is None
    capacity = (post or {}).get("recruit_capacity")
    closed = "cancelled" if cancelled else closed_state(
        (post or {}).get("recruit_deadline"), capacity, (post or {}).get("join_count"))
    view = {
        "code": event["public_code"], "post_id": event["post_id"], "title": event["title"],
        "starts_at": _utc(event["starts_at"]).isoformat(), "ends_at": _utc(event["ends_at"]).isoformat(),
        "place": event["place"], "community_id": event["community_id"], "community_name": community_name,
        "host": {"id": host.get("id"), "display_name": host.get("display_name") or ""} if host else None,
        "capacity": capacity, "applied_count": applied_count, "closed": closed, "cancelled": cancelled,
        "visibility": event["visibility"], "questions": event.get("questions") or [],
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
    cache = _host().state.setdefault("event_public_cache", {})
    if code is None:
        cache.clear()
    else:
        cache.pop(code, None)


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
    if clean["visibility"] == "public":
        with guarded():
            if not store.is_community_admin(community_id, user_id):
                raise _fail("public_admin_only")
    return clean


def create_for_post(store, user_id, post_row, clean, base_url):
    """投稿を保存したあとに会の行を作る（D 7 章 10）。失敗したら投稿を戻して、日本語の断りを投げる。"""
    try:
        result = store.event_create(
            post=post_row["id"], actor=user_id, title=clean["title"], starts=clean["starts_at"],
            ends=clean["ends_at"], place=clean["place"], visibility=clean["visibility"],
            questions=clean["questions"])
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
                "closed": "cancelled", "questions": [], "breakdown": {"age": [], "job": [], "genre": []}}
    roster = store.event_roster(event["post_id"])
    answers = store.event_answer_vectors(event["post_id"])
    host = store.get_account(post["author_id"]) or {}
    return {
        **base, "host_name": host.get("display_name") or "",
        "community_name": store.event_community_name(event["community_id"]) or "",
        "applied_count": sum(1 for row in roster if row["status"] in ("applied", "attended")),
        "capacity": post.get("recruit_capacity"),
        "closed": closed_state(post.get("recruit_deadline"), post.get("recruit_capacity"), post.get("join_count")),
        "questions": event.get("questions") or [],
        "breakdown": breakdown_of(roster, answers),
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
        event = _event_or_404(store, code)
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


def _me_block(store, event, user_id):
    reg = store.event_registration(event["post_id"], user_id)
    link = store.line_link_of(user_id)
    return {"status": reg["status"] if reg else "none", "is_member": _is_member(store, event, user_id),
            "late_minutes": reg["late_minutes"] if reg else None, "line_friend": bool(link and link.get("is_friend"))}


def _applied_count(store, event):
    return sum(1 for row in store.event_roster(event["post_id"]) if row["status"] in ("applied", "attended"))


def _view_for(store, event, user_id):
    post = store.get_post(event["post_id"])
    host = store.get_account(post["author_id"]) if post else None
    is_host = bool(post and post["author_id"] == user_id)
    view = event_view(event, post, host=host, community_name=store.event_community_name(event["community_id"]),
                      applied_count=_applied_count(store, event), is_host=is_host)
    return {"event": view, "me": _me_block(store, event, user_id), "is_host": is_host,
            "checkin_code": event["checkin_code"] if is_host else None}


@router.get("/api/events/mine")
def my_events(request: Request):
    """生きている申し込みだけ（起動時の振り分けが使う）。"""
    host = _host()
    user_id = host.current_user(request)
    store = _store()
    _require_events()
    now = _utc()
    with guarded():
        rows = store.my_event_registrations(user_id)
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
    if not sent:
        raise HTTPException(status_code=422, detail="変更点がありません。")
    try:
        fields = clean_event(sent, current=event)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
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
            "me_path": f"#/e/{event['public_code']}/me"}


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
    with guarded():
        rows = store.event_roster(event["post_id"])
    counts = Counter(row["status"] for row in rows)
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
        people.append({key: row.get(key) for key in (
            "account_id", "display_name", "affiliation", "job_title", "age_band", "referral", "joined_via",
            "channel", "status", "late_minutes", "banned_before", "line_friend")})
    return {
        "counts": {**{status: counts.get(status, 0) for status in
                      ("applied", "attended", "waiting", "cancelled", "declined")},
                   "capacity": (post or {}).get("recruit_capacity")},
        "line_quota": quota,
        "waiting": [{"account_id": row["account_id"], "display_name": row["display_name"],
                     "affiliation": row["affiliation"], "rejects": row.get("rejects", 0)}
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
