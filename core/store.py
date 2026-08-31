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

import math
import os
import threading
import time
import uuid
from datetime import datetime, timezone

import httpx

from core.config import ENERGY_CELL_SIZE
from core.energy import computed_energy, total_energy

ACCOUNTS = "accounts"
POSTS = "posts"
REACTIONS = "reactions"
COMMENTS = "comments"
NOTIFICATIONS = "notifications"
REPORTS = "reports"
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
POST_COLUMNS = (
    "id,author_id,body,tags,motivation,image_path,x,y,cluster_id,terms,"
    "like_count,help_count,join_count,comment_count,energy,created_at,updated_at"
)
ACCOUNT_COLUMNS = "id,display_name,affiliation,bio,link_url,icon_id,avatar_path,created_at"
# Naming a landmass needs the words and the position, not the essays.
TERM_COLUMNS = "id,cluster_id,x,y,terms,motivation,like_count,help_count,join_count,comment_count,energy"


def _now():
    return datetime.now(timezone.utc).isoformat()


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
        self._lock = threading.RLock()

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
                "created_at": _now(),
            }
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

    def nearest_posts(self, post_id, k):
        import numpy as np

        with self._lock:
            origin = self._posts.get(post_id)
            if not origin or origin.get("deleted_at"):
                return []
            rows = [row for row in self._live() if row["id"] != post_id]
            mine = origin.get("vec_c")
        if mine is None:
            return []
        mine = np.asarray(mine, dtype=float)
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
            self._reactions[key] = _now()
            post[f"{kind}_count"] = post.get(f"{kind}_count", 0) + 1
            post["energy"] = computed_energy(post)
            if post["author_id"] != actor_id:
                self._notify(post["author_id"], actor_id, post_id, None, kind)
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

    def reactions_by_actor(self, actor_id):
        with self._lock:
            return [
                {"post_id": post_id, "kind": kind}
                for (post_id, sender, kind) in self._reactions
                if sender == actor_id
            ]

    # -- comments ----------------------------------------------------------

    def add_comment(self, post_id, author_id, body):
        with self._lock:
            post = self._posts.get(post_id)
            if not post or post.get("deleted_at"):
                raise StoreError("post")
            row = {
                "id": str(uuid.uuid4()),
                "post_id": post_id,
                "author_id": author_id,
                "body": body,
                "created_at": _now(),
                "deleted_at": None,
            }
            self._comments[row["id"]] = row
            post["comment_count"] = post.get("comment_count", 0) + 1
            post["energy"] = computed_energy(post)
            if post["author_id"] != author_id:
                self._notify(post["author_id"], author_id, post_id, row["id"], "comment")
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

    def _notify(self, recipient_id, actor_id, post_id, comment_id, kind):
        row = {
            "id": str(uuid.uuid4()),
            "recipient_id": recipient_id,
            "actor_id": actor_id,
            "post_id": post_id,
            "comment_id": comment_id,
            "type": kind,
            "created_at": _now(),
            "read_at": None,
        }
        self._notifications[row["id"]] = row

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
                row["actor"] = {
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
        out = {key: row[key] for key in ("id", "post_id", "author_id", "body", "created_at")}
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
                if response.status_code < 400 or response.status_code in allow_statuses:
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
        response = self._send(
            "POST", ACCOUNTS, label="プロフィールの保存",
            headers={"Prefer": "return=representation,resolution=merge-duplicates"},
            params={"on_conflict": "id"},
            json=record,
        )
        body = response.json()
        return body[0] if body else self.get_account(account_id)

    # -- posts -------------------------------------------------------------

    def insert_post(self, record):
        response = self._send(
            "POST", POSTS, label="保存",
            headers={"Prefer": "return=representation"},
            params={"select": POST_COLUMNS},
            json=record,
        )
        return response.json()[0]

    def get_post(self, post_id, with_vec=False):
        select = POST_COLUMNS + (",vec,vec_c" if with_vec else "")
        rows = self._get(POSTS, {
            "select": select, "id": f"eq.{post_id}", "deleted_at": "is.null", "limit": "1",
        })
        return rows[0] if rows else None

    def update_post(self, post_id, author_id, fields):
        response = self._send(
            "PATCH", POSTS, label="更新",
            headers={"Prefer": "return=representation"},
            params={
                "id": f"eq.{post_id}", "author_id": f"eq.{author_id}",
                "deleted_at": "is.null", "select": POST_COLUMNS,
            },
            json=fields,
        )
        rows = response.json()
        return rows[0] if rows else None

    def soft_delete_post(self, post_id, author_id):
        return bool(self.update_post(post_id, author_id, {"deleted_at": _now()}))

    def posts_by_author(self, author_id):
        rows = self._get(POSTS, {
            "select": POST_COLUMNS + f",{ACCOUNTS}(id,display_name,icon_id,avatar_path)",
            "author_id": f"eq.{author_id}",
            "deleted_at": "is.null",
            "order": "created_at.desc",
        })
        return [_flatten(row) for row in rows]

    def count_posts(self):
        response = self._send(
            "GET", POSTS, label="件数の取得",
            headers={"Prefer": "count=exact", "Range": "0-0"},
            params={"select": "id", "deleted_at": "is.null"},
        )
        # Content-Range looks like "0-0/42"
        return int(response.headers.get("content-range", "*/0").split("/")[-1])

    def map_posts(self, min_x, min_y, max_x, max_y, limit):
        return self._rpc("map_posts", {
            "min_x": min_x, "min_y": min_y, "max_x": max_x, "max_y": max_y,
            "limit_n": limit,
        }, label="地図の読み込み")

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

    def nearest_posts(self, post_id, k):
        rows = self._rpc("nearest_posts", {"from_post": post_id, "k": k},
                         label="近い人の検索")
        return [(row["id"], float(row["cosine"])) for row in rows]

    def pair_similarity(self, a, b):
        value = self._rpc("pair_similarity", {"a": a, "b": b}, label="似てる度の計算")
        return float(value) if isinstance(value, (int, float)) else None

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

    def add_comment(self, post_id, author_id, body):
        response = self._send(
            "POST", COMMENTS, label="メッセージの送信",
            headers={"Prefer": "return=representation"},
            params={"select": f"id,post_id,author_id,body,created_at,"
                              f"{ACCOUNTS}(id,display_name,icon_id,avatar_path)"},
            json={"post_id": post_id, "author_id": author_id, "body": body},
        )
        return _flatten(response.json()[0], into="author")

    def list_comments(self, post_id):
        rows = self._get(COMMENTS, {
            "select": f"id,post_id,author_id,body,created_at,"
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
            "select": f"id,recipient_id,actor_id,post_id,comment_id,type,created_at,read_at,"
                      f"{ACCOUNTS}!notifications_actor_id_fkey(id,display_name,icon_id,avatar_path)",
            "recipient_id": f"eq.{recipient_id}",
            "order": "created_at.desc",
            "limit": str(limit),
        })
        return [_flatten(row, into="actor") for row in rows]

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
