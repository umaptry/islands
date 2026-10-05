"""Islands that keep who they are while the map re-clusters underneath them.

Clustering is recomputed from scratch, so "island 3" today and "island 3"
yesterday mean nothing on their own. Identity is decided by the posts: a new
island is the same island as an old one when they share at least
ISLAND_MATCH_OVERLAP of the smaller one's posts. One-to-one identities are
handed out greedily, largest overlap first; whatever is left over explains
itself as a merge, a split, a birth or an island that went quiet.

Every change becomes an island_events row with a place, a cause and the counts
before and after, which is what the "while you were away" list is made of.

Pure functions only. The caller (app.py) loads the previous state, the live
islands, the posts and the interaction events, and saves what comes back.
"""

import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from core import growth
from core.config import (
    ISLAND_MATCH_OVERLAP,
    ISLAND_QUIET_DAYS,
    LANDMARK_COUNT_BY_TIER,
    LANDMARK_SWAP_DAYS,
)
from core.notifications import parse_time

CAUSES = {
    "birth": "近い話題の投稿が集まって島ができた",
    "merge": "あいだの投稿が増えて島がつながった",
    "split": "話題が分かれて島が2つになった",
    "rename": "島でよく使われる言葉が変わった",
    "tier_up": "人・投稿・交流が増えた",
    "tier_down": "しばらく交流が少なかった",
    "quiet_gone": "島の投稿がなくなった",
    "quiet_idle": f"{ISLAND_QUIET_DAYS}日間 新しい投稿も交流もない",
    "landmark_new": "島が育って目印が増えた",
    "landmark_swap": "島の話題が変わって目印が入れ替わった",
}


def _place(island):
    return {"cx": island.get("cx"), "cy": island.get("cy")}


def _counts(island):
    return {
        "name": island.get("name"),
        "posts": len(island.get("post_ids") or []),
        "people": len(island.get("author_ids") or []),
        "tier": island.get("tier", 0),
    }


def match(previous, current):
    """Overlap links between old and new islands that clear the threshold.

    Returns (links, identity): links is [(prev_index, cur_index, overlap)] for
    every pair over the threshold, identity maps cur_index -> prev_index for
    the one-to-one assignment.
    """
    links = []
    for i, old in enumerate(previous):
        old_posts = set(old.get("post_ids") or [])
        if not old_posts:
            continue
        for j, new in enumerate(current):
            new_posts = set(new.get("post_ids") or [])
            if not new_posts:
                continue
            overlap = len(old_posts & new_posts)
            if overlap and overlap >= ISLAND_MATCH_OVERLAP * min(len(old_posts), len(new_posts)):
                links.append((i, j, overlap))
    identity = {}
    taken = set()
    for i, j, _ in sorted(links, key=lambda link: (-link[2], link[0], link[1])):
        if i in taken or j in identity:
            continue
        identity[j] = i
        taken.add(i)
    return links, identity


def _landmarks(state, ranked, tier, now):
    """New landmark list and challenger for one island, plus events to record.

    ranked: candidate words, best first, for this island's current terms.
    A missing slot is filled at once. An existing landmark is replaced only
    after the same better candidate has led for LANDMARK_SWAP_DAYS.
    """
    if not ranked:
        return state.get("landmarks") or [], state.get("challenger"), []
    want = LANDMARK_COUNT_BY_TIER[max(0, min(tier, len(LANDMARK_COUNT_BY_TIER) - 1))]
    current = [dict(item) for item in (state.get("landmarks") or [])]
    names = [item["name"] for item in current]
    changes = []
    for word in ranked:
        if len(current) >= want:
            break
        if word not in names:
            current.append({"name": word, "since": now.isoformat()})
            names.append(word)
            changes.append(("landmark_new", None, word))
    current = current[:want] if len(current) > want else current
    names = [item["name"] for item in current]

    challenger = state.get("challenger")
    if not current:
        return current, None, changes
    order = {word: index for index, word in enumerate(ranked)}
    weakest = max(current, key=lambda item: order.get(item["name"], len(ranked)))
    best_outside = next((word for word in ranked if word not in names), None)
    leads = best_outside is not None and order[best_outside] < order.get(weakest["name"], len(ranked))
    if not leads:
        return current, None, changes
    if not challenger or challenger.get("name") != best_outside:
        return current, {"name": best_outside, "since": now.isoformat(), "over": weakest["name"]}, changes
    if now - parse_time(challenger["since"]) >= timedelta(days=LANDMARK_SWAP_DAYS):
        current = [{"name": best_outside, "since": now.isoformat()} if item is weakest else item
                   for item in current]
        changes.append(("landmark_swap", weakest["name"], best_outside))
        return current, None, changes
    return current, challenger, changes


