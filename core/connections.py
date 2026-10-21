"""Lines between people: one per pair, no direction, from interactions.

Only an act of reaching out draws a line - a join, a comment on somebody's
post, a reply to somebody's comment. A like or a "help" is too light: counting
it would cover the map in lines. Two people who interact many times, or
one person with ten posts, still get exactly one line: the unit is the pair of
people, never the post.

Strength decays with a half-life so that the map shows who is talking NOW
without forgetting who once did. A line whose last interaction is older than
CONNECTION_FAINT_DAYS is still drawn, thin and faint; it disappears only when
the interactions behind it are undone (a reaction taken back, a comment deleted).

Input is the flat event list from store.interaction_events(); see the SQL
function of the same name for the exact columns.
"""

import math
from datetime import datetime, timedelta, timezone

from core.config import (
    CONNECTION_FAINT_DAYS,
    CONNECTION_HALF_LIFE_DAYS,
    CONNECTION_ONGOING_DAYS,
    CONNECTION_ONGOING_WINDOW_DAYS,
    CONNECTION_POINTS,
    CONNECTION_TIER_BOUNDS,
    CONNECTION_WEEK_DAYS,
)
from core.notifications import parse_time


def pair_key(a, b):
    return (a, b) if a < b else (b, a)


def expand(event):
    """(person, person, points, post_id, post_owner) for each pair one event touches."""
    actor = event["actor_id"]
    owner = event["post_author_id"]
    kind = event["kind"]
    out = []
    if kind == "reply" and event.get("reply_author_id"):
        parent = event["reply_author_id"]
        if parent != actor:
            out.append((actor, parent, CONNECTION_POINTS["reply"], event["post_id"], owner))
        if owner not in (actor, parent):
            out.append((actor, owner, CONNECTION_POINTS["comment"], event["post_id"], owner))
        return out
    if owner == actor:
        return out
    points = CONNECTION_POINTS.get(kind if kind != "reply" else "comment", 0)
    if points:
        out.append((actor, owner, points, event["post_id"], owner))
    return out


def tier_of(strength):
    tier = 1
    for bound in CONNECTION_TIER_BOUNDS:
        if strength >= bound:
            tier += 1
    return tier


def nearest_post(origin, candidates, positions):
    """The candidate post standing closest to `origin` on the map (ties: lowest id)."""
    best = None
    for post_id in candidates:
        spot = positions.get(post_id)
        if spot is None:
            continue
        key = (math.hypot(spot[0] - origin[0], spot[1] - origin[1]), post_id)
        if best is None or key < best[0]:
            best = (key, post_id)
    return best[1] if best else None


def closest_pair(mine, theirs, positions):
    """The (post of `mine`, post of `theirs`) pair standing closest to each other."""
    best = None
    for left in mine:
        spot = positions.get(left)
        if spot is None:
            continue
        right = nearest_post(spot, theirs, positions)
        if right is None:
            continue
        other = positions[right]
        key = (math.hypot(spot[0] - other[0], spot[1] - other[1]), left, right)
        if best is None or key < best:
            best = key
    return (best[1], best[2]) if best else (None, None)


def build(events, now=None, fallback_posts=None, positions=None, posts_by_author=None):
    """Connections, strongest first.

    A line joins the post the last interaction landed on to the other person's
    post standing closest to it on the map. positions maps post id -> (x, y)
    and posts_by_author maps person -> their live post ids; without them (or
    when the other person has no post with a place) the end falls back to
    fallback_posts, person -> their most energetic live post id.
    """
    now = now or datetime.now(timezone.utc)
    fallback_posts = fallback_posts or {}
    positions = positions or {}
    posts_by_author = posts_by_author or {}
    half_life = CONNECTION_HALF_LIFE_DAYS
    pairs = {}
    for event in events:
        stamp = parse_time(event["created_at"])
        age_days = max(0.0, (now - stamp).total_seconds() / 86400.0)
        for a, b, points, post_id, owner in expand(event):
            key = pair_key(a, b)
            pair = pairs.get(key)
            if pair is None:
                pair = pairs[key] = {
                    "points": 0, "strength": 0.0, "count": 0, "last": stamp,
                    "days": set(), "week": 0, "latest": None,
                }
            pair["points"] += points
            pair["strength"] += points * math.pow(0.5, age_days / half_life)
            pair["count"] += 1
            pair["last"] = max(pair["last"], stamp)
            pair["days"].add(stamp.date())
            if age_days <= CONNECTION_WEEK_DAYS:
                pair["week"] += 1
            if pair["latest"] is None or (stamp, post_id) >= pair["latest"][:2]:
                pair["latest"] = (stamp, post_id, owner)

    window_start = (now - timedelta(days=CONNECTION_ONGOING_WINDOW_DAYS)).date()
    out = []
    for (a, b), pair in pairs.items():
        _, post_id, owner = pair["latest"]
        ends = {}
        spot = positions.get(post_id)
        if owner in (a, b) and (spot is not None or not positions):
            other = b if owner == a else a
            ends[owner] = post_id
            if spot is not None:
                ends[other] = nearest_post(spot, posts_by_author.get(other, ()), positions)
        else:
            # The touched post has no place on the map: let both ends fall back.
            ends[a], ends[b] = closest_pair(posts_by_author.get(a, ()), posts_by_author.get(b, ()), positions)

        def end(person):
            return ends.get(person) or fallback_posts.get(person)
        recent_days = sum(1 for day in pair["days"] if day >= window_start)
        idle_days = (now - pair["last"]).total_seconds() / 86400.0
        out.append({
            "a": a, "b": b,
            "a_post": end(a), "b_post": end(b),
            "points": pair["points"],
            "strength": round(pair["strength"], 3),
            "tier": tier_of(pair["strength"]),
            "count": pair["count"],
            "week": pair["week"],
            "last_at": pair["last"].isoformat(),
            "faint": idle_days > CONNECTION_FAINT_DAYS,
            "ongoing": recent_days >= CONNECTION_ONGOING_DAYS,
        })
    out.sort(key=lambda row: (-row["strength"], row["a"], row["b"]))
    return out


def partners(connections, person):
    """Everybody `person` has a line with."""
    return {row["b"] if row["a"] == person else row["a"]
            for row in connections if person in (row["a"], row["b"])}


__all__ = ["build", "expand", "pair_key", "partners", "tier_of"]
