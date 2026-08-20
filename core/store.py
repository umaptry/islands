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
import uuid
from datetime import datetime, timezone

import httpx

TABLE = "profiles"
REQUEST_TIMEOUT = 10.0

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

    def _get(self, params):
        response = self._client.get(self._base, headers=self._headers, params=params)
        if response.status_code >= 400:
            raise StoreError(f"Supabase GET {response.status_code}: {response.text[:200]}")
        return response.json()

    def count(self):
        headers = dict(self._headers)
        headers["Prefer"] = "count=exact"
        headers["Range"] = "0-0"
        response = self._client.get(self._base, headers=headers, params={"select": "id"})
        if response.status_code >= 400:
            raise StoreError(f"Supabase count {response.status_code}: {response.text[:200]}")
        # Content-Range looks like "0-0/42"
        content_range = response.headers.get("content-range", "*/0")
        return int(content_range.split("/")[-1])

    def insert(self, record):
        headers = dict(self._headers)
        headers["Prefer"] = "return=representation"
        response = self._client.post(self._base, headers=headers, json=record)
        if response.status_code >= 400:
            raise StoreError(f"Supabase INSERT {response.status_code}: {response.text[:200]}")
        return response.json()[0]

    def list_public(self):
        return self._get({"select": PUBLIC_COLUMNS, "order": "created_at.asc"})

    def list_full(self):
        return self._get({"select": FULL_COLUMNS + ",vec", "order": "created_at.asc"})

    def get(self, profile_id):
        rows = self._get({"select": FULL_COLUMNS, "id": f"eq.{profile_id}", "limit": "1"})
        return rows[0] if rows else None

    def delete(self, profile_id, edit_token):
        headers = dict(self._headers)
        headers["Prefer"] = "return=representation"
        response = self._client.delete(
            self._base,
            headers=headers,
            params={"id": f"eq.{profile_id}", "edit_token": f"eq.{edit_token}"},
        )
        if response.status_code >= 400:
            raise StoreError(f"Supabase DELETE {response.status_code}: {response.text[:200]}")
        return bool(response.json())


def create_store():
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if url and key:
        return SupabaseStore(url, key)
    return MemoryStore()
