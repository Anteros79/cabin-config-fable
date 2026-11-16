import { describe, expect, it } from "vitest";
import { lookup } from "../../src/domain/resolve.ts";
import { buildIndex, isStrictlyMoreSpecific, isSubset } from "../../src/domain/specificity.ts";
import type { ApplicabilityRule, ReleaseContent } from "../../src/domain/types.ts";
import { asRelease, entry, fixtureContent, fixtureRelease, partAt, resolutionAt } from "../helpers.ts";

const release = fixtureRelease();

describe("lookup states", () => {
  const cases: [string, string, string, string][] = [
    ["", "2026-11-12", "INVALID_INPUT", "TAIL_MISSING"],
    ["N1!", "2026-11-12", "INVALID_INPUT", "TAIL_INVALID"],
    ["N100TL", "", "INVALID_INPUT", "DATE_MISSING"],
    ["N100TL", "12/11/2026", "INVALID_INPUT", "DATE_INVALID"],
    ["N100TL", "2026-02-30", "INVALID_INPUT", "DATE_INVALID"],
    ["N999ZZ", "2026-11-12", "UNKNOWN_TAIL", "TAIL_NOT_IN_REFERENCE"],
    ["N000TL", "2026-11-12", "UNCONFIGURED", "NO_ASSIGNMENTS"],
    ["N500TL", "2026-03-01", "UNCONFIGURED", "DATE_GAP"],
    ["N400TL", "2026-09-15", "OVERLAP", "OVERLAPPING_ASSIGNMENTS"],
    ["N110TL", "2026-11-12", "PLANNED", "PLANNED_ONLY"],
    ["N600TL", "2026-03-01", "SOURCE_INVALID", "CONFIGURATION_SOURCE_INVALID"],
    ["N090TL", "2026-11-12", "PARTIAL", "UNRESOLVED_COMPONENTS"],
    ["N100TL", "2026-11-12", "RESOLVED", "ALL_COMPONENTS_RESOLVED"],
  ];
  it.each(cases)("%s on %s -> %s (%s)", (tail, date, state, reason) => {
    const result = lookup(release, tail, date);
    expect(result.state).toBe(state);
    expect(result.reasonCode).toBe(reason);
    expect(result.demo).toBe(true);
    if (state !== "RESOLVED" && state !== "PARTIAL") {
      expect(result.context).toBeUndefined();
      expect(result.resolution).toBeUndefined();
    }
  });

  it("normalises tail case and whitespace", () => {
    expect(lookup(release, "  n100tl ", "2026-11-12").tail).toBe("N100TL");
    expect(lookup(release, "  n100tl ", "2026-11-12").state).toBe("RESOLVED");
  });

  it("does not pick the first of two overlapping assignments", () => {
    const result = lookup(release, "N400TL", "2026-09-15");
    expect(result.context).toBeUndefined();
    expect(result.assignmentsConsidered!.filter((a) => a.coversDate).map((a) => a.variantId)).toEqual(["V05", "V04"]);
    // outside the overlap each side resolves normally
    expect(lookup(release, "N400TL", "2026-08-31").context!.variant.id).toBe("V05");
    expect(lookup(release, "N400TL", "2026-10-01").context!.variant.id).toBe("V04");
  });

  it("never turns a planned layout into released data", () => {
    const result = lookup(release, "N110TL", "2026-11-12");
    expect(result.state).toBe("PLANNED");
    expect(result.message).toMatch(/not released data/);
    // a planned assignment beside a released one is advisory only
    const both = fixtureRelease((c) => {
      const planned = c.assignments.find((a) => a.tail === "N110TL")!;
      c.assignments.push({ ...planned, id: "X-PLANNED", tail: "N100TL" });
      c.aircraft.find((a) => a.tail === "N100TL")!.subtypeId = "FX-MAX8";
    });
    const r = lookup(both, "N100TL", "2026-11-12");
    expect(r.state).toBe("RESOLVED");
    expect(r.context!.variant.id).toBe("V01");
    expect(r.context!.plannedAdvisories.map((a) => a.id)).toEqual(["X-PLANNED"]);
  });

  it("refuses an inconsistent configuration instead of guessing another", () => {
    const bad = fixtureRelease((c) => (c.aircraft.find((a) => a.tail === "N100TL")!.subtypeId = "FX-800"));
    const r = lookup(bad, "N100TL", "2026-11-12");
    expect(r.state).toBe("SOURCE_INVALID");
    expect(r.reasonCode).toBe("INCONSISTENT_CONFIGURATION");
  });
});

