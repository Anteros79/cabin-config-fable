# Phase 2: Domain

Read [`00-index.md`](00-index.md) first. Requires Phase 0. Independent of Phase 1 except where noted.

Outcome: reference data that is malformed, mistyped or internally inconsistent is rejected at import with a finding, never at lookup with an exception or a silently wrong answer. Every exclusion is kept and shown.

Conventions for this phase:

- Tests that need a release build one with `buildStagedRelease({ includeCandidate: false }).content`, take a `structuredClone`, change one thing, and assert on `validateRelease(clone)` or `lookup(clone, …)`. This is the pattern in `tests/unit/import.test.ts:222-277`.
- A new validation finding has `severity`, a `code` in `UPPER_SNAKE`, a `message` that names the entity id, and `refs` listing the ids involved.
- If a new check produces a finding on the unmodified fixture release, stop: either the check is wrong or the fixture has a real defect. Fix whichever it is and name it in the commit body. Do not loosen the check to make the fixture pass.

---

### Task 2.1: Structural schema in front of validation

Closes DOM-12, DOM-13, DOM-14, DOM-09, the key half of DOM-02, the bound half of DOM-05.

**Files:**
- Create: `src/domain/schema.ts`, `src/domain/limits.ts`
- Modify: `src/domain/validate.ts` (`validateRelease`), `src/domain/resolve.ts` (export `TAIL_PATTERN`)
- Test: `tests/unit/schema.test.ts`

**Interfaces:**
- `limits.ts`: `export const MAX_QTY = 10_000` (any quantity field in reference data), `MAX_REPLACEMENTS_PER_LOCATION = 1_000`, `MAX_DERIVED_QTY = 1_000_000` (any computed line quantity), `MAX_KIT_DEPTH = 8`.
- `schema.ts`:
  - One zod schema per interface in `types.ts` from `SourceArtifact` to `VisualProfile`, each `.strict()`, composed into `export const ReleaseContentSchema`. Field names, optionality and literal unions are copied from `types.ts`; read it in full first.
  - Compile-time agreement, both directions, at the bottom of the file:
    ```ts
    type Inferred = z.infer<typeof ReleaseContentSchema>;
    const _a: ReleaseContent = {} as Inferred;
    const _b: Inferred = {} as ReleaseContent;
    ```
  - Dates use `z.string().refine(isIsoDate)`. Quantities use `z.number().int().min(1).max(MAX_QTY)`. `maxReplacementsPerLocation` uses `.max(MAX_REPLACEMENTS_PER_LOCATION)`. Tails use `.refine((t) => t === normalizeTail(t) && TAIL_PATTERN.test(t))`. `componentIds` on a location uses `.refine(unique)`.
  - `export function structuralFindings(content: unknown): Finding[]` — runs `safeParse`; each issue becomes `{ severity: "error", code: "SCHEMA_INVALID", message: "<path.joined('.')>: <issue message>", refs: [<nearest entity id on the path, or the entity type>] }`. At most 50 findings, then one `SCHEMA_INVALID` summarising how many more.
- `validateRelease(content)` calls `structuralFindings` first. If it returns any finding, `validateRelease` returns only those (the semantic checks assume sound structure).

- [ ] **Step 1: Write the failing tests.** One `test.each` table; every row mutates the clone and expects a `SCHEMA_INVALID` whose message contains the path fragment:

```ts
const cases: [string, (c: ReleaseContent) => void, string][] = [
  ["rule without locations", (c) => { delete (c.rules[0] as any).locations; }, "rules.0.locations"],
  ["rule without constraint", (c) => { delete (c.rules[0] as any).constraint; }, "rules.0.constraint"],
  ["selector key typo zone", (c) => { const l = c.rules[0]!.locations as any; l.zone = l.zones; delete l.zones; }, "rules.0.locations"],
  ["constraint key typo variants", (c) => { (c.rules[0]!.constraint as any).variants = ["V01"]; }, "rules.0.constraint"],
  ["layout revision without geometry", (c) => { delete (c.layoutRevisions[0] as any).geometry; }, "layoutRevisions.0.geometry"],
  ["assignment status Released", (c) => { (c.assignments[0] as any).status = "Released"; }, "assignments.0.status"],
  ["tail not normalised", (c) => { c.aircraft[0]!.tail = "n100tl"; }, "aircraft.0.tail"],
  ["tail too long", (c) => { c.aircraft[0]!.tail = "N100TL-LONGTAIL"; }, "aircraft.0.tail"],
  ["duplicate component id on a location", (c) => { const l = c.layoutRevisions[0]!.locations[0]!; l.componentIds.push(l.componentIds[0]!); }, "componentIds"],
  ["quantity 1e300", (c) => { c.rules[0]!.qtyPerReplacement = 1e300; }, "rules.0.qtyPerReplacement"],
  ["quantity 2^53", (c) => { c.kitChildren[0]!.qty = 2 ** 53; }, "kitChildren.0.qty"],
  ["quantity 0", (c) => { c.substitutes[0]!.qtyPerReplacement = 0; }, "substitutes.0.qtyPerReplacement"],
  ["impossible date", (c) => { c.rules[0]!.effectiveFrom = "2026-02-30"; }, "rules.0.effectiveFrom"],
];
test.each(cases)("%s", (_name, mutate, path) => {
  const c = structuredClone(base); mutate(c);
  const f = validateRelease(c);
  expect(f.some((x) => x.code === "SCHEMA_INVALID" && x.message.includes(path))).toBe(true);
  expect(hasBlockingFindings(f)).toBe(true);
});
test("the fixture release and the full staged release have no SCHEMA_INVALID", () => { /* includeCandidate false and true */ });
test("validateRelease never throws on garbage", () => { for (const g of [null, 1, "x", [], {}, { rules: 5 }]) expect(() => validateRelease(g as any)).not.toThrow(); });
```

  Use the real property name for the kit quantity (`qty` above is a guess; `types.ts:275` has it).
- [ ] **Step 2: Run.** Expected: FAIL; several cases throw `TypeError`, the rest return no finding.
- [ ] **Step 3: Implement.** Remove from `validate.ts` any hand-written check that the schema now covers, so each rule lives in one place.
- [ ] **Step 4: Run** `npm run check`. **Commit** `feat(domain): strict structural schema for reference data (DOM-02, DOM-05, DOM-09, DOM-12, DOM-13, DOM-14)`.

---

### Task 2.2: Referential and consistency validation

Closes the rest of DOM-02, DOM-07, DOM-10, DOM-15, the validation half of DOM-17 and DOM-19.

**Files:**
- Modify: `src/domain/validate.ts`
- Test: `tests/unit/validate.test.ts` (new file; leave the existing cases in `import.test.ts`)

**Interfaces:** new findings, all from `validateRelease`:

| Code | Severity | Condition |
| --- | --- | --- |
| `SELECTOR_ID_UNKNOWN` | error | A rule or substitute selector `ids` entry exists in no layout revision reachable through the rule's constraint |
| `SELECTOR_VALUE_UNMATCHED` | error | A `zones`, `letters`, `sides`, `floorAreaTypes` value or a row range matches no location in any reachable revision |
| `CONSTRAINT_VALUE_UNKNOWN` | error | A constraint names a variant, subtype, layout revision or hardware value that does not exist in the release; or a carpet, seam or upholstery not in the vocabulary |
| `ROW_RANGE_INVALID` | error | `rowFrom > rowTo`, or only one bound given |
| `ASSIGNMENT_INCONSISTENT` | conflict | Aircraft subtype ≠ variant subtype ≠ layout-revision subtype; or the variant does not list the layout revision; or the revision's seat set is not complete. Mirror the conditions `lookup` tests at `resolve.ts:168-177` by extracting them into one exported function `configurationProblems(aircraft, variant, revision): string[]` used by both |
| `CANDIDATE_HAS_FIXTURE_DATA` | error | A candidate-namespace revision has a seat with a non-null `maintenanceZone`, or any `FLOOR` or `BIN` location |
| `RULES_INCOMPARABLE` | conflict | Two released rules for one component, with overlapping validity, whose match sets intersect and neither is a subset of the other, and no third eligible rule is a strict subset of both on the intersection |
| `SUBSTITUTE_UNREACHABLE` | warning | A substitute's scope intersects no location of any rule that selects its primary part |

