# Visual Appearance Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A technician taps any seat, floor or bin piece in 3D. They can replace it, note a problem, or defer that problem under a fictional MEL. Deferrals carry forward per tail, and each check ends with an after-action report: a cabin picture, a timeline and lists.

**Architecture:** This extends the existing layers and replaces none of them.
- **Reference data** gains new components, an ARMREST location kind, bin types and one new release key, `mel`.
- **Visit store** gains a per-tail `visit_observations` table, a schema v3 migration and new event types.
- **Pure domain functions** classify a problem, map carried observations onto a new snapshot, and build report v3.
- **Client** gains piece-level status, an observation form, per-piece 3D meshes, opening bins and the new report sections.

**Tech Stack:** Node 24 (`node:sqlite`, type stripping), TypeScript 7 (strict, no enums), zod 4, Fastify 5, React 19, Vite 8, three.js 0.187, vitest, `@playwright/test`, pdfkit, Biome 2.6.8. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-11-18-visual-appearance-check-design.md`](../specs/2026-11-18-visual-appearance-check-design.md). Bin facts: [`docs/research/2026-11-18-southwest-737-overhead-bins.md`](../../research/2026-11-18-southwest-737-overhead-bins.md).

## Naming

- `Finding` already exists: it is the release-validation finding, `src/domain/types.ts:351`.
- In code, a technician's noted problem is therefore an **Observation**: types `Observation*`, events `OBSERVATION_*`.
- The UI calls it a "problem", for example "Note a problem" and "Carried over".

## Global Constraints

- **Data is fictional or public only.** No real part numbers, MEL text, tails or approvals. The demo banner and footer stay.
- **New fictional data goes in `fixtures/fixture-data.json`** (strict schema `src/importer/fixtureSchema.ts`) and `src/importer/fixtures.ts`. `fixtures/originals/` is never edited; `npm run originals:verify` must still pass.
- **Piece names are the contract between data, 3D and report:** a location id plus a component id. Location ids keep the forms `SEAT:12A`, `FLOOR:<id>` and `BIN:<side>-<nn>`, plus the new `ARMREST:<row>-<span>`.
- **Conditions** (exact): `STAINED`, `TORN`, `WORN`, `BROKEN`, `MISSING`, `WONT_LATCH`, `OTHER`.
- **MEL classes** (exact): `COSMETIC`, `MEL`, `NO_GO`. Categories: `A` (interval as stated), `B` 3 days, `C` 10 days, `D` 120 days. These are fictional values.
- **A class can be raised, never lowered.** COSMETIC < MEL < NO_GO.
- **An MEL deferral past its due date is treated as NO_GO.** Due and overdue dates are compared as date-only strings against the visit's `checkDate`, never against the wall clock.
- **Completing with an open NO_GO observation requires `aircraftHeld: true`.** The report then says "Not releasable".
- **A visit may complete with at least one record or one observation event.**
- **Visit stores from commit `5d6679d` (`tests/fixtures/visits-5d6679d.sqlite`)** must still open, migrate, list, report and complete. Stored snapshots, reports and events are immutable. Migrations add tables, columns and triggers only; they never rewrite stored JSON.
- **Every write is one `BEGIN IMMEDIATE` transaction** with idempotency keys and optimistic versions, as today.
- **Error envelope** `{ "error": { "code", "message", "details" } }` on every non-2xx.
- **Plain-language copy:** no raw codes (`NO_GO`, `WONT_LATCH`), ISO timestamps or JSON in the UI unless "Details" is expanded (`tests/web/readableViews.test.tsx`). Codes appear only in the data, the API and PDF details.
- **Theme:** every new colour is a token in `src/web/styles/tokens.css` with light and dark values, passing WCAG AA contrast. Print and PDF stay light.
- **Performance:** the 176-seat scene budget is re-measured once, in Task 10, and written to `budgets.json`. Afterwards it must not drift. The mobile e2e project must still render and pick.
- **Version:** `package.json` goes to `2.1.0`, with a CHANGELOG entry (Task 16).
- **TDD:** write the failing test, see it fail for the stated reason, implement, see it pass. One commit per task, with a message of the form `type(scope): summary (VAC-<task>)`.
- **Gate per task:** `npm run check`. Tasks that touch the web or scene also run `npm run build` and `npm run budgets`.
- **Pinned values:** hash `9cf6c6d2`, the counts 376, 270/23/1 and 24, and the placement sha are re-pinned in the task that changes them, with the new value written into the test. Never loosen an assertion to `>0`.

## Review Focus

1. **A piece with both a replacement and an open problem in the same visit.** It shows one combined status, using the rank in Task 6. The report lists it in both places. Closing the problem as REPLACED requires that record to exist. *Tests: Task 6, Task 4.*
2. **Carry-forward across a configuration change.** Tail N200TL moves V05 → V04, from PIVOT to LARGE_PIVOT bins with different module spans. A BIN_ASSIST problem has no matching piece and must appear under "no longer at this position". A bin door problem moves to the bin covering its first row. *Tests: Task 3, Task 4, e2e Task 15.*
3. **Overdue at the boundary.** On the due date itself an item is still deferrable; on the next day it is NO_GO. A re-deferral keeps the original due date. *Tests: Task 3.*
4. **Two tabs editing the same problem.** A stale `expectedVersion` gives a 409 `STALE_OBSERVATION`, and a retry with the same key replays without duplicating. *Tests: Task 4.*
5. **Keyboard-only and screen-reader access to hidden pieces.** The life vest (under-seat layer off) and the pieces inside a closed bin must be reachable and selectable from the map/list and "Go to location" (for example "12A life vest" or "L-04 latch") without the 3D view. *Tests: Task 9, e2e Task 15.*

---

## Task map

| # | Task | Depends on |
|---|---|---|
| 1 | Reference types: ARMREST kind, bin type, `mel` release key | — |
| 2 | Fictional data: new pieces, armrests, bin modules and types, rules, MEL | 1 |
| 3 | Domain: classify, seat-blocked, due/overdue, carry-forward mapping | 1 |
| 4 | Visit store v3: observations, events, completion rules | 2, 3 |
| 5 | HTTP routes and web API client | 4 |
| 6 | Web model: piece status and observations | 5 |
| 7 | Inspector: piece panel and problem form | 6 |
| 8 | Check view: carried-over list, completion with hold, go-to pieces | 7 |
| 9 | Map/list: armrests, pieces, statuses | 6 |
| 10 | 3D seats: one mesh per piece, under-seat layer, new budget | 6 |
| 11 | 3D bins: three types, opening, inner pieces | 10 |
| 12 | Report v3: summary, timeline, outcome lists, release flag | 4 |
| 13 | Report view: cabin picture, timeline, lists | 12, 9 |
| 14 | PDF: cabin picture and new sections | 12 |
| 15 | Theme tokens and the end-to-end visual check | 8, 11, 13, 14 |
| 16 | Sample data, docs, version | 15 |

---

### Task 1: Reference types: ARMREST kind, bin type, `mel` release key

**Files:**
- Modify: `src/domain/types.ts` (`LocationKind` :7, `BinAttributes` :114, `CabinLocation` :132, `ReleaseContent` :322)
- Modify: `src/domain/schema.ts` (`locationKind` :15, `BinAttributesSchema` :108, `CabinLocationSchema` :119, `ReleaseContentSchema` :300, `SchemaAgreesWithTypes` :394)
- Modify: `src/importer/assemble.ts:93-112`
- Modify: `src/importer/fixtures.ts` (`FixtureContent` :45, `emptyFixtureContent` :26)
- Modify: `src/server/referenceStore.ts` (`ENTITY_TYPES` :24, `entityRows` :189, `readRelease` :492-524)
- Modify: `src/domain/report.ts:18` (`KIND_ORDER`)
- Test: `tests/unit/schema.test.ts`, `tests/integration/referenceStore.test.ts`

**Interfaces:**
- Produces, in `src/domain/types.ts`:
  ```ts
  export type LocationKind = "SEAT" | "FLOOR" | "BIN" | "ARMREST";
  export type BinType = "CLASSIC" | "PIVOT" | "LARGE_PIVOT";
  export interface BinAttributes { side: "L" | "R"; module: number; rowFrom: number; rowTo: number; binType: BinType; capacityBags: number }
  export interface ArmrestAttributes { row: number; side: "L" | "R"; between: [string | null, string | null] } // seat codes either side; null = wall or aisle
  // CabinLocation gains: armrest?: ArmrestAttributes
  export type Condition = "STAINED" | "TORN" | "WORN" | "BROKEN" | "MISSING" | "WONT_LATCH" | "OTHER";
  export type MelCategory = "A" | "B" | "C" | "D";
  export type MelClass =
    | { class: "COSMETIC" }
    | { class: "MEL"; item: string; category: MelCategory; intervalDays: number; conditions: string; blocksSeat?: true }
    | { class: "NO_GO"; reason: string };
  export interface MelEntry {
    id: string; componentId: string; condition: Condition; result: MelClass;
    whenSeatBlocked?: MelClass;            // replaces `result` while the seat is blocked (life vest)
    constraint?: { variant?: string[] };   // configuration override; the most specific entry wins
    sourceId: string;
  }
  // ReleaseContent gains: mel: MelEntry[]
  ```
- `BinAttributes.binType` and `capacityBags` are required in new releases. Readers of stored snapshots accept their absence: treat a missing type as `"PIVOT"` and missing capacity as `4` via `binTypeOf(bin)` in `src/domain/types.ts`. The 5d6679d store has old-shape snapshots.
- `KIND_ORDER` becomes `{ SEAT: 0, ARMREST: 1, FLOOR: 2, BIN: 3 }`.

- [ ] **Step 1: Write failing tests**
  - `schema.test.ts`, "a release with mel entries and an ARMREST location round-trips": parse a minimal release with one `MelEntry` and one `ARMREST` location, and expect `ReleaseContentSchema.parse(x)` to deep-equal `x`. An unknown `condition` value (`"DIRTY"`) fails.
  - `referenceStore.test.ts`, "stage/activate/read keeps mel": a staged release with two `mel` entries reads back equal, and its `contentHash` changes when one entry's `result` changes.
  - `schema.test.ts`, "binTypeOf defaults an old-shape bin": `binTypeOf({ side: "L", module: 1, rowFrom: 1, rowTo: 3 } as never)` equals `{ binType: "PIVOT", capacityBags: 4 }`.
- [ ] **Step 2:** Run `npx vitest run tests/unit/schema.test.ts tests/integration/referenceStore.test.ts`. Expected: FAIL (unknown key `mel` or kind).
- [ ] **Step 3:** Implement the types, the strict zod schemas (keep `SchemaAgreesWithTypes` compiling), the `mel` plumbing in the six places, `binTypeOf`, and `KIND_ORDER`. `emptyFixtureContent` gets `mel: []`.
- [ ] **Step 4:** Run `npm run check`. Expected: all pass, with the fixture hash unchanged (no data yet).
- [ ] **Step 5:** Commit `feat(domain): armrest kind, bin type and MEL entries in reference content (VAC-1)`.

### Task 2: Fictional data: new pieces, armrests, bin modules and types, rules, MEL

**Files:**
- Modify: `fixtures/fixture-data.json`
- Modify: `src/importer/fixtureSchema.ts` (`SeatSpecSchema` :14, the variants schema, a new `mel` key)
- Modify: `src/importer/fixtures.ts` (`SEAT_COMPONENTS` :66, `buildRevision` :93-183, rules :379-466)
- Modify: `src/domain/geometry.ts` (add `armrestPlacement`)
- Re-pin: `tests/helpers.ts:19`, `tests/unit/fixtures.test.ts`, `tests/unit/geometry.test.ts:111-120`, `tests/unit/visitLogic.test.ts`, `tests/unit/resolve.test.ts:193`, `tests/unit/report.test.ts`, `tests/unit/validate.test.ts`, `tests/unit/scale.test.ts:35`, `tests/web/model.test.ts:44`, `tests/integration/api.test.ts`, `tests/integration/headers.test.ts:53` (payload budget), `tests/integration/visitStoreCompat.test.ts:139` (only the new-release assertions; old-store assertions stay)
- Test: `tests/unit/fixtures.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces: the fixture release with the following content.

