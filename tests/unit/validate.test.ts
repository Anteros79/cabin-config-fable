import { describe, expect, it } from "vitest";
import type { ApplicabilityRule, Finding, ReleaseContent } from "../../src/domain/types.ts";
import { validateRelease } from "../../src/domain/validate.ts";
import { fixtureContent, stagedFull } from "../helpers.ts";

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}

function withCode(findings: Finding[], code: string): Finding[] {
  return findings.filter((f) => f.code === code);
}

function rule(c: ReleaseContent, id: string): ApplicabilityRule {
  const found = c.rules.find((r) => r.id === id);
  if (!found) throw new Error(`missing rule ${id}`);
  return found;
}

/** A released cushion rule over every seat, copied from a real one so parts and sources resolve. */
function cushionOverAllSeats(c: ReleaseContent, id: string, constraint: ApplicabilityRule["constraint"]): ApplicabilityRule {
  return { ...rule(c, "FX-R-V01-ELR-A-CUSHION"), id, constraint, locations: { kind: "SEAT" } };
}

function expectFinding(findings: Finding[], code: string, severity: Finding["severity"], ref: string): void {
  const hits = withCode(findings, code);
  expect(hits.length).toBeGreaterThan(0);
  for (const f of hits) expect(f.severity).toBe(severity);
  expect(hits.some((f) => f.refs?.includes(ref))).toBe(true);
}

