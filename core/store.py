"""Where accounts, posts, reactions, comments and notifications live.

Two interchangeable backends behind one interface:

  SupabaseStore  - the deployed app. PostgREST with a Supabase secret key (or
                   the legacy service_role key), held only by the server.
                   Counts and notifications are maintained
                   by triggers in supabase/schema.sql, so writing a reaction
                   here is a single insert and nothing else.
  MemoryStore    - local development and tests. Nothing survives a restart, and
                   every trigger in the schema is reimplemented in Python so
                   the two backends behave the same. That duplication is the
                   price of `uvicorn app:app` working with no services running,
                   which is what makes the app testable at all.

Selected automatically: Supabase if SUPABASE_URL and SUPABASE_SERVICE_KEY are
both set, memory otherwise.

WHAT THIS LAYER IS AND IS NOT
-----------------------------
In the deployed app the browser reads and writes most of this itself, straight
to PostgREST, with its own JWT and RLS deciding what it may touch. This module
is what the SERVER uses: creating a post (because x/y/vec come from the frozen
encoder), naming the landmasses, and the local-mode shim that stands in for
PostgREST when there is no Supabase project at all.
"""

import json
import math
import os
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import numpy as np

from core.config import ENERGY_CELL_SIZE
from core.energy import computed_energy, total_energy
from core.post_extras import (
    CLOSED_DEADLINE, CLOSED_FULL, ERROR_CLOSED, ERROR_FULL, EXTRA_COLUMNS, closed_state, shape,
)

ACCOUNTS = "accounts"
# posts reach accounts through the author key and, many-to-many, through
# reactions/comments/notifications/reports, so PostgREST needs the key named.
POST_AUTHOR = "accounts!posts_author_id_fkey"
POSTS = "posts"
REACTIONS = "reactions"
COMMENTS = "comments"
NOTIFICATIONS = "notifications"
REPORTS = "reports"
NOTIFICATION_SETTINGS = "notification_settings"
ISLANDS_STATE = "islands_state"
ISLAND_EVENTS = "island_events"
PUSH_CONFIG = "push_config"
PUSH_SUBSCRIPTIONS = "push_subscriptions"
PUSH_PRESENCE = "push_presence"
REQUEST_TIMEOUT = 10.0

# A dropped connection or a 502 from the PostgREST front end is routine and
# clears on its own. Without a retry every one of them surfaced as a failed post
# in somebody's browser, which is the one thing a live demo cannot afford.
# Only transient classes are retried - a 400 or a 409 is our own bug or a real
# conflict, and repeating it just wastes the visitor's time.
RETRY_ATTEMPTS = 3
RETRY_BACKOFF = 0.4  # seconds, doubled each attempt
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})

REACTION_KINDS = ("like", "help", "join")

# Columns the map needs. Deliberately excludes vec / vec_c: the vectors never
# leave the server, and the browser is not granted them either (see the column
# grants in supabase/schema.sql).
POST_COLUMNS_BASE = (
    "id,author_id,body,tags,motivation,image_path,x,y,cluster_id,terms,"
    "like_count,help_count,join_count,comment_count,energy,created_at,updated_at"
)
# The 2026-10-20 columns (お題 / 申込期限 / 先着人数). A database that has not had
# the migration yet answers 400 (42703) when they are named, so SupabaseStore
# reads and writes without them until it sees them (see supports_post_extras).
POST_COLUMNS = POST_COLUMNS_BASE + "," + ",".join(EXTRA_COLUMNS)
ACCOUNT_COLUMNS = ("id,display_name,affiliation,bio,link_url,icon_id,avatar_path,created_at,"
                   "updated_at,topics,goal,seeking,offering")
# The hidden profile vectors. Written by the server only, never selected for a client.
PROFILE_VECTOR_COLUMNS = ("vec_topics", "vec_goal", "vec_seeking", "vec_offering")
# Naming a landmass needs the words and the position, not the essays.
# author_id and created_at are what island growth and tracking count.
TERM_COLUMNS = ("id,author_id,cluster_id,x,y,terms,motivation,like_count,help_count,"
                "join_count,comment_count,energy,created_at")
NOTIFICATION_COLUMNS = ("id,recipient_id,actor_id,post_id,comment_id,type,created_at,read_at,"
                        "island_id,event_id,payload")
# The columns the 2026-10-12 migration added. A database that has not had it yet
# answers 400 (42703 / PGRST204) when they are named; SupabaseStore then works
# without them (see _has_name_columns), so new code can come up before the SQL.
ISLAND_NAME_COLUMNS = ("name_source", "name_basis", "name_tried_at")
ISLAND_STATE_BASE_COLUMNS = ("id,name,label,tier,score_total,score_recent,score_shown,post_ids,"
                             "author_ids,cx,cy,landmarks,challenger,quiet,active,last_activity_at,"
                             "created_at,updated_at")
ISLAND_STATE_COLUMNS = ISLAND_STATE_BASE_COLUMNS + "," + ",".join(ISLAND_NAME_COLUMNS)
# How long a "columns are there" / "columns are missing" check is trusted.
NAME_COLUMNS_CHECK_SECONDS = 60
POST_EXTRAS_CHECK_SECONDS = 60
ISLAND_EVENT_COLUMNS = "id,island_id,kind,cause,place,before,after,created_at"
PUSH_CONFIG_COLUMNS = "vapid_public,vapid_private,dispatch_url"
PUSH_SUBSCRIPTION_COLUMNS = "id,account_id,endpoint,p256dh,auth,user_agent,created_at"
# mark_active() caps a claim at this many seconds; a stuck tab cannot silence
# pushes for longer.
PRESENCE_MAX_SECONDS = 120
# ids per in.(...) filter: keeps each request line well under proxy limits.
IN_BATCH = 150


def _now():
    return datetime.now(timezone.utc).isoformat()


def _stamp(value):
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def _batches(ids):
    """Distinct ids, sorted, in slices of IN_BATCH."""
    ids = sorted(set(ids))
    return [ids[start:start + IN_BATCH] for start in range(0, len(ids), IN_BATCH)]


def _since(value):
    """An ISO string for a `since` argument given as datetime, string or None."""
    if value is None:
        return "1970-01-01T00:00:00+00:00"
    return value.isoformat() if isinstance(value, datetime) else str(value)


def _parse_vector(value):
    """pgvector's text form "[0.1,0.2]" (or a list) as a list of floats."""
    if value is None:
        return None
    if isinstance(value, str):
        value = json.loads(value)
    return [float(v) for v in value]


def _flatten(row, key=ACCOUNTS, into=None):
    """PostgREST embeds a joined table as a nested object; the client wants it flat.

    Both stores return the same shape because of this: MemoryStore builds the
    flat form directly, and every Supabase read that embeds an account passes
    through here. A caller should never have to ask which backend it is on.
    """
    nested = row.pop(key, None) or {}
    if into is None:
        row["display_name"] = nested.get("display_name", "")
        row["icon_id"] = nested.get("icon_id", "0")
        row["avatar_path"] = nested.get("avatar_path")
    else:
        row[into] = {
            "id": nested.get("id"),
            "display_name": nested.get("display_name", ""),
            "icon_id": nested.get("icon_id", "0"),
            "avatar_path": nested.get("avatar_path"),
        }
    return row


class StoreError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# memory
# ---------------------------------------------------------------------------