**Seat components.** The `componentIds` of a seat, in this order: `CUSHION, BACKREST, HEADREST, SEATBELT, TRAY, SEATBACK_NET, LIFE_VEST`.

**ARMREST locations, per row and side.**
- Ids for a side with seats A, B and C: `ARMREST:<row>-A` (wall side of A), `ARMREST:<row>-AB`, `ARMREST:<row>-BC` and `ARMREST:<row>-C` (aisle side of C). The other side mirrors with F, EF, DE and D.
- Seats that the spec omits drop the spans that touch them. A span between a present seat and an omitted one becomes that seat's outer armrest.
- `componentIds: ["ARMREST"]`. Labels: "Armrest between 12A and 12B", "Armrest at the window, 12A", "Armrest at the aisle, 12C".

**New `ComponentDef`s.** `maxReplacementsPerLocation` 1 unless stated.

| id | kind | name |
|---|---|---|
| HEADREST | SEAT | Headrest cover |
| SEATBELT | SEAT | Seat belt |
| TRAY | SEAT | Tray table (on the seat in front) |
| SEATBACK_NET | SEAT | Seat-back net (on the seat in front) |
| LIFE_VEST | SEAT | Life vest (under the seat) |
| ARMREST | ARMREST | Armrest |
| BIN_LATCH | BIN | Bin latch and release button |
| BIN_STRIKER | BIN | Bin latch striker |
| BIN_PIVOT | BIN | Bin hinge / pivot |
| BIN_ASSIST | BIN | Bin assist spring and damper |
| BIN_LINER | BIN | Bin floor liner |
| BIN_SIDE_PANEL | BIN | Bin inner side panel (max 2) |
| BIN_BUMPER | BIN | Bin stop bumper |
| BIN_SEAL | BIN | Bin closeout seal |
| BIN_PLACARD | BIN | Bin maximum-weight placard |
| BIN_LABEL | BIN | Bin row label |