def update(previous, current, posts_by_id, events, now=None, rank_landmarks=None):
    """One tracking step.

    previous: active islands_state rows from the last run.
    current: live islands from energy.name_landmasses (name, label, cx, cy, post_ids).
    posts_by_id: {post_id: {id, author_id, created_at}} for every live post.
    events: interaction events (store.interaction_events rows).
    rank_landmarks: island dict -> candidate words best first, or None to skip.

    Returns {"states": rows to save (including islands now inactive),
             "events": island_events rows to insert}.
    """
    now = now or datetime.now(timezone.utc)
    previous = [row for row in previous if row.get("active", True)]
    links, identity = match(previous, current)
    by_prev = defaultdict(list)
    by_cur = defaultdict(list)
    for i, j, overlap in links:
        by_prev[i].append((j, overlap))
        by_cur[j].append((i, overlap))

    events_by_post = defaultdict(list)
    for event in events:
        events_by_post[event["post_id"]].append(event)

    states, out = [], []

    def record(island_id, kind, cause, place, before, after):
        out.append({
            "id": str(uuid.uuid4()), "island_id": island_id, "kind": kind,
            "cause": CAUSES[cause], "place": place, "before": before, "after": after,
            "created_at": now.isoformat(),
        })

    # Islands absorbed by another one in a merge are closed with it, not as quiet.
    absorbed = {}
    for j, olds in by_cur.items():
        if len(olds) > 1:
            for i, _ in olds:
                if identity.get(j) != i and i not in identity.values():
                    absorbed[i] = j

    new_ids = {}
    for j, island in enumerate(current):
        post_ids = [pid for pid in island.get("post_ids") or [] if pid in posts_by_id]
        posts = [posts_by_id[pid] for pid in post_ids]
        island_events = [e for pid in post_ids for e in events_by_post.get(pid, [])]
        points = growth.score(posts, island_events, now)
        stamps = [parse_time(p["created_at"]) for p in posts] + \
                 [parse_time(e["created_at"]) for e in island_events]
        last_activity = max(stamps) if stamps else None
        authors = sorted({p["author_id"] for p in posts})

        old = previous[identity[j]] if j in identity else None
        island_id = old["id"] if old else str(uuid.uuid4())
        new_ids[j] = island_id
        shown = growth.shown(old.get("score_shown") if old else None, points["total"])
        tier = growth.tier_for(shown, old.get("tier") if old else None)
        state = {
            "id": island_id,
            "name": island.get("name"),
            "label": island.get("label"),
            "tier": tier,
            "score_total": points["total"],
            "score_recent": points["recent"],
            "score_shown": shown,
            "post_ids": post_ids,
            "author_ids": authors,
            "cx": island.get("cx"),
            "cy": island.get("cy"),
            "landmarks": (old or {}).get("landmarks") or [],
            "challenger": (old or {}).get("challenger"),
            "quiet": bool(last_activity is None or now - last_activity > timedelta(days=ISLAND_QUIET_DAYS)),
            "active": True,
            "last_activity_at": last_activity.isoformat() if last_activity else None,
            "created_at": (old or {}).get("created_at") or now.isoformat(),
        }
        place = _place(state)
        after = _counts(state)

        merged_from = [i for i, _ in by_cur.get(j, []) if absorbed.get(i) == j]
        split_from = None
        if old is None:
            parents = [i for i, _ in by_cur.get(j, []) if len(by_prev[i]) > 1]
            split_from = parents[0] if parents else None

        if merged_from:
            before = ([_counts(old)] if old else []) + [_counts(previous[i]) for i in merged_from]
            record(island_id, "merge", "merge", place,
                   {"islands": before}, after)
        if old is not None and len(by_prev[identity[j]]) > 1:
            pieces = [current[k] for k, _ in by_prev[identity[j]]]
            record(island_id, "split", "split", place, _counts(old),
                   {"islands": [{"name": p.get("name"), "posts": len(p.get("post_ids") or [])} for p in pieces]})
        if old is None and split_from is None and not merged_from:
            record(island_id, "birth", "birth", place, {}, after)
        if old is not None and old.get("name") != state["name"]:
            record(island_id, "rename", "rename", place, {"name": old.get("name")}, {"name": state["name"]})
        if old is not None and old.get("tier", 0) != tier:
            cause = "tier_up" if tier > old.get("tier", 0) else "tier_down"
            record(island_id, "tier", cause, place,
                   {"tier": old.get("tier", 0), "tier_name": growth.tier_name(old.get("tier", 0))},
                   {"tier": tier, "tier_name": growth.tier_name(tier)})
        if old is not None and state["quiet"] and not old.get("quiet"):
            record(island_id, "quiet", "quiet_idle", place, _counts(old), after)

        if rank_landmarks is not None:
            ranked = rank_landmarks(island) or []
            landmarks, challenger, changes = _landmarks(state, ranked, tier, now)
            state["landmarks"], state["challenger"] = landmarks, challenger
            # A new island's first landmarks are part of its birth (or split),
            # not a change of their own.
            for cause, was, became in changes if old is not None else ():
                record(island_id, "landmark", cause, place,
                       {"landmark": was} if was else {}, {"landmark": became})
        states.append(state)

    claimed = set(identity.values())
    for i, old in enumerate(previous):
        if i in claimed:
            continue
        closed = dict(old, active=False)
        states.append(closed)
        if i in absorbed:
            continue  # recorded on the surviving island as a merge
        if by_prev.get(i):
            continue  # its posts live on in split pieces, recorded there
        record(old["id"], "quiet", "quiet_gone", _place(old), _counts(old), {"posts": 0, "people": 0})

    return {"states": states, "events": out, "ids": new_ids}


__all__ = ["CAUSES", "match", "update"]