class MemoryStore:
    """In-process store for local development and tests.

    Every count and every notification the schema maintains with a trigger is
    maintained here in the write methods. Keeping them in the same methods that
    do the write - rather than in a separate "recompute" pass - is what keeps
    the two backends observably identical from the API's point of view.
    """

    backend = "memory"

    def __init__(self):
        self._accounts = {}
        self._posts = {}
        self._reactions = {}      # (post_id, actor_id, kind) -> created_at
        self._comments = {}
        self._notifications = {}
        self._reports = {}
        self._profile_vectors = {}  # account_id -> {vec_topics: [...], ...}
        self._last_seen = {}        # account_id -> iso time
        self._settings = {}         # (account_id, category) -> row
        self._islands = {}
        self._island_events = {}
        self._island_run_at = None
        self._views = set()         # (post_id, viewer)
        self._push_pending = []     # notification ids not yet taken by the dispatcher
        self._push_config = {"vapid_public": None, "vapid_private": None, "dispatch_url": None}
        self._push_subscriptions = {}  # endpoint -> row
        self._presence = {}         # account_id -> datetime the app is on screen until
        self._lock = threading.RLock()
        # Stands in for the database trigger that pokes /api/push/dispatch.
        # Called with the lock held, so it must only raise a flag and return.
        self.on_notify = None

    # -- accounts ----------------------------------------------------------

    def get_account(self, account_id):
        with self._lock:
            row = self._accounts.get(account_id)
        return dict(row) if row else None

    def list_accounts(self, ids):
        with self._lock:
            return [dict(self._accounts[i]) for i in ids if i in self._accounts]

    def upsert_account(self, account_id, fields):
        with self._lock:
            row = self._accounts.get(account_id) or {
                "id": account_id,
                "display_name": "",
                "affiliation": None,
                "bio": None,
                "link_url": None,
                "icon_id": "0",
                "avatar_path": None,
                "topics": [],
                "goal": None,
                "seeking": None,
                "offering": None,
                "created_at": _now(),
            }
            # The vectors are kept apart, like the column grant that hides them.
            fields = dict(fields)
            vectors = {key: fields.pop(key) for key in PROFILE_VECTOR_COLUMNS if key in fields}
            if vectors:
                self._profile_vectors.setdefault(account_id, {}).update(vectors)
            # No `is not None` filter: null is how the client clears a field.
            # Dropping it here made 自己紹介 and リンク write-once.
            row.update(fields)
            row["updated_at"] = _now()
            self._accounts[account_id] = row
            return dict(row)

    # -- posts -------------------------------------------------------------

    def insert_post(self, record):
        row = dict(record)
        row.setdefault("id", str(uuid.uuid4()))
        row.setdefault("created_at", _now())
        row["updated_at"] = row["created_at"]
        row.setdefault("deleted_at", None)
        for column in ("like_count", "help_count", "join_count", "comment_count"):
            row.setdefault(column, 0)
        row["energy"] = computed_energy(row)
        with self._lock:
            if row["id"] in self._posts:
                return self._public_post(self._posts[row["id"]])
            self._posts[row["id"]] = row
        return self._public_post(row)

    def get_post(self, post_id, with_vec=False):
        with self._lock:
            row = self._posts.get(post_id)
            if not row or row.get("deleted_at"):
                return None
            return self._public_post(row, with_vec=with_vec)

    def update_post(self, post_id, author_id, fields):
        with self._lock:
            row = self._posts.get(post_id)
            if not row or row.get("deleted_at") or row["author_id"] != author_id:
                return None
            row.update(fields)
            row["energy"] = computed_energy(row)
            row["updated_at"] = _now()
            return self._public_post(row)

    def soft_delete_post(self, post_id, author_id):
        with self._lock:
            row = self._posts.get(post_id)
            if not row or row.get("deleted_at") or row["author_id"] != author_id:
                return False
            row["deleted_at"] = _now()
            return True

    def posts_by_author(self, author_id):
        with self._lock:
            rows = [
                row for row in self._posts.values()
                if row["author_id"] == author_id and not row.get("deleted_at")
            ]
        rows.sort(key=lambda row: row["created_at"], reverse=True)
        return [self._joined(row) for row in rows]

    def count_posts(self):
        with self._lock:
            return sum(1 for row in self._posts.values() if not row.get("deleted_at"))

    def _live(self):
        return [row for row in self._posts.values() if not row.get("deleted_at")]

    def map_posts(self, min_x, min_y, max_x, max_y, limit):
        with self._lock:
            rows = [
                row for row in self._live()
                if min_x <= row["x"] <= max_x and min_y <= row["y"] <= max_y
            ]
        rows.sort(key=lambda row: (total_energy(row), row["created_at"]), reverse=True)
        return [self._joined(row) for row in rows[:limit]]

    def map_cells(self, min_x, min_y, max_x, max_y):
        cells = {}
        with self._lock:
            rows = list(self._live())
        for row in rows:
            key = (
                int(math.floor(row["x"] / ENERGY_CELL_SIZE)),
                int(math.floor(row["y"] / ENERGY_CELL_SIZE)),
            )
            cell = cells.setdefault(key, {"cell_x": key[0], "cell_y": key[1],
                                          "sum_energy": 0.0, "post_count": 0})
            cell["sum_energy"] += total_energy(row)
            cell["post_count"] += 1
        low_x, low_y = math.floor(min_x / ENERGY_CELL_SIZE), math.floor(min_y / ENERGY_CELL_SIZE)
        high_x, high_y = math.floor(max_x / ENERGY_CELL_SIZE), math.floor(max_y / ENERGY_CELL_SIZE)
        return [
            cell for (cx, cy), cell in cells.items()
            if low_x <= cx <= high_x and low_y <= cy <= high_y
        ]

    def list_terms(self, limit=5000):
        with self._lock:
            rows = sorted(self._live(), key=lambda row: -total_energy(row))[:limit]
        keys = TERM_COLUMNS.split(",")
        return [{key: (computed_energy(row) if key == "energy" else row.get(key))
                 for key in keys} for row in rows]

    def terrain_posts(self):
        with self._lock:
            return [self._joined(row) for row in self._live()]

    def post_bodies(self, ids):
        """{post_id: body} for live posts among ids (island naming reads this)."""
        with self._lock:
            return {i: self._posts[i]["body"] for i in ids
                    if i in self._posts and not self._posts[i].get("deleted_at")}

    def nearest_posts(self, post_id, k):
        with self._lock:
            origin = self._posts.get(post_id)
            if not origin or origin.get("deleted_at"):
                return []
            mine = origin.get("vec_c")
        if mine is None:
            return []
        return self._nearest(mine, k, skip=post_id)

    def nearest_to_vector(self, vector, k):
        """Neighbours of a text that was never saved (the first-post tryout)."""
        return self._nearest(vector, k)

    def _nearest(self, origin, k, skip=None):
        import numpy as np

        with self._lock:
            rows = [row for row in self._live() if row["id"] != skip]
        mine = np.asarray(origin, dtype=float)
        scored = []
        for row in rows:
            other = row.get("vec_c")
            if other is None:
                continue
            other = np.asarray(other, dtype=float)
            if other.shape != mine.shape:
                continue
            scale = float(np.linalg.norm(mine) * np.linalg.norm(other))
            if scale == 0.0:
                continue
            scored.append((row["id"], float(np.dot(mine, other) / scale)))
        scored.sort(key=lambda pair: -pair[1])
        return scored[:k]

    def pair_similarity(self, a, b):
        for post_id, cosine in self.nearest_posts(a, 10_000):
            if post_id == b:
                return cosine
        return None

    # -- footprints (Q35): a count, never a list ------------------------------

    def record_view(self, post_id, viewer):
        """Count one viewer once. The author never counts. False when skipped."""
        with self._lock:
            row = self._posts.get(post_id)
            if not row or row.get("deleted_at") or row["author_id"] == viewer:
                return False
            self._views.add((post_id, viewer))
            return True

    def view_counts(self, author_id):
        """{post_id: views} for the author's live posts that someone opened."""
        with self._lock:
            mine = {pid for pid, row in self._posts.items()
                    if row["author_id"] == author_id and not row.get("deleted_at")}
            counts = {}
            for post_id, _viewer in self._views:
                if post_id in mine:
                    counts[post_id] = counts.get(post_id, 0) + 1
        return counts

    # -- reactions ---------------------------------------------------------

    def add_reaction(self, post_id, actor_id, kind):
        if kind not in REACTION_KINDS:
            raise StoreError("kind")
        with self._lock:
            post = self._posts.get(post_id)
            if not post or post.get("deleted_at"):
                return False
            key = (post_id, actor_id, kind)
            if key in self._reactions:
                return False
            if kind == "join":
                # Same rule as the database trigger on reactions: a closed 募集 takes no
                # new join (withdrawing one is always possible).
                closed = closed_state(post.get("recruit_deadline"), post.get("recruit_capacity"),
                                      post.get("join_count"))
                if closed == CLOSED_DEADLINE:
                    raise StoreError(ERROR_CLOSED)
                if closed == CLOSED_FULL:
                    raise StoreError(ERROR_FULL)
            self._reactions[key] = _now()
            post[f"{kind}_count"] = post.get(f"{kind}_count", 0) + 1
            post["energy"] = computed_energy(post)
            if post["author_id"] != actor_id:
                self._notify(post["author_id"], actor_id, post_id, None, kind)
                self._notify_new_connection(actor_id, post["author_id"])
        return True

    def remove_reaction(self, post_id, actor_id, kind):
        with self._lock:
            key = (post_id, actor_id, kind)
            if key not in self._reactions:
                return False
            del self._reactions[key]
            post = self._posts.get(post_id)
            if post:
                post[f"{kind}_count"] = max(0, post.get(f"{kind}_count", 0) - 1)
                post["energy"] = computed_energy(post)
            stale = [
                nid for nid, row in self._notifications.items()
                if row["post_id"] == post_id and row["actor_id"] == actor_id
                and row["type"] == kind and row["read_at"] is None
            ]
            for nid in stale:
                del self._notifications[nid]
        return True

    def joiners_of(self, post_id):
        """Account ids that pressed 参加 on a post (local mode only).

        With a database the reactions are public and the browser reads them
        directly; this is the stand-in for 「参加者を見てみる」.
        """
        with self._lock:
            return [actor for (pid, actor, kind) in self._reactions
                    if pid == post_id and kind == "join"]


    def reactions_by_actor(self, actor_id):
        with self._lock:
            return [
                {"post_id": post_id, "kind": kind}
                for (post_id, sender, kind) in self._reactions
                if sender == actor_id
            ]

    # -- comments ----------------------------------------------------------

    def add_comment(self, post_id, author_id, body, reply_to=None):
        with self._lock:
            post = self._posts.get(post_id)
            if not post or post.get("deleted_at"):
                raise StoreError("post")
            parent_author = None
            if reply_to is not None:
                parent = self._comments.get(reply_to)
                if not parent or parent["post_id"] != post_id:
                    raise StoreError("reply_to")
                parent_author = parent["author_id"]
            row = {
                "id": str(uuid.uuid4()),
                "post_id": post_id,
                "author_id": author_id,
                "body": body,
                "reply_to": reply_to,
                "created_at": _now(),
                "deleted_at": None,
            }
            self._comments[row["id"]] = row
            post["comment_count"] = post.get("comment_count", 0) + 1
            post["energy"] = computed_energy(post)
            # Same rules as on_comment_change(): the person answered hears
            # 'reply'; the owner hears 'comment' only if they are somebody else.
            owner = post["author_id"]
            if parent_author is not None and parent_author != author_id:
                self._notify(parent_author, author_id, post_id, row["id"], "reply")
                self._notify_new_connection(author_id, parent_author)
            if owner != author_id and owner != parent_author:
                self._notify(owner, author_id, post_id, row["id"], "comment")
            if owner != author_id:
                self._notify_new_connection(author_id, owner)
            return self._with_author(row)

    def list_comments(self, post_id):
        with self._lock:
            rows = [
                row for row in self._comments.values()
                if row["post_id"] == post_id and not row["deleted_at"]
            ]
        rows.sort(key=lambda row: row["created_at"])
        return [self._with_author(row) for row in rows]

    def delete_comment(self, comment_id, author_id):
        with self._lock:
            row = self._comments.get(comment_id)
            if not row or row["deleted_at"] or row["author_id"] != author_id:
                return False
            row["deleted_at"] = _now()
            post = self._posts.get(row["post_id"])
            if post:
                post["comment_count"] = max(0, post.get("comment_count", 0) - 1)
                post["energy"] = computed_energy(post)
            return True

    def comments_by_author(self, author_id):
        with self._lock:
            return [
                self._with_author(row) for row in self._comments.values()
                if row["author_id"] == author_id and not row["deleted_at"]
            ]

    # -- notifications -----------------------------------------------------

    def _notify(self, recipient_id, actor_id, post_id, comment_id, kind,
                island_id=None, event_id=None, payload=None):
        row = {
            "id": str(uuid.uuid4()),
            "recipient_id": recipient_id,
            "actor_id": actor_id,
            "post_id": post_id,
            "comment_id": comment_id,
            "type": kind,
            "island_id": island_id,
            "event_id": event_id,
            "payload": payload,
            "created_at": _now(),
            "read_at": None,
        }
        self._notifications[row["id"]] = row
        self._push_pending.append(row["id"])
        # quiet_post stays in the app (Q34), as poke_push_dispatch() skips it.
        if kind != "quiet_post" and self.on_notify is not None:
            self.on_notify()
        return row

    def _pair_interaction_count(self, a, b):
        """pair_interaction_count() in Python. Caller holds the lock."""
        count = 0
        for (post_id, actor, _) in self._reactions:
            owner = (self._posts.get(post_id) or {}).get("author_id")
            if (actor == a and owner == b) or (actor == b and owner == a):
                count += 1
        for row in self._comments.values():
            if row["deleted_at"]:
                continue
            owner = (self._posts.get(row["post_id"]) or {}).get("author_id")
            parent = self._comments.get(row.get("reply_to")) if row.get("reply_to") else None
            touched = {owner, parent["author_id"] if parent else None}
            if (row["author_id"] == a and b in touched) or (row["author_id"] == b and a in touched):
                count += 1
        return count

    def _notify_new_connection(self, a, b):
        """Retired 2026-10-12: 「新しいつながり」の通知はもう作らない。

        The database function of the same name is a no-op too (migration
        20261012000000). Rows written before stay as they were.
        """
        return

    def insert_notifications(self, rows):
        """Server-written notifications (similar, island)."""
        with self._lock:
            return [dict(self._notify(
                row["recipient_id"], row.get("actor_id"), row.get("post_id"), None, row["type"],
                row.get("island_id"), row.get("event_id"), row.get("payload"),
            )) for row in rows]

    def recent_notifications(self, kind, since, recipient_id=None):
        """Rows of one type since a time, for the per-day limits."""
        start = _stamp(_since(since))
        with self._lock:
            return [
                dict(row) for row in self._notifications.values()
                if row["type"] == kind and _stamp(row["created_at"]) >= start
                and (recipient_id is None or row["recipient_id"] == recipient_id)
            ]

    def list_notifications(self, recipient_id, limit=100):
        with self._lock:
            rows = [
                dict(row) for row in self._notifications.values()
                if row["recipient_id"] == recipient_id
            ]
        rows.sort(key=lambda row: row["created_at"], reverse=True)
        rows = rows[:limit]
        with self._lock:
            for row in rows:
                actor = self._accounts.get(row["actor_id"]) or {}
                row["actor"] = None if row["actor_id"] is None else {
                    "id": row["actor_id"],
                    "display_name": actor.get("display_name", ""),
                    "icon_id": actor.get("icon_id", "0"),
                    "avatar_path": actor.get("avatar_path"),
                }
                comment = self._comments.get(row["comment_id"]) if row["comment_id"] else None
                row["comment_body"] = comment["body"] if comment else None
        return rows

    def mark_notifications_read(self, recipient_id, ids=None):
        stamp = _now()
        changed = 0
        with self._lock:
            for row in self._notifications.values():
                if row["recipient_id"] != recipient_id or row["read_at"]:
                    continue
                if ids is not None and row["id"] not in ids:
                    continue
                row["read_at"] = stamp
                changed += 1
        return changed

    def unread_count(self, recipient_id):
        with self._lock:
            return sum(
                1 for row in self._notifications.values()
                if row["recipient_id"] == recipient_id and not row["read_at"]
            )

    # -- notification settings ---------------------------------------------

    def get_notification_settings(self, account_id):
        with self._lock:
            return [dict(row) for (owner, _), row in self._settings.items() if owner == account_id]

    def put_notification_settings(self, account_id, rows):
        with self._lock:
            for row in rows:
                self._settings[(account_id, row["category"])] = {
                    "account_id": account_id, "category": row["category"],
                    "push": bool(row["push"]), "in_app": bool(row["in_app"]),
                    "updated_at": _now(),
                }
        return self.get_notification_settings(account_id)

    def notification_settings_for(self, account_ids):
        """{account_id: [setting rows]} for everybody about to be told something."""
        wanted = set(account_ids)
        out = {}
        with self._lock:
            for (owner, _), row in self._settings.items():
                if owner in wanted:
                    out.setdefault(owner, []).append(dict(row))
        return out

    # -- web push (段6) ------------------------------------------------------

    def get_push_config(self):
        with self._lock:
            return dict(self._push_config)

    def save_push_keys(self, public, private):
        """Store a VAPID pair unless one is already there; return what is stored.

        Two servers making a pair at once both get the one that landed first.
        """
        with self._lock:
            if not self._push_config["vapid_private"]:
                self._push_config.update({"vapid_public": public, "vapid_private": private})
            return dict(self._push_config)

    def claim_pending_pushes(self):
        """Take every notification the dispatcher has not seen yet, oldest first."""
        with self._lock:
            rows = [dict(self._notifications[i]) for i in self._push_pending
                    if i in self._notifications]
            self._push_pending.clear()
        rows.sort(key=lambda row: row["created_at"])
        return rows

    def push_subscriptions(self, account_ids):
        wanted = set(account_ids)
        with self._lock:
            return [dict(row) for row in self._push_subscriptions.values()
                    if row["account_id"] in wanted]

    def save_push_subscription(self, account_id, endpoint, p256dh, auth, user_agent=None):
        """One row per endpoint: a browser that signs in as somebody else moves over."""
        with self._lock:
            row = self._push_subscriptions.get(endpoint) or {
                "id": str(uuid.uuid4()), "endpoint": endpoint, "created_at": _now(),
            }
            row.update({"account_id": account_id, "p256dh": p256dh, "auth": auth,
                        "user_agent": user_agent})
            self._push_subscriptions[endpoint] = row
            return dict(row)

    def delete_push_subscription(self, endpoint, account_id=None):
        with self._lock:
            row = self._push_subscriptions.get(endpoint)
            if row is None or (account_id is not None and row["account_id"] != account_id):
                return False
            del self._push_subscriptions[endpoint]
            return True

    def mark_active(self, account_id, seconds):
        """mark_active() for the local shim: on screen for `seconds`, 0 clears it."""
        with self._lock:
            if seconds <= 0:
                self._presence.pop(account_id, None)
            else:
                self._presence[account_id] = (datetime.now(timezone.utc)
                                              + timedelta(seconds=min(seconds, PRESENCE_MAX_SECONDS)))

    def active_accounts(self, account_ids):
        """Those of `account_ids` who have the app on screen right now."""
        now = datetime.now(timezone.utc)
        with self._lock:
            return {account for account in account_ids
                    if account in self._presence and self._presence[account] > now}

    def recent_visitors(self, account_ids, since):
        """Those of `account_ids` who opened the app at or after `since`."""
        start = _stamp(_since(since))
        with self._lock:
            return {account for account in account_ids
                    if account in self._last_seen and _stamp(self._last_seen[account]) >= start}

    # -- people layer --------------------------------------------------------

    def profile_vectors(self):
        """Every account's four fields and hidden vectors (server only)."""
        with self._lock:
            out = []
            for account_id, row in self._accounts.items():
                vectors = self._profile_vectors.get(account_id, {})
                out.append({
                    "id": account_id, "topics": list(row.get("topics") or []),
                    "goal": row.get("goal"), "seeking": row.get("seeking"),
                    "offering": row.get("offering"),
                    **{key: vectors.get(key) for key in PROFILE_VECTOR_COLUMNS},
                })
            return out

    def post_centroids(self):
        """{author_id: {"centroid": [...], "post_count": n}} from live vec_c."""
        groups = {}
        with self._lock:
            for row in self._live():
                if row.get("vec_c") is None:
                    continue
                groups.setdefault(row["author_id"], []).append(np.asarray(row["vec_c"], dtype=float))
        return {
            author: {"centroid": [float(v) for v in np.mean(vectors, axis=0)],
                     "post_count": len(vectors)}
            for author, vectors in groups.items()
        }

    def interaction_events(self, since=None):
        """interaction_events() in Python: reactions, comments and replies."""
        start = _stamp(_since(since))
        out = []
        with self._lock:
            for (post_id, actor, kind), created_at in self._reactions.items():
                post = self._posts.get(post_id)
                if not post or post.get("deleted_at") or actor == post["author_id"]:
                    continue
                if _stamp(created_at) < start:
                    continue
                out.append({"actor_id": actor, "post_author_id": post["author_id"],
                            "post_id": post_id, "kind": kind, "reply_author_id": None,
                            "created_at": created_at})
            for row in self._comments.values():
                post = self._posts.get(row["post_id"])
                if row["deleted_at"] or not post or post.get("deleted_at"):
                    continue
                if _stamp(row["created_at"]) < start:
                    continue
                parent = self._comments.get(row.get("reply_to")) if row.get("reply_to") else None
                parent_author = parent["author_id"] if parent else None
                if row["author_id"] == post["author_id"] and parent_author in (None, row["author_id"]):
                    continue
                out.append({"actor_id": row["author_id"], "post_author_id": post["author_id"],
                            "post_id": row["post_id"],
                            "kind": "reply" if row.get("reply_to") else "comment",
                            "reply_author_id": parent_author, "created_at": row["created_at"]})
        out.sort(key=lambda event: event["created_at"])
        return out

    def touch_last_seen(self, account_id):
        """Record this visit; return the previous one (None on a first visit)."""
        with self._lock:
            previous = self._last_seen.get(account_id)
            self._last_seen[account_id] = _now()
            return previous

    # -- islands -------------------------------------------------------------

    def island_states(self, active_only=True):
        with self._lock:
            return [dict(row) for row in self._islands.values()
                    if row.get("active", True) or not active_only]

    supports_island_names = True
    supports_post_extras = True

    def island_names_ready(self):
        return True

    def post_extras_ready(self):
        return True

    def save_island_states(self, rows):
        stamp = _now()
        with self._lock:
            for row in rows:
                saved = dict(self._islands.get(row["id"]) or {"created_at": stamp})
                saved.update(row)
                saved["updated_at"] = stamp
                self._islands[row["id"]] = saved
        return len(rows)

    def add_island_events(self, rows):
        with self._lock:
            for row in rows:
                saved = dict(row)
                saved.setdefault("id", str(uuid.uuid4()))
                saved.setdefault("created_at", _now())
                self._island_events[saved["id"]] = saved
        return len(rows)

    def list_island_events(self, since=None, limit=50, island_ids=None):
        start = _stamp(_since(since))
        with self._lock:
            rows = [dict(row) for row in self._island_events.values()
                    if _stamp(row["created_at"]) >= start
                    and (island_ids is None or row["island_id"] in island_ids)]
        rows.sort(key=lambda row: row["created_at"], reverse=True)
        return rows[:limit]

    def claim_island_run(self, min_seconds):
        """True for one caller per min_seconds, like claim_island_run()."""
        now = datetime.now(timezone.utc)
        with self._lock:
            if self._island_run_at and now - self._island_run_at < timedelta(seconds=min_seconds):
                return False
            self._island_run_at = now
            return True

    # -- reports -----------------------------------------------------------

    def add_report(self, reporter_id, post_id, comment_id, reason):
        row = {
            "id": str(uuid.uuid4()), "reporter_id": reporter_id, "post_id": post_id,
            "comment_id": comment_id, "reason": reason, "created_at": _now(),
        }
        with self._lock:
            self._reports[row["id"]] = row
        return dict(row)

    # -- shaping -----------------------------------------------------------

    def _public_post(self, row, with_vec=False):
        keys = POST_COLUMNS.split(",")
        out = {key: row.get(key) for key in keys}
        out["energy"] = computed_energy(row)
        out = shape(out)
        if with_vec:
            out["vec"] = row.get("vec")
            out["vec_c"] = row.get("vec_c")
        return out

    def _joined(self, row):
        out = self._public_post(row)
        account = self._accounts.get(row["author_id"]) or {}
        out.update({
            "display_name": account.get("display_name", ""),
            "icon_id": account.get("icon_id", "0"),
            "avatar_path": account.get("avatar_path"),
        })
        return out

    def _with_author(self, row):
        out = {key: row.get(key) for key in ("id", "post_id", "author_id", "body", "reply_to", "created_at")}
        account = self._accounts.get(row["author_id"]) or {}
        out["author"] = {
            "id": row["author_id"],
            "display_name": account.get("display_name", ""),
            "icon_id": account.get("icon_id", "0"),
            "avatar_path": account.get("avatar_path"),
        }
        return out


