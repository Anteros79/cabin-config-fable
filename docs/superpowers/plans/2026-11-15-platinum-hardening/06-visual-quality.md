# Phase 5: Visual and interaction quality

Read [`00-index.md`](00-index.md) first. Requires Phase 4.

Outcome: the 3D cabin reads as a finished product rather than a debug view, costs less than half the triangles, moves smoothly, and the surrounding application has consistent tokens, a dark theme, and real loading, empty and feedback states. Closes WEB-20 and WEB-21.

How visual work is accepted here:

- **Measured** criteria (triangles, draw calls, GPU memory, frame time, contrast ratios) have numbers and are read from `window.__cabinKit.scene.describe()` in the e2e build or computed in a unit test.
- **Judged** criteria are checked against the supplied photographs using the comparison sheets (`npm run comparisons` after `npm run evidence:capture`, Task 6.2; before that task exists, use the existing `node tests/e2e/run.ts` capture path and discard other changes under `verification/`). Re-judge the affected rows of the table in `verification/README.md` and change a rating only to what the sheet shows. A row that is still PARTIAL stays PARTIAL. Do not write PASS for something that was not looked at.
- Nothing in this phase may claim a dimension, a colour or a layout-to-appearance link that the supplied files do not support. The geometry stays "illustrative approximation". Brand marks stay out.
- three.js API names below are for 0.187. Before using an addon or a material property, open its source under `node_modules/three/` and confirm the name and signature.

---

### Task 5.1: Geometry budget and on-demand frames

Closes the cost half of WEB-20.

**Files:**
- Modify: `src/web/scene/seatParts.ts`, `src/web/scene/CabinScene.ts`
- Test: `tests/web/seatBudget.test.ts`

**Interfaces:**
- `export const SEAT_TRIANGLE_BUDGET = 3_200` in `seatParts.ts`. `export function seatTriangleCount(parts: SeatParts): number` sums `index.count / 3` (or `position.count / 3`) over the seat's part geometries. three.js geometry classes construct without WebGL, so this runs in jsdom.
- Part detail: rounded boxes with 2 segments only for the headrest, back cushion and pan (the parts whose silhouette is seen). Legs, arm structures, arm pads, ledges, tray and latch use plain boxes or 1 segment. Relief stays in the texture and normal map (Task 5.3), not in geometry.
- Frame scheduling replaces the permanent `requestAnimationFrame` loop: `invalidate(): void` requests one frame if none is pending. A frame re-requests itself only while damping is settling, a camera transition is running (Task 5.5), or `measure()` is active. `setPaused(true)` and `document.visibilityState === "hidden"` cancel any pending frame.

- [ ] **Step 1: Write the failing tests.**

```ts
test("one seat is within the triangle budget", () => { for (const profile of ALL_PROFILES) expect(seatTriangleCount(buildSeatParts(profile))).toBeLessThanOrEqual(SEAT_TRIANGLE_BUDGET); });
test("the silhouette parts keep rounded edges", () => { /* headrest, back and pan geometries have more than 12 triangles each */ });
```

  Use the real builder and profile names from `seatParts.ts`.
- [ ] **Step 2: Run.** Expected: FAIL (about 7,800 per seat).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Measure in a browser** (e2e build, 176-seat layout, all layers on): record triangles, draw calls and idle CPU before and after. Accept when triangles ≤ 600,000, draw calls ≤ 30, and with no interaction for 5 s the page schedules zero frames (count `requestAnimationFrame` calls via the test hook).
- [ ] **Step 5: Compare** sheets 01, 02, 06 and 10 against the previous captures: the seat silhouette must be unchanged to the eye. **Commit** `perf(scene): halve seat geometry, render only on change (WEB-20)`.

---

### Task 5.2: Incremental scene updates

Closes the rebuild half of WEB-20.

**Files:**
- Modify: `src/web/scene/CabinScene.ts`, `src/web/scene/textures.ts`
- Test: `tests/web/textureCache.test.ts`

**Interfaces:**
- `rebuild()` is split into three private methods with these triggers:

| Method | Runs when | Does |
| --- | --- | --- |
| `buildLayout()` | layout id or pickability changes | creates instanced meshes, sets instance matrices, floor and bin meshes |
| `applyProfile()` | visual family or light changes | swaps material maps and colours; no geometry work |
| `applyStates()` | record states, selection or colour mode change | writes instance colours only |

