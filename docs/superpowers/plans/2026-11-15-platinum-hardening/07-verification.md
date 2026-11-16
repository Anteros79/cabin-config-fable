# Phase 6: Verification pipeline and release

Read [`00-index.md`](00-index.md) first. Requires Phases 0–5. Tasks 6.3 and 6.4 depend only on Phase 0 and may be done earlier.

Outcome: browser tests are isolated, retryable and run on Linux CI; nothing a test run writes is tracked; committed evidence is produced by one deliberate command; the documents say only what was checked.

Decision D7 applies throughout.

---

### Task 6.1: Port the browser checks to `@playwright/test`

Closes TST-02, TST-03, TST-04, TST-08. Review Focus 4 and 5.

**Files:**
- Create: `playwright.config.ts`, `e2e/fixtures.ts`, `e2e/helpers.ts`, and the spec files below
- Delete: `tests/e2e/run.ts`, `tests/e2e/lib.ts` (after every check has a home)
- Modify: `package.json`, `.github/workflows/ci.yml`, `tsconfig.node.json` (include `e2e`, `playwright.config.ts`)

**Interfaces:**
- Dev dependency `@playwright/test` at the version matching the installed `playwright-core` (then remove the direct `playwright-core` dependency); keep `@axe-core/playwright`.
- `playwright.config.ts`: `testDir: "e2e"`, `fullyParallel: true`, `retries: process.env.CI ? 2 : 0`, `reporter: [["list"], ["html", { open: "never" }]]`, `outputDir: "test-results"`, `use: { locale: "en-GB", timezoneId: "UTC", trace: "on-first-retry", screenshot: "only-on-failure", video: "retain-on-failure" }`.
- Projects:

| Project | Device | Notes |
| --- | --- | --- |
| `desktop` | 1440 × 900 Chromium | runs every spec except `mobile.spec.ts` |
| `mobile` | 390 × 844, touch, device scale 3 | runs `mobile.spec.ts`, `a11y.spec.ts`, `workflow.spec.ts` |
| `no-webgl` | Chromium with `--disable-gpu --disable-webgl --disable-webgl2` | runs `fallback.spec.ts`, `workflow.spec.ts` |
| `reduced-motion` | desktop, `reducedMotion: "reduce"` | runs `scene.spec.ts` |
| `dark` | desktop, `colorScheme: "dark"` | runs `a11y.spec.ts` |

  Chromium comes from `npx playwright install chromium`. Launch args add `--use-angle=swiftshader --enable-unsafe-swiftshader` on Linux so WebGL works without a GPU. No `channel: "chrome"`, no `--use-angle=metal`.
- `e2e/fixtures.ts` extends `test` with:
  - `server` (worker scope): a temp data dir, `importReference`, then `node src/server/main.ts` with `CABIN_KIT_PORT=0`, `CABIN_KIT_TEST_FAULTS=1`, `CABIN_KIT_WEB_ROOT=dist/web-e2e`, `CABIN_KIT_LOG_LEVEL=warn`; resolves when stdout prints `listening on`; exposes `{ baseURL, dataDir, restart(), stop() }`; teardown sends SIGTERM, waits 3 s, then SIGKILL, and removes the temp dir. Server stderr is attached to the test report on failure.
  - `api` (test scope): `createVisit(tail, date)`, `addRecord(visitId, record)`, `complete(visitId)`, `setFault(body)`; its teardown always clears faults.
  - `visit` (test scope): a fresh draft on `N100TL` / `2026-11-12` created through `api`.
  - `page` override: fails the test at teardown if the page logged an uncaught error or a console error, **including** failed resource loads, except those a test explicitly allows with `allowConsoleErrors(/pattern/)`.
- `e2e/helpers.ts`:
  - `selectLocation(page, label: string)`: types into go-to, presses Enter, then `await expect(page.getByRole("heading", { name: label, exact: false })).toBeVisible()` on the inspector heading. It waits for **that** label.
  - `setDate(page, iso: string)`: `page.getByLabel(/date/i).fill(iso)`; no keystroke typing.
  - `scene(page)`: evaluates `window.__cabinKit.scene.describe()`.
  - No function in `e2e/` calls `waitForTimeout`. A conventions test (`tests/unit/conventions.test.ts`) fails on `/waitForTimeout\(/` under `e2e/`.
