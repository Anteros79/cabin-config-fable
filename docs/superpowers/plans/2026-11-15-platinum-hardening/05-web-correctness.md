# Phase 4: Web client correctness and accessibility

Read [`00-index.md`](00-index.md) first. Requires Phases 0 and 1 (Task 1.5 changed the write contract; Task 1.6 added the event key).

Outcome: no write is lost, duplicated or applied to the wrong visit; the URL holds the user's place; a keyboard or screen-reader user can do the whole job; saving never disturbs the 3D view.

Conventions:

- Component and hook tests live in `tests/web/`, run in the vitest `web` project (jsdom), and use `@testing-library/react` with `userEvent`. They stub `fetch` with a small in-test router; they never start the server.
- three.js needs WebGL, which jsdom lacks. Scene behaviour is tested two ways: pure logic extracted into modules without a `THREE.WebGLRenderer` (unit tests here), and real-browser checks in Phase 6. A task says which.
- Do not restyle anything in this phase beyond what a finding requires. Visual work is Phase 5.

---

### Task 4.1: Web test project and a hardened request function

Closes WEB-17. Starts TST-09.

**Files:**
- Modify: `vitest.config.ts`, `package.json`, `tsconfig.web.json`, `src/web/api.ts`
- Create: `tests/web/setup.ts`, `tests/web/api.test.ts`, `tests/web/model.test.ts`