`BIN_DOOR` is renamed "Bin door / bucket face".

**Bin pieces by type.**
- `CLASSIC`: all bin pieces except BIN_ASSIST and BIN_BUMPER.
- `PIVOT`: all of them.
- `LARGE_PIVOT`: all except BIN_ASSIST.

**Seat spec gains `binModules: { L: number[]; R: number[] }`.** Each list gives the module lengths in rows and must sum to `rows`; `fixtureReferenceIssues` reports otherwise. The values are fictional, and each list gets a `"note"` saying so in the JSON:
- S176 (30 rows), each side: `[2,3,3,3,3,2,3,3,3,3,2]` (11 modules: shorter at the doors and over the wing).
- S170 (29): `[2,3,3,3,3,2,3,3,3,2,2]`.
- S137 and S138 (23): `[2,3,3,3,2,3,3,2,2]`.

**Variants gain `binType`:** V09 and V10 `CLASSIC`; V05, V06, V07, V08, V02 and V03 `PIVOT`; V04 and V01 `LARGE_PIVOT`. V11 is `null`.

**Bin capacity:** CLASSIC 3, PIVOT 4, LARGE_PIVOT 6.

**Layouts are per (seat spec, bin type).**
- Ids: `FX-L-<spec>-<CL|PV|LP>`, revision `@1`, for example `FX-L-S176-LP@1`.
- Every variant points at the layout for its spec and bin type.
- Bin labels: `Overhead bin L-04 (rows 10-12, 6 bags)`.

**Rules: every new component gets a rule for every released variant with a seat spec, so every lookup that is RESOLVED today stays RESOLVED.**
- Seat pieces follow the existing seat pattern: `FX-R-<V>-<ZONE>-<LETTER>-<COMP>`, part `FAKE-<V>-<ZONE>-<LETTER>-<COMP>`.
- ARMREST: one rule per variant, `FX-R-<V>-ARMREST`, part `FAKE-<V>-ARMREST`, `locations {kind:"ARMREST"}`.
- Bin pieces: one rule per variant per bin piece, `FX-R-<V>-BIN-<COMP>`, part `FAKE-<V>-<BINTYPE>-<COMP>`, `locations {kind:"BIN"}`. BIN_DOOR keeps its per-bin rule. V09 `noBinRules` still skips every bin rule, so N090TL keeps its bin gaps.

**`mel` (fixture key, copied into the release).** Source `FX-DOC-MEL` (add it to `sources`: "Fictional minimum equipment list (demo)").
- One entry per component and condition that the component allows. The allowed conditions are:
  - covers and liners: STAINED, TORN, WORN, MISSING, OTHER;
  - SEATBELT: BROKEN, MISSING, WORN, OTHER;
  - BIN_DOOR and BIN_LATCH: add WONT_LATCH.
- Values:
  - CUSHION, BACKREST, HEADREST, ARMREST, SEATBACK_NET, BIN_LINER, BIN_SIDE_PANEL, BIN_BUMPER, BIN_SEAL, BIN_LABEL, CARPET_KIT and CARPET_PANEL: COSMETIC for every condition, except SEATBACK_NET MISSING, which is COSMETIC as well.
  - SEATBELT BROKEN and MISSING: `MEL item FX-25-21-01 cat C 10d "Seat blocked and placarded INOP" blocksSeat`. WORN and OTHER: COSMETIC.
  - LIFE_VEST MISSING: `NO_GO "A life vest is required at every occupied seat"`, with `whenSeatBlocked` `MEL FX-25-61-01 cat C 10d "Seat blocked"`. STAINED, TORN and WORN: COSMETIC.
  - TRAY BROKEN: `MEL FX-25-22-01 cat D 120d "Tray stowed and placarded INOP"`. Other conditions: COSMETIC.
  - BIN_DOOR WONT_LATCH, and BIN_PIVOT BROKEN or MISSING: `NO_GO "Bin cannot be secured"`. Other BIN_DOOR conditions: COSMETIC.
  - BIN_LATCH and BIN_STRIKER BROKEN, MISSING or WONT_LATCH: `MEL FX-25-31-01 cat C 10d "Bin empty, locked and placarded INOP"`.
  - BIN_ASSIST BROKEN: `MEL FX-25-31-02 cat D 120d "Bin opens without assist"`.
  - BIN_PLACARD MISSING or TORN: `NO_GO "Maximum-weight placard required"`. WORN: COSMETIC.
- One override as a worked example: `constraint {variant:["V09"]}` makes TRAY BROKEN `MEL cat C 10d`.

- [ ] **Step 1: Write failing tests** in `fixtures.test.ts`:
  - "S176 LARGE_PIVOT layout has 176 seats, 11 bins per side, and the armrests": kinds `{SEAT:176, ARMREST:<computed n>, FLOOR:4, BIN:22}`. Compute `n` once from the rule above, assert it, and say how in a comment.
  - "every seat has the seven seat pieces in order".
  - "bin pieces follow the bin type": V01 bins have no BIN_ASSIST; V05 bins have it.
  - "binModules must sum to rows": a spec with `[3,3]` for 30 rows gives a reference issue.
  - "N100TL, N200TL and N300TL resolve RESOLVED with every component matched".
  - "N090TL stays PARTIAL with the bin gaps": assert the exact new gap count.
  - "every component and condition used by the UI has exactly one base MEL entry".