describe("referential findings", () => {
  it("SELECTOR_ID_UNKNOWN: a selector id that exists in no reachable layout revision", () => {
    const findings = validateRelease(
      fixtureContent((c) => {
        rule(c, "FX-R-V01-CARPET-KIT").locations.ids = ["FLOOR:FULL-CABIN", "SEAT:99Z"];
      }),
    );
    expectFinding(findings, "SELECTOR_ID_UNKNOWN", "error", "FX-R-V01-CARPET-KIT");
    expectFinding(findings, "SELECTOR_ID_UNKNOWN", "error", "SEAT:99Z");
    expect(withCode(findings, "SELECTOR_ID_UNKNOWN")).toHaveLength(1);
  });

  it("SELECTOR_ID_UNKNOWN: an id that exists only in a revision the constraint cannot reach", () => {
    // FLOOR:FULL-CABIN exists in every fixture layout, so pick a seat only some layouts have
    const findings = validateRelease(
      fixtureContent((c) => {
        const revisionOf = (variantId: string) => {
          const variant = must(
            c.variants.find((v) => v.id === variantId),
            variantId,
          );
          return must(
            c.layoutRevisions.find((r) => variant.layoutRevisionIds.includes(r.id)),
            `${variantId} layout`,
          );
        };
        const v09 = revisionOf("V09");
        const onlyV01 = must(
          revisionOf("V01").locations.find((l) => l.kind === "SEAT" && !v09.locations.some((m) => m.id === l.id)),
          "a V01 seat absent from V09",
        );
        c.rules.push({ ...cushionOverAllSeats(c, "X-V09-ID", { variant: ["V09"] }), locations: { kind: "SEAT", ids: [onlyV01.id] } });
      }),
    );
    expectFinding(findings, "SELECTOR_ID_UNKNOWN", "error", "X-V09-ID");
  });

  it("SELECTOR_VALUE_UNMATCHED: zone, letter, side, floor area and row range values that match nothing", () => {
    const findings = validateRelease(
      fixtureContent((c) => {
        c.rules.push({ ...cushionOverAllSeats(c, "X-ZONE", {}), locations: { kind: "SEAT", zones: ["ELR", "NOWHERE"] } });
        c.rules.push({ ...cushionOverAllSeats(c, "X-LETTER", {}), locations: { kind: "SEAT", letters: ["A", "Q"] } });
        c.rules.push({ ...cushionOverAllSeats(c, "X-ROWS", {}), locations: { kind: "SEAT", rowFrom: 90, rowTo: 99 } });
        const kit = rule(c, "FX-R-V01-CARPET-KIT");
        c.rules.push({ ...kit, id: "X-AREA", locations: { kind: "FLOOR", floorAreaTypes: ["FULL_CABIN"] } });
        const bin = must(
          c.rules.find((r) => r.componentId === "BIN_DOOR"),
          "bin rule",
        );
        c.rules.push({ ...bin, id: "X-SIDE", locations: { kind: "BIN", sides: ["L"] } });
      }),
    );
    const unmatched = withCode(findings, "SELECTOR_VALUE_UNMATCHED");
    for (const f of unmatched) expect(f.severity).toBe("error");
    expect(unmatched.map((f) => f.refs?.[0]).sort()).toEqual(["X-LETTER", "X-ROWS", "X-ZONE"]);
    expect(unmatched.find((f) => f.refs?.[0] === "X-ZONE")?.message).toContain("NOWHERE");
    expect(unmatched.find((f) => f.refs?.[0] === "X-LETTER")?.message).toContain("Q");
  });

  it("ROW_RANGE_INVALID: an inverted range or a single bound", () => {
    const findings = validateRelease(
      fixtureContent((c) => {
        c.rules.push({ ...cushionOverAllSeats(c, "X-INVERTED", {}), locations: { kind: "SEAT", rowFrom: 10, rowTo: 5 } });
        c.rules.push({ ...cushionOverAllSeats(c, "X-ONE-BOUND", {}), locations: { kind: "SEAT", rowFrom: 10 } });
      }),
    );
    expectFinding(findings, "ROW_RANGE_INVALID", "error", "X-INVERTED");
    expectFinding(findings, "ROW_RANGE_INVALID", "error", "X-ONE-BOUND");
    expect(withCode(findings, "SELECTOR_VALUE_UNMATCHED")).toEqual([]);
  });

  it("CONSTRAINT_VALUE_UNKNOWN: a hardware value no variant has", () => {
    const findings = validateRelease(
      fixtureContent((c) => {
        rule(c, "FX-R-V01-ELR-A-CUSHION").constraint = { variant: ["V01"], hardware: ["NoSuchHW", "Recaro"] };
      }),
    );
    expectFinding(findings, "CONSTRAINT_VALUE_UNKNOWN", "error", "FX-R-V01-ELR-A-CUSHION");
    expectFinding(findings, "CONSTRAINT_VALUE_UNKNOWN", "error", "NoSuchHW");
    expect(withCode(findings, "CONSTRAINT_VALUE_UNKNOWN")).toHaveLength(1);
  });

  it("CONSTRAINT_VALUE_UNKNOWN: unknown variant, subtype, layout revision and vocabulary values", () => {
    const findings = validateRelease(
      fixtureContent((c) => {
        rule(c, "FX-R-V01-ELR-A-CUSHION").constraint = {
          variant: ["V01", "V99"],
          subtype: ["FX-999"],
          layoutRevision: ["NO-REV"],
          carpet: ["SHAG"],
          seam: ["ZIP"],
          upholstery: ["VELVET"],
        };
      }),
    );
    const refs = withCode(findings, "CONSTRAINT_VALUE_UNKNOWN").map((f) => f.refs?.[1]);
    expect(refs.sort()).toEqual(["FX-999", "NO-REV", "SHAG", "V99", "VELVET", "ZIP"]);
  });

  it("ASSIGNMENT_INCONSISTENT: aircraft subtype disagrees with the variant and layout revision", () => {
    const content = fixtureContent((c) => {
      must(
        c.aircraft.find((a) => a.tail === "N100TL"),
        "N100TL",
      ).subtypeId = "FX-800";
    });
    const findings = validateRelease(content);
    expectFinding(findings, "ASSIGNMENT_INCONSISTENT", "conflict", "N100TL");
    const ids = content.assignments.filter((a) => a.tail === "N100TL").map((a) => a.id);
    for (const f of withCode(findings, "ASSIGNMENT_INCONSISTENT")) expect(ids).toContain(f.refs?.[0]);
  });

  it("CANDIDATE_HAS_FIXTURE_DATA: a candidate seat with a maintenance zone", () => {
    const content = structuredClone(stagedFull().content);
    const rev = must(
      content.layoutRevisions.find((r) => r.id === "CAND-73G@2026.1"),
      "CAND-73G@2026.1",
    );
    const seat = must(
      rev.locations.find((l) => l.kind === "SEAT"),
      "a candidate seat",
    );
    must(seat.seat, "seat attributes").maintenanceZone = "ELR";
    const findings = validateRelease(content);
    expectFinding(findings, "CANDIDATE_HAS_FIXTURE_DATA", "error", "CAND-73G@2026.1");
    expect(withCode(findings, "CANDIDATE_HAS_FIXTURE_DATA")).toHaveLength(1);
    expect(withCode(findings, "CANDIDATE_HAS_FIXTURE_DATA")[0]?.refs).toContain(`CAND-73G@2026.1#${seat.id}`);
  });

  it("RULES_INCOMPARABLE: two released rules whose scopes overlap without either implying the other", () => {
    const findings = validateRelease(
      fixtureContent((c) => {
        c.rules.push(cushionOverAllSeats(c, "X-MOHAWK", { carpet: ["MOHAWK"] }));
        c.rules.push(cushionOverAllSeats(c, "X-V01-PRE", { variant: ["V01"], seam: ["PRE"] }));
      }),
    );
    const hits = withCode(findings, "RULES_INCOMPARABLE").filter((f) => f.refs?.includes("X-MOHAWK") && f.refs.includes("X-V01-PRE"));
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe("conflict");
    expect(hits[0]?.refs).toEqual(["X-MOHAWK", "X-V01-PRE"]);
    // a seat-wide carpet rule is also incomparable with every per-seat rule it overlaps
    expect(withCode(findings, "RULES_INCOMPARABLE").some((f) => f.refs?.includes("X-MOHAWK") && f.refs.includes("FX-R-V01-ELR-A-CUSHION"))).toBe(true);
  });

  it("RULES_INCOMPARABLE is not raised when a third rule is more specific than both across their overlap", () => {
    const findings = validateRelease(
      fixtureContent((c) => {
        c.rules.push(cushionOverAllSeats(c, "X-MOHAWK", { carpet: ["MOHAWK"] }));
        c.rules.push(cushionOverAllSeats(c, "X-V01-PRE", { variant: ["V01"], seam: ["PRE"] }));
        c.rules.push(cushionOverAllSeats(c, "X-BOTH", { variant: ["V01"], carpet: ["MOHAWK"], seam: ["PRE"] }));
      }),
    );
    expect(withCode(findings, "RULES_INCOMPARABLE").filter((f) => f.refs?.includes("X-MOHAWK") && f.refs.includes("X-V01-PRE"))).toEqual([]);
  });

  it("RULES_INCOMPARABLE is raised when the settling rule's source lapses inside the pair's overlap", () => {
    const pairOf = (f: Finding) => f.refs?.includes("X-MOHAWK") === true && f.refs.includes("X-V01-PRE");
    const settledBy = (sourceId: string) =>
      validateRelease(
        fixtureContent((c) => {
          c.rules.push(cushionOverAllSeats(c, "X-MOHAWK", { carpet: ["MOHAWK"] }));
          c.rules.push(cushionOverAllSeats(c, "X-V01-PRE", { variant: ["V01"], seam: ["PRE"] }));
          c.rules.push({ ...cushionOverAllSeats(c, "X-BOTH", { variant: ["V01"], carpet: ["MOHAWK"], seam: ["PRE"] }), sourceId });
        }),
      );
    // FX-DOC-DEV expires on 2026-12-31 while the pair stays open-ended: from 2027 the pair is ambiguous at lookup
    expect(withCode(settledBy("FX-DOC-DEV"), "RULES_INCOMPARABLE").filter(pairOf)).toHaveLength(1);
    // an unreleased source never lets the third rule apply
    expect(withCode(settledBy("FX-DOC-DRAFT"), "RULES_INCOMPARABLE").filter(pairOf)).toHaveLength(1);
    // an open-ended released source settles it
    expect(withCode(settledBy("FX-DOC-B"), "RULES_INCOMPARABLE").filter(pairOf)).toEqual([]);
  });

  it("an unreleased variant does not turn equal rules into a dominance or raise an incomparable pair", () => {
    const findings = validateRelease(
      fixtureContent((c) => {
        c.rules.push(cushionOverAllSeats(c, "X-HW", { hardware: ["Recaro"], subtype: ["FX-MAX8"] }));
        c.rules.push(cushionOverAllSeats(c, "X-VAR", { variant: ["V01"] }));
        const v01 = must(
          c.variants.find((v) => v.id === "V01"),
          "V01",
        );
        c.variants.push({ ...v01, id: "V99-DRAFT", released: false });
      }),
    );
    const pair = (f: Finding) => f.refs?.includes("X-HW") === true && f.refs.includes("X-VAR");
    expect(findings.filter(pair).map((f) => f.code)).toEqual(["EQUAL_RULES"]);
  });

  it("a rule and substitute staged for a planned revision of an unreleased variant validate, with a warning", () => {
    const content = fixtureContent((c) => {
      const rev = must(
        c.layoutRevisions.find((r) => r.id === "FX-L-S176-MAX8@1"),
        "FX-L-S176-MAX8@1",
      );
      const v01 = must(
        c.variants.find((v) => v.id === "V01"),
        "V01",
      );
      c.layoutRevisions.push({ ...structuredClone(rev), id: "FX-L-S176-MAX8@9", status: "planned" });
      c.variants.push({ ...v01, id: "V12-DRAFT", released: false, layoutRevisionIds: ["FX-L-S176-MAX8@9"] });
      c.rules.push({ ...cushionOverAllSeats(c, "X-STAGED", { variant: ["V12-DRAFT"] }), locations: { kind: "SEAT", ids: ["SEAT:3A"], letters: ["A"] } });
      const sub = must(c.substitutes[0], "a substitute");
      c.substitutes.push({
        ...sub,
        id: "X-STAGED-SUB",
        componentId: "CUSHION",
        primaryPartNo: rule(c, "X-STAGED").partNo,
        constraint: { variant: ["V12-DRAFT"] },
        locations: { kind: "SEAT", ids: ["SEAT:3A"] },
      });
    });
    const findings = validateRelease(content);
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    expectFinding(findings, "RULE_UNRELEASED_ONLY", "warning", "X-STAGED");
    expectFinding(findings, "SUBSTITUTE_UNRELEASED_ONLY", "warning", "X-STAGED-SUB");
    expect(withCode(findings, "SUBSTITUTE_UNREACHABLE").filter((f) => f.refs?.includes("X-STAGED-SUB"))).toEqual([]);
  });

  it("NAMESPACE: a fixture rule reaching a candidate layout revision, even one no released data can use", () => {
    const content = structuredClone(stagedFull().content);
    const rev = must(
      content.layoutRevisions.find((r) => r.id === "CAND-73G@2026.1"),
      "CAND-73G@2026.1",
    );
    const v01 = must(
      content.variants.find((v) => v.id === "V01"),
      "V01",
    );
    // Candidate seats carry no components of their own (Task 3.8); give them the fixture cushion so a rule can reach them.
    for (const seat of rev.locations) if (seat.kind === "SEAT") seat.componentIds = ["CUSHION"];
    content.variants.push({ ...v01, id: "X-CAND-V", namespace: "candidate", subtypeId: rev.subtypeId, layoutRevisionIds: [rev.id] });
    content.rules.push(cushionOverAllSeats(content, "X-REACH", { variant: ["X-CAND-V"] }));
    const hits = withCode(validateRelease(content), "NAMESPACE").filter((f) => f.refs?.includes("X-REACH"));
    expect(hits.map((f) => f.severity)).toEqual(["error"]);
    expect(hits[0]?.message).toMatch(/reaches layout revision CAND-73G@2026\.1/);
  });

  it("RULES_INCOMPARABLE is not raised for rules whose validity does not overlap, or for unreleased rules", () => {
    const findings = validateRelease(
      fixtureContent((c) => {
        c.rules.push({ ...cushionOverAllSeats(c, "X-MOHAWK", { carpet: ["MOHAWK"] }), effectiveTo: "2024-12-31" });
        c.rules.push({ ...cushionOverAllSeats(c, "X-V01-PRE", { variant: ["V01"], seam: ["PRE"] }), effectiveFrom: "2025-01-01" });
        c.rules.push({ ...cushionOverAllSeats(c, "X-DRAFT", { variant: ["V01"], seam: ["PRE"] }), released: false });
      }),
    );
    const among = (f: Finding) => (f.refs ?? []).filter((r) => r.startsWith("X-")).length === 2;
    expect(withCode(findings, "RULES_INCOMPARABLE").filter(among)).toEqual([]);
  });

  it("does not duplicate EQUAL_RULES as RULES_INCOMPARABLE", () => {
    const findings = validateRelease(
      fixtureContent((c) => {
        c.rules.push({ ...rule(c, "FX-R-V02-CARPET-KIT"), id: "X-EQUAL" });
      }),
    );
    expect(withCode(findings, "EQUAL_RULES")).toHaveLength(1);
    expect(withCode(findings, "RULES_INCOMPARABLE").filter((f) => f.refs?.includes("X-EQUAL"))).toEqual([]);
  });

  it("the deliberate N090TL forward-panel ambiguity raises exactly one RULES_INCOMPARABLE and no EQUAL_RULES", () => {
    const findings = validateRelease(fixtureContent());
    const pair = ["FX-R-700-PRE-FWD-PANEL", "FX-R-V09-FWD-PANEL"];
    const touching = findings.filter((f) => pair.every((r) => f.refs?.includes(r)));
    expect(touching.map((f) => [f.severity, f.code, f.refs])).toEqual([["conflict", "RULES_INCOMPARABLE", pair]]);
  });

  it("SUBSTITUTE_UNREACHABLE: a substitute scoped away from every rule selecting its primary part", () => {
    const findings = validateRelease(
      fixtureContent((c) => {
        const base = must(c.substitutes[0], "a substitute");
        c.substitutes.push({
          ...base,
          id: "X-SUB-30F",
          componentId: "CUSHION",
          primaryPartNo: "FAKE-SC-1001",
          altPartNo: "FAKE-SC-1002",
          unit: "EA",
          constraint: {},
          locations: { kind: "SEAT", ids: ["SEAT:30F"] },
        });
      }),
    );
    expectFinding(findings, "SUBSTITUTE_UNREACHABLE", "warning", "X-SUB-30F");
    expect(withCode(findings, "SELECTOR_ID_UNKNOWN")).toEqual([]);
    expect(withCode(findings, "UNREACHABLE_SUBSTITUTE")).toEqual([]);
  });
});

