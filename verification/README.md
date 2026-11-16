# Verification

This folder holds curated evidence: renders of the 3D view, sheets comparing them with the supplied photographs, sample visits and reports, and one performance measurement. It is captured on purpose with `npm run evidence:capture` and committed by hand. No check or test run writes here.

## What is committed and when it was captured

`PROVENANCE.json` says when the files below were captured, the exact commit the renders were built from, and the machine, Node and browser (Chromium bundled with Playwright, headless). It is the only record of these; this page does not copy them. A capture made with changes outside `verification/` is never promoted, so the commit named there is the source of every render. The renderer is in `performance.json`.

| Path | What it is |
| --- | --- |
| `PROVENANCE.json` | When, where and from which commit the files below were captured. The two PDFs printed by Chromium also carry their own creation time |
| `captures/` | 18 renders of this build and `captures.json` (release, layout, visual family, light, camera, layers and viewport of each) |
| `comparisons/` | 12 sheets placing a supplied original beside a render, and `index.json` |
| `samples/` | Sample visits, their reports as JSON and PDF, and a preparation export |
| `performance.json` | Frame rate and selection feedback on the machine named in `PROVENANCE.json` |

PNG and PDF bytes differ between machines, so the files change only when someone promotes a new capture. Promoting is a decision: look at every image first.

## Test results

Test results live in CI, not in this repository: the workflow in `.github/workflows/ci.yml` runs Biome, the type check, both builds, the vitest suite with coverage and the Playwright browser tests on every push, and fails if the run changed the working tree. It has not run yet (see Not verified). Locally:

```
npm run verify          # check (Biome, tsc, vitest), build, browser tests, originals check; writes nothing tracked
npm run verify:clean    # verify, then fails unless the working tree is unchanged
```

Browser test reports go to the ignored `playwright-report/` and `test-results/` folders.

## How to capture evidence

```
npm run evidence:capture                     # everything below into verification/out/ (git-ignored)
npm run evidence:capture -- --assert-perf    # also fails under 30 fps or over 250 ms per pick
npm run evidence:capture -- --promote        # capture, then copy the curated subset here
npm run evidence:capture -- --promote-only   # copy what the last capture left in verification/out/ (--force if made at another commit)
npm run comparisons                          # only the comparison sheets, from verification/out/captures
```

`evidence:capture` builds the client with test hooks (`dist/web-e2e`), starts its own server with temporary stores (never `./data`) and drives Chromium. It writes to `verification/out/`: the 18 captures and `captures.json`, the samples, `performance.json`, `webgl.json` (renderer and scene description), `framing.json`, axe results for eight views in the light and dark themes and two at phone width (`axe/`), the comparison sheets, `vitest-output.txt` (every vitest test by name) and `PROVENANCE.json`. The sheets need the 14 image originals (`CABIN_KIT_SOURCE_ROOT`, else `../../`); without them they are skipped and nothing can be promoted. A capture with a failed step promotes nothing.

`--promote` replaces `captures/`, `comparisons/` and `samples/` wholesale (files no longer captured disappear) and replaces `performance.json` and `PROVENANCE.json`. It copies everything into a staging folder first and swaps it in only when the copy succeeded. It refuses when files outside `verification/` differ from HEAD, at capture time or now; `--promote-only` also refuses, unless given `--force`, when the capture was made at another commit than HEAD. The rest stays in `verification/out/`. The axe results are not curated, in either theme: the browser tests assert zero violations on every view in the light, dark and mobile projects on each run, so a stored copy would only go stale. The capture above recorded 0 violations on all 18 page states.

The sample visits are written with fixed idempotency keys and a fixed clock (2026-11-12T09:00:00Z), so a new capture gives them new ids but the same content, totals and report body. The PDFs Chromium prints (`sample-completed-report-browser-print.pdf` and the preparation PDF) are not reproducible byte for byte: they carry the time they were printed.

## Performance (`performance.json`)

176-seat layout, 1440×900, device pixel ratio 1, seats, floor and bins visible.

| Measure | Result | Target |
| --- | --- | --- |
| Frame rate during a 4 s continuous orbit | 59.8 fps (240 frames), worst frame 18.8 ms | about 30 fps |
| Selection feedback, pick to next rendered frame, 10 picks | median 8.2 ms, max 14.3 ms | within 250 ms |
| Scene size | about 489,000 triangles, 23 draw calls | — |

60 fps is the display cap in headless Chromium, so the true headroom is not measured. These figures apply only to the machine named in `PROVENANCE.json`. The targets are checked only by `evidence:capture -- --assert-perf`, never by the tests; the browser tests check the scene's draw-call and triangle budgets instead.

Framing (`framing.json` of the same capture, not committed): in the default cutaway view the cabin spans 74% of the canvas width and 64% of its height and lies wholly inside it. `e2e/scene.spec.ts` asserts this framing on every run.

