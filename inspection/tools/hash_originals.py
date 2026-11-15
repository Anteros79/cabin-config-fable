"""Read-only SHA-256 inventory of the original baseline files.

Usage: python3 hash_originals.py <original-root> <output-json> [<compare-json>]

Opens the originals strictly for reading. Writes only the output JSON.
"""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

TREES = ("app", "tests")
FILES = ("README.md", "pyproject.toml", "uv.lock")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inventory(root: Path) -> dict[str, dict[str, object]]:
    paths: list[Path] = []
    for tree in TREES:
        paths.extend(p for p in (root / tree).rglob("*") if p.is_file())
    paths.extend(root / name for name in FILES)
    return {
        p.relative_to(root).as_posix(): {"sha256": sha256(p), "bytes": p.stat().st_size}
        for p in sorted(paths)
    }


def main() -> int:
    root = Path(sys.argv[1])
    output = Path(sys.argv[2])
    files = inventory(root)
    record: dict[str, object] = {
        "root": str(root),
        "recorded_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "algorithm": "sha256",
        "scope": [*(f"{tree}/**" for tree in TREES), *FILES],
        "file_count": len(files),
        "files": files,
    }
    if len(sys.argv) > 3:
        before = json.loads(Path(sys.argv[3]).read_text())["files"]
        changed = sorted(k for k in files if k in before and before[k]["sha256"] != files[k]["sha256"])
        record["comparison"] = {
            "against": Path(sys.argv[3]).name,
            "added": sorted(set(files) - set(before)),
            "removed": sorted(set(before) - set(files)),
            "changed": changed,
            "all_unchanged": not changed and set(files) == set(before),
        }
    output.write_text(json.dumps(record, indent=2) + "\n")
    print(f"{len(files)} files hashed -> {output}")
    if "comparison" in record:
        print(json.dumps(record["comparison"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
