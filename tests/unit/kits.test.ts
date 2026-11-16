import { describe, expect, it } from "vitest";
import { buildKitIndex, KitError, validateKits } from "../../src/domain/kits.ts";
import { MAX_DERIVED_QTY, MAX_KIT_DEPTH, MAX_QTY } from "../../src/domain/limits.ts";
import { kitSourceExclusions, lookup } from "../../src/domain/resolve.ts";
import { buildIndex } from "../../src/domain/specificity.ts";
import type { KitChild, LookupResult, Part, ReleaseContent } from "../../src/domain/types.ts";
import { DomainError, deriveRecord } from "../../src/domain/visitLogic.ts";
import { entry, fixtureContent, fixtureRelease, KIT_ALTERNATE, KIT_PRIMARY, resolutionAt, snapshotFor } from "../helpers.ts";

const line = (parentPartNo: string, childPartNo: string, qty = 1, unit = "EA", sourceId = "S"): KitChild => ({
  parentPartNo,
  childPartNo,
  qty,
  unit,
  sourceId,
});
const partsOf = (lines: KitChild[]): Map<string, Part> =>
  new Map(lines.flatMap((l) => [l.parentPartNo, l.childPartNo]).map((p) => [p, { partNo: p, namespace: "fixture", description: `desc ${p}` }]));
const index = (lines: KitChild[]) => buildKitIndex(lines, partsOf(lines));
const kitErrorOf = (fn: () => unknown): KitError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof KitError) return e;
    throw e;
  }
  throw new Error("expected a KitError");
};
/** C0 -> C1 -> ... -> C<edges>, one item each. */
const chain = (edges: number, prefix = "C") => Array.from({ length: edges }, (_, i) => line(`${prefix}${i}`, `${prefix}${i + 1}`));
/** K_i -> {A_i, B_i} -> K_{i+1}: each diamond is two levels and doubles the quantity of the next K. */
const diamonds = (count: number) =>
  Array.from({ length: count }, (_, i) => [line(`K${i}`, `A${i}`), line(`K${i}`, `B${i}`), line(`A${i}`, `K${i + 1}`), line(`B${i}`, `K${i + 1}`)]).flat();

/** A fixture with extra fictional parts, so validation sees only the finding under test. */
const withParts = (c: ReleaseContent, partNos: string[]) => {
  for (const partNo of partNos) c.parts.push({ partNo, namespace: "fixture", description: partNo });
};
const codesOf = (content: ReleaseContent, severity: "error" | "warning") =>
  validateKits(content.kitChildren, new Map(content.parts.map((p) => [p.partNo, p])), content.vocabulary.units, new Set(content.sources.map((s) => s.id)))
    .filter((f) => f.severity === severity)
    .map((f) => f.code);

const carpetKit = (r: LookupResult) => entry(r.resolution!.rules, (resolutionAt(r, "FLOOR:FULL-CABIN", "CARPET_KIT") as { ruleId: string }).ruleId);
const carpetRule = (c: ReleaseContent) => c.rules.find((r) => r.componentId === "CARPET_KIT" && r.partNo === "FAKE-CK-2001")!;
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof DomainError ? e.code : `other:${(e as Error).message}`;
  }
  return "no-error";
};