**Interfaces:**
- Dev dependencies: `jsdom`, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`.
- vitest project `web`: `environment: "jsdom"`, `include: ["tests/web/**/*.test.{ts,tsx}"]`, `setupFiles: ["tests/web/setup.ts"]`, timeout 10 s. Coverage `include` gains `src/web/**` except `src/web/scene/**`, threshold set to the measured value.
- `api.ts`:
  - `request<T>(method, url, body?, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T>`. The timeout timer stays armed until the body has been read. A caller's `signal` aborts the request; that rejection is `ApiError` with `kind: "aborted"` and callers ignore it.
  - `ApiError.kind` becomes `"network" | "http" | "aborted"`.
  - Classification for a **write** (`method !== "GET"`): no response, timeout, body unreadable, or a 5xx whose body is not the JSON error envelope → `kind: "network"` (outcome unknown). A 5xx with the envelope and code `STORAGE_UNAVAILABLE` or `INTERNAL_ERROR` → `kind: "http"` (the server answered; nothing was saved).
  - Every id placed in a URL goes through `encodeURIComponent`. One helper: `const visitUrl = (id: string, suffix = "") => \`/api/visits/${encodeURIComponent(id)}${suffix}\``.
  - `api.addEvent(visitId, body, idempotencyKey)` sends the key.
  - All URLs are built from `const API_BASE = "/api"`; set `base: "/"` in `vite.config.ts` (WEB-19: the app is served from the root and nowhere else).

- [ ] **Step 1: Write the failing tests** in `tests/web/api.test.ts` with a stub `fetch`:

```ts
test("a body that never arrives times out", async () => { /* headers resolve, json() never does; with timeoutMs 50 → ApiError kind network */ });
test("a non-JSON 502 on a write is an unknown outcome", async () => { /* PUT → kind "network" */ });
test("a non-JSON 502 on a read is an http error", ...);
test("an enveloped 503 on a write is 'not saved'", async () => { /* kind "http", code STORAGE_UNAVAILABLE */ });
test("409 carries the current record", async () => { /* details.current present */ });
test("a caller abort rejects with kind aborted", ...);
test("ids are encoded", async () => { await api.getVisit("../health?x#y").catch(() => {}); expect(lastUrl).toBe("/api/visits/..%2Fhealth%3Fx%23y"); });
test("a lookup 503 with a state body resolves with that body", ...);   // existing behaviour, pinned
```

  And `tests/web/model.test.ts`: `componentsAt`, `buildStates`, `describeSeat`, `seatLabelFor` on a snapshot built from the fixture release (import the domain functions directly; they are pure).
- [ ] **Step 2: Run** `npx vitest run --project web`. Expected: FAIL.
- [ ] **Step 3: Implement, run** `npm run check && npm run build`. **Commit** `test(web): jsdom project; fix(web): request timeout through body, outcome classification, encoded ids (WEB-17)`.

---

### Task 4.2: A write queue that cannot lose or duplicate a save

Closes WEB-04, WEB-05, WEB-06, the Remove part of WEB-18. Review Focus 2.

**Files:**
- Create: `src/web/hooks/useMutations.ts`
- Modify: `src/web/views/CheckView.tsx`, `src/web/views/ReportView.tsx`, `src/web/components/Inspector.tsx` (props only)
- Test: `tests/web/useMutations.test.tsx`, `tests/web/CheckView.test.tsx`, `tests/web/ReportView.test.tsx`

**Interfaces:**
- ```ts
  export type SaveStatus =
    | { phase: "idle" }
    | { phase: "saving" }
    | { phase: "saved"; at: string }
    | { phase: "failed"; message: string }            // server answered: not saved
    | { phase: "unknown"; message: string }           // no answer: may or may not be saved
    | { phase: "conflict"; message: string; current: unknown };

  export interface Mutations<R> {
    statusOf(target: string): SaveStatus;
    isBusy(target: string): boolean;
    anyBusy: boolean;
    run(target: string, send: (idempotencyKey: string) => Promise<R>, fingerprint: string): Promise<R | undefined>;
    retry(target: string): Promise<R | undefined>;     // only valid in phase "unknown"; reuses the key
    dismiss(target: string): void;
  }
  export function useMutations<R>(onResult: (result: R) => void): Mutations<R>;
  ```
- Rules:
  - State is a `Map<target, { status, key, fingerprint, send }>`. One target's outcome never touches another's.
  - `run` on a target that is `saving` is ignored (returns `undefined`).
  - `run` on a target in phase `unknown` with the **same** `fingerprint` reuses the stored key; a different fingerprint mints a new key.
  - Writes are sent one at a time in call order (a promise chain), so responses apply in order.
  - `onResult` is called only for the newest result: `CheckView` passes `(res) => setVisit((cur) => cur && res.visit.version >= cur.version ? { ...res.visit, snapshot: cur.snapshot } : cur)`.
- Targets: `record:<locationId>|<componentId>`, `complete`, `create`, `note`. Fingerprints: canonical JSON of the request body without the key.
- `CheckView`: Start visit uses target `create` with fingerprint `{tail, date, technician}`; the button is disabled while `isBusy("create")`. Worklist Remove buttons are disabled while their record target is busy. Each Inspector card shows `statusOf` for its own target.
- `ReportView`: "Add linked note" uses target `note`, is disabled while busy, and sends the key from Task 1.6.

- [ ] **Step 1: Write the failing tests.**

```ts
// useMutations.test.tsx
test("a failure on one target survives a success on another", async () => { /* A rejects network, B resolves → statusOf(A).phase "unknown", statusOf(B).phase "saved" */ });
test("retry after an unknown outcome reuses the key", async () => { /* keys seen by send: [k1, k1] */ });
test("the same request repeated after an unknown outcome reuses the key; a changed request does not", ...);
test("a second run on a busy target is ignored", ...);
test("results are applied in call order even when the first response is slower", ...);
// CheckView.test.tsx
test("Start visit twice after a lost response sends one key", async () => { /* first POST: fetch rejects; click Start again; both POST bodies carry the same idempotencyKey */ });
test("an older response does not overwrite a newer visit version", ...);
test("Remove is disabled while its record is saving", ...);
// ReportView.test.tsx
test("a double click on Add linked note sends one request", ...);
test("a lost response on a linked note says the outcome is unknown and offers a safe retry", ...);
```

- [ ] **Step 2: Run, implement, run** `npm run check`. Remove the shared `saveState` and `pending` ref from `CheckView`.
- [ ] **Step 3: Commit** `fix(web): per-target write queue with stable retry keys (WEB-04, WEB-05, WEB-06, WEB-18)`.

---

### Task 4.3: Routing that keeps the user's place

Closes WEB-02, WEB-03, WEB-10, the resume part of WEB-18. Review Focus 4.

**Files:**
- Create: `src/web/routes.ts`
- Modify: `src/web/App.tsx`, `src/web/main.tsx`, `src/web/views/CheckView.tsx`, `src/web/views/VisitsView.tsx`
- Test: `tests/web/routes.test.ts`, `tests/web/App.test.tsx`

**Interfaces:**
- ```ts
  export type Route =
    | { name: "check"; tail: string | null; date: string | null }
    | { name: "visit"; id: string }
    | { name: "report"; id: string }
    | { name: "prep"; visitId: string | null; tail: string | null; date: string | null }
    | { name: "visits"; status: "DRAFT" | "COMPLETED" | null; q: string; page: number }
    | { name: "layouts"; id: string | null }
    | { name: "reference" }
    | { name: "notFound"; hash: string };
  export function parseRoute(hash: string): Route;     // never throws
  export function formatRoute(route: Route): string;   // "#/visit/<id>", "#/check?tail=N100TL&date=2026-11-12", …
  export function isInPageAnchor(hash: string): boolean;   // "#main" and any hash not starting with "#/"
  ```
- `parseRoute`: wraps `decodeURIComponent` in try/catch → `notFound`. A visit id that is not a UUID → `notFound`. An unknown first segment → `notFound`. Empty hash, `#`, `#/` → `check` with null fields. `parseRoute(formatRoute(r))` deep-equals `r` for every valid route.
- `App`: the `hashchange` handler ignores hashes where `isInPageAnchor` is true (the current route stays). The skip link is `<a href="#main" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>`. `notFound` renders a panel "This page does not exist." with a link to `#/`.
- `main.tsx` wraps `<App />` in a top-level `ErrorBoundary` whose fallback is a plain message and a "Reload" button.
- `CheckView`: on mount and when the route's `tail`/`date` change, fill the form and run the lookup. Submitting the form calls `location.hash = formatRoute({ name: "check", tail, date })`; the lookup runs from the route. Technician is kept in `sessionStorage` under `cabin-kit.technician`, not in the URL.
- `VisitsView`: filter, query and page come from the route and are written back with `formatRoute`.
- Resume pointer: the stored draft id is cleared when a `GET` for it returns 404 or a visit with status `COMPLETED`.
- `document.title`: `Visit #<n> · <tail> · Cabin Kit`, `Report #<n> · <tail> · Cabin Kit`, and the view name for the rest. The Check nav item is current on the `prep` route reached from a lookup; Visits is current on a visit's prep route.

