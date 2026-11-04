"""会（イベント申し込み）のストア側（2026-11-01 第2回a）。

  EventsSupabaseMixin  SupabaseStore の相手。DB 関数（supabase/migrations/20261106000000_events.sql の
                       event_*、line_*、outbound_*）を RPC で呼び、表は PostgREST で読む。
  EventsMemoryMixin    MemoryStore の相手。手元モード・テスト用。DB 関数・トリガーと同じ動き・同じ日本語・同じ hint。

メソッド名は DB 関数と同じ（D_関数の取り決め 1-1）。引数名は 2 章の表の `p_` を取った形のキーワード引数。
断りは EventRefused（core/store.py に置いた。`.code` が hint、`.status` が HTTP の番号、str() が日本語の文）。

core/store.py と互いに読み込むので、store の名前は必要になったときに読む（`_s()`）。
EventRefused は `from core.store_events import EventRefused` でも取れる。

第2回b（2026-11-11。設計 G）：開催の条件（最小開催人数・判定日・キャンセル期限・会のあとの入り方）と、
受付（QR・飛び入り・主催者の受付）・参加者リスト・会のあと（会えてよかった）・コミュニティへの参加。
DB は supabase/migrations/20261111000000_events_b.sql。その SQL が無い DB（supports_events_b が False）では、
新しい項目を送らず、会を作るときは今の8引数で呼ぶ。
"""

import secrets
import time
from datetime import date, datetime, timedelta, timezone

import numpy as np

from core.config import (
    EVENT_ERROR_TEXT,
    EVENT_LIVE_STATUSES,
    EVENT_STATUS_OF,
    JOB_TITLE_MAX,
    LATE_CHOICES,
    MAX_AFFILIATION_LENGTH,
    MAX_NAME_LENGTH,
    LINE_WEBHOOK_KEEP_DAYS,
    EVENT_ANSWERS_MIN,
    AGE_BANDS,
    CHECKIN_CLOSES_AFTER_HOURS,
    CHECKIN_OPENS_BEFORE_HOURS,
    EVENT_CLEANUP_DAYS,
    EVENT_JOIN_POLICIES,
    EVENT_MIN_PARTICIPANTS,
    EVENT_PLACE_MAX,
    EVENT_QUESTIONS_MAX,
    EVENT_TITLE_MAX,
    MATCH_COSINE_SAME,
    OUTBOUND_BATCH,
    OUTBOUND_LEASE_SECONDS,
    OUTBOUND_MAX_ATTEMPTS,
    OUTBOUND_STALE_HOURS,
    PROBE_PER_DEVICE_PER_DAY,
    PROBE_PER_EVENT_PER_DAY,
    RECRUIT_TAG,
    REFERRAL_MAX,
    WALKIN_REJECT_MAX,
)
from core.post_extras import CLOSED_DEADLINE, closed_state


def _s():
    import core.store as store_module
    return store_module


def __getattr__(name):
    if name == "EventRefused":
        return _s().EventRefused
    raise AttributeError(name)


def refuse(code, status=None):
    """Raise EventRefused with the words and the number of one hint code (EVENT_ERROR_TEXT)."""
    raise _s().EventRefused(EVENT_ERROR_TEXT[code], status or EVENT_STATUS_OF[code], code)


def _utc(value=None):
    """An aware UTC datetime from a datetime, an ISO string, or now (None)."""
    if value is None:
        return datetime.now(timezone.utc)
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _iso(value):
    return None if value is None else _utc(value).isoformat()


def new_code():
    """24 characters, not guessable (make_invite_code() in the database is the same length)."""
    return secrets.token_urlsafe(18)


def jst_day(moment):
    return (_utc(moment) + timedelta(hours=9)).date().isoformat()


def decide_deadline(decide_on):
    """判定の締め：判定日の翌日の 0:00（日本時間）を UTC で。decide_on は "YYYY-MM-DD"（date でもよい）。"""
    day = decide_on if isinstance(decide_on, date) else date.fromisoformat(str(decide_on)[:10])
    return datetime(day.year, day.month, day.day, tzinfo=timezone.utc) + timedelta(days=1) - timedelta(hours=9)


def day_text(value):
    """判定日を "YYYY-MM-DD" に（None はそのまま）。"""
    if value in (None, ""):
        return None
    return value.isoformat() if isinstance(value, date) else str(value)[:10]


def rules_ok(*, min_participants, decide_on, cancel_deadline, join_policy, starts, capacity, now,
             check_today=True):
    """開催の条件が DB の event_create／event_update の検めに通るか（手元の代役。通らなければ False）。
    最小人数は 2 以上・定員以下、判定日と組、判定日は今日以降（check_today のとき）かつ開始日より前の日、
    キャンセル期限は開始より前。"""
    if (min_participants is None) != (decide_on is None):
        return False
    if min_participants is not None:
        low, high = EVENT_MIN_PARTICIPANTS
        if isinstance(min_participants, bool) or not low <= int(min_participants) <= high:
            return False
        if capacity is not None and int(min_participants) > int(capacity):
            return False
        day = day_text(decide_on)
        if (check_today and day < jst_day(now)) or day >= jst_day(starts):
            return False
    if cancel_deadline is not None and _utc(cancel_deadline) >= _utc(starts):
        return False
    return join_policy in EVENT_JOIN_POLICIES


def in_checkin_window(event, now):
    """受付の時間（開始3時間前〜終了2時間後）の中か。core/events.py の window_state と同じ。"""
    opens = _utc(event["starts_at"]) - timedelta(hours=CHECKIN_OPENS_BEFORE_HOURS)
    closes = _utc(event["ends_at"]) + timedelta(hours=CHECKIN_CLOSES_AFTER_HOURS)
    return opens <= _utc(now) <= closes


def clean_referral(value):
    text = str(value or "").strip()[:REFERRAL_MAX]
    return text or None


def _cosine(a, b):
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    denominator = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(a @ b) / denominator if denominator else 0.0


# ---------------------------------------------------------------------------
# memory
# ---------------------------------------------------------------------------

