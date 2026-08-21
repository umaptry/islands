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
        # get() must withhold the vector unless it is asked for, and hand it
        # over when it is: similarity is unreadable without it.
        assert "vec" not in backend.get(created["id"])
        assert backend.get(created["id"], with_vec=True)["vec"] == sample("契約")["vec"]
        rows = backend.list_vectors()
        assert {row["id"] for row in rows} >= {created["id"]}
        assert all(set(row) == {"id", "vec"} for row in rows), "vectors query stays lean"
        assert backend.delete(created["id"], created["edit_token"]) is True


# ---------------------------------------------------------------- retries
#
# The store retries transient failures because a demo cannot afford to turn a
# dropped connection into a failed join. These pin down which failures count as
# transient, and - just as important - which do not.

class FlakyPostgrest(BaseHTTPRequestHandler):
    """Fails the first `fail_times` requests with `fail_status`, then succeeds."""

    fail_times = 0
    fail_status = 503
    seen = 0

    def log_message(self, *args):
        pass

    def do_GET(self):
        type(self).seen += 1
        if type(self).seen <= type(self).fail_times:
            self.send_response(type(self).fail_status)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = json.dumps([]).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture
def flaky():
    server = HTTPServer(("127.0.0.1", 0), FlakyPostgrest)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    FlakyPostgrest.seen = 0
    yield FlakyPostgrest, SupabaseStore(f"http://{host}:{port}", SERVICE_KEY)
    server.shutdown()


def test_transient_failure_is_retried_until_it_succeeds(flaky, monkeypatch):
    import core.store as store_module

    monkeypatch.setattr(store_module, "RETRY_BACKOFF", 0.01)
    handler, store = flaky
    handler.fail_times = 2
    handler.fail_status = 503

    assert store.list_public() == []
    assert handler.seen == 3  # two failures, then the real answer


def test_retries_give_up_and_raise(flaky, monkeypatch):
    import core.store as store_module

    monkeypatch.setattr(store_module, "RETRY_BACKOFF", 0.01)
    handler, store = flaky
    handler.fail_times = 99
    handler.fail_status = 503

    with pytest.raises(store_module.StoreError):
        store.list_public()
    assert handler.seen == store_module.RETRY_ATTEMPTS


def test_a_client_error_is_not_retried(flaky, monkeypatch):
    """A 400 is our own bug. Repeating it only makes the visitor wait longer."""
    import core.store as store_module

    monkeypatch.setattr(store_module, "RETRY_BACKOFF", 0.01)
    handler, store = flaky
    handler.fail_times = 99
    handler.fail_status = 400

    with pytest.raises(store_module.StoreError):
        store.list_public()
    assert handler.seen == 1


def test_error_message_does_not_leak_the_response_body(flaky, monkeypatch):
    """StoreError text is rendered into the browser, so it stays generic."""
    import core.store as store_module

    monkeypatch.setattr(store_module, "RETRY_BACKOFF", 0.01)
    handler, store = flaky
    handler.fail_times = 99
    handler.fail_status = 503

    with pytest.raises(store_module.StoreError) as caught:
        store.list_public()
    assert "503" not in str(caught.value)


# ---------------------------------------------------------------- likes
#
# The duplicate case reached production. PostgREST builds ON CONFLICT against
# the PRIMARY KEY unless the request names the columns, and likes collide on
# unique(from_id, to_id) instead - so a second tap on the same person came back
# 409 and the tapper was told the like could not be sent.
#
# MemoryStore keys likes by the pair, so it could never reproduce this. The fake
# below models PostgREST's actual contract rather than our convenient one.

LIKES = {}


class FakeLikesPostgrest(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, status, payload=None):
        body = b"" if payload is None else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        query = parse_qs(urlparse(self.path).query)
        record = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        key = (record["from_id"], record["to_id"])
        prefer = self.headers.get("Prefer", "")

        if key in LIKES:
            names_the_pair = query.get("on_conflict", [""])[0] == "from_id,to_id"
            if names_the_pair and "ignore-duplicates" in prefer:
                return self._send(201, [])       # swallowed, nothing created
            return self._send(409, {"code": "23505", "message": "duplicate key"})

        LIKES[key] = "2026-01-01T00:00:00Z"
        row = {"id": str(uuid.uuid4()), "from_id": key[0], "to_id": key[1],
               "created_at": LIKES[key]}
        self._send(201, [row] if "return=representation" in prefer else None)

    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        rows = [{"from_id": a, "to_id": b, "created_at": t} for (a, b), t in LIKES.items()]
        for key, values in query.items():
            if key in {"select", "order", "limit"}:
                continue
            for value in values:
                if value.startswith("eq."):
                    rows = [row for row in rows if str(row.get(key)) == value[3:]]
        columns = query.get("select", ["*"])[0].split(",")
        self._send(200, [{k: v for k, v in row.items() if k in columns} for row in rows])


@pytest.fixture
def likes_store():
    LIKES.clear()
    server = HTTPServer(("127.0.0.1", 0), FakeLikesPostgrest)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    yield SupabaseStore(f"http://{host}:{port}", SERVICE_KEY)
    server.shutdown()


def test_first_like_is_created(likes_store):
    assert likes_store.add_like("a", "b") is True


def test_liking_the_same_person_twice_is_not_an_error(likes_store):
    """The demo behaviour: tapping again says "already liked", never fails."""
    assert likes_store.add_like("a", "b") is True
    assert likes_store.add_like("a", "b") is False


def test_duplicate_survives_even_without_the_on_conflict_hint(likes_store, monkeypatch):
    """If the hint is ever lost, a 409 must still read as "already liked"."""
    import core.store as store_module

    monkeypatch.setattr(store_module, "RETRY_BACKOFF", 0.01)
    original = likes_store._send

    def strip_hint(method, **kwargs):
        if kwargs.get("params", {}).get("on_conflict"):
            kwargs["params"] = {}
        return original(method, **kwargs)

    likes_store.add_like("a", "b")
    monkeypatch.setattr(likes_store, "_send", strip_hint)
    assert likes_store.add_like("a", "b") is False


def test_likes_received_and_given(likes_store):
    likes_store.add_like("b", "a")
    likes_store.add_like("c", "a")
    likes_store.add_like("a", "c")

    received = likes_store.likes_received("a")
    assert sorted(row["from_id"] for row in received) == ["b", "c"]
    assert likes_store.likes_given("a") == ["c"]
    assert likes_store.like_counts() == {"a": 2, "c": 1}


def test_memory_and_supabase_agree_on_the_like_contract(likes_store):
    memory = MemoryStore()
    person = memory.insert(sample("うけとる"))
    assert memory.add_like("someone", person["id"]) is True
    assert memory.add_like("someone", person["id"]) is False
    assert likes_store.add_like("someone", person["id"]) is True
    assert likes_store.add_like("someone", person["id"]) is False
