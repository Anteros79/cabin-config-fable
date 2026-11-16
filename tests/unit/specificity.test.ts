import { describe, expect, it } from "vitest";
import { deepFreeze } from "../../src/domain/canonical.ts";
import { lookup } from "../../src/domain/resolve.ts";
import { buildIndex, isStrictlyMoreSpecific, isSubset, isUsablePair, type MatchSet } from "../../src/domain/specificity.ts";
import type { LayoutRevision, MaintenanceVariant, ReferenceRelease } from "../../src/domain/types.ts";
import { buildSnapshot, DomainError } from "../../src/domain/visitLogic.ts";
import { asRelease, cushionRule, fixtureContent, resolutionAt, withCushionRules } from "../helpers.ts";

const ALL_SEATS = { kind: "SEAT" as const };
const status3A = (release: ReferenceRelease) => resolutionAt(lookup(release, "N100TL", "2026-11-12"), "SEAT:3A", "CUSHION").status;

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`test expected ${what}`);
  return value;
}
const matchOf = (release: ReferenceRelease, ruleId: string): MatchSet => must(buildIndex(release).ruleMatch.get(ruleId), `a match set for ${ruleId}`);

/** HW {hardware: [Recaro], subtype: [FX-MAX8]} and VAR {variant: [V01]}, all seats: the same released pairs today. */
function withTwoCushionRules(): ReferenceRelease {
  return withCushionRules([
    cushionRule("HW", "P-HW", { hardware: ["Recaro"], subtype: ["FX-MAX8"] }, ALL_SEATS),
    cushionRule("VAR", "P-VAR", { variant: ["V01"] }, ALL_SEATS),
  ]);
}

describe("released data only (D2)", () => {
  it("an unreleased variant does not change dominance between released rules", () => {
    const c = withTwoCushionRules();
    expect(status3A(c)).toBe("AMBIGUOUS");
    const v01 = must(
      c.variants.find((v) => v.id === "V01"),
      "variant V01",
    );
    c.variants.push({ ...v01, id: "V99-DRAFT", released: false });
    expect(status3A(c)).toBe("AMBIGUOUS");
  });

  it("a planned or candidate layout revision does not change dominance either", () => {
    for (const status of ["planned", "candidate"] as const) {
      const c = withTwoCushionRules();
      const v01 = must(
        c.variants.find((v) => v.id === "V01"),
        "variant V01",
      );
      const rev = must(
        c.layoutRevisions.find((r) => r.id === "FX-L-S176-MAX8@1"),
        "revision FX-L-S176-MAX8@1",
      );
      c.layoutRevisions.push({ ...rev, id: "FX-L-S176-MAX8@9", status });
      c.variants.push({ ...v01, id: "V98", layoutRevisionIds: ["FX-L-S176-MAX8@9"] });
      expect(status3A(c)).toBe("AMBIGUOUS");
    }
  });

  it("isUsablePair needs a released variant that lists a revision that is neither planned nor candidate", () => {
    const content = fixtureContent();
    const v01 = must(
      content.variants.find((v) => v.id === "V01"),
      "variant V01",
    );
    const rev = must(
      content.layoutRevisions.find((r) => r.id === "FX-L-S176-MAX8@1"),
      "revision FX-L-S176-MAX8@1",
    );
    const variant = (extra: Partial<MaintenanceVariant>): MaintenanceVariant => ({ ...v01, ...extra });
    const revision = (extra: Partial<LayoutRevision>): LayoutRevision => ({ ...rev, ...extra });
    expect(isUsablePair(v01, rev)).toBe(true);
    expect(isUsablePair(variant({ released: false }), rev)).toBe(false);
    expect(isUsablePair(v01, revision({ status: "planned" }))).toBe(false);
    expect(isUsablePair(v01, revision({ status: "candidate" }))).toBe(false);
    expect(isUsablePair(variant({ layoutRevisionIds: ["FX-L-S170@1"] }), rev)).toBe(false);
  });
});

describe("index cache", () => {
  it("mutating an unfrozen release after a lookup is seen by the next lookup", () => {
    const c = withTwoCushionRules();
    expect(lookup(c, "N100TL", "2026-11-12").state).toBe("PARTIAL");
    c.rules.length = 0;
    const after = lookup(c, "N100TL", "2026-11-12");
    const components = must(after.resolution, "a resolution").components;
    expect(components.length).toBeGreaterThan(0);
    expect(components.every((comp) => comp.status === "NO_MATCH")).toBe(true);
  });

  it("a rule added to an unfrozen release after a lookup takes part in the next lookup", () => {
    const c = withTwoCushionRules();
    expect(status3A(c)).toBe("AMBIGUOUS");
    c.rules.push(cushionRule("EXACT", "P-EXACT", { variant: ["V01"] }, { kind: "SEAT", ids: ["SEAT:3A"] }));
    c.parts.push({ partNo: "P-EXACT", namespace: "fixture", description: "P-EXACT" });
    expect(resolutionAt(lookup(c, "N100TL", "2026-11-12"), "SEAT:3A", "CUSHION")).toMatchObject({ status: "RESOLVED", ruleId: "EXACT" });
  });

  it("an unfrozen release gets a fresh index on every call; a frozen one is indexed once", () => {
    const open = asRelease(fixtureContent());
    expect(buildIndex(open)).not.toBe(buildIndex(open));
    const frozen = deepFreeze(asRelease(fixtureContent()));
    expect(buildIndex(frozen)).toBe(buildIndex(frozen));
  });
});