describe("inclusive date boundaries", () => {
  it("assignment start: N100TL is unconfigured on 2025-09-30 and V01 on 2025-10-01", () => {
    expect(lookup(release, "N100TL", "2025-09-30").state).toBe("UNCONFIGURED");
    expect(lookup(release, "N100TL", "2025-10-01").context!.variant.id).toBe("V01");
  });
  it("assignment end and retrofit: N200TL is V05 through 2026-06-30 and V04 from 2026-07-01", () => {
    const before = lookup(release, "N200TL", "2026-06-30");
    const after = lookup(release, "N200TL", "2026-07-01");
    expect(before.context!.variant.id).toBe("V05");
    expect(before.context!.assignment).toMatchObject({ carpet: "BOTANY", seam: "PRE" });
    expect(after.context!.variant.id).toBe("V04");
    expect(after.context!.assignment).toMatchObject({ carpet: "BOTANY", seam: "POST" });
  });
  it("N300TL is V10 from 2026-03-15 and unconfigured the day before", () => {
    expect(lookup(release, "N300TL", "2026-03-14").reasonCode).toBe("DATE_GAP");
    expect(lookup(release, "N300TL", "2026-03-15").context!.variant.id).toBe("V10");
  });
  it("date gap edges for N500TL", () => {
    expect(lookup(release, "N500TL", "2025-12-31").state).toBe("RESOLVED");
    expect(lookup(release, "N500TL", "2026-01-01").reasonCode).toBe("DATE_GAP");
    expect(lookup(release, "N500TL", "2026-05-31").reasonCode).toBe("DATE_GAP");
    expect(lookup(release, "N500TL", "2026-06-01").state).toBe("RESOLVED");
  });
  it("configuration source expiry is inclusive", () => {
    expect(lookup(release, "N600TL", "2025-12-31").state).toBe("RESOLVED");
    expect(lookup(release, "N600TL", "2026-01-01").state).toBe("SOURCE_INVALID");
  });
  it("substitute approval is offered on 2026-12-31 and excluded with reasons on 2027-01-01", () => {
    const last = lookup(release, "N100TL", "2026-12-31");
    const kitLast = entry(last.resolution!.rules, (resolutionAt(last, "FLOOR:FULL-CABIN", "CARPET_KIT") as { ruleId: string }).ruleId);
    expect(kitLast.partNo).toBe("FAKE-CK-2001");
    expect(kitLast.substitutes.map((s) => s.altPartNo)).toEqual(["FAKE-CK-2000"]);
    expect(kitLast.excludedSubstitutes).toEqual([]);
    const next = lookup(release, "N100TL", "2027-01-01");
    const kitNext = entry(next.resolution!.rules, (resolutionAt(next, "FLOOR:FULL-CABIN", "CARPET_KIT") as { ruleId: string }).ruleId);
    expect(kitNext.partNo).toBe("FAKE-CK-2001"); // the primary stays valid
    expect(kitNext.substitutes).toEqual([]);
    expect(kitNext.excludedSubstitutes[0]?.reasons.map((r) => r.code).sort()).toEqual(["APPROVAL_EXPIRED", "SOURCE_EXPIRED"]);
    // not yet effective the day before the approval starts
    const early = lookup(
      fixtureRelease((c) => (c.assignments.find((a) => a.tail === "N100TL")!.effectiveFrom = "2025-01-01")),
      "N100TL",
      "2025-07-21",
    );
    const kitEarly = entry(early.resolution!.rules, (resolutionAt(early, "FLOOR:FULL-CABIN", "CARPET_KIT") as { ruleId: string }).ruleId);
    expect(kitEarly.excludedSubstitutes[0]?.reasons.map((r) => r.code)).toEqual(["APPROVAL_NOT_YET_EFFECTIVE"]);
  });
});

