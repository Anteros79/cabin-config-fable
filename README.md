# Cabin Kit (replacement implementation)

Cabin Kit helps an aircraft appearance technician bring only the replacement parts that apply to one tail on one check date. This folder is a self-contained replacement for the earlier Python/FastAPI baseline.

> **Authority status.** This is a fictional home-lab demonstration. It is not an approved maintenance authority, engineering source or work instruction. Every tail, part number, applicability rule and approval in it is a fictional fixture. The supplied Southwest registry is loaded only as unverified, unassigned candidate layouts. No approved airline data was supplied, so none is present.

## What it does

- **Lookup:** tail + appearance-check date resolve to one effective configuration, or to an explicit state (invalid input, unknown tail, unconfigured or date gap, overlap, planned, source invalid, partial, resolved, service unavailable). It never guesses.
- **3D cutaway:** real WebGL scene of floor, seats and overhead bins with picking, orbit/pan/zoom, cutaway / overhead / aisle / focus / reset cameras, independent layers, neutral and blue light, and three unassigned visual families.
- **Map and list:** a complete keyboard-operable alternative for every seat, floor area and bin. It needs no WebGL and takes over automatically if 3D fails.
- **Parts:** component-level primary part, separately approved alternates, and mandatory supplements derived by the server.
- **Visits:** persistent drafts, resumable history, explicit non-empty completion, locked afterwards.
- **Reports:** location-level and aggregate after-action report as printable page, server PDF and versioned JSON.
- **Preparation:** searchable, filterable, printable and exportable list of applicable parts before the work.

## Quick start

Requires Node.js 24 or later (uses the built-in `node:sqlite` and runs TypeScript directly; no native modules to compile). Network access is needed once, for `npm ci`.

```bash
cd implementation/cabin-kit
npm run setup        # npm ci, build the web client, import reference data, add two sample visits
npm start            # http://127.0.0.1:4310
```

`npm start` binds to loopback only; there is no authentication. If no reference store exists it creates one with the same import the CLI uses. It never re-imports or resets an existing store.

Try: `N100TL` on `2026-11-12` → Start visit → Map and list → `3A` → Record replacement → "Full cabin floor" → Alternate → Record → Complete. The report shows exactly six part/unit totals.

| Tail / date | Result |
| --- | --- |
| N100TL / 2026-11-12 | V01, 176 fictional seats, resolved |
| N100TL / 2026-12-31 and 2027-01-01 | alternate kit offered, then excluded with the reason |
| N200TL / 2026-06-30 and 2026-07-01 | V05, then V04 (retrofit boundary; pending-change advisory) |
| N300TL / 2026-11-12 | V10, 138 fictional seats |
| N090TL / 2026-11-12 | V09, 137 seats, PARTIAL: no-match, ambiguous, expired-source and unreleased-rule gaps |
| N000TL · N500TL / 2026-03-01 | unconfigured · date gap |
| N400TL / 2026-09-15 | overlap (refused) |
| N110TL | planned only |
| N600TL / 2026-03-01 | configuration source expired |
| N999ZZ | unknown tail |

## Commands

| Command | Purpose |
| --- | --- |
| `npm run setup` | Install locked dependencies, build, import reference data, seed two sample visits |
| `npm start` | Start the server (`CABIN_KIT_PORT`, default 4310) |
| `npm run reference:import` | Stage, validate and atomically activate a new reference release. Never touches visits. When the data equals the active release (the `--label` does not count), nothing is staged and it says so |
| `npm run reference:status` / `reference:findings` | Releases, active release, import findings |
| `npm run reference:reset -- --yes` | Rebuild the reference store only (stop the server first) |
| `npm run sample:seed` | Add one completed and one draft sample visit, only if the visit store is empty |
| `npm run visits:backup -- [--out <file>]` | Verified copy of the visit store (default `backups/visits-<UTC stamp>Z.sqlite`); safe while the server runs |
| `npm test` | 132 unit, integration and separate-process race tests (disposable stores) |
| `npm run test:e2e` | 62 browser checks with the installed Google Chrome (disposable stores, free port) |
| `npm run verify` | Typecheck, all tests, comparison sheets, original-hash recheck |
| `npm run originals:verify` | Re-hash the 23 supplied originals against the manifest |
| `npm run evidence:build` | Regenerate the evidence inventory, extracts and registers from the originals |