- [ ] **Step 1: Write the failing tests,** one per code, each asserting the code, the severity and that `refs` contains the offending id. Inputs from the audit:
  - `SELECTOR_ID_UNKNOWN`: add `"SEAT:99Z"` to a rule's `ids`.
  - `CONSTRAINT_VALUE_UNKNOWN`: constraint `hardware: ["NoSuchHW", "Recaro"]`.
  - `ASSIGNMENT_INCONSISTENT`: set aircraft `N100TL` `subtypeId` to `FX-800`.
  - `CANDIDATE_HAS_FIXTURE_DATA`: full staged content, set `maintenanceZone: "ELR"` on one seat of `CAND-73G@2026.1`.
  - `RULES_INCOMPARABLE`: two released CUSHION rules over all seats, `{ carpet: ["MOHAWK"] }` and `{ variant: ["V01"], seam: ["PRE"] }`.
  - `SUBSTITUTE_UNREACHABLE`: a substitute for `FAKE-SC-1001` scoped to `ids: ["SEAT:30F"]`.
  - Negative: the fixture's deliberate ambiguity on `N090TL` already raises a finding; assert the new code does not duplicate an existing `EQUAL_RULES` finding for the same pair.
- [ ] **Step 2: Run.** Expected: FAIL (no findings).
- [ ] **Step 3: Implement.** `RULES_INCOMPARABLE` reuses `buildIndex` and the existing `MatchSet` helpers; add `export function matchSetsIntersect(a: MatchSet, b: MatchSet): boolean` to `specificity.ts`. Build each rule's match set once and share it with the existing equal-rules check.
- [ ] **Step 4: Run** `npm run check`. **Commit** `feat(domain): referential and consistency findings at import (DOM-02, DOM-07, DOM-10, DOM-15, DOM-17, DOM-19)`.

---

### Task 2.3: Keep every exclusion; report schema 2

Closes DOM-01, DOM-16. Decision D6. Defines the backward-compatibility rule for snapshots and reports.

**Files:**
- Modify: `src/domain/types.ts`, `src/domain/resolve.ts`, `src/domain/report.ts`, `src/domain/prep.ts`, `src/server/pdf.ts`, `src/web/components/Inspector.tsx`, `src/web/views/ReportView.tsx`, `src/web/views/PrepView.tsx`, `docs/logical-model.md`
- Test: `tests/unit/resolve.test.ts`, `tests/unit/report.test.ts` (new)

**Interfaces:**
- `types.ts`:
  ```ts
  export interface ExcludedRule { ruleId: string; partNo: string; sourceId: string; reasons: ExclusionReason[] }
  ```
  `ComponentResolution`: the `RESOLVED` and `AMBIGUOUS` variants gain `excluded?: ExcludedRule[]`; the `NO_MATCH` variant's `excluded` becomes `ExcludedRule[]` with `sourceId` typed optional on read. New code always writes the field (empty array when nothing was excluded). Readers treat a missing field as `[]`.
- `ReportWorkItem` gains `excludedRules?: ExcludedRule[]`. `ReportGap` gains `sourceIds?: string[]`.
- `export const REPORT_SCHEMA = "cabin-kit.report/2"`; `Report["schema"]` is `"cabin-kit.report/1" | "cabin-kit.report/2"`. `buildReport` writes `/2`. Stored `/1` reports are returned untouched (Task 1.7 tests this).
- `report.sources` is the union of sources cited by: work items (rule and selection), their mandatory children, pending changes, `excludedRules`, and gaps (`candidates[].sourceId` for ambiguous, `excluded[].sourceId` for no-match).
- Backward-compatibility rule, stated once in `docs/logical-model.md` under "Visit snapshot": *fields added after a snapshot was frozen are absent from it; every reader defaults them; nothing rewrites a stored snapshot.*
- Display: Inspector, the report page, the PDF and the preparation list show, under a resolved component, a line "Rules not used: `<ruleId>` (`<partNo>`): `<reason messages>`" when `excluded` is non-empty.

- [ ] **Step 1: Write the failing tests.**

