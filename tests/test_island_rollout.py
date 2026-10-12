"""Rolling the 2026-10-12 change out safely (2026-10-12).

  * new code against a database that has not had the migration yet
  * /api/health says "not ready" for that, and why
  * quiet_post follows the island category in the app
  * /api/islands tells the screen where a name came from
"""

import json

import pytest

from conftest import CAMPING_A
from core import notifications as notices
from core.store import ISLAND_NAME_COLUMNS, SupabaseStore


# -- a database without the columns ----------------------------------------

class Resp:
    def __init__(self, status, payload=None, text=None):
        self.status_code = status
        self._payload = payload
        self.text = text if text is not None else json.dumps(payload)

    def json(self):
        return self._payload


class FakeClient:
    """Stands in for httpx.Client. `has_columns` decides whether the migration was run."""

    def __init__(self, has_columns, error=None):
        self.has_columns = has_columns
        self.error = error or {"code": "42703", "message": "column islands_state.name_source does not exist"}
        self.requests = []
        self.rows = []

    def request(self, method, url, headers=None, params=None, json=None):
        self.requests.append((method, params, json))
        if method == "GET":
            select = (params or {}).get("select", "")
            if not self.has_columns and any(name in select for name in ISLAND_NAME_COLUMNS):
                return Resp(400, self.error)
            return Resp(200, [dict(row) for row in self.rows])
        if not self.has_columns and any(name in row for row in json for name in ISLAND_NAME_COLUMNS):
            return Resp(400, {"code": "PGRST204", "message": "Could not find the 'name_source' column"})
        self.rows.extend(json)
        return Resp(201, [])


def store_with(client):
    store = SupabaseStore("http://example.test", "key")
    store._client = client
    return store


@pytest.mark.parametrize("error", [
    {"code": "42703", "message": "column islands_state.name_source does not exist"},
    {"code": "PGRST204", "message": "Could not find the 'name_basis' column"},
])
def test_reading_without_the_columns_falls_back_and_remembers(error):
    client = FakeClient(has_columns=False, error=error)
    client.rows = [{"id": "1", "name": "山"}]
    store = store_with(client)
    assert store.supports_island_names is True
    assert store.island_states() == [{"id": "1", "name": "山"}]
    assert store.supports_island_names is False
    first_reads = len(client.requests)
    store.island_states()
    assert len(client.requests) == first_reads + 1, "after the fallback, one plain read"
    for name in ISLAND_NAME_COLUMNS:
        assert name not in client.requests[-1][1]["select"]


@pytest.mark.parametrize("error", [
    {"code": "23514", "message": 'violates check constraint "islands_state_name_source_check"'},
    {"code": "PGRST100", "message": "failed to parse filter on name_source"},
    {"code": "42703", "message": "column islands_state.other_thing does not exist"},
])
def test_other_400s_do_not_count_as_missing_columns(error):
    from core.store import StoreError
    client = FakeClient(has_columns=True)
    client.request = lambda *a, **k: Resp(400, error)
    store = store_with(client)
    with pytest.raises(StoreError):
        store.island_states()
    assert store.supports_island_names is True


def test_an_instance_without_the_columns_reads_everything_again_after_a_minute(monkeypatch):
    import core.store as store_module
    client = FakeClient(has_columns=False)
    client.rows = [{"id": "1", "name": "山"}]
    store = store_with(client)
    store.island_states()
    assert store.supports_island_names is False
    client.has_columns = True                       # the SQL was run in the meantime
    store.island_states()
    assert store.supports_island_names is False, "not before the interval"
    monkeypatch.setattr(store_module, "NAME_COLUMNS_CHECK_SECONDS", 0)
    store.island_states()
    assert store.supports_island_names is True
    assert "name_source" in client.requests[-1][1]["select"]