## What the tests cover

Vitest (`npm test`; run `npm run evidence:capture` for `vitest-output.txt`, which lists every test by name):

- Import: registry counts (5 configurations, 147 row records, 837 seats), 16,641 values agreeing across JSON, CSV and XLSX, exact seat sets, template files rejected.
- Lookup: the lookup states, inclusive date boundaries, retrofit on 2026-07-01, overlap, gap, planned, expired source.
- Rule specificity: strict-subset dominance, ambiguity, dates as filters.
- Kits: mandatory children, expired alternates, units kept separate in totals.
- Visits: the six-line report totals, forged quantities and totals refused, stale edits refused, locked completion, immutable snapshot, idempotent retries, more than 100 visits.
- Stores: reset and import guards (same file, symlink, hard link, visit tables, foreign file), immutable releases, failed import leaves the previous release active.
- Separate processes: two editors of one record; edit, removal and completion racing each other; concurrent completion; many writers on different records.
- Web components and hooks in jsdom.

Playwright (`npm run test:e2e`, `e2e/*.spec.ts`, desktop, mobile, no-WebGL, reduced-motion and dark projects): lookup states in the page, the whole workflow by keyboard, 3D picking and synchronisation, draft persistence across a server restart, stale-edit conflict, failure conditions with recovery (including WebGL unavailable), partial configurations, preparation overview, candidate layouts, mobile viewport, security headers, and axe with zero violations of any impact on every view.

## Samples (`samples/`)

Both visits are on N100TL, 2026-11-12, technician "Sample Technician (fictional)", with the README walk-through's two records: seat 3A cushion, and the full-cabin carpet kit replaced by its approved alternate.

