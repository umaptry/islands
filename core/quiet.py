"""Q34: a post nobody has answered yet, shown quietly to a few people nearby.

A post that has sat for QUIET_POST_MIN_HOURS with no like, help, join or
comment is put in front of up to QUIET_POST_PER_POST people whose own posts
stand on the same island or on the QUIET_POST_NEAR_ISLANDS nearest ones,
nearest first. Only people who opened the app in the last
QUIET_POST_VISIT_DAYS days are picked, and nobody is told more than
QUIET_POST_PER_DAY a day.

The row stays inside the app (config.NEVER_PUSHED) and the wording never says
that nobody answered: to the reader it is a recommendation, to the author it
is nothing at all. Each post is shown this way once.

Two steps, so the store is asked about visits once per run: candidates()
lists the nearest people for every quiet post, choose() applies the visits
and the daily cap.
"""

from collections import Counter
from datetime import timedelta
from math import hypot

from core.config import (
    QUIET_POST_CANDIDATES,
    QUIET_POST_MAX_DAYS,
    QUIET_POST_MIN_HOURS,
    QUIET_POST_NEAR_ISLANDS,
    QUIET_POST_PER_DAY,
    QUIET_POST_PER_POST,
)
from core.notifications import parse_time

REACTION_COLUMNS = ("like_count", "help_count", "join_count", "comment_count")
MESSAGE = "近くの島に、話が合いそうな投稿があります。"


def is_quiet(post, now):
    """No reaction of any kind, and old enough to tell but not too old."""
    if any(int(post.get(column) or 0) for column in REACTION_COLUMNS):
        return False
    if not post.get("created_at"):
        return False
    age = now - parse_time(post["created_at"])
    return timedelta(hours=QUIET_POST_MIN_HOURS) <= age <= timedelta(days=QUIET_POST_MAX_DAYS)


def _centre(island):
    if island.get("cx") is None or island.get("cy") is None:
        return None
    return float(island["cx"]), float(island["cy"])


def near_islands(spot, home, islands):
    """Indexes of the post's own island and the nearest others, by centre.

    A post on no island takes the QUIET_POST_NEAR_ISLANDS + 1 nearest to it.
    """
    origin = (_centre(islands[home]) if home is not None else None) or spot
    others = [index for index, island in enumerate(islands)
              if index != home and _centre(island) is not None]
    others.sort(key=lambda index: (hypot(_centre(islands[index])[0] - origin[0],
                                         _centre(islands[index])[1] - origin[1]), index))
    if home is None:
        return others[:QUIET_POST_NEAR_ISLANDS + 1]
    return [home] + others[:QUIET_POST_NEAR_ISLANDS]


def candidates(posts, islands, now, already=()):
    """Quiet posts, oldest first, each with its nearest people.

    posts: list_terms() rows; islands: live islands (post_ids, cx, cy);
    already: post ids that have had a quiet_post row. Returns
    [{"post_id", "author_id", "people": [account id, nearest first]}].
    """
    placed = {post["id"]: post for post in posts
              if post.get("x") is not None and post.get("y") is not None}
    island_of = {}
    for index, island in enumerate(islands):
        for post_id in island.get("post_ids") or []:
            island_of[post_id] = index
    already = set(already)
    found = []
    for post in placed.values():
        author = post.get("author_id")
        if not author or post["id"] in already or not is_quiet(post, now):
            continue
        spot = (float(post["x"]), float(post["y"]))
        distance = {}
        for index in near_islands(spot, island_of.get(post["id"]), islands):
            for post_id in islands[index].get("post_ids") or []:
                other = placed.get(post_id)
                person = (other or {}).get("author_id")
                if not person or person == author:
                    continue
                gap = hypot(float(other["x"]) - spot[0], float(other["y"]) - spot[1])
                if gap < distance.get(person, float("inf")):
                    distance[person] = gap
        people = sorted(distance, key=lambda person: (distance[person], person))
        if people:
            found.append({"post_id": post["id"], "author_id": author,
                          "created_at": post["created_at"],
                          "people": people[:QUIET_POST_CANDIDATES]})
    found.sort(key=lambda item: (parse_time(item["created_at"]), item["post_id"]))
    return found


def choose(found, visitors, told_recently):
    """notification rows for candidates(): visitors only, capped per day.

    visitors: people who came by recently; told_recently: recipient ids of
    the quiet_post rows of the last day (one entry per row).
    """
    visitors = set(visitors)
    sent = Counter(told_recently)
    rows = []
    for item in found:
        picked = 0
        for person in item["people"]:
            if picked >= QUIET_POST_PER_POST:
                break
            if person not in visitors or sent[person] >= QUIET_POST_PER_DAY:
                continue
            sent[person] += 1
            picked += 1
            # The author is the actor so the row shows their face, as every
            # post does; nothing in it says how the post has been received.
            rows.append({"recipient_id": person, "actor_id": item["author_id"],
                         "post_id": item["post_id"], "type": "quiet_post",
                         "payload": {"message": MESSAGE}})
    return rows
