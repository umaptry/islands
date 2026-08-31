"""SupabaseStore against a stand-in PostgREST.

This code path only runs in production, where a mistake means the app is dead on
arrival and the fix costs a redeploy. The fake implements the parts of PostgREST
the store actually relies on - the `count=exact` Content-Range header,
`return=representation`, `eq.` filters, embedded selects, RPC calls, and the
DELETE-returns-rows contract - so the store is exercised end to end without
touching a real project.

The other half of the file is the retry policy, which exists because a dropped
connection to PostgREST used to surface as a failed post in somebody's browser.
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

# table -> {id: row}
TABLES = {"accounts": {}, "posts": {}, "reactions": {}, "comments": {}, "notifications": {}}
SEQUENCE = {"n": 0}


def reset():
    for rows in TABLES.values():
        rows.clear()
    SEQUENCE["n"] = 0


def stamp():
    SEQUENCE["n"] += 1
    return f"2026-01-01T00:00:{SEQUENCE['n']:02d}Z"


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

    def _table(self):
        return urlparse(self.path).path.rsplit("/", 1)[-1]

    def _body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length)) if length else None

    def _filters(self, query):
        """Translate PostgREST `col=eq.value` / `col=is.null` into a predicate."""
        checks = []
        for key, values in query.items():
            if key in {"select", "order", "limit", "on_conflict"}:
                continue
            for value in values:
                if value.startswith("eq."):
                    wanted = value[3:]
                    checks.append(lambda row, k=key, v=wanted: str(row.get(k)) == v)
                elif value == "is.null":
                    checks.append(lambda row, k=key: row.get(k) is None)
                elif value.startswith("in."):
                    wanted = set(value[4:-1].split(","))
                    checks.append(lambda row, k=key, v=wanted: str(row.get(k)) in v)
        return lambda row: all(check(row) for check in checks)

    def _project(self, rows, select):
        """Handle a select list, including one level of embedded table."""
        if select in (None, "*"):
            return [dict(row) for row in rows]
        # accounts(id,display_name) -> embed
        embeds = {}
        plain = []
        depth = 0
        current = ""
        for char in select:
            if char == "(":
                depth += 1
            if char == "," and depth == 0:
                plain.append(current)
                current = ""
                continue
            if char == ")":
                depth -= 1
            current += char
        if current:
            plain.append(current)

        columns = []
        for piece in plain:
            if "(" in piece:
                table = piece.split("(")[0].split("!")[0]
                fields = piece[piece.index("(") + 1:piece.rindex(")")].split(",")
                embeds[table] = fields
            else:
                columns.append(piece)

        out = []
        for row in rows:
            shaped = {key: row.get(key) for key in columns if key in row}
            for table, fields in embeds.items():
                # The only embed the store uses is accounts, joined on a *_id.
                key = "author_id" if "author_id" in row else "actor_id"
                parent = TABLES["accounts"].get(row.get(key))
                shaped[table] = (
                    {field: parent.get(field) for field in fields} if parent else None
                )
            out.append(shaped)
        return out

    # -- routes ------------------------------------------------------------

    def do_GET(self):
        if not self._auth_ok():
            return self._send(401, {"message": "unauthorized"})
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        rows = [row for row in TABLES[self._table()].values() if self._filters(query)(row)]
        rows.sort(key=lambda row: row.get("created_at") or "")

        if "count=exact" in (self.headers.get("Prefer") or ""):
            return self._send(200, [], {"Content-Range": f"0-0/{len(rows)}"})

        if "limit" in query:
            rows = rows[: int(query["limit"][0])]
        self._send(200, self._project(rows, query.get("select", ["*"])[0]))

    def do_POST(self):
        if not self._auth_ok():
            return self._send(401, {"message": "unauthorized"})
        parsed = urlparse(self.path)
        table = self._table()
        record = self._body()
        prefer = self.headers.get("Prefer") or ""

        if parsed.path.rsplit("/", 2)[-2] == "rpc":
            return self._rpc(table, record)

        rows = TABLES[table]

        # Upsert on a named conflict target: accounts on id, reactions on the
        # (post, actor, kind) triple. This is the behaviour the store leans on
        # for "liking twice is the same as liking once".
        conflict = parse_qs(parsed.query).get("on_conflict", [None])[0]
        if conflict:
            keys = conflict.split(",")
            for existing in rows.values():
                if all(existing.get(key) == record.get(key) for key in keys):
                    if "merge-duplicates" in prefer:
                        existing.update(record)
                        return self._send(200, [existing])
                    # ignore-duplicates: an empty body, not an error.
                    return self._send(201, [] if "representation" in prefer else None)

        row = dict(record)
        row.setdefault("id", str(uuid.uuid4()))
        row.setdefault("created_at", stamp())
        row.setdefault("deleted_at", None)
        if table == "posts":
            for column in ("like_count", "help_count", "join_count", "comment_count"):
                row.setdefault(column, 0)
            row["energy"] = (
                float(row.get("motivation") or 0)
                + sum(row.get(c, 0) for c in
                      ("like_count", "help_count", "join_count", "comment_count")) * 5
            )
        rows[row["id"]] = row
        select = parse_qs(parsed.query).get("select", ["*"])[0]
        self._send(201, self._project([row], select) if "representation" in prefer else None)

    def _rpc(self, name, args):
        if name == "map_posts":
            rows = [
                row for row in TABLES["posts"].values()
                if row.get("deleted_at") is None
                and args["min_x"] <= row["x"] <= args["max_x"]
                and args["min_y"] <= row["y"] <= args["max_y"]
            ]
            rows.sort(key=lambda row: -row["energy"])
            out = []
            for row in rows[: args.get("limit_n", 800)]:
                account = TABLES["accounts"].get(row["author_id"], {})
                out.append({
                    **{k: v for k, v in row.items() if k not in ("vec", "vec_c")},
                    "display_name": account.get("display_name", ""),
                    "icon_id": account.get("icon_id", "0"),
                    "avatar_path": account.get("avatar_path"),
                })
            return self._send(200, out)
        if name == "nearest_posts":
            origin = TABLES["posts"].get(args["from_post"])
            out = []
            for row in TABLES["posts"].values():
                if row["id"] == args["from_post"] or row.get("deleted_at"):
                    continue
                out.append({"id": row["id"], "cosine": _cosine(origin, row)})
            out.sort(key=lambda item: -item["cosine"])
            return self._send(200, out[: args.get("k", 24)])
        if name == "pair_similarity":
            return self._send(
                200, _cosine(TABLES["posts"].get(args["a"]), TABLES["posts"].get(args["b"]))
            )
        if name == "map_cells":
            return self._send(200, [])
        return self._send(404, {"message": f"no function {name}"})

    def do_PATCH(self):
        if not self._auth_ok():
            return self._send(401, {"message": "unauthorized"})
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        patch = self._body()
        matched = [
            row for row in TABLES[self._table()].values() if self._filters(query)(row)
        ]
        for row in matched:
            row.update(patch)
        select = query.get("select", ["*"])[0]
        self._send(200, self._project(matched, select))

    def do_DELETE(self):
        if not self._auth_ok():
            return self._send(401, {"message": "unauthorized"})
        query = parse_qs(urlparse(self.path).query)
        rows = TABLES[self._table()]
        matched = [row for row in rows.values() if self._filters(query)(row)]
        for row in matched:
            del rows[row["id"]]
        self._send(200, matched)


def _cosine(a, b):
    """Enough of a cosine for the ordering tests: parse the pgvector literal."""
    if not a or not b:
        return 0.0
    left = [float(v) for v in str(a["vec_c"]).strip("[]").split(",")]
    right = [float(v) for v in str(b["vec_c"]).strip("[]").split(",")]
    return sum(x * y for x, y in zip(left, right))


@pytest.fixture(scope="module")
def store():
    reset()
    server = HTTPServer(("127.0.0.1", 0), FakePostgrest)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    yield SupabaseStore(f"http://{host}:{port}", SERVICE_KEY)
    server.shutdown()


def account(store, name="てすと"):
    row = store.upsert_account(str(uuid.uuid4()), {"display_name": name, "icon_id": "3"})
    return row["id"]


def sample(author_id, body="週末はキャンプで焚き火を眺めています。道具を少しずつ揃えるのが楽しい。"):
    return {
        "author_id": author_id,
        "body": body,
        "tags": ["気軽に話しかけて"],
        "motivation": 60,
        "image_path": None,
        "x": 123.45,
        "y": 678.9,
        "cluster_id": 2,
        "terms": ["キャンプ", "焚き火", "道具"],
        "vec": "[" + ",".join(["0.1"] * 8) + "]",
        "vec_c": "[" + ",".join(["0.1"] * 8) + "]",
    }


# --------------------------------------------------------------------------
# rows in, rows out
# --------------------------------------------------------------------------

def test_insert_returns_a_generated_id(store):
    author = account(store)
    row = store.insert_post(sample(author))
    assert row["id"]
    assert row["body"].startswith("週末は")
    assert row["cluster_id"] == 2


def test_the_insert_response_never_carries_the_vectors(store):
    """The select list on the insert is what keeps 448 floats off the wire."""
    author = account(store)
    row = store.insert_post(sample(author))
    assert "vec" not in row
    assert "vec_c" not in row


def test_count_reads_the_content_range_header(store):
    before = store.count_posts()
    author = account(store)
    store.insert_post(sample(author))
    assert store.count_posts() == before + 1


def test_map_posts_joins_the_author_and_drops_the_vectors(store):
    author = account(store, "地図の人")
    store.insert_post(sample(author))
    rows = store.map_posts(0, 0, 1000, 1000, 100)
    assert rows
    row = next(r for r in rows if r["author_id"] == author)
    assert row["display_name"] == "地図の人"
    assert "vec" not in row and "vec_c" not in row


def test_posts_by_author_flattens_the_embedded_account(store):
    """PostgREST nests the join; every screen wants it flat.

    Both backends have to return the same shape or a caller would need to know
    which one it is talking to.
    """
    author = account(store, "作者")
    store.insert_post(sample(author))
    rows = store.posts_by_author(author)
    assert rows
    assert rows[0]["display_name"] == "作者"
    assert "accounts" not in rows[0]


def test_get_post_by_id(store):
    author = account(store)
    created = store.insert_post(sample(author))
    fetched = store.get_post(created["id"])
    assert fetched["id"] == created["id"]
    assert store.get_post(str(uuid.uuid4())) is None


def test_soft_delete_hides_the_post_but_keeps_the_row(store):
    author = account(store)
    created = store.insert_post(sample(author))
    assert store.soft_delete_post(created["id"], author) is True
    assert store.get_post(created["id"]) is None
    # Somebody else's delete does nothing.
    other = account(store)
    again = store.insert_post(sample(author))
    assert store.soft_delete_post(again["id"], other) is False


def test_upsert_account_merges_rather_than_duplicating(store):
    account_id = str(uuid.uuid4())
    store.upsert_account(account_id, {"display_name": "はじめ", "icon_id": "1"})
    store.upsert_account(account_id, {"bio": "あとから足した自己紹介"})
    row = store.get_account(account_id)
    assert row["display_name"] == "はじめ"
    assert row["bio"] == "あとから足した自己紹介"


def test_a_null_field_clears_it_rather_than_being_ignored(store):
    """Emptying a box has to reach the database.

    merge-duplicates writes exactly the columns it is sent, so a store layer
    that filtered nulls out made 自己紹介 and リンク write-once: you could put
    text in and never take it out again.
    """
    account_id = str(uuid.uuid4())
    store.upsert_account(account_id, {
        "display_name": "けす人", "bio": "消える自己紹介", "link_url": "example.com",
    })
    store.upsert_account(account_id, {"bio": None, "link_url": None})
    row = store.get_account(account_id)
    assert row["display_name"] == "けす人"   # untouched: never sent
    assert row["bio"] is None
    assert row["link_url"] is None


def test_bad_credentials_raise_rather_than_return_empty(store):
    from core.store import StoreError

    broken = SupabaseStore(store._root.replace("/rest/v1", ""), "wrong-key")
    with pytest.raises(StoreError):
        broken.count_posts()


# --------------------------------------------------------------------------
# reactions
# --------------------------------------------------------------------------

def test_first_reaction_is_created(store):
    author = account(store)
    actor = account(store)
    post = store.insert_post(sample(author))
    assert store.add_reaction(post["id"], actor, "like") is True


def test_reacting_the_same_way_twice_is_not_an_error(store):
    """The unique key is what turns a racing second tap into a no-op.

    Two taps both reach PostgREST and the loser has to read as "already done"
    rather than as "送れませんでした".
    """
    author = account(store)
    actor = account(store)
    post = store.insert_post(sample(author))
    assert store.add_reaction(post["id"], actor, "help") is True
    assert store.add_reaction(post["id"], actor, "help") is False


def test_the_three_kinds_do_not_collide(store):
    author = account(store)
    actor = account(store)
    post = store.insert_post(sample(author))
    assert store.add_reaction(post["id"], actor, "like") is True
    assert store.add_reaction(post["id"], actor, "help") is True
    assert store.add_reaction(post["id"], actor, "join") is True
    kinds = {row["kind"] for row in store.reactions_by_actor(actor)}
    assert kinds == {"like", "help", "join"}


def test_removing_a_reaction_reports_whether_there_was_one(store):
    author = account(store)
    actor = account(store)
    post = store.insert_post(sample(author))
    store.add_reaction(post["id"], actor, "join")
    assert store.remove_reaction(post["id"], actor, "join") is True
    assert store.remove_reaction(post["id"], actor, "join") is False


# --------------------------------------------------------------------------
# comments
# --------------------------------------------------------------------------

def test_a_comment_comes_back_with_its_author_flattened(store):
    author = account(store)
    talker = account(store, "話す人")
    post = store.insert_post(sample(author))
    created = store.add_comment(post["id"], talker, "参加したいです")
    assert created["author"]["display_name"] == "話す人"
    assert "accounts" not in created

    listed = store.list_comments(post["id"])
    assert [row["body"] for row in listed] == ["参加したいです"]
    assert listed[0]["author"]["display_name"] == "話す人"


# --------------------------------------------------------------------------
# both backends have to behave the same
# --------------------------------------------------------------------------

def test_the_two_backends_agree(store):
    """MemoryStore reimplements every trigger in the schema.

    Every method a caller uses has to exist on both and answer the same shape,
    or `app.py` would have to know which backend it is on.
    """
    memory = MemoryStore()
    surface = [
        "get_account", "list_accounts", "upsert_account",
        "insert_post", "get_post", "update_post", "soft_delete_post",
        "posts_by_author", "count_posts", "map_posts", "map_cells", "list_terms",
        "nearest_posts", "pair_similarity",
        "add_reaction", "remove_reaction", "reactions_by_actor",
        "add_comment", "list_comments", "delete_comment",
        "list_notifications", "mark_notifications_read", "unread_count",
        "add_report",
    ]
    for method in surface:
        assert hasattr(memory, method), f"MemoryStore is missing {method}"
        assert hasattr(store, method), f"SupabaseStore is missing {method}"

    author = account(store, "同じ人")
    memory.upsert_account(author, {"display_name": "同じ人", "icon_id": "3"})
    record = sample(author)
    memory_record = dict(record, vec=[0.1] * 8, vec_c=[0.1] * 8)

    remote = store.insert_post(record)
    local = memory.insert_post(memory_record)
    # The columns a caller reads must be present in both.
    for key in ("id", "author_id", "body", "tags", "motivation", "x", "y",
                "cluster_id", "terms", "like_count", "energy", "created_at"):
        assert key in remote, f"SupabaseStore.insert_post dropped {key}"
        assert key in local, f"MemoryStore.insert_post dropped {key}"
    assert remote["energy"] == local["energy"] == 60


# --------------------------------------------------------------------------
# retry policy
# --------------------------------------------------------------------------

class FlakyPostgrest(BaseHTTPRequestHandler):
    """Fails a configurable number of times, then succeeds."""

    failures_left = 0
    status = 503
    attempts = 0
    body = '{"message":"service unavailable","hint":"internal detail"}'

    def log_message(self, *args):
        pass

    def do_GET(self):
        FlakyPostgrest.attempts += 1
        if FlakyPostgrest.failures_left > 0:
            FlakyPostgrest.failures_left -= 1
            payload = FlakyPostgrest.body.encode()
            self.send_response(FlakyPostgrest.status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        payload = b"[]"
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Content-Range", "0-0/7")
        self.end_headers()
        self.wfile.write(payload)


@pytest.fixture
def flaky():
    FlakyPostgrest.attempts = 0
    FlakyPostgrest.failures_left = 0
    FlakyPostgrest.status = 503
    server = HTTPServer(("127.0.0.1", 0), FlakyPostgrest)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    yield SupabaseStore(f"http://{host}:{port}", SERVICE_KEY)
    server.shutdown()


def test_transient_failure_is_retried_until_it_succeeds(flaky, monkeypatch):
    monkeypatch.setattr("core.store.RETRY_BACKOFF", 0.001)
    FlakyPostgrest.failures_left = 2
    assert flaky.count_posts() == 7
    assert FlakyPostgrest.attempts == 3


def test_retries_give_up_and_raise(flaky, monkeypatch):
    from core.store import StoreError

    monkeypatch.setattr("core.store.RETRY_BACKOFF", 0.001)
    FlakyPostgrest.failures_left = 99
    with pytest.raises(StoreError):
        flaky.count_posts()
    assert FlakyPostgrest.attempts == 3, "three attempts, then stop"


def test_a_client_error_is_not_retried(flaky, monkeypatch):
    """A 400 is our own bug. Repeating it only wastes the visitor's time."""
    from core.store import StoreError

    monkeypatch.setattr("core.store.RETRY_BACKOFF", 0.001)
    FlakyPostgrest.status = 400
    FlakyPostgrest.failures_left = 99
    with pytest.raises(StoreError):
        flaky.count_posts()
    assert FlakyPostgrest.attempts == 1


def test_error_message_does_not_leak_the_response_body(flaky, monkeypatch):
    """StoreError text is rendered straight into somebody's browser.

    Supabase error prose is meaningless to a visitor and is a place where
    internals leak, so it goes to the server log and not into the exception.
    """
    from core.store import StoreError

    monkeypatch.setattr("core.store.RETRY_BACKOFF", 0.001)
    FlakyPostgrest.failures_left = 99
    with pytest.raises(StoreError) as caught:
        flaky.count_posts()
    message = str(caught.value)
    assert "internal detail" not in message
    assert "service unavailable" not in message
