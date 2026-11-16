import { describe, expect, test } from "vitest";
import { MAX_QTY } from "../../src/domain/limits.ts";
import { structuralFindings } from "../../src/domain/schema.ts";
import type { ReleaseContent } from "../../src/domain/types.ts";
import { hasBlockingFindings, validateRelease } from "../../src/domain/validate.ts";
import { at, fixtureContent, stagedFull } from "../helpers.ts";

/** A record view of a typed object, so a test can delete or misname a required key. */
const loose = (value: object): Record<string, unknown> => value as Record<string, unknown>;

const base = fixtureContent();

describe("structural schema in front of validateRelease", () => {
  const cases: [string, (c: ReleaseContent) => void, string][] = [
    ["rule without locations", (c) => delete loose(at(c.rules, 0)).locations, "rules.0.locations"],
    ["rule without constraint", (c) => delete loose(at(c.rules, 0)).constraint, "rules.0.constraint"],
    [
      "selector key typo zone",
      (c) => {
        const l = loose(at(c.rules, 0).locations);
        l.zone = l.zones ?? ["EXIT"];
        delete l.zones;
      },
      "rules.0.locations",
    ],
    ["constraint key typo variants", (c) => (loose(at(c.rules, 0).constraint).variants = ["V01"]), "rules.0.constraint"],
    ["layout revision without geometry", (c) => delete loose(at(c.layoutRevisions, 0)).geometry, "layoutRevisions.0.geometry"],
    ["assignment status Released", (c) => (loose(at(c.assignments, 0)).status = "Released"), "assignments.0.status"],
    ["tail not normalised", (c) => (at(c.aircraft, 0).tail = "n100tl"), "aircraft.0.tail"],
    ["tail too long", (c) => (at(c.aircraft, 0).tail = "N100TL-LONGTAIL"), "aircraft.0.tail"],
    [
      "duplicate component id on a location",
      (c) => {
        const l = at(at(c.layoutRevisions, 0).locations, 0);
        l.componentIds.push(at(l.componentIds, 0));
      },
      "componentIds",
    ],
    ["quantity 1e300", (c) => (at(c.rules, 0).qtyPerReplacement = 1e300), "rules.0.qtyPerReplacement"],
    ["quantity 2^53", (c) => (at(c.kitChildren, 0).qty = 2 ** 53), "kitChildren.0.qty"],
    ["quantity 0", (c) => (at(c.substitutes, 0).qtyPerReplacement = 0), "substitutes.0.qtyPerReplacement"],
    ["quantity above MAX_QTY", (c) => (at(c.rules, 0).qtyPerReplacement = MAX_QTY + 1), "rules.0.qtyPerReplacement"],
    ["impossible date", (c) => (at(c.rules, 0).effectiveFrom = "2026-02-30"), "rules.0.effectiveFrom"],
    ["replacement limit above bound", (c) => (at(c.components, 0).maxReplacementsPerLocation = 1_001), "components.0.maxReplacementsPerLocation"],
    ["unknown top-level key", (c) => (loose(c).extra = true), "extra"],
  ];
  test.each(cases)("%s", (_name, mutate, path) => {
    const c = structuredClone(base);
    mutate(c);
    const f = validateRelease(c);
    expect(f.some((x) => x.code === "SCHEMA_INVALID" && x.message.includes(path))).toBe(true);
    expect(hasBlockingFindings(f)).toBe(true);
    // semantic checks assume sound structure, so only schema findings come back
    expect(f.every((x) => x.code === "SCHEMA_INVALID")).toBe(true);
  });

  test("the fixture release and the full staged release have no SCHEMA_INVALID", () => {
    expect(structuralFindings(fixtureContent())).toEqual([]);
    expect(structuralFindings(stagedFull().content)).toEqual([]);
    expect(validateRelease(fixtureContent()).filter((f) => f.code === "SCHEMA_INVALID")).toEqual([]);
    expect(stagedFull().findings.filter((f) => f.code === "SCHEMA_INVALID")).toEqual([]);
  });

  test("validateRelease never throws on garbage", () => {
    for (const g of [null, 1, "x", [], {}, { rules: 5 }]) {
      expect(() => validateRelease(g as unknown as ReleaseContent)).not.toThrow();
      expect(hasBlockingFindings(validateRelease(g as unknown as ReleaseContent))).toBe(true);
    }
  });

  test("a finding names the nearest entity id on its path", () => {
    const c = structuredClone(base);
    loose(at(c.assignments, 0)).status = "Released";
    const [first] = structuralFindings(c);
    expect(first).toMatchObject({ severity: "error", code: "SCHEMA_INVALID", refs: [at(base.assignments, 0).id] });
    const d = structuredClone(base);
    at(d.aircraft, 0).tail = "n100tl";
    expect(structuralFindings(d)[0]?.refs).toEqual(["n100tl"]);
  });

  test("at most 50 findings, then one summarising how many more", () => {
    const c = structuredClone(base);
    const count = c.rules.length;
    expect(count).toBeGreaterThan(0);
    // 60 broken rules, one issue each
    const rule = at(c.rules, 0);
    c.rules = Array.from({ length: 60 }, (_, i) => ({ ...structuredClone(rule), id: `X-${i}`, qtyPerReplacement: 0 }));
    const f = structuralFindings(c);
    expect(f).toHaveLength(51);
    expect(f.every((x) => x.code === "SCHEMA_INVALID" && x.severity === "error")).toBe(true);
    expect(at(f, 50).message).toMatch(/10 more/);
  });
});
