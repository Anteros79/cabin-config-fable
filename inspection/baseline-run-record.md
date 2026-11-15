# Baseline run record

Everything below was executed in **this** inspection run on **2026-11-14, 20:25–20:40 CST (UTC−06:00)**.
Nothing here is carried over from the baseline's README, earlier sessions or anyone else's notes. Where a
statement comes from reading code rather than executing it, it is marked "(read, not run)".

- Original baseline (read-only, never executed): `/Users/joe/DevProjects/Cabin Config/cabin-config/`
- Working copy (everything was run here): `inspection/baseline-copy/`
- Disposable stores: `inspection/disposable/`
- Logs: `inspection/logs/` · helper scripts written for this run: `inspection/tools/`

## 1. Integrity of the originals

| Step | Time | File | Result |
| --- | --- | --- | --- |
| Hash before | 20:25:07 | `baseline-original-sha256.json` | 23 files (`app/**`, `tests/**`, `README.md`, `pyproject.toml`, `uv.lock`) |
| Hash after | 20:40:17, after all tests, probes and both documents were written (an earlier pass at 20:34:02 gave the same result) | `baseline-original-sha256-after.json` | **all 23 SHA-256 values unchanged**; nothing added, nothing removed |

Also checked after the run: no `data/`, `artifacts/`, `.venv`, cache, `__pycache__`, `.pyc` or `.sqlite3` appeared
in the original; directory mtimes of the original `app/`, `tests/` are still 2026-11-13. The 23 source files in
the copy are still byte-identical to the originals (tests and lint did not modify them).

Commands:

```bash
python3 -B inspection/tools/hash_originals.py "<original>" inspection/baseline-original-sha256.json
cp -R "<original>/app" "<original>/tests" inspection/baseline-copy/
cp "<original>/README.md" "<original>/pyproject.toml" "<original>/uv.lock" inspection/baseline-copy/
python3 -B inspection/tools/hash_originals.py "<original>" inspection/baseline-original-sha256-after.json inspection/baseline-original-sha256.json
```

Not copied: `data/`, `.taskplane/`, `analysis/`, databases, the image/CSV/JSON/DOCX files in the original root.
`analysis/` and `.taskplane/` were not opened.

## 2. Environment

| Item | Value |
| --- | --- |
| Host | macOS 27.3, arm64 |
| uv | 0.13.5 (`/Users/joe/.local/bin/uv`) |
| Python used by the venv | CPython 3.13.14 (uv-managed, `~/.local/share/uv/python/cpython-3.13-macos-aarch64-none`), SQLite library 3.53.1 |
| Python used only for hashing | system `python3` 3.14.6 |
| curl | 8.7.1 |
| Environment | **the locked one**: `uv sync --frozen` succeeded against the copied `uv.lock` (lock revision 5, `requires-python >=3.11`); no fallback was needed |

`uv sync --frozen` output is in `logs/uv-sync.txt`. Installed packages (25, all at the versions pinned in `uv.lock`):

`annotated-doc 0.0.6`, `annotated-types 0.8.0`, `anyio 4.16.0`, `certifi 2026.10.23`, `click 8.5.1`,
**`fastapi 0.162.5`**, `greenlet 3.5.6`, `h11 0.16.0`, `httpcore 1.0.9`, **`httpx 0.28.1`**, `idna 3.20`,
`iniconfig 2.3.1`, `opentelemetry-api 1.45.2`, `packaging 26.3`, **`playwright 1.65.1`**, `pluggy 1.7.0`,
**`pydantic 2.14.3`**, `pydantic-core 2.50.4`, `pygments 2.21.0`, **`pytest 9.2.0`**, **`ruff 0.17.4`**,
**`starlette 1.10.0`**, `typing-extensions 4.16.0`, `typing-inspection 0.4.5`, **`uvicorn 0.54.0`**.

The lock lists 27 entries; the two not installed are the project itself (`cabin-kit 0.1.0`, no build system, so
not installable) and `colorama 0.4.6` (Windows-only marker).

