import copy
import json
from types import SimpleNamespace
import zipfile

import pytest

from core.artifact_manifest import embedding_spec
from scripts import artifact_release, migrate_map, verify_release


def test_archive_pins_version_hash_and_exact_files(tmp_path):
    archive = tmp_path / "map.zip"
    sha = artifact_release.pack("artifacts", archive, "onnx", "kotoba-map-v1")
    manifest = artifact_release.unpack(archive, tmp_path / "map", "onnx", "kotoba-map-v1", sha)
    assert manifest["artifact_version"] == "kotoba-map-v1"
    with pytest.raises(RuntimeError, match="checksum"):
        artifact_release.unpack(archive, tmp_path / "bad", "onnx", "kotoba-map-v1", "0" * 64)
    with zipfile.ZipFile(archive, "a") as handle:
        handle.writestr("../private-posts.json", "private")
    with pytest.raises(RuntimeError, match="exactly four"):
        artifact_release.unpack(archive, tmp_path / "extra", "onnx", "kotoba-map-v1", artifact_release.sha256(archive))
    assert not (tmp_path / "private-posts.json").exists()


def contract():
    health = {"store": "supabase", "store_ok": True, "embedding": embedding_spec("gemini"),
              "artifact_version": "gemini-v1", "active_map_version": "gemini-v1",
              "artifact_compatible": True, "maintenance": False, "ready": True}
    config = {"mode": "supabase", "map_version": "gemini-v1", "supabase": {"url": "https://test.supabase.co", "anon_key": "public"}}
    return health, config


def test_candidate_requires_matching_db_before_promotion():
    health, config = contract()
    def check(phase):
        verify_release.validate(health, config, "gemini", "gemini-v1", "https://test.supabase.co", phase)
    check("ready")
    health.update(active_map_version="e5", artifact_compatible=False, ready=False)
    check("pre-migration")
    with pytest.raises(RuntimeError):
        check("ready")
    with pytest.raises(RuntimeError):
        check("maintenance")
    health.update(active_map_version="gemini-v1", artifact_compatible=True, maintenance=True)
    check("maintenance")
    with pytest.raises(RuntimeError):
        check("ready")
    health["embedding"]["model"] = "different-model"
    with pytest.raises(RuntimeError, match="embedding"):
        check("pre-migration")


@pytest.mark.parametrize("change", ["insert", "edit", "delete", "version", "duplicate"])
def test_migration_dry_run_rejects_stale_snapshots(tmp_path, monkeypatch, change):
    row = {"id": "one", "body": "original", "updated_at": "time"}
    rows = [copy.deepcopy(row)]
    version = "e5"
    data = {"expected_version": version, "next_version": "gemini", "rows": [row]}
    if change == "insert": rows.append({**row, "id": "two"})
    if change == "delete": rows.clear()
    if change == "edit": rows[0]["body"] = "edited"
    if change == "version": version = "new"
    if change == "duplicate": data["rows"].append(row)
    class Store:
        def runtime_status(self): return {"active_version": version}
        def _rpc(self, *args, **kwargs): pytest.fail("dry run must not write")
    monkeypatch.setattr(migrate_map, "connect", Store)
    monkeypatch.setattr(migrate_map, "read_posts", lambda _: rows)
    source = tmp_path / "snapshot.json"
    source.write_text(json.dumps(data))
    with pytest.raises(RuntimeError):
        migrate_map.apply(SimpleNamespace(input=source, execute=False))


def test_pacing_reserves_batch_budget_and_respects_deadline(monkeypatch):
    from core import embedder
    now = [0.0]
    monkeypatch.setattr(embedder.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(embedder.time, "sleep", lambda seconds: now.__setitem__(0, now[0] + seconds))
    pacer = embedder.RequestPacer(60, 60)
    pacer.take(20, 45)
    pacer.take(20, 45)
    assert now[0] == 20
    with pytest.raises(embedder.EmbeddingUnavailable):
        pacer.take(20, 30)


def test_rollback_keeps_current_timestamp_and_refuses_new_posts(tmp_path, monkeypatch):
    before = {"id": "one", "body": "unchanged", "updated_at": "old", "x": 1, "y": 2}
    current = [{**before, "updated_at": "new", "x": 100, "y": 200}]
    class Store:
        def runtime_status(self): return {"active_version": "gemini", "maintenance": True}
    monkeypatch.setattr(migrate_map, "connect", Store)
    monkeypatch.setattr(migrate_map, "read_posts", lambda _: current)
    backup = tmp_path / "backup.json"
    backup.write_text(json.dumps({"version": "e5", "rows": [before]}))
    output = tmp_path / "rollback.json"
    args = SimpleNamespace(backup=backup, output=output, reproject=False)
    migrate_map.rollback(args)
    result = json.loads(output.read_text())
    assert result["rows"] == [{**before, "updated_at": "new"}]
    assert result["expected_version"] == "gemini"
    current.append({**before, "id": "new-post"})
    with pytest.raises(RuntimeError, match="Post set changed"):
        migrate_map.rollback(args)


def test_reproject_rollback_uses_current_bodies_and_ids(tmp_path, monkeypatch):
    import sys
    from core import embedder
    rows = [{"id": "new-post", "body": "new body", "updated_at": "now"}]
    class Store:
        def runtime_status(self): return {"active_version": "gemini", "maintenance": True}
    monkeypatch.setattr(migrate_map, "connect", Store)
    monkeypatch.setattr(migrate_map, "read_posts", lambda _: rows)
    seen = []
    def project(body):
        seen.append(body)
        return (1, 2, 0, [], [1], [1])
    fake_app = SimpleNamespace(state={}, load_artifacts=lambda: {"manifest": {
        "artifact_version": "e5", "embedding": {"provider": "onnx"}}}, project=project, as_pgvector=json.dumps)
    monkeypatch.setitem(sys.modules, "app", fake_app)
    monkeypatch.setattr(embedder, "load_embedder", lambda: object())
    backup = tmp_path / "backup.json"
    backup.write_text(json.dumps({"version": "e5", "rows": []}))
    output = tmp_path / "rollback.json"
    migrate_map.rollback(SimpleNamespace(backup=backup, output=output, reproject=True))
    result = json.loads(output.read_text())
    assert seen == ["new body"]
    assert result["rows"][0]["id"] == "new-post"
    assert result["rows"][0]["body"] == "new body"


def test_daily_quota_stops_without_retry_or_provider_details():
    import httpx
    from core.embedder import GeminiEmbedder, EmbeddingDailyQuotaExceeded
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(429, json={"error": {"message": "private provider detail", "details": [
            {"violations": [{"quotaId": "EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier"}]}]}})
    model = GeminiEmbedder("test-key")
    model._http.close()
    model._http = httpx.Client(transport=httpx.MockTransport(respond))
    with pytest.raises(EmbeddingDailyQuotaExceeded) as error:
        model.encode(["synthetic"])
    assert len(calls) == 1
    assert "private" not in str(error.value)