class EventsMemoryMixin:
    """MemoryStore の会まわり。表の代わりの辞書と、DB のトリガーがやることを同じメソッドの中でやる。"""

    supports_events = True
    supports_probe = True
    supports_events_b = True

    def _init_events(self):
        self._events = {}            # post id -> events の行（starts_at などは ISO 文字列）
        self._event_regs = {}        # (event id, account id) -> event_registrations の行
        self._event_answers = {}     # (event id, account id, prompt) -> event_answers の行
        self._event_meetings = set()   # (event id, from, to)  第2回b
        self._line_links = {}        # account id -> line_links の行
        self._line_orphans = {}      # LINE の userId -> まだアカウントに結べていない友だち
        self._line_subs = {}         # LINE の sub（= userId）-> account id（auth.identities の代わり）
        self._outbound = {}          # id -> outbound_messages の行
        self._probe_hits = {}        # (event id, device, JST day) -> n
        self._webhook_seen = {}      # webhook event id -> received_at
        self._sent_messages = []     # 手元では LINE に送らず、ここに積む

    # -- small readers -------------------------------------------------------

    def _has_event_registration(self, account_id):
        """accounts_invite_guard: 申し込みの行がある人は、招待がなくてもアカウントを作れる。"""
        return any(key[1] == account_id for key in self._event_regs)

    def _event_row(self, event):
        return dict(event)

    def event_by_code(self, code):
        with self._lock:
            for row in self._events.values():
                if row["public_code"] == code:
                    return self._event_row(row)
        return None

    def event_by_checkin_code(self, code):
        with self._lock:
            for row in self._events.values():
                if row["checkin_code"] == code:
                    return self._event_row(row)
        return None

    def event_by_post(self, post_id):
        with self._lock:
            row = self._events.get(post_id)
            return self._event_row(row) if row else None

    def is_community_admin(self, community_id, account_id):
        with self._lock:
            return self._is_admin(community_id, account_id)

    def event_community_name(self, community_id):
        with self._lock:
            return (self._communities.get(community_id) or {}).get("name")

    def event_registration(self, event_id, account_id):
        with self._lock:
            row = self._event_regs.get((event_id, account_id))
            return dict(row) if row else None

    def my_event_registrations(self, account_id):
        """この人の申し込み（全部の状態）。会の情報つき：event_id・status・public_code・title・starts_at・
        ends_at・place・cancelled_at（会の中止）・registration_cancelled_at。"""
        with self._lock:
            rows = []
            for (event_id, account), reg in self._event_regs.items():
                event = self._events.get(event_id)
                if account != account_id or not event:
                    continue
                rows.append({
                    "event_id": event_id, "post_id": event_id, "status": reg["status"],
                    "public_code": event["public_code"], "title": event["title"],
                    "starts_at": event["starts_at"], "ends_at": event["ends_at"], "place": event["place"],
                    "cancelled_at": event["cancelled_at"], "registration_cancelled_at": reg["cancelled_at"],
                    "late_minutes": reg["late_minutes"], "community_id": event["community_id"],
                })
            rows.sort(key=lambda row: row["starts_at"])
            return rows

    def _event_banned(self, event, account, reg):
        """この会でお断りされた人。メンバーでない人は、前に外された人・断られた人（設計 A の記録）も。
        DB の event_apply と同じ（メンバーに戻った人は、外された記録があっても申し込める）。"""
        key = (event["community_id"], account)
        request = self._join_requests.get(key)
        if reg and reg["status"] == "declined":
            return True
        return key not in self._members and (key in self._removals
                                             or bool(request and request["status"] == "rejected"))

    def _event_live(self, event_id, allow_cancelled=False):
        event = self._events.get(event_id)
        if not event:
            refuse("event_not_found")
        post = self._posts.get(event_id)
        if not allow_cancelled and (event["cancelled_at"] or not post or post.get("deleted_at")):
            refuse("event_cancelled")
        return event, post

    # -- outbound (予約送信) -----------------------------------------------------

    def _outbound_put(self, event_id, account, kind, when):
        for row in self._outbound.values():
            if (row["event_id"], row["account_id"], row["kind"]) == (event_id, account, kind):
                row.update({"scheduled_at": _iso(when), "claimed_at": None, "sent_at": None,
                            "attempts": 0, "last_error": None})
                return row
        row = {"id": str(_s().uuid.uuid4()), "event_id": event_id, "account_id": account, "kind": kind,
               "scheduled_at": _iso(when), "claimed_at": None, "sent_at": None, "attempts": 0,
               "last_error": None}
        self._outbound[row["id"]] = row
        return row

    def _outbound_drop_unsent(self, event_id, account=None, kinds=None):
        for oid in [oid for oid, row in self._outbound.items()
                    if row["event_id"] == event_id and row["sent_at"] is None
                    and (account is None or row["account_id"] == account)
                    and (kinds is None or row["kind"] in kinds)]:
            del self._outbound[oid]

    def _event_schedule(self, event, account, now):
        """案内の予定（週前・当日・終了時）。DB の event_queue_reminders と同じ。呼ぶのは channel='line' の人だけ。
        中止（not_held）の会は入れない。"""
        from core.jobs import schedule_times
        if event.get("decision") == "not_held":
            return
        for kind, when in schedule_times(event, now).items():
            self._outbound_put(event["post_id"], account, kind, when)

    def outbound_claim(self, limit=OUTBOUND_BATCH, lease_seconds=OUTBOUND_LEASE_SECONDS, now=None):
        """送る時刻が来ていて、まだ送っていない友だち宛ての予約を取り出す（for update skip locked の代わり）。"""
        now = _utc(now)
        out = []
        with self._lock:
            for row in sorted(self._outbound.values(), key=lambda r: r["scheduled_at"]):
                if len(out) >= limit:
                    break
                if row["sent_at"] or row["attempts"] >= OUTBOUND_MAX_ATTEMPTS:
                    continue
                scheduled = _utc(row["scheduled_at"])
                if scheduled > now or now - scheduled >= timedelta(hours=OUTBOUND_STALE_HOURS):
                    continue
                if row["claimed_at"] and _utc(row["claimed_at"]) >= now - timedelta(seconds=lease_seconds):
                    continue
                link = self._line_links.get(row["account_id"])
                event = self._events.get(row["event_id"])
                if not link or not link["is_friend"] or not event or event.get("decision") == "not_held":
                    continue
                row["claimed_at"] = now.isoformat()
                row["attempts"] += 1
                out.append({
                    "id": row["id"], "event_id": row["event_id"], "account_id": row["account_id"],
                    "kind": row["kind"], "line_user_id": link["line_user_id"], "title": event["title"],
                    "starts_at": event["starts_at"], "ends_at": event["ends_at"], "place": event["place"],
                    "public_code": event["public_code"],
                    "near_count": None,      # DB の outbound_claim と同じ：常に null。core/jobs.py が week_before のときだけ埋める
                })
        return out

    def outbound_done(self, id, ok, error=None, now=None):
        with self._lock:
            row = self._outbound.get(id)
            if not row:
                return
            if ok:
                row["sent_at"] = _utc(now).isoformat()
                row["last_error"] = None
            else:
                row["last_error"] = str(error or "")[:200]

    # the LINE that is not sent from local mode
    def record_sent(self, row, messages):
        with self._lock:
            self._sent_messages.append({"to": row.get("account_id"), "line_user_id": row.get("line_user_id"),
                                        "kind": row.get("kind"), "event_id": row.get("event_id"),
                                        "messages": messages})

    def sent_messages(self):
        with self._lock:
            return [dict(item) for item in self._sent_messages]

    # -- 会を作る・変える -------------------------------------------------------------

    def event_create(self, *, post, actor, title, starts, ends, place, visibility, questions,
                     min_participants=None, decide_on=None, cancel_deadline=None, join_policy="auto"):
        with self._lock:
            row = self._posts.get(post)
            if not row or row.get("deleted_at") or row["author_id"] != actor:
                refuse("event_not_found")
            if (post in self._events or RECRUIT_TAG not in (row.get("tags") or [])
                    or row.get("recruit_capacity") is None or row.get("share_group")
                    or not row.get("community_id")):
                refuse("event_invalid")
            title = str(title or "").strip()
            place = str(place or "").strip()
            starts, ends = _utc(starts), _utc(ends)
            if (not 1 <= len(title) <= EVENT_TITLE_MAX or len(place) > EVENT_PLACE_MAX or ends <= starts
                    or visibility not in ("public", "community") or not isinstance(questions, list)
                    or len(questions) > EVENT_QUESTIONS_MAX):
                refuse("event_invalid")
            if not rules_ok(min_participants=min_participants, decide_on=decide_on,
                            cancel_deadline=cancel_deadline, join_policy=join_policy, starts=starts,
                            capacity=row.get("recruit_capacity"), now=_utc()):
                refuse("event_invalid")
            if visibility == "public" and not self._is_admin(row["community_id"], actor):
                refuse("public_admin_only")
            event = {"post_id": post, "community_id": row["community_id"], "title": title,
                     "starts_at": starts.isoformat(), "ends_at": ends.isoformat(), "place": place,
                     "visibility": visibility, "questions": [dict(item) for item in questions],
                     "public_code": new_code(), "checkin_code": new_code(), "cancelled_at": None,
                     "created_at": _utc().isoformat(),
                     "min_participants": None if min_participants is None else int(min_participants),
                     "decide_on": day_text(decide_on), "cancel_deadline": _iso(cancel_deadline),
                     "join_policy": join_policy, "decision": None, "decided_at": None}
            self._events[post] = event
            return {"post_id": post, "public_code": event["public_code"], "checkin_code": event["checkin_code"]}

    def event_update(self, *, post, actor, fields):
        with self._lock:
            event, row = self._event_live(post)
            if not row or row["author_id"] != actor:
                refuse("event_not_host")
            self._event_settle(post, _utc())          # 最初に判定（判定が出ていれば最小人数・判定日は変えられない）
            new = dict(event)
            for key in ("title", "place"):
                if key in fields:
                    new[key] = str(fields[key] or "").strip()
            for key in ("starts_at", "ends_at"):
                if key in fields:
                    new[key] = _iso(fields[key])
            if "questions" in fields:
                if not isinstance(fields["questions"], list) or len(fields["questions"]) > EVENT_QUESTIONS_MAX:
                    refuse("event_invalid")
                new["questions"] = [dict(item) for item in fields["questions"]]
            if "min_participants" in fields:
                value = fields["min_participants"]
                new["min_participants"] = None if value is None else int(value)
            if "decide_on" in fields:
                new["decide_on"] = day_text(fields["decide_on"])
            if "cancel_deadline" in fields:
                new["cancel_deadline"] = _iso(fields["cancel_deadline"])
            if "join_policy" in fields:
                new["join_policy"] = fields["join_policy"]
            if (not 1 <= len(new["title"]) <= EVENT_TITLE_MAX or len(new["place"]) > EVENT_PLACE_MAX
                    or _utc(new["ends_at"]) <= _utc(new["starts_at"])):
                refuse("event_invalid")
            rule_changed = any(new.get(key) != event.get(key) for key in ("min_participants", "decide_on"))
            if event.get("decision") and rule_changed:
                refuse("event_decided")
            # 開始日時を変えたときも、判定日・キャンセル期限と比べ直す（判定日の「今日以降」は変えたときだけ）
            if not rules_ok(min_participants=new.get("min_participants"), decide_on=new.get("decide_on"),
                            cancel_deadline=new.get("cancel_deadline"), join_policy=new.get("join_policy", "auto"),
                            starts=new["starts_at"], capacity=row.get("recruit_capacity"), now=_utc(),
                            check_today=new.get("decide_on") != event.get("decide_on")):
                refuse("event_invalid")
            moved = any(new[key] != event[key] for key in ("starts_at", "ends_at", "place"))
            changed = any(new.get(key) != event.get(key) for key in new)
            event.update(new)
            notified = 0
            if moved:
                now = _utc()
                applied = [account for (eid, account), reg in self._event_regs.items()
                           if eid == post and reg["status"] == "applied" and reg["channel"] == "line"]
                self._outbound_drop_unsent(post, kinds=("week_before", "day_of", "after"))
                for account in applied:
                    self._event_schedule(event, account, now)
                    self._outbound_put(post, account, "event_changed", now)
                notified = len(applied)
            self._event_settle(post, _utc())          # 最後にも判定（最小人数を下げて届いたら、その場で開催決定）
            return {"changed": changed, "notified": notified}

    def event_set_times(self, code, starts_at, ends_at):
        """手元だけのテスト用（POST /api/local/events/{code}/set-times）：時刻を動かす。"""
        with self._lock:
            event = next((row for row in self._events.values() if row["public_code"] == code), None)
            if not event:
                refuse("event_not_found")
            event["starts_at"], event["ends_at"] = _iso(starts_at), _iso(ends_at)

    # -- 申し込み ---------------------------------------------------------------------------

    def _event_state(self, event_id, account, post, status, was_guest, created_account):
        capacity = post.get("recruit_capacity") if post else None
        return {"status": status, "is_member": not was_guest, "was_guest": was_guest,
                "created_account": created_account,
                "remaining": None if capacity is None else max(0, capacity - int(post.get("join_count") or 0)),
                "phase": self._event_settle(event_id, _utc())}   # 最後にも判定（届いたら、その場で開催決定）

    def event_apply(self, *, event, account, profile=None, channel="email", referral=None,
                    answers=None, consent=None, now=None):
        now = _utc(now)
        profile = profile or {}
        channel = channel if channel in ("line", "email") else "email"
        with self._lock:
            ev, post = self._event_live(event)
            if self._event_settle(event, now) == "not_held":
                refuse("event_not_held")
            key = (event, account)
            reg = self._event_regs.get(key)
            if self._event_banned(ev, account, reg):
                refuse("event_banned")
            is_member = (ev["community_id"], account) in self._members
            if ev["visibility"] == "community" and not is_member:
                refuse("event_members_only")
            if reg and reg["status"] in ("applied", "attended", "waiting"):
                return self._event_state(event, account, post, "already", reg["was_guest"], reg["created_account"])
            # アカウントが無い人、またはフルネームの確認（name_confirmed_at）がまだの人は、名前と所属が要る（DB と同じ）
            current = self._accounts.get(account)
            confirmed = bool(current and current.get("name_confirmed_at"))
            name = str(profile.get("display_name") or "").strip()
            affiliation = str(profile.get("affiliation") or "").strip()
            if (current is None or not confirmed) and (
                    not name or len(name) > MAX_NAME_LENGTH
                    or not affiliation or len(affiliation) > MAX_AFFILIATION_LENGTH):
                refuse("name_required")
            age_band = profile.get("age_band") if profile.get("age_band") in dict(AGE_BANDS) else None
            job_title = str(profile.get("job_title") or "").strip()[:JOB_TITLE_MAX] or None
            # 回答：会の質問にある prompt だけ。同じ prompt は1回。メンバーでない人は質問のうち2つ（質問が1つなら1つ）
            asked = {item.get("prompt") for item in ev.get("questions") or []}
            kept = {}
            if not is_member:
                for item in answers or []:
                    prompt, body = item.get("prompt"), str(item.get("body") or "").strip()
                    if prompt in asked and 1 <= len(body) <= 60 and prompt not in kept:
                        kept[prompt] = {**item, "body": body}
                if len(kept) < min(EVENT_ANSWERS_MIN, len(asked)):
                    refuse("answers_required")
            # 定員・期限は join の安全装置が決める（recruit_closed / recruit_full がそのまま上がる）
            closed = closed_state(post.get("recruit_deadline"), post.get("recruit_capacity"),
                                  post.get("join_count"), now)
            if closed:
                refuse("recruit_closed" if closed == CLOSED_DEADLINE else "recruit_full")
            created = (current is None) or bool(reg and reg["created_account"])
            self._event_regs[key] = {
                "event_id": event, "account_id": account, "status": "applied",
                "consent_version": consent, "was_guest": not is_member, "created_account": created,
                "channel": channel,
                "referral": clean_referral(referral), "late_minutes": None, "late_at": None,
                "applied_at": now.isoformat(), "checked_in_at": None, "cancelled_at": None,
                "declined_at": None, "declined_by": None, "walkin_rejects": (reg or {}).get("walkin_rejects", 0),
            }
            if current is None or not confirmed:
                fields = {"display_name": name, "affiliation": affiliation, "name_confirmed_at": now.isoformat()}
                for column, value in (("age_band", age_band), ("job_title", job_title)):
                    if value:
                        fields[column] = value
                self.upsert_account(account, fields)
            else:
                # 確認済みの人の名前・所属は変えない。年代・職種は空のときだけ入れる
                fields = {column: value for column, value in (("age_band", age_band), ("job_title", job_title))
                          if value and not current.get(column)}
                if fields:
                    self.upsert_account(account, fields)
            # reactions に join を1行（数・主催者への通知は add_reaction と同じ）
            if (event, account, "join") not in self._reactions:
                self._reactions[(event, account, "join")] = now.isoformat()
                post["join_count"] = int(post.get("join_count") or 0) + 1
                post["energy"] = _s().computed_energy(post)
                if post["author_id"] != account:
                    self._notify(post["author_id"], account, event, None, "join")
            for key_ in [k for k in self._event_answers if k[0] == event and k[1] == account]:
                del self._event_answers[key_]
            for prompt, item in kept.items():
                self._event_answers[(event, account, prompt)] = {
                    "event_id": event, "account_id": account, "prompt": prompt, "body": item["body"],
                    "vec": item.get("vec"), "vec_c": item.get("vec_c"), "x": item.get("x"), "y": item.get("y"),
                    "cluster_id": item.get("cluster_id"), "terms": item.get("terms") or [],
                    "created_at": now.isoformat()}
            if channel == "line":       # 案内の予定は LINE で申し込んだ人にだけ（E の 14）
                self._event_schedule(ev, account, now)
            return self._event_state(event, account, post, "applied", not is_member, created)

    def _event_remove_join(self, event, account):
        if (event, account, "join") in self._reactions:
            self.remove_reaction(event, account, "join")

    def event_cancel_registration(self, *, event, account, now=None):
        now = _utc(now)
        with self._lock:
            ev, post = self._event_live(event, allow_cancelled=True)
            self._event_settle(event, now)
            reg = self._event_regs.get((event, account))
            if reg and reg["status"] == "attended":
                refuse("event_attended")
            if not reg or reg["status"] not in ("applied", "waiting"):
                refuse("event_not_applied")
            # キャンセル期限は申し込み（applied）にだけ（受付待ちの取り下げは期限なし）。期限の時刻ちょうどで締め切る（DB と同じ）
            if (reg["status"] == "applied" and ev.get("cancel_deadline")
                    and now >= _utc(ev["cancel_deadline"])):
                refuse("cancel_closed")
            # 受付待ち（waiting）の本人の取り下げも cancelled にして行を残す（飛び入りのやり直し3回の数えを消さない）
            was = reg["status"]
            reg.update({"status": "cancelled", "cancelled_at": now.isoformat()})
            self._event_remove_join(event, account)
            self._outbound_drop_unsent(event, account)
            for key_ in [k for k in self._event_answers if k[0] == event and k[1] == account]:
                del self._event_answers[key_]
            if was == "applied" and post and post["author_id"] != account:
                self._notify(post["author_id"], account, event, None, "event_cancel", payload={})
            return {"status": "cancelled"}

    def event_set_late(self, *, event, account, minutes, now=None):
        now = _utc(now)
        with self._lock:
            ev, post = self._event_live(event)
            if self._event_settle(event, now) == "not_held":
                refuse("event_not_held")
            reg = self._event_regs.get((event, account))
            if not reg or reg["status"] != "applied":
                refuse("event_not_applied")
            if minutes not in LATE_CHOICES:
                refuse("event_invalid")
            reg.update({"late_minutes": int(minutes), "late_at": now.isoformat()})
            if post["author_id"] != account:
                for nid in [nid for nid, row in self._notifications.items()
                            if row["type"] == "event_late" and row["post_id"] == event
                            and row["actor_id"] == account and row["read_at"] is None]:
                    del self._notifications[nid]
                self._notify(post["author_id"], account, event, None, "event_late",
                             payload={"minutes": int(minutes)})
            return {"late_minutes": int(minutes)}

    def event_decline(self, *, event, host, account, now=None):
        now = _utc(now)
        with self._lock:
            ev, post = self._event_live(event, allow_cancelled=True)
            if not post or post["author_id"] != host:
                refuse("event_not_host")
            reg = self._event_regs.get((event, account))
            if not reg:
                refuse("event_not_applied")
            if reg["status"] == "declined":
                return {"status": "declined"}
            if reg["status"] == "attended":
                refuse("event_attended")
            reg.update({"status": "declined", "declined_at": now.isoformat(), "declined_by": host})
            self._event_remove_join(event, account)
            self._outbound_drop_unsent(event, account)
            for key_ in [k for k in self._event_answers if k[0] == event and k[1] == account]:
                del self._event_answers[key_]
            if reg["channel"] == "line":     # お断りの LINE は LINE で申し込んだ人にだけ
                self._outbound_put(event, account, "declined", now)
            return {"status": "declined"}

    # -- 開催の判定（第2回b。DB の event_live_count・event_settle・event_settle_due と同じ） ----------------

    def _event_live_count(self, event_id):
        """生きている申し込みの数（applied と attended）。Lock held."""
        return sum(1 for (eid, _a), reg in self._event_regs.items()
                   if eid == event_id and reg["status"] in ("applied", "attended"))

    def _event_settle(self, event_id, now):
        """判定（設計 G の「共通」）。最小人数が無ければ None。記録済みならそれ、届いていれば held を記録、
        締め（判定日の翌 0:00 JST）を過ぎていれば not_held を記録して未送信を消す、それ以外は recruiting。Lock held."""
        event = self._events.get(event_id)
        if not event or event.get("min_participants") is None:
            return None
        if event.get("decision"):
            return event["decision"]
        if self._event_live_count(event_id) >= int(event["min_participants"]):
            event.update({"decision": "held", "decided_at": _utc(now).isoformat()})
            return "held"
        if _utc(now) >= decide_deadline(event["decide_on"]):
            event.update({"decision": "not_held", "decided_at": _utc(now).isoformat()})
            self._outbound_drop_unsent(event_id)
            return "not_held"
        return "recruiting"

    def event_settle(self, *, event, now=None):
        with self._lock:
            return self._event_settle(event, _utc(now))

    def event_settle_due(self, now=None):
        """最小人数あり・未判定・締めを過ぎた会を全部判定する。判定した数。"""
        now = _utc(now)
        with self._lock:
            due = [eid for eid, row in self._events.items()
                   if row.get("min_participants") is not None and not row.get("decision")
                   and now >= decide_deadline(row["decide_on"])]
            for eid in due:
                self._event_settle(eid, now)
            return len(due)

    def event_force(self, code, fields):
        """手元だけのテスト用（POST /api/local/events/{code}/force）：判定日・期限・判定を検めずに入れる。"""
        with self._lock:
            event = next((row for row in self._events.values() if row["public_code"] == code), None)
            if not event:
                refuse("event_not_found")
            for key, value in fields.items():
                if key == "decide_on":
                    event[key] = day_text(value)
                elif key == "cancel_deadline":
                    event[key] = _iso(value)
                elif key == "min_participants":
                    event[key] = None if value is None else int(value)
                elif key == "decision":
                    event["decision"] = value
                    event["decided_at"] = _utc().isoformat() if value else None
                elif key == "join_policy":
                    event[key] = value

    # -- コミュニティに入れる（DB の event_admit・event_after_attend と同じ） -----------------------------

    def _event_admit(self, event_id, account, now):
        """会のコミュニティのメンバーにする。外された・断られた記録があれば False。回答を posts へ写す
        （event_answers は消さない。参加者リストが使い、片付けで消える）。承認待ちの行は消す。Lock held."""
        event = self._events[event_id]
        key = (event["community_id"], account)
        if key in self._members:
            return False
        request = self._join_requests.get(key)
        if key in self._removals or (request and request["status"] == "rejected"):
            return False
        self._members[key] = {"role": "member", "joined_at": _utc(now).isoformat(), "joined_via": "event",
                              "invite_id": None, "event_post_id": event_id}
        for (eid, who, prompt), row in sorted(self._event_answers.items()):
            if eid != event_id or who != account:
                continue
            try:      # 投稿への写しが失敗しても加入は止めない（DB の event_admit と同じ）
                self.insert_post({
                    "author_id": account, "body": row["body"], "tags": [], "motivation": 50, "image_path": None,
                    "prompt": prompt, "x": row["x"], "y": row["y"], "cluster_id": row["cluster_id"],
                    "terms": list(row.get("terms") or []), "vec": row.get("vec"), "vec_c": row.get("vec_c"),
                    "community_id": event["community_id"]})
            except Exception:
                pass
        if request and request["status"] == "pending":
            self._drop_join_request(key)
        return True

    def _event_after_attend(self, event_id, account, now):
        """受付のあと：入り方が auto で、まだメンバーでなければコミュニティに入れる。入ったか。Lock held."""
        event = self._events[event_id]
        if event.get("join_policy", "auto") != "auto":
            return False
        return self._event_admit(event_id, account, now)

    # -- 受付（DB の event_checkin・event_walkin_request・event_checkin_by_host・event_reject_walkin） -------

    def _event_open_for_checkin(self, event_id, now, *, check_window=True):
        """中止・not_held・受付時間の外を断る。(会, 投稿)。Lock held."""
        ev, post = self._event_live(event_id)
        if self._event_settle(event_id, now) == "not_held":
            refuse("event_not_held")
        if check_window and not in_checkin_window(ev, now):
            refuse("checkin_closed")
        return ev, post

    def _event_attend(self, reg, now):
        reg.update({"status": "attended", "checked_in_at": _utc(now).isoformat(), "cancelled_at": None})

    def event_checkin(self, *, event, account, now=None):
        """QR で受付する。{"result": attended|already|need_walkin|waiting, "joined": bool}。"""
        now = _utc(now)
        with self._lock:
            ev, _post = self._event_open_for_checkin(event, now)
            key = (event, account)
            reg = self._event_regs.get(key)
            if self._event_banned(ev, account, reg):
                refuse("event_banned")
            is_member = (ev["community_id"], account) in self._members
            if reg and reg["status"] == "applied":
                self._event_attend(reg, now)
                return {"result": "attended", "joined": self._event_after_attend(event, account, now)}
            if reg and reg["status"] == "attended":
                return {"result": "already", "joined": False}
            if reg and reg["status"] == "waiting":
                return {"result": "waiting", "joined": False}
            if reg and reg["status"] == "cancelled" and reg["channel"] != "walkin":
                refuse("checkin_cancelled_reg")
            # 申し込みが無い（か、飛び入りが却下された・取り下げた）人：メンバーはその場で受付、ほかは飛び入りへ
            if not is_member:
                return {"result": "need_walkin", "joined": False}
            self._event_regs[key] = {
                "event_id": event, "account_id": account, "status": "attended", "consent_version": None,
                "was_guest": False, "created_account": False, "channel": "walkin", "referral": None,
                "late_minutes": None, "late_at": None, "applied_at": now.isoformat(),
                "checked_in_at": now.isoformat(), "cancelled_at": None, "declined_at": None,
                "declined_by": None, "walkin_rejects": (reg or {}).get("walkin_rejects", 0)}
            return {"result": "attended", "joined": False}

    def event_walkin_request(self, *, event, account, profile=None, consent=None, now=None):
        """飛び入りの受付待ちになる。{"status": "waiting"}（申し込み・受付済みの人はその状態）。"""
        now = _utc(now)
        profile = profile or {}
        with self._lock:
            ev, _post = self._event_open_for_checkin(event, now)
            key = (event, account)
            reg = self._event_regs.get(key)
            if self._event_banned(ev, account, reg):
                refuse("event_banned")
            if reg and reg["status"] in ("applied", "attended", "waiting"):
                return {"status": reg["status"]}
            if reg and reg["walkin_rejects"] >= WALKIN_REJECT_MAX:
                refuse("walkin_limit")
            current = self._accounts.get(account)
            confirmed = bool(current and current.get("name_confirmed_at"))
            name = str(profile.get("display_name") or "").strip()
            affiliation = str(profile.get("affiliation") or "").strip()
            if (current is None or not confirmed) and (
                    not name or len(name) > MAX_NAME_LENGTH
                    or not affiliation or len(affiliation) > MAX_AFFILIATION_LENGTH):
                refuse("name_required")
            created = (current is None) or bool(reg and reg["created_account"])
            if current is None or not confirmed:
                self.upsert_account(account, {"display_name": name, "affiliation": affiliation,
                                              "name_confirmed_at": now.isoformat()})
            is_member = (ev["community_id"], account) in self._members
            if reg:
                reg.update({"status": "waiting", "cancelled_at": None, "consent_version": consent or reg["consent_version"]})
            else:
                self._event_regs[key] = {
                    "event_id": event, "account_id": account, "status": "waiting", "consent_version": consent,
                    "was_guest": not is_member, "created_account": created, "channel": "walkin", "referral": None,
                    "late_minutes": None, "late_at": None, "applied_at": now.isoformat(), "checked_in_at": None,
                    "cancelled_at": None, "declined_at": None, "declined_by": None, "walkin_rejects": 0}
            return {"status": "waiting"}

    def event_checkin_by_host(self, *, event, host, account, now=None):
        """主催者が名簿で受付する（受付待ち・申し込み済みの人）。受付の時間は見ない。{"status","joined"}。"""
        now = _utc(now)
        with self._lock:
            ev, post = self._event_live(event)
            if not post or post["author_id"] != host:
                refuse("event_not_host")
            self._event_open_for_checkin(event, now, check_window=False)
            reg = self._event_regs.get((event, account))
            if not reg or reg["status"] not in ("waiting", "applied"):
                refuse("not_waiting")
            self._event_attend(reg, now)
            return {"status": "attended", "joined": self._event_after_attend(event, account, now)}

    def event_reject_walkin(self, *, event, host, account, now=None):
        """主催者が受付待ちを却下する（「違う人」）。{"walkin_rejects": n}。"""
        now = _utc(now)
        with self._lock:
            _ev, post = self._event_live(event, allow_cancelled=True)
            if not post or post["author_id"] != host:
                refuse("event_not_host")
            reg = self._event_regs.get((event, account))
            if not reg or reg["status"] != "waiting":
                refuse("not_waiting")
            reg.update({"status": "cancelled", "cancelled_at": now.isoformat(),
                        "walkin_rejects": min(WALKIN_REJECT_MAX, reg["walkin_rejects"] + 1)})
            return {"walkin_rejects": reg["walkin_rejects"]}

    def event_join_community(self, *, event, account, now=None):
        """「本人に確認」の会で、受付済みの人が自分でコミュニティに入る。{"status": joined|already}。"""
        now = _utc(now)
        with self._lock:
            ev, _post = self._event_live(event, allow_cancelled=True)
            if ev.get("join_policy", "auto") != "ask":
                refuse("join_not_allowed")
            reg = self._event_regs.get((event, account))
            if not reg or reg["status"] != "attended":
                refuse("event_not_attended")
            if (ev["community_id"], account) in self._members:
                return {"status": "already"}
            if not self._event_admit(event, account, now):
                refuse("event_banned")
            return {"status": "joined"}

    def event_banned_for(self, event_id, account_id):
        """受付の画面の「お断り」：この会でお断りされた、またはメンバーでなく前に外された・断られた人か。"""
        with self._lock:
            event = self._events.get(event_id)
            if not event:
                return False
            return self._event_banned(event, account_id, self._event_regs.get((event_id, account_id)))

    # -- 参加者リスト・会のあと（DB の event_participants・event_participant_answers・event_after_people・event_meet）

    def _event_person(self, event, account):
        person = self._accounts.get(account) or {}
        return {"account_id": account, "display_name": person.get("display_name") or "",
                "affiliation": person.get("affiliation"), "job_title": person.get("job_title"),
                "icon_id": person.get("icon_id", "0"), "avatar_path": person.get("avatar_path"),
                "is_member": (event["community_id"], account) in self._members}

    def event_participants(self, event_id):
        """applied・attended の人と主催者（申し込みが無ければ status='host'）。申し込み順、主催者は最後。年代は返さない。"""
        with self._lock:
            event = self._events.get(event_id)
            if not event:
                return []
            host = (self._posts.get(event_id) or {}).get("author_id")
            regs = sorted(((account, reg) for (eid, account), reg in self._event_regs.items()
                           if eid == event_id and reg["status"] in ("applied", "attended")),
                          key=lambda item: _utc(item[1]["applied_at"]))
            rows = [{**self._event_person(event, account), "status": reg["status"],
                     "late_minutes": reg["late_minutes"], "is_host": account == host,
                     "checked_in_at": reg["checked_in_at"]} for account, reg in regs]
            if host and not any(row["account_id"] == host for row in rows):
                rows.append({**self._event_person(event, host), "status": "host", "late_minutes": None,
                             "is_host": True, "checked_in_at": None})
            return rows

    def event_participant_answers(self, event_id):
        """[{account_id, prompt, body}]：applied・attended の人の回答。"""
        with self._lock:
            return [{"account_id": account, "prompt": prompt, "body": row["body"]}
                    for (eid, account, prompt), row in sorted(self._event_answers.items())
                    if eid == event_id and self._event_regs.get((eid, account), {}).get("status")
                    in ("applied", "attended")]

    def event_after_people(self, *, event, account):
        """会のあと：自分以外の受付済みの人。met は自分→相手の「会えてよかった」があるか。"""
        with self._lock:
            ev = self._events.get(event)
            if not ev:
                refuse("event_not_found")
            reg = self._event_regs.get((event, account))
            if not reg or reg["status"] != "attended":
                refuse("event_not_attended")
            others = sorted(((who, row) for (eid, who), row in self._event_regs.items()
                             if eid == event and who != account and row["status"] == "attended"),
                            key=lambda item: _utc(item[1]["checked_in_at"] or item[1]["applied_at"]))
            return [{**self._event_person(ev, who), "met": (event, account, who) in self._event_meetings}
                    for who, _row in others]

    def event_meet(self, *, event, from_id, to_id, on):
        """「会えてよかった」を付ける・外す。2人とも受付済みでなければ event_not_attended。{"on": bool}。"""
        with self._lock:
            if event not in self._events:
                refuse("event_not_found")
            for who in (from_id, to_id):
                reg = self._event_regs.get((event, who))
                if not reg or reg["status"] != "attended":
                    refuse("event_not_attended")
            if from_id == to_id:
                refuse("event_invalid")
            if on:
                self._event_meetings.add((event, from_id, to_id))
            else:
                self._event_meetings.discard((event, from_id, to_id))
            return {"on": bool(on)}

    def event_talk_targets(self, account_id):
        """この人が「もっと話してみたい」を押している相手（押しただけ・両思いの両方）。会のあとの talk に使う。"""
        return {row["target"] for row in self.talk_state(account_id)}

    def _event_on_post_deleted(self, post_id):
        """events_on_post_delete（トリガー）：会の投稿が消されたら会は中止。未送信を消し、申し込み中の人に
        中止を送る（LINE）。メンバーにはアプリの中の通知 event_cancelled。失敗しても削除は止めない。Lock held."""
        try:
            event = self._events.get(post_id)
            if not event or event["cancelled_at"]:
                return
            now = _utc()
            event["cancelled_at"] = now.isoformat()
            self._outbound_drop_unsent(post_id)
            host = (self._posts.get(post_id) or {}).get("author_id")
            for (eid, account), reg in sorted(self._event_regs.items()):
                if eid != post_id or reg["status"] != "applied":
                    continue
                if reg["channel"] == "line":
                    self._outbound_put(post_id, account, "event_cancelled", now)
                if (event["community_id"], account) in self._members and account != host:
                    self._notify(account, host, post_id, None, "event_cancelled",
                                 payload={"title": event["title"]}, community_id=event["community_id"])
        except Exception:
            pass

    # -- 読み取り ----------------------------------------------------------------------------

    def event_roster(self, event_id):
        """主催者の名簿の材料：申し込み1件ごとに人の情報つき。受付待ちが先、あとは申し込み順。"""
        with self._lock:
            event = self._events.get(event_id)
            rows = []
            for (eid, account), reg in self._event_regs.items():
                if eid != event_id:
                    continue
                person = self._accounts.get(account) or {}
                member = self._members.get((event["community_id"], account)) if event else None
                link = self._line_links.get(account)
                key = (event["community_id"], account) if event else None
                request = self._join_requests.get(key)
                rows.append({
                    "account_id": account, "display_name": person.get("display_name") or "",
                    "affiliation": person.get("affiliation"), "job_title": person.get("job_title"),
                    "age_band": person.get("age_band"), "icon_id": person.get("icon_id", "0"),
                    "referral": reg["referral"], "joined_via": (member or {}).get("joined_via"),
                    "channel": reg["channel"], "status": reg["status"], "late_minutes": reg["late_minutes"],
                    "banned_before": bool(key in self._removals or (request and request["status"] == "rejected")),
                    "line_friend": bool(link and link["is_friend"]), "rejects": reg["walkin_rejects"],
                    "was_guest": reg["was_guest"], "applied_at": reg["applied_at"], "is_member": member is not None,
                })
            rows.sort(key=lambda row: (row["status"] != "waiting", _utc(row["applied_at"])))
            return rows

    def event_answer_vectors(self, event_id):
        """受付前の回答（申し込み中・受付済みの人の分）。vec_c は数のリスト。"""
        with self._lock:
            return [{"account_id": account, "prompt": prompt, "body": row["body"], "vec_c": row["vec_c"],
                     "x": row["x"], "y": row["y"], "cluster_id": row["cluster_id"]}
                    for (eid, account, prompt), row in self._event_answers.items()
                    if eid == event_id and self._event_regs[(eid, account)]["status"] in ("applied", "attended")]

    def event_probe_hit(self, *, event, device, ip, now=None):
        """同じ cookie・同じ IP は1つの会につき1日5回、会全体で1日300回。超えたら ok=False（数えない）。"""
        day = jst_day(now)
        keys = [(event, device, day), (event, "ip:" + str(ip), day)]
        every = (event, "*", day)
        with self._lock:
            counts = [self._probe_hits.get(key, 0) for key in keys]
            if max(counts) >= PROBE_PER_DEVICE_PER_DAY or self._probe_hits.get(every, 0) >= PROBE_PER_EVENT_PER_DAY:
                return {"ok": False, "remaining": 0}
            for key in keys + [every]:
                self._probe_hits[key] = self._probe_hits.get(key, 0) + 1
            return {"ok": True, "remaining": PROBE_PER_DEVICE_PER_DAY - max(counts) - 1}

    # -- LINE -----------------------------------------------------------------------------------

    def set_line_sub(self, account_id, sub):
        """手元の代役：ログインした人の LINE の sub（本番は auth.identities）。"""
        with self._lock:
            self._line_subs[sub] = account_id

    def account_by_line_sub(self, sub):
        with self._lock:
            return self._line_subs.get(sub)

    def line_link_save(self, account, line_user_id, is_friend=True):
        """DB の line_link_save と同じ。account が None（まだ結べない友だち）なら、userId と友だちの状態だけ記録する。"""
        now = _utc().isoformat()
        friend = True if is_friend is None else bool(is_friend)
        with self._lock:
            if not account:
                row = self._line_orphans.get(line_user_id)
                if row is None:
                    self._line_orphans[line_user_id] = {
                        "line_user_id": line_user_id, "is_friend": friend,
                        "followed_at": now if friend else None, "unfollowed_at": None if friend else now}
                    return
                if friend and not row["is_friend"]:
                    row["followed_at"] = now
                if friend:
                    row["unfollowed_at"] = None
                elif row["is_friend"]:
                    row["unfollowed_at"] = now
                row["is_friend"] = friend
                return
            for other in [a for a, r in self._line_links.items() if r["line_user_id"] == line_user_id and a != account]:
                del self._line_links[other]          # 同じ LINE の人が別のアカウントに付いていたら、そちらを外す
            self._line_orphans.pop(line_user_id, None)
            row = self._line_links.get(account)
            if row is None:
                self._line_links[account] = {
                    "account_id": account, "line_user_id": line_user_id, "is_friend": friend, "created_at": now,
                    "followed_at": now if friend else None, "unfollowed_at": None if friend else now}
                return
            if friend and (not row["is_friend"] or row["line_user_id"] != line_user_id or row["followed_at"] is None):
                row["followed_at"] = now
            if friend:
                row["unfollowed_at"] = None
            elif row["is_friend"]:
                row["unfollowed_at"] = now
            row.update({"line_user_id": line_user_id, "is_friend": friend})

    def line_link_attach(self, account, line_user_id):
        """DB の line_link_attach と同じ。先に友だち追加していた人の記録（なければ今の結びつき、なければ「友だちではない」）を
        アカウントに結ぶ。結んだあとの is_friend を返す。"""
        if not account or not line_user_id:
            return False
        now = _utc().isoformat()
        with self._lock:
            pending = self._line_orphans.get(line_user_id)
            current = self._line_links.get(account)
            if pending is not None:
                friend = bool(pending["is_friend"])
            elif current is not None and current["line_user_id"] == line_user_id:
                friend = bool(current["is_friend"])
            else:
                friend = False
            for other in [a for a, r in self._line_links.items() if r["line_user_id"] == line_user_id and a != account]:
                del self._line_links[other]
            self._line_orphans.pop(line_user_id, None)
            followed = (((pending or {}).get("followed_at") or (current or {}).get("followed_at") or now)
                        if friend else None)
            unfollowed = None if friend else ((pending or {}).get("unfollowed_at")
                                              or (current or {}).get("unfollowed_at"))
            self._line_links[account] = {
                "account_id": account, "line_user_id": line_user_id, "is_friend": friend,
                "followed_at": followed, "unfollowed_at": unfollowed,
                "created_at": (current or {}).get("created_at") or now}
            return friend

    def line_link_unfollow(self, line_user_id):
        """DB の line_link_unfollow と同じ。結びついていない人は、友だちではないと記録する。"""
        now = _utc().isoformat()
        with self._lock:
            linked = False
            for row in self._line_links.values():
                if row["line_user_id"] == line_user_id:
                    linked = True
                    if row["is_friend"]:
                        row.update({"is_friend": False, "unfollowed_at": now})
            if not linked:
                row = self._line_orphans.setdefault(line_user_id, {"line_user_id": line_user_id, "followed_at": None})
                row.update({"is_friend": False, "unfollowed_at": now})

    def line_link_of(self, account_id):
        with self._lock:
            row = self._line_links.get(account_id)
            return dict(row) if row else None

    def line_webhook_seen(self, webhook_event_id, now=None):
        """入れられたら True（新しい）、既にあれば False（二重）。"""
        with self._lock:
            if webhook_event_id in self._webhook_seen:
                return False
            self._webhook_seen[webhook_event_id] = _utc(now).isoformat()
            return True

    # -- 片付け（保存期間。E の 4・5・6） ------------------------------------------------------------------

    def event_cleanup(self, now=None):
        now = _utc(now)
        done = {"registrations": 0, "answers": 0, "outbound": 0, "webhook_events": 0, "probe_hits": 0}
        gone = set()
        with self._lock:
            old = {eid for eid, event in self._events.items()
                   if _utc(event["ends_at"]) + timedelta(days=EVENT_CLEANUP_DAYS) <= now}
            for key in [k for k, reg in self._event_regs.items() if k[0] in old and reg["status"] != "attended"]:
                reg = self._event_regs.pop(key)
                done["registrations"] += 1
                if reg["created_account"]:
                    gone.add(key[1])
            for key in [k for k in self._event_answers if k[0] in old]:
                del self._event_answers[key]
                done["answers"] += 1
            for oid in [oid for oid, row in self._outbound.items() if row["event_id"] in old]:
                del self._outbound[oid]
                done["outbound"] += 1
            horizon = now - timedelta(days=LINE_WEBHOOK_KEEP_DAYS)
            for wid in [w for w, at in self._webhook_seen.items() if _utc(at) < horizon]:
                del self._webhook_seen[wid]
                done["webhook_events"] += 1
            today = jst_day(now)
            for key in [k for k in self._probe_hits if k[2] < today]:
                del self._probe_hits[key]
                done["probe_hits"] += 1
            # アカウントごと消してよいのは、この申し込みで作った人で、どのコミュニティにも入らず、
            # ほかの申し込みも承認待ちも無い人だけ（E の 18）
            ids = []
            for account in sorted(gone):
                if (any(m[1] == account for m in self._members)
                        or any(k[1] == account for k in self._event_regs)
                        or any(k[1] == account and r["status"] == "pending"
                               for k, r in self._join_requests.items())):
                    continue
                ids.append(account)
        return {**done, "account_ids": ids}

    def delete_auth_user(self, account_id):
        """管理 API でアカウントを消す代役（手元）：人と、その人の会まわりの行。"""
        with self._lock:
            self._accounts.pop(account_id, None)
            self._profile_vectors.pop(account_id, None)
            self._line_links.pop(account_id, None)
            for key in [k for k in self._event_regs if k[1] == account_id]:
                del self._event_regs[key]
            for key in [k for k in self._event_answers if k[1] == account_id]:
                del self._event_answers[key]
            for oid in [oid for oid, row in self._outbound.items() if row["account_id"] == account_id]:
                del self._outbound[oid]


# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------

EVENTS_CHECK_SECONDS = 60


class EventsSupabaseMixin:
    """SupabaseStore の会まわり。書き込みは DB 関数（RPC）、読み取りは表を PostgREST で。"""

    _has_events = False
    _events_checked_at = None
    _has_probe = False
    _has_events_b = False
    _events_b_checked_at = None

    def _event_rpc(self, name, payload, label):
        """RPC を呼ぶ。DB 関数の断り（400 + hint）は EventRefused に。本文は画面に出さない。"""
        response = self._send("POST", f"rpc/{name}", label=label, json=payload, allow_statuses=(400,))
        if response.status_code == 400:
            try:
                body = response.json() or {}
            except Exception:
                body = {}
            hint, message = body.get("hint"), body.get("message")
            code = hint if hint in EVENT_STATUS_OF else (message if message in ("recruit_closed", "recruit_full") else None)
            if code:
                refuse(code)
            if hint == "invite_required":
                raise _s().InviteRequired()
            print(f"[store] {label} failed: HTTP 400: {(response.text or '')[:200]}", flush=True)
            raise _s().StoreError(label)
        if not response.content:
            return None
        return response.json()

    def _events_table_ready(self, table):
        response = self._send("GET", table, label="会の表の確認", allow_statuses=(400, 404),
                              params={"select": "*", "limit": "1"})
        return response.status_code < 300

    def events_ready(self):
        now = time.monotonic()
        if self._events_checked_at is not None and now - self._events_checked_at < EVENTS_CHECK_SECONDS:
            return self._has_events
        try:
            ready = self._events_table_ready("events")
            probe = ready and self._events_table_ready("event_probe_hits")
        except _s().StoreError:
            self._events_checked_at = now - EVENTS_CHECK_SECONDS + 10
            raise
        if ready != self._has_events or self._events_checked_at is None:
            print("[store] events: " + ("tables found; 会の申し込みが使えます" if ready else
                  "tables missing; 会は supabase/migrations/20261106000000_events.sql を流すまで止まっています"),
                  flush=True)
        self._has_events, self._has_probe, self._events_checked_at = ready, probe, now
        return ready

    @property
    def supports_events(self):
        try:
            return self.events_ready()
        except _s().StoreError:
            return self._has_events

    @property
    def supports_probe(self):
        return self.supports_events and self._has_probe

    def events_b_ready(self):
        """第2回b の SQL（20261111000000_events_b.sql）が流れているか：events に join_policy の列があるか。
        events_ready と同じく1分ほど覚える。"""
        now = time.monotonic()
        if self._events_b_checked_at is not None and now - self._events_b_checked_at < EVENTS_CHECK_SECONDS:
            return self._has_events_b
        try:
            response = self._send("GET", "events", label="会の列の確認", allow_statuses=(400, 404),
                                  params={"select": "join_policy", "limit": "1"})
        except _s().StoreError:
            self._events_b_checked_at = now - EVENTS_CHECK_SECONDS + 10
            raise
        ready = response.status_code < 300
        if ready != self._has_events_b or self._events_b_checked_at is None:
            print("[store] events_b: " + ("columns found; 開催の条件・受付が使えます" if ready else
                  "columns missing; 開催の条件・受付は supabase/migrations/20261111000000_events_b.sql を流すまで止まっています"),
                  flush=True)
        self._has_events_b, self._events_b_checked_at = ready, now
        return ready

    @property
    def supports_events_b(self):
        if not self.supports_events:
            return False
        try:
            return self.events_b_ready()
        except _s().StoreError:
            return self._has_events_b

    # -- reads (tables) --------------------------------------------------------------------------

    def _event_one(self, column, value):
        rows = self._get("events", {"select": "*", column: f"eq.{value}", "limit": "1"}, label="会の読み込み")
        return rows[0] if rows else None

    def event_by_code(self, code):
        return self._event_one("public_code", code)

    def event_by_checkin_code(self, code):
        return self._event_one("checkin_code", code)

    def event_by_post(self, post_id):
        return self._event_one("post_id", post_id)

    def is_community_admin(self, community_id, account_id):
        rows = self._get("community_members", {
            "select": "role", "community_id": f"eq.{community_id}", "account_id": f"eq.{account_id}",
            "limit": "1"}, label="役割の読み込み")
        return bool(rows and rows[0].get("role") == "admin")

    def event_community_name(self, community_id):
        rows = self._get("communities", {"select": "name", "id": f"eq.{community_id}", "limit": "1"},
                         label="コミュニティの読み込み")
        return rows[0]["name"] if rows else None

    def event_registration(self, event_id, account_id):
        rows = self._get("event_registrations", {
            "select": "*", "event_id": f"eq.{event_id}", "account_id": f"eq.{account_id}", "limit": "1"},
            label="申し込みの読み込み")
        return rows[0] if rows else None

    def my_event_registrations(self, account_id):
        rows = self._get("event_registrations", {
            "select": "*,events(post_id,public_code,title,starts_at,ends_at,place,cancelled_at,community_id)",
            "account_id": f"eq.{account_id}"}, label="申し込みの読み込み")
        out = []
        for row in rows:
            event = row.pop("events", None) or {}
            if not event:
                continue
            out.append({
                "event_id": row["event_id"], "post_id": row["event_id"], "status": row["status"],
                "public_code": event.get("public_code"), "title": event.get("title"),
                "starts_at": event.get("starts_at"), "ends_at": event.get("ends_at"),
                "place": event.get("place"), "cancelled_at": event.get("cancelled_at"),
                "registration_cancelled_at": row.get("cancelled_at"),
                "late_minutes": row.get("late_minutes"), "community_id": event.get("community_id")})
        out.sort(key=lambda item: item["starts_at"] or "")
        return out

    def event_roster(self, event_id):
        event = self.event_by_post(event_id)
        regs = self._get("event_registrations", {"select": "*", "event_id": f"eq.{event_id}"},
                         label="名簿の読み込み")
        if not event or not regs:
            return []
        ids = [row["account_id"] for row in regs]
        joined = ",".join(ids)
        people = {row["id"]: row for row in self._get("accounts", {
            "select": "id,display_name,affiliation,job_title,age_band,icon_id", "id": f"in.({joined})"},
            label="名簿の読み込み")}
        members = {row["account_id"]: row for row in self._get("community_members", {
            "select": "account_id,joined_via", "community_id": f"eq.{event['community_id']}",
            "account_id": f"in.({joined})"}, label="名簿の読み込み")}
        banned = {row["account_id"] for row in self._get("community_removals", {
            "select": "account_id", "community_id": f"eq.{event['community_id']}",
            "account_id": f"in.({joined})"}, label="名簿の読み込み")}
        banned |= {row["account_id"] for row in self._get("community_join_requests", {
            "select": "account_id", "community_id": f"eq.{event['community_id']}", "status": "eq.rejected",
            "account_id": f"in.({joined})"}, label="名簿の読み込み")}
        friends = {row["account_id"] for row in self._get("line_links", {
            "select": "account_id", "is_friend": "eq.true", "account_id": f"in.({joined})"},
            label="名簿の読み込み")}
        rows = []
        for reg in regs:
            person = people.get(reg["account_id"]) or {}
            rows.append({
                "account_id": reg["account_id"], "display_name": person.get("display_name") or "",
                "affiliation": person.get("affiliation"), "job_title": person.get("job_title"),
                "age_band": person.get("age_band"), "icon_id": person.get("icon_id", "0"),
                "referral": reg.get("referral"), "joined_via": (members.get(reg["account_id"]) or {}).get("joined_via"),
                "channel": reg["channel"], "status": reg["status"], "late_minutes": reg.get("late_minutes"),
                "banned_before": reg["account_id"] in banned, "line_friend": reg["account_id"] in friends,
                "rejects": reg.get("walkin_rejects", 0), "was_guest": reg.get("was_guest", False),
                "applied_at": reg["applied_at"], "is_member": reg["account_id"] in members})
        rows.sort(key=lambda row: (row["status"] != "waiting", row["applied_at"] or ""))
        return rows

    def event_answer_vectors(self, event_id):
        rows = self._event_rpc("event_answer_vectors", {"p_event": event_id}, "回答の読み込み") or []
        _parse = _s()._parse_vector
        return [{**row, "vec_c": _parse(row.get("vec_c"))} for row in rows]

    # -- writes (RPC) ---------------------------------------------------------------------------------

    def event_create(self, *, post, actor, title, starts, ends, place, visibility, questions,
                     min_participants=None, decide_on=None, cancel_deadline=None, join_policy="auto"):
        payload = {
            "p_post": post, "p_actor": actor, "p_title": title, "p_starts": _iso(starts), "p_ends": _iso(ends),
            "p_place": place, "p_visibility": visibility, "p_questions": questions}
        if self.supports_events_b:
            # 第2回b の SQL が無い DB には送らない（今の8引数で呼ぶ）
            payload.update({"p_min": min_participants, "p_decide_on": day_text(decide_on),
                            "p_cancel_deadline": _iso(cancel_deadline), "p_join_policy": join_policy})
        return self._event_rpc("event_create", payload, "会の保存")

    def event_update(self, *, post, actor, fields):
        new_keys = ("min_participants", "decide_on", "cancel_deadline", "join_policy")
        if not self.supports_events_b:
            fields = {key: value for key, value in fields.items() if key not in new_keys}
        fields = {key: (_iso(value) if key in ("starts_at", "ends_at", "cancel_deadline")
                        else day_text(value) if key == "decide_on" else value)
                  for key, value in fields.items()}
        return self._event_rpc("event_update", {"p_post": post, "p_actor": actor, "p_fields": fields}, "会の更新")

    def event_apply(self, *, event, account, profile=None, channel="email", referral=None,
                    answers=None, consent=None):
        return self._event_rpc("event_apply", {
            "p_event": event, "p_account": account, "p_profile": profile or {}, "p_channel": channel,
            "p_referral": clean_referral(referral), "p_answers": _answers_for_rpc(answers),
            "p_consent": consent}, "申し込みの保存")

    def event_cancel_registration(self, *, event, account):
        return self._event_rpc("event_cancel_registration", {"p_event": event, "p_account": account},
                               "申し込みの取り消し")

    def event_set_late(self, *, event, account, minutes):
        return self._event_rpc("event_set_late", {"p_event": event, "p_account": account, "p_minutes": minutes},
                               "遅れる連絡の保存")

    def event_decline(self, *, event, host, account):
        return self._event_rpc("event_decline", {"p_event": event, "p_host": host, "p_account": account},
                               "お断りの保存")

    # -- 第2回b（20261111000000_events_b.sql） -----------------------------------------------------------

    def event_settle(self, *, event):
        return self._event_rpc("event_settle", {"p_event": event}, "開催の判定")

    def event_settle_due(self):
        return int(self._event_rpc("event_settle_due", {}, "開催の判定") or 0)

    def event_checkin(self, *, event, account):
        return self._event_rpc("event_checkin", {"p_event": event, "p_account": account}, "受付")

    def event_walkin_request(self, *, event, account, profile=None, consent=None):
        return self._event_rpc("event_walkin_request", {
            "p_event": event, "p_account": account, "p_profile": profile or {}, "p_consent": consent}, "受付待ち")

    def event_checkin_by_host(self, *, event, host, account):
        return self._event_rpc("event_checkin_by_host", {"p_event": event, "p_host": host, "p_account": account},
                               "受付")

    def event_reject_walkin(self, *, event, host, account):
        return self._event_rpc("event_reject_walkin", {"p_event": event, "p_host": host, "p_account": account},
                               "受付待ちの却下")

    def event_join_community(self, *, event, account):
        return self._event_rpc("event_join_community", {"p_event": event, "p_account": account},
                               "コミュニティへの参加")

    def event_participants(self, event_id):
        return self._event_rpc("event_participants", {"p_event": event_id}, "参加者の読み込み") or []

    def event_participant_answers(self, event_id):
        return self._event_rpc("event_participant_answers", {"p_event": event_id}, "参加者の読み込み") or []

    def event_after_people(self, *, event, account):
        return self._event_rpc("event_after_people", {"p_event": event, "p_account": account},
                               "会った人の読み込み") or []

    def event_meet(self, *, event, from_id, to_id, on):
        return self._event_rpc("event_meet", {"p_event": event, "p_from": from_id, "p_to": to_id, "p_on": bool(on)},
                               "会えてよかったの保存")

    def event_banned_for(self, event_id, account_id):
        """受付の画面の「お断り」（DB 関数でなく表を読む。名簿と同じ読み方）。"""
        event = self.event_by_post(event_id)
        if not event:
            return False
        reg = self.event_registration(event_id, account_id)
        if reg and reg.get("status") == "declined":
            return True
        community = event["community_id"]
        if self.is_community_member(community, account_id):
            return False
        removed = self._get("community_removals", {
            "select": "account_id", "community_id": f"eq.{community}", "account_id": f"eq.{account_id}",
            "limit": "1"}, label="受付の確認")
        rejected = self._get("community_join_requests", {
            "select": "account_id", "community_id": f"eq.{community}", "account_id": f"eq.{account_id}",
            "status": "eq.rejected", "limit": "1"}, label="受付の確認")
        return bool(removed or rejected)

    def event_talk_targets(self, account_id):
        """この人が「もっと話してみたい」を押している相手と、両思いの相手（talk_wishes・dm_rooms を読む）。"""
        pressed = self._get("talk_wishes", {"select": "to_id", "from_id": f"eq.{account_id}"},
                            label="話してみたいの読み込み")
        rooms = self._get("dm_rooms", {"select": "user_a,user_b",
                                       "or": f"(user_a.eq.{account_id},user_b.eq.{account_id})"},
                          label="話してみたいの読み込み")
        out = {row["to_id"] for row in pressed}
        out |= {row["user_b"] if row["user_a"] == account_id else row["user_a"] for row in rooms}
        return out

    def event_probe_hit(self, *, event, device, ip):
        return self._event_rpc("event_probe_hit", {"p_event": event, "p_device": device, "p_ip": ip},
                               "回数の確認")

    def event_cleanup(self, now=None):
        payload = {} if now is None else {"p_now": _iso(now)}
        return self._event_rpc("event_cleanup", payload, "会の片付け")

    # -- LINE -------------------------------------------------------------------------------------------

    def account_by_line_sub(self, sub):
        return self._event_rpc("account_by_line_sub", {"p_sub": sub}, "LINE の結びつき")

    def line_link_save(self, account, line_user_id, is_friend=True):
        self._event_rpc("line_link_save", {"p_account": account, "p_line_user_id": line_user_id,
                                           "p_is_friend": bool(is_friend)}, "LINE の結びつき")

    def line_link_attach(self, account, line_user_id):
        """先に友だち追加した人の userId をアカウントに結ぶ（DB 関数 line_link_attach）。"""
        return bool(self._event_rpc("line_link_attach", {"p_account": account, "p_line_user_id": line_user_id},
                                    "LINE の結びつき"))

    def line_link_unfollow(self, line_user_id):
        self._event_rpc("line_link_unfollow", {"p_line_user_id": line_user_id}, "LINE の友だち解除")

    def line_link_of(self, account_id):
        rows = self._get("line_links", {"select": "*", "account_id": f"eq.{account_id}", "limit": "1"},
                         label="LINE の読み込み")
        return rows[0] if rows else None

    def line_webhook_seen(self, webhook_event_id):
        return bool(self._event_rpc("line_webhook_seen", {"p_id": webhook_event_id}, "LINE の二重除け"))

    def outbound_claim(self, limit=OUTBOUND_BATCH, lease_seconds=OUTBOUND_LEASE_SECONDS):
        return self._event_rpc("outbound_claim", {"p_limit": limit, "p_lease_seconds": lease_seconds},
                               "送る予定の取り出し") or []

    def outbound_done(self, id, ok, error=None):
        self._event_rpc("outbound_done", {"p_id": id, "p_ok": bool(ok), "p_error": error}, "送った記録")

    def delete_auth_user(self, account_id):
        """Supabase の管理 API（service キー）でアカウントを消す。"""
        url = self._root.replace("/rest/v1", "") + f"/auth/v1/admin/users/{account_id}"
        response = self._client.delete(url, headers=dict(self._headers))
        if response.status_code >= 300 and response.status_code != 404:
            print(f"[store] アカウントの削除 failed: HTTP {response.status_code}", flush=True)
            raise _s().StoreError("アカウントの削除")


def _answers_for_rpc(answers):
    """event_apply に渡す回答。ベクトルは pgvector の文字列にする。"""
    out = []
    for item in answers or []:
        row = dict(item)
        for column in ("vec", "vec_c"):
            if row.get(column) is not None and not isinstance(row[column], str):
                row[column] = "[" + ",".join(repr(float(v)) for v in row[column]) + "]"
        out.append(row)
    return out
