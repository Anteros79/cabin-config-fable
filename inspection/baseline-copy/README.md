# Cabin Kit

A fictional home-lab app for appearance checks: selectable 3D seats, floors and overhead bins, date-aware tail configurations, applicable replacement parts, SQLite visit history, and after-action reports.

The application was restored from the implementation in this conversation after the published environment contained an empty checkout. All data and geometry remain fictional; the requested current Southwest research has not been completed and has not been incorporated into applicability rules.

## Run

Python 3.11+ and uv are required. Three.js is vendored, so no Node build or external browser CDN is needed.

```bash
cd /workspace/cabin-config
uv sync --frozen
uv run python -m app.seed  # only when the reference database is absent
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Use the local browser on port 8000. API docs are at `/docs`.

Rebuild fictional reference data in one command: `uv run python -m app.seed --reset`. It preserves `data/visits.sqlite3` and refuses to overwrite a database without the reference-data marker.

## Use

1. Select a tail, check date and optional demo technician. **Start check** saves a draft visit and its configuration/rule snapshot.
2. Orbit or zoom the 3D cabin. Switch to Cutaway, Overhead or Aisle view. Hide bins to access seats; **Go to location** provides keyboard selection. **Focus selection** zooms to the chosen component. A selectable 2D map is available as a fallback.
3. Select a seat, floor or bin and record the parts actually replaced. Replacements save immediately to SQLite. Recording the same location/component again updates it rather than double-counting.
4. Substitute kits are shown separately with approval sources and required panels. Selecting an alternate replaces the primary selection for that component.
5. Resume drafts in **Saved visits**. **Complete & view report** confirms the work and locks the visit. Print/save the report to PDF or download JSON. Reports preserve locations, quantities, source revisions, notes and part totals.

Changing the form does not mutate the currently displayed visit. Pressing Start check creates a new draft; previous drafts remain in Saved visits.

## Demo cases

| Tail / date | Behavior |
| --- | --- |
| N100TL / 2026-11-12 | V01, 176 fictional seats; seat 3A cushion FAKE-SC-1001 |
| N200TL / 2026-06-30 | V05 before retrofit |
| N200TL / 2026-07-01 | V04, Botany/post-fix carpet FAKE-CK-2002, pending change |
| N300TL / 2026-11-12 | V10, 138-seat demo layout |
| N090TL / 2026-11-12 | V09, 137-seat layout with no 23C |
| N000TL | Known tail with no configuration |
| N110TL | Planned V11; NO_CONFIG |
| N100TL / 2027-01-01 | Expired deviation substitute excluded |

Generic N010TL–N090TL examples exercise V01–V09; N101TL exercises V10. Layout dimensions, bin modules and component shapes are illustrative, not validated aircraft geometry. This is not an approved maintenance source or work instruction.

## Data architecture

- `app/repository.py`: read-only SQLite adapter behind `CabinRepository`; replace with an approved feed adapter later. HTTP lookups use one read transaction.
- `app/lookup.py`: tail/date configuration and applicability rules. Start and end dates are inclusive. Missing configurations, overlaps and ambiguous rules are refused. Specific rules must strictly dominate broader matching constraints; incomparable rules produce gaps.
- `app/schema.sql` and `app/seed.py`: configuration history, variants, explicit seats, expected positions, part rules, sources, substitutes and mandatory panels. Carpet and seam belong to dated tail configuration records.
- `app/visits.py`: separate writable history. The server validates each location, rule and substitute. Completed visits are locked. Snapshots preserve the original approved-on-check-date data even after reference changes.
- `app/static/`: native HTML/CSS/JS plus Three.js 0.180.0, OrbitControls and RoundedBoxGeometry. Vendored npm artifacts are verified with SHA-512; licensing is in `vendor/THREE-LICENSE.txt`.

`CABIN_DB_PATH` defaults to `data/reference.sqlite3`; `CABIN_VISITS_DB_PATH` defaults to `data/visits.sqlite3`. Database files are ignored by Git. Back up visits with SQLite's backup API, or while the app is stopped. Browser local storage holds only the last visit ID.

## Check

```bash
uv run pytest -q
uv run ruff check --config pyproject.toml app tests
```

Browser QA uses a separate database, system Chromium and port 8001:

```bash
CABIN_VISITS_DB_PATH=/tmp/cabin-kit-qa.sqlite3 uv run uvicorn app.main:app --port 8001
# In another terminal:
uv run python tests/browser_smoke.py
```

Set `CHROMIUM_PATH` if the browser executable differs from `/usr/bin/chromium`. Captures go into ignored `artifacts/`. Do not point the test at a database containing real visits.

## Internal deployment prerequisites

The local lab has no workforce authentication or production authorization; keep it bound to loopback. Before an internal pilot, establish the authoritative engineering source, approved read-only feed, exact tail layouts and retrofit dates, workforce identity, backups, retention and a correction workflow. Public cabin research cannot by itself establish tail-specific part applicability. Do not put internal tail lists, part numbers or engineering documents into this home-lab dataset.