- `textures.ts`: `export function textureKey(kind: string, paletteId: string, size: number): string` and a module-level cache `getTexture(key, make: () => THREE.Texture): THREE.Texture` with `disposeTextureCache(): void` called from `CabinScene.dispose()` when the last scene goes away (reference count). Switching family A → B → A creates each texture once.

- [ ] **Step 1: Write the failing test:** `getTexture` returns the same object for the same key and calls `make` once; `disposeTextureCache` disposes each texture once and empties the cache.
- [ ] **Step 2: Implement.** Run `npm run check`.
- [ ] **Step 3: Measure:** time from clicking a visual-family button to the next rendered frame, median of 10. Accept ≤ 50 ms (it is a full rebuild today; record the old number). Recording a replacement must cause zero calls to `buildLayout` and `applyProfile` (count them through the test hook).
- [ ] **Step 4: Commit** `perf(scene): separate layout, profile and state updates; cache textures (WEB-20)`.

---

### Task 5.3: Materials and light that read as a real cabin

Closes the "matte, no seam detail" FAIL and the lighting PARTIALs in WEB-21.

**Files:**
- Create: `src/web/scene/environment.ts`, `src/web/scene/materials.ts`
- Modify: `src/web/scene/CabinScene.ts`, `src/web/scene/textures.ts`, `src/web/scene/seatParts.ts`, `docs/visual-families.md`
- Test: `tests/web/materials.test.ts`

**Interfaces:**
- `environment.ts`: `export function createEnvironment(renderer: THREE.WebGLRenderer, mode: LightMode): THREE.Texture` — builds a `RoomEnvironment` (three addon), tints its emissive panels for `blue` mode, and returns a PMREM-filtered texture. One per light mode, cached on the scene, disposed with it. `scene.environment` is set from it; `scene.environmentIntensity` is 1.0 neutral, 0.55 blue.
- The six always-on point lights are removed. Lighting is: the environment, one directional key light (window side), and in blue mode one blue-tinted fill. The wash-light strips become emissive meshes.
- `materials.ts`:
  ```ts
  export interface SeatMaterialSet { upholstery: THREE.MeshPhysicalMaterial; shell: THREE.MeshStandardMaterial; metal: THREE.MeshStandardMaterial; pad: THREE.MeshStandardMaterial }
  export function createSeatMaterials(profile: VisualProfile, maps: { colour: THREE.Texture; normal: THREE.Texture; roughness: THREE.Texture }): SeatMaterialSet
  ```
  Upholstery: `roughness` 0.55, `sheen` 0.4 with `sheenRoughness` 0.5, `clearcoat` 0.08 with `clearcoatRoughness` 0.6, `normalScale` (0.6, 0.6). Metal: `metalness` 1, `roughness` 0.35. Shell: `roughness` 0.7. These are starting values; tune by eye against sheets 01 and 03 and write the final values into `docs/visual-families.md`.
- `textures.ts`: seat back and pan textures are 512 × 1024. Alongside each colour map, draw a height canvas (stitch lines and panel seams as dark grooves, piping as a light ridge) and convert it to a tangent-space normal map with a Sobel pass: `export function normalFromHeight(height: ImageData, strength: number): ImageData` (pure; unit-tested). A roughness map lowers roughness slightly along piping.
- Contact: a single instanced, alpha-blended quad under each seat with a radial-gradient texture (`depthWrite: false`, 4 mm above the carpet) grounds the seats. No shadow maps.
- Tone mapping stays ACES; the status overlay colours are corrected so the rendered overlay matches the legend swatch within ΔE 10 at the default exposure (compute expected sRGB in a unit test from the tone curve, or draw the legend swatches from the same rendered colour; choose the second if the first cannot be made to hold).

- [ ] **Step 1: Write the failing tests.**

```ts
test("normalFromHeight: a flat height map gives the neutral normal", () => { /* every pixel (128,128,255) ±1 */ });
test("normalFromHeight: a vertical groove tilts normals away from it on both sides", ...);
test("createSeatMaterials uses a physical material with sheen for upholstery and wires all three maps", ...);
```

