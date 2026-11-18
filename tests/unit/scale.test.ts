import { describe, expect, it } from "vitest";
import { buildKitIndex } from "../../src/domain/kits.ts";
import { MAX_KIT_DEPTH } from "../../src/domain/limits.ts";
import { buildPreparation } from "../../src/domain/prep.ts";
import { lookup } from "../../src/domain/resolve.ts";
import { buildIndex } from "../../src/domain/specificity.ts";
import type { ApplicabilityRule, CabinLocation, KitChild, LayoutRevision, MaintenanceVariant, Part, ReleaseContent } from "../../src/domain/types.ts";
import { validateRelease } from "../../src/domain/validate.ts";
import { asRelease, fixtureContent, snapshotFor } from "../helpers.ts";

const LETTERS = ["A", "B", "C", "D", "E", "F"] as const;
const SYNTHETIC_REVISION = "SYN-L@1";
const BAND = 6;

/**
 * A fictional release built from the fixture's shapes: one released layout revision with `rows` rows
 * of six seats, `variants` released variants that all list it, one tail per variant, and `rules`
 * released seat rules spread over the variants and both seat components. Each (variant, component)
 * group gets, in turn, a catch-all rule, one rule per letter, then letter-and-row-band rules, so
 * almost every seat resolves through a chain of strictly more specific rules. Every base rule's part
 * is a two-line kit and has one approved alternate.
 */
function syntheticRelease({ rows, variants, rules }: { rows: number; variants: number; rules: number }): ReleaseContent {
  return fixtureContent((c) => {
    const template = c.layoutRevisions.find((r) => r.id === "FX-L-S176-MAX8-LP@1");
    const seatTemplate = template?.locations.find((l) => l.id === "SEAT:1A");
    if (!template || !seatTemplate?.seat) throw new Error("fixture lacks the template layout");
    const subtypeId = template.subtypeId;
    const locations: CabinLocation[] = [];
    for (let row = 1; row <= rows; row += 1) {
      LETTERS.forEach((letter, i) => {
        const seat = structuredClone(seatTemplate);
        seat.id = `SEAT:${row}${letter}`;
        seat.label = `Seat ${row}${letter}`;
        seat.componentIds = ["CUSHION", "BACKREST"];
        seat.seat = {
          ...structuredClone(seatTemplate.seat!),
          printedRow: String(row),
          letter,
          code: `${row}${letter}`,
          side: i < 3 ? "L" : "R",
          physicalRow: row,
          positionType: i === 0 || i === 5 ? "WINDOW" : i === 1 || i === 4 ? "MIDDLE" : "AISLE",
          maintenanceZone: null,
        };
        locations.push(seat);
      });
    }
    const revision: LayoutRevision = {
      ...structuredClone(template),
      id: SYNTHETIC_REVISION,
      layoutId: "SYN-L",
      name: "Synthetic layout",
      declaredSeatCount: rows * LETTERS.length,
      rows: Array.from({ length: rows }, (_, i) => ({ printedLabel: String(i + 1), exists: true, physicalOrder: i + 1 })),
      locations,
    };
    c.layouts.push({ id: "SYN-L", namespace: "fixture", subtypeId, name: "Synthetic layout" });
    c.layoutRevisions.push(revision);
    const variantTemplate = c.variants.find((v) => v.id === "V01")!;
    const synVariants: MaintenanceVariant[] = Array.from({ length: variants }, (_, i) => ({
      ...structuredClone(variantTemplate),
      id: `SYN-V${i}`,
      name: `Synthetic variant ${i}`,
      subtypeId,
      layoutRevisionIds: [SYNTHETIC_REVISION],
    }));
    c.variants.push(...synVariants);
    synVariants.forEach((v, i) => {
      const tail = `NSYN${i}`;
      c.aircraft.push({ tail, namespace: "fixture", subtypeId, note: "Synthetic scale tail" });
      c.assignments.push({
        id: `SYN-TA-${i}`,
        namespace: "fixture",
        tail,
        variantId: v.id,
        layoutRevisionId: SYNTHETIC_REVISION,
        status: "released",
        carpet: null,
        seam: null,
        upholstery: null,
        effectiveFrom: "2025-01-01",
        effectiveTo: null,
        sourceId: "FX-DOC-CONFIG",
      });
    });
    const groups = synVariants.flatMap((v) => (["CUSHION", "BACKREST"] as const).map((componentId) => ({ variantId: v.id, componentId })));
    const addPart = (partNo: string) => c.parts.push({ partNo, namespace: "fixture", description: `Synthetic ${partNo}` });
    for (let i = 0; i < rules; i += 1) {
      const group = groups[i % groups.length]!;
      const template = Math.floor(i / groups.length);
      const letter = LETTERS[(template - 1) % LETTERS.length]!;
      const band = template - 1 - LETTERS.length;
      const selector: ApplicabilityRule["locations"] =
        template === 0
          ? { kind: "SEAT" }
          : template <= LETTERS.length
            ? { kind: "SEAT", letters: [letter] }
            : {
                kind: "SEAT",
                letters: [LETTERS[band % LETTERS.length]!],
                rowFrom: ((band * BAND) % rows) + 1,
                rowTo: Math.min(rows, ((band * BAND) % rows) + BAND),
              };
      const partNo = `SYN-P-${i}`;
      addPart(partNo);
      c.rules.push({
        id: `SYN-R-${i}`,
        namespace: "fixture",
        componentId: group.componentId,
        partNo,
        qtyPerReplacement: 1,
        unit: "EA",
        constraint: { variant: [group.variantId] },
        locations: selector,
        released: true,
        effectiveFrom: "2024-01-01",
        effectiveTo: null,
        sourceId: "FX-DOC-A",
      });
      if (template === 0) {
        const kit: KitChild[] = [1, 2].map((n) => ({ parentPartNo: partNo, childPartNo: `${partNo}-K${n}`, qty: n, unit: "EA", sourceId: "FX-DOC-A" }));
        for (const k of kit) addPart(k.childPartNo);
        c.kitChildren.push(...kit);
        addPart(`${partNo}-ALT`);
        c.substitutes.push({
          id: `SYN-SUB-${i}`,
          namespace: "fixture",
          componentId: group.componentId,
          primaryPartNo: partNo,
          altPartNo: `${partNo}-ALT`,
          qtyPerReplacement: 1,
          unit: "EA",
          constraint: { variant: [group.variantId] },
          released: true,
          effectiveFrom: "2024-01-01",
          effectiveTo: null,
          sourceId: "FX-DOC-A",
        });
      }
    }
  });
}