describe("mandatory fixture parts", () => {
  it("FAKE-SC-1001 is the V01 ELR-A cushion at 1A-5A and nowhere else", () => {
    const r = lookup(release, "N100TL", "2026-11-12");
    const where = r.resolution!.components.filter((c) => c.status === "RESOLVED" && r.resolution!.rules[c.ruleId]?.partNo === "FAKE-SC-1001");
    expect(where.map((c) => `${c.locationId}/${c.componentId}`)).toEqual([
      "SEAT:1A/CUSHION",
      "SEAT:2A/CUSHION",
      "SEAT:3A/CUSHION",
      "SEAT:4A/CUSHION",
      "SEAT:5A/CUSHION",
    ]);
    expect(partAt(r, "SEAT:3A", "BACKREST")).toBe("FAKE-V01-ELR-A-BACKREST"); // cushion and backrest are independent
    expect(partAt(r, "SEAT:6A", "CUSHION")).toBe("FAKE-SC-1002");
  });
  it("FAKE-CK-2001 is the V01 primary carpet kit; FAKE-CK-2002 is V04 Botany/post-fix with a pending change", () => {
    expect(partAt(lookup(release, "N100TL", "2026-11-12"), "FLOOR:FULL-CABIN", "CARPET_KIT")).toBe("FAKE-CK-2001");
    const r = lookup(release, "N200TL", "2026-07-01");
    const res = resolutionAt(r, "FLOOR:FULL-CABIN", "CARPET_KIT") as { ruleId: string; dominatedRuleIds: string[] };
    const rule = entry(r.resolution!.rules, res.ruleId);
    expect(rule.partNo).toBe("FAKE-CK-2002");
    expect(res.dominatedRuleIds).toEqual(["FX-R-V04-CARPET-KIT"]);
    expect(rule.pendingChanges.map((p) => p.note)).toEqual(["Fictional STA 521 revision pending."]);
    // the pending change is an advisory: the rule is still effective and resolved
    expect(r.state).toBe("RESOLVED");
    expect(partAt(lookup(release, "N200TL", "2026-06-30"), "FLOOR:FULL-CABIN", "CARPET_KIT")).toBe("FAKE-V05-CARPET-KIT");
  });
  it("N090TL shows every gap kind with a reason", () => {
    const r = lookup(release, "N090TL", "2026-11-12");
    expect(r.resolution!.counts).toEqual({ resolved: 270, noMatch: 23, ambiguous: 1 });
    const fwd = resolutionAt(r, "FLOOR:FWD", "CARPET_PANEL");
    expect(fwd.status).toBe("AMBIGUOUS");
    expect(fwd.status === "AMBIGUOUS" && fwd.candidates.map((c) => c.ruleId).sort()).toEqual(["FX-R-700-PRE-FWD-PANEL", "FX-R-V09-FWD-PANEL"]);
    const backrest = resolutionAt(r, "SEAT:12A", "BACKREST");
    expect(backrest.status === "NO_MATCH" && backrest.excluded[0]?.reasons.map((x) => x.code)).toEqual(["SOURCE_EXPIRED"]);
    const aft = resolutionAt(r, "FLOOR:AFT", "CARPET_PANEL");
    expect(aft.status === "NO_MATCH" && aft.excluded[0]?.reasons.map((x) => x.code).sort()).toEqual(["NOT_RELEASED", "SOURCE_NOT_RELEASED"]);
    const bin = resolutionAt(r, "BIN:L-01", "BIN_DOOR");
    expect(bin.status === "NO_MATCH" && bin.excluded).toEqual([]);
  });
});