- Scripts: `test:e2e` = `npm run build:e2e && playwright test`; `test:e2e:ui` = `playwright test --ui`.
- CI: a job `e2e` on `ubuntu-latest`: `npm ci`, `npx playwright install --with-deps chromium`, `npm run test:e2e`, upload `playwright-report/` and `test-results/` as artifacts always.

**Spec files.** Port every one of the 62 checks; keep a table in the pull request description mapping each old check name to its new test. Checks that only wrote files (samples, captures, performance) move to Task 6.2, not here.

| File | Covers |
| --- | --- |
| `lookup.spec.ts` | every lookup state on the page, date boundaries, URL carries tail and date, Back restores the result |
| `workflow.spec.ts` | the README walk-through by keyboard only: skip link keeps the route; go-to; record; alternate; complete; six totals on the report; JSON download, server PDF and printed PDF carry the same six totals |
| `scene.spec.ts` | pick selects and syncs with the map; hidden layer never blocks a pick (assert the seat **behind** the hidden bin is selected, not merely that nothing happened); camera presets; saving does not move the camera (compare `describe().camera` before and after); resize keeps a free camera; tab switch keeps one scene; 20 family switches leave `geometries` and `textures` counts unchanged; with reduced motion a preset is applied within one frame |
| `conflict.spec.ts` | two pages on one visit: stale edit shows both values and keeps typed input; unknown outcome then "Retry safely" saves once; an edit racing completion |
| `failures.spec.ts` | the eight failure conditions with recovery; each sets its fault or route inside the test and relies on fixture teardown to clear it |
| `persistence.spec.ts` | a draft survives `server.restart()`; resume link; completed visit is locked |
| `fallback.spec.ts` | WebGL unavailable: notice, map takes over, whole workflow still completes |
| `candidates.spec.ts` | Layouts and Reference views; candidate layouts cannot start a visit |
| `prep.spec.ts` | preparation overview, filter, CSV export content and filename |
| `mobile.spec.ts` | layout at 390 × 844; one-finger vertical drag over the canvas scrolls the page; a two-finger pinch that ends does not select; URL-bar style viewport height change keeps the camera; visit map and report reachable |
| `a11y.spec.ts` | axe (WCAG 2.1 A and AA, all impacts) on check, visit (3D), visit (map), completion dialog open, report, preparation, visits, layouts, reference; zero violations |
| `security.spec.ts` | no CSP violation events during the workflow (listen for `securitypolicyviolation`); response headers on `/` and an asset |

- [ ] **Step 1: Scaffold** config, fixtures and helpers; port `lookup.spec.ts` first. Run `npm run test:e2e -- lookup`. Expected: PASS on `desktop`.
- [ ] **Step 2: Port the remaining specs** one file per commit-sized step, deleting the corresponding block from `run.ts` as each lands, so nothing is covered twice or dropped.
- [ ] **Step 3: Prove isolation.** `npx playwright test --repeat-each 3 --workers 4` passes. `npx playwright test e2e/failures.spec.ts -g "reference unavailable"` passes alone. Insert `expect(1).toBe(2)` into the first test of `failures.spec.ts`, run the file, confirm every other test in it still passes and a screenshot and trace exist for the failure; remove the line.
- [ ] **Step 4: Prove it runs without a GPU.** `docker run --rm -v "$PWD":/w -w /w mcr.microsoft.com/playwright:<matching tag> npm run test:e2e`, or push the branch and read the CI job. Record which one was done.
- [ ] **Step 5: Delete** `tests/e2e/`. Run `npm run check && npm run test:e2e`. **Commit** `test(e2e): isolated Playwright specs, five projects, Linux CI (TST-02, TST-03, TST-04, TST-08)`.

---

### Task 6.2: Evidence is captured on purpose, not by the test run

Closes TST-05.

**Files:**
- Create: `tools/capture-evidence.ts`
- Modify: `tools/make-comparisons.mjs`, `package.json`, `.gitignore`, `verification/README.md`, `README.md`, `docs/operations.md`
- Remove from tracking: files under `verification/` that no document refers to after this task

