"""Why two people might want to meet, in words, and a first line to say.

Stage 4 of the islands redesign (2026-10-07): a suggested person always comes
with a reason (Q15, e.g. 「同じ島にいます」), the people most like you are
listed first (Q52), and a first line is offered to start the conversation
(Q44). The first line is a template filled from the reason, not generated:
the same reason always gives the same words, and nothing is sent to a model.

Pure functions only. app.py gathers the two profiles, the island each person
stands on and the per-direction scores, and passes them in.
"""

from core.config import INTRO_PART_THRESHOLD, INTRO_REASON_COUNT

# Order of preference when several reasons hold. A shared island is the one
# a person can see for themselves on the map, so it leads (Q15's example).
ORDER = ("island", "topics", "seeking", "offering", "goal", "posts")


def _topic_list(words, limit=2):
    return "".join(f"「{word}」" for word in words[:limit])


def reasons(viewer, other, parts, *, seeking=None, offering=None, shared_islands=(), shared_topics=()):
    """Up to INTRO_REASON_COUNT reasons, best first. Never empty when anything is known.

    viewer, other: profile dicts (topics, goal, seeking, offering).
    parts: affinity()["parts"] - topics / goal / posts scores 0..1 or None.
    seeking: how well `other` offers what `viewer` is looking for (0..1 or None).
    offering: how well `viewer` offers what `other` is looking for.
    shared_islands: island labels both people have posts on.
    shared_topics: topic words both listed.

    Each reason is {"kind", "text"}. When no part clears the threshold, the
    best part there is is still given, worded as weaker, so a suggestion is
    never shown without one (Q15).
    """
    # A direction only counts when the side it rests on said something.
    if not other.get("offering"):
        seeking = None
    if not other.get("seeking"):
        offering = None
    found = {}
    if shared_islands:
        found["island"] = f"同じ{shared_islands[0]}にいます"
    if shared_topics:
        found["topics"] = f"共通の話題{_topic_list(list(shared_topics))}"
    if seeking is not None and seeking >= INTRO_PART_THRESHOLD:
        found["seeking"] = "あなたの探していることを手伝えそうです"
    if offering is not None and offering >= INTRO_PART_THRESHOLD:
        found["offering"] = "あなたが手伝えることを探しています"
    goal = parts.get("goal")
    if goal is not None and goal >= INTRO_PART_THRESHOLD:
        found["goal"] = "目標が近いです"
    posts = parts.get("posts")
    if posts is not None and posts >= INTRO_PART_THRESHOLD:
        found["posts"] = "投稿の話題が近いです"

    out = [{"kind": kind, "text": found[kind]} for kind in ORDER if kind in found]
    if not out:
        weak = _weak_reason(parts, seeking, offering)
        if weak:
            out.append(weak)
    return out[:INTRO_REASON_COUNT]


def _weak_reason(parts, seeking, offering):
    """The best part below the threshold, worded as only somewhat close."""
    scores = {
        "topics": parts.get("topics"),
        "goal": parts.get("goal"),
        "posts": parts.get("posts"),
        "seeking": seeking,
        "offering": offering,
    }
    scores = {kind: value for kind, value in scores.items() if value is not None}
    if not scores:
        return None
    kind = max(scores, key=lambda key: (scores[key], -ORDER.index(key)))
    text = {
        "topics": "話題が少し近いです",
        "goal": "目標が少し近いです",
        "posts": "投稿の話題が少し近いです",
        "seeking": "探していることに少し近いです",
        "offering": "手伝えることに少し近いです",
    }[kind]
    return {"kind": kind, "text": text}


def opener(reason_list, other, shared_topics=()):
    """A first comment the viewer can send as is or rewrite (Q44).

    Written to the other person, so it says what brought the viewer over and
    ends with a question they can answer in one line.
    """
    kind = reason_list[0]["kind"] if reason_list else None
    if kind == "topics" and shared_topics:
        return f"私も「{shared_topics[0]}」が好きです。最近はどんなことをしていますか？"
    if kind == "island":
        return "同じ島にいたので声をかけました。どんなことをしているか聞いてもいいですか？"
    if kind == "seeking":
        return "私の探していることに詳しそうだったので、少し教えてもらえませんか？"
    if kind == "offering":
        return "探していることについて、私で良ければ手伝えるかもしれません。"
    if kind == "goal":
        return "目標が近そうだったので声をかけました。いまはどんなことに取り組んでいますか？"
    return "投稿を読んで声をかけました。よろしくお願いします。"


def contributors(island_post_ids, events, before=None, exclude=(), limit=2):
    """The people whose interactions on an island's posts led up to a change.

    Counted from interaction events (likes, comments, replies) on the island's
    posts up to `before` (an aware datetime, or None for all), most first,
    latest as the tie-break. Returns [person id] at most `limit` long.
    """
    from core.notifications import parse_time

    posts = set(island_post_ids or [])
    counts, last = {}, {}
    for event in events:
        if event.get("post_id") not in posts:
            continue
        stamp = parse_time(event["created_at"])
        if before is not None and stamp > before:
            continue
        actor = event.get("actor_id")
        if not actor or actor in exclude:
            continue
        counts[actor] = counts.get(actor, 0) + 1
        last[actor] = max(last.get(actor, stamp), stamp)
    ranked = sorted(counts, key=lambda person: (-counts[person], -last[person].timestamp(), person))
    return ranked[:limit]


__all__ = ["ORDER", "contributors", "opener", "reasons"]