// --- synthetic rule sets for specificity -----------------------------------------------------
function rule(
  id: string,
  partNo: string,
  constraint: ApplicabilityRule["constraint"],
  locations: ApplicabilityRule["locations"],
  extra: Partial<ApplicabilityRule> = {},
): ApplicabilityRule {
  return {
    id,
    namespace: "fixture",
    componentId: "CUSHION",
    partNo,
    qtyPerReplacement: 1,
    unit: "EA",
    constraint,
    locations,
    released: true,
    effectiveFrom: "2024-01-01",
    effectiveTo: null,
    sourceId: "FX-DOC-A",
    ...extra,
  };
}
function withRules(rules: ApplicabilityRule[], more?: (c: ReleaseContent) => void) {
  return fixtureRelease((c) => {
    c.rules = c.rules.filter((r) => !(r.componentId === "CUSHION" && r.constraint.variant?.includes("V01")));
    for (const r of rules) {
      if (!c.parts.some((p) => p.partNo === r.partNo)) c.parts.push({ partNo: r.partNo, namespace: "fixture", description: r.partNo });
      c.rules.push(r);
    }
    more?.(c);
  });
}
const ALL_SEATS = { kind: "SEAT" as const };
const at3A = (rel: ReturnType<typeof withRules>) => resolutionAt(lookup(rel, "N100TL", "2026-11-12"), "SEAT:3A", "CUSHION");

