"""Create a private logical backup of the Supabase data used by islands.

The service key is accepted only through the environment. Backup contents are
written below an ignored output directory and are never printed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


TABLES = (
    "accounts",
    "posts",
    "reactions",
    "comments",
    "notifications",
    "reports",
    "energy_cells",
    "map_runtime",
    "embedding_cache",
)
OPTIONAL_TABLES = {"map_runtime", "embedding_cache"}


class SupabaseBackup:
    def __init__(self, url: str, service_key: str, destination: Path):
        self.url = url.rstrip("/")
        self.service_key = service_key
        self.destination = destination
        self.files: list[dict[str, object]] = []

    def request(self, method: str, path: str, *, body: object | None = None,
                headers: dict[str, str] | None = None) -> tuple[bytes, dict[str, str]]:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        request_headers = {
            "apikey": self.service_key,
            "Authorization": f"Bearer {self.service_key}",
        }
        if payload is not None:
            request_headers["Content-Type"] = "application/json"
        request_headers.update(headers or {})
        request = Request(self.url + path, data=payload, headers=request_headers, method=method)
        with urlopen(request, timeout=120) as response:
            return response.read(), dict(response.headers.items())

    def save(self, relative: str, data: bytes) -> None:
        target = self.destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        self.files.append({
            "path": relative.replace("\\", "/"),
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        })

    def table(self, name: str) -> int | None:
        rows: list[object] = []
        offset = 0
        while True:
            try:
                data, _ = self.request(
                    "GET", f"/rest/v1/{quote(name)}?select=*",
                    headers={"Range": f"{offset}-{offset + 999}", "Prefer": "count=exact"},
                )
            except HTTPError as exc:
                if name in OPTIONAL_TABLES and exc.code == 404:
                    return None
                raise
            page = json.loads(data)
            rows.extend(page)
            if len(page) < 1000:
                break
            offset += len(page)
        self.save(f"database/{name}.json", json.dumps(rows, ensure_ascii=False, indent=2).encode("utf-8"))
        return len(rows)

    def auth_users(self) -> int:
        users: list[object] = []
        page = 1
        while True:
            data, _ = self.request("GET", f"/auth/v1/admin/users?page={page}&per_page=1000")
            result = json.loads(data)
            current = result.get("users", result if isinstance(result, list) else [])
            users.extend(current)
            if len(current) < 1000:
                break
            page += 1
        self.save("auth/users.json", json.dumps(users, ensure_ascii=False, indent=2).encode("utf-8"))
        return len(users)

    def list_folder(self, bucket: str, prefix: str = "") -> list[str]:
        files: list[str] = []
        offset = 0
        while True:
            data, _ = self.request(
                "POST", f"/storage/v1/object/list/{quote(bucket, safe='')}",
                body={"prefix": prefix, "limit": 1000, "offset": offset, "sortBy": {"column": "name", "order": "asc"}},
            )
            page = json.loads(data)
            for item in page:
                name = item["name"]
                full_name = f"{prefix}/{name}" if prefix else name
                if item.get("id"):
                    files.append(full_name)
                else:
                    files.extend(self.list_folder(bucket, full_name))
            if len(page) < 1000:
                break
            offset += len(page)
        return files

    @staticmethod
    def safe_object_path(name: str) -> Path:
        parsed = PurePosixPath(name)
        if parsed.is_absolute() or ".." in parsed.parts:
            raise ValueError(f"Unsafe Storage object name: {name!r}")
        return Path(*parsed.parts)

    def storage(self) -> tuple[int, int]:
        data, _ = self.request("GET", "/storage/v1/bucket")
        buckets = json.loads(data)
        self.save("storage/buckets.json", json.dumps(buckets, ensure_ascii=False, indent=2).encode("utf-8"))
        object_count = 0
        for bucket in buckets:
            bucket_id = bucket["id"]
            names = self.list_folder(bucket_id)
            for name in names:
                data, _ = self.request(
                    "GET",
                    f"/storage/v1/object/authenticated/{quote(bucket_id, safe='')}/{quote(name, safe='/')}",
                )
                relative = Path("storage", "objects", bucket_id) / self.safe_object_path(name)
                self.save(relative.as_posix(), data)
                object_count += 1
        return len(buckets), object_count

    def run(self) -> dict[str, object]:
        table_counts = {name: self.table(name) for name in TABLES}
        auth_count = self.auth_users()
        bucket_count, object_count = self.storage()
        manifest = {
            "created_at": datetime.now(timezone.utc).isoformat(),
            "project_ref": self.url.removeprefix("https://").split(".", 1)[0],
            "table_counts": table_counts,
            "auth_users": auth_count,
            "storage_buckets": bucket_count,
            "storage_objects": object_count,
            "files": sorted(self.files, key=lambda item: str(item["path"])),
        }
        self.save("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"))
        return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    url = os.environ.get("SUPABASE_URL", "")
    service_key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not service_key:
        raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_KEY are required")
    if args.output.exists() and any(args.output.iterdir()):
        raise SystemExit(f"Refusing to overwrite non-empty backup: {args.output}")
    manifest = SupabaseBackup(url, service_key, args.output).run()
    print(json.dumps({
        "output": str(args.output),
        "table_counts": manifest["table_counts"],
        "auth_users": manifest["auth_users"],
        "storage_buckets": manifest["storage_buckets"],
        "storage_objects": manifest["storage_objects"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
