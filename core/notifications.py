"""How the notification list reads, and who may be interrupted.

Rows are written one per event (by the database triggers, or by MemoryStore
doing the same in Python). Reading them is where they get grouped: reactions
to the same post that follow each other within REACTION_GROUP_MINUTES become
one line, "A さん ほか2人". supabase/migrations/20261006000000_social_foundation.sql
has the same rule as notification_feed() for the browser; the two must agree.

Settings never delete anything. A category switched off for in_app still
appears in the list; it just does not count towards the badge or pop up.
"""

from datetime import datetime, timedelta

from core.config import (
    NOTIFICATION_CATEGORIES,
    NOTIFICATION_CATEGORY_OF,
    REACTION_GROUP_MINUTES,
)


def category_of(kind):
    return NOTIFICATION_CATEGORY_OF.get(kind, kind)


def parse_time(value):
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def group_feed(rows, limit=50):
    """Group raw notification rows (any order) into list entries, newest first.

    Each entry keeps the newest row's fields, plus `category`, `others` (how
    many other people are in the group), `actors` (newest first, distinct),
    `unread` and `ids` (every row in the group, to mark them read together).
    """
    window = timedelta(minutes=REACTION_GROUP_MINUTES)
    ordered = sorted(rows, key=lambda row: parse_time(row["created_at"]))
    groups = []
    open_chain = {}  # post_id -> (group, last time)
    for row in ordered:
        category = category_of(row["type"])
        stamp = parse_time(row["created_at"])
        if category == "reaction":
            chain = open_chain.get(row.get("post_id"))
            if chain and stamp - chain[1] <= window:
                chain[0].append(row)
                open_chain[row.get("post_id")] = (chain[0], stamp)
                continue
            group = [row]
            open_chain[row.get("post_id")] = (group, stamp)
            groups.append(group)
        else:
            groups.append([row])

    entries = []
    for group in groups:
        newest = group[-1]
        actors = []
        seen = set()
        for row in reversed(group):
            actor_id = row.get("actor_id")
            if actor_id in seen:
                continue
            seen.add(actor_id)
            actors.append(row.get("actor") or {"id": actor_id})
        entry = dict(newest)
        entry.update({
            "category": category_of(newest["type"]),
            "actors": actors,
            "others": max(0, len(actors) - 1),
            "unread": any(not row.get("read_at") for row in group),
            "ids": [row["id"] for row in reversed(group)],
        })
        entries.append(entry)
    entries.sort(key=lambda entry: parse_time(entry["created_at"]), reverse=True)
    return entries[:limit]


def default_settings():
    return {category: {"push": True, "in_app": True} for category in NOTIFICATION_CATEGORIES}


class Settings(dict):
    """{category: {"push", "in_app"}} as JSON shows it, plus `quiet_post`.

    quiet_post: whether "a quiet post nearby" may show in the app. It follows
    the island category's in_app switch, and stays off for somebody who had
    turned the retired similar category's in_app off (their old row is still
    there). It is derived, not stored, and kept off the dict itself so the
    shape of the settings does not change.
    """

    quiet_post = True


def merge_settings(rows):
    """Stored rows over the defaults. A category with no row is fully on."""
    settings = Settings(default_settings())
    similar_off = False
    for row in rows or []:
        if row.get("category") in settings:
            settings[row["category"]] = {"push": bool(row["push"]), "in_app": bool(row["in_app"])}
        elif row.get("category") == "similar" and not row.get("in_app", True):
            similar_off = True
    settings.quiet_post = bool(settings["island"]["in_app"]) and not similar_off
    return settings


def allows(settings, kind, channel):
    """Whether a notification of this type may interrupt on this channel.

    quiet_post: in the app only (never pushed), and only while the island
    category's in_app switch is on and the person had not switched the old
    similar category's in_app off.
    """
    if kind == "quiet_post":
        if channel != "in_app":
            return False
        entry = settings.get("island")
        if entry is None:
            return True
        # A plain dict (not from merge_settings) has no legacy information.
        return bool(getattr(settings, "quiet_post", True)) and bool(entry.get("in_app"))
    entry = settings.get(category_of(kind))
    if entry is None:
        # Old rows (connection / similar) have no switch any more: they stay in the
        # list, but never push and never interrupt in the app (those notifications were retired).
        return False
    return bool(entry.get(channel))


__all__ = ["allows", "category_of", "default_settings", "group_feed", "merge_settings", "parse_time"]