describe("specificity by logical implication", () => {
  it("an exact-seat rule that implies the broad rule dominates it", () => {
    const rel = withRules([
      rule("BROAD", "P-BROAD", { variant: ["V01"] }, ALL_SEATS),
      rule("EXACT", "P-EXACT", { variant: ["V01"] }, { kind: "SEAT", ids: ["SEAT:3A"] }),
    ]);
    const r = at3A(rel);
    expect(r).toMatchObject({ status: "RESOLVED", ruleId: "EXACT", dominatedRuleIds: ["BROAD"] });
    expect(partAt(lookup(rel, "N100TL", "2026-11-12"), "SEAT:4A", "CUSHION")).toBe("P-BROAD");
  });

  it("insertion order does not matter", () => {
    const a = withRules([
      rule("BROAD", "P-BROAD", { variant: ["V01"] }, ALL_SEATS),
      rule("EXACT", "P-EXACT", { variant: ["V01"] }, { kind: "SEAT", ids: ["SEAT:3A"] }),
    ]);
    const b = withRules([
      rule("EXACT", "P-EXACT", { variant: ["V01"] }, { kind: "SEAT", ids: ["SEAT:3A"] }),
      rule("BROAD", "P-BROAD", { variant: ["V01"] }, ALL_SEATS),
    ]);
    expect(at3A(a)).toMatchObject({ ruleId: "EXACT" });
    expect(at3A(b)).toMatchObject({ ruleId: "EXACT" });
  });

  it("equal rules are ambiguous", () => {
    const rel = withRules([rule("ONE", "P-ONE", { variant: ["V01"] }, ALL_SEATS), rule("TWO", "P-TWO", { variant: ["V01"] }, ALL_SEATS)]);
    const r = at3A(rel);
    expect(r.status).toBe("AMBIGUOUS");
    expect(r.status === "AMBIGUOUS" && r.candidates.map((c) => c.ruleId)).toEqual(["ONE", "TWO"]);
  });

  it("equal rules written differently are still equal (zone+letter vs explicit ids)", () => {
    const rel = withRules([
      rule("ZONE", "P-ZONE", { variant: ["V01"] }, { kind: "SEAT", zones: ["ELR"], letters: ["A"] }),
      rule("IDS", "P-IDS", { variant: ["V01"] }, { kind: "SEAT", ids: ["SEAT:1A", "SEAT:2A", "SEAT:3A", "SEAT:4A", "SEAT:5A"] }),
    ]);
    expect(at3A(rel).status).toBe("AMBIGUOUS");
  });

  it("incomparable rules are ambiguous even when one has more selectors", () => {
    // TWO has two constraints, ONE has one; neither implies the other.
    const rel = withRules([rule("ONE", "P-ONE", { carpet: ["MOHAWK"] }, ALL_SEATS), rule("TWO", "P-TWO", { variant: ["V01"], seam: ["PRE"] }, ALL_SEATS)]);
    const r = at3A(rel);
    expect(r.status).toBe("AMBIGUOUS");
    const index = buildIndex(rel);
    const one = index.ruleMatch.get("ONE")!;
    const two = index.ruleMatch.get("TWO")!;
    expect(isSubset(one, two)).toBe(false);
    expect(isSubset(two, one)).toBe(false);
  });

  it("an exact-seat rule without the broad rule's constraint is not more specific", () => {
    // "3A in any variant" does not imply "any seat in V01", so it cannot override it.
    const rel = withRules([rule("BROAD", "P-BROAD", { variant: ["V01"] }, ALL_SEATS), rule("SEAT-ONLY", "P-SEAT", {}, { kind: "SEAT", ids: ["SEAT:3A"] })]);
    expect(at3A(rel).status).toBe("AMBIGUOUS");
  });

  it("derived attributes are closed under implication: variant V01 implies its subtype and hardware", () => {
    const rel = withRules([
      rule("SUBTYPE", "P-SUB", { subtype: ["FX-MAX8"] }, ALL_SEATS),
      rule("VARIANT", "P-VAR", { variant: ["V01"] }, ALL_SEATS),
      rule("HARDWARE", "P-HW", { hardware: ["Recaro"], subtype: ["FX-MAX8"] }, ALL_SEATS),
    ]);
    // V01 is the only Recaro MAX8 variant, so VARIANT and HARDWARE accept exactly the same situations.
    const index = buildIndex(rel);
    expect(isStrictlyMoreSpecific(index.ruleMatch.get("VARIANT")!, index.ruleMatch.get("SUBTYPE")!)).toBe(true);
    expect(isSubset(index.ruleMatch.get("VARIANT")!, index.ruleMatch.get("HARDWARE")!)).toBe(true);
    expect(isSubset(index.ruleMatch.get("HARDWARE")!, index.ruleMatch.get("VARIANT")!)).toBe(true);
    expect(at3A(rel).status).toBe("AMBIGUOUS"); // VARIANT and HARDWARE tie; SUBTYPE is dominated by both
    const two = withRules([rule("SUBTYPE", "P-SUB", { subtype: ["FX-MAX8"] }, ALL_SEATS), rule("VARIANT", "P-VAR", { variant: ["V01"] }, ALL_SEATS)]);
    expect(at3A(two)).toMatchObject({ status: "RESOLVED", ruleId: "VARIANT" });
  });

  it("a three-level chain resolves to the most specific rule", () => {
    const rel = withRules([
      rule("L1", "P-1", { subtype: ["FX-MAX8"] }, ALL_SEATS),
      rule("L2", "P-2", { variant: ["V01"] }, { kind: "SEAT", zones: ["ELR"] }),
      rule("L3", "P-3", { variant: ["V01"], carpet: ["MOHAWK"] }, { kind: "SEAT", ids: ["SEAT:3A"] }),
    ]);
    expect(at3A(rel)).toMatchObject({ status: "RESOLVED", ruleId: "L3" });
    expect(partAt(lookup(rel, "N100TL", "2026-11-12"), "SEAT:4A", "CUSHION")).toBe("P-2");
    expect(partAt(lookup(rel, "N100TL", "2026-11-12"), "SEAT:20A", "CUSHION")).toBe("P-1");
  });

  it("a constrained dimension never matches an unknown context value", () => {
    const rel = withRules([rule("CARPET", "P-C", { carpet: ["MOHAWK"] }, ALL_SEATS)], (c) => (c.assignments.find((a) => a.tail === "N100TL")!.carpet = null));
    expect(at3A(rel).status).toBe("NO_MATCH");
  });
});