- [ ] **Step 2:** Run `npx vitest run tests/unit/fixtures.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the data, the schema keys, the generator and `armrestPlacement(row, side, spanIndex)`. Its x is the row centre; its z sits between the two seats' lateral centres, or at the seat edge for wall and aisle armrests; size 0.06 × 0.5 × 0.25.
- [ ] **Step 4:** Run `npm run check`. Re-pin each listed test with its new exact value, in the same commit. Write the new content hash into `tests/helpers.ts:19`.
- [ ] **Step 5:** Run `npm run originals:verify`. Expected: unchanged pass.
- [ ] **Step 6:** Commit `feat(fixtures): seat, armrest and bin pieces, bin types and modules, fictional MEL (VAC-2)`.

### Task 3: Domain: classify, seat-blocked, due/overdue, carry-forward mapping

**Files:**
- Create: `src/domain/observations.ts`
- Modify: `src/domain/types.ts` (observation types below)
- Test: `tests/unit/observations.test.ts`

**Interfaces:**
- Consumes: `MelEntry`, `MelClass`, `Condition` (Task 1); `CabinLocation`.
- Produces:
  ```ts
  export type ObservationOutcome = "NOTED" | "DEFERRED" | "MUST_FIX" | "REPLACED" | "FIXED";
  export type DeferUntil = "NEXT_CHECK" | "NEXT_STOP";
  export type DeferReason = "NO_STOCK" | "NO_TIME" | "OTHER";
  export interface ObservationInput {
    locationId: string; componentId: string; condition: Condition; note: string;
    outcome: "NOTED" | "DEFERRED" | "MUST_FIX";
    deferUntil?: DeferUntil; reason?: DeferReason; raisedTo?: "MEL" | "NO_GO";
  }
  export interface Observation extends ObservationInput {
    id: string; tail: string; status: "OPEN" | "CLOSED"; version: number;
    melClass: MelClass;           // effective class when last written
    dueDate: string | null;       // YYYY-MM-DD, MEL only, fixed when first deferred
    blocksSeat: boolean;
    openedInVisitId: string; closedInVisitId: string | null; closedAs: "REPLACED" | "FIXED" | null;
    locationLabel: string; componentName: string; createdAt: string; updatedAt: string;
  }
  export interface CarriedObservation { observation: Observation; placement: "SAME" | "MAPPED" | "ORPHANED"; locationId: string | null; overdue: boolean }

  export function melEntryFor(mel: MelEntry[], componentId: string, condition: Condition, variant: string): MelEntry | null;
  export function classify(args: { mel: MelEntry[]; componentId: string; condition: Condition; variant: string; seatBlocked: boolean; raisedTo?: "MEL" | "NO_GO" }): MelClass;
  export function allowedOutcomes(cls: MelClass): ("NOTED" | "DEFERRED" | "MUST_FIX")[];
  export function dueDateFor(cls: MelClass, deferredOn: string): string | null;
  export function isOverdue(dueDate: string | null, onDate: string): boolean;
  export function effectiveClass(o: Observation, onDate: string): MelClass;
  export function seatIsBlocked(openObservations: Observation[], seatLocationId: string): boolean;
  export function mapCarried(open: Observation[], locations: CabinLocation[], onDate: string): CarriedObservation[];
  ```

**Rules (pin these in tests):**
- `melEntryFor`: an entry whose `constraint.variant` includes the variant wins over the base entry. No entry → `null`.
- `classify`: with no entry → `{class:"COSMETIC"}`. While the seat is blocked, `whenSeatBlocked` replaces `result`. Then `raisedTo` applies only if it is stricter: raising to MEL with no MEL entry gives `{class:"MEL", item:"TECH-RAISED", category:"C", intervalDays:10, conditions:"Raised by the technician"}`. A lower `raisedTo` is ignored.
- `allowedOutcomes`:
  - COSMETIC → `["NOTED","DEFERRED"]`;
  - MEL → `["DEFERRED","MUST_FIX"]`;
  - NO_GO → `["MUST_FIX"]`.
- `dueDateFor`: MEL → `deferredOn + intervalDays` (UTC date arithmetic). Otherwise `null`. Category A uses its `intervalDays` as given.
- `isOverdue(due, on)` is `on > due`. It is false on the due date.
- `effectiveClass`: an open DEFERRED MEL observation that is overdue on `onDate` → `{class:"NO_GO", reason:"MEL deferral expired on <due>"}`.
- `seatIsBlocked`: true when an OPEN, DEFERRED observation on that seat has `blocksSeat`.
- `mapCarried`:
  - **SAME:** the location exists and has the component.
  - **MAPPED:** BIN only. The location is missing, or lacks the component, but a BIN on the same side contains the observation's first row (from its stored `locationLabel` row span, parsed by `binRowsFromLabel`) and has the component.
  - **ORPHANED:** otherwise, with `locationId: null`.
  - Order: ORPHANED last, then by location order.

- [ ] **Step 1:** Write failing tests in `observations.test.ts`, one per rule above, with these named cases:
  - "life vest missing is NO_GO, MEL once the seat belt deferral blocks the seat";
  - "a V09 override wins for TRAY BROKEN";
  - "raising COSMETIC to MEL gives the TECH-RAISED entry; lowering is ignored";
  - "due on 2026-11-28 is deferrable on 2026-11-28 and NO_GO on 2026-11-29";
  - "a PIVOT BIN_ASSIST problem is ORPHANED on a LARGE_PIVOT layout";
  - "a BIN_DOOR problem on L-04 (rows 10-12) maps to the bin covering row 10";
  - "a SAME seat piece keeps its location".
- [ ] **Step 2:** Run `npx vitest run tests/unit/observations.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `src/domain/observations.ts`. It is pure, with no I/O, and uses `compareCodePoints` for ordering.
- [ ] **Step 4:** Run `npm run check`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(domain): classify problems under the MEL, due dates, seat block, carry-forward mapping (VAC-3)`.

### Task 4: Visit store v3: observations, events, completion rules

**Files:**
- Modify: `src/server/migrations.ts` (add `{to:3}`)
- Modify: `src/server/visitStore.ts` (`VISIT_SCHEMA_VERSION` :25 → `"3"`, new methods, `completeVisit` :613, `loadVisitState` :390, `fingerprint` :719)
- Modify: `src/domain/types.ts` (`Visit` and `VisitState` gain `observations: Observation[]` and `carried: CarriedObservation[]`; `VisitSummary` gains `aircraftHeld: boolean`)
- Test: `tests/integration/visitStore.test.ts`, `tests/integration/visitStoreCompat.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces on `VisitStore`:
  ```ts
  addObservation(visitId: string, input: unknown, options?: MutationOptions): VisitMutationResult;
  updateObservation(visitId: string, observationId: string, input: unknown, expectedVersion: number, options?: MutationOptions): VisitMutationResult;
  closeObservation(visitId: string, observationId: string, closedAs: "REPLACED" | "FIXED", expectedVersion: number, options?: MutationOptions): VisitMutationResult;
  completeVisit(visitId: string, expectedVisitVersion: number, options?: MutationOptions & { aircraftHeld?: boolean }): CompletionResult;
  ```
- Error codes:
  - `OBSERVATION_NOT_FOUND` 404;
  - `STALE_OBSERVATION` 409;
  - `OUTCOME_NOT_ALLOWED` 422 (the outcome is not in `allowedOutcomes` of the effective class);
  - `INVALID_OBSERVATION` 422 (unknown piece or condition; DEFERRED without `deferUntil` and `reason`; note over 1000 chars);
  - `REPLACEMENT_MISSING` 422 (closing as REPLACED without a record on that piece in this visit);
  - `MUST_FIX_OPEN` 409 (complete with an open effective NO_GO and no `aircraftHeld: true`; `details.observationIds`);
  - `VISIT_LOCKED` as today.

**Migration `{to:3}`, which adds only:**
- the table `visit_observations` (`id TEXT PK`, `tail`, `location_id`, `component_id`, `condition`, `note`, `outcome`, `defer_until`, `reason`, `raised_to`, `mel_class_json`, `due_date`, `blocks_seat`, `status`, `version`, `opened_in_visit_id`, `closed_in_visit_id`, `closed_as`, `location_label`, `component_name`, `created_at`, `updated_at`), with CHECKs on the enums and an index on `(tail, status)`;
- the column `visits.aircraft_held INTEGER NOT NULL DEFAULT 0`;
- a recreated `visits_complete_needs_records` trigger that aborts with `EMPTY_VISIT` only when there is no `visit_records` row and no `visit_events` row of type `OBSERVATION_%` for the visit;
- a trigger refusing updates to an observation row once its `closed_in_visit_id` visit is COMPLETED.