Deviations from the README commands, all to keep writes inside `inspection/`:

- `UV_CACHE_DIR=inspection/.uv-cache` (deleted at the end, 204 MB), `UV_PYTHON_DOWNLOADS=never`, `TMPDIR=inspection/disposable/tmp`.
- pytest got `--basetemp=inspection/disposable/pytest-tmp` so `tmp_path` does not use the system temp directory.
- `CABIN_DB_PATH` / `CABIN_VISITS_DB_PATH` were exported to files under `inspection/disposable/` for the pytest run as a
  guard. They were never created: `tests/conftest.py:11-34` seeds the reference store into `tmp_path` and passes both
  paths explicitly to `create_app(reference, tmp_path / "visits.sqlite3")`; `tests/test_visits.py:81-97` also uses only
  `tmp_path`. Importing `app.main` builds a module-level app bound to the default/env paths (`app/main.py:110`) but
  opens nothing until the lifespan starts. No `data/` directory exists in the copy after the run.

## 3. Automated tests (this run)

```bash
cd inspection/baseline-copy
uv sync --frozen
uv run --frozen pytest -q --basetemp=../disposable/pytest-tmp      # 20:27:42
uv run --frozen pytest -v --basetemp=../disposable/pytest-tmp      # same suite again, for per-test names
```

| Run | Collected | Passed | Failed | Errors | Skipped | Warnings | Time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `pytest -q` | 52 | **52** | 0 | 0 | 0 | 1 | 2.49 s |
| `pytest -v` | 52 | **52** | 0 | 0 | 0 | 1 | 2.23 s |

- 31 tests in `tests/test_lookup.py`, 21 in `tests/test_visits.py`. `tests/browser_smoke.py` is not collected (no `test_` prefix).
- The one warning: `StarletteDeprecationWarning: Using httpx with starlette.testclient is deprecated; install httpx2 instead`
  (from `fastapi/testclient.py`; a dependency-pin issue, not a test failure).
- Full output: `logs/pytest.txt`.

## 4. Lint (this run)

```bash
uv run --frozen ruff check --config pyproject.toml app tests      # the baseline's documented check
```

Result: **`All checks passed!`**, exit 0, 0 findings (ruff 0.17.4, default rule set; `pyproject.toml` only sets `line-length = 100`).

Two supplementary commands, not part of the baseline's documented check, recorded for context only:

| Command | Result |
| --- | --- |
| `ruff check --config pyproject.toml --select E501 --statistics app tests` | 52 lines longer than the configured 100 columns (E501 is not in the default rule set, so the configured limit is never enforced) |
| `ruff format --check --config pyproject.toml app tests` | 9 of 10 Python files would be reformatted |

Ruff does not look at `app/static/*.js`, `*.css` or `*.html`; the JavaScript has no lint, type-check or unit test.
Full output: `logs/ruff.txt`.

## 5. Live probe (this run, copy only)

```bash
cd inspection/baseline-copy
.venv/bin/python -B -m app.seed --db ../disposable/probe-reference.sqlite3          # explicit --db
CABIN_DB_PATH=../disposable/probe-reference.sqlite3 \
CABIN_VISITS_DB_PATH=../disposable/probe-visits.sqlite3 \
  .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 53258            # pid 26605
bash ../tools/live_probe.sh http://127.0.0.1:53258 .venv/bin/python ../tools/summarize.py ../disposable
kill 26605
```

(Absolute paths were used in the real invocation.) Port 53258 was obtained by binding to port 0 and rejecting
8000/8001. The probe ran 20:30:27–20:30:30; the server was then stopped with `kill 26605`, after which
`lsof` showed no listener on the port, the PID was gone and `curl` failed to connect (exit 7). Transcript:
`logs/live-probe.txt` (76 HTTP exchanges, summarised by `tools/summarize.py`); server access log:
`logs/live-probe-server.txt` (91 requests: those 76, one readiness check and 14 parallel requests in the
concurrency section). One cosmetic defect in the transcript: the two echoed `-H Origin: …` command lines
are printed without quotes; the header was sent correctly (both got the expected 403).