describe("rule validity versus source validity", () => {
  const broad = () => rule("BROAD", "P-BROAD", { variant: ["V01"] }, ALL_SEATS);
  it("an expired rule and an expired source are reported as different reasons", () => {
    const ruleExpired = withRules([{ ...broad(), effectiveTo: "2026-11-11" }]);
    const a = at3A(ruleExpired);
    expect(a.status === "NO_MATCH" && a.excluded[0]?.reasons.map((x) => x.code)).toEqual(["RULE_EXPIRED"]);
    const sourceExpired = withRules([{ ...broad(), sourceId: "FX-DOC-OLD" }]);
    const b = at3A(sourceExpired);
    expect(b.status === "NO_MATCH" && b.excluded[0]?.reasons.map((x) => x.code)).toEqual(["SOURCE_EXPIRED"]);
  });
  it("rule end date is inclusive", () => {
    const rel = withRules([{ ...broad(), effectiveTo: "2026-11-12" }]);
    expect(at3A(rel).status).toBe("RESOLVED");
  });
  it("a rule not yet effective, or citing a not-yet-effective or missing source, grants nothing", () => {
    expect(at3A(withRules([{ ...broad(), effectiveFrom: "2026-11-13" }])).status).toBe("NO_MATCH");
    const future = withRules([broad()], (c) => (c.sources.find((s) => s.id === "FX-DOC-A")!.effectiveFrom = "2027-01-01"));
    const r = at3A(future);
    expect(r.status === "NO_MATCH" && r.excluded[0]?.reasons.map((x) => x.code)).toEqual(["SOURCE_NOT_YET_EFFECTIVE"]);
  });
  it("an unreleased more-specific change cannot grant eligibility or displace the released rule", () => {
    const rel = withRules([broad(), rule("DRAFT", "P-DRAFT", { variant: ["V01"] }, { kind: "SEAT", ids: ["SEAT:3A"] }, { released: false })]);
    expect(at3A(rel)).toMatchObject({ status: "RESOLVED", ruleId: "BROAD" });
    const only = withRules([rule("DRAFT", "P-DRAFT", { variant: ["V01"] }, { kind: "SEAT", ids: ["SEAT:3A"] }, { released: false })]);
    const r = at3A(only);
    expect(r.status === "NO_MATCH" && r.excluded[0]?.reasons.map((x) => x.code)).toContain("NOT_RELEASED");
  });
  it("an expired specific rule falls back to the still-valid broad rule rather than leaving a silent gap", () => {
    const rel = withRules([broad(), rule("EXACT", "P-EXACT", { variant: ["V01"] }, { kind: "SEAT", ids: ["SEAT:3A"] }, { effectiveTo: "2026-01-01" })]);
    expect(at3A(rel)).toMatchObject({ status: "RESOLVED", ruleId: "BROAD" });
  });
});

describe("substitute scope", () => {
  it("is offered only where its own constraint and location scope apply", () => {
    const rel = fixtureRelease((c) => {
      c.substitutes.push({
        id: "X-SUB-SEAT",
        namespace: "fixture",
        componentId: "CUSHION",
        primaryPartNo: "FAKE-SC-1001",
        altPartNo: "FAKE-SC-1002",
        qtyPerReplacement: 1,
        unit: "EA",
        constraint: { variant: ["V01"], carpet: ["MOHAWK"] },
        locations: { kind: "SEAT", ids: ["SEAT:3A", "SEAT:4A"] },
        released: true,
        effectiveFrom: "2024-01-01",
        effectiveTo: null,
        sourceId: "FX-DOC-A",
      });
    });
    const r = lookup(rel, "N100TL", "2026-11-12");
    const ruleId = (resolutionAt(r, "SEAT:3A", "CUSHION") as { ruleId: string }).ruleId;
    expect(entry(r.resolution!.rules, ruleId).substitutes.find((s) => s.id === "X-SUB-SEAT")!.locationIds).toEqual(["SEAT:3A", "SEAT:4A"]);
    // a different carpet context removes the approval entirely
    const botany = asRelease(
      fixtureContent((c) => {
        c.substitutes.push({
          id: "X-SUB-SEAT",
          namespace: "fixture",
          componentId: "CUSHION",
          primaryPartNo: "FAKE-SC-1001",
          altPartNo: "FAKE-SC-1002",
          qtyPerReplacement: 1,
          unit: "EA",
          constraint: { variant: ["V01"], carpet: ["BOTANY"] },
          released: true,
          effectiveFrom: "2024-01-01",
          effectiveTo: null,
          sourceId: "FX-DOC-A",
        });
      }),
    );
    const rb = lookup(botany, "N100TL", "2026-11-12");
    const ruleB = (resolutionAt(rb, "SEAT:3A", "CUSHION") as { ruleId: string }).ruleId;
    expect(entry(rb.resolution!.rules, ruleB).substitutes).toEqual([]);
    expect(entry(rb.resolution!.rules, ruleB).excludedSubstitutes).toEqual([]);
  });
});