const SHAPE = { rows: 60, variants: 12, rules: 400 };
/**
 * CI-hardware ceilings from the brief, deliberately loose: to be tightened later from CI logs. On the
 * development machine (Task 2.8) these take about 40 ms and 16 ms alone, and up to 138 ms and 36 ms
 * under `npm run coverage` with the whole suite running. At this scale no absolute bound separates
 * linear from quadratic work; the ratio test below does that.
 */
const VALIDATE_BOUND_MS = 1500;
const LOOKUP_BOUND_MS = 400;
/** Well under the brief's 400 ms lookup bound; measured at about 1 ms. */
const KIT_DAG_BOUND_MS = 100;
/** Each timing is the best of this many cold runs, so one scheduler stall cannot fail it. */
const RUNS = 5;

/** Milliseconds `fn` takes: the best of `runs` cold runs, each on fresh (unindexed) content. */
function bestOf(runs: number, fresh: () => ReleaseContent, fn: (content: ReleaseContent) => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i += 1) {
    const content = fresh();
    const start = performance.now();
    fn(content);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe("scale (synthetic release: 60 rows, 12 variants, 400 rules)", () => {
  const base = syntheticRelease(SHAPE);

  it("the synthetic release is valid and resolves every seat on its tails", () => {
    expect(validateRelease(base).filter((f) => f.severity === "error")).toEqual([]);
    const result = lookup(asRelease(base), "NSYN0", "2026-11-12");
    expect(result.state).toBe("RESOLVED");
    expect(result.resolution?.counts.resolved).toBe(SHAPE.rows * LETTERS.length * 2);
  });

  it("cold validateRelease stays under its bound", () => {
    const ms = bestOf(
      RUNS,
      () => structuredClone(base),
      (content) => validateRelease(content),
    );
    expect(ms).toBeLessThan(VALIDATE_BOUND_MS);
  });

  it("cold lookup (index built afresh) stays under its bound", () => {
    const ms = bestOf(
      RUNS,
      () => structuredClone(base),
      (content) => lookup(asRelease(content), "NSYN5", "2026-11-12"),
    );
    expect(ms).toBeLessThan(LOOKUP_BOUND_MS);
  });

  it("validateRelease and lookup can share one index", () => {
    const content = structuredClone(base);
    const index = buildIndex(content);
    expect(validateRelease(content, index).filter((f) => f.severity === "error")).toEqual([]);
    // the release spreads the content, so it shares every entity array and the index fits it
    const release = asRelease(content);
    expect(lookup(release, "NSYN3", "2026-11-12", index)).toEqual(lookup(release, "NSYN3", "2026-11-12"));
    // an index of other content is refused, never silently used
    expect(() => validateRelease(structuredClone(base), index)).toThrow(/different release/);
    expect(() => validateRelease(42, index)).toThrow(/different release/);
    expect(() => lookup(asRelease(structuredClone(base)), "NSYN3", "2026-11-12", index)).toThrow(/different release/);
  });
});

describe("grouping is linear", () => {
  /**
   * Best-of-`runs` milliseconds for `repeat` calls of each of `a` and `b`, measured alternately so a
   * burst of load from other test workers hits both sides alike.
   */
  const timedPair = (a: () => void, b: () => void, repeat: number, runs: number): [number, number] => {
    const best: [number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    for (let i = 0; i < runs; i += 1) {
      [a, b].forEach((fn, side) => {
        const start = performance.now();
        for (let j = 0; j < repeat; j += 1) fn();
        best[side] = Math.min(best[side] ?? Number.POSITIVE_INFINITY, performance.now() - start);
      });
    }
    return best;
  };

  it("doubling the seats at most doubles (well under quadruples) the preparation overview's cost", () => {
    // One catch-all rule per variant and component, so each preparation line groups every seat of the
    // cabin (6 x rows locations). Appending by copying the list (`[...(map.get(k) ?? []), x]`) makes
    // that quadratic (4x per doubling, more with the garbage it makes); get-or-create then push keeps it
    // near 2. Rows past 999 are fine here: catch-all rules use no row range.
    const ROWS = 1200;
    const shape = (rows: number) => ({ rows, variants: 12, rules: 24 });
    const prepare = (rows: number) => {
      const snap = snapshotFor(asRelease(syntheticRelease(shape(rows))), "NSYN0", "2026-11-12");
      expect(snap.resolution.counts.resolved).toBe(rows * LETTERS.length * 2);
      return () => buildPreparation(snap);
    };
    const small = prepare(ROWS);
    const large = prepare(2 * ROWS);
    small(); // warm up both paths before timing
    large();
    const [smallMs, largeMs] = timedPair(small, large, 2, 9);
    const ratio = largeMs / smallMs;
    // linear measures about 1.8-2.2 (once 2.8 under the full coverage run); with a spread-append in
    // prep's coverage grouping it measures about 6, so 3.5 separates them with room on both sides
    expect(ratio).toBeLessThan(3.5);
  }, 20_000); // passes in about 1 s; the allowance lets a quadratic regression fail on the ratio, not on time
});

describe("kit expansion on valid data is linear", () => {
  it("a layered, fully connected kit DAG at the depth limit (8 levels x 4 parts, 65,536 paths) expands quickly", () => {
    const WIDTH = 4;
    const lines: KitChild[] = [];
    const name = (level: number, i: number) => `L${level}-${i}`;
    for (let i = 0; i < WIDTH; i += 1) lines.push({ parentPartNo: "ROOT", childPartNo: name(1, i), qty: 1, unit: "EA", sourceId: "S" });
    for (let level = 1; level < MAX_KIT_DEPTH; level += 1) {
      for (let i = 0; i < WIDTH; i += 1) {
        for (let j = 0; j < WIDTH; j += 1) lines.push({ parentPartNo: name(level, i), childPartNo: name(level + 1, j), qty: 1, unit: "EA", sourceId: "S" });
      }
    }
    const parts = new Map<string, Part>(
      [...new Set(lines.flatMap((l) => [l.parentPartNo, l.childPartNo]))].map((p) => [p, { partNo: p, namespace: "fixture", description: p }]),
    );
    const start = performance.now();
    const children = buildKitIndex(lines, parts).expand("ROOT", 1);
    const ms = performance.now() - start;
    // every part below the root appears once; the deepest level is reached by WIDTH^(depth-1) = 4^7 paths
    expect(children).toHaveLength(WIDTH * MAX_KIT_DEPTH);
    expect(children.find((c) => c.partNo === name(MAX_KIT_DEPTH, 0))?.qty).toBe(WIDTH ** (MAX_KIT_DEPTH - 1));
    expect(ms).toBeLessThan(KIT_DAG_BOUND_MS);
  });
});
