# Verification

Everything in this folder was produced by running this build on the machine described below. Figures quoted here come from the files named beside them. Regenerate all of it with `npm run verify`.

Last full run: 2026-11-15 (UTC), after the final source change.

## Results

| Check | Command | Result | Record |
| --- | --- | --- | --- |
| Type check | `npx tsc --noEmit` | no errors | — |
| Unit, integration, separate-process tests | `npx vitest run` | 132 passed, 0 failed, 7 files | `vitest-output.txt` |
| End-to-end in Chrome | `node tests/e2e/run.ts` | 62 of 62 checks passed | `e2e/e2e-results.txt`, `e2e/e2e-results.json`, `e2e/console-output.txt` |
| Accessibility (axe-core, WCAG A/AA, serious and critical) | part of E2E | 0 violations on 10 page states | `e2e/axe-*.json` |
| Originals unchanged | `node tools/verify-originals.ts` | 23 of 23 SHA-256 values unchanged | `../evidence/originals-manifest.json` |
| Baseline tests (isolated copy) | see `../inspection/baseline-run-record.md` | pytest 52 passed; ruff 0 findings | `../inspection/logs/` |

Machine: Apple M4 Pro, 14 cores, 24 GB, macOS (darwin 27.3.0), Node v24.16.0, Chrome 157.0.8103.51 headless, WebGL 2 through ANGLE Metal.

## Performance (`performance.json`)

176-seat layout, 1440×900, device pixel ratio 1, seats, floor and bins visible.

| Measure | Result | Target |
| --- | --- | --- |
| Frame rate during a 4 s continuous orbit | 60.1 fps (241 frames), worst frame 19 ms | about 30 fps |
| Selection feedback, pick to next rendered frame, 10 picks | median 8.7 ms, max 10.5 ms | within 250 ms |
| Scene size | about 1.31 million triangles, 23 draw calls | — |

60 fps is the display cap in headless Chrome, so the true headroom is not measured. These figures apply to this machine only.

Framing (`e2e/framing.json`): in the default cutaway view the cabin spans 74% of the canvas width and 63% of its height and lies wholly inside it.

## What the tests cover

Vitest (`vitest-output.txt` lists every test by name):

- Import: registry counts (5 configurations, 147 row records, 837 seats), 16,641 values agreeing across JSON, CSV and XLSX, exact seat sets, template files rejected.
- Lookup: the lookup states, inclusive date boundaries, retrofit on 2026-07-01, overlap, gap, planned, expired source.
- Rule specificity: strict-subset dominance, ambiguity, dates as filters.
- Kits: mandatory children, expired alternates, units kept separate in totals.
- Visits: the six-line report totals, forged quantities and totals refused, stale edits refused, locked completion, immutable snapshot, idempotent retries, more than 100 visits.
- Stores: reset and import guards (same file, symlink, hard link, visit tables, foreign file), immutable releases, failed import leaves the previous release active.
- Separate processes: two editors of one record; edit, removal and completion racing each other; concurrent completion; many writers on different records.

E2E (`e2e/e2e-results.txt`): lookup states in the page, whole workflow by keyboard, 3D picking and synchronisation, draft persistence across a server restart, stale-edit conflict, eight failure conditions with recovery (including WebGL unavailable), partial configurations, preparation overview, candidate layouts, mobile viewport, accessibility.

## Samples (`samples/`)

| File | What it is |
| --- | --- |
| `sample-completed-visit.json`, `sample-completed-report.json` | A completed visit and its stored report |
| `sample-completed-report.pdf` | The same report rendered by the server |
| `sample-completed-report-browser-print.pdf` | The report page printed by Chrome |
| `sample-draft-visit.json`, `sample-draft-report-preview.json`, `.pdf` | A draft and its preview (marked as not final) |
| `sample-preparation-N100TL-2026-11-12.csv`, `.pdf` | Preparation overview export |

The E2E run checks that the JSON, the server PDF and the printed PDF carry the same six totals as the stored records.