describe("buildSnapshot", () => {
  it("refuses a result from another release", () => {
    const content = fixtureContent();
    const result = lookup(asRelease(content, "REL-A"), "N100TL", "2026-11-12");
    expect(result.state).toBe("RESOLVED");
    let thrown: unknown;
    try {
      buildSnapshot(asRelease(content, "REL-B"), result, "2026-11-12T12:00:00.000Z");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect(thrown).toMatchObject({
      code: "RELEASE_MISMATCH",
      message: "The lookup result does not belong to this reference release.",
      status: 500,
    });
  });
});

describe("specificity cases", () => {
  it("a rule constrained to every vocabulary carpet is strictly more specific than an unconstrained one", () => {
    // the constrained rule refuses an unknown carpet, so it accepts strictly less
    const rel = withCushionRules([
      cushionRule("ANY", "P-ANY", { variant: ["V01"] }, ALL_SEATS),
      cushionRule("CARPETS", "P-CARPETS", { variant: ["V01"], carpet: ["MOHAWK", "BOTANY"] }, ALL_SEATS),
    ]);
    expect(isStrictlyMoreSpecific(matchOf(rel, "CARPETS"), matchOf(rel, "ANY"))).toBe(true);
    expect(resolutionAt(lookup(rel, "N100TL", "2026-11-12"), "SEAT:3A", "CUSHION")).toMatchObject({
      status: "RESOLVED",
      ruleId: "CARPETS",
      dominatedRuleIds: ["ANY"],
    });
  });

  it("a rule broader in one dimension and narrower in another is incomparable", () => {
    // WIDE-SEATS: only V01 but every seat; ONE-SEAT: every FX-MAX8 variant but only 3A
    const rel = withCushionRules([
      cushionRule("WIDE-SEATS", "P-WIDE", { variant: ["V01"] }, ALL_SEATS),
      cushionRule("ONE-SEAT", "P-ONE", { subtype: ["FX-MAX8"] }, { kind: "SEAT", ids: ["SEAT:3A"] }),
    ]);
    const wide = matchOf(rel, "WIDE-SEATS");
    const one = matchOf(rel, "ONE-SEAT");
    expect(isSubset(wide, one)).toBe(false);
    expect(isSubset(one, wide)).toBe(false);
    expect(status3A(rel)).toBe("AMBIGUOUS");
  });

  it("two tied rules selecting the same part are still AMBIGUOUS", () => {
    const rel = withCushionRules([
      cushionRule("FIRST", "P-SAME", { variant: ["V01"] }, ALL_SEATS),
      cushionRule("SECOND", "P-SAME", { variant: ["V01"] }, ALL_SEATS),
    ]);
    const r = resolutionAt(lookup(rel, "N100TL", "2026-11-12"), "SEAT:3A", "CUSHION");
    expect(r.status).toBe("AMBIGUOUS");
    expect(r.status === "AMBIGUOUS" && r.candidates.map((c) => c.ruleId)).toEqual(["FIRST", "SECOND"]);
  });

  it("constraint.layoutRevision narrows to that revision when a variant lists two", () => {
    const rel = withCushionRules(
      [
        cushionRule("BOTH", "P-BOTH", { variant: ["V01"] }, ALL_SEATS),
        cushionRule("FIRST-REV", "P-FIRST", { variant: ["V01"], layoutRevision: ["FX-L-S176-MAX8@1"] }, ALL_SEATS),
      ],
      (c) => {
        const rev = must(
          c.layoutRevisions.find((r) => r.id === "FX-L-S176-MAX8@1"),
          "revision FX-L-S176-MAX8@1",
        );
        c.layoutRevisions.push({ ...rev, id: "FX-L-S176-MAX8@2" });
        must(
          c.variants.find((v) => v.id === "V01"),
          "variant V01",
        ).layoutRevisionIds.push("FX-L-S176-MAX8@2");
      },
    );
    expect([...matchOf(rel, "BOTH").pairs.keys()]).toEqual(["V01|FX-L-S176-MAX8@1", "V01|FX-L-S176-MAX8@2"]);
    expect([...matchOf(rel, "FIRST-REV").pairs.keys()]).toEqual(["V01|FX-L-S176-MAX8@1"]);
    expect(isStrictlyMoreSpecific(matchOf(rel, "FIRST-REV"), matchOf(rel, "BOTH"))).toBe(true);
    expect(resolutionAt(lookup(rel, "N100TL", "2026-11-12"), "SEAT:3A", "CUSHION")).toMatchObject({ status: "RESOLVED", ruleId: "FIRST-REV" });
  });
});