def test_saving_does_not_send_the_new_columns_once_they_are_missing():
    client = FakeClient(has_columns=False)
    store = store_with(client)
    store.island_states()
    row = {"id": "1", "name": "山", "name_source": "ai", "name_basis": ["a"], "name_tried_at": "t",
           "tier": 0}
    assert store.save_island_states([row]) == 1
    sent = client.requests[-1][2][0]
    assert sent["name"] == "山" and not any(name in sent for name in ISLAND_NAME_COLUMNS)


def test_saving_first_still_works_when_the_columns_turn_out_missing():
    client = FakeClient(has_columns=False)
    store = store_with(client)
    row = {"id": "1", "name": "山", "name_source": "ai", "name_basis": ["a"]}
    assert store.save_island_states([row]) == 1
    assert store.supports_island_names is False and client.rows[0]["name"] == "山"
    assert "name_source" not in client.rows[0]


def test_with_the_columns_everything_is_sent_and_read():
    client = FakeClient(has_columns=True)
    store = store_with(client)
    store.save_island_states([{"id": "1", "name": "山", "name_source": "ai", "name_basis": ["a"]}])
    assert client.rows[0]["name_source"] == "ai"
    store.island_states()
    assert "name_source" in client.requests[-1][1]["select"] and store.supports_island_names is True


def test_other_400s_are_still_errors():
    from core.store import StoreError
    client = FakeClient(has_columns=True)
    client.request = lambda *a, **k: Resp(400, {"code": "22P02", "message": "bad uuid"})
    with pytest.raises(StoreError):
        store_with(client).island_states()


def test_island_names_ready_reports_and_recovers(monkeypatch):
    import core.store as store_module
    client = FakeClient(has_columns=False)
    store = store_with(client)
    assert store.island_names_ready() is False
    count = len(client.requests)
    assert store.island_names_ready() is False and len(client.requests) == count, "cached"
    client.has_columns = True                     # the SQL was run in the meantime
    monkeypatch.setattr(store_module, "NAME_COLUMNS_CHECK_SECONDS", 0)
    assert store.island_names_ready() is True and store.supports_island_names is True


def test_ai_naming_is_off_when_the_store_has_no_columns(people, fresh_client, monkeypatch):
    import app as application

    class Namer:
        def name(self, *args, **kwargs):
            raise AssertionError("must not be asked")

    monkeypatch.setitem(application.state, "island_namer", Namer())
    monkeypatch.setattr(application.state["store"], "supports_island_names", False, raising=False)
    islands = [{"name": "山", "label": "山島", "post_ids": list("abcdefg"),
                "author_ids": ["x", "y", "z"], "size": 7}]
    assert application.name_islands_with_ai(islands, [], {}) == 0


# -- /api/health -------------------------------------------------------------

def test_health_is_ready_locally(client):
    body = client.get("/api/health").json()
    assert body["ready"] is True and body["island_names_ready"] is True
    assert body["not_ready_reasons"] == []


def test_health_is_not_ready_without_the_columns_and_says_why(client, monkeypatch):
    import app as application
    monkeypatch.setattr(application.state["store"], "island_names_ready", lambda: False, raising=False)
    body = client.get("/api/health").json()
    assert body["ready"] is False and body["island_names_ready"] is False
    assert any("name_source" in reason for reason in body["not_ready_reasons"])


def test_the_release_check_stops_a_release_that_is_not_ready():
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
    from verify_release import validate
    from core.artifact_manifest import embedding_spec

    health = {"store": "supabase", "store_ok": True, "artifact_version": "e5",
              "embedding": embedding_spec("onnx"), "active_map_version": "e5",
              "artifact_compatible": True, "maintenance": False, "ready": False,
              "not_ready_reasons": ["islands_state.name_source is missing"]}
    with pytest.raises(RuntimeError, match="readiness.*name_source"):
        validate(health, {"mode": "supabase", "map_version": "e5",
                          "supabase": {"url": "https://x", "anon_key": "k"}}, "onnx", "e5", "https://x")


# -- quiet_post --------------------------------------------------------------

def row(category, push=True, in_app=True):
    return {"category": category, "push": push, "in_app": in_app}