## Visual comparison

Method: `captures/` holds 19 real renders from this build (`captures/captures.json` records release, layout, profile, light, camera and layers for each). `comparisons/` holds 12 sheets placing a supplied original on the left and a render on the right (`comparisons/index.json`). I looked at each sheet and judged each feature. The judgments are mine, by eye. Nothing was measured, because no dimensions were supplied.

The six rows marked "(5.3)" were re-judged after Task 5.3 (environment light, physical upholstery with stitched normal maps, contact shading) against sheets regenerated from that commit's renders with `npm run test:e2e && npm run comparisons`; those regenerated captures and sheets are not committed, so the files in `captures/` and `comparisons/` may predate the judgment.

PASS means the feature is present and reads as the same thing. PARTIAL means present but visibly different. FAIL means absent or wrong. UNKNOWN means the originals do not settle what is correct.

| Feature | Original(s) | Sheet | Result | Note |
| --- | --- | --- | --- | --- |
| Three-abreast seats each side of one aisle | `seats 2 .jpeg`, `southwest seats-7.webp` | 10, 11 | PASS | |
| Separate headrest, back and pan | `recarro 2.jpg`, `seats 5.jpg` | 01, 03 | PASS | |
| Headrest with projecting side wings | `recarro 2.jpg`, PNG video still | 01, 04 | PARTIAL | Wings present. The model's headrest is a thick rounded block; the originals show a slimmer, gently curved pad |
| Pale face on the headrest wing | `seats 5.jpg`, PNG video still | 03, 04 | PARTIAL | Present on one side as in the originals, but flatter and more rectangular |
| Headrest width relative to the back | `recarro 2.jpg` against `seats 5.jpg` | 01, 03 | UNKNOWN | The two originals differ. The model uses the narrower form for every family |
| Pale angled band on the upper back (band family) | `recarro 2.jpg`, `seats 1.jpeg` | 01, 02 | PARTIAL | Present and pale. The original band has a clearer diagonal lower edge |
| No band (plain family) | `seats 5.jpg` | 03 | PASS | |
| Stitch lines on the lower back (5.3) | `seats 1.jpeg`, `seats 5.jpg` | 02, 03 | PARTIAL | Now clear in relief under both lights. The model repeats many short chevrons where the originals show a few long converging diagonals |
| Concept gray colour and bold stitching (5.3) | PNG video still, `seats 8.jpg` | 04, 05 | PARTIAL | Stitched channels now read as sewn grooves. The covering is paler and cooler (lilac) than the render's warm taupe, and its chevrons replace the render's finer, flatter lines |
| Leather sheen and seam detail (5.3) | `seats 5.jpg`, `recarro 2.jpg` | 01, 03 | PARTIAL | Seams, channels and piped edges are in relief and the leather has a soft sheen and faint clear coat. The photographed leather is glossier, with bright specular highlights the model does not reach |
| Pale arms with dark pads | `seats 1.jpeg`, `carpet.jpg` | 02, 08 | PASS | |
| Silver legs (5.3) | `seats 1.jpeg`, `seats 4.jpg` | 02, 09 | PASS | Now metallic, reflecting the cabin light. The frame is still simplified |
| Pale rear shell with dark top edge | `southwest seats-7.webp` | 06 | PASS | |
| Rear-shell furniture: literature ledge, device ledge, tray and latch, mesh pocket | `southwest seats-7.webp`, `seats 3.jpg` | 06, 07 | PARTIAL | All present. The original shell is a rounded moulding with a fold-out device holder; the model is flat panels |
| Two-opening panel on the rear shell | `seats 3.jpg`, `seats 4.jpg` | 07 | UNKNOWN | Drawn on every shell. The originals show it only on the seats in view; no availability claim is made |
| Dashed-arc carpet | `carpet.jpg` | 08 | PASS | Arc scale is close; the original's arcs are less regular |
| Pale border strips along the aisle | `carpet.jpg` | 08 | PASS | |
| Convex pale bin doors with seams and handle | `seats 4.jpg`, `seats 2 .jpeg` | 09, 10 | PARTIAL | Shape and seams read correctly. Handle size and door depth are guesses |
| Segmented bin underside with service units | `seats 4.jpg` | 09 | PARTIAL | Segments and round fittings present; far less detail than the original |
| Window surrounds | `seats 5.jpg`, `recarro 2.jpg` | 01, 03 | PARTIAL | Plain ovals on a flat sidewall, one per row. Only in the optional context layer |
| Ceiling arch | `seats 2 .jpeg` | 10 | FAIL | The model has no sculpted ceiling; it is open above the bins |
| Blue cabin light (5.3) | `seats 1.jpeg`, `seats 4.jpg`, `seats 5.jpg` | 02, 03, 09 | PARTIAL | A blue wash with pale whites, as in the photographs, and no longer oversaturated. Still dimmer and greyer than the luminous blue of `seats 1.jpeg` and `seats 5.jpg`, with no glow from the ceiling |
| Neutral light (5.3) | `recarro 2.jpg` | 01 | PARTIAL | Environment light with a key from the window side gives the forms direction and soft modelling. No hard sunlit highlights or cast shadows as in the original |
| Seat belts, heart mark, literature cards | several | — | FAIL (by decision) | Not modelled. Brand marks are deliberately left out |
| Galleys, barrier, lavatories | `barrier.webp`, `rear galley.jpg`, `forward galley flight deck.jpg` | — | FAIL (by decision) | Not modelled. The context layer has only a plain translucent bulkhead at each end |
| Dimensions, pitch, proportions | — | — | UNKNOWN | Nothing supplied gives a dimension |
| True colours | — | — | UNKNOWN | Every photograph is under tinted or strong light |
| Which family belongs to which layout | — | — | UNKNOWN | No supplied file says |