**Behaviour:**
- Observations are written only through a DRAFT visit of the same tail. The visit's version bumps, as for records.
- Each write appends an event with full before and after values: `OBSERVATION_ADDED {observation}`, `OBSERVATION_UPDATED {before, after}` or `OBSERVATION_CLOSED {before, after}`.
- `RECORD_UPDATED` and `RECORD_REMOVED` payloads gain `before` (the previous record). Old events stay as stored.
- The class is computed with `classify` against the visit snapshot's release `mel`, which is frozen in the snapshot. `VisitSnapshot` gains an optional `mel?: MelEntry[]`: it is set from `release.mel` where the snapshot is built for `POST /api/visits`, and absent in old snapshots, meaning everything is COSMETIC.
- `dueDate` is fixed at the first DEFERRED write, using the visit's `checkDate`. Updates never move it.
- `blocksSeat` is copied from the class.
- `loadVisitState` adds `observations`, which are those opened in or closed in this visit, and `carried`, which is `mapCarried` of the tail's other OPEN observations against this snapshot's locations on `checkDate`.
- Completion: if an observation that is open and touched by this visit, or open on the tail, has an effective NO_GO on `checkDate` and `aircraftHeld !== true`, fail with `MUST_FIX_OPEN`. Otherwise store `aircraft_held`.
- The idempotency scopes are `observation:<visitId>` and the existing `complete:<id>`. The request hash includes `aircraftHeld`.
- `fingerprint()` includes `visit_observations`.

- [ ] **Step 1: Write failing tests** in `visitStore.test.ts`:
  - "add, update, close an observation appends ADDED/UPDATED/CLOSED with before/after".
  - "MUST_FIX on a COSMETIC problem needs raisedTo": without `raisedTo` it gives `OUTCOME_NOT_ALLOWED`, and with `raisedTo:"NO_GO"` it is accepted.
  - "NO_GO cannot be DEFERRED".
  - "closing as REPLACED needs a record on that piece".
  - "a stale expectedVersion gives STALE_OBSERVATION; the same key replays without a second row".
  - "a deferral carries to the next visit on the tail and is closed there".
  - "an MEL deferral past its due date blocks completion with MUST_FIX_OPEN until aircraftHeld".
  - "a visit with only an observation completes".
  - "a visit with nothing still fails with EMPTY_VISIT".
  - "N200TL V05 → V04: a BIN_ASSIST deferral arrives ORPHANED".

  In `visitStoreCompat.test.ts`:
  - "the 5d6679d store migrates to v3, its /1 report is byte-identical, and the old draft completes".
  - Update the `to` constant check.
- [ ] **Step 2:** Run `npx vitest run --project integration`. Expected: FAIL.
- [ ] **Step 3:** Implement. Use the existing `write()` and `replay`/`remember` patterns, and map trigger messages as at :301.
- [ ] **Step 4:** Run `npm run check`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(server): per-tail observations with MEL rules, schema v3, hold on completion (VAC-4)`.

### Task 5: HTTP routes and web API client

**Files:**
- Modify: `src/server/app.ts` (next to the record routes :463-519)
- Modify: `src/web/api.ts` (`api` object :194)
- Test: `tests/integration/api.test.ts`, `tests/web/api.test.ts`

**Interfaces:**
- Routes. Bodies are hand-parsed like the existing ones; unknown keys give `UNSUPPORTED_FIELD`.
  - `POST /api/visits/:id/observations` `{observation: ObservationInput, idempotencyKey}` → 201 `{visit: VisitState}`
  - `PUT /api/visits/:id/observations/:obsId` `{observation, expectedVersion, idempotencyKey}` → 200
  - `POST /api/visits/:id/observations/:obsId/close` `{closedAs, expectedVersion, idempotencyKey}` → 200
  - `POST /api/visits/:id/complete` gains an optional `aircraftHeld: boolean`.
  - `GET /api/visits/:id` already returns `VisitState`, now with `observations` and `carried`.
- Client: `api.addObservation(id, input, key)`, `api.updateObservation(id, obsId, input, expectedVersion, key)`, `api.closeObservation(id, obsId, closedAs, expectedVersion, key)`, and `api.complete(id, expectedVisitVersion, key, aircraftHeld?)`.
- Mutation responses stay within `budgets.json` `api.mutationResponseBytes`. If the larger state breaks the 8000-byte budget, raise it once in this task to the measured value plus 20%, and record why in the commit message.

- [ ] **Step 1:** Write failing tests in `api.test.ts`: each route happy path; `MUST_FIX_OPEN` envelope with `details.observationIds`; `UNSUPPORTED_FIELD` on an extra key; replay with the same key returns 200 and the same body. In `tests/web/api.test.ts`: each new client function sends the exact path and body.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run check`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): observation routes and complete with aircraftHeld (VAC-5)`.

### Task 6: Web model: piece status and observations

**Files:**
- Modify: `src/web/model.ts` (`LocationStatus` :8, `STATUS_ENCODING` :15, `aggregateStatus` :36, `Workspace` :44, `componentsAt` :67, `buildStates` :96)
- Test: `tests/web/model.test.ts`

**Interfaces:**
- `LocationStatus` becomes `"mustFix" | "unresolved" | "deferred" | "carried" | "noted" | "recorded" | "alternate" | "none"`. That order is the rank `aggregateStatus` uses, highest first.
- `Workspace` gains `observations: Observation[]`, `carried: CarriedObservation[]`, `checkDate: string` and `mel: MelEntry[]`.
- `ComponentView` gains:
  - `problems: Observation[]`: open, on this piece;
  - `carried: CarriedObservation | null`;
  - `melClass: (condition: Condition) => MelClass`: closed over the seat-blocked state;
  - `pieceStatus: LocationStatus`.
- The piece status:
  - `mustFix` if any problem's effective class is NO_GO or its outcome is MUST_FIX;
  - else `deferred` for an open DEFERRED problem, or `carried` for one that arrived from an earlier visit;
  - else `noted`;
  - else the existing record-based status.
- `buildStates` puts each piece's `pieceStatus` into `LocationState.components`.
- `buildStates` also adds a `flags.blocked: Set<string>` of seat ids.

- [ ] **Step 1:** Write failing tests:
  - "rank: mustFix beats unresolved beats deferred …";
  - "a piece with a record and an open NOTED problem is noted";
  - "an overdue carried MEL deferral is mustFix on the visit's checkDate";
  - "a blocked seat appears in flags.blocked".
- [ ] **Step 2:** Run `npx vitest run --project web tests/web/model.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. CheckView, LayoutsView and PrepView build `Workspace` with the new fields; they pass empty lists where they have no visit.
- [ ] **Step 4:** Run `npm run check`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): piece-level status from records and problems (VAC-6)`.

### Task 7: Inspector: piece panel and problem form

**Files:**
- Modify: `src/web/components/Inspector.tsx`
- Modify: `src/web/format.ts` (plain-language labels)
- Test: `tests/web/Inspector.test.tsx`

**Interfaces:**
- Props gain:
  - `onObserve(input: ObservationInput): void`;
  - `onUpdateObservation(o: Observation, input: ObservationInput): void`;
  - `onCloseObservation(o: Observation, closedAs: "REPLACED" | "FIXED"): void`.
- `format.ts` exports:
  - `conditionLabel(c)`: "Stained", "Torn", "Worn", "Broken", "Missing", "Won't latch", "Other";
  - `melLabel(cls)`:
    - "Cosmetic: can wait";
    - "MEL item FX-25-21-01 (category C, fix within 10 days): <conditions>";
    - "No-go: must be fixed before flight. <reason>";
  - `outcomeLabel`, `deferLabel` ("Until the next check", "Until the next stop") and `reasonLabel` ("No stock on hand", "No time on this turn", "Other").

**Panel layout per piece card (copy is exact):**
- Heading: `<location label> · <component name>`, for example "Seat 12A · Headrest cover".
- Part line, as today.
- Then three buttons: "Replace now", which opens the existing record fieldset; "Note a problem"; and "Defer".
  - "Defer" opens the same form with the outcome preset to DEFERRED.
  - "Defer" is hidden when DEFERRED is not allowed for any condition. Within the form, outcomes come from `allowedOutcomes(melClass(condition))`.
- The form, in this order:
  1. Condition: radio buttons.
  2. "What this means": `melLabel`, plus a due date line for MEL ("Fix by 28 Nov 2026").
  3. Outcome: radio buttons from the allowed list, labelled "Note only", "Defer" and "Must be fixed before flight".
  4. If Defer: "Until" radio buttons and "Reason" radio buttons.
  5. An optional note of up to 1000 characters.
  6. "Make this stricter" (a select with "MEL item" and "No-go", showing only levels above the current one).
  7. Submit: "Save problem".
- Open problems on the piece are listed with an "Edit" button, plus "Mark replaced" (enabled only when a record exists on the piece) and "Mark fixed".
- A carried problem shows "Carried over from the check on <date>". When it is overdue it adds "Overdue since <date>" in the must-fix style.

- [ ] **Step 1:** Write failing tests:
  - "a life vest marked Missing offers only Must be fixed";
  - "after a seat belt deferral on the same seat it offers Defer with a fix-by date";
  - "Defer hides Note only for an MEL item";
  - "Make this stricter offers only higher levels";
  - "Mark replaced is disabled without a record";
  - "the copy shows no raw codes": the rendered text does not match `/NO_GO|WONT_LATCH|NEXT_CHECK/`;
  - "submit calls onObserve with the exact ObservationInput".
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Reuse the existing `ComponentCard` structure and `data-component` hook, and keep the keyboard order to match the visual order.
- [ ] **Step 4:** Run `npm run check`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): piece panel with replace, note a problem and defer under the MEL (VAC-7)`.

