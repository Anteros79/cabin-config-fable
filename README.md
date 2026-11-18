# Cabin Kit (replacement implementation)

Cabin Kit helps an aircraft appearance technician bring only the replacement parts that apply to one tail on one check date. This folder is a self-contained replacement for the earlier Python/FastAPI baseline.

> **Authority status.** This is a fictional home-lab demonstration. It is not an approved maintenance authority, engineering source or work instruction. Every tail, part number, applicability rule and approval in it is a fictional fixture. The supplied Southwest registry is loaded only as unverified, unassigned candidate layouts. No approved airline data was supplied, so none is present.

## What it does

- **Lookup:** tail + appearance-check date resolve to one effective configuration, or to an explicit state (invalid input, unknown tail, unconfigured or date gap, overlap, planned, source invalid, partial, resolved, service unavailable). It never guesses.
- **3D cutaway:** real WebGL scene of floor, seats, armrests and overhead bins with picking of single pieces, orbit/pan/zoom, cutaway / overhead / aisle / focus / reset cameras, independent layers (including an "Under seat" layer), neutral and blue light, and three unassigned visual families. Bins open on tap.
- **Map and list:** a complete keyboard-operable alternative for every seat, armrest, floor area, bin and piece. It needs no WebGL and takes over automatically if 3D fails.
- **Parts:** component-level primary part, separately approved alternates, and mandatory supplements derived by the server.
- **Pieces and problems:** tap the exact piece, see its part, then replace it, note a problem or defer it under the fictional MEL (see [Visual appearance check](#visual-appearance-check)).
- **Visits:** persistent drafts, resumable history, explicit non-empty completion (a record or a problem), locked afterwards.
- **Reports:** after-action report (report v3) with a cabin picture, a timeline and lists by outcome, as printable page, server PDF and versioned JSON.
- **Preparation:** searchable, filterable, printable and exportable list of applicable parts before the work.

## Visual appearance check

Version 2.1.0 adds a visual way to do the check: tap the exact piece in 3D, see what it is and which part replaces it, then record what was done. Everything here is fictional demonstration data.

**Pieces you can tap**

- **Seat:** cushion, backrest, headrest, seat belt, tray table, seat-back net, and the life vest on the "Under seat" layer. That is seven pieces per seat.
- **Armrests are their own locations** (`ARMREST:<row>-<span>`, for example "Armrest between 12A and 12B"), so a shared armrest is logged once. The 176-seat layout has 240 of them.
- **The tray table and the seat-back net belong to the seat behind**, the passenger who uses them, even though they are drawn on the back of the seat in front (or on the bulkhead in row 1).
- **Floor:** carpet, as before.

**Overhead bins.** Three fictional bin types, set per cabin configuration: CLASSIC (3 bags), PIVOT (4 bags) and LARGE_PIVOT (6 bags). The module lengths per side (2 or 3 rows) are made up and labelled as such in the data; the 176-seat layout has 11 bins per side, 22 in all. A bin opens in 3D when you tap it, and its inner pieces then become tappable. CLASSIC has 9 pieces (no assist, no bumper), PIVOT has 11 and LARGE_PIVOT has 10 (no assist): door or bucket face, latch, striker, pivot, assist, floor liner, side panels, stop bumper, seal, placard and label. The CLASSIC door has a fixed fascia and a lower panel that swings up; the pivot types swing the bucket down. The mechanisms are stand-ins: public sources do not give them.

**Problems.** A problem is a condition (stained, torn, worn, broken, missing, won't latch, other) plus an outcome:

- **Note only:** nothing to do now.
- **Defer:** until the next check or the next stop, with a reason (no stock, no time, other).
- **Must be fixed** before flight.

The outcomes on offer depend on the MEL class: a cosmetic problem can be noted or deferred, an MEL item can be deferred or must-fix, and a no-go item is must-fix only.

**The fictional MEL.** Every piece and condition has a class: `COSMETIC`, `MEL` (deferrable under an MEL item with a category and a due date) or `NO_GO`. The MEL is data, like the parts list, and it is not the airline's MEL: the items, categories (A as stated, B 3 days, C 10 days, D 120 days) and wording are invented for this demonstration.

- A class can be raised by the technician, never lowered.
- A seat belt deferral blocks the seat. While a seat is blocked, an entry that allows it (a missing life vest) becomes deferrable on that seat.
- An MEL deferral past its due date is treated as `NO_GO`: it becomes must-fix. Dates are compared against the visit's check date, never the clock.
- Completing a check with must-fix items needs the answer "Aircraft held, reported to maintenance". The visit stores it and the report says "Not releasable".

**Carried over.** Only deferred and must-fix problems carry to the next check on the same tail; a problem that was only noted stays on its own visit. A carried problem attaches to the same piece, or, if that bin changed, to the bin that now covers its first row on the same side. If the piece no longer exists (for example an assist spring after a move to LARGE_PIVOT) it is listed under "No longer at this position" until the technician closes it. It is never dropped.

**The after-action report** (schema `cabin-kit.report/3`) shows, on the page and in the PDF: a summary (replaced, noted, deferred, must-fix, carried over, release flag), a cabin picture with every touched piece coloured by outcome, a timeline of the visit in order, and lists by outcome. The page can show the same marking on the 3D model. Stored `/1` and `/2` reports are served as they were stored. The report page loads as its own chunk.

## Quick start

Requires Node.js 24 or later (uses the built-in `node:sqlite` and runs TypeScript directly; no native modules to compile). Network access is needed once, for `npm ci`. The nine data originals the import reads are vendored in `fixtures/originals/`, so a fresh clone sets up, starts and passes `npm run verify:clean` with nothing from outside the repository. The 14 images are not vendored: where they are not present, `originals:verify` skips them and the comparison sheets are not made.

```bash
git clone <this repository> cabin-kit && cd cabin-kit
npm run setup        # npm ci, build the web client, import reference data, add three sample visits
npm start            # http://127.0.0.1:4310
```

At 2.0.0 this was tested from a fresh clone of the release branch, and the page and the lookup API answered on the port given. At 2.1.0 the process tests seed a fresh data folder: the import activates release `REL-0001-b5b0a788` and the seed adds three sample visits.

**Upgrading an existing data folder to 2.1.0:** back up the visits (`npm run visits:backup`), then after upgrading, run `npm run reference:import` to get the new pieces and MEL. Until then the active release is the old one: seats have only their cushion and backrest, and no problem can be noted or deferred.

`npm start` binds to loopback only unless told otherwise (see Configuration); there is no authentication. If no reference store exists it creates one with the same import the CLI uses. It never re-imports or resets an existing store.

The seed leaves a completed visit on N100TL with one deferred tray table (seat 7C), a draft on N200TL and a later draft on N100TL (2026-11-19) that shows the tray table under "Carried over".

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
| `npm run setup` | Install locked dependencies, build, import reference data, seed three sample visits |
| `npm start` | Start the server (`CABIN_KIT_PORT`, default 4310) |
| `npm run reference:import` | Stage, validate and atomically activate a new reference release. Never touches visits. When the data equals the active release (the `--label` does not count), nothing is staged and it says so |
| `npm run reference:status` / `reference:findings` | Releases, active release, import findings |
| `npm run reference:reset -- --yes` | Rebuild the reference store only (stop the server first) |
| `npm run sample:seed` | Add three sample visits (a completed N100TL visit with one deferral, a draft on N200TL, and a draft on N100TL that shows the deferral carried over), only if the visit store is empty |
| `npm run visits:backup -- [--out <file>]` | Verified copy of the visit store (default `backups/visits-<UTC stamp>Z.sqlite`); safe while the server runs |
| `npm run check` | Biome, the type check and the whole vitest suite (unit, integration, separate-process races, web components in jsdom, timing tests) |
| `npm test` | The vitest suite only |
| `npm run coverage` | The vitest suite with v8 coverage and the per-directory floors |
| `npm run test:e2e` | Build the client with test hooks (`dist/web-e2e`), then the Playwright specs in `e2e/` on the bundled Chromium (`npx playwright install chromium` once). Disposable stores, free ports |
| `npm run test:e2e:ui` | The same specs in Playwright's UI mode (run `npm run build:e2e` first) |
| `npm run budgets` | Build, then check bundle, payload, scene geometry and coverage budgets against `budgets.json` |
| `npm run verify` | `check`, build, browser tests and the originals check. Writes nothing tracked |
| `npm run verify:clean` | `verify`, then fails if the working tree changed. CI runs the equivalent steps, but its `npm audit` step uses `--audit-level=high`, where the release gate used `moderate` |
| `npm run evidence:capture` | Renders, sample visits and reports, performance and axe results into `verification/out/` (git-ignored). `-- --promote` copies the curated subset into `verification/` to be committed by hand; `-- --assert-perf` also checks the frame-rate and pick targets |
| `npm run comparisons` | Comparison sheets from the captures in `verification/out/` and the image originals; skipped when the images are not present |
| `npm run originals:verify` | Re-hash the supplied originals against the manifest. The source root (`CABIN_KIT_SOURCE_ROOT`, else `../../`) is checked when it was named or holds any original, and must then hold all of them; otherwise the 14 images are skipped |
| `npm run evidence:build` | Regenerate the evidence inventory, extracts and registers from the originals. Offline by default; `-- --online` adds the public-hyperlink reachability check. Step names run a subset, with the steps it needs |

Test counts are not listed here because they change; see the CI run (`.github/workflows/ci.yml`) or run `npm run check`.

## Configuration

Store paths, host, port and the other server settings are resolved in `src/server/config.ts`; the source root is resolved in `src/importer/originals.ts` (`resolveSourceRoot` for the data originals, `resolveImageRoot` for the images). The server, the import CLI, the tools and the tests all use these. An empty or blank value counts as unset. The server checks every value before it opens a store and stops with exit code 2 on an unusable one.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CABIN_KIT_DATA_DIR` | `./data` | Folder for both stores |
| `CABIN_KIT_REFERENCE_DB` | `<data dir>/reference.sqlite` | Reference store |
| `CABIN_KIT_VISITS_DB` | `<data dir>/visits.sqlite` | Visit store |
| `CABIN_KIT_HOST` / `CABIN_KIT_PORT` | `127.0.0.1` / `4310` | Listen address and port. A non-loopback host is refused unless `CABIN_KIT_ALLOW_REMOTE=1` |
| `CABIN_KIT_ALLOW_REMOTE` | unset | `1` accepts a non-loopback `CABIN_KIT_HOST`. The server has no authentication |
| `CABIN_KIT_ALLOWED_HOSTS` | unset | Extra host names accepted in the `Host` header, comma-separated (besides `localhost`, `127.0.0.1`, `::1` and the listen host) |
| `CABIN_KIT_LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info` or `debug`. Two JSON lines per request (incoming request, request completed), with its request id |
| `CABIN_KIT_WEB_ROOT` | `dist/web` | Built client the server serves |
| `CABIN_KIT_SOURCE_ROOT` | see below | Folder holding the supplied originals |

Source root, for the data originals: `CABIN_KIT_SOURCE_ROOT` when set, else the vendored `fixtures/originals/`, else the development folder two levels up (`../../`). The 14 images are never vendored: they are read from `CABIN_KIT_SOURCE_ROOT` when set, else `../../`, and only the comparison sheets and `originals:verify` use them.

More in [operations](docs/operations.md).

## Where things are

```
src/domain/     pure logic: lookup, specificity, kits, snapshot, records, report, preparation, validation
src/importer/   readers (CSV, XLSX, DOCX), fixture and candidate staging, import CLI
src/server/     config, reference store, visit store, PDF, HTTP API
src/web/        React client, accessible map/list, three.js scene
fixtures/       mandatory fictional regression data (declarative)
evidence/       inventory, located extracts, crosswalk, seat sets, conflict register, image previews
docs/           logical model, visual families, operations, missing evidence, baseline review, audit register
verification/   curated captures, comparison sheets, performance, sample visits and reports, and their provenance
inspection/     isolated copy of the baseline and the record of running it
data/           runtime stores (git-ignored)
tests/          vitest: unit, integration, process (races), web (jsdom)
e2e/            Playwright specs
```

Read next: [logical model](docs/logical-model.md) · [visual families](docs/visual-families.md) · [operations](docs/operations.md) · [missing evidence](docs/missing-evidence.md) · [verification](verification/README.md) · [evidence](evidence/README.md) · [baseline review](docs/baseline-review.md) · [audit register](docs/audit-2026-11-15.md) · [browser check migration](docs/e2e-migration.md) · [changelog](CHANGELOG.md).

## Path mapping and preservation

The request named `./app`, `./tests` and `./analysis/...` under the development folder. In this folder they are not present:

| Named in the request | Actual location | Handling |
| --- | --- | --- |
| 8 data/document inputs and 14 images at `./` | `../../` (the development folder) | Read only. SHA-256 recorded in `evidence/originals-manifest.json`. The nine data and document originals are also vendored, byte-identical, in `fixtures/originals/` |
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

What is true at 2.1.0:

- All workflow data is fictional. Candidate layouts have no tails, parts, floor map or bin map; every component there is shown as unresolved.
- Geometry is an illustrative approximation with uniform row spacing, and the cabin shell (ceiling 2.45 m, curved sidewall, windows) is drawn from illustrative constants. Nothing is derived from pitch claims, drawings or photographs.
- The 3D model is recognisable as the photographed cabin but is not a faithful reproduction: 13 of the judged features are PARTIAL and 5 UNKNOWN in [verification/README.md](verification/README.md). There are no cast shadows, only contact shading.
- No authentication, authorisation or multi-user identity. The server listens on loopback unless `CABIN_KIT_ALLOW_REMOTE=1`, and then anyone who can reach it can read and write visits.
- Completing a visit locks it for good; there is no reopen and no delete. Corrections are linked notes.
- Screen-reader support was checked with axe, structural assertions and a keyboard-only run. No one has run it with a real screen reader.
- The browser tests run on the Chromium bundled with Playwright. WebKit was run on the workflow and accessibility specs: "Go to location" needed a second Enter (a datalist suggestion took the first), fixed in 74cf243 for it and the tail lookup; a CSP console message there comes from Playwright's screenshotter, not the app; and WebKit's plain Tab skips buttons and links (Option-Tab reaches them), so the keyboard walk-through, written for plain Tab, still fails there. Firefox could not be started on the reference machine. See "Not verified" in [verification/README.md](verification/README.md).
- The CI workflow (Linux, WebGL in software) has never run: nothing has been pushed. Every result here comes from one machine (Apple M4 Pro, macOS).
- The scene stays within the budgets in `budgets.json` (39 draw calls, 546,307 triangles and 3,175 triangles per seat on the 176-seat layout, checked by the browser tests); frame rate was measured only on that machine. The captured frame rates and sizes in [verification/README.md](verification/README.md) are from 2.0.0 and were not re-captured.
- Bin types, module lengths, bin mechanisms and the whole MEL are fictional stand-ins. Public sources give none of them; the MEL is not any airline's MEL and nothing here approves a deferral. The technician decides, and the record says so.
- An import accepts a large workbook only up to its caps (4 MiB per XML part, 100,000 elements); a legitimate larger workbook is refused with a message, and an accepted one near the caps can use about 300 MB.
