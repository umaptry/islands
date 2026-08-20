"""SupabaseStore against a stand-in PostgREST.

This code path only runs in production, where a mistake means the demo is dead
on arrival and the fix costs a redeploy. The fake implements the parts of
PostgREST the store actually relies on - the `count=exact` Content-Range header,
`return=representation`, `eq.` filters and the DELETE-returns-rows contract - so
the store is exercised end to end without touching a real project.
"""

import json
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core.store import MemoryStore, SupabaseStore  # noqa: E402

SERVICE_KEY = "test-service-role-key"
ROWS = {}


class FakePostgrest(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # keep pytest output clean

    def _auth_ok(self):
        return (
            self.headers.get("apikey") == SERVICE_KEY
            and self.headers.get("Authorization") == f"Bearer {SERVICE_KEY}"
        )

    def _send(self, status, payload=None, extra_headers=None):
        body = b"" if payload is None else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _filters(self, query):
        """Translate PostgREST `col=eq.value` params into a predicate."""
        conditions = {}
        for key, values in query.items():
            if key in {"select", "order", "limit"}:
                continue
            for value in values:
                if value.startswith("eq."):
                    conditions[key] = value[3:]
        return lambda row: all(str(row.get(k)) == v for k, v in conditions.items())

    def do_GET(self):
        if not self._auth_ok():
            return self._send(401, {"message": "unauthorized"})
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        rows = [row for row in ROWS.values() if self._filters(query)(row)]
        rows.sort(key=lambda row: row["created_at"])

        if self.headers.get("Prefer") == "count=exact":
            return self._send(200, [], {"Content-Range": f"0-0/{len(rows)}"})

        columns = query.get("select", ["*"])[0].split(",")
        if "limit" in query:
            rows = rows[: int(query["limit"][0])]
        projected = [
            {k: v for k, v in row.items() if k in columns} if columns != ["*"] else dict(row)
            for row in rows
        ]
        self._send(200, projected)

    def do_POST(self):
        if not self._auth_ok():
            return self._send(401, {"message": "unauthorized"})
        length = int(self.headers.get("Content-Length", 0))
        record = json.loads(self.rfile.read(length))
        row = dict(record)
        row["id"] = str(uuid.uuid4())
        row["edit_token"] = str(uuid.uuid4())
        row["created_at"] = f"2026-01-01T00:00:{len(ROWS):02d}Z"
        ROWS[row["id"]] = row
        self._send(201, [row] if self.headers.get("Prefer") == "return=representation" else None)

    def do_DELETE(self):
        if not self._auth_ok():
            return self._send(401, {"message": "unauthorized"})
        query = parse_qs(urlparse(self.path).query)
        matched = [row for row in ROWS.values() if self._filters(query)(row)]
        for row in matched:
            del ROWS[row["id"]]
        self._send(200, matched)


@pytest.fixture(scope="module")
def store():
    ROWS.clear()
    server = HTTPServer(("127.0.0.1", 0), FakePostgrest)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    yield SupabaseStore(f"http://{host}:{port}", SERVICE_KEY)
    server.shutdown()


def sample(name="てすと"):
    return {
        "icon_id": "3",
        "name": name,
        "text": "週末はキャンプで焚き火を眺めています。道具を少しずつ揃えるのが楽しい。",
        "x": 123.45,
        "y": 678.9,
        "cluster_id": 2,
        "terms": ["キャンプ", "焚き火", "道具"],
        "vec": [0.1, 0.2, 0.3],
    }


def test_insert_returns_generated_id_and_token(store):
    row = store.insert(sample())
    assert row["id"] and row["edit_token"]
    assert row["name"] == "てすと"
    assert row["x"] == 123.45


def test_count_reads_the_content_range_header(store):
    before = store.count()
    store.insert(sample("ふたり目"))
    assert store.count() == before + 1


def test_list_public_hides_text_and_vectors(store):
    rows = store.list_public()
    assert rows
    for row in rows:
        assert set(row) == {"id", "icon_id", "name", "x", "y", "cluster_id", "created_at"}


def test_list_full_carries_terms_for_shared_keywords(store):
    rows = store.list_full()
    assert rows
    assert all("terms" in row and "text" in row for row in rows)


def test_get_by_id(store):
    created = store.insert(sample("さんにん目"))
    fetched = store.get(created["id"])
    assert fetched["name"] == "さんにん目"
    assert store.get(str(uuid.uuid4())) is None


def test_delete_requires_matching_edit_token(store):
    created = store.insert(sample("よにん目"))
    assert store.delete(created["id"], str(uuid.uuid4())) is False
    assert store.get(created["id"]) is not None
    assert store.delete(created["id"], created["edit_token"]) is True
    assert store.get(created["id"]) is None


def test_bad_credentials_raise_rather_than_return_empty(store):
    from core.store import StoreError

    broken = SupabaseStore(store._base.rsplit("/rest/v1/", 1)[0], "wrong-key")
    with pytest.raises(StoreError):
        broken.list_public()


def test_matches_the_memory_backend_contract(store):
    """Both backends must be interchangeable from the app's point of view."""
    memory = MemoryStore()
    for backend in (memory, store):
        created = backend.insert(sample("契約"))
        assert {"id", "edit_token", "created_at"} <= set(created)
        assert backend.get(created["id"])["name"] == "契約"
        assert backend.delete(created["id"], created["edit_token"]) is True