def test_quiet_post_follows_the_island_in_app_switch():
    assert notices.allows(notices.merge_settings([]), "quiet_post", "in_app") is True
    off = notices.merge_settings([row("island", in_app=False)])
    assert notices.allows(off, "quiet_post", "in_app") is False
    push_off = notices.merge_settings([row("island", push=False, in_app=True)])
    assert notices.allows(push_off, "quiet_post", "in_app") is True


def test_quiet_post_is_never_pushed():
    assert notices.allows(notices.merge_settings([]), "quiet_post", "push") is False


def test_quiet_post_stays_off_for_someone_who_switched_similar_in_app_off():
    legacy = notices.merge_settings([row("similar", in_app=False)])
    assert notices.allows(legacy, "quiet_post", "in_app") is False
    assert legacy.quiet_post is False and legacy["island"]["in_app"] is True
    # island itself is unaffected, and so are the other kinds
    assert notices.allows(legacy, "island", "in_app") is True
    assert notices.allows(legacy, "like", "in_app") is True
    # turning island off and on again does not bring it back
    back = notices.merge_settings([row("similar", in_app=False), row("island", in_app=True)])
    assert notices.allows(back, "quiet_post", "in_app") is False


def test_similar_with_in_app_on_or_push_off_only_does_not_block_quiet_post():
    assert notices.allows(notices.merge_settings([row("similar", push=False, in_app=True)]),
                          "quiet_post", "in_app") is True


def test_old_similar_and_connection_rows_never_interrupt_whatever_the_stored_row_says():
    settings = notices.merge_settings([row("similar", in_app=False)])
    assert notices.allows(settings, "similar", "in_app") is False
    assert notices.allows(settings, "connection", "in_app") is False


def test_old_connection_and_similar_rows_are_never_pushed():
    settings = notices.merge_settings([])
    for kind in ("connection", "similar"):
        assert notices.allows(settings, kind, "push") is False
        assert notices.allows(settings, kind, "in_app") is False  # still listed, never interrupts
    assert notices.allows(settings, "like", "push") is True


def test_the_settings_api_shows_the_derived_quiet_post_flag(people, fresh_client):
    akari = people("a@example.com", "あかり")
    shown = fresh_client.get("/api/notification-settings", headers=akari.headers).json()
    assert shown["quiet_post"] is True and shown["settings"]["island"] == {"push": True, "in_app": True}
    assert shown["categories"] == ["reply", "reaction", "island"]
    # a screen that saves what it was shown (extra field included) changes nothing
    fresh_client.put("/api/notification-settings", headers=akari.headers, json={"settings": [
        {"category": "island", "push": True, "in_app": False}]})
    shown = fresh_client.get("/api/notification-settings", headers=akari.headers).json()
    assert shown["settings"]["island"] == {"push": True, "in_app": False} and shown["quiet_post"] is False


# -- /api/islands ------------------------------------------------------------

def test_islands_carry_name_source_and_hide_the_bookkeeping(people, fresh_client, monkeypatch):
    import app as application
    folks = [people(f"{n}@example.com", n) for n in ("あかり", "いつき", "うみ")]
    ids = [folks[i % 3].post(f"{CAMPING_A} その{i}")["id"] for i in range(6)]
    live = [{"name": "山 / 火", "label": "山 / 火島", "cx": 0.2, "cy": 0.5, "size": 6, "energy": 0,
             "cluster_id": 0, "post_ids": ids}]
    monkeypatch.setattr(application, "live_islands", lambda force=False: live)
    [first] = fresh_client.get("/api/islands").json()["islands"]
    assert first["name_source"] == "terms" and "name_basis" not in first and "name_tried_at" not in first

    live[0].update(name="キャンプ", name_source="ai", name_basis=ids, name_tried_at="2026-10-12T00:00:00+00:00")
    [second] = fresh_client.get("/api/islands").json()["islands"]
    assert second["name_source"] == "ai" and "name_basis" not in second

    live[0].update(name="手書き", name_source="manual")
    [third] = fresh_client.get("/api/islands").json()["islands"]
    assert third["name_source"] == "manual"
