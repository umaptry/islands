"""How big an island has grown: points from people, posts and interactions.

  score = people x GROWTH_WEIGHTS["people"]
        + sum over people of sqrt(their posts) x GROWTH_WEIGHTS["posts"]
        + deduplicated interactions x GROWTH_WEIGHTS["interactions"]

The square root is what keeps one person posting fifty times from building a
city alone: their fiftieth post adds far less than somebody else's first.
Interactions count once per (actor, post, day) and at most GROWTH_DAILY_CAP
times per actor per island per day.

Two numbers are kept: the lifetime total and the last GROWTH_RECENT_DAYS. The
score people see (score_shown) never drops more than GROWTH_MAX_SHRINK in one
update, and the tier only steps down once the score falls clearly below the
boundary (GROWTH_TIER_HYSTERESIS), so a quiet week does not flatten a town.
"""

import math
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from core.config import (
    GROWTH_DAILY_CAP,
    GROWTH_MAX_SHRINK,
    GROWTH_RECENT_DAYS,
    GROWTH_TIER_BOUNDS,
    GROWTH_TIER_HYSTERESIS,
    GROWTH_TIERS,
    GROWTH_WEIGHTS,
)
from core.notifications import parse_time


def _points(posts, events):
    authors = defaultdict(int)
    for post in posts:
        authors[post["author_id"]] += 1
    post_ids = {post["id"] for post in posts}

    seen = set()
    per_actor_day = defaultdict(int)
    interactions = 0
    for event in sorted(events, key=lambda e: parse_time(e["created_at"])):
        if event["post_id"] not in post_ids:
            continue
        day = parse_time(event["created_at"]).date()
        key = (event["actor_id"], event["post_id"], day)
        if key in seen:
            continue
        seen.add(key)
        if per_actor_day[(event["actor_id"], day)] >= GROWTH_DAILY_CAP:
            continue
        per_actor_day[(event["actor_id"], day)] += 1
        interactions += 1

    parts = {
        "people": len(authors),
        "posts": round(sum(math.sqrt(count) for count in authors.values()), 4),
        "interactions": interactions,
    }
    score = sum(GROWTH_WEIGHTS[key] * value for key, value in parts.items())
    return round(score, 3), parts


def score(posts, events, now=None):
    """Lifetime and recent points for one island.

    posts: [{id, author_id, created_at}] on the island now.
    events: interaction events (store.interaction_events rows); those on other
    islands' posts are ignored.
    """
    now = now or datetime.now(timezone.utc)
    total, parts = _points(posts, events)
    start = now - timedelta(days=GROWTH_RECENT_DAYS)
    recent_posts = [p for p in posts if parse_time(p["created_at"]) >= start]
    recent_events = [e for e in events if parse_time(e["created_at"]) >= start]
    recent, recent_parts = _points(recent_posts, recent_events)
    return {"total": total, "recent": recent, "parts": parts, "recent_parts": recent_parts}


def shown(previous, current):
    """The score on screen: follows growth at once, shrinks at most GROWTH_MAX_SHRINK."""
    if previous is None:
        return current
    return round(max(current, previous * (1.0 - GROWTH_MAX_SHRINK)), 3)


def tier_for(points, previous=None):
    """Index into GROWTH_TIERS. Steps up at a bound, steps down only well below it."""
    raw = 0
    for index, bound in enumerate(GROWTH_TIER_BOUNDS):
        if points >= bound:
            raw = index
    if previous is None or raw >= previous:
        return raw
    tier = previous
    while tier > raw and points < GROWTH_TIER_BOUNDS[tier] * (1.0 - GROWTH_TIER_HYSTERESIS):
        tier -= 1
    return tier


def tier_name(tier):
    return GROWTH_TIERS[max(0, min(tier, len(GROWTH_TIERS) - 1))]


__all__ = ["score", "shown", "tier_for", "tier_name"]