**Interfaces:**
- `npm run evidence:capture` runs `tools/capture-evidence.ts`: starts a disposable server on the e2e build (reuse `e2e/fixtures.ts` start logic by importing a plain function from `e2e/server.ts`), drives Chromium with Playwright's library API, and writes to `verification/out/` (git-ignored): the 19 captures and `captures.json`, the sample visits, reports, PDFs and CSV, `performance.json`, `webgl.json`, `framing.json`, the axe JSON, and `vitest-output.txt` (by running `vitest run --reporter verbose`).
- `--promote` copies a **curated subset** from `verification/out/` to `verification/`: captures, comparison sheets, samples and `performance.json`. Promotion normalises what would otherwise churn: timestamps are written only into one file, `verification/PROVENANCE.json` (`{ capturedAt, commit, machine, node, browser }`); the sample visit is created with a fixed idempotency key and `options.now`, so its ids differ but its content, totals and report body are stable. PNG and PDF bytes will still differ between machines; that is why promotion is a human decision.
- Performance thresholds (frame rate, pick latency) are checked only by `evidence:capture --assert-perf`, never by `test:e2e`.
- `npm run comparisons` reads captures from `verification/out/captures` and the 14 image originals from `../../`; if the images are absent it exits 0 with "image originals not present; skipped".
- Scripts: `verify` = `npm run check && npm run build && npm run test:e2e && npm run originals:verify`. It writes nothing tracked. Add a CI step after tests: `git diff --exit-code` must be clean.
- `verification/README.md` is rewritten to say: what is committed and when it was captured (from `PROVENANCE.json`); that test results live in CI, not in the repository; the exact commands. The sentence "Regenerate all of it with `npm run verify`" is removed.

- [ ] **Step 1: Write the check first:** add to CI and to a local script `npm run verify:clean` = `npm run verify && git diff --exit-code && test -z "$(git status --porcelain)"`. Run it. Expected: FAIL (the tree is dirty after E2E until this task is done; after Task 6.1 the old writer is gone, so confirm what, if anything, still writes).
- [ ] **Step 2: Implement** the tool and the script changes. Decide file by file what stays tracked under `verification/`: keep `captures/`, `comparisons/`, `samples/`, `performance.json`, `PROVENANCE.json`, `README.md`; untrack `e2e/` results, `vitest-output.txt`, `console-output.txt`, axe JSON.
- [ ] **Step 3: Run** `npm run evidence:capture -- --promote` once on the reference machine, look at every promoted image, and commit them with the phase's final renders.
- [ ] **Step 4: Run** `npm run verify:clean` twice in a row. Expected: PASS both times, tree clean.
- [ ] **Step 5: Commit** `chore(verification): capture evidence deliberately; verify leaves the tree clean (TST-05)`.

---

### Task 6.3: Race tests without wall-clock luck

Closes TST-06.

**Files:**
- Modify: `tests/process/race.test.ts`, `tests/process/worker.ts`

**Interfaces:**
- Worker protocol over stdio: the worker opens the store, prints `ready\n`, then blocks on one line from stdin (`go\n`), performs its operation, prints one JSON result line, and exits. The parent spawns all workers, waits for every `ready`, then writes `go` to each in the order the case requires.
- Ordered cases replace "both orderings were observed": for each race, two explicit tests, one releasing A then B after A's result line arrives, one releasing B then A. Each asserts the exact outcome for that order.
- Unordered cases (true simultaneity: `go` written to all workers in one tick) assert only invariants that hold for every interleaving: exactly one winner where one is required; the loser's error code is one of the allowed set; the final store state equals what the winner's order implies; no partial rows; the report, if any, contains exactly the records that committed before completion.
- `START_DELAY`, the busy-spin and the skew constants are deleted. No test asserts that a particular interleaving occurred.

