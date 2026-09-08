"""Validate the exact release contract; maintenance candidates never promote."""
import argparse
import json
from pathlib import Path
import sys
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core.artifact_manifest import embedding_spec


def validate(health, config, provider, version, supabase_url, phase="ready"):
    errors = []
    if phase not in ("ready", "pre-migration", "maintenance"):
        raise ValueError("Unknown verification phase")
    spec = embedding_spec(provider)
    for name, expected in (("store", "supabase"), ("store_ok", True), ("artifact_version", version)):
        if health.get(name) != expected:
            errors.append(f"health.{name} mismatch")
    if health.get("embedding") != spec:
        errors.append("health.embedding mismatch")
    if config.get("mode") != "supabase" or config.get("map_version") != version:
        errors.append("config mode/version mismatch")
    public = config.get("supabase") or {}
    if public.get("url") != supabase_url or not public.get("anon_key"):
        errors.append("public Supabase configuration mismatch")
    if phase != "pre-migration":
        if health.get("active_map_version") != version or health.get("artifact_compatible") is not True:
            errors.append("DB and artifact versions mismatch")
        maintenance = phase == "maintenance"
        if health.get("maintenance") is not maintenance or health.get("ready") is not (not maintenance):
            errors.append("unexpected maintenance/readiness state")
    if errors:
        raise RuntimeError("; ".join(errors))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--provider", required=True, choices=["onnx", "gemini"])
    parser.add_argument("--version", required=True)
    parser.add_argument("--supabase-url", required=True)
    parser.add_argument("--phase", default="ready", choices=["ready", "pre-migration", "maintenance"])
    args = parser.parse_args()
    base = args.url.rstrip("/")
    def fetch(path):
        with urlopen(base + path, timeout=120) as response:
            return json.load(response)
    validate(fetch("/api/health"), fetch("/api/config"), args.provider, args.version, args.supabase_url, args.phase)
    for path in ("/", "/how", "/static/style.css", "/static/js/app.js"):
        with urlopen(base + path, timeout=30) as response:
            if response.status != 200:
                raise RuntimeError(f"Static endpoint failed: {path}")
    print(f"Verified {args.provider}/{args.version} phase={args.phase}")


if __name__ == "__main__":
    main()