# ---------------------------------------------------------------------------
# supabase
# ---------------------------------------------------------------------------

class SupabaseStore:
    """PostgREST client. Server-side only, with an elevated API key."""

    backend = "supabase"

    def __init__(self, url, service_key):
        self._root = f"{url.rstrip('/')}/rest/v1"
        self._headers = {
            "apikey": service_key,
            "Content-Type": "application/json",
        }
        # Legacy service_role keys are JWTs and must also be the bearer token.
        # The current sb_secret_* keys are opaque API keys: Supabase's gateway
        # maps them to service_role from the apikey header, while sending one as
        # a bearer token makes PostgREST reject it as a non-JWT.
        if not service_key.startswith("sb_secret_"):
            self._headers["Authorization"] = f"Bearer {service_key}"
        self._client = httpx.Client(timeout=REQUEST_TIMEOUT)
        self._has_name_columns = True      # until the database says otherwise
        self._names_checked_at = None
        self._has_post_extras = False      # until the database shows the 2026-10-20 columns
        self._extras_checked_at = None

    def _send(self, method, path, *, label, headers=None, params=None, json=None,
              allow_statuses=()):
        """One request, retried while the failure still looks transient.

        Every call into PostgREST goes through here so the retry policy is
        stated once. The StoreError message deliberately does NOT carry the
        response body: it is rendered straight into the browser, and Supabase
        error text is both meaningless to a visitor and a place where internals
        leak. The body goes to the server log instead.
        """
        merged = dict(self._headers)
        if headers:
            merged.update(headers)
        url = f"{self._root}/{path}"

        delay = RETRY_BACKOFF
        last = ""
        for attempt in range(1, RETRY_ATTEMPTS + 1):
            try:
                response = self._client.request(
                    method, url, headers=merged, params=params, json=json
                )
            except httpx.HTTPError as error:  # timeout, DNS, connection reset
                last = f"{type(error).__name__}: {error}"
            else:
                if response.status_code < 300 or response.status_code in allow_statuses:
                    return response
                last = f"HTTP {response.status_code}: {response.text[:200]}"
                if response.status_code not in RETRY_STATUSES:
                    break

            if attempt < RETRY_ATTEMPTS:
                print(f"[store] {label} attempt {attempt} failed ({last}); retrying", flush=True)
                time.sleep(delay)
                delay *= 2

        print(f"[store] {label} gave up after {RETRY_ATTEMPTS} attempts: {last}", flush=True)
        raise StoreError(label)

    def _get(self, path, params, label="読み込み"):
        return self._send("GET", path, label=label, params=params).json()

    def _rpc(self, name, payload, label="読み込み"):
        return self._send("POST", f"rpc/{name}", label=label, json=payload).json()

    # -- accounts ----------------------------------------------------------

    def get_embedding(self, key):
        rows = self._get("embedding_cache", {"cache_key": f"eq.{key}", "select": "embedding"})
        return rows[0]["embedding"] if rows else None

    def runtime_status(self):
        rows = self._get("map_runtime", {"select": "maintenance,active_version", "singleton": "eq.true"})
        if len(rows) != 1:
            raise StoreError("Map runtime configuration is missing")
        return rows[0]

    def put_embedding(self, key, value):
        self._send("POST", "embedding_cache", label="埋め込みの保存",
                   headers={"Prefer": "resolution=ignore-duplicates"},
                   json={"cache_key": key, "embedding": value})
        return self.get_embedding(key)

    def get_account(self, account_id):
        rows = self._get(ACCOUNTS, {
            "select": ACCOUNT_COLUMNS, "id": f"eq.{account_id}", "limit": "1",
        })
        return rows[0] if rows else None

    def list_accounts(self, ids):
        if not ids:
            return []
        joined = ",".join(ids)
        return self._get(ACCOUNTS, {"select": ACCOUNT_COLUMNS, "id": f"in.({joined})"})

    def upsert_account(self, account_id, fields):
        # fields arrives already filtered by the AccountPatch model, and a null
        # in it is deliberate: merge-duplicates writes exactly the columns sent,
        # so a column that is dropped here can never be emptied again.
        record = dict(fields)
        record["id"] = account_id
        for key in PROFILE_VECTOR_COLUMNS:
            if record.get(key) is not None:
                record[key] = "[" + ",".join(repr(float(v)) for v in record[key]) + "]"
        response = self._send(
            "POST", ACCOUNTS, label="プロフィールの保存",
            headers={"Prefer": "return=representation,resolution=merge-duplicates"},
            # select keeps the hidden vectors out of the answer.
            params={"on_conflict": "id", "select": ACCOUNT_COLUMNS},
            json=record,
        )
        body = response.json()
        return body[0] if body else self.get_account(account_id)

    # -- posts -------------------------------------------------------------

    # -- the 2026-10-20 columns (prompt / recruit_deadline / recruit_capacity) ---

    def _post_columns(self):
        return POST_COLUMNS if self.supports_post_extras else POST_COLUMNS_BASE

    @staticmethod
    def _missing_post_extras(response):
        """True when a 400 says posts has no prompt / recruit_* column (yet)."""
        if response.status_code != 400:
            return False
        text = response.text or ""
        try:
            code = str((response.json() or {}).get("code", ""))
        except Exception:
            code = ""
        return code in ("42703", "PGRST204") and any(name in text for name in EXTRA_COLUMNS)

    def post_extras_ready(self):
        """True when posts has the 2026-10-20 columns (cached for a minute).

        Raises StoreError when the database cannot be asked."""
        now = time.monotonic()
        if self._extras_checked_at is not None and now - self._extras_checked_at < POST_EXTRAS_CHECK_SECONDS:
            return self._has_post_extras
        try:
            response = self._send("GET", POSTS, label="投稿の列の確認", allow_statuses=(400,),
                                  params={"select": ",".join(EXTRA_COLUMNS), "limit": "1"})
        except StoreError:
            self._extras_checked_at = now - POST_EXTRAS_CHECK_SECONDS + 10
            raise
        if response.status_code < 300:
            ready = True
        elif self._missing_post_extras(response):
            ready = False
        else:
            # Remember the failure for ~10s (keeping the last answer) so an outage
            # does not make every request retry this check three times.
            self._extras_checked_at = now - POST_EXTRAS_CHECK_SECONDS + 10
            raise StoreError("投稿の列の確認")
        if ready != self._has_post_extras or self._extras_checked_at is None:
            print("[store] posts " + ("has" if ready else "has no")
                  + " prompt / recruit_* columns; post extras are " + ("on" if ready else "off until "
                  "supabase/migrations/20261020000000_post_prompts_and_recruit.sql is run"), flush=True)
        self._has_post_extras = ready
        self._extras_checked_at = now
        return ready

    @property
    def supports_post_extras(self):
        """Whether to read and write the extras. A database that cannot be asked
        right now keeps the last answer (off before the first one)."""
        try:
            return self.post_extras_ready()
        except StoreError:
            return self._has_post_extras

    def _without_extras(self, data):
        if self.supports_post_extras:
            return data
        return {key: value for key, value in data.items() if key not in EXTRA_COLUMNS}

    def insert_post(self, record):
        response = self._send(
            "POST", POSTS, label="保存",
            headers={"Prefer": "return=representation,resolution=ignore-duplicates"},
            params={"select": self._post_columns()},
            json=self._without_extras(record),
        )
        rows = response.json()
        if rows:
            return shape(rows[0])
        existing = self.get_post(record["id"])
        if not existing:
            raise StoreError("投稿を保存できませんでした。")
        return existing

    def get_post(self, post_id, with_vec=False):
        select = self._post_columns() + (",vec,vec_c" if with_vec else "")
        rows = self._get(POSTS, {
            "select": select, "id": f"eq.{post_id}", "deleted_at": "is.null", "limit": "1",
        })
        return shape(rows[0]) if rows else None

    def update_post(self, post_id, author_id, fields):
        fields = self._without_extras(fields)
        if not fields:
            return None
        response = self._send(
            "PATCH", POSTS, label="更新",
            headers={"Prefer": "return=representation"},
            params={
                "id": f"eq.{post_id}", "author_id": f"eq.{author_id}",
                "deleted_at": "is.null", "select": self._post_columns(),
            },
            json=fields,
        )
        rows = response.json()
        return shape(rows[0]) if rows else None

    def soft_delete_post(self, post_id, author_id):
        return bool(self.update_post(post_id, author_id, {"deleted_at": _now()}))

    def posts_by_author(self, author_id):
        rows = self._get(POSTS, {
            "select": self._post_columns() + f",{POST_AUTHOR}(id,display_name,icon_id,avatar_path)",
            "author_id": f"eq.{author_id}",
            "deleted_at": "is.null",
            "order": "created_at.desc",
        })
        return [shape(_flatten(row)) for row in rows]

    def count_posts(self):
        response = self._send(
            "GET", POSTS, label="件数の取得",
            headers={"Prefer": "count=exact", "Range": "0-0"},
            params={"select": "id", "deleted_at": "is.null"},
        )
        # Content-Range looks like "0-0/42"
        return int(response.headers.get("content-range", "*/0").split("/")[-1])

    def map_posts(self, min_x, min_y, max_x, max_y, limit):
        rows = self._rpc("map_posts", {
            "min_x": min_x, "min_y": min_y, "max_x": max_x, "max_y": max_y,
            "limit_n": limit,
        }, label="地図の読み込み")
        # Before the 2026-10-20 SQL the answer has no extras; shape() fills them in.
        return [shape(row) for row in rows]

    def map_cells(self, min_x, min_y, max_x, max_y):
        return self._rpc("map_cells", {
            "min_x": min_x, "min_y": min_y, "max_x": max_x, "max_y": max_y,
        }, label="地図の読み込み")

    def list_terms(self, limit=5000):
        return self._get(POSTS, {
            "select": TERM_COLUMNS,
            "deleted_at": "is.null",
            "order": "energy.desc",
            "limit": str(limit),
        }, label="領域名の読み込み")

    def post_bodies(self, ids):
        """{post_id: body} for live posts among ids (island naming reads this)."""
        ids = list(ids)
        out = {}
        for start in range(0, len(ids), 40):
            chunk = ",".join(ids[start:start + 40])
            for row in self._get(POSTS, {"select": "id,body", "deleted_at": "is.null",
                                         "id": f"in.({chunk})"}, label="島の名前用の投稿"):
                out[row["id"]] = row["body"]
        return out

    def terrain_posts(self):
        rows = []
        last = None
        while True:
            params = {"select": f"id,x,y,energy,body,tags,{POST_AUTHOR}(display_name)",
                      "deleted_at": "is.null", "order": "id", "limit": "1000"}
            if last:
                params["id"] = f"gt.{last}"
            batch = self._get(POSTS, params, label="地形の読み込み")
            rows.extend(_flatten(row) for row in batch)
            if len(batch) < 1000:
                return rows
            last = batch[-1]["id"]

    def nearest_posts(self, post_id, k):
        rows = self._rpc("nearest_posts", {"from_post": post_id, "k": k},
                         label="近い人の検索")
        return [(row["id"], float(row["cosine"])) for row in rows]

    def pair_similarity(self, a, b):
        value = self._rpc("pair_similarity", {"a": a, "b": b}, label="似てる度の計算")
        return float(value) if isinstance(value, (int, float)) else None

    def nearest_to_vector(self, vector, k):
        text = "[" + ",".join(f"{float(value):.6f}" for value in vector) + "]"
        rows = self._rpc("nearest_to_vector", {"origin": text, "k": k}, label="近い人の検索")
        return [(row["id"], float(row["cosine"])) for row in rows]

    # -- footprints (Q35) -----------------------------------------------------

    def record_view(self, post_id, viewer):
        rows = self._get(POSTS, {"select": "author_id", "id": f"eq.{post_id}",
                                 "deleted_at": "is.null", "limit": "1"}, label="投稿の確認")
        if not rows or rows[0]["author_id"] == viewer:
            return False
        self._send("POST", "post_views", label="見られた数の記録",
                   headers={"Prefer": "return=minimal,resolution=ignore-duplicates"},
                   params={"on_conflict": "post_id,viewer"},
                   json={"post_id": post_id, "viewer": viewer})
        return True

    def view_counts(self, author_id):
        rows = self._rpc("post_view_counts", {"author": author_id}, label="見られた数の読み込み")
        return {row["post_id"]: int(row["views"]) for row in rows}

    # -- reactions / comments / notifications ------------------------------
    #
    # In the deployed app the browser does all of these itself against
    # PostgREST, so these methods exist for the local shim and for tests. The
    # counts and the notification rows come from the triggers either way, which
    # is why none of them is touched here.

    def add_reaction(self, post_id, actor_id, kind):
        response = self._send(
            "POST", REACTIONS, label="リアクションの保存",
            params={"on_conflict": "post_id,actor_id,kind"},
            headers={"Prefer": "return=representation,resolution=ignore-duplicates"},
            json={"post_id": post_id, "actor_id": actor_id, "kind": kind},
            # Belt and braces: a duplicate must read as "already reacted" rather
            # than an error even if a deployment loses the on_conflict hint.
            allow_statuses=(409,),
        )
        if response.status_code == 409:
            return False
        return bool(response.json() if response.content else [])

    def remove_reaction(self, post_id, actor_id, kind):
        response = self._send(
            "DELETE", REACTIONS, label="リアクションの取り消し",
            headers={"Prefer": "return=representation"},
            params={
                "post_id": f"eq.{post_id}", "actor_id": f"eq.{actor_id}",
                "kind": f"eq.{kind}",
            },
        )
        return bool(response.json())

    def reactions_by_actor(self, actor_id):
        return self._get(REACTIONS, {
            "select": "post_id,kind", "actor_id": f"eq.{actor_id}",
        })

    def add_comment(self, post_id, author_id, body, reply_to=None):
        record = {"post_id": post_id, "author_id": author_id, "body": body}
        if reply_to is not None:
            # The trigger refuses a parent on another post (23514 -> 400); the
            # lookup here only turns that into the same error MemoryStore raises.
            parent = self._get(COMMENTS, {"select": "id", "id": f"eq.{reply_to}",
                                          "post_id": f"eq.{post_id}", "limit": "1"})
            if not parent:
                raise StoreError("reply_to")
            record["reply_to"] = reply_to
        response = self._send(
            "POST", COMMENTS, label="メッセージの送信",
            headers={"Prefer": "return=representation"},
            params={"select": f"id,post_id,author_id,body,reply_to,created_at,"
                              f"{ACCOUNTS}(id,display_name,icon_id,avatar_path)"},
            json=record,
        )
        return _flatten(response.json()[0], into="author")

    def list_comments(self, post_id):
        rows = self._get(COMMENTS, {
            "select": f"id,post_id,author_id,body,reply_to,created_at,"
                      f"{ACCOUNTS}(id,display_name,icon_id,avatar_path)",
            "post_id": f"eq.{post_id}",
            "deleted_at": "is.null",
            "order": "created_at.asc",
        })
        return [_flatten(row, into="author") for row in rows]

    def delete_comment(self, comment_id, author_id):
        response = self._send(
            "PATCH", COMMENTS, label="メッセージの削除",
            headers={"Prefer": "return=representation"},
            params={"id": f"eq.{comment_id}", "author_id": f"eq.{author_id}",
                    "deleted_at": "is.null"},
            json={"deleted_at": _now()},
        )
        return bool(response.json())

    def list_notifications(self, recipient_id, limit=100):
        rows = self._get(NOTIFICATIONS, {
            "select": f"{NOTIFICATION_COLUMNS},"
                      f"{ACCOUNTS}!notifications_actor_id_fkey(id,display_name,icon_id,avatar_path)",
            "recipient_id": f"eq.{recipient_id}",
            "order": "created_at.desc",
            "limit": str(limit),
        })
        rows = [_flatten(row, into="actor") for row in rows]
        for row in rows:
            if row.get("actor_id") is None:
                row["actor"] = None  # island notifications have nobody behind them
        return rows

    def insert_notifications(self, rows):
        if not rows:
            return []
        keys = ("recipient_id", "actor_id", "post_id", "type", "island_id", "event_id", "payload")
        response = self._send(
            "POST", NOTIFICATIONS, label="通知の保存",
            headers={"Prefer": "return=representation"},
            params={"select": NOTIFICATION_COLUMNS},
            json=[{key: row.get(key) for key in keys} for row in rows],
        )
        return response.json()

    def recent_notifications(self, kind, since, recipient_id=None):
        params = {"select": NOTIFICATION_COLUMNS, "type": f"eq.{kind}",
                  "created_at": f"gte.{_since(since)}", "order": "created_at.desc",
                  "limit": "1000"}
        if recipient_id is not None:
            params["recipient_id"] = f"eq.{recipient_id}"
        return self._get(NOTIFICATIONS, params, label="通知の読み込み")

    # -- notification settings ---------------------------------------------

    def get_notification_settings(self, account_id):
        return self._get(NOTIFICATION_SETTINGS, {
            "select": "account_id,category,push,in_app,updated_at",
            "account_id": f"eq.{account_id}",
        }, label="通知設定の読み込み")

    def put_notification_settings(self, account_id, rows):
        if rows:
            self._send(
                "POST", NOTIFICATION_SETTINGS, label="通知設定の保存",
                headers={"Prefer": "return=minimal,resolution=merge-duplicates"},
                params={"on_conflict": "account_id,category"},
                json=[{"account_id": account_id, "category": row["category"],
                       "push": bool(row["push"]), "in_app": bool(row["in_app"]),
                       "updated_at": _now()} for row in rows],
            )
        return self.get_notification_settings(account_id)

    def notification_settings_for(self, account_ids):
        out = {}
        for ids in _batches(account_ids):
            for row in self._get(NOTIFICATION_SETTINGS, {
                "select": "account_id,category,push,in_app,updated_at",
                "account_id": f"in.({','.join(ids)})",
            }, label="通知設定の読み込み"):
                out.setdefault(row["account_id"], []).append(row)
        return out

    # -- web push (段6) ------------------------------------------------------
    #
    # push_config and push_presence are closed to everybody but this key. The
    # database pokes /api/push/dispatch after each insert into notifications;
    # the dispatcher then claims the rows itself, so a forged poke sends
    # nothing that was not already due.

    def get_push_config(self):
        rows = self._get(PUSH_CONFIG, {"select": PUSH_CONFIG_COLUMNS, "singleton": "eq.true"},
                         label="通知の鍵の読み込み")
        if not rows:
            return {key: None for key in PUSH_CONFIG_COLUMNS.split(",")}
        return rows[0]

    def save_push_keys(self, public, private):
        # Only fills an empty slot: the first pair written is the one everybody keeps.
        response = self._send(
            "PATCH", PUSH_CONFIG, label="通知の鍵の保存",
            headers={"Prefer": "return=representation"},
            params={"singleton": "eq.true", "vapid_private": "is.null",
                    "select": PUSH_CONFIG_COLUMNS},
            json={"vapid_public": public, "vapid_private": private, "updated_at": _now()},
        )
        rows = response.json()
        return rows[0] if rows else self.get_push_config()

    def claim_pending_pushes(self):
        # One UPDATE ... WHERE pushed_at IS NULL: two dispatchers never take the same row.
        response = self._send(
            "PATCH", NOTIFICATIONS, label="送る通知の取り出し",
            headers={"Prefer": "return=representation"},
            params={"pushed_at": "is.null", "select": NOTIFICATION_COLUMNS},
            json={"pushed_at": _now()},
        )
        rows = response.json()
        rows.sort(key=lambda row: _stamp(row["created_at"]))
        return rows

    def push_subscriptions(self, account_ids):
        rows = []
        for ids in _batches(account_ids):
            rows.extend(self._get(PUSH_SUBSCRIPTIONS, {
                "select": PUSH_SUBSCRIPTION_COLUMNS, "account_id": f"in.({','.join(ids)})",
            }, label="通知の送り先の読み込み"))
        return rows

    def save_push_subscription(self, account_id, endpoint, p256dh, auth, user_agent=None):
        response = self._send(
            "POST", PUSH_SUBSCRIPTIONS, label="通知の送り先の保存",
            headers={"Prefer": "return=representation,resolution=merge-duplicates"},
            params={"on_conflict": "endpoint", "select": PUSH_SUBSCRIPTION_COLUMNS},
            json={"account_id": account_id, "endpoint": endpoint, "p256dh": p256dh,
                  "auth": auth, "user_agent": user_agent},
        )
        return response.json()[0]

    def delete_push_subscription(self, endpoint, account_id=None):
        params = {"endpoint": f"eq.{endpoint}"}
        if account_id is not None:
            params["account_id"] = f"eq.{account_id}"
        response = self._send(
            "DELETE", PUSH_SUBSCRIPTIONS, label="通知の送り先の削除",
            headers={"Prefer": "return=representation"}, params=params,
        )
        return bool(response.json())

    def mark_active(self, account_id, seconds):
        # The browser calls the mark_active() RPC itself; this is for the server.
        if seconds <= 0:
            self._send("DELETE", PUSH_PRESENCE, label="表示中の記録",
                       headers={"Prefer": "return=minimal"},
                       params={"account_id": f"eq.{account_id}"})
            return
        until = datetime.now(timezone.utc) + timedelta(seconds=min(seconds, PRESENCE_MAX_SECONDS))
        self._send("POST", PUSH_PRESENCE, label="表示中の記録",
                   headers={"Prefer": "return=minimal,resolution=merge-duplicates"},
                   params={"on_conflict": "account_id"},
                   json={"account_id": account_id, "active_until": until.isoformat()})

    def active_accounts(self, account_ids):
        found = set()
        for ids in _batches(account_ids):
            found.update(row["account_id"] for row in self._get(PUSH_PRESENCE, {
                "select": "account_id", "account_id": f"in.({','.join(ids)})",
                "active_until": f"gt.{_now()}",
            }, label="表示中の確認"))
        return found

    def recent_visitors(self, account_ids, since):
        found = set()
        for ids in _batches(account_ids):
            found.update(row["id"] for row in self._get(ACCOUNTS, {
                "select": "id", "id": f"in.({','.join(ids)})",
                "last_seen_at": f"gte.{_since(since)}",
            }, label="訪問の確認"))
        return found

    # -- people layer --------------------------------------------------------

    def profile_vectors(self):
        rows = self._rpc("profile_vectors", {}, label="プロフィールの読み込み")
        for row in rows:
            row["topics"] = list(row.get("topics") or [])
            for key in PROFILE_VECTOR_COLUMNS:
                row[key] = _parse_vector(row.get(key))
        return rows

    def post_centroids(self):
        rows = self._rpc("account_post_centroids", {}, label="投稿の平均の読み込み")
        return {
            row["author_id"]: {"centroid": _parse_vector(row["centroid"]),
                               "post_count": int(row["post_count"])}
            for row in rows if row.get("centroid") is not None
        }

    def interaction_events(self, since=None):
        rows = self._rpc("interaction_events", {"since": _since(since)}, label="交流の読み込み")
        rows.sort(key=lambda event: _stamp(event["created_at"]))
        return rows

    def touch_last_seen(self, account_id):
        # touch_last_seen() reads auth.uid(), which is empty for the server's
        # key, so the server does the same two steps directly.
        rows = self._get(ACCOUNTS, {"select": "last_seen_at", "id": f"eq.{account_id}",
                                    "limit": "1"}, label="前回の訪問の読み込み")
        self._send("PATCH", ACCOUNTS, label="訪問の記録",
                   headers={"Prefer": "return=minimal"},
                   params={"id": f"eq.{account_id}"}, json={"last_seen_at": _now()})
        return rows[0].get("last_seen_at") if rows else None

    # -- islands -------------------------------------------------------------

    @property
    def supports_island_names(self):
        """False once the database turned out not to have the name columns."""
        return self._has_name_columns

    @staticmethod
    def _missing_name_columns(response):
        """True when a 400 says the islands_state name columns do not exist (yet)."""
        if response.status_code != 400:
            return False
        text = response.text or ""
        try:
            code = str((response.json() or {}).get("code", ""))
        except Exception:
            code = ""
        # Both: a CHECK violation (23514), a bad filter (PGRST100) or another column's
        # 42703 must not be taken for "the migration has not been run".
        return code in ("42703", "PGRST204") and any(name in text for name in ISLAND_NAME_COLUMNS)

    def _island_columns(self):
        return ISLAND_STATE_COLUMNS if self._has_name_columns else ISLAND_STATE_BASE_COLUMNS

    def island_states(self, active_only=True):
        # An instance that decided "no columns" tries the full read again once the
        # check interval has passed (the SQL may have been run since), without a restart.
        if (not self._has_name_columns and self._names_checked_at is not None
                and time.monotonic() - self._names_checked_at >= NAME_COLUMNS_CHECK_SECONDS):
            self._has_name_columns = True
            self._names_checked_at = time.monotonic()
        for _ in range(2):
            params = {"select": self._island_columns(), "order": "created_at.asc"}
            if active_only:
                params["active"] = "is.true"
            response = self._send("GET", ISLANDS_STATE, label="島の読み込み", params=params,
                                  allow_statuses=(400,))
            if response.status_code < 300:
                return response.json()
            if self._has_name_columns and self._missing_name_columns(response):
                self._remember_missing_name_columns()
                continue
            print(f"[store] 島の読み込み failed: HTTP {response.status_code}: {response.text[:200]}", flush=True)
            raise StoreError("島の読み込み")
        raise StoreError("島の読み込み")

    def _remember_missing_name_columns(self):
        if self._has_name_columns:
            print("[store] islands_state has no name_source column yet; AI island names are off "
                  "until supabase/migrations/20261012000000_ai_island_names_no_connection.sql is run",
                  flush=True)
        self._has_name_columns = False
        self._names_checked_at = time.monotonic()

    def island_names_ready(self):
        """True when islands_state can be read with the name columns (cached briefly).

        Used by /api/health: a database the 2026-10-12 migration has not reached
        must not be promoted. Raises StoreError when the database cannot be asked.
        """
        now = time.monotonic()
        if self._names_checked_at is not None and now - self._names_checked_at < NAME_COLUMNS_CHECK_SECONDS:
            return self._has_name_columns
        response = self._send("GET", ISLANDS_STATE, label="島の列の確認", allow_statuses=(400,),
                              params={"select": ",".join(ISLAND_NAME_COLUMNS), "limit": "1"})
        if response.status_code < 300:
            self._has_name_columns = True
            self._names_checked_at = now
        elif self._missing_name_columns(response):
            self._remember_missing_name_columns()
        else:
            raise StoreError("島の列の確認")
        return self._has_name_columns

    def save_island_states(self, rows):
        if not rows:
            return 0
        for _ in range(2):
            keys = self._island_columns().split(",")
            stamp = _now()
            response = self._send(
                "POST", ISLANDS_STATE, label="島の保存", allow_statuses=(400,),
                headers={"Prefer": "return=minimal,resolution=merge-duplicates"},
                params={"on_conflict": "id"},
                json=[{**{key: row.get(key) for key in keys if key in row and key != "created_at"},
                       "updated_at": stamp} for row in rows],
            )
            if response.status_code < 300:
                return len(rows)
            if self._has_name_columns and self._missing_name_columns(response):
                self._remember_missing_name_columns()
                continue
            print(f"[store] 島の保存 failed: HTTP {response.status_code}: {response.text[:200]}", flush=True)
            raise StoreError("島の保存")
        raise StoreError("島の保存")

    def add_island_events(self, rows):
        if rows:
            keys = ISLAND_EVENT_COLUMNS.split(",")
            self._send("POST", ISLAND_EVENTS, label="島の変化の保存",
                       headers={"Prefer": "return=minimal"},
                       json=[{key: row[key] for key in keys if key in row} for row in rows])
        return len(rows)

    def list_island_events(self, since=None, limit=50, island_ids=None):
        params = {"select": ISLAND_EVENT_COLUMNS, "created_at": f"gte.{_since(since)}",
                  "order": "created_at.desc", "limit": str(limit)}
        if island_ids is not None:
            if not island_ids:
                return []
            params["island_id"] = f"in.({','.join(island_ids)})"
        return self._get(ISLAND_EVENTS, params, label="島の変化の読み込み")

    def claim_island_run(self, min_seconds):
        return bool(self._rpc("claim_island_run", {"min_seconds": int(min_seconds)},
                              label="島の処理の確認"))

    def mark_notifications_read(self, recipient_id, ids=None):
        params = {"recipient_id": f"eq.{recipient_id}", "read_at": "is.null"}
        if ids is not None:
            params["id"] = f"in.({','.join(ids)})"
        response = self._send(
            "PATCH", NOTIFICATIONS, label="既読の保存",
            headers={"Prefer": "return=representation"},
            params=params, json={"read_at": _now()},
        )
        return len(response.json())

    def unread_count(self, recipient_id):
        response = self._send(
            "GET", NOTIFICATIONS, label="未読件数の取得",
            headers={"Prefer": "count=exact", "Range": "0-0"},
            params={"select": "id", "recipient_id": f"eq.{recipient_id}",
                    "read_at": "is.null"},
        )
        return int(response.headers.get("content-range", "*/0").split("/")[-1])

    def add_report(self, reporter_id, post_id, comment_id, reason):
        response = self._send(
            "POST", REPORTS, label="通報の送信",
            headers={"Prefer": "return=representation"},
            json={"reporter_id": reporter_id, "post_id": post_id,
                  "comment_id": comment_id, "reason": reason},
        )
        return response.json()[0]


def create_store():
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if url and key:
        return SupabaseStore(url, key)
    return MemoryStore()