### Lookups (all HTTP 200; state is in the body)

| Tail / date | Status | Variant | Seats | Lines | Notable |
| --- | --- | --- | --- | --- | --- |
| N100TL 2026-11-12 | OK | V01 | 176 | 58 (36 seat, 2 carpet, 20 bin) | `P-ELR-A-CUSHION` → FAKE-SC-1001; `P-CARPET-KIT` → FAKE-CK-2001 with 1 substitute |
| N200TL 2026-06-30 | OK | V05 (config to 2026-06-30) | 176 | 58 | carpet kit FAKE-V05-CARPET-KIT |
| N200TL 2026-07-01 | OK | V04 (config from 2026-07-01) | 176 | 58 | carpet kit rule `R4` → FAKE-CK-2002, `pending_change=1` |
| N300TL 2026-11-12 | OK | V10 | 138 | 54 (36, 2, 16) | no omitted seats |
| N000TL 2026-11-12 | NO_CONFIG | – | – | 0 | "No configuration on this date." |
| N110TL 2026-11-12 | NO_CONFIG | – | – | 0 | "This variant is planned; no released configuration is available." |
| N999ZZ 2026-11-12 | UNKNOWN_TAIL | – | – | 0 | "This tail is not in the dataset." |
| N100TL 2027-01-01 | OK | V01 | 176 | 58 | carpet kit substitutes = **0** (DOC-DEV expired 2026-12-31); no issue raised |

Extra boundaries probed: N100TL 2026-12-31 → substitute still offered; N100TL 2025-09-30 → NO_CONFIG, 2025-10-01 → OK;
N010TL 2025-07-21 → 0 substitutes, 2025-07-22 → 1 substitute; N040TL 2026-06-30 → FAKE-V04-CARPET-KIT, 2026-07-01 →
FAKE-CK-2002; N030TL → V03, 170 seats; N090TL → V09, 137 seats, 23C omitted; N010TL 2023-12-31 → NO_CONFIG;
`" n100tl "` → normalised to N100TL; `check_date=bad`, missing date and `2026-02-30` → HTTP 422.
In every 30-row layout four emitted seat lines (`P-EXIT-B-*`, `P-EXIT-E-*`) match no seat.

### Visit A (N100TL, 2026-11-12, technician "Probe Tech")

| Action | HTTP | Result |
| --- | --- | --- |
| `POST /api/visits` | 201 | DRAFT, snapshot 88,487 bytes (58 lines, 176 seats) |
| `PUT` 3A / `R-V01-P-ELR-A-CUSHION` | 200 | 1 item: FAKE-SC-1001 ×1 EA |
| same `PUT` again with a new note | 200 | still 1 item, same item id, note and `recorded_at` overwritten |
| `PUT` FULL_CABIN / `R-V01-P-CARPET-KIT` (primary) | 200 | 2 items: FAKE-CK-2001 ×1 KIT |
| `PUT` FULL_CABIN with `substitute_id=SUB-KIT-1` | 200 | still 2 items; carpet item now 5 part lines, source DOC-DEV, primary source DOC-B |
| `GET …/report` | 200 | totals below |
| `POST …/complete` | 200 | COMPLETED, `completed_at` set |
| `PUT` 3A after completion | **409** | "Completed visits are locked." |
| `PUT` 4A (new item) after completion | **409** | same |
| `DELETE` item after completion | **409** | same |
| `POST …/complete` again | 200 | idempotent, `completed_at` unchanged |

Report totals lines (identical before and after completion; 6 lines, quantity sum 8):

```
FAKE-CK-2000   1 KIT
FAKE-P-39      2 PANEL
FAKE-P-40      2 PANEL
FAKE-P-41      1 PANEL
FAKE-P-42      1 PANEL
FAKE-SC-1001   1 EA
```