- [ ] **Step 2: Implement.** Run `npm run check`.
- [ ] **Step 3: Measure:** GPU texture memory from `renderer.info.memory.textures` and an estimate of bytes (sum of width × height × 4 × 1.33 over cached textures). Accept ≤ 96 MB. Frame time during a 4 s orbit on the reference machine: worst frame ≤ 25 ms.
- [ ] **Step 4: Judge** against sheets 01–07 and 10–12. Rows to re-judge in `verification/README.md`: "Leather sheen and seam detail", "Stitch lines on the lower back", "Concept gray colour and bold stitching", "Blue cabin light", "Neutral light", "Silver legs". Write the new rating and one sentence of what is still different for each.
- [ ] **Step 5: Commit** `feat(scene): environment lighting, physical upholstery with stitched normal maps, contact shading (WEB-21)`.

---

### Task 5.4: Selection, hover and status that anyone can read

Closes the legibility items in WEB-21.

**Files:**
- Create: `src/web/scene/outline.ts`
- Modify: `src/web/scene/CabinScene.ts`, `src/web/components/Cabin3D.tsx`, `src/web/components/CabinMap.tsx`, `src/web/styles.css`
- Test: `tests/web/statusEncoding.test.ts`

**Interfaces:**
- `outline.ts`: `export function createOutline(geometry: THREE.BufferGeometry, colour: THREE.ColorRepresentation, widthMetres: number): THREE.Mesh` — an inverted-hull outline: the same geometry, `side: THREE.BackSide`, vertices pushed along their normals by `widthMetres` in the vertex shader (`onBeforeCompile`), unlit flat colour, `depthTest: true`. Selection: 18 mm, the select token colour. Hover: 9 mm, white with a dark 3 mm inner hull so it reads on pale shells and on the pale background.
- The translucent selection cube and both 1 px wire boxes are removed.
- Status is encoded twice. In 3D: instead of a 60 % colour overlay that hides the upholstery, the seat keeps its material and gains a status **badge**, a small instanced disc on the top of the headrest (or on the centre of a floor area / the door of a bin), drawn from a 4-cell texture atlas: recorded (tick), unresolved (question mark), has alternate (double arrow), none (no badge). Colour mode "status" additionally tints the headrest only.
- In the map and the legend: the same four glyphs beside the colour, using inline SVG, `aria-hidden` with the text label carrying the meaning.
- `export const STATUS_ENCODING: Record<LocationStatus, { glyph: "tick" | "question" | "alternate" | "none"; token: string; label: string }>` in `src/web/model.ts`, used by the scene atlas, the map and the legend so they cannot disagree. `LocationStatus` is the existing union exported from `src/web/scene/CabinScene.ts`; move it to `model.ts` and re-export it from the scene.
- Hover label: positioned at the pointer (offset 14 px, clamped inside the canvas wrap), not in a fixed corner. It is `aria-hidden`; the live region already announces selection.

- [ ] **Step 1: Write the failing tests.**

```ts
test("every status has a distinct glyph or is 'none', and a label", ...);
test("status token colours are distinguishable under simulated deuteranopia and protanopia", () => { /* convert each token to the simulated colour (Machado 2009 matrices, severity 1.0); every pair differs by ΔE ≥ 15, or the pair also differs by glyph */ });
test("the legend and the map render the same glyph for a status", ...);
```

- [ ] **Step 2: Implement, run** `npm run check`.
- [ ] **Step 3: Judge:** capture cutaway, overhead and aisle views with one recorded, one unresolved and one selected seat. A person who has not seen the legend should be able to say which seat is selected and which is recorded from the overhead capture in grayscale (convert the capture to grayscale and look). Record the result.
- [ ] **Step 4: Commit** `feat(scene): hull outlines for selection and hover, glyph badges for status (WEB-21)`.

---

### Task 5.5: Camera that moves, stays in bounds and respects the page

Closes the camera and scroll items in WEB-21.

**Files:**
- Create: `src/web/scene/cameraRig.ts`
- Modify: `src/web/scene/CabinScene.ts`, `src/web/components/Cabin3D.tsx`, `src/web/styles.css`
- Test: `tests/web/cameraRig.test.ts`

