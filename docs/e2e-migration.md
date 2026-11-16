# Browser checks: old runner to Playwright specs

In 2.0.0 the single-page runner `tests/e2e/run.ts` (86 checks sharing one page, one server and one store) was replaced by isolated `@playwright/test` specs in `e2e/` (Task 6.1, TST-02, TST-03, TST-04, TST-08). This table says where each old check went. Checks marked "Moved to 6.2" or "Dropped here" only wrote evidence files; that is now `npm run evidence:capture` (Task 6.2, TST-05), and no spec writes into `verification/`.

Projects: `desktop`, `mobile` (390 x 844 touch), `no-webgl`, `reduced-motion` and `dark`, all on the Chromium bundled with Playwright. See `playwright.config.ts` for which spec runs in which project.

The old runner printed 86 checks: 66 `check(` calls, three of which loop (9 lookups, 7 axe, 7 dark axe).

| # | Old check (group) | New spec › test (projects) |
|---|---|---|
| 1–9 | `N999ZZ … UNKNOWN_TAIL`, `N000TL … UNCONFIGURED`, `N500TL 2026-03-01 … UNCONFIGURED`, `N400TL … OVERLAP`, `N110TL … PLANNED`, `N600TL … SOURCE_INVALID`, `N090TL … PARTIAL`, `N200TL 2026-06-30 … RESOLVED`, `N200TL 2026-07-01 … RESOLVED` (lookup) | lookup.spec › same nine names (desktop) |
| 10 | N200TL retrofit boundary shows V05 then V04 | lookup.spec › same name |
| 11 | empty tail is reported as invalid input | lookup.spec › same name |
| – | (new) URL carries tail and date, Back restores | lookup.spec › the URL carries tail and date, and Back restores the earlier result |
| 12 | look up N100TL and start a visit using only the keyboard | workflow.spec › README walk-through, step "look up N100TL and start a visit using only the keyboard" (desktop, mobile, no-webgl) |
| – | (new) skip link keeps the route | workflow.spec › step "the skip link is the first tab stop and keeps the route" |
| 13 | select seat 3A in the map with arrow keys and record the cushion | workflow.spec › step of the same name |
| 14 | select the full-cabin floor, choose the approved alternate and record it | workflow.spec › step of the same name |
| 15 | draft is saved: sample draft exported | workflow.spec › step "the draft is saved and its report is a draft preview". **Dropped here:** writing `sample-draft-visit.json`, `sample-draft-report-preview.json/.pdf` (6.2) |
| 16 | complete requires an explicit confirmation and opens the locked report | workflow.spec › step "complete requires an explicit confirmation; focus stays in the dialog; it opens the locked report" |
| 17 | report shows exactly the six mandated part/unit totals | workflow.spec › step of the same name |
| 18 | structured JSON, server PDF and printed PDF agree with the persisted work | workflow.spec › step "JSON download, server PDF and printed PDF carry the same six totals as the persisted work" (now the real JSON download by keyboard, filename checked; dates in words in both PDFs). **Dropped here:** writing `sample-completed-*.json/.pdf` (6.2) |
| 19 | completed visit is locked in the UI and through the API | persistence.spec › a completed visit is locked in the UI and through the API |
| 20 | genuine WebGL scene with one instance per seat, floor area and bin module | scene.spec › same name (desktop, reduced-motion). **Dropped here:** `verification/e2e/webgl.json` (6.2) |
| – | (new) scene budgets | scene.spec › the 176-seat layout stays within the draw-call and triangle budgets in every preset (scene budgets in `budgets.json`) |
| 21 | spatial picking selects the exact seat and its component | scene.spec › same name |
| 22 | selection, recorded and unresolved states stay in sync … | scene.spec › same name (also checks that a save updates only the scene states: `describeScene().updates`) |
| 23 | selection and hover are outlined, status is a badge … (WEB-21) | scene.spec › same name |
| 24 | floor areas and bin modules are pickable in 3D | scene.spec › same name |
| 25 | a hidden layer never blocks a pick | scene.spec › a hidden layer never blocks a pick: the seat behind a hidden bin is selected (strengthened, see below) |
| 26 | camera buttons, orbit, pan and zoom change the view; reset restores it | scene.spec › same name |
| 27 | a camera preset eases along an arc and drawing stops …; with reduced motion it cuts | scene.spec › "a camera preset eases along an arc and drawing stops when it arrives; reduced motion, once turned on, cuts" (desktop; skipped in reduced-motion) |
| 28 | the wheel scrolls the page past the view until the view has focus … | scene.spec › same name |
| 29 | an unmoved preset re-frames on resize, also after a pick … (WEB-09) | scene.spec › same name |
| 30 | a location chosen in the work list while 3D shows is brought into view … | scene.spec › same name |
| 31 | whole cabin is framed to fill the view | scene.spec › same name. **Dropped here:** `framing.json` (6.2) |
| 32 | lighting, visual family and colour modes switch independently | scene.spec › same name |
| – | (new) 20 family switches leave geometries and textures unchanged | scene.spec › 20 visual family switches leave the geometry and texture counts unchanged |
| 33 | a save, a window resize and a tab switch leave a moved camera … | scene.spec › same name (includes pause: paused scene draws nothing, same instance) |
| 34 | a right click and a long press never pick; the aisle strip picks the full-cabin floor | scene.spec › same name |
| 35 | the first-use hint … goes after Got it … (WEB-21) | scene.spec › same name |
| 36 | save full-cabin, seat-front, seat-rear, carpet and bin captures … | **Moved to 6.2** (only wrote PNGs and `captures.json`) |
| 37 | measured frame rate and selection feedback on this device | **Moved to 6.2** (wrote `performance.json`; its fps ≥ 30 and pick ≤ 250 ms asserts are TST-08's hard fps assert and go with it) |
| 38 | quantity update, primary/alternate switch and remove keep one record … | persistence.spec › same name |
| 39 | draft survives a service restart and a browser reload, and can be resumed from history | persistence.spec › a draft survives a server restart and a browser reload, and can be resumed from saved visits |
| – | (new) resume link | persistence.spec › the resume link on the check page opens the last draft |
| 40 | changing the lookup form does not retarget the open visit | persistence.spec › same name |
| 41 | stale edit from a second window is reported as a conflict and reloaded | conflict.spec › a stale edit from a second window shows both values, keeps the typed input, and the first writer's value stays |
| – | (new) unknown outcome then Retry safely saves once (two tabs) | conflict.spec › an unknown outcome in one tab, seen saved in another, then Retry safely stores it once |
| – | (new) an edit racing completion | conflict.spec › an edit racing completion is refused: nothing is stored and the page follows to the completed, locked visit |
| 42 | network loss during save: outcome reported as unknown, retry is safe | failures.spec › network loss during save: … retry is safe |
| 43 | response lost after commit: retry confirms the earlier save without duplicating | failures.spec › response lost after commit: … |
| 44 | storage failure: reported as not saved, retry succeeds after recovery | failures.spec › storage failure: reported as Not saved, … |
| 45 | reference store failure: lookup shows SERVICE_UNAVAILABLE … | failures.spec › reference unavailable: … |
| 46 | server down: clear banner, retry buttons, recovery without losing the draft | failures.spec › server down: the unsent record is reported as unknown, and after recovery the draft is intact |
| 47 | 3D module failure: complete map-and-list fallback, work continues, retry restores 3D | failures.spec › 3D module failure: … |
| 48 | WebGL unavailable: fallback covers seats, floors and bins | fallback.spec › WebGL unavailable: … the whole workflow completes (no-webgl only). **Dropped here:** `fallback-no-webgl.png` (6.2) |
| 49 | blocked localStorage does not break the app | failures.spec › same name |
| 50 | PARTIAL visit: gaps are visible, cannot be recorded and stay in the report | lookup.spec › same name |
| 51 | expired alternate is not offered on 2027-01-01 … | lookup.spec › same name |
| 52 | pending change is an advisory and the rule stays usable | lookup.spec › same name |
| 53 | preparation overview: searchable, filterable, printable, exportable … | prep.spec › preparation overview … and › preparation CSV export: its filename and its content (CSV now through the page's download link). **Dropped here:** sample CSV and printed prep PDF (6.2) |
| 54 | candidate layout is explorable with its status visible and nothing resolvable | candidates.spec › the candidate 73G layout is explorable … nothing resolvable or recordable. **Dropped here:** `candidate-73G-map.png` (6.2) |
| – | (new) Reference view | candidates.spec › the reference view shows the active release, its sources and its import findings |
| 55 | more than 100 visits remain navigable in saved history | persistence.spec › more than 100 visits remain navigable in saved visits |
| 56 | a reference update leaves the completed report unchanged and is flagged, not applied | persistence.spec › same idea, on a server of its own (it activates a second release) |
| 57–63 | axe … on check, visit-3d, report, preparation, visits, layouts, reference | a11y.spec › axe: … on check / preparation / layouts / reference / visits / visit (3D) / report (desktop, mobile, dark) |
| 64 | axe: map and list with a selected location and record form | a11y.spec › on visit (map) with a selected location and its record form |
| – | (new) completion dialog open | a11y.spec › on visit with the completion dialog open |
| 65 | screen-reader oriented structure: landmarks, headings, labels, live regions | a11y.spec › same name (desktop) |
| 66–72 | axe in the dark theme … on the 7 screens | a11y.spec › the same 9 axe tests in the dark project |
| 73 | axe in the dark theme: map and list … | a11y.spec › on visit (map) … (dark) |
| 74 | the 3D view takes the dark background from the theme | a11y.spec › the system dark setting applies the dark tokens, the 3D view follows, and print stays light (dark) |
| 75 | print uses the light tokens under a dark system setting | same test as 74 |
| 76 | the header's theme control chooses dark over a light system … | a11y.spec › same name (desktop) |
| 77 | the header's theme control chooses light over a dark system | a11y.spec › … chooses light over a dark system, with no axe violations (dark) |
| 78 | mobile: lookup, start visit, no horizontal overflow | mobile.spec › mobile: lookup and start a visit with no horizontal overflow |
| 79 | mobile: 3D renders in portrait framing and a tap picks a seat | mobile.spec › same name. **Dropped here:** mobile capture PNG (6.2) |
| 80 | mobile: Overhead and Cutaway show the whole cabin, also in a tall view | mobile.spec › same name |
| 81 | mobile: the end of a two-finger gesture selects nothing and a URL-bar resize keeps a moved camera | mobile.spec › same name |
| 82 | mobile: a one-finger vertical drag … scrolls the page; a sideways drag orbits | mobile.spec › same name |
| 83 | mobile: record through the map with touch-sized targets, complete and read the report | mobile.spec › same name. **Dropped here:** `mobile-visit-map.png`, `mobile-report.png` (6.2) |
| 84 | a scene that starts with reduced motion cuts between presets … | scene.spec › a scene that starts with reduced motion applies a preset within one frame and does not glide (reduced-motion only) |
| 85 | axe on mobile: visit map and report | a11y.spec, all 9 axe tests in the mobile project |
| 86 | no uncaught page errors during the desktop run | the `page` fixture, in every test of every project (stricter: console errors and failed loads count too) |
| – | (new) security | security.spec › no Content-Security-Policy violation during the workflow; › security headers on the page and on a hashed asset |

Also dropped with the runner (all file writing, all to 6.2): `verification/e2e/axe-*.json`, `console-errors.json`, `e2e-results.json/.txt`, `desktop-visit.png`, `desktop-report.png`. No spec writes into `verification/`.

## Checks added during the hardening work

| Behaviour | Where it is checked now |
|---|---|
| CSP violations | security.spec (a `securitypolicyviolation` listener from the first script, through lookup, 3D, map, record, complete, report and the other four views); and the page fixture (CSP reports are console errors). Checked that the listener sees a violation by injecting an inline `<style>` in a throwaway test. |
| storage failure "Not saved" | failures.spec: `toHaveText(/^Not saved: /)` plus the server's "nothing was saved" |
| idempotent retry | failures.spec (network loss, response lost), conflict.spec (two-tab) |
| two-tab replay | conflict.spec › an unknown outcome in one tab, seen saved in another, then Retry safely stores it once |
| routes / skip link | workflow.spec (skip link keeps the route), lookup.spec (URL carries tail and date, Back, reload); `tests/web/routes.test.ts` unchanged |
| keyboard focus | workflow.spec (whole walk-through by Tab, arrows, Enter, Space, Escape) |
| ConfirmDialog | workflow.spec: starts on Cancel, Escape returns focus to "Complete visit…", Tab/Shift+Tab never focus the page behind, Shift+Tab from Cancel reaches Confirm; a11y.spec: axe with the dialog open |
| page clamp replace-history | `tests/web/VisitsView.test.tsx` (vitest; never in `run.ts`) |
| scene stable camera / pinch / URL-bar resize / pause | scene.spec (save, resize, tab switch, pause), mobile.spec (two-finger end, URL-bar resize after nudge and after touch orbit) |
| test hooks absent in prod build | `tests/web/disposal.test.ts` bundle test (vitest; never in `run.ts`) |
| geometry budget + on-demand frames | scene.spec budget test (scene budgets in `budgets.json`) and "drawing stops when it arrives" (20 frames, frame count unchanged), paused scene draws nothing; `tests/web/seatBudget.test.ts` |
| outlines / badges / status precedence | scene.spec outline test; `tests/web/statusEncoding.test.tsx` |
| camera rig (phone overhead/cutaway fit, touch axis lock, reduced motion, wheel hint) | mobile.spec (fit at 390 × 844 and 390 × 1120, vertical drag scrolls, sideways orbits), scene.spec (reduced motion both ways, wheel hint); `tests/web/cameraRig.test.ts` |
| shell bin clearance | `tests/web/shell.test.ts` (vitest; never in `run.ts`) |
| dark theme axe (9 views) + system/light choice | a11y.spec in the dark project: 9 views, tokens, scene background, print; theme control both ways |
| toasts / undo / skeleton / readable dates incl. PDF date agreement | workflow.spec: "12Nov2026" in both the server and the printed PDF, "12 Nov 2026" on the report page; toasts, undo and skeletons are in `tests/web/Toasts.test.tsx`, `CheckView.test.tsx`, `readableViews.test.tsx` (vitest; never in `run.ts`) |