### Task 8: Check view: carried-over list, completion with hold, go-to pieces

**Files:**
- Modify: `src/web/views/CheckView.tsx` (write wiring :382-445)
- Modify: `src/web/components/CabinMap.tsx` (`submitGoTo` :82-95)
- Test: `tests/web/CheckView.test.tsx`, `tests/web/CabinMap.test.tsx`

**Interfaces:**
- Writes for observations go through `useMutations`. The targets are `observation:<locationId>:<componentId>` for new problems and `observation:<id>` for edits.
- A "Carried over" panel sits above the work list when `carried.length > 0`. It lists each item with its label, condition, outcome and due date, and a "Show" button that selects it. ORPHANED items are listed under "No longer at this position" with Mark fixed only.
- The completion dialog lists every open must-fix item. If any are open, the confirm button is replaced by a required checkbox, "Aircraft held, reported to maintenance", plus "Complete check". The call sends `aircraftHeld: true`.
- **Go to location parsing:**
  - The input "12A headrest" (any case, with piece-name words from `ComponentDef.name`) selects `SEAT:12A` and focuses HEADREST.
  - "L-04 latch" selects `BIN:L-04` + BIN_LATCH and opens the bin.
  - "12AB" or "armrest 12A 12B" selects `ARMREST:12-AB`.
  - The datalist gains piece entries for the selected location only, so it doesn't grow 7×.

- [ ] **Step 1:** Write failing tests:
  - "carried-over panel lists the deferral and Show selects it";
  - "an orphaned item appears under No longer at this position";
  - "complete with an open must-fix needs the hold checkbox and sends aircraftHeld";
  - "go to 12A life vest selects the seat and focuses LIFE_VEST";
  - "go to L-04 latch focuses BIN_LATCH".
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run check`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): carried-over list, hold on completion, go to a piece (VAC-8)`.

### Task 9: Map/list: armrests, pieces, statuses

**Files:**
- Modify: `src/web/components/CabinMap.tsx` (seat grid :14, bins :253-275)
- Test: `tests/web/CabinMap.test.tsx`

**Interfaces:**
- **Seat grid:**
  - Each seat button keeps `data-seat`. Its status badge uses the aggregated piece status, with the new statuses and their text badges ("Must fix", "Deferred", "Carried", "Noted").
  - Armrests render as narrow buttons between seats with `data-location="ARMREST:…"`. On narrow screens they collapse into the selected seat's piece list.
- **Bins** show type, rows and capacity ("L-04 · rows 10-12 · 6 bags").
- **Selected location:** below the map, a "Pieces at <label>" list has a button per piece (`data-component`) with its status. This is the non-3D path to every piece, including the life vest and the bin interiors.
- A blocked seat shows "Blocked".

- [ ] **Step 1:** Write failing tests:
  - "armrest 12-AB is a button between 12A and 12B";
  - "selecting 12A lists its seven pieces and the life vest is selectable";
  - "a bin lists its inner pieces by type";
  - "a mustFix piece shows the Must fix badge text";
  - "a blocked seat shows Blocked".
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run check`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): armrests, piece list and new statuses on the map (VAC-9)`.

### Task 10: 3D seats: one mesh per piece, under-seat layer, new budget

**Files:**
- Modify: `src/web/scene/seatParts.ts` (`buildSeatGeometries` :143, `SeatGeometries` :110)
- Modify: `src/web/scene/CabinScene.ts` (`SeatPart` :139, `addSeatMesh` :618-654, `applyStates` :1103, `applyLayers` :1016, `hit` :1533, hover)
- Modify: `src/web/components/Cabin3D.tsx` (layers :143/:357, the legend)
- Modify: `src/web/scene/materials.ts` (`STATUS_COLOUR` :114)
- Modify: `budgets.json`, `e2e/helpers.ts:16`
- Test: `tests/web/seatBudget.test.ts`, `tests/web/Cabin3D.test.tsx`, `e2e/scene.spec.ts`

**Interfaces:**
- **Tagging.** Every pickable instanced mesh carries `{ component: string; owner: "self" | "behind" }`:
  - pan → CUSHION;
  - backCore, backFront, rearShell and wings → BACKREST;
  - headrest → HEADREST;
  - a new belt mesh on the pan → SEATBELT;
  - new tray and net meshes on the rear of each seat back → TRAY and SEATBACK_NET, with `owner: "behind"`;
  - a new vest mesh under the pan → LIFE_VEST;
  - armPads → ARMREST, but instanced per armrest location, not per seat;
  - legs → null.