- [ ] **Step 1: Write the failing tests.**

```ts
// routes.test.ts
test.each(["#/visit/%E0%A4%A", "#/visit/not-a-uuid", "#/nope", "#/visit/"])("parseRoute(%j) is notFound and does not throw", ...);
test.each(["", "#", "#/", "#/check"])("parseRoute(%j) is the check route", ...);
test("format and parse round-trip", () => { for (const r of sampleRoutes) expect(parseRoute(formatRoute(r))).toEqual(r); });
test("tail and date with unusual characters survive the round trip", ...);
test.each([["#main", true], ["#inspector-heading", true], ["#/visits", false]])("isInPageAnchor(%j) = %j", ...);
// App.test.tsx
test("Skip to content focuses main and keeps the route", async () => { /* start at #/visit/<uuid>; activate the skip link; location.hash unchanged; document.activeElement is main */ });
test("a malformed hash shows the not-found panel, not a blank page", ...);
test("Back after opening the preparation list restores the lookup", async () => { /* #/check?tail=N100TL&date=2026-11-12 renders the resolved result without touching the form */ });
test("the resume link disappears when the stored draft is completed elsewhere", ...);
test("VisitsView filter and page come from and go to the URL", ...);
```

- [ ] **Step 2: Run, implement, run** `npm run check`. **Commit** `fix(web): safe route parsing, skip link, lookup and filters in the URL (WEB-02, WEB-03, WEB-10, WEB-18)`.