describe("kit child sources (DOM-04)", () => {
  it("KIT_SOURCE_UNRELEASED: a kit child citing an unreleased source is a warning", () => {
    const findings = validateRelease(
      fixtureContent((c) => {
        const draft = must(
          c.sources.find((s) => !s.released),
          "an unreleased source",
        );
        must(
          c.kitChildren.find((k) => k.childPartNo === "FAKE-P-41"),
          "kit line",
        ).sourceId = draft.id;
      }),
    );
    expectFinding(findings, "KIT_SOURCE_UNRELEASED", "warning", "FAKE-CK-2000>FAKE-P-41");
    expect(withCode(findings, "KIT_SOURCE_UNRELEASED")).toHaveLength(1);
  });
});

describe("the unmodified fixture", () => {
  it("yields exactly these conflicts, the only new ones naming the deliberate FX-700/PRE forward-panel rule", () => {
    const conflicts = stagedFull()
      .findings.filter((f) => f.severity === "conflict")
      .map((f) => [f.code, f.refs ?? null]);
    expect(conflicts).toEqual([
      ["BULKHEAD_PARTIAL_SIDE", ["738|2"]],
      ["BULKHEAD_PARTIAL_SIDE", ["7M8-1|2"]],
      ["BULKHEAD_PARTIAL_SIDE", ["738-2|2"]],
      ["BULKHEAD_PARTIAL_SIDE", ["7M8-2|2"]],
      ["LAYOUT_NOT_SUPPLIED", ["DOCX-CAT-700-138"]],
      ["LAYOUT_NOT_SUPPLIED", ["DOCX-CAT-MAX7-NOT-CURRENT"]],
      ["AIRLINE_DATA_NOT_SUPPLIED", null],
      ["ASSIGNMENT_OVERLAP", ["FX-TA-N400TL-V05-2024-01-01", "FX-TA-N400TL-V04-2026-09-01"]],
      // both pairs come from the deliberate FX-700/PRE forward-panel rule: V09 (N090TL, documented) and V10 (latent, no PRE tail)
      ["RULES_INCOMPARABLE", ["FX-R-700-PRE-FWD-PANEL", "FX-R-V09-FWD-PANEL"]],
      ["RULES_INCOMPARABLE", ["FX-R-700-PRE-FWD-PANEL", "FX-R-V10-FWD-PANEL"]],
    ]);
  });

  it("has no errors and no warnings", () => {
    expect(stagedFull().findings.filter((f) => f.severity === "error" || f.severity === "warning")).toEqual([]);
  });
});