| File | What it is |
| --- | --- |
| `sample-completed-visit.json`, `sample-completed-report.json` | A completed visit and its stored report (schema `cabin-kit.report/2`) |
| `sample-completed-report.pdf` | The same report rendered by the server |
| `sample-completed-report-browser-print.pdf` | The report page printed by Chromium |
| `sample-draft-visit.json`, `sample-draft-report-preview.json`, `.pdf` | A draft and its preview (marked as not final). The JSON preview and its PDF (the server's renderer) are both built at the fixed clock |
| `sample-preparation-N100TL-2026-11-12.csv`, `.pdf` | Preparation overview export and the printed page |

The capture refuses to finish unless the sample report carries exactly the six expected totals. `e2e/workflow.spec.ts` checks on every run that the JSON download, the server PDF and the printed PDF carry the same six totals as the stored records. The earlier samples, with `cabin-kit.report/1` reports from before Phase 2, were replaced; stored `/1` reports are still served unchanged (decision D6) and are covered by `tests/integration/visitStoreCompat.test.ts`, not by samples here.

## Visual comparison

Method: `captures/` holds 18 renders from this build (`captures/captures.json`). The desktop captures hide the legend and the hover label and show no selection. The mobile capture shows the page's legend as a phone shows it, including the ochre selection swatch (Task 5.7). `comparisons/` holds 12 sheets placing a supplied original on the left and a render on the right (`comparisons/index.json`). I looked at each sheet and judged each feature. The judgments are mine, by eye. Nothing was measured, because no dimensions were supplied.

Every row below was re-judged in Task 6.2 against the 12 sheets committed here, which were made from the captures committed here (current build: Task 5.5 framing and bins at 1.62 m, the Task 5.6 shell and 2.45 m ceiling, the Task 5.7 ochre selection). No judgment moved. With the Task 5.5 focus framing the seat-front captures show several rows, so the seat finish is smaller in the frame than in the photographs. "Last changed" names the task that last changed the feature.

PASS means the feature is present and reads as the same thing. PARTIAL means present but visibly different. FAIL means absent or wrong. UNKNOWN means the originals do not settle what is correct.

| Feature | Last changed | Original(s) | Sheet | Result | Note |
| --- | --- | --- | --- | --- | --- |
| Three-abreast seats each side of one aisle | | `seats 2 .jpeg`, `southwest seats-7.webp` | 10, 11 | PASS | |
| Separate headrest, back and pan | | `recarro 2.jpg`, `seats 5.jpg` | 01, 03 | PASS | |
| Headrest with projecting side wings | | `recarro 2.jpg`, PNG video still | 01, 04 | PARTIAL | Wings present. The model's headrest is a thick rounded block; the originals show a slimmer, gently curved pad |
| Pale face on the headrest wing | | `seats 5.jpg`, PNG video still | 03, 04 | PARTIAL | Present on one side as in the originals, but flatter and more rectangular |
| Headrest width relative to the back | | `recarro 2.jpg` against `seats 5.jpg` | 01, 03 | UNKNOWN | The two originals differ. The model uses the narrower form for every family |
| Pale angled band on the upper back (band family) | | `recarro 2.jpg`, `seats 1.jpeg` | 01, 02 | PARTIAL | Present and pale. The original band has a clearer diagonal lower edge |
| No band (plain family) | | `seats 5.jpg` | 03 | PASS | |
| Stitch lines on the lower back | 5.3 | `seats 1.jpeg`, `seats 5.jpg` | 02, 03 | PARTIAL | Clear in relief under both lights. The model repeats many short chevrons where the originals show a few long converging diagonals |
| Concept gray colour and bold stitching | 5.3 | PNG video still, `seats 8.jpg` | 04, 05 | PARTIAL | Stitched channels read as sewn grooves. The model's covering is paler and cooler (lilac) than the concept render's warm taupe, and its chevrons replace the render's finer, flatter lines |
| Leather sheen and seam detail | 5.3 | `seats 5.jpg`, `recarro 2.jpg` | 01, 03 | PARTIAL | Seams, channels and piped edges are in relief and the leather has a soft sheen. The photographed leather is glossier, with bright specular highlights the model does not reach |
| Pale arms with dark pads | | `seats 1.jpeg`, `carpet.jpg` | 02, 08 | PASS | |
| Silver legs | 5.3 | `seats 1.jpeg`, `seats 4.jpg` | 02, 09 | PASS | Pale metallic legs along the aisle. The frame is simplified |
| Pale rear shell with dark top edge | | `southwest seats-7.webp` | 06 | PASS | |
| Rear-shell furniture: literature ledge, device ledge, tray and latch, mesh pocket | | `southwest seats-7.webp`, `seats 3.jpg` | 06, 07 | PARTIAL | All present. The original shell is a rounded moulding with a fold-out device holder; the model is flat panels |
| Two-opening panel on the rear shell | | `seats 3.jpg`, `seats 4.jpg` | 07 | UNKNOWN | Drawn on every shell. The originals show it only on the seats in view; no availability claim is made |
| Dashed-arc carpet | | `carpet.jpg` | 08 | PASS | Arc scale is close; the original's arcs are less regular |
| Pale border strips along the aisle | | `carpet.jpg` | 08 | PASS | |
| Convex pale bin doors with seams and handle | | `seats 4.jpg`, `seats 2 .jpeg` | 09, 10 | PARTIAL | Shape and seams read correctly. Handle size and door depth are guesses |
| Segmented bin underside with service units | 5.6 | `seats 4.jpg` | 09 | PARTIAL | Segments and round fittings present; far less detail than the original. Below the bins the shell shows a pale ledge where it steps out behind them, but not the original's lit wash under the bins |
| Window surrounds | 5.6 | `seats 5.jpg`, `recarro 2.jpg`, `seats 4.jpg` | 01, 03, 09 | PARTIAL | Rounded-rectangle recesses with a reveal, one per row pitch, set into a curved sidewall. The originals' windows are rounder, with a bright pane and a thicker moulded surround; the model's panes are a dim blue-grey. Only in the optional context layer |
| Ceiling arch | 5.6 | `seats 2 .jpeg`, `southwest seats-7.webp` | 10, 11 | PARTIAL | A closed ceiling arching 12 cm from just above the bin tops to 2.45 m over the aisle, with a glowing light channel along each bin edge; the bins are whole beneath it. The original's ceiling is a much deeper dome, brightly lit from its centre; the model's is shallow and evenly lit. Only in the optional context layer |
| Blue cabin light | 5.3 | `seats 1.jpeg`, `seats 4.jpg`, `seats 5.jpg` | 02, 03, 09 | PARTIAL | A blue wash with pale whites, as in the photographs, and not oversaturated. Dimmer and greyer than the luminous blue of `seats 1.jpeg` and `seats 5.jpg`. The ceiling's light channels and faint glow (5.6) show only in the optional context layer |
| Neutral light | 5.3 | `recarro 2.jpg` | 01 | PARTIAL | Environment light with a key from the window side gives the forms direction and soft modelling. No hard sunlit highlights or cast shadows as in the original |
| Seat belts, heart mark, literature cards | | several | — | FAIL (by decision) | Not modelled. Brand marks are deliberately left out |
| Galleys, barrier, lavatories | | `barrier.webp`, `rear galley.jpg`, `forward galley flight deck.jpg` | — | FAIL (by decision) | Not modelled. The context layer has only a plain translucent bulkhead at each end |
| Dimensions, pitch, proportions | | — | — | UNKNOWN | Nothing supplied gives a dimension |
| True colours | | — | — | UNKNOWN | Every photograph is under tinted or strong light |
| Which family belongs to which layout | | — | — | UNKNOWN | No supplied file says |

Summary (re-judged in Task 6.2 against the committed sheets): 8 PASS, 13 PARTIAL, 2 FAIL, 5 UNKNOWN. Still PARTIAL: the headrest (a thick rounded block, not the slim curved pad), the band edge, the stitching pattern, the concept colour, leather gloss, the flat rear-shell panels, bin detail, windows, the shallow evenly lit ceiling, and both lights (the blue is dimmer and greyer; the neutral has no hard sunlit highlights). The two FAIL rows are deliberate omissions (brand marks, galleys). The model is recognisable as the cabin in the photographs and works as a spatial index for picking seats, floor areas and bins. It is not a faithful reproduction. The headrest shape is the weakest point; the material finish is closer but less glossy than the photographed leather.

## Other records

- Originals unchanged: `npm run originals:verify` checks the 23 SHA-256 values in `../evidence/originals-manifest.json` (the 14 images only where `../../` is present).
- Baseline tests (isolated copy): see `../inspection/baseline-run-record.md` and `../inspection/logs/`.

## Not verified

Written for 2.0.0 (Task 6.6). Each item says what was and was not done.

- **A real screen reader.** Not done. No one has run the walk-through with VoiceOver (or any screen reader) and listened to it; see the next section for what is checked automatically instead. This should be done by a person before release.
- **Browsers other than Chromium.** The browser tests run on the Chromium bundled with Playwright. On the reference machine (macOS 27.3, Playwright 1.65.1) the `workflow` and `a11y` specs were run once on the other two engines, without changing anything to make them pass:
  - **WebKit 27.2** (as the `desktop` and `dark` projects): 19 passed, 4 failed, 4 skipped by the specs' own project rules. Failing: the keyboard walk-through (the first Tab does not focus "Skip to content"; WebKit's default of not moving focus to buttons with Tab may be the cause, not confirmed); "Go to location" then Enter does not select "Full cabin floor", which fails the axe check on the map view (desktop and dark) and the screen-reader structure check; and every failing test also logged a console error, "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive", that Chromium does not log. Cause not investigated. The other axe checks (eight views, light and dark) and the theme checks passed.
  - **Firefox** (Playwright's Nightly build 1572): not run. The browser does not start on this machine ("Could not find profile folder", also when started directly and after a forced reinstall), so no Firefox behaviour was observed.
- **The PDFs in a desktop viewer.** The server PDF and the Chromium-printed report were opened with pdfjs (text, page count, the six totals); neither has been opened in Preview or Acrobat by a person, so layout, tagging and reading order in a real viewer are unchecked.
- **Linux, and WebGL without a GPU.** The CI workflow (`.github/workflows/ci.yml`, Ubuntu with SwiftShader) has never run: nothing was pushed and no container was available. Everything here ran on one Mac with a GPU.
- **Hardware other than the reference machine** (named in `PROVENANCE.json`). Frame rate on weaker hardware, integrated graphics or a real phone is unknown; the mobile project is Chromium emulating a 390x844 touch viewport.
- **A clean clone outside the development folder.** Setup, import and start work there, and the browser tests do not need the images. But `originals:verify`, and the vitest test that runs it, treat `../../` as the image folder whenever it exists, so in such a clone (and on a CI runner) they report the 14 images missing and `npm run check` and `npm run verify` fail. The final check for 2.0.0 was therefore run in a clone with `CABIN_KIT_SOURCE_ROOT` pointing at the originals.
- **Long-running use.** No soak test: a server left running for days, visit stores far beyond the 100-plus visits in the tests, or more than two concurrent writers.
- **The baseline in a browser.** Its tests and linter were run in an isolated copy; its pages were not exercised.
- **Live web links cited in the DOCX** (only with `evidence:build -- --online`, not run for this release).
- **Agreement of any candidate data with a real aircraft.**

## Screen reader pass (VoiceOver, manual)

Not done. Task 4.6 asks for one pass of the README walk-through by keyboard only with VoiceOver on, writing down what was announced at each step. The task was carried out by an automated agent that cannot run VoiceOver or hear its output, so no announcements were observed and none are claimed here.

What is checked automatically instead: the jsdom tests in `tests/web/a11y.test.tsx` (focus moves to the view heading on a route change and the page title is placed in a polite live region; the completion dialog is a native modal `<dialog>`, starts on Cancel, and returns focus to "Complete visit…" on Cancel or Escape; the view tabs follow the WAI-ARIA tabs pattern; "Go to parts" and Enter on the canvas focus the inspector heading; the canvas has `role="application"` and a described list of keys), and the keyboard-only workflow in `e2e/workflow.spec.ts`, which also checks in the browser that Tab and Shift+Tab never leave the open completion dialog. This pass should still be done by a person with VoiceOver before release.