---

### Task 4.4: One data hook with cancellation

Closes WEB-07.

**Files:**
- Create: `src/web/hooks/useResource.ts`
- Modify: `src/web/views/CheckView.tsx`, `LayoutsView.tsx`, `PrepView.tsx`, `ReportView.tsx`, `VisitsView.tsx`, `ReferenceView.tsx`, `src/web/App.tsx` (health poll)
- Test: `tests/web/useResource.test.tsx`, one case added to each view's test file

**Interfaces:**
- ```ts
  export type Resource<T> =
    | { state: "loading"; data: T | undefined }        // data = previous value while reloading the same key
    | { state: "ready"; data: T }
    | { state: "error"; error: ApiError; data: T | undefined };
  export function useResource<T>(key: string | null, fetcher: (signal: AbortSignal) => Promise<T>): Resource<T> & { reload(): void; set(next: T | ((current: T) => T)): void };
  ```
- Rules: a new `key` aborts the in-flight request and clears `data`; `reload()` keeps `data`; a response is applied only if its request is the latest for the current key; `key === null` is idle; unmount aborts; `kind: "aborted"` errors are swallowed.
- Keys: `visit:<id>`, `report:<id>`, `prep:<visitId>` or `prep:<tail>:<date>`, `visits:<status>:<q>:<page>`, `layouts`, `layout:<id>`, `reference`, `lookup:<tail>:<date>`.
- The health poll in `App.tsx` pauses while `document.visibilityState === "hidden"` and resumes with an immediate check.
- VisitsView's Apply button is disabled while loading.

- [ ] **Step 1: Write the failing tests.**

```ts
test("a late response for a previous key is discarded", async () => { /* key A slow, key B fast → data is B's and stays B's after A resolves */ });
test("changing key aborts the previous request", ...);
test("reload keeps the previous data while loading", ...);
test("unmount aborts and does not set state", ...);
// CheckView.test.tsx
test("navigating from visit A to visit B never shows A under B's URL, and writes go to B", ...);
```

- [ ] **Step 2: Run, implement, run** `npm run check`. Delete the five hand-rolled `load` callbacks. **Commit** `refactor(web): useResource with abort and stale-response guard (WEB-07)`.

---

### Task 4.5: Inspector forms that keep what the user typed

Closes WEB-11.

**Files:**
- Modify: `src/web/components/Inspector.tsx`, `src/web/views/CheckView.tsx`
- Test: `tests/web/Inspector.test.tsx`

**Interfaces:**
- Each component card holds a draft `{ selection, substituteId, quantityText: string, note }` and a `baseVersion` (the record version it was loaded from, 0 for none). `dirty` = draft differs from the server record.
- Server record changes while **not dirty** → draft follows it. While **dirty** → draft is kept and a notice appears: "This replacement changed elsewhere. Saved value: `<selection>`, `<quantity>`, note `<note>`." with buttons "Use saved value" and "Keep mine". "Keep mine" sets `baseVersion` to the current server version, so the next save is not stale.
- Quantity: a text input with `inputMode="numeric"` and `pattern="[0-9]*"`. `quantityText` is whatever was typed. Valid when `/^[1-9]\d*$/` and `≤ limit`. Invalid → the field has `aria-invalid="true"`, a message "Enter a whole number from 1 to `<limit>`." linked with `aria-describedby`, and the save button is disabled.
- `Inspector` reports dirty cards upward: `onDirtyChange(target: string, dirty: boolean)`. `CheckView` keeps a `Set` of dirty targets.
- With a dirty card, selecting another location or pressing "Complete visit…" first shows the confirm dialog (Task 4.6 component; until then `window.confirm`): "You have an unrecorded change for `<location>` / `<component>`. Discard it?" with "Discard" and "Go back".
- The "Saved." text is hidden while the card is dirty.
- A `beforeunload` handler is registered only while any card is dirty or any write is in phase `unknown`.

