"""Post extras added 2026-10-20: the prompt a post answers, and for a post tagged
「参加者募集中」 a sign-up deadline and a first-come capacity.

Pure helpers shared by app.py and both stores. The deadline is a Japan-time date
and sign-up stays open until the end of that day; the database trigger
(supabase/migrations/20261020000000_post_prompts_and_recruit.sql) applies the
same rule to the browser's direct writes to `reactions`.
"""

import re
from datetime import date, datetime, timedelta, timezone

from core.config import (
    POST_PROMPT_KEYS,
    PROMPT_UTC_OFFSET_HOURS,
    RECRUIT_CAPACITY_MAX,
    RECRUIT_CAPACITY_MIN,
    RECRUIT_DEADLINE_MAX_DAYS,
)

JST = timezone(timedelta(hours=PROMPT_UTC_OFFSET_HOURS))

# Columns a database without the 2026-10-20 migration does not have.
EXTRA_COLUMNS = ("prompt", "recruit_deadline", "recruit_capacity")

CLOSED_DEADLINE = "deadline"
CLOSED_FULL = "full"
# The words a refused join carries (store errors, API detail, database message).
ERROR_CLOSED = "recruit_closed"
ERROR_FULL = "recruit_full"

_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def today_jst(now=None):
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now.astimezone(JST).date()


def parse_date(value):
    """A "YYYY-MM-DD" string (or date) as a date, or None when it is not one."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if not isinstance(value, str) or not _DATE.match(value.strip()):
        return None
    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        return None


def closed_state(deadline, capacity, joins, now=None):
    """None while sign-up is open, "deadline" once the deadline day is over, "full"
    when the joins reached the capacity. The deadline wins when both hold."""
    last_day = parse_date(deadline)
    if last_day is not None and today_jst(now) > last_day:
        return CLOSED_DEADLINE
    if capacity is not None and int(joins or 0) >= int(capacity):
        return CLOSED_FULL
    return None


def shape(row, now=None):
    """The row with the extras always present (None when the database has none)
    and `recruit_closed` worked out. A row the database already answered with its
    own `recruit_closed` (map_posts) keeps the same value, recomputed here."""
    if row is None:
        return None
    out = dict(row)
    for column in EXTRA_COLUMNS:
        out.setdefault(column, None)
    if out["recruit_deadline"] is not None:
        out["recruit_deadline"] = str(out["recruit_deadline"])[:10]
    # A post put on several communities counts its places over all of them (2026-10-29).
    joins = out.get("group_join_count")
    if joins is None:
        joins = out.get("join_count")
    out["recruit_closed"] = closed_state(
        out["recruit_deadline"], out["recruit_capacity"], joins, now)
    return out


def clean_prompt(value):
    """The prompt key, or None for none. Raises ValueError for anything else."""
    if value is None or value == "":
        return None
    if value not in POST_PROMPT_KEYS:
        raise ValueError("お題の指定が正しくありません。")
    return value


def clean_capacity(value):
    """A whole number from 1 to 999, or None. Raises ValueError otherwise."""
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError("先着人数は整数で入力してください。")
    try:
        number = int(value)
    except ValueError:
        raise ValueError("先着人数は整数で入力してください。")
    if not RECRUIT_CAPACITY_MIN <= number <= RECRUIT_CAPACITY_MAX:
        raise ValueError(f"先着人数は{RECRUIT_CAPACITY_MIN}〜{RECRUIT_CAPACITY_MAX}人で入力してください。")
    return number


def clean_deadline(value, now=None, keep=None):
    """"YYYY-MM-DD" from today to a year ahead (Japan time), or None for none.

    `keep` is the deadline the post already has: saving it again unchanged is
    always fine, even if it has passed since. Raises ValueError otherwise."""
    if value is None or value == "":
        return None
    day = parse_date(value)
    if day is None:
        raise ValueError("申込期限は「2026-12-31」の形で入力してください。")
    if keep is not None and day == parse_date(keep):
        return day.isoformat()
    today = today_jst(now)
    if day < today:
        raise ValueError("申込期限が過ぎています。今日以降の日付にしてください。")
    if day > today + timedelta(days=RECRUIT_DEADLINE_MAX_DAYS):
        raise ValueError("申込期限は今日から1年以内にしてください。")
    return day.isoformat()
