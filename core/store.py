"""Where profiles live.

Two interchangeable backends:

  MemoryStore    - local development. Nothing survives a restart.
  SupabaseStore  - the deployed demo. Talks to PostgREST with the service_role
                   key, which is held only as a Space secret. The browser never
                   sees a Supabase credential and never contacts Supabase, so
                   there is no anon key to leak and no RLS policy to get wrong.

Selected automatically: Supabase if SUPABASE_URL and SUPABASE_SERVICE_KEY are
both set, memory otherwise.
"""

import os
import threading
import time
import uuid
from datetime import datetime, timezone

import httpx

TABLE = "profiles"
LIKES_TABLE = "likes"
REQUEST_TIMEOUT = 10.0

# A dropped connection or a 502 from the PostgREST front end is routine and
# clears on its own. Without a retry every one of them surfaced as a failed join
# in somebody's browser, which is the one thing a live demo cannot afford.
# Only transient classes are retried - a 400 or a 409 is our own bug or a real
# conflict, and repeating it just wastes the visitor's time.
RETRY_ATTEMPTS = 3
RETRY_BACKOFF = 0.4  # seconds, doubled each attempt
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})

# Columns returned for the public map. Deliberately excludes text / vec / terms
# / edit_token: the map shows where people are, not what they wrote.
PUBLIC_COLUMNS = "id,icon_id,name,x,y,cluster_id,created_at"
FULL_COLUMNS = PUBLIC_COLUMNS + ",text,terms"
# Just enough to name the islands. Naming needs the words, not the essays,
# and certainly not the 448-float vectors that list_full drags along.
TERM_COLUMNS = "id,cluster_id,x,y,terms"


def _now():
    return datetime.now(timezone.utc).isoformat()


class StoreError(RuntimeError):
    pass


class MemoryStore:
    """In-process store for local development and tests."""

    backend = "memory"

    def __init__(self):
        self._rows = {}
        # (from_id, to_id) -> created_at. The pair is the key, so liking the
        # same person twice is a no-op rather than a second notification.
        self._likes = {}
        self._lock = threading.Lock()

    def count(self):
        with self._lock:
            return len(self._rows)

    def insert(self, record):
        row = dict(record)
        row.setdefault("id", str(uuid.uuid4()))
        row.setdefault("edit_token", str(uuid.uuid4()))
        row.setdefault("created_at", _now())
        with self._lock:
            self._rows[row["id"]] = row
        return dict(row)

    def list_public(self):
        with self._lock:
            rows = sorted(self._rows.values(), key=lambda row: row["created_at"])
        return [{key: row[key] for key in PUBLIC_COLUMNS.split(",")} for row in rows]

    def list_full(self):
        with self._lock:
            rows = sorted(self._rows.values(), key=lambda row: row["created_at"])
        return [dict(row) for row in rows]

    def list_terms(self):
        with self._lock:
            rows = sorted(self._rows.values(), key=lambda row: row["created_at"])
        return [{key: row.get(key) for key in TERM_COLUMNS.split(",")} for row in rows]

    def get(self, profile_id):
        with self._lock:
            row = self._rows.get(profile_id)
        return dict(row) if row else None

    def verify(self, profile_id, edit_token):
        with self._lock:
            row = self._rows.get(profile_id)
        return bool(row and row["edit_token"] == edit_token)

    def add_like(self, from_id, to_id):
        """True if this is a new like, False if it already existed."""
        with self._lock:
            if to_id not in self._rows:
                return False
            key = (from_id, to_id)
            if key in self._likes:
                return False
            self._likes[key] = _now()
        return True

    def likes_received(self, to_id):
        with self._lock:
            rows = [
                {"from_id": sender, "created_at": when}
                for (sender, target), when in self._likes.items()
                if target == to_id
            ]
        return sorted(rows, key=lambda row: row["created_at"])

    def likes_given(self, from_id):
        with self._lock:
            return sorted(
                target for (sender, target) in self._likes if sender == from_id
            )

    def like_counts(self):
        counts = {}
        with self._lock:
            for _sender, target in self._likes:
                counts[target] = counts.get(target, 0) + 1
        return counts

    def delete(self, profile_id, edit_token):
        with self._lock:
            row = self._rows.get(profile_id)
            if not row or row["edit_token"] != edit_token:
                return False
            del self._rows[profile_id]
        return True