- [ ] **Step 1: Write the failing tests.**

```ts
test("clearing the quantity and typing 3 gives 3", async () => { /* select all, backspace, type "3" → value "3"; save sends quantity 3 */ });
test.each(["", "0", "1.5", "abc", "999"])("quantity %j is invalid and blocks saving", ...);
test("a conflict reload keeps the typed note and offers both values", ...);
test("Keep mine then save sends the current server version", ...);
test("selecting another seat with an unrecorded change asks first", ...);
test("Complete with an unrecorded change asks first", ...);
test("Saved is not shown while the form is dirty", ...);
```

- [ ] **Step 2: Run, implement, run** `npm run check`. **Commit** `fix(web): preserve unrecorded input across conflicts and navigation; honest quantity field (WEB-11)`.

---

### Task 4.6: Focus, dialog, tabs and contrast

Closes WEB-13, WEB-14, the accessibility parts of WEB-16. Review Focus 4.

**Files:**
- Create: `src/web/components/ConfirmDialog.tsx`
- Modify: `src/web/App.tsx`, `src/web/views/CheckView.tsx`, `src/web/components/Viewer.tsx`, `Cabin3D.tsx`, `Inspector.tsx`, `CabinMap.tsx`, `src/web/styles.css`
- Test: `tests/web/a11y.test.tsx`

**Interfaces:**
- `ConfirmDialog` props: `{ open: boolean; title: string; children: ReactNode; confirmLabel: string; cancelLabel: string; destructive?: boolean; busy?: boolean; onConfirm(): void; onCancel(): void }`. Renders a native `<dialog>` opened with `showModal()`; `aria-labelledby` its title; Escape and the cancel button call `onCancel`; on close, focus returns to the element that had it when the dialog opened. Initial focus is the cancel button.
- Route change: after the new view renders, focus moves to that view's `<h2>` (give each one `tabIndex={-1}`), and a visually hidden `aria-live="polite"` region in `App` announces the new `document.title`. Not on first load.
- Selecting a location (map, list, go-to, or 3D pick) updates the inspector. The map's status line gains a button "Go to parts for `<label>`" that focuses `#inspector-heading`. Picking in 3D with the keyboard (Enter on the canvas's focused location) focuses the heading directly.
- `Viewer` tabs follow the WAI-ARIA tabs pattern: `role="tablist"`, roving `tabIndex`, Left/Right/Home/End move and activate, each tab's `aria-controls` names a `role="tabpanel"` that exists in the DOM (both panels stay mounted from Task 4.7; the inactive one has `hidden`).
- The canvas has `role="application"`, `aria-roledescription="3D cabin view"`, and `aria-describedby` pointing at a visually hidden list of its keys.
- CSS:
  - `.app-header :focus-visible { outline-color: #fff; }`
  - `.canvas-wrap canvas:focus-visible { outline-offset: -3px; }`
  - Selection on `button.loc` moves from `outline` to `box-shadow: inset 0 0 0 3px var(--select)`, so `:focus-visible` still draws its outline. Both together must be distinguishable from either alone.
  - Remove `font-size: 15px` from `:root`; set `html { font-size: 93.75%; }` so the user's setting scales it.
  - Remove the sticky `thead th` rule.
  - `@media (forced-colors: active)`: selected tab and current nav item get a 3 px `border-bottom: solid Highlight`; legend swatches and tier marks get `forced-color-adjust: none` and a 1 px `CanvasText` border; selected seat gets `outline: 3px solid Highlight`.

