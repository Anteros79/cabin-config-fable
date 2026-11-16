# Changelog

## 2.0.0 (2026-11-16)

The platinum-hardening release. It closes the findings of the audit in [`docs/audit-2026-11-15.md`](docs/audit-2026-11-15.md) (the "Closed by" column there names the commit for each; a few stay partial or open, with the reason). All data is still fictional.

### Breaking changes

- **Write responses no longer carry the snapshot.** Creating a visit, saving or removing a record, completing and adding a linked event answer with the visit state without its frozen `snapshot` (decision D5). `GET /api/visits/:id` still returns the whole visit with its snapshot; a client must keep the snapshot from that answer. A save answer is now about 1.4 KB instead of about 154 KB.
- **Report schema 2.** New reports are `cabin-kit.report/2`: each work item gains `excludedRules`, each gap gains `sourceIds`, and `sources` lists every source the report cites, including those cited by gaps and excluded rules. Stored `cabin-kit.report/1` reports are served exactly as stored (decision D6). Readers of the JSON must accept both.
- **Reference content hash changed.** The same fixtures and originals now hash differently, so release ids change: `REL-0001-6df51180` (1.0.0) → `0a22902d` (Task 3.4, honest parse statuses) → `3be1fb71` (Task 3.7: the `--label` and the JSON engine's error text are no longer hashed) → `9cf6c6d2` (Task 3.8, candidate seats without fixture component ids). Releases already stored keep their recorded hash and still load. The first import under 2.0.0 stages one new release even from unchanged files; after that an unchanged import stages nothing.
- **Stricter validation may reject data that used to import.** Reference content now passes a strict structural schema (unknown or misspelt keys, wrong types, bad enums, unbounded quantities and malformed tails are errors), referential checks (unknown selector values and ids, constraint values that do not exist, overlapping incomparable rules, candidate layouts carrying fixture data) and kit limits (depth 8, derived quantity 1,000,000). `fixtures/fixture-data.json` is checked by its own strict schema, and the import refuses originals that differ from `evidence/originals-manifest.json` unless `--accept-changed`. Hand-edited exports that no longer agree across JSON, CSV and XLSX are rejected (`CROSS_FORMAT_MISMATCH`).
- **CLI usage errors exit 64.** The reference CLI rejects unknown or misspelt options, valueless path options, stray arguments and unknown commands with exit 64 (before, most were ignored, `--name=value` was silently dropped, and an unknown command exited 0). `--name=value` now works. `sample:seed` and `originals:verify` do the same. `visits:backup` keeps exit 2 for bad arguments.
- **Server start is stricter.** An unusable setting (port, log level, allowed host) stops the server with exit 2, and a non-loopback `CABIN_KIT_HOST` is refused unless `CABIN_KIT_ALLOW_REMOTE=1`. Requests whose `Host` is not an allowed name get 403 `HOST_NOT_ALLOWED`. Unexpected errors are 500 `INTERNAL_ERROR` instead of 503 `STORAGE_UNAVAILABLE`.
- **Visit store schema 2.** A 1.x visit store is migrated in place on first open (an index on retry keys) and is then refused by 1.x. Back it up first (`npm run visits:backup`).
- **New technician names with hidden characters are refused** (`422 INVALID_TECHNICIAN`); stored visits are not re-checked.
- **Tests and evidence moved.** The browser checks are Playwright specs in `e2e/` (`docs/e2e-migration.md` maps every old check). `npm run verify` no longer writes tracked files; evidence is captured on purpose with `npm run evidence:capture`.

### Phase 0: foundation

- The nine data originals are vendored in `fixtures/originals/`, so a clean clone sets up, starts and tests with nothing outside the repository; one resolver decides the source root, and an empty `CABIN_KIT_SOURCE_ROOT` means unset (TST-01, IMP-12, IMP-14).
- Dependencies patched (`@fastify/static` 10, `sharp` 0.35, `pdfjs-dist` 5.5.207 pinned for tests); `npm audit --omit=dev` is clean.
- Biome lint and format, `.editorconfig`, `.nvmrc`, `npm run check`, TypeScript project references with `noUncheckedIndexedAccess`, separate server and web type environments, coverage thresholds and a GitHub Actions workflow (TST-09, TST-10).
- All string ordering in domain, importer and server code is by code point, and `canonicalJson`/`contentHash` live in the domain (DOM-11, SRV-13).

### Phase 1: server

- Host allow-list against DNS rebinding, stricter Origin and `Sec-Fetch-Site` checks (SRV-01).
- Content-Security-Policy and security headers, immutable caching for hashed assets, compression (SRV-04, SRV-05).
- Validated query strings and ids; 400 instead of 503 (SRV-02).
- Internal errors separated from storage faults, request logging with request ids (SRV-03).
- Write answers without the snapshot (SRV-05).
- Idempotent linked events, still allowed on drafts (decision D4); retry keys pruned after 30 days; `replayed` is true only for a real replay (SRV-06, SRV-07).
- Visit-store migrations, snapshot, report and release hashes verified on read, frozen release cache (SRV-09, SRV-10).
- Validated configuration, single-shot shutdown with a timeout, `unhandledRejection` handler, `npm run visits:backup` (SRV-08, SRV-11).
- CSV export neutralises formula-leading cells; reference transactions keep the original error (SRV-12, SRV-15).
- Tagged PDF with a document language, rows taller than a page handled, the notice box grows, deterministic output (SRV-14).

### Phase 2: domain

- Strict structural schema and numeric limits for reference data (DOM-02, DOM-05, DOM-09, DOM-12, DOM-13, DOM-14).
- Referential and consistency findings at import: unknown selector values, incomparable overlapping rules, subtype disagreement, fixture data in candidate layouts, unreachable substitutes, bad row ranges (DOM-02, DOM-07, DOM-10, DOM-15, DOM-17, DOM-19).
- Every component keeps its excluded rules and their reasons whatever its outcome; reports cite every source, including those cited by gaps (DOM-01, DOM-16).
- Specificity is built from released data only; no stale index cache (DOM-03, DOM-22).
- Source validity enforced on variants, layout revisions and kit children (DOM-04).
- Memoised, bounded kit expansion; lookup never throws on kit data (DOM-05, DOM-06, DOM-08).
- Strict printed rows and seat letters, positional report order, honest counts and statuses (DOM-17 to DOM-21).
- Shared index and linear grouping, with property and scale tests.

### Phase 3: importer and tools

- Strict CLI option parsing, usage exit 64, symlink-safe entry point (IMP-01, IMP-08).
- Strict fixture schema; `released` and quantities come from the data (IMP-04).
- Strict cross-format comparison with header and key checks (IMP-02).
- Originals verified against the manifest on every import; registry shape guarded (IMP-03, IMP-08).
- OOXML read with a real XML parser behind inflate, part and element caps (IMP-05, IMP-06).
- Strict CSV quoting and headers; explicit pitch and width parsing with findings (IMP-07, IMP-11).
- The label and engine error text are out of the content hash; unchanged imports stage nothing (IMP-09, IMP-10).
- Safe manifest writes, seeding that detects a partial earlier run, an offline-by-default evidence build with declared step dependencies (IMP-13, IMP-14).

### Phase 4: web client

- Request timeout covers the body; unknown outcomes are told apart from refusals; ids are encoded (WEB-17).
- One write queue per target with stable retry keys: no duplicate drafts or notes, failures are not hidden by later successes, Remove disabled in flight (WEB-04, WEB-05, WEB-06, WEB-18).
- Safe route parsing, a skip link that keeps the route, lookup and filters in the URL, a resume link that checks the draft still exists (WEB-02, WEB-03, WEB-10, WEB-18).
- `useResource` with abort and a stale-response guard (WEB-07).
- Typed input survives conflicts and navigation; an honest quantity field (WEB-11).
- Focus management, a modal completion dialog, the WAI-ARIA tabs pattern, visible focus rings, forced-colours support (WEB-13, WEB-14, WEB-16).
- A camera that stays put across saves, tab switches and resizes; correct pointer and pinch handling; the full-cabin floor pickable (WEB-01, WEB-08, WEB-09, WEB-12, WEB-18).
- GPU resources tracked and disposed; test hooks only in the e2e build (WEB-15, WEB-19).

### Phase 5: 3D scene and visual design

- Seat geometry about 60% lighter, drawing only on change, separate layout, profile and state updates, cached textures (WEB-20).
- Environment lighting, physical upholstery with stitched normal maps, contact shading (WEB-21).
- Hull outlines for selection and hover, glyph badges so status is not colour alone; unresolved outranks recorded, which outranks alternate (WEB-21).
- Eased, bounded camera with reduced-motion support and page-friendly wheel and touch scrolling (WEB-21).
- A sculpted ceiling (2.45 m, clearing the drawn bins) and a curved sidewall with windows in the context layer (WEB-21).
- Stylesheet split into tokens; a dark theme with system, light and dark modes (WEB-16).
- Readable dates and states, toasts with undo, loading skeletons, empty states, a grouped 3D toolbar (WEB-21).

### Phase 6: verification and release

- Isolated Playwright specs in five projects (desktop, mobile, no-WebGL, reduced motion, dark) on the bundled Chromium, with traces and screenshots on failure (TST-02, TST-03, TST-04, TST-08).
- Evidence captured on purpose (`npm run evidence:capture`); `verify` leaves the tree clean, `verify:clean` checks it; provenance names the exact commit (TST-05).
- A deterministic barrier for the separate-process race tests (TST-06).
- Overclaiming tests made to check their claims; resources closed on failure (TST-07, TST-09).
- Bundle, payload, scene-geometry and coverage budgets in `budgets.json`, checked by `npm run budgets` and the browser tests (WEB-20).
- Documentation for 2.0.0, audit closure, `docs/e2e-migration.md`.

### Detailed notes

#### Coverage baseline

Coverage measured by `npm run coverage` (v8, over `src/domain`, `src/importer` and `src/server`) at the start of the platinum hardening work, 146 tests:

| Metric | Measured |
| --- | --- |
| Lines | 89.48% |
| Branches | 76.37% |
| Statements | 86.66% |
| Functions | 94.71% |

Thresholds are set to lines 85 and branches 75 (measured value rounded down to the nearest 5). Phases 1-3 each raise them towards the final floor: 90 lines / 85 branches for `src/domain`, 85 / 75 for `src/server` and `src/importer`.

#### Added in Phase 0

- Vitest projects (`unit`, `integration`, `process`) with per-tier timeouts.
- Coverage with `@vitest/coverage-v8` and thresholds; `npm run coverage`.
- GitHub Actions workflow on Ubuntu and macOS.
- `SECURITY.md`.

#### Per-task notes (newest first)

- Visits (Task 6.4, TST-09): a new visit whose technician name contains, after the surrounding whitespace is trimmed, a control character (C0, DEL or C1, such as a tab or line break), a format character (such as a bidi override or a zero-width space; the zero-width non-joiner and joiner are allowed) or a line or paragraph separator is refused with `422 INVALID_TECHNICIAN`; the check view shows the server's message as "Not saved: The technician name contains a hidden or control character, such as a tab, a line break or an invisible formatting mark. Remove it and try again." A name of only whitespace is still stored empty. Visits stored before this change are not checked: they open, list, report and complete with the name as stored. `ReferenceStore.loadRelease` and `loadActive` take an optional test seam, `onAfterHead`, run inside the read transaction after the release's head row is read.
- Tools (Task 3.8, IMP-13, IMP-14): `originals:verify` checks the union of the nine data originals, the fourteen images and the manifest entries; an empty manifest, an original missing on disk and an original absent from the manifest all exit 1, and images are reported `skipped (not present)` while no image folder is present. `--write` refuses when an original is missing and refuses to replace a manifest without `--force`; the script body runs only as the entry point. `sample:seed` builds both lookups before writing, exits 1 with one line when the import is rejected or a lookup is not `RESOLVED`, and says so when an earlier run left exactly one sample visit. `comparisons` renders into a temporary folder and swaps it in only when every sheet rendered; `generatedAt` is written only with `--stamp`. `images:previews` names each preview after the whole source name (`seats 3.jpg.jpg`), so sources that differ only by extension cannot collide (the 17 committed previews were renamed to match). `evidence:build` steps declare `needs`, dependencies run first, and a subset that omits one fails before writing with a message naming it; network access is off unless `--online`, and then `curl` runs with `--proto =http,https --max-redirs 3 --max-time 10`; the private-host test also rejects 127.0.0.0/8, 169.254.0.0/16, 0.0.0.0, `::1`, `fc00::/7`, `fe80::/10` and every bare IP literal. Candidate seats carry `componentIds: []` instead of the fixture ids `CUSHION` and `BACKREST` (nothing in `src/web` or the domain assumed otherwise; the Layouts view shows them as unresolved either way). Coverage floor for `src/importer`: 85 lines / 75 branches. The content hash of the release staged from the committed fixtures and originals moves (PF-2):
  `3be1fb71ae4816a9125230678dba6f4338e0d7281958354eea0b0193d40b15ff` (`REL-0001-3be1fb71`) → `9cf6c6d29e468c944381a11f9042c89f2ad30cfd07d852720796ce14b2d8ed72` (`REL-0001-9cf6c6d2`). Cause: the candidate seats' `componentIds`.
- Importer (Task 3.7, IMP-09, IMP-10): the content hash no longer covers the release `label`, and no parse status carries a reader's error text: an unparseable JSON source is `invalid: not valid JSON` and an unreadable original is `invalid: could not be read`; the engine's message is kept in the finding and in the release stats (`templates.spaceNamedError`, `templates.geminiError`, `registryJsonError`). An import whose result has no blocking finding and hashes the same as the active release stages nothing: the CLI prints `Reference data unchanged: release <id> is already active.` and exits 0 (`ImportOutcome.unchanged`, `ReferenceStore.activeContentHash()`). A rejected build that repeats the most recent rejected release (same hash and same findings) reports that release instead of staging another. Releases stored before this change carry the old hash (label included, `legacyContentHash`); loading accepts either, so existing reference stores still open. The originals check reads each original once and stages exactly the bytes it verified, still reports missing originals when the manifest cannot be used, turns a read failure into `SOURCE_UNREADABLE` instead of throwing, and names the manifest by its project-relative path. The content hash of the release staged from the committed fixtures and originals moves (PF-2):
  `0a22902d1f024b39f2c2b9507768ffd060f8deb19637ace96fb8063c5c66da5b` (`REL-0001-0a22902d`) → `3be1fb71ae4816a9125230678dba6f4338e0d7281958354eea0b0193d40b15ff` (`REL-0001-3be1fb71`). Two causes: the label is not hashed, and the two template sources' parse status lost the V8 `JSON.parse` message.
- Importer (Task 3.6, IMP-07, IMP-11): `parseCsv` is strict. A character after a closing quote other than a comma, a line break or the end of input, a quote inside an unquoted field, an empty or repeated header name and a ragged row each throw an error naming the 1-based line (reported as `SOURCE_UNREADABLE`). Seat pitch and width values go through `parseRangeClaim`: `N` or `N-M` with a hyphen, en dash or em dash, optional spaces, a leading `~` or `≈` (approximate) and a trailing `"`, `in`, `in.` or `inches`; a finite number is an exact claim. A value it cannot read (or a reversed range) leaves the claim empty and raises one `PITCH_UNPARSED` or `WIDTH_UNPARSED` warning per distinct value, with the number of seats that carry it. The configuration-level "approximate" qualifier matches only `~` or `≈` immediately followed by exactly that number (`~37.5` no longer marks `37`). Key fields (the registry primary keys) compare across exports as exact strings: `"1.50"` no longer equals `1.5` there. The supplied originals read exactly as before; the content hash is unchanged (`0a22902d…`).
- Importer (Task 3.5, IMP-05, IMP-06): the XLSX and DOCX readers use `fast-xml-parser` instead of regular expressions, through the shared `src/importer/readers/ooxml.ts`. Only the parts a reader needs are inflated; an XML part that declares more than 4 MiB (any other entry: 32 MiB), or wanted entries above 64 MiB in total, are refused before inflation, and an XML part with more than 100,000 element starts is refused before it is parsed. A sheet row above 1,048,576, a column above 16,384, more than 2,000,000 cells (or a grid that would span more), a date-typed cell, a formula without a cached value, an unknown cell type, a document type declaration, malformed XML and a missing `word/document.xml` are `OoxmlError`s, reported as `SOURCE_UNREADABLE`. A workbook value right of the last header is a `CROSS_FORMAT_MISMATCH` error instead of being dropped. The supplied originals read exactly as before; the content hash is unchanged (`0a22902d…`). The evidence tools open archives through the same reader's size caps (entry and total inflate limits); its element-count pre-scan applies to the importer only, not to the evidence tools' own XML parser.
- Importer (Task 3.4, IMP-03, IMP-08): the nine data originals are checked against `evidence/originals-manifest.json` on every import. A missing original (or a directory in its place) is `SOURCE_FILE_MISSING`; a size or SHA-256 that differs is `SOURCE_HASH_CHANGED`, an error unless `import --accept-changed` is given (then a warning). Every source is read and reported even when another is missing. The registry JSON is shape-checked before use (`REGISTRY_SHAPE`), text sources must be valid UTF-8 (`SOURCE_ENCODING`), the schema CSV is parsed (`SOURCE_UNREADABLE` when it cannot be), and an unexpected exception becomes `IMPORT_INTERNAL` instead of escaping. `import` checks the source root before it opens or creates any store.
- Every candidate source now carries an honest parse status: `parsed: …`, `not read: file missing`, `not parsed: narrative evidence, hash recorded` (the RTF) or `invalid: …`. Parse statuses are part of the release content, so the content hash of the release staged from the committed fixtures and originals moves (PF-2):
  `6df5118095a4e9416c3e409a62edabb0a10e38bbb17e50a2f4d8615776969400` (`REL-0001-6df51180`) → `0a22902d1f024b39f2c2b9507768ffd060f8deb19637ace96fb8063c5c66da5b` (`REL-0001-0a22902d`). Only the parse statuses of the registry JSON, the two templates, the schema CSV and the RTF differ. Releases already stored keep their recorded hash and still load.
- Fixtures: a part override for an existing but unreleased variant no longer blocks the import; an unknown variant, a variant with no seat spec, or a zone and letter no seat has still do. A fixture file that cannot be read is reported as such, with its path, separately from one that is not valid JSON.