- **Owner "behind".** `hit()` maps a hit on seat instance i to the seat directly aft in the same column: same letter, next physical row. When there is no seat behind, the tray and net are not drawn for that seat.
- **Row 1 or a bulkhead row.** The tray and net for that row's seats are drawn on a thin bulkhead panel ahead of row 1. Its instances are indexed by the row-1 seats.
- **`hit()`** returns `{ location, component }` with the owner applied. It returns the ARMREST location for armrest pads.
- **Layers** gain `underSeat` (default off). The vest mesh is visible only when it is on. When off, the vest is not pickable.
- **Status tint per piece.** Each piece mesh gets a per-instance colour attribute from `LocationState.components[piece]`, using the `headrestTint` technique generalised to all piece meshes; opacity stays `HEADREST_TINT_OPACITY`. Hover outlines only the hovered piece's instance.
- **Hover** shows the piece name with the location, for example "12A · Headrest cover", in the existing hover label.
- **A blocked seat** (`flags.blocked`) shows a grey "Blocked" badge, using the existing badge mesh.
- **New `STATUS_COLOUR` entries** for mustFix, deferred, carried and noted. They read their colours from the scene tokens (Task 15 sets the light and dark values); until then they use fallback constants in the same file.
- **Budget.**
  - Measure `renderer.info` in the worst-case e2e (every location with a status, all layers on).
  - Set `scene.drawCalls176` and `scene.triangles176` to the measured values plus 10%, and `seatTriangles` to `seatTriangleCount(...)` plus 10%. Record the before and after values in the commit message.
  - Hard caps: draw calls ≤ 48 and triangles ≤ 700,000. If the scene would exceed these, merge the tray and net into one mesh with a per-instance piece id, and lower segment counts.

- [ ] **Step 1:** Write failing tests:
  - `Cabin3D.test.tsx`: "a hit on the tray behind 11A selects SEAT:12A TRAY"; "the life vest is not pickable until Under seat is on"; "an armrest pad selects ARMREST:12-AB".
  - `seatBudget.test.ts`: the new ceiling.
  - `e2e/scene.spec.ts` (update PF-21, :155 and :180): budgets from `budgets.json`; "clicking the headrest of 7C focuses HEADREST, not BACKREST" (replacing the :242 assumption).
- [ ] **Step 2:** Run `npx vitest run --project web`. Expected: FAIL.
- [ ] **Step 3:** Implement. Keep instancing, so there is one mesh per piece kind. Dispose new geometries with the existing lifecycle.
- [ ] **Step 4:** Run `npm run check && npm run build && npm run budgets && npm run test:e2e`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(scene): tappable seat pieces, tray and net for the seat behind, under-seat layer (VAC-10)`.

### Task 11: 3D bins: three types, opening, inner pieces

**Files:**
- Modify: `src/web/scene/seatParts.ts` (`buildBinGeometry` :223 becomes `buildBinGeometry(side, binType)`, returning `{ closedBody, door, interior: Record<BinPiece, BufferGeometry> }`)
- Modify: `src/web/scene/CabinScene.ts` (bins :752-800, `applyStates` :1146-1151, `hit`)
- Modify: `src/web/components/Cabin3D.tsx` (a "Close bin" button and the open-bin state)
- Test: `tests/web/Cabin3D.test.tsx`, `e2e/scene.spec.ts`

**Interfaces:**
- **Geometry per type:**
  - **CLASSIC:** a door hinged at the top edge, opening upward by rotating 75° about that edge; a fixed shelf.
  - **PIVOT:** the bucket rotates 35° down about its side pivots.
  - **LARGE_PIVOT:** a deeper bucket rotating 38°, whose open bottom edge sits 0.05 m lower than PIVOT's.
- **Scene API:**
  - `openBin(locationId: string | null): void` closes any other open bin, so at most one is open.
  - `onBinOpenChange?(locationId | null)` is a scene callback.
  - The animation lasts 350 ms, easeOutCubic. With reduced motion, the change happens immediately.
- **Picking:**
  - A tap on a closed bin opens it and selects `BIN_DOOR`.
  - While a bin is open, its interior pieces are pickable: liner, side panels, latch, striker, pivot, assist (PIVOT only), bumper, seal, placard and label.
  - A tap on the open door or bucket face selects BIN_DOOR. "Close bin" or Escape closes it.
- **Status:**
  - A closed bin with any piece status other than none shows the existing badge, plus a coloured marker on the bin face.
  - The interior pieces are tinted per piece.
- **Draw calls.** Interior meshes exist only for the open bin: one small set, rebuilt when the open bin changes. They stay within the Task 10 caps. Closed bins stay instanced per side.

- [ ] **Step 1:** Write failing tests:
  - "tapping BIN:L-04 opens it and selects BIN_DOOR; a second bin closes the first";
  - "the latch is pickable only while open";
  - "BIN_ASSIST is drawn for PIVOT and absent for LARGE_PIVOT";
  - "reduced motion opens in one frame";
  - e2e: "open a bin, select the latch, the inspector shows Bin latch and release button; draw calls stay within budget with a bin open".
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run check && npm run build && npm run budgets && npm run test:e2e`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(scene): three bin types that open, with tappable inner pieces (VAC-11)`.

### Task 12: Report v3: summary, timeline, outcome lists, release flag

**Files:**
- Modify: `src/domain/report.ts` (`buildReport` :117), `src/domain/types.ts` (`Report` :648, `REPORT_SCHEMA` :646)
- Test: `tests/unit/report.test.ts`

**Interfaces:**
- `REPORT_SCHEMA = "cabin-kit.report/3"`. Readers accept `/1`, `/2` and `/3`. Stored reports are served unchanged.
- `Report` gains these fields. All are optional in the type, for older reports, and always present in `/3`:
  ```ts
  summary?: { replaced: number; noted: number; deferredCosmetic: number; deferredMel: number; mustFix: number; carriedIn: number; stillOpen: number; releasable: boolean; aircraftHeld: boolean };
  timeline?: { seq: number; at: string; kind: "RECORD_ADDED" | "RECORD_UPDATED" | "RECORD_REMOVED" | "OBSERVATION_ADDED" | "OBSERVATION_UPDATED" | "OBSERVATION_CLOSED" | "COMPLETED"; locationId: string | null; componentId: string | null; label: string; before: unknown | null; after: unknown | null }[];
  observations?: { deferred: Observation[]; mustFix: Observation[]; noted: Observation[]; closed: Observation[]; carriedIn: CarriedObservation[]; stillOpen: Observation[] };
  pieceOutcomes?: { locationId: string; componentId: string; status: LocationStatus }[]; // feeds the cabin picture
  ```
- `releasable` is false if any observation that is open at completion has an effective NO_GO on `checkDate`.
- `timeline` is built from `visit.events` in `seq` order. CREATED is excluded; `label` is plain words, for example "Seat 12A · Headrest cover: problem noted (Stained)".
- `buildReport` takes the carried list from `visit.carried`. Snapshots without `mel` work, with everything COSMETIC.

- [ ] **Step 1:** Write failing tests:
  - "summary counts each outcome once";
  - "releasable false with an open overdue MEL deferral and aircraftHeld true";
  - "timeline is in seq order with before/after for an update";
  - "a /1 stored report still parses and renders its totals";
  - "pieceOutcomes ranks mustFix over recorded on the same piece".
- [ ] **Step 2:** Run `npx vitest run tests/unit/report.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. It stays pure.
- [ ] **Step 4:** Run `npm run check`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(domain): report v3 with summary, timeline and outcome lists (VAC-12)`.

### Task 13: Report view: cabin picture, timeline, lists

**Files:**
- Modify: `src/web/views/ReportView.tsx`
- Modify: `src/web/components/CabinMap.tsx` (a `readOnly` prop that takes `pieceOutcomes`)
- Test: `tests/web/ReportView.test.tsx`, `tests/web/readableViews.test.tsx`

**Interfaces:**
- **Section order:**
  1. "Summary" (`h3#r-summary`), with "Not releasable: aircraft held" in the must-fix style when `!releasable`.
  2. "Cabin picture" (`#r-picture`): a read-only `CabinMap` coloured by `pieceOutcomes`, with the legend and a "View in 3D" toggle. That toggle mounts `Cabin3D` read-only with the same states, loaded lazily.
  3. "What happened, in order" (`#r-timeline`): an ordered list with a `<time>` for each entry.
  4. "Deferred", "Must be fixed", "Noted", "Closed this check", "Carried over in" and "Still open".
  5. The existing sections, unchanged.