```ts
test("an expired exact rule beside a broad rule is kept with its reason", () => {
  const c = structuredClone(base);
  c.rules.push({ ...exactCushionRuleFor(c, "SEAT:3A"), id: "X-EXPIRED-EXACT", effectiveTo: "2026-11-11" });
  const r = lookup(c, "N100TL", "2026-11-12");
  const comp = component(r, "SEAT:3A", "CUSHION");
  expect(comp.status).toBe("RESOLVED");
  expect(comp.excluded).toEqual([expect.objectContaining({ ruleId: "X-EXPIRED-EXACT", reasons: [expect.objectContaining({ code: "RULE_EXPIRED" })] })]);
});
test("an unreleased rule beside two tied rules is kept on the AMBIGUOUS component", ...);
test("report.sources includes every source cited by gaps", () => { /* N090TL 2026-11-12 with one SEAT:3A cushion record: sources ⊇ FX-DOC-B, FX-DOC-OLD, FX-DOC-DRAFT */ });
test("new reports use schema /2 and carry excludedRules", ...);
test("a snapshot without excluded fields still builds a report", () => { /* strip excluded from every component of a snapshot, buildReport does not throw, excludedRules is [] */ });
```

  `exactCushionRuleFor` and `component` are small local helpers; build the rule by cloning the existing V01 cushion rule and narrowing its selector to `ids: ["SEAT:3A"]`. Use the reason code the code base already emits for an expired rule (`resolve.ts` `ruleExclusions`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** domain first, then PDF and the three web files. Carry `sourceId` on the excluded entry when it is created so `resolve.ts` no longer searches `release.rules` per excluded rule.
- [ ] **Step 4: Run** `npm run check`. Update the E2E expectation only if a check compares the literal string `cabin-kit.report/1`; `grep -rn "report/1" tests src` first.
- [ ] **Step 5: Commit** `feat(domain): keep excluded rules on every component, complete report sources, report schema 2 (DOM-01, DOM-16)`.

---

### Task 2.4: Unreleased data must not change an outcome

Closes DOM-03, DOM-22. Decision D2.

**Files:**
- Modify: `src/domain/specificity.ts` (`buildIndex`, `buildMatchSet`), `src/domain/resolve.ts`, `src/domain/visitLogic.ts` (`buildSnapshot`), `docs/logical-model.md`
- Test: `tests/unit/specificity.test.ts` (new)

**Interfaces:**
- `export function isUsablePair(variant: MaintenanceVariant, revision: LayoutRevision): boolean` in `specificity.ts`: true only when the variant is released, the revision is not planned and not candidate, and the variant lists the revision. `lookup` uses the same function where it classifies an assignment as planned (`resolve.ts:117-122`), so the two cannot drift.
- Feasible pairs in `buildMatchSet` are filtered by `isUsablePair`.
- `buildIndex(release)` caches its result only when `Object.isFrozen(release)`; otherwise it builds a fresh index on every call. Releases loaded from the store are frozen by Task 1.7.
- `buildSnapshot(release, result, capturedAt)` throws `DomainError("RELEASE_MISMATCH", "The lookup result does not belong to this reference release.", 500)` when `result.referenceReleaseId !== release.id`.
- `lookup` validates tail and date before it calls `buildIndex`.

- [ ] **Step 1: Write the failing tests.**

```ts
test("an unreleased variant does not change dominance between released rules", () => {
  const c = withTwoCushionRules(base);           // HW {hardware:[Recaro], subtype:[FX-MAX8]} and VAR {variant:[V01]}, all seats
  expect(component(lookup(c, "N100TL", "2026-11-12"), "SEAT:3A", "CUSHION").status).toBe("AMBIGUOUS");
  c.variants.push({ ...c.variants.find((v) => v.id === "V01")!, id: "V99-DRAFT", released: false });
  expect(component(lookup(c, "N100TL", "2026-11-12"), "SEAT:3A", "CUSHION").status).toBe("AMBIGUOUS");
});
test("mutating an unfrozen release after a lookup is seen by the next lookup", () => { /* lookup, c.rules.length = 0, lookup again → every component NO_MATCH */ });
test("buildSnapshot refuses a result from another release", ...);
test("a rule constrained to every vocabulary carpet is strictly more specific than an unconstrained one", ...);
test("a rule broader in one dimension and narrower in another is incomparable", ...);
test("two tied rules selecting the same part are still AMBIGUOUS", ...);
test("constraint.layoutRevision narrows to that revision when a variant lists two", ...);
```

- [ ] **Step 2: Run.** Expected: the first two FAIL.
- [ ] **Step 3: Implement.** Reword the "Variant, subtype and hardware are dependent…" bullet in `docs/logical-model.md` to say pairs come from released variants and usable revisions.
- [ ] **Step 4: Run** `npm run check`. If a fixture lookup changes state, a fixture rule depended on an unreleased variant; report it in the commit body.
- [ ] **Step 5: Commit** `fix(domain): build specificity from released data only, drop stale index cache (DOM-03, DOM-22)`.

---

### Task 2.5: Source validity for variants, layouts and kit children

Closes DOM-04. Decision D3.

**Files:**
- Modify: `src/domain/resolve.ts`, `src/domain/validate.ts`, `src/domain/types.ts` (reason codes), `docs/logical-model.md`
- Test: `tests/unit/resolve.test.ts`

**Interfaces:**
- `lookup`: after the configuration is selected, apply the existing source check (the function used for the assignment source) to `variant.sourceId` and `layoutRevision.sourceId`. Failure → state `SOURCE_INVALID`, reason codes `VARIANT_SOURCE_INVALID` and `LAYOUT_SOURCE_INVALID`, message naming the source id and the specific problem (missing, unreleased, not yet effective, expired).
- Kit children: when the primary part of an otherwise eligible rule has any child, at any depth, whose source fails the check, the rule is excluded with reason code `KIT_SOURCE_INVALID` naming the child part and source. The same for a substitute's alternate part: it moves to `excludedSubstitutes` with that reason.
- Validation adds warning `KIT_SOURCE_UNRELEASED` for a kit child whose source is unreleased.

- [ ] **Step 1: Write the failing tests.**

```ts
const dead = { ...someFixtureSource, id: "X-DEAD", released: false, expiresOn: "2020-01-01" };
test("a variant citing a dead source is SOURCE_INVALID", () => { /* push dead, point V01.sourceId at it → state SOURCE_INVALID, reasonCode VARIANT_SOURCE_INVALID */ });
test("a layout revision citing a dead source is SOURCE_INVALID", ...);
test("an alternate whose kit child cites a dead source is excluded with the reason", () => {
  /* re-point children of FAKE-CK-2000 at dead; lookup N100TL 2026-11-12; the frozen rule for the carpet kit has no eligible substitute and excludedSubstitutes[0].reasons[0].code === "KIT_SOURCE_INVALID" */ });
test("deriveRecord refuses that alternate", ...);
test("a source effective exactly on the check date is valid; the day before it is not", ...);
```

- [ ] **Step 2: Run, implement, run** `npm run check`. If an existing lookup test changes state, read the fixture source dates for that variant or layout: correct the fixture only when the dates are plainly an oversight, and list each change in the commit body.
- [ ] **Step 3: Commit** `fix(domain): enforce source validity on variants, layouts and kit children (DOM-04)`.

---

### Task 2.6: Kit expansion that is linear, bounded and never throws from lookup

Closes DOM-06, DOM-08, the derived half of DOM-05.

**Files:**
- Modify: `src/domain/kits.ts`, `src/domain/resolve.ts`, `src/domain/visitLogic.ts` (`deriveRecord`), `src/domain/validate.ts`
- Test: `tests/unit/kits.test.ts` (new)

**Interfaces:**
- `export interface KitIndex { expand(partNo: string, multiplier: number): ExpandedChild[] }`
- `export function buildKitIndex(kitChildren: KitChild[], parts: Map<string, Part>): KitIndex` — computes each part's fully expanded children once (depth-first with an explicit stack and an in-progress set for cycle detection), stores them at multiplier 1, and scales on `expand`. Throws `KitError` for a cycle, for depth greater than `MAX_KIT_DEPTH`, and for any quantity that is not a safe integer or exceeds `MAX_DERIVED_QTY`.
- `expandKit` keeps its exported signature and delegates to a `KitIndex`. `ReleaseIndex` holds one `KitIndex`.
- `validateKits` adds error `KIT_TOO_DEEP` and error `KIT_QTY_OVERFLOW` (expanded quantity above `MAX_DERIVED_QTY`), and warning `KIT_UNIT_UNDER_NON_COUNT` when a kit line with children has a unit other than the count unit(s) of the vocabulary.
- `resolveComponents` catches `KitError` while freezing a rule: the rule is excluded with reason code `KIT_INVALID` and the error message. `lookup` therefore returns `PARTIAL` or `RESOLVED`, never throws.
- `deriveRecord`: any computed line quantity that is not a safe integer or exceeds `MAX_DERIVED_QTY` → `DomainError("QUANTITY_TOO_LARGE", …, 422)`.
- Output order of expanded children: `compareCodePoints` on part number, then unit, then source id.

- [ ] **Step 1: Write the failing tests.**

```ts
test("diamond sums both paths", () => { /* K→A×2, A→B×3, K→B×1 ⇒ B = 7 */ });
test("a chain of diamonds at the depth limit expands 1,000 times in under 50 ms", () => { /* K_i → {A_i, B_i} → K_{i+1}, qty 1, deepest chain MAX_KIT_DEPTH allows */ });
test("one level past MAX_KIT_DEPTH is KIT_TOO_DEEP in validation and KitError in buildKitIndex", ...);
test("lookup never throws on a kit cycle", () => {
  const c = structuredClone(base); c.kitChildren.push(childLine("FAKE-P-39", "FAKE-CK-2000"));
  expect(() => lookup(c, "N100TL", "2026-11-12")).not.toThrow();
  /* the alternate FAKE-CK-2000 is excluded with KIT_INVALID */ });
test("primary part that is itself a kit yields MANDATORY_CHILD lines scaled by replacements × qtyPerReplacement", ...);
test("alternate qtyPerReplacement 2 multiplies children", () => { /* replacements 3 × alt 2 × child 4 = 24 */ });
test("same child in two units stays on two lines in a fixed order", ...);
test("a derived quantity above MAX_DERIVED_QTY is refused, never serialised as null", ...);
```

- [ ] **Step 2: Run, implement, run** `npm run check`.
- [ ] **Step 3: Commit** `fix(domain): memoised bounded kit expansion; lookup never throws on kit data (DOM-05, DOM-06, DOM-08)`.

---

### Task 2.7: Rows, geometry, ordering and the small fixes

Closes DOM-17 (runtime half), DOM-18, DOM-19 (runtime half), DOM-20, DOM-21.

**Files:**
- Modify: `src/domain/specificity.ts`, `src/domain/summarize.ts`, `src/domain/geometry.ts`, `src/domain/report.ts`, `src/domain/prep.ts`, `src/domain/resolve.ts`
- Test: `tests/unit/geometry.test.ts`, `tests/unit/summarize.test.ts`, `tests/unit/report.test.ts`, `tests/unit/dates.test.ts` (all new or extended)

**Interfaces:**
- `export function parsePrintedRow(label: string): number | null` in `specificity.ts`: `/^\d{1,3}$/` → number, anything else → `null`. Used by `locationMatches` and `summarizeLocations`. A location whose row is `null` never matches a row range. `rowFrom`/`rowTo` of `null` or `undefined` mean "no bound".
- `geometry.ts`: `lateralCentre`, `sideOf`, `seatPlacement` throw `RangeError("Unknown seat letter: <letter>")` for a letter outside the table. Callers that build placements at import time already hold validated letters; `validateRelease` gains error `SEAT_LETTER_UNKNOWN` and error `SEAT_SIDE_MISMATCH` (seat `side` ≠ `sideOf(letter)`).
- `report.ts`: unknown location kind or a record whose location is absent from the snapshot → `DomainError("SNAPSHOT_INCONSISTENT", …, 500)`. Gap `locationIds` are ordered by the snapshot's physical location order. Work items: seats by physical row then letter, then floor, then bins.
- `prep.ts`: `counts.parts` is the number of distinct part numbers. A substitute is attached to a frozen rule only if its covered locations intersect that rule's locations.
- `resolve.ts`: `assignmentsConsidered[]` entries gain `effectiveStatus: "released" | "planned"` and `reason: string | null`. An assignment whose variant or layout revision is missing → `SOURCE_INVALID` / `INCONSISTENT_CONFIGURATION`. A non-string, non-empty date → `INVALID_INPUT` / `DATE_INVALID`.

- [ ] **Step 1: Write the failing tests.** Key assertions:

```ts
// geometry
test("every seat of every fixture layout lies inside the cabin and A/B/C are port side", ...);  // 0 ≤ x ≤ cabinLength, |z| ≤ CABIN_HALF_WIDTH, z > 0 for A,B,C
test("no two seats of a layout share a placement", ...);
test.each(["G", "a", "", "AA"])("unknown letter %j throws RangeError", ...);
// rows
test.each([["12", 12], ["", null], ["12A", null], ["007", 7], ["1000", null]])("parsePrintedRow(%j) = %j", ...);
test("rowFrom 5 with no rowTo matches rows 5 and up", ...);
test("row range across a skipped printed row", ...);
// report
test("work items are ordered by physical position regardless of insertion order", ...);
test("buildReport is deterministic under shuffled record order", ...);
test("gap locations list SEAT:2A before SEAT:10A", ...);
test("the same part as primary at one location and mandatory child at another merges into one total with both roles", ...);
test("counts.replacements sums quantities, not records", ...);
// dates
test.each([["1900-02-29", false], ["2100-02-29", false], ["2000-02-29", true], ["2028-02-29", true], ["2026-1-5", false], ["2026-11-12\n", false]])("isIsoDate(%j) = %j", ...);
test("intervalsOverlap: equal endpoints overlap, adjacent days do not, null is open", ...);
// lookup
test.each([20261112, new Date(), ["2026-11-12"]])("non-string date %j → INVALID_INPUT DATE_INVALID", ...);
test("three overlapping released assignments → OVERLAP naming all three", ...);
```

- [ ] **Step 2: Run, implement, run** `npm run check`.
- [ ] **Step 3: Commit** `fix(domain): strict rows and seat letters, positional report order, honest counts (DOM-17 – DOM-21)`.

---

### Task 2.8: Indexing cost, property checks, documentation

Closes the performance notes in the domain review. Ends the phase.

**Files:**
- Modify: `src/domain/specificity.ts`, `src/domain/validate.ts`, `src/domain/resolve.ts`, `src/domain/prep.ts`, `src/domain/summarize.ts`, `docs/logical-model.md`, `vitest.config.ts`
- Test: `tests/unit/scale.test.ts`, `tests/unit/properties.test.ts`

**Interfaces:**
- `ReleaseIndex` gains `locationsByComponent: Map<string /* revisionId */, Map<string /* componentId */, CabinLocation[]>>` and `substitutesByKey: Map<string /* componentId|primaryPartNo */, SubstituteApproval[]>`. Selector arrays are turned into `Set`s once per rule. `validateRelease` and `lookup` share one index (pass it in; do not rebuild).
- Replace every `map.set(k, [...(map.get(k) ?? []), x])` with get-or-create then `push` (sites listed in the audit: `validate.ts:166, 216, 223`, `kits.ts:77`, `prep.ts:64`, `summarize.ts:35`).

- [ ] **Step 1: Measure first.** Write `tests/unit/scale.test.ts` with a generator `syntheticRelease({ rows: 60, variants: 12, rules: 400 })` built from the fixture's shapes. Record cold `validateRelease` and cold `lookup` times on the unchanged code in the commit body.
- [ ] **Step 2: Write the bound tests:** `validateRelease(synthetic)` under 1,500 ms and cold `lookup` under 400 ms on CI hardware; tighten each to twice the time measured after the change, rounded up to the next 50 ms.
- [ ] **Step 3: Write the property tests** (plain loops over a seeded PRNG, no new dependency; 200 iterations each):
  - *Unreleased data is inert:* adding a copy of any existing rule with a new id and `released: false` leaves every component's `status` and `ruleId` unchanged, and the new id appears in that component's `excluded` list wherever the original rule was a candidate.
  - *Determinism:* shuffling the order of `rules`, `substitutes`, `kitChildren` and `locations` in a release yields a deep-equal `lookup` result after sorting components by `(locationId, componentId)`.
  - *Totals:* for random valid records on the `N100TL` snapshot, every report total equals the sum of its `locations[].quantity`, and the sum over totals equals the sum over record lines.
- [ ] **Step 4: Implement** the index changes. Run `npm run check`.
- [ ] **Step 5: Update `docs/logical-model.md`:** new finding codes (Tasks 2.1, 2.2, 2.5, 2.6), released-only pairs, the exclusion rule, report schema 2, numeric limits.
- [ ] **Step 6: Raise coverage thresholds** for `src/domain` to at least 90 lines / 85 branches; add tests for whatever is uncovered rather than lowering the bar. **Commit** `perf(domain): shared index, linear grouping; property and scale tests`.
