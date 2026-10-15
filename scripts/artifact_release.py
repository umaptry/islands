"""Package only map artifacts; verify a pinned archive before reading any pickle."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core.artifact_manifest import FILES, SEED_VECTORS, validate_manifest

NAMES = (*FILES, "manifest.json")
ALLOWED = (*FILES, SEED_VECTORS)


def names_of(manifest):
    """The files a release carries: those its manifest pins, plus the manifest.
    Only known names: the list comes from inside the archive, and a name such as
    ../x would otherwise be written outside the output directory."""
    pinned = set(FILES) | set(manifest["files"])
    if not pinned <= set(ALLOWED):
        raise RuntimeError("Release manifest pins files a map does not have")
    return (*sorted(pinned), "manifest.json")


def check(directory, provider, version):
    manifest = validate_manifest(directory, provider)
    if manifest["artifact_version"] != version:
        raise RuntimeError("Artifact version differs from the release selection")
    return manifest


def sha256(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def pack(directory, output, provider, version, quality_report=None):
    manifest = check(directory, provider, version)
    if provider == "gemini":
        if not quality_report:
            raise RuntimeError("Gemini release requires --quality-report")
        report = json.loads(Path(quality_report).read_text(encoding="utf-8"))
        candidate = report.get("candidate", {})
        if report.get("passed") is not True or candidate.get("version") != version or candidate.get("manifest_sha256") != sha256(Path(directory) / "manifest.json"):
            raise RuntimeError("Quality report does not approve these exact artifacts")
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in names_of(manifest):
            archive.write(Path(directory) / name, name)
    return sha256(output)


def unpack(source, output, provider, version, expected_sha256):
    if sha256(source) != expected_sha256:
        raise RuntimeError("Release archive checksum mismatch")
    output = Path(output)
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        try:
            names = names_of(json.loads(archive.read("manifest.json")))
        except (KeyError, ValueError) as error:
            raise RuntimeError("Release archive has no readable manifest") from error
        if len(entries) != len(names) or {e.filename for e in entries} != set(names):
            raise RuntimeError("Release archive must contain exactly the files its manifest pins")
        if sum(e.file_size for e in entries) > 256 * 1024 * 1024:
            raise RuntimeError("Release archive exceeds the map size limit")
        output.mkdir(parents=True, exist_ok=False)
        for name in names:
            with (output / name).open("xb") as handle:
                handle.write(archive.read(name))
    return check(output, provider, version)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["pack", "unpack", "check"])
    parser.add_argument("--source", required=True)
    parser.add_argument("--output")
    parser.add_argument("--provider", choices=["onnx", "gemini"], required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--sha256")
    parser.add_argument("--quality-report")
    args = parser.parse_args()
    if args.command == "check":
        check(args.source, args.provider, args.version)
    elif args.command == "pack":
        if not args.output:
            parser.error("pack requires --output")
        print(pack(args.source, args.output, args.provider, args.version, args.quality_report))
    else:
        if not args.output or not args.sha256:
            parser.error("unpack requires --output and --sha256")
        unpack(args.source, args.output, args.provider, args.version, args.sha256)


if __name__ == "__main__":
    main()