- [ ] **Step 1: Write the failing tests.**

```ts
test("route change moves focus to the view heading and announces it", ...);
test("the completion dialog traps focus, closes on Escape, and returns focus to its opener", ...);
test("Cancel in the completion dialog returns focus to Complete visit", ...);
test("tabs: arrow keys move and activate; aria-controls resolves to an element", ...);
test("Go to parts focuses the inspector heading", ...);
test("the canvas exposes role and description", ...);
test("styles: header focus ring is white; selection does not use outline", () => { /* read styles.css text; assert the two rules exist and `button.loc.selected` has no `outline:` declaration */ });
```

- [ ] **Step 2: Run, implement, run** `npm run check`.
- [ ] **Step 3: Check with a real screen reader once.** With VoiceOver on, do the README walk-through by keyboard only. Write what was announced at each step, and anything wrong, into `verification/README.md` under a new heading "Screen reader pass (VoiceOver, manual)". If this cannot be done in the execution environment, say so there instead; do not claim it.
- [ ] **Step 4: Commit** `fix(web): focus management, modal confirm, tabs pattern, visible focus rings, forced-colors (WEB-13, WEB-14, WEB-16)`.

---

### Task 4.7: Scene lifecycle: saving and resizing never disturb the view

Closes WEB-01, WEB-08, WEB-09, WEB-12, the floor-pick part of WEB-18. Review Focus 5.

**Files:**
- Create: `src/web/scene/pickGesture.ts`
- Modify: `src/web/components/Cabin3D.tsx`, `Viewer.tsx`, `src/web/scene/CabinScene.ts`
- Test: `tests/web/pickGesture.test.ts`, `tests/web/Cabin3D.test.tsx` (with `vi.mock("../../src/web/scene/CabinScene.ts")`)

**Interfaces:**
- `Cabin3D`: the layout effect depends on `[ready, workspace.layout.id, hasMaps]`. `CabinScene.setLayout(layout, pickable)` returns early when `layout.id` and `pickable` equal the current ones.
- `Viewer` keeps `Cabin3D` mounted when the Map tab is active (panel `hidden`); `CabinScene.setPaused(paused: boolean)` stops rendering and input while hidden. Camera, layers, light, family and colour mode therefore survive a tab switch. If WebGL failed, `Cabin3D` is not mounted and the tab is disabled as today.
- `CameraView` gains `"free"`. `currentView` becomes `"free"` on the OrbitControls `start` event and in `nudge()`. `resize()` re-applies a preset only when `currentView !== "free"`; in free view it updates aspect and renderer size only. `resize()` also calls `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))`.
- `pickGesture.ts` (no three.js import):
  ```ts
  export interface PointerSample { pointerId: number; button: number; isPrimary: boolean; x: number; y: number; time: number }
  export class PickGesture {
    down(p: PointerSample): void;
    move(p: PointerSample): void;
    up(p: PointerSample): { x: number; y: number } | null;   // a pick position, or null
    cancel(): void;
  }
  export const PICK_MAX_MOVE_PX = 5;
  export const PICK_MAX_MS = 600;
  ```
  A pick is returned only when: the `down` was `button === 0` and `isPrimary`; no second pointer went down in between; the `up` has the same `pointerId`; total movement ≤ `PICK_MAX_MOVE_PX`; duration ≤ `PICK_MAX_MS`. `CabinScene` feeds it from `pointerdown`, `pointermove`, `pointerup`, `pointercancel` and uses its result for picking.