- **`/1` and `/2` reports** render without the new sections, with no empty headings.

- [ ] **Step 1:** Write failing tests:
  - "a v3 report shows Summary, Cabin picture, timeline and the outcome lists";
  - "Not releasable shows when releasable is false";
  - "a /2 report shows no empty new sections";
  - `readableViews`: no raw codes or ISO timestamps in the new sections.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run check && npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): after-action report with cabin picture, timeline and outcome lists (VAC-13)`.

### Task 14: PDF: cabin picture and new sections

**Files:**
- Modify: `src/server/pdf.ts` (`renderReportPdf` :45; sections :274-421)
- Test: `tests/integration/pdf.test.ts`

**Interfaces:**
- New sections after "Visit": "Summary", "Cabin picture", "What happened, in order", and the outcome lists. Then the existing sections follow.
- **Cabin picture:**
  - pdfkit vector drawing, using `rect` and `fill`, on one page. Seats are a grid by row and letter; armrests are thin bars; the floor areas and bins are drawn as strips on each side.
  - Each piece's colour comes from `pieceOutcomes`, aggregated per location. Fixed light colours go in a `PDF_STATUS` map, with a legend.
  - The PDF stays tagged. The picture is wrapped as a `Figure` with alt text, for example "Cabin picture: 3 pieces deferred, 1 must be fixed".
- Text goes through `safe()`, as today.

- [ ] **Step 1:** Write failing tests:
  - "a v3 report PDF has the Summary, Cabin picture and timeline headings in its text";
  - "the figure has alt text";
  - "a /1 report PDF is unchanged in its section list".
- [ ] **Step 2:** Run `npx vitest run tests/integration/pdf.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run check`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(pdf): cabin picture and after-action sections (VAC-14)`.

### Task 15: Theme tokens and the end-to-end visual check

**Files:**
- Modify: `src/web/styles/tokens.css` (light :178, dark :234/:289), `src/web/styles/*.css` for the new badges and form, and `src/web/scene/materials.ts`
- Create: `e2e/visual-check.spec.ts`
- Modify: `e2e/a11y.spec.ts` (add the report v3 and the open-bin states)
- Test: those e2e specs and `tests/web/a11y.test.tsx`

**Interfaces:**
- **Tokens** `--status-mustfix`, `--status-deferred`, `--status-carried`, `--status-noted`, each with an `-ink` text variant and light and dark values meeting 4.5:1 for text and 3:1 for UI.
- **Scene tokens** `--scene-status-*`, read by `sceneThemeTokens()` (`Cabin3D.tsx:230`).
- **`e2e/visual-check.spec.ts`**, desktop project. One test per bullet:
  - Look up N100TL, start a visit, tap 12A's headrest in 3D, choose Stained, Defer until next check, reason No stock, and Save. The work list and the map show "Deferred".
  - Open bin L-04, select the latch, choose Won't latch, and see "MEL item … category C" with a fix-by date. Defer it.
  - Complete the check. In the report, the Summary shows 2 deferred, the cabin picture has 2 coloured pieces, and the timeline has 2 entries in order.
  - Start a new visit on N100TL. "Carried over" lists both; mark the headrest replaced after recording a replacement.
  - On N200TL (V05 → V04), a BIN_ASSIST deferral from the earlier configuration appears under "No longer at this position". Seed it through the API in the test.
  - A life vest marked Missing offers only "Must be fixed". Completing needs "Aircraft held" and the report shows "Not releasable".
  - Using the keyboard only: "Go to location" "12A life vest", then record a problem without touching the canvas.
- **a11y:** axe runs on the visual-check states in `desktop`, `dark` and `mobile`, with zero violations.

- [ ] **Step 1:** Write the e2e specs. Expected: FAIL where the styles are missing (axe contrast).
- [ ] **Step 2:** Implement the tokens and styles.
- [ ] **Step 3:** Run `npm run check && npm run build && npm run budgets && npm run test:e2e`. Expected: PASS (120 + new tests, 10 skipped).
- [ ] **Step 4:** Commit `feat(web): status colours for problems in light and dark, end-to-end visual check (VAC-15)`.

### Task 16: Sample data, docs, version

**Files:**
- Modify: `tools/seed-sample-visits.ts` (:104). Add, on N100TL, one completed visit with a deferral and one draft that carries it over.
- Modify: `README.md` (pieces, problems and deferral, the MEL being fictional, the report), `docs/logical-model.md` (Observation, MelEntry, ARMREST, bin type), `docs/visual-families.md` (piece meshes), `docs/operations.md` (schema v3 migration), `CHANGELOG.md` (2.1.0), `package.json` (`"version": "2.1.0"`)
- Test: `tests/process/tools.test.ts` (seed), `npm run verify:clean`

- [ ] **Step 1:** Update the seed and add a failing test: "seed creates a completed visit with one deferral and a draft that shows it carried over".
- [ ] **Step 2:** Run `npx vitest run --project process tests/process/tools.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the seed and the docs. Every new number in the README (seat pieces, bins per side, hash) comes from a command output quoted in the commit message.
- [ ] **Step 4:** Run `npm run check && npm run build && npm run budgets && npm run test:e2e && npm run originals:verify && npm run verify:clean`. Expected: PASS.
- [ ] **Step 5:** Commit `docs: visual appearance check, fictional MEL, v2.1.0 (VAC-16)`.