**Interfaces:**
- `cameraRig.ts` (imports only `three` math classes; no renderer):
  ```ts
  export interface CameraPose { position: THREE.Vector3; target: THREE.Vector3 }
  export interface CabinBounds { length: number; halfWidth: number; height: number }
  export function easeInOutCubic(t: number): number;
  export function interpolatePose(from: CameraPose, to: CameraPose, t: number): CameraPose;   // position along an arc around the interpolated target, not a straight line through the cabin
  export function clampTarget(target: THREE.Vector3, bounds: CabinBounds): THREE.Vector3;      // target stays inside the cabin box plus 0.5 m
  export function transitionMs(from: CameraPose, to: CameraPose, reducedMotion: boolean): number;   // 0 when reducedMotion; otherwise 250–700 ms scaled by distance
  export function poseToFrame(location: { x: number; y: number; z: number }, kind: LocationKind, bounds: CabinBounds): CameraPose;   // a three-quarter view from the aisle side, 2.2 m back for a seat
  ```
- `CabinScene.setCamera(view, locationId?)` starts a transition from the current pose to the preset. A new call or any user input cancels the running transition from where it is.
- `prefers-reduced-motion: reduce` (read once and on change via `matchMedia`): transitions are instant and OrbitControls damping is disabled.
- OrbitControls limits: `minDistance` 0.8, `maxDistance` `bounds.length * 1.4`, `maxPolarAngle` `Math.PI / 2 - 0.03` (never below the floor); on every `change`, the target is passed through `clampTarget`.
- Selecting a location from outside the canvas (map, list, worklist, go-to) while the 3D tab is visible: if the location's projected position is outside the central 80 % of the viewport or is occluded by the bin layer in the current view, transition to `poseToFrame(location)`. A pick inside the canvas never moves the camera.
- Scroll and touch: the wheel zooms only while the canvas has focus or `ctrl`/`meta` is held; otherwise the page scrolls and a one-line hint "Click the view, then scroll to zoom" appears for 2 s (at most once per session). `touch-action: pan-y` on the canvas: one-finger vertical drags scroll the page; one-finger horizontal drags orbit; two fingers pinch and pan.
- Ghosting of bins and walls fades over 150 ms (0 ms with reduced motion) instead of popping.

- [ ] **Step 1: Write the failing tests.**

```ts
test("easeInOutCubic: 0 → 0, 1 → 1, 0.5 → 0.5, monotonic", ...);
test("interpolatePose at 0 and 1 returns the endpoints", ...);
test("the interpolated camera never passes below the floor or inside the seat volume between two valid poses", () => { /* sample 50 steps between the overhead and aisle presets; position.y ≥ 0.3 at every step */ });
test("clampTarget keeps the target within bounds plus half a metre", ...);
test("transitionMs is 0 with reduced motion and between 250 and 700 otherwise", ...);
test("poseToFrame looks at the location from the aisle side", ...);
```

- [ ] **Step 2: Implement, run** `npm run check`.
- [ ] **Step 3: Check by hand** at 390 × 844 and at 1440 × 900: the page scrolls past the canvas with one finger or an unfocused wheel; a camera preset eases; with reduced motion on in the OS, it cuts. Task 6.1 automates the scroll and the reduced-motion cases.
- [ ] **Step 4: Commit** `feat(scene): eased bounded camera, reduced-motion support, page-friendly scroll (WEB-21)`.

---

### Task 5.6: Cabin shell

Closes the "Ceiling arch" FAIL and the sidewall PARTIAL in WEB-21.

**Files:**
- Modify: `src/web/scene/CabinScene.ts`, `src/domain/geometry.ts` (constants only), `docs/visual-families.md`, `docs/missing-evidence.md`
- Test: `tests/unit/geometry.test.ts`

