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


def _now():
    return datetime.now(timezone.utc).isoformat()


class StoreError(RuntimeError):
    pass


class MemoryStore:
    """In-process store for local development and tests."""

    backend = "memory"

    def __init__(self):
        self._rows = {}
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

    def get(self, profile_id):
        with self._lock:
            row = self._rows.get(profile_id)
        return dict(row) if row else None

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
        self._base = f"{url.rstrip('/')}/rest/v1/{TABLE}"
        self._headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        }
        self._client = httpx.Client(timeout=REQUEST_TIMEOUT)

    def _send(self, method, *, label, headers=None, params=None, json=None):
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
                    method, self._base, headers=merged, params=params, json=json
                )
            except httpx.HTTPError as error:  # timeout, DNS, connection reset
                last = f"{type(error).__name__}: {error}"
            else:
                if response.status_code < 400:
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

    def list_public(self):
        return self._get({"select": PUBLIC_COLUMNS, "order": "created_at.asc"})

    def list_full(self):
        return self._get({"select": FULL_COLUMNS + ",vec", "order": "created_at.asc"})

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