- Canvas key handler: return without `preventDefault` when `e.ctrlKey || e.metaKey || e.altKey`.
- The aisle strip mesh is a pick target for `FLOOR:FULL-CABIN` when that location exists and floor picking is enabled. Area meshes win over it where they overlap (they are nearer the camera in the overhead view; set the strip's `renderOrder` and raycast priority so an area hit is preferred).

- [ ] **Step 1: Write the failing tests.**

```ts
// pickGesture.test.ts
test("a primary left click picks", ...);
test.each([["right button", { button: 2 }], ["non-primary pointer", { isPrimary: false }]])("%s does not pick", ...);
test("lifting one finger at the end of a pinch does not pick", () => { /* down id 1, down id 2, up id 2, up id 1 → both null */ });
test("a drag beyond 5 px does not pick", ...);
test("a long press does not pick", ...);
test("pointercancel clears the gesture", ...);
// Cabin3D.test.tsx
test("a save that returns a new layout object with the same id does not call setLayout again", () => { /* rerender with structuredClone(workspace) → mock setLayout called once in total */ });
test("switching to Map and back keeps one scene instance", () => { /* constructor called once; setPaused(true) then setPaused(false) */ });
test("Cmd+= on the focused canvas is not prevented", ...);
```

- [ ] **Step 2: Run, implement, run** `npm run check && npm run build`.
- [ ] **Step 3: Check in a browser by hand:** focus a seat, record a replacement, confirm the camera stays; orbit, resize the window, confirm the camera stays; switch tabs and back. Phase 6 Task 6.1 automates these three.
- [ ] **Step 4: Commit** `fix(scene): stable camera across saves, tab switches and resizes; correct pointer gestures (WEB-01, WEB-08, WEB-09, WEB-12, WEB-18)`.

---

### Task 4.8: Scene resources and production flags

Closes WEB-15, WEB-19.

**Files:**
- Modify: `src/web/scene/CabinScene.ts`, `src/web/components/Cabin3D.tsx`, `src/web/views/CheckView.tsx`, `src/web/vite-env.d.ts`, `package.json`, `src/server/config.ts`
- Test: `tests/web/disposal.test.ts`

**Interfaces:**
- Build flag `VITE_TEST_HOOKS`. `const TEST_HOOKS = import.meta.env.VITE_TEST_HOOKS === "1"`. Only when true: `window.__cabinKit` is assigned, `preserveDrawingBuffer` is `true`, and `measure`, `screenPointOf`, `describe` and the pick-latency recorder are attached. Otherwise none of those names appears in the bundle.
- Scripts: `build:e2e` = `VITE_TEST_HOOKS=1 vite build --outDir ../../dist/web-e2e`. `ServerConfig.webRoot` honours `CABIN_KIT_WEB_ROOT`.
- A `ResourceTracker` in `CabinScene.ts`: `track<T extends { dispose(): void }>(resource: T): T` and `disposeAll(): void`. Two trackers: `layoutResources` (disposed at the start of every rebuild) and `sceneResources` (disposed in `dispose()`). Every geometry, material, texture and render target created anywhere in the scene goes through one of them, including the bin door and body geometries and the selection and hover marks.
- `dispose()` ends with `renderer.dispose()` then `renderer.forceContextLoss()`.

- [ ] **Step 1: Write the failing tests.**

```ts
test("ResourceTracker disposes everything it tracked exactly once", ...);
test("the production bundle contains no test hooks", () => {
  /* after `npm run build`: no file in dist/web/assets contains "__cabinKit", "screenPointOf" or "preserveDrawingBuffer:!0" */ });
```

  The second test reads `dist/web`; mark it to run only when the directory exists and add `npm run build` before `npm run coverage` in CI so it always runs there.
- [ ] **Step 2: Run, implement, run** `npm run check && npm run build && npm run build:e2e`.
- [ ] **Step 3: Measure the leak is gone.** In a browser with the e2e build, read `window.__cabinKit.scene.describe()` (it reports `renderer.info.memory`), switch visual family 20 times, read again: `geometries` and `textures` must be equal before and after. Record both numbers in the commit body. Task 6.1 automates this.
- [ ] **Step 4: Commit** `fix(scene): track and dispose all GPU resources; test hooks only in the e2e build (WEB-15, WEB-19)`.