- [ ] **Step 1: Rewrite the worker and one race** (two editors of one record) in the new protocol. Run it 50 times: `for i in $(seq 50); do npx vitest run tests/process/race.test.ts -t "two editors" || break; done`. Expected: 50 passes.
- [ ] **Step 2: Port the remaining races** (edit vs removal vs completion; concurrent completion; many writers on different records).
- [ ] **Step 3: Stress under load:** run the file while `yes > /dev/null &` occupies every core (`for i in $(seq $(sysctl -n hw.ncpu)); do yes > /dev/null & done`), then `kill %1 …`. Expected: PASS. This is the condition the old tests could not survive.
- [ ] **Step 4: Commit** `test(process): deterministic barrier for race tests (TST-06)`.

---

### Task 6.4: Tests that check what their names say

Closes TST-07 and the vitest parts of TST-09 not already covered.

**Files:**
- Modify: `tests/integration/visitStore.test.ts`, `tests/integration/referenceStore.test.ts`, `tests/helpers.ts`

**Changes, one per finding:**

| Location (as of `5d6679d`) | Change |
| --- | --- |
| `visitStore.test.ts:301-310` "changing the lookup form cannot retarget an existing visit" | Rewrite to do what it says: create a visit on `N100TL`; activate a second release in which `N100TL` resolves to a different variant; assert `getVisit` returns the original snapshot hash and variant, and a record valid only under the new variant is refused. Rename to "a new reference release cannot retarget an existing visit". |
| `referenceStore.test.ts:114-138` "…activates a new one mid-flight" | Make it mid-flight: open two store connections; on connection 1 begin `loadRelease` through a test seam that pauses after reading the head row (inject an optional `onAfterHead` callback parameter used only by this test); on connection 2 activate a new release; resume; assert the loaded release is internally consistent (its content hash verifies). |
| `referenceStore.test.ts:272-284` "path configuration is shared by seed and start" | Replace the POSIX literals with `join(tmpdir(), …)`. Add a process test that runs `tools/seed-sample-visits.ts` and `src/server/main.ts` with the same `CABIN_KIT_DATA_DIR` and asserts the server reports the seeded visit count on `/api/health`. |
| `visitStore.test.ts:94-99` assertions inside `catch` | `expect(() => …).toThrow(expect.objectContaining({ status: 409, code: "STALE_RECORD" }))` and a second assertion on `details.current`. |
| All integration tests that close resources as their last statement | Add to `tests/helpers.ts`: `export function track<T extends { close(): unknown }>(resource: T): T` and an `afterEach` that closes every tracked resource in reverse order, then removes temp dirs. Wrap every `makeApp`, `VisitStore.open`, `ReferenceStore.open/create` and raw `DatabaseSync` in `track`. Remove the trailing manual closes. |