describe("kit expansion", () => {
  it("diamond sums both paths", () => {
    // K -> A x2, A -> B x3, K -> B x1 => B = 2 x 3 + 1 = 7
    const kits = index([line("K", "A", 2), line("A", "B", 3), line("K", "B", 1)]);
    expect(kits.expand("K", 1).map((c) => [c.partNo, c.qty])).toEqual([
      ["A", 2],
      ["B", 7],
    ]);
    expect(kits.expand("K", 3).map((c) => [c.partNo, c.qty])).toEqual([
      ["A", 6],
      ["B", 21],
    ]);
    expect(kits.expand("K", 1)[0]?.description).toBe("desc A");
  });

  it("a chain of diamonds at the depth limit expands 1,000 times in under 50 ms", () => {
    const count = Math.floor(MAX_KIT_DEPTH / 2); // the deepest chain MAX_KIT_DEPTH allows
    const kits = index(diamonds(count)); // one index, as a release holds one
    const deepest: (number | undefined)[] = [];
    const started = performance.now();
    for (let multiplier = 1; multiplier <= 1_000; multiplier += 1) {
      deepest.push(kits.expand("K0", multiplier).find((c) => c.partNo === `K${count}`)?.qty);
    }
    expect(performance.now() - started).toBeLessThan(50);
    expect(deepest[0]).toBe(2 ** count); // both paths of every diamond are summed
    expect(deepest[999]).toBe(1_000 * 2 ** count);
  });

  it("is linear on shared sub-kits: 40 chained diamonds are refused at once, not walked 2^40 times", () => {
    const lines = diamonds(40);
    const started = performance.now();
    expect(kitErrorOf(() => index(lines).expand("K0", 1)).code).toBe("KIT_TOO_DEEP");
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("one level past MAX_KIT_DEPTH is KIT_TOO_DEEP in validation and KitError in buildKitIndex", () => {
    expect(() => index(chain(MAX_KIT_DEPTH)).expand("C0", 1)).not.toThrow();
    const error = kitErrorOf(() => index(chain(MAX_KIT_DEPTH + 1)).expand("C0", 1));
    expect(error.code).toBe("KIT_TOO_DEEP");
    // the sub-kits that fit stay usable
    expect(index(chain(MAX_KIT_DEPTH + 1)).expand("C1", 1)).toHaveLength(MAX_KIT_DEPTH);

    const atLimit = fixtureContent((c) => {
      withParts(
        c,
        chain(MAX_KIT_DEPTH + 1, "FAKE-T-").map((l) => l.parentPartNo),
      );
      c.kitChildren.push(...chain(MAX_KIT_DEPTH, "FAKE-T-").map((l) => ({ ...l, sourceId: "FX-DOC-B" })));
    });
    expect(codesOf(atLimit, "error")).toEqual([]);
    const pastLimit = fixtureContent((c) => {
      withParts(
        c,
        chain(MAX_KIT_DEPTH + 2, "FAKE-T-").map((l) => l.parentPartNo),
      );
      c.kitChildren.push(...chain(MAX_KIT_DEPTH + 1, "FAKE-T-").map((l) => ({ ...l, sourceId: "FX-DOC-B" })));
    });
    expect(codesOf(pastLimit, "error")).toEqual(["KIT_TOO_DEEP"]); // once, not once per kit above it
  });

  it("a cycle is a KitError naming the cycle, and validation reports it once as KIT_CYCLE", () => {
    const lines = [line("X", "K"), line("K", "A"), line("A", "K")];
    const error = kitErrorOf(() => index(lines).expand("X", 1));
    expect(error.code).toBe("KIT_CYCLE");
    expect(error.message).toMatch(/K -> A -> K/);
    const content = fixtureContent((c) => c.kitChildren.push(line("FAKE-P-39", "FAKE-CK-2000", 1, "PANEL", "FX-DOC-B")));
    expect(codesOf(content, "error")).toEqual(["KIT_CYCLE"]);
  });

  it("an expanded quantity above MAX_DERIVED_QTY is KIT_QTY_OVERFLOW in validation and KitError in the index", () => {
    const lines = [line("K", "A", MAX_QTY), line("A", "B", MAX_QTY)];
    expect(kitErrorOf(() => index(lines).expand("K", 1)).code).toBe("KIT_QTY_OVERFLOW");
    expect(index(lines).expand("A", 1)).toEqual([expect.objectContaining({ partNo: "B", qty: MAX_QTY })]);
    expect(kitErrorOf(() => index(lines).expand("A", MAX_DERIVED_QTY)).code).toBe("KIT_QTY_OVERFLOW");
    const content = fixtureContent((c) => {
      c.kitChildren.push(line("FAKE-CK-2001", "FAKE-P-39", MAX_QTY, "PANEL", "FX-DOC-B"), line("FAKE-P-39", "FAKE-P-40", MAX_QTY, "PANEL", "FX-DOC-B"));
    });
    expect(codesOf(content, "error")).toEqual(["KIT_QTY_OVERFLOW"]);
  });

  it("warns when a kit line in a non-count unit multiplies a kit below it", () => {
    const nested = (unit: string) =>
      fixtureContent((c) => {
        c.vocabulary.units.push("M");
        c.kitChildren.push(line("FAKE-P-39", "FAKE-P-40", 1, "PANEL", "FX-DOC-B"));
        c.kitChildren.find((k) => k.parentPartNo === "FAKE-CK-2000" && k.childPartNo === "FAKE-P-39")!.unit = unit;
      });
    expect(codesOf(nested("M"), "warning")).toEqual(["KIT_UNIT_UNDER_NON_COUNT"]);
    expect(codesOf(nested("PANEL"), "warning")).toEqual([]);
    // a non-count unit on a line whose child has no kit is not warned about
    const leaf = fixtureContent((c) => {
      c.vocabulary.units.push("M");
      c.kitChildren.find((k) => k.childPartNo === "FAKE-P-42")!.unit = "M";
    });
    expect(codesOf(leaf, "warning")).toEqual([]);
  });

  it("same child in two units stays on two lines in a fixed order", () => {
    const lines = [line("K", "A", 1, "PANEL", "S"), line("K", "A", 2, "EA", "S"), line("K", "A", 3, "EA", "R"), line("K", "A", 4, "EA", "S")];
    const expected = [
      ["A", "EA", "R", 3],
      ["A", "EA", "S", 6],
      ["A", "PANEL", "S", 1],
    ];
    const shape = (lines: KitChild[]) =>
      index(lines)
        .expand("K", 1)
        .map((c) => [c.partNo, c.unit, c.sourceId, c.qty]);
    expect(shape(lines)).toEqual(expected);
    expect(shape([...lines].reverse())).toEqual(expected);
  });

  it("descendantLines walks each line once and returns on a cycle", () => {
    const lines = [line("K", "A"), line("A", "B"), line("B", "K"), line("K", "B")];
    expect(index(lines).descendantLines("K")).toEqual([line("K", "A"), line("A", "B"), line("B", "K"), line("K", "B")]);
  });
});

describe("lookup on broken kit data", () => {
  it("lookup never throws on a kit cycle", () => {
    const c = fixtureRelease((c) => c.kitChildren.push(line("FAKE-P-39", "FAKE-CK-2000", 1, "PANEL", "FX-DOC-B")));
    expect(() => lookup(c, "N100TL", "2026-11-12")).not.toThrow();
    const r = lookup(c, "N100TL", "2026-11-12");
    expect(r.state).toBe("RESOLVED");
    // the alternate FAKE-CK-2000 is excluded with KIT_INVALID; the primary stays valid (PF-12)
    const kit = carpetKit(r);
    expect(kit.partNo).toBe("FAKE-CK-2001");
    expect(kit.substitutes).toEqual([]);
    expect(kit.excludedSubstitutes).toHaveLength(1);
    expect(kit.excludedSubstitutes[0]?.altPartNo).toBe("FAKE-CK-2000");
    expect(kit.excludedSubstitutes[0]?.reasons.map((x) => x.code)).toEqual(["KIT_INVALID"]);
    expect(kit.excludedSubstitutes[0]?.reasons[0]?.message).toMatch(/Cyclic kit definition/);
  });

  it("a cyclic kit below a rule's primary part excludes the rule with KIT_INVALID", () => {
    const rel = fixtureRelease((c) =>
      c.kitChildren.push(line("FAKE-CK-2001", "FAKE-P-77", 1, "PANEL", "FX-DOC-B"), line("FAKE-P-77", "FAKE-CK-2001", 1, "PANEL", "FX-DOC-B")),
    );
    const r = lookup(rel, "N100TL", "2026-11-12");
    expect(r.state).toBe("PARTIAL");
    const comp = resolutionAt(r, "FLOOR:FULL-CABIN", "CARPET_KIT");
    expect(comp.status).toBe("NO_MATCH");
    const excluded = comp.excluded?.find((x) => x.partNo === "FAKE-CK-2001");
    expect(excluded?.reasons.map((x) => x.code)).toEqual(["KIT_INVALID"]);
  });

  it("a rule that is not yet effective and has a dead kit child lists both reasons", () => {
    const rel = fixtureRelease((c) => {
      c.sources.push({ ...c.sources[0]!, id: "X-DEAD", released: false });
      c.kitChildren.push(line("FAKE-CK-2001", "FAKE-P-39", 1, "PANEL", "X-DEAD"));
      carpetRule(c).effectiveFrom = "2026-11-13";
    });
    const r = lookup(rel, "N100TL", "2026-11-12");
    const excluded = resolutionAt(r, "FLOOR:FULL-CABIN", "CARPET_KIT").excluded?.find((x) => x.partNo === "FAKE-CK-2001");
    expect(excluded?.reasons.map((x) => x.code)).toEqual(["RULE_NOT_YET_EFFECTIVE", "KIT_SOURCE_INVALID"]);
    expect(r.resolution!.sources["X-DEAD"]).toBeDefined();
  });

  it("kitSourceExclusions returns on a cyclic kit with a dead source", () => {
    const rel = fixtureRelease((c) => {
      c.sources.push({ ...c.sources[0]!, id: "X-DEAD", released: false });
      c.kitChildren.push(line("FAKE-P-39", "FAKE-CK-2000", 1, "PANEL", "X-DEAD"));
    });
    const kit = kitSourceExclusions(buildIndex(rel), "FAKE-CK-2000", "2026-11-12");
    expect(kit.sourceIds).toEqual(["X-DEAD"]);
    expect(kit.reasons.map((x) => x.message)).toEqual([expect.stringMatching(/Kit child FAKE-CK-2000 of FAKE-P-39 cites source X-DEAD/)]);
  });
});

describe("derived quantities", () => {
  it("primary part that is itself a kit yields MANDATORY_CHILD lines scaled by replacements × qtyPerReplacement", () => {
    const rel = fixtureRelease((c) => {
      c.components.find((x) => x.id === "CARPET_KIT")!.maxReplacementsPerLocation = 3;
      carpetRule(c).qtyPerReplacement = 2;
      c.kitChildren.push(line("FAKE-CK-2001", "FAKE-P-39", 5, "PANEL", "FX-DOC-B"), line("FAKE-P-39", "FAKE-P-40", 7, "PANEL", "FX-DOC-B"));
    });
    const lines = deriveRecord(snapshotFor(rel, "N100TL", "2026-11-12"), { ...KIT_PRIMARY, quantity: 3 }).lines;
    expect(lines.map((l) => [l.role, l.partNo, l.qty, l.parentPartNo])).toEqual([
      ["PRIMARY", "FAKE-CK-2001", 6, null],
      ["MANDATORY_CHILD", "FAKE-P-39", 3 * 2 * 5, "FAKE-CK-2001"],
      ["MANDATORY_CHILD", "FAKE-P-40", 3 * 2 * 5 * 7, "FAKE-CK-2001"],
    ]);
  });

  it("alternate qtyPerReplacement 2 multiplies children", () => {
    const rel = fixtureRelease((c) => {
      c.components.find((x) => x.id === "CARPET_KIT")!.maxReplacementsPerLocation = 3;
      c.substitutes.find((s) => s.altPartNo === "FAKE-CK-2000")!.qtyPerReplacement = 2;
      c.kitChildren.find((k) => k.parentPartNo === "FAKE-CK-2000" && k.childPartNo === "FAKE-P-39")!.qty = 4;
    });
    const lines = deriveRecord(snapshotFor(rel, "N100TL", "2026-11-12"), { ...KIT_ALTERNATE, quantity: 3 }).lines;
    expect(lines.find((l) => l.role === "ALTERNATE")?.qty).toBe(6);
    expect(lines.find((l) => l.partNo === "FAKE-P-39")?.qty).toBe(24); // replacements 3 x alt 2 x child 4
  });

  it("a derived quantity above MAX_DERIVED_QTY is refused, never serialised as null", () => {
    const rel = fixtureRelease((c) => {
      carpetRule(c).qtyPerReplacement = MAX_QTY;
      c.kitChildren.push(line("FAKE-CK-2001", "FAKE-P-39", MAX_QTY, "PANEL", "FX-DOC-B"));
    });
    const snap = snapshotFor(rel, "N100TL", "2026-11-12");
    expect(carpetKit(lookup(rel, "N100TL", "2026-11-12")).children[0]?.qty).toBe(MAX_QTY); // the kit itself is within bounds
    expect(code(() => deriveRecord(snap, KIT_PRIMARY))).toBe("QUANTITY_TOO_LARGE");
    expect(() => deriveRecord(snap, KIT_PRIMARY)).toThrow(
      `The quantity of FAKE-P-39 (PANEL) for this record is too large or not a whole number; it must be a whole number no greater than ${MAX_DERIVED_QTY}.`,
    );
    // the same refusal holds for a snapshot whose numbers would overflow to Infinity (JSON null)
    const forged = structuredClone(snap);
    for (const rule of Object.values(forged.resolution.rules)) if (rule.partNo === "FAKE-CK-2001") rule.qtyPerReplacement = Number.MAX_VALUE;
    expect(code(() => deriveRecord(forged, KIT_PRIMARY))).toBe("QUANTITY_TOO_LARGE");
  });
});