class SupabaseStore:
    """PostgREST client. All calls are server-side with the service_role key."""

    backend = "supabase"

    def __init__(self, url, service_key):
        root = f"{url.rstrip('/')}/rest/v1"
        self._base = f"{root}/{TABLE}"
        self._likes = f"{root}/{LIKES_TABLE}"
        self._headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        }
        self._client = httpx.Client(timeout=REQUEST_TIMEOUT)

    def _send(self, method, *, label, url=None, headers=None, params=None, json=None,
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

        delay = RETRY_BACKOFF
        last = ""
        for attempt in range(1, RETRY_ATTEMPTS + 1):
            try:
                response = self._client.request(
                    method, url or self._base, headers=merged, params=params, json=json
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

    def _get(self, params):
        return self._send("GET", label="読み込み", params=params).json()

    def count(self):
        response = self._send(
            "GET",
            label="件数の取得",
            headers={"Prefer": "count=exact", "Range": "0-0"},
            params={"select": "id"},
        )
        # Content-Range looks like "0-0/42"
        content_range = response.headers.get("content-range", "*/0")
        return int(content_range.split("/")[-1])

    def insert(self, record):
        response = self._send(
            "POST", label="保存", headers={"Prefer": "return=representation"}, json=record
        )
        return response.json()[0]

    def verify(self, profile_id, edit_token):
        rows = self._get(
            {
                "select": "id",
                "id": f"eq.{profile_id}",
                "edit_token": f"eq.{edit_token}",
                "limit": "1",
            }
        )
        return bool(rows)

    def add_like(self, from_id, to_id):
        """True if this is a new like, False if the pair was already there.

        The unique constraint on (from_id, to_id) is what makes this safe: two
        taps racing each other both reach PostgREST, and the loser is turned
        into a 409 that we read as "already liked" rather than an error. Doing
        the check with a SELECT first would still let the pair through twice.
        """
        response = self._send(
            "POST",
            label="いいねの保存",
            url=self._likes,
            # on_conflict names the constraint columns. Without it PostgREST
            # builds ON CONFLICT against the PRIMARY KEY, which a fresh
            # gen_random_uuid() never collides with - so a repeat like came back
            # as a 409 and surfaced to the tapper as "送れませんでした".
            params={"on_conflict": "from_id,to_id"},
            headers={"Prefer": "return=representation,resolution=ignore-duplicates"},
            json={"from_id": from_id, "to_id": to_id},
            # Belt and braces: if a deployment ever loses the on_conflict hint,
            # a duplicate must still read as "already liked" rather than an error.
            allow_statuses=(409,),
        )
        if response.status_code == 409:
            return False
        # ignore-duplicates returns an empty body when the row already existed.
        body = response.json() if response.content else []
        return bool(body)

    def likes_received(self, to_id):
        return self._send(
            "GET",
            label="いいねの読み込み",
            url=self._likes,
            params={
                "select": "from_id,created_at",
                "to_id": f"eq.{to_id}",
                "order": "created_at.asc",
            },
        ).json()

    def likes_given(self, from_id):
        rows = self._send(
            "GET",
            label="いいねの読み込み",
            url=self._likes,
            params={"select": "to_id", "from_id": f"eq.{from_id}"},
        ).json()
        return sorted(row["to_id"] for row in rows)

    def like_counts(self):
        rows = self._send(
            "GET", label="いいねの集計", url=self._likes, params={"select": "to_id"}
        ).json()
        counts = {}
        for row in rows:
            counts[row["to_id"]] = counts.get(row["to_id"], 0) + 1
        return counts

    def list_public(self):
        return self._get({"select": PUBLIC_COLUMNS, "order": "created_at.asc"})

    def list_full(self):
        return self._get({"select": FULL_COLUMNS + ",vec", "order": "created_at.asc"})

    def list_terms(self):
        return self._get({"select": TERM_COLUMNS, "order": "created_at.asc"})

    def get(self, profile_id):
        rows = self._get({"select": FULL_COLUMNS, "id": f"eq.{profile_id}", "limit": "1"})
        return rows[0] if rows else None

    def delete(self, profile_id, edit_token):
        response = self._send(
            "DELETE",
            label="削除",
            headers={"Prefer": "return=representation"},
            params={"id": f"eq.{profile_id}", "edit_token": f"eq.{edit_token}"},
        )
        return bool(response.json())


def create_store():
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if url and key:
        return SupabaseStore(url, key)
    return MemoryStore()