### Visit B (N100TL, 2026-11-12, no technician): refusals and forged input

| Request | HTTP | Detail |
| --- | --- | --- |
| complete an empty visit | **409** | "Record at least one replacement before completing the visit." |
| 3B with the A-seat rule; unknown seat 99Z; 14B (absent seat); 14A with the STD rule | 422 | "This part does not apply to this seat." |
| seat quantity 2 | 422 | "Record one replacement per seat component." |
| rule of another variant (`R-V02-…`) | 422 | "Part rule is not applicable to this visit." |
| substitute not attached to the rule | 422 | "Substitute is not approved on this visit's check date." |
| bin rule on another bin; carpet-kit rule on FORWARD | 422 | "This part does not apply to this cabin location." |
| quantity `"1"` (string), note of 1001 chars, missing `rule_id`, non-JSON body | 422 | pydantic validation errors |
| **BIN-L-01 with quantity 100** | **200** | accepted: FAKE-V01-BIN-L-01 ×100 EA for a single bin module |
| **FULL_CABIN substitute with quantity 7** plus forged `part_no`, `parts`, `status` fields | **200** | accepted: 7 kits and 14/14/7/7 panels; the unknown fields were silently ignored (not rejected) |
| delete visit B's item through visit A's URL; delete unknown item | 404 | "Replacement not found." |
| create visit for N000TL / N110TL / N999ZZ | 422 | lookup message returned as `detail` |
| tail `N100TL; DROP`; technician of 81 chars | 422 | pydantic validation errors |
| `Origin: https://unrelated.example`; `Origin: null` | 403 | "Cross-origin writes are not allowed." |
| unknown visit id (GET visit, GET report) | 404 | "Visit not found." |

### Concurrency over HTTP

- 12 parallel `PUT`s for the same seat/component: all 12 returned 200, one record remained, holding whichever note
  was written last ("writer 8" in this run). There is no version field, ETag or precondition.
- `complete` raced against an edit on the same visit: `complete` → 200, edit → 409 (serialised by `BEGIN IMMEDIATE`).
- `GET /api/visits` listed both visits, newest first, with `item_count`.

### Other observations from the probe

- Responses carry `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`; no CSP or frame headers.
  `three.core.js` is served uncompressed (1,403,455 bytes) and uncached.
- `/docs` (Swagger UI) is enabled and references `https://cdn.jsdelivr.net`; the application page itself references no external host.

## 6. Store-safety checks (this run, copy only)

`PYTHONPATH=. .venv/bin/python -B ../tools/store_hazards.py ../disposable/hazards` — output in `logs/store-hazards.txt`.
It drives the copy's own `seed`, `create_app` and `VisitStore` against throw-away files.

| Check | Observed |
| --- | --- |
| Seeder default vs server path | `app.seed.DEFAULT_DB` = `<root>/data/reference.sqlite3`; `seed.py` never reads `CABIN_DB_PATH` (`app/seed.py:11,151`), while the server does (`app/main.py:33`). With the variable set, `python -m app.seed` without `--db` seeds a file the server is not using. The two agree only when neither is overridden, or when `--db` repeats the variable's value by hand. |
| Server started on a never-seeded reference path | `/api/health`, `/api/lookup`, `POST /api/visits` → 503 "Database unavailable. Check local setup and seed the reference dataset."; `/api/visits` → 200 `[]`; the missing file is not created (opened `mode=ro`) |
| Seeding an existing file without `--reset` | `ValueError: Database exists; use --reset…` as an uncaught traceback, exit 1 |
| **Reference and visit paths set to the same file, then `seed --reset`** | The app runs normally on the shared file (visit created, replacement recorded). `--reset` then finds the marker row, replaces the file, exits 0 and prints "Visit history was not changed." — afterwards the `visits` and `replacements` tables **no longer exist** (1 visit and 1 replacement destroyed). Nothing compares the two paths. |
| `--reset` on a visits-only database | refused, but only by accident: `sqlite3.OperationalError: no such table: metadata` (this is what `tests/test_visits.py:91-97` asserts) |
| `--reset` on a non-SQLite file | refused via `sqlite3.DatabaseError: file is not a database` |
| `--reset` on an unrelated database that merely contains the marker row | **overwritten** |
| History listing | 105 visits created → `GET /api/visits` returns 100; the 5 oldest are absent from the list but still fetchable by id; no paging/filter parameters; the store was 9.5 MB for 105 empty visits |
| Writer blocked by another connection's write lock | request waits 10.4 s, then 503 with the same "seed the reference dataset" message; `journal_mode = delete` |
| Two editors of one draft | both `PUT`s 200, second silently replaces the first; no version field, no ETag |