Configuration (one resolver, shared by the server, the import CLI and the tests):

| Variable | Default |
| --- | --- |
| `CABIN_KIT_DATA_DIR` | `./data` |
| `CABIN_KIT_REFERENCE_DB` | `<data dir>/reference.sqlite` |
| `CABIN_KIT_VISITS_DB` | `<data dir>/visits.sqlite` |
| `CABIN_KIT_HOST` / `CABIN_KIT_PORT` | `127.0.0.1` / `4310` |
| `CABIN_KIT_SOURCE_ROOT` | the development folder two levels up (where the originals are) |

## Where things are

```
src/domain/     pure logic: lookup, specificity, kits, snapshot, records, report, preparation, validation
src/importer/   readers (CSV, XLSX, DOCX), fixture and candidate staging, import CLI
src/server/     config, reference store, visit store, PDF, HTTP API
src/web/        React client, accessible map/list, three.js scene
fixtures/       mandatory fictional regression data (declarative)
evidence/       inventory, located extracts, crosswalk, seat sets, conflict register, image previews
docs/           logical model, visual families, operations, missing evidence, baseline review
verification/   current test logs, captures, comparison sheets, performance, sample visits and reports
inspection/     isolated copy of the baseline and the record of running it
data/           runtime stores (git-ignored)
tests/          unit, integration, process (races), e2e
```

Read next: [logical model](docs/logical-model.md) · [visual families](docs/visual-families.md) · [operations](docs/operations.md) · [missing evidence](docs/missing-evidence.md) · [verification](verification/README.md) · [evidence](evidence/README.md) · [baseline review](docs/baseline-review.md).

## Path mapping and preservation

The request named `./app`, `./tests` and `./analysis/...` under the development folder. In this folder they are not present:

| Named in the request | Actual location | Handling |
| --- | --- | --- |
| 8 data/document inputs and 14 images at `./` | `../../` (the development folder) | Read only. SHA-256 recorded in `evidence/originals-manifest.json` |
| DOCX at `./analysis/.../additional-inputs/` | `../../Current Aircraft Seat Configurations.docx` | The root copy is byte-identical to the analysis copy (SHA-256 `723d11ee62d0…`); the root copy is used |
| Baseline `./app`, `./tests`, `README.md`, `pyproject.toml`, `uv.lock` | sibling `../../../cabin-config/` | Read in place, never written. Only `app/`, `tests/` and the three files were copied to `inspection/baseline-copy/` and run there |
| `./analysis/cabin-kit-review-2026-11-13/` | `../../../cabin-config/analysis/` | Not used as an authority. Evidence here was extracted from the original bytes |

No additional images exist beyond the 14 (there are no `references/`, `images/`, `assets/`, `inputs/` or `baseline/` folders, and the DOCX has no embedded media). Files under `evidence/image-previews/` and `verification/` are generated derivatives, not evidence.

Nothing outside `implementation/cabin-kit/` was created or changed. Other sibling folders were not read.

## Design choices (stack was free to choose)

- **TypeScript on Node 24, end to end.** The resolver, kit and report logic is one set of pure functions used by the server and the tests; the browser only displays what the server derived.
- **SQLite via `node:sqlite`.** Two files: an append-only, versioned reference store and a visit store. (The plan named `better-sqlite3` with `node:sqlite` as the fallback; the built-in was chosen so setup needs no compiler.)
- **Fastify** API, **React + Vite** client, **three.js** bundled locally (no CDN), **pdfkit** for the server PDF.
- **Reference releases are immutable.** Import stages a release, validates it and flips one pointer row in a single transaction. Visits keep a self-contained snapshot, so a new release cannot rebase them.
- **Every write is one `BEGIN IMMEDIATE` transaction** with record versions and idempotency keys. Completed visits are also locked by database triggers.

## Known limits

- All workflow data is fictional. Candidate layouts have no tails, parts, floor map or bin map; every component there is shown as unresolved.
- Geometry is an illustrative approximation with uniform row spacing. It is not derived from pitch claims or photographs.
- Visual fidelity was judged by comparing real renders with the supplied images; several features are recorded as FAIL or UNKNOWN in [verification/README.md](verification/README.md).
- No authentication, authorisation or multi-user identity. Loopback only.
- Screen-reader support was checked structurally and with axe; it was not tested with a live screen reader.
- Performance was measured on one device (Apple M4 Pro, headless Chrome).