- [ ] **Step 1: Make each change.** For the two rewritten tests, first break the behaviour they guard (temporarily return the active release's variant from `getVisit`; temporarily read the head outside the transaction) and confirm the new test fails, then restore.
- [ ] **Step 2: Add the remaining store tests** the audit lists as absent: `listVisits` with `q` containing `_` and `\`; technician with only whitespace and with control characters (define: trimmed; control characters refused with `INVALID_TECHNICIAN`); the same idempotency key used on two different visits (refused); `backupTo` an existing path (refused); a visit on a `PARTIAL` configuration completed, FINAL report retains the gaps.
- [ ] **Step 3: Run** `npm run check`. **Commit** `test: make four overclaiming tests check their claim; close resources on failure (TST-07, TST-09)`.

---

### Task 6.5: Budgets that fail the build

Protects the gains from Phases 1 and 5.

**Files:**
- Create: `tools/check-budgets.ts`, `budgets.json`
- Modify: `package.json`, `.github/workflows/ci.yml`, `vite.config.ts`

**Interfaces:**
- `budgets.json`:
  ```json
  {
    "bundle": { "indexJsGzipKb": 110, "sceneJsGzipKb": 190, "cssGzipKb": 8 },
    "api": { "mutationResponseBytes": 8000, "lookupGzipBytes": 30000 },
    "scene": { "triangles176": 600000, "drawCalls176": 34, "seatTriangles": 3200 },
    "coverage": { "domainLines": 90, "serverLines": 85, "importerLines": 85 }
  }
  ```
  Set each bundle number to the size measured after Phase 5, rounded up by 5 %; the numbers above are ceilings to stay under, not targets to grow into. If a measured value exceeds a ceiling above, fix the cause (see step 2) rather than raising it.
- `tools/check-budgets.ts`: gzips each file in `dist/web/assets`, classifies by name prefix, compares with `budgets.json`, prints a table, exits 1 on any excess. `npm run budgets` = `npm run build && node tools/check-budgets.ts`. CI runs it. The API and scene numbers are asserted in the tests that already measure them (Tasks 1.2, 1.5, 5.1); import the numbers from `budgets.json` there so there is one source.
- `vite.config.ts`: remove `chunkSizeWarningLimit`; add `build.rollupOptions.output.manualChunks` only if step 2 shows it helps; add `<link rel="modulepreload">` for the scene chunk on visit routes via Vite's default preload (verify it is emitted).

- [ ] **Step 1: Measure** the three bundle sizes now and write them in the commit body. At `5d6679d` they were, gzip -9: index 87.5 KB, scene 157.0 KB, CSS 4.1 KB.
- [ ] **Step 2: Reduce the scene chunk** if it is over the ceiling: import three.js by named module path (`three/src/...` is not supported for tree-shaking in all versions; check what `three` 0.187 exports and whether `import { X } from "three"` tree-shakes under Vite 8 with Rolldown; measure, do not assume). Confirm `OrbitControls`, `RoomEnvironment` and `RoundedBoxGeometry` are the only addons bundled.
- [ ] **Step 3: Implement** the tool and wire CI. Run `npm run budgets`. Expected: PASS.
- [ ] **Step 4: Commit** `ci: bundle, payload, geometry and coverage budgets`.

---

### Task 6.6: Documentation, version, closure

Ends the plan.

**Files:**
- Modify: `README.md`, `docs/operations.md`, `docs/logical-model.md`, `docs/visual-families.md`, `docs/missing-evidence.md`, `verification/README.md`, `SECURITY.md`, `CHANGELOG.md`, `package.json` (version `2.0.0`), `docs/audit-2026-11-15.md`

- [ ] **Step 1: README.** Quick start works from a clean clone (state it and test it: `git clone` into a temp dir, `npm run setup`, `npm start`, open the page). Update the commands table (new: `check`, `coverage`, `budgets`, `visits:backup`, `evidence:capture`, `test:e2e:ui`; changed: `verify`; test counts replaced by "see CI" so they cannot go stale). Update the configuration table (`CABIN_KIT_ALLOWED_HOSTS`, `CABIN_KIT_ALLOW_REMOTE`, `CABIN_KIT_LOG_LEVEL`, `CABIN_KIT_WEB_ROOT`, source-root precedence). Rewrite "Known limits" from what is true now.
- [ ] **Step 2: Operations.** Backup command, exit codes, migration behaviour on upgrade, what a `VISIT_SCHEMA_NEWER` or `SNAPSHOT_CORRUPT` error means and what to do, log levels and request ids.
- [ ] **Step 3: Audit closure.** Add a column "Closed by" to every table in `docs/audit-2026-11-15.md` with the task number and commit hash. For each finding, re-run the probe or test that showed it and confirm it no longer reproduces. Any finding not closed stays open in the table with the reason; do not mark a finding closed on the strength of having done its task.
- [ ] **Step 4: "Not verified" list.** Rewrite the section in `verification/README.md` honestly: real screen reader (done once by hand in Task 4.6, or not), browsers other than Chromium (run `npx playwright install firefox webkit` and the `workflow` and `a11y` specs once on each; record the result, including failures), hardware other than the reference machine, long-running use.
- [ ] **Step 5: CHANGELOG.** Under `2.0.0`: breaking changes (mutation responses without snapshot; report schema 2; content-hash change from Task 3.7; stricter validation may reject data that used to import; CLI exit code 64), then fixes and features by phase.
- [ ] **Step 6: Final gate.** From a fresh clone of the branch: `npm run setup && npm run verify:clean && npm run budgets && npm audit --omit=dev --audit-level=moderate`. Expected: all pass, tree clean. Open the app, do the walk-through in light and dark themes at desktop and phone widths, and print a report.
- [ ] **Step 7: Commit** `docs: 2.0.0, audit closure, updated operations and limits`.