## 7. Other checks (this run)

- `logs/fixture-facts.txt`: exact fixture contents read (read-only) from the reference database the copy's seeder produced —
  row counts, source documents, per-variant seat sets, tail configurations, named part rules, substitute and panels.
- `logs/vendor-verify.txt`: the public npm tarball `three@0.180.0` was downloaded (its SHA-512 matches the registry
  `integrity` value) and compared with `app/static/vendor/`: `three.core.js`, `three.module.js`, `OrbitControls.js`,
  `RoundedBoxGeometry.js` and `THREE-LICENSE.txt` are **byte-identical** to the package's files (licence: MIT,
  "Copyright © 2010-2025 three.js authors"). The baseline itself ships no checksum or version manifest for these files.

## 8. What was NOT run

| Not run | Why | What it would do (read, not run) |
| --- | --- | --- |
| `tests/browser_smoke.py` | Per instruction; it defaults to `http://127.0.0.1:8001`, a Chromium at `/usr/bin/chromium` (absent on macOS) and writes into whatever stores that server uses | Playwright script, not a pytest test. Desktop 1440×1050: waits for the 3D canvas and "176 seats", starts a check for 2026-11-12, hides bins, switches to Overhead, clicks seat 3A at `window.cabinViewer.screenPoint('3A')`, expects FAKE-SC-1001, checks Focus distance < 10, records cushion and backrest, records the carpet substitute (expects FAKE-P-42) and BIN-L-01, reloads and expects 4 items, previews the draft report, completes, expects COMPLETED/FAKE-P-42/DOC-DEV, screenshots the report, downloads the JSON, renders an A4 PDF with print media, reopens the visit from Saved visits, checks N200TL V05/V04 and "Pending change", checks N000TL → NO_CONFIG, asserts no page errors. Mobile 390×844: seats 1A/1F/30A/30F project inside the canvas, records 3A via the location menu, asserts no horizontal overflow, screenshots. Outputs go to `artifacts/` in the working directory. |
| Any real browser session | No browser automation was in scope | So nothing about rendering, WebGL picking, camera framing, the 2D map, dialogs or keyboard behaviour was observed; statements about the UI in `docs/baseline-review.md` come from reading `app/static/*` |
| PDF / print output | Needs a browser | Print path is `window.print()` plus an `@media print` stylesheet; there is no server-side PDF |
| Mobile layout | Needs a browser | Two CSS breakpoints (1100 px, 700 px) exist; untested here |
| Default-path seeding (`python -m app.seed` without `--db`) and `--reset` on default paths | Would create `data/` inside the copy; the behaviour was established from the code and from the shared-file check instead | – |
| Anything inside the original directory | Read-only by rule | – |

## 9. State left behind

- `inspection/baseline-copy/`: the copied sources plus `.venv/` (209 MB, locked environment), `.pytest_cache/`, `.ruff_cache/`, `__pycache__/`.
- `inspection/disposable/`: `probe-reference.sqlite3` (438 KB) and `probe-visits.sqlite3` (291 KB; visits A and B, both completed — B contains the deliberately forged quantities).
- Removed after use: the uv cache, pytest temp tree, the hazard-check databases and the npm tarball. Logs that mention those paths refer to files that no longer exist.
- No process from this run is still running; port 53258 is free.