Summary: 8 PASS, 12 PARTIAL, 3 FAIL, 5 UNKNOWN. The model is recognisable as the cabin in the photographs and works as a spatial index for picking seats, floor areas and bins. It is not a faithful reproduction. The headrest shape is now the weakest point; the material finish is closer but less glossy than the photographed leather.

## Not verified

- A real screen reader. The checks are axe-core plus structural assertions (landmarks, headings, labels, live regions) and a keyboard-only run.
- Any browser other than Chrome 157, and any device other than this one. The mobile check is Chrome emulating a 390×844 touch viewport, not a phone.
- Frame rate on weaker hardware or integrated graphics.
- The PDFs in viewers other than the text extraction used by the tests. I did not open them in Preview or Acrobat.
- The baseline in a browser. Its tests and linter were run in an isolated copy; its pages were not exercised.
- Live web links cited in the DOCX.
- Long-running use, large visit stores beyond the 100-plus visits in the tests, and more than two concurrent writers.
- Agreement of any candidate data with a real aircraft.

## Screen reader pass (VoiceOver, manual)

Not done. Task 4.6 asks for one pass of the README walk-through by keyboard only with VoiceOver on, writing down what was announced at each step. The task was carried out by an automated agent that cannot run VoiceOver or hear its output, so no announcements were observed and none are claimed here.

What is checked automatically instead: the jsdom tests in `tests/web/a11y.test.tsx` (focus moves to the view heading on a route change and the page title is placed in a polite live region; the completion dialog is a native modal `<dialog>`, starts on Cancel, and returns focus to "Complete visit…" on Cancel or Escape; the view tabs follow the WAI-ARIA tabs pattern; "Go to parts" and Enter on the canvas focus the inspector heading; the canvas has `role="application"` and a described list of keys), and the keyboard-only workflow in `tests/e2e/run.ts`. Whether focus stays inside the open dialog is a browser behaviour that jsdom cannot show; it is left to the Playwright work in Task 6.1. This pass should still be done by a person with VoiceOver before release.