**Interfaces:**
- `geometry.ts` adds illustrative constants `CEILING_HEIGHT = 2.15` and `SIDEWALL_CURVE_RADIUS = 1.9`, each with the same "illustrative, not from a drawing" comment the others carry. `GEOMETRY_VERSION` stays `cabin-kit.geometry/1`: these constants place no location and change no placement. Add a unit test that every existing `seatPlacement`, `floorPlacement` and `binPlacement` output is unchanged (snapshot the 176-seat layout's placements before the change).
- `export function shellProfile(): { y: number; z: number }[]` in `geometry.ts`: the half cross-section from floor edge to ceiling centre as a polyline (sidewall arc, bin recess, ceiling arc). Pure; unit-tested for continuity and for staying outside the seat and bin boxes.
- Context layer builds from it: an extruded shell along +X (two mirrored halves), with window reveals as inset rounded-rectangle recesses, one per row pitch, and a ceiling with a recessed emissive light channel each side. Material: matte pale, `side: THREE.BackSide` so the cutaway camera looks through the near wall.
- Cutaway rule: the half of the shell between the camera and the cabin centreline fades out (reuse the ghosting fade from Task 5.5); the ceiling fades in the overhead and cutaway presets and is opaque in the aisle preset.
- The context layer stays optional and off for picking. Galleys, lavatories and the barrier stay out by decision; keep the two plain end bulkheads.

- [ ] **Step 1: Write the failing tests:** `shellProfile` is continuous (consecutive points within 0.15 m), starts at the floor edge, ends on the centreline at `CEILING_HEIGHT`, and no point lies inside the seat envelope or the bin box; placements snapshot unchanged.
- [ ] **Step 2: Implement, run** `npm run check`.
- [ ] **Step 3: Measure:** the shell adds ≤ 25,000 triangles and ≤ 4 draw calls.
- [ ] **Step 4: Judge** against sheets 09, 10, 11 and re-rate "Ceiling arch", "Window surrounds", "Segmented bin underside". Update `docs/missing-evidence.md`: cabin height and cross-section remain illustrative.
- [ ] **Step 5: Commit** `feat(scene): sculpted ceiling and curved sidewall in the context layer (WEB-21)`.

---

### Task 5.7: Design tokens, stylesheet split, dark theme

Closes the remaining CSS items in WEB-16.

**Files:**
- Create: `src/web/styles/tokens.css`, `base.css`, `layout.css`, `forms.css`, `viewer.css`, `map.css`, `inspector.css`, `report.css`, `print.css`; `src/web/styles/index.css` imports them in that order
- Delete: `src/web/styles.css` (after moving every rule)
- Modify: `src/web/main.tsx`, `src/web/index.html`, `src/web/scene/CabinScene.ts` (reads background and outline colours from CSS custom properties)
- Test: `tests/web/tokens.test.ts`

**Interfaces:**
- `tokens.css` defines, on `:root`, every colour, radius, space step, font size, shadow and duration used anywhere, and redefines the colour tokens under `@media (prefers-color-scheme: dark)` and under `:root[data-theme="dark"]` / `[data-theme="light"]` for the manual switch. `color-scheme: light dark`.
- Token groups: `--surface-{0,1,2}`, `--text-{strong,body,muted}`, `--border-{subtle,strong}`, `--accent`, `--accent-contrast`, `--focus`, `--select`, `--status-{recorded,unresolved,alternate}` with `-bg` and `-text` variants, `--danger`, `--warning`, `--success`, `--header-bg`, `--header-text`, `--space-{1..8}`, `--radius-{1,2,3}`, `--dur-{fast,base}`.
- No hex, `rgb()` or named colour appears outside `tokens.css` and `print.css`.
- A theme control in the header: a three-state button group "System / Light / Dark", stored in `localStorage` under `cabin-kit.theme`, applied to `document.documentElement.dataset.theme` by a 6-line inline-free module imported first in `main.tsx` (no inline script; the CSP forbids it).
- The scene background, hover hull and wash-light colours follow the theme: `CabinScene.setTheme(tokens: { background: string; outline: string })`, called on theme change.
- Print always uses the light tokens.

- [ ] **Step 1: Write the failing tests.**

```ts
test("no colour literal outside tokens.css and print.css", () => { /* read every file in src/web/styles; fail listing file:line for /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i */ });
test("every var(--x) used is defined", ...);
test("text and status token pairs meet WCAG AA in both themes", () => {
  /* parse tokens.css into light and dark maps; for each pair in PAIRS assert contrast ≥ 4.5 (text) or ≥ 3 (focus, borders, large text) */ });
```

  `PAIRS` lists at least: body text on each surface, muted text on each surface, header text on header, accent-contrast on accent, each status `-text` on its `-bg`, focus on each surface and on header, select on surface-0.
- [ ] **Step 2: Move the rules** file by file with no visual change in light theme: capture the six main screens before and after (e2e screenshots) and compare; differences must be zero pixels apart from anti-aliasing noise. Then add dark values.
- [ ] **Step 3: Run** `npm run check && npm run build`. Run axe on both themes (Task 6.1 adds this permanently; run it by hand now).
- [ ] **Step 4: Commit** in two commits: `refactor(web): split stylesheet, tokenise colours`, then `feat(web): dark theme with system, light and dark modes (WEB-16)`.

---

### Task 5.8: Application shell polish

Closes the app-shell items in WEB-21. Ends the phase.

**Files:**
- Create: `src/web/format.ts`, `src/web/components/Toasts.tsx`, `src/web/components/Skeleton.tsx`, `src/web/components/EmptyState.tsx`
- Modify: every view, `src/web/components/Cabin3D.tsx` (toolbar), `verification/README.md`
- Test: `tests/web/format.test.ts`, `tests/web/Toasts.test.tsx`, cases added to view tests

**Interfaces:**
- `format.ts`:
  ```ts
  export function formatDateTime(iso: string, timeZone?: string): string;   // "12 Nov 2026, 14:05 UTC"; always states the zone
  export function formatDate(isoDate: string): string;                      // "12 Nov 2026"; calendar dates are never shifted by time zone
  export function relativeTime(iso: string, now: Date): string;             // "just now", "5 min ago", then formatDateTime after 24 h
  export const LOOKUP_STATE_LABEL: Record<LookupState, string>;             // RESOLVED → "Resolved", SOURCE_INVALID → "Source not valid", …
  export const FINDING_SEVERITY_LABEL: Record<FindingSeverity, string>;
  export function formatCounts(counts: Record<string, number>, labels: Record<string, string>): string;   // "3 errors, 12 warnings"
  ```
  Every raw ISO timestamp, state code and `JSON.stringify(...)` in the UI is replaced by these. The machine value stays available: timestamps render in `<time dateTime={iso} title={iso}>`.
- `Toasts`: a provider and `useToast(): { show(message: string, options?: { action?: { label: string; run(): void }; durationMs?: number }): void }`. Rendered in a `role="status"` region; at most 3 visible; default 5 s, 8 s when it has an action; paused on hover and focus; dismissible with a button; no animation with reduced motion.
- Undo after Remove: removing a record shows "Removed `<location>` / `<component>`." with action "Undo", which re-sends the record through `useMutations` (target and fingerprint of the original record, `expectedRecordVersion: 0`). If the undo conflicts, the normal conflict message shows.
- `Skeleton`: block placeholders sized like the content they replace, inside the same panel, `aria-hidden`, with one visually hidden "Loading `<thing>`" per view. Used for the visit workspace, report, preparation list, visits table, layouts and reference.
- `EmptyState` props `{ title: string; children?: ReactNode; action?: { label: string; href: string } }`. Cases: no visits at all ("No visits yet." + "Start a check"); no visits match a filter ("No visits match this filter." + "Clear filter"); preparation filter with no rows; a layout with no seat set. The pager is hidden when there is one page.
- 3D toolbar: grouped with `role="group"` and a visible label each: "View" (five presets as a segmented control), "Layers" (toggle buttons), "Light and style" (one disclosure on narrow screens). The six nudge buttons move into a disclosure "Move camera" (they exist for keyboard and switch users; they stay reachable). Under 700 px the toolbar is one scrollable row.
- First-use hint over the canvas: "Drag to orbit · Pinch or Ctrl+scroll to zoom · Click a seat to select" with a "Got it" button; shown until dismissed once (`localStorage` `cabin-kit.hint.3d`).

- [ ] **Step 1: Write the failing tests.**

```ts
test("formatDate never shifts a calendar date", () => { expect(formatDate("2026-11-12")).toBe("12 Nov 2026"); });   // run with TZ=Pacific/Kiritimati and TZ=Pacific/Pago_Pago
test("formatDateTime states the zone", ...);
test("every LookupState and FindingSeverity has a label", ...);
test("no view renders a raw ISO timestamp or a JSON string", () => { /* render each view with fixture data; container text does not match /\d{4}-\d{2}-\d{2}T/ or /^\{"/m */ });
test("Undo after Remove re-creates the record", ...);
test("toasts pause on focus and cap at three", ...);
test("empty store and empty filter show different messages; pager hidden for one page", ...);
```

- [ ] **Step 2: Implement, run** `npm run check && npm run build`.
- [ ] **Step 3: Re-judge the whole visual table** in `verification/README.md` from fresh captures and comparison sheets, row by row, and rewrite the summary line with the new counts. State plainly what is still FAIL or PARTIAL and why.
- [ ] **Step 4: Commit** `feat(web): readable dates and states, toasts with undo, skeletons, empty states, grouped toolbar (WEB-21)`.
