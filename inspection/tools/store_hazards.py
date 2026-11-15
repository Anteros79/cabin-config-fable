"""Store-safety and limit checks against the baseline COPY, using disposable files only.

Run with cwd = inspection/baseline-copy and the copy's locked venv:
  .venv/bin/python -B ../tools/store_hazards.py <scratch-dir>

Every database touched lives under <scratch-dir> (inspection/disposable/hazards).
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

SCRATCH = Path(sys.argv[1]).resolve()
if SCRATCH.exists():
    shutil.rmtree(SCRATCH)
SCRATCH.mkdir(parents=True)
os.environ["CABIN_DB_PATH"] = str(SCRATCH / "env-reference.sqlite3")
os.environ["CABIN_VISITS_DB_PATH"] = str(SCRATCH / "env-visits.sqlite3")

from fastapi.testclient import TestClient  # noqa: E402

import app.seed as seed_module  # noqa: E402
from app.main import create_app  # noqa: E402
from app.seed import seed  # noqa: E402
from app.visits import VisitStore  # noqa: E402


def tables(path: Path) -> list[str]:
    with sqlite3.connect(path) as db:
        return sorted(r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'"))


def count(path: Path, table: str) -> str:
    try:
        with sqlite3.connect(path) as db:
            return str(db.execute(f"SELECT count(*) FROM {table}").fetchone()[0])
    except sqlite3.Error as exc:
        return f"ERROR {type(exc).__name__}: {exc}"


def section(title: str) -> None:
    print(f"\n=== {title} ===")


section("A. Seeder default path vs server CABIN_DB_PATH")
print(f"CABIN_DB_PATH (env)            = {os.environ['CABIN_DB_PATH']}")
print(f"app.seed.DEFAULT_DB            = {seed_module.DEFAULT_DB}")
print(f"seed.py reads CABIN_DB_PATH    = {'getenv' in Path(seed_module.__file__).read_text() or 'environ' in Path(seed_module.__file__).read_text()}")
print(f"default data/ dir exists in copy = {seed_module.DEFAULT_DB.parent.exists()}")
print("-> `python -m app.seed` without --db always targets <root>/data/reference.sqlite3, even when the server is")
print("   pointed elsewhere by CABIN_DB_PATH; the two only agree when neither is overridden or --db repeats the env value.")

section("B. Server with a reference path that was never seeded")
missing = SCRATCH / "never-seeded.sqlite3"
with TestClient(create_app(missing, SCRATCH / "b-visits.sqlite3")) as client:
    for method, url, body in [
        ("GET", "/api/health", None),
        ("GET", "/api/lookup?tail=N100TL&check_date=2026-11-12", None),
        ("POST", "/api/visits", {"tail": "N100TL", "check_date": "2026-11-12"}),
        ("GET", "/api/visits", None),
    ]:
        r = client.request(method, url, json=body)
        print(f"{method} {url} -> {r.status_code} {r.text[:110]}")
print(f"reference file created by the server = {missing.exists()}")

section("C. Reference and visit store configured as the SAME file, then seed --reset")
shared = SCRATCH / "shared.sqlite3"
seed(shared)
with TestClient(create_app(shared, shared)) as client:
    v = client.post("/api/visits", json={"tail": "N100TL", "check_date": "2026-11-12", "technician": "Shared"}).json()
    r = client.put(f"/api/visits/{v['id']}/replacements", json={"location": "3A", "rule_id": "R-V01-P-ELR-A-CUSHION"})
    print(f"app start + create visit + record replacement on shared file -> {r.status_code}")
print(f"tables before reset: {tables(shared)}")
print(f"visits before reset = {count(shared, 'visits')}, replacements before reset = {count(shared, 'replacements')}")
cli = subprocess.run(
    [sys.executable, "-B", "-m", "app.seed", "--db", str(shared), "--reset"], capture_output=True, text=True
)
print(f"$ python -m app.seed --db <shared> --reset -> exit {cli.returncode}")
print(f"  stdout: {cli.stdout.strip().replace(str(SCRATCH), '<scratch>')}")
print(f"tables after reset: {tables(shared)}")
print(f"visits after reset = {count(shared, 'visits')}")
print("-> the marker check passes (metadata.dataset is present), the file is atomically replaced and the visit history")
print("   is destroyed while the CLI prints 'Visit history was not changed.'")

section("D. What --reset refuses, and how")
visits_only = SCRATCH / "visits-only.sqlite3"
VisitStore(visits_only).initialize()
not_sqlite = SCRATCH / "notes.txt"
not_sqlite.write_text("not a database\n" * 200)
foreign = SCRATCH / "foreign-with-marker.sqlite3"
with sqlite3.connect(foreign) as db:
    db.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    db.execute("INSERT INTO metadata VALUES ('dataset','fictional-cabin-kit')")
    db.execute("CREATE TABLE precious (note TEXT)")
    db.execute("INSERT INTO precious VALUES ('unrelated data that merely carries the marker row')")
for label, path in [("visits-only DB", visits_only), ("non-SQLite file", not_sqlite), ("foreign DB carrying the marker row", foreign)]:
    try:
        seed(path, reset=True)
        outcome = f"OVERWRITTEN; tables now {tables(path)[:4]}…"
    except Exception as exc:  # noqa: BLE001 - recording whatever the baseline raises
        outcome = f"refused via {type(exc).__name__}: {exc}"
    print(f"--reset on {label}: {outcome}")
leftovers = sorted(p.name for p in SCRATCH.glob("*.tmp"))
print(f"temporary files left behind = {leftovers}")

section("E. History listing cap")
ref = SCRATCH / "e-reference.sqlite3"
seed(ref)
e_visits = SCRATCH / "e-visits.sqlite3"
with TestClient(create_app(ref, e_visits)) as client:
    ids = [client.post("/api/visits", json={"tail": "N100TL", "check_date": "2026-11-12"}).json()["id"] for _ in range(105)]
    listed = client.get("/api/visits").json()
    oldest = client.get(f"/api/visits/{ids[0]}")
    print(f"visits created = {len(ids)}; GET /api/visits returned = {len(listed)}; rows in table = {count(e_visits, 'visits')}")
    print(f"oldest visit present in listing = {ids[0] in {row['id'] for row in listed}}; still fetchable by id = {oldest.status_code}")
    print(f"listing query parameters accepted (limit/offset/status/tail) = none; store file size = {e_visits.stat().st_size} bytes")

section("F. Writer blocked by another connection holding the write lock")
with TestClient(create_app(ref, e_visits)) as client:
    blocker = sqlite3.connect(e_visits, timeout=1)
    blocker.execute("BEGIN IMMEDIATE")
    started = time.monotonic()
    r = client.put(f"/api/visits/{ids[-1]}/replacements", json={"location": "3A", "rule_id": "R-V01-P-ELR-A-CUSHION"})
    waited = time.monotonic() - started
    blocker.rollback()
    blocker.close()
    print(f"PUT while locked -> {r.status_code} after {waited:.1f}s: {r.text}")
    with sqlite3.connect(e_visits) as db:
        print(f"journal_mode = {db.execute('PRAGMA journal_mode').fetchone()[0]}")

section("G. Lost update between two editors of one draft (no version / precondition)")
with TestClient(create_app(ref, e_visits)) as client:
    vid = ids[-1]
    url = f"/api/visits/{vid}/replacements"
    a_view = client.get(f"/api/visits/{vid}").json()
    b_view = client.get(f"/api/visits/{vid}").json()
    ra = client.put(url, json={"location": "3A", "rule_id": "R-V01-P-ELR-A-CUSHION", "note": "editor A"})
    rb = client.put(url, json={"location": "3A", "rule_id": "R-V01-P-ELR-A-CUSHION", "note": "editor B, unaware of A"})
    final = client.get(f"/api/visits/{vid}").json()
    print(f"both editors loaded the draft with {len(a_view['replacements'])}/{len(b_view['replacements'])} items; PUT A -> {ra.status_code}, PUT B -> {rb.status_code}")
    print(f"stored note = {final['replacements'][0]['note']!r}; version/etag fields on visit = {[k for k in final if 'version' in k or 'etag' in k]}")
    print(f"ETag header on GET = {client.get(f'/api/visits/{vid}').headers.get('etag')}")

print("\nstore hazard checks finished")
