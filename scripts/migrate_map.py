"""Prepare, apply and roll back a versioned map without changing post identities.

All files contain private vectors/text: keep them outside git and build contexts.
Supabase service credentials are read only from environment variables.
"""
import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core.store import SupabaseStore


def connect():
    return SupabaseStore(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])


def read_posts(store):
    rows, last = [], None
    while True:
        params = {"select": "id,body,x,y,cluster_id,terms,vec,vec_c,updated_at", "deleted_at": "is.null",
                  "order": "id", "limit": "1000"}
        if last:
            params["id"] = f"gt.{last}"
        batch = store._get("posts", params)
        rows.extend(batch)
        if len(batch) < 1000:
            return rows
        last = batch[-1]["id"]


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)


def prepare(args):
    import app
    from core.embedder import load_embedder
    from core.embedding_cache import CachedEmbedder
    store = connect()
    runtime = store.runtime_status()
    if runtime["maintenance"]:
        raise RuntimeError("Prepare before maintenance, then validate again at apply")
    app.state.update(app.load_artifacts())
    app.state["store"] = store
    app.state["local_mode"] = False
    app.state["model"] = CachedEmbedder(load_embedder(), store, app.state["manifest"]["embedding"])
    old = read_posts(store)
    write(args.backup, {"version": runtime["active_version"], "rows": old})
    new = []
    for row in old:
        x, y, cluster, terms, vec, vec_c = app.project(row["body"])
        new.append({**row, "x": x, "y": y, "cluster_id": cluster, "terms": terms,
                    "vec": app.as_pgvector(vec), "vec_c": app.as_pgvector(vec_c)})
    write(args.output, {"expected_version": runtime["active_version"],
                       "next_version": app.state["manifest"]["artifact_version"], "rows": new})
    print(f"Prepared {len(new)} posts; live map is unchanged.")


def maintenance(args):
    store = connect()
    store._send("PATCH", "map_runtime", label="メンテナンス切替", params={"singleton": "eq.true"},
                json={"maintenance": args.state == "on"})
    print(json.dumps(store.runtime_status()))


def apply(args):
    data = json.loads(Path(args.input).read_text(encoding="utf-8"))
    store = connect()
    if not args.execute:
        current = read_posts(store)
        expected = {r["id"]: (r["body"], r["updated_at"]) for r in data["rows"]}
        actual = {r["id"]: (r["body"], r["updated_at"]) for r in current}
        if expected != actual:
            raise RuntimeError("Posts changed since preparation; prepare a new snapshot")
        print(f"Dry run: {len(current)} posts match. No writes performed.")
        return
    result = store._rpc("apply_map_version", data, label="地図切替")
    print(f"Applied {result} posts. Maintenance remains ON; verify candidate before reopening.")


def rollback(args):
    backup = json.loads(Path(args.backup).read_text(encoding="utf-8"))
    store = connect()
    runtime = store.runtime_status()
    if not runtime["maintenance"]:
        raise RuntimeError("Enable maintenance before preparing rollback")
    current = {row["id"]: row for row in read_posts(store)}
    if args.reproject:
        import app
        from core.embedder import load_embedder
        from core.embedding_cache import CachedEmbedder
        app.state.update(app.load_artifacts())
        if app.state["manifest"]["artifact_version"] != backup["version"]:
            raise RuntimeError("Rollback artifacts must match the backup version")
        model = load_embedder()
        if app.state["manifest"]["embedding"]["provider"] == "gemini":
            model = CachedEmbedder(model, store, app.state["manifest"]["embedding"])
        app.state["model"] = model
        rows = []
        for live in current.values():
            x, y, cluster, terms, vec, vec_c = app.project(live["body"])
            rows.append({**live, "x": x, "y": y, "cluster_id": cluster, "terms": terms,
                         "vec": app.as_pgvector(vec), "vec_c": app.as_pgvector(vec_c)})
        write(args.output, {"expected_version": runtime["active_version"], "next_version": backup["version"], "rows": rows})
        print("Current posts reprojected with rollback artifacts. No live posts changed.")
        return
    if set(current) != {row["id"] for row in backup["rows"]}:
        raise RuntimeError("Post set changed after release; rollback needs a fresh old-model projection")
    rows = []
    for row in backup["rows"]:
        live = current[row["id"]]
        if live["body"] != row["body"]:
            raise RuntimeError("Post body changed after release; refusing to restore stale coordinates")
        rows.append({**row, "updated_at": live["updated_at"]})
    write(args.output, {"expected_version": runtime["active_version"], "next_version": backup["version"], "rows": rows})
    print("Rollback prepared. Apply this file, then route traffic to the matching old revision.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--backup", required=True); p.add_argument("--output", required=True)
    p.set_defaults(run=prepare)
    p = sub.add_parser("maintenance"); p.add_argument("state", choices=["on", "off"]); p.set_defaults(run=maintenance)
    p = sub.add_parser("apply"); p.add_argument("--input", required=True); p.add_argument("--execute", action="store_true"); p.set_defaults(run=apply)
    p = sub.add_parser("rollback"); p.add_argument("--backup", required=True); p.add_argument("--output", required=True)
    p.add_argument("--reproject", action="store_true", help="Reproject all current posts using the backup artifact version")
    p.set_defaults(run=rollback)
    args = parser.parse_args(); args.run(args)


if __name__ == "__main__":
    main()
