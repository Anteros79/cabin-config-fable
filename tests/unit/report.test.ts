import { describe, expect, it } from "vitest";
import { buildPreparation } from "../../src/domain/prep.ts";
import { buildReport, rulesNotUsedLine } from "../../src/domain/report.ts";
import { lookup } from "../../src/domain/resolve.ts";
import type { ComponentResolution, ReleaseContent, SubstituteApproval, Visit } from "../../src/domain/types.ts";
import { REPORT_SCHEMA } from "../../src/domain/types.ts";
import { DomainError } from "../../src/domain/visitLogic.ts";
import {
  asRelease,
  CUSHION_3A,
  cushionRule,
  entry,
  fixtureContent,
  fixtureRelease,
  KIT_ALTERNATE,
  KIT_PRIMARY,
  oldShapeSnapshot,
  resolutionAt,
  snapshotFor,
  visitWith,
  withCushionRules,
} from "../helpers.ts";

const AT = "2026-11-12T12:02:00.000Z";

/** N100TL with an exact SEAT:3A cushion rule that ended the day before the check, citing FX-DOC-C. */
function releaseWithExpiredExactRule() {
  return asRelease(
    fixtureContent((c) => {
      const v01 = c.rules.find((r) => r.componentId === "CUSHION" && r.partNo === "FAKE-SC-1001");
      if (!v01) throw new Error("fixture has no V01 cushion rule");
      c.rules.push({
        ...structuredClone(v01),
        id: "X-EXPIRED-EXACT",
        locations: { kind: "SEAT", ids: ["SEAT:3A"] },
        effectiveTo: "2026-11-11",
        sourceId: "FX-DOC-C",
      });
    }),
  );
}

describe("report schema 2 (DOM-01, DOM-16)", () => {
  it("report.sources includes every source cited by gaps", () => {
    const snap = snapshotFor(fixtureRelease(), "N090TL", "2026-11-12");
    const report = buildReport(visitWith(snap, [CUSHION_3A]), "DRAFT_PREVIEW", AT);
    const ids = report.sources.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["FX-DOC-B", "FX-DOC-OLD", "FX-DOC-DRAFT"]));
    expect([...ids].sort()).toEqual(ids);
    // every source a gap cites is listed, and each gap names its own
    const cited = report.gaps.flatMap((g) => g.sourceIds ?? []);
    for (const id of cited) expect(ids).toContain(id);
    const backrest = report.gaps.find((g) => g.componentId === "BACKREST");
    expect(backrest?.sourceIds).toEqual(["FX-DOC-OLD"]);
    const ambiguous = report.gaps.find((g) => g.status === "AMBIGUOUS");
    expect(ambiguous?.sourceIds).toEqual(["FX-DOC-B"]);
    const bins = report.gaps.find((g) => g.componentId === "BIN_DOOR");
    expect(bins?.sourceIds).toEqual([]);
  });

  it("new reports use schema /2 and carry excludedRules", () => {
    const snap = snapshotFor(releaseWithExpiredExactRule(), "N100TL", "2026-11-12");
    const report = buildReport(visitWith(snap, [CUSHION_3A]), "DRAFT_PREVIEW", AT);
    expect(REPORT_SCHEMA).toBe("cabin-kit.report/2");
    expect(report.schema).toBe("cabin-kit.report/2");
    const [item] = report.work;
    expect(item?.ruleId).not.toBe("X-EXPIRED-EXACT");
    expect(item?.excludedRules).toEqual([
      expect.objectContaining({
        ruleId: "X-EXPIRED-EXACT",
        partNo: "FAKE-SC-1001",
        sourceId: "FX-DOC-C",
        reasons: [expect.objectContaining({ code: "RULE_EXPIRED" })],
      }),
    ]);
    // the excluded rule's source is cited even though no part line uses it
    expect(report.sources.map((s) => s.id)).toContain("FX-DOC-C");
    expect(rulesNotUsedLine(item?.excludedRules)).toBe("Rules not used: X-EXPIRED-EXACT (FAKE-SC-1001): Rule X-EXPIRED-EXACT ended after 2026-11-11.");
  });

  it("a snapshot without excluded fields still builds a report", () => {
    const snap = oldShapeSnapshot(snapshotFor(releaseWithExpiredExactRule(), "N100TL", "2026-11-12"));
    expect(snap.resolution.components.some((c) => "excluded" in c)).toBe(false);
    const report = buildReport(visitWith(snap, [CUSHION_3A]), "DRAFT_PREVIEW", AT);
    expect(report.work[0]?.excludedRules).toEqual([]);
    expect(report.schema).toBe("cabin-kit.report/2");
    // an old PARTIAL snapshot (no-match exclusions without sourceId) builds its gaps and preparation list
    const partial = oldShapeSnapshot(snapshotFor(fixtureRelease(), "N090TL", "2026-11-12"));
    const old = buildReport(visitWith(partial, [CUSHION_3A]), "DRAFT_PREVIEW", AT);
    expect(old.gaps.find((g) => g.componentId === "BACKREST")?.sourceIds).toEqual([]);
    expect(old.counts.unresolvedComponents).toBe(24);
    expect(buildPreparation(partial).lines.every((l) => l.excludedRules.length === 0)).toBe(true);
  });

  it("the preparation list keeps excluded rules under the resolved part with their locations", () => {
    const prep = buildPreparation(snapshotFor(releaseWithExpiredExactRule(), "N100TL", "2026-11-12"));
    const cushion = prep.lines.find((l) => l.partNo === "FAKE-SC-1001");
    expect(cushion?.excludedRules).toEqual([
      expect.objectContaining({ ruleId: "X-EXPIRED-EXACT", locationIds: ["SEAT:3A"], locationSummary: "Seat A row 3 (1 location)" }),
    ]);
    expect(prep.lines.filter((l) => l.excludedRules.length > 0)).toHaveLength(1);
  });

  it("no line is shown when nothing was excluded", () => {
    expect(rulesNotUsedLine(undefined)).toBeNull();
    expect(rulesNotUsedLine([])).toBeNull();
  });
});

const record = (locationId: string, componentId: string, extra: Record<string, unknown> = {}) => ({
  locationId,
  componentId,
  selection: "PRIMARY",
  substituteId: null,
  quantity: 1,
  note: "",
  ...extra,
});

/** A dead (unreleased) source X-DEAD for kit-source tests. */
function addDeadSource(c: ReleaseContent): void {
  const any = c.sources[0];
  if (!any) throw new Error("fixture has no sources");
  c.sources.push({ ...any, id: "X-DEAD", released: false });
}

function refusal(build: () => unknown): DomainError {
  try {
    build();
  } catch (e) {
    if (e instanceof DomainError) return e;
    throw e;
  }
  throw new Error("expected a DomainError");
}

describe("positional order and honest counts (DOM-20, DOM-21)", () => {
  const inputs = [
    record("BIN:R-02", "BIN_DOOR"),
    record("SEAT:10A", "CUSHION"),
    KIT_PRIMARY,
    record("SEAT:2C", "BACKREST"),
    record("BIN:L-01", "BIN_DOOR"),
    record("SEAT:2A", "CUSHION"),
    record("SEAT:2C", "CUSHION"),
  ];

  it("work items are ordered by physical position regardless of insertion order", () => {
    const report = buildReport(visitWith(snapshotFor(fixtureRelease(), "N100TL", "2026-11-12"), inputs), "DRAFT_PREVIEW", AT);
    expect(report.work.map((w) => `${w.locationId}/${w.componentId}`)).toEqual([
      "SEAT:2A/CUSHION",
      "SEAT:2C/BACKREST",
      "SEAT:2C/CUSHION",
      "SEAT:10A/CUSHION",
      "FLOOR:FULL-CABIN/CARPET_KIT",
      "BIN:L-01/BIN_DOOR",
      "BIN:R-02/BIN_DOOR",
    ]);
    expect(report.work.map((w) => w.locationKind)).toEqual(["SEAT", "SEAT", "SEAT", "SEAT", "FLOOR", "BIN", "BIN"]);
  });

  it("buildReport is deterministic under shuffled record order", () => {
    const visit = visitWith(snapshotFor(fixtureRelease(), "N100TL", "2026-11-12"), inputs);
    const expected = JSON.stringify(buildReport(visit, "DRAFT_PREVIEW", AT));
    let seed = 7;
    for (let round = 0; round < 10; round++) {
      const records = [...visit.records];
      for (let i = records.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        const j = seed % (i + 1);
        [records[i], records[j]] = [records[j]!, records[i]!];
      }
      expect(JSON.stringify(buildReport({ ...visit, records }, "DRAFT_PREVIEW", AT))).toBe(expected);
    }
  });

  it("gap locations list SEAT:2A before SEAT:10A", () => {
    const rel = withCushionRules([cushionRule("X-OLD", "P-OLD", { variant: ["V01"] }, { kind: "SEAT" }, { effectiveTo: "2025-12-31" })]);
    const snap = snapshotFor(rel, "N100TL", "2026-11-12");
    const gap = buildReport(visitWith(snap, []), "DRAFT_PREVIEW", AT).gaps.find((g) => g.componentId === "CUSHION");
    if (!gap) throw new Error("expected a cushion gap");
    const ids = gap.locationIds;
    expect(ids.indexOf("SEAT:2A")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("SEAT:2A")).toBeLessThan(ids.indexOf("SEAT:10A"));
    const seats = snap.context.layoutRevision.locations.filter((l) => l.kind === "SEAT");
    const physical = [...seats].sort((a, b) => a.seat!.physicalRow - b.seat!.physicalRow || (a.seat!.letter < b.seat!.letter ? -1 : 1)).map((l) => l.id);
    expect(ids).toEqual(physical);
  });

  it("the same part as primary at one location and mandatory child at another merges into one total with both roles", () => {
    // FAKE-P-39 (PANEL) is a mandatory child of the FAKE-CK-2000 alternate kit; make it the cushion primary too
    const rel = withCushionRules([cushionRule("X-P39", "FAKE-P-39", { variant: ["V01"] }, { kind: "SEAT" }, { unit: "PANEL" })]);
    const report = buildReport(visitWith(snapshotFor(rel, "N100TL", "2026-11-12"), [CUSHION_3A, KIT_ALTERNATE]), "DRAFT_PREVIEW", AT);
    const p39 = report.totals.filter((t) => t.partNo === "FAKE-P-39");
    expect(p39).toHaveLength(1);
    expect(p39[0]?.roles).toEqual(["MANDATORY_CHILD", "PRIMARY"]);
    expect(p39[0]?.quantity).toBe(3); // 1 primary at 3A + 2 required with the kit
    expect(p39[0]?.locations.map((l) => [l.locationId, l.role, l.quantity])).toEqual([
      ["SEAT:3A", "PRIMARY", 1],
      ["FLOOR:FULL-CABIN", "MANDATORY_CHILD", 2],
    ]);
  });

  it("counts.replacements sums quantities, not records", () => {
    const rel = fixtureRelease((c) => {
      c.components.find((x) => x.id === "CARPET_KIT")!.maxReplacementsPerLocation = 3;
    });
    const report = buildReport(visitWith(snapshotFor(rel, "N100TL", "2026-11-12"), [CUSHION_3A, { ...KIT_PRIMARY, quantity: 3 }]), "DRAFT_PREVIEW", AT);
    expect(report.counts.workItems).toBe(2);
    expect(report.counts.replacements).toBe(4);
  });

  it("a record whose location is not in the snapshot is SNAPSHOT_INCONSISTENT, never placed first", () => {
    const visit = visitWith(snapshotFor(fixtureRelease(), "N100TL", "2026-11-12"), [CUSHION_3A]);
    const broken: Visit = { ...visit, records: visit.records.map((r) => ({ ...r, locationId: "SEAT:99Z" })) };
    const e = refusal(() => buildReport(broken, "DRAFT_PREVIEW", AT));
    expect(e.code).toBe("SNAPSHOT_INCONSISTENT");
    expect(e.status).toBe(500);
    expect(e.message).toMatch(/SEAT:99Z/);
  });

  it("an unknown location kind is SNAPSHOT_INCONSISTENT", () => {
    const visit = visitWith(snapshotFor(fixtureRelease(), "N100TL", "2026-11-12"), [CUSHION_3A]);
    const snapshot = structuredClone(visit.snapshot);
    const galley = snapshot.context.layoutRevision.locations.find((l) => l.id === "BIN:L-01")!;
    (galley as { kind: string }).kind = "GALLEY";
    const e = refusal(() => buildReport({ ...visit, snapshot }, "DRAFT_PREVIEW", AT));
    expect(e.code).toBe("SNAPSHOT_INCONSISTENT");
    expect(e.message).toMatch(/BIN:L-01 has unknown kind "GALLEY"/);
    expect(refusal(() => buildPreparation(snapshot)).code).toBe("SNAPSHOT_INCONSISTENT");
  });
});

describe("kit-source citations (DOM-16, after D3)", () => {
  it("a gap whose rule is excluded for a dead kit child cites that child's source", () => {
    const rel = fixtureRelease((c) => {
      addDeadSource(c);
      c.kitChildren.push(
        { parentPartNo: "FAKE-CK-2001", childPartNo: "FAKE-P-39", qty: 1, unit: "PANEL", sourceId: "FX-DOC-B" },
        { parentPartNo: "FAKE-P-39", childPartNo: "FAKE-P-40", qty: 1, unit: "PANEL", sourceId: "X-DEAD" },
      );
    });
    const report = buildReport(visitWith(snapshotFor(rel, "N100TL", "2026-11-12"), [CUSHION_3A]), "DRAFT_PREVIEW", AT);
    const gap = report.gaps.find((g) => g.componentId === "CARPET_KIT");
    expect(gap?.sourceIds).toContain("X-DEAD");
    expect(report.sources.map((s) => s.id)).toContain("X-DEAD");
  });

  it("a work item whose passed-over rule has a dead kit child cites that child's source", () => {
    const rel = fixtureRelease((c) => {
      addDeadSource(c);
      c.parts.push({ partNo: "X-PART", namespace: "fixture", description: "X part" }, { partNo: "X-CHILD", namespace: "fixture", description: "X child" });
      c.kitChildren.push({ parentPartNo: "X-PART", childPartNo: "X-CHILD", qty: 1, unit: "EA", sourceId: "X-DEAD" });
      c.rules.push(cushionRule("X-KITBAD", "X-PART", { variant: ["V01"] }, { kind: "SEAT", ids: ["SEAT:3A"] }));
    });
    const report = buildReport(visitWith(snapshotFor(rel, "N100TL", "2026-11-12"), [CUSHION_3A]), "DRAFT_PREVIEW", AT);
    const [item] = report.work;
    expect(item?.excludedRules?.map((e) => e.ruleId)).toEqual(["X-KITBAD"]);
    expect(item?.excludedRules?.[0]?.reasons[0]).toMatchObject({ code: "KIT_SOURCE_INVALID", sourceId: "X-DEAD" });
    expect(report.sources.map((s) => s.id)).toContain("X-DEAD");
  });
});

/** The message of an unresolved component; fails the test when it resolved. */
function messageOf(c: ComponentResolution): string {
  if (c.status === "RESOLVED") throw new Error(`${c.locationId}/${c.componentId} resolved`);
  return c.message;
}

describe("no-match wording for kit-only exclusions", () => {
  it("names the kit problem instead of saying the rule is not valid on the check date", () => {
    const rel = fixtureRelease((c) => {
      addDeadSource(c);
      c.kitChildren.push({ parentPartNo: "FAKE-CK-2001", childPartNo: "FAKE-P-39", qty: 1, unit: "PANEL", sourceId: "X-DEAD" });
    });
    const comp = resolutionAt(lookup(rel, "N100TL", "2026-11-12"), "FLOOR:FULL-CABIN", "CARPET_KIT");
    expect(comp.status).toBe("NO_MATCH");
    expect(messageOf(comp)).toBe(
      "A rule covers this component but the kit data of its part is unusable: a kit child cites a source that is not valid on the check date.",
    );
    expect(messageOf(comp)).not.toMatch(/rule covers this component but is not valid/);
  });

  it("a cyclic kit is named as such", () => {
    const rel = fixtureRelease((c) => {
      c.kitChildren.push(
        { parentPartNo: "FAKE-CK-2001", childPartNo: "FAKE-P-77", qty: 1, unit: "PANEL", sourceId: "FX-DOC-B" },
        { parentPartNo: "FAKE-P-77", childPartNo: "FAKE-CK-2001", qty: 1, unit: "PANEL", sourceId: "FX-DOC-B" },
      );
    });
    const comp = resolutionAt(lookup(rel, "N100TL", "2026-11-12"), "FLOOR:FULL-CABIN", "CARPET_KIT");
    expect(messageOf(comp)).toBe("A rule covers this component but the kit data of its part is unusable: the kit cannot be expanded.");
  });

  it("an exclusion for a date reason keeps the date wording", () => {
    const comp = resolutionAt(lookup(fixtureRelease(), "N090TL", "2026-11-12"), "SEAT:12A", "BACKREST");
    expect(messageOf(comp)).toBe("A rule covers this component but is not valid on the check date.");
  });
});

describe("preparation counts and substitute scope (DOM-17, DOM-21)", () => {
  const substitute = (locations: SubstituteApproval["locations"]): SubstituteApproval => ({
    id: "X-SUB",
    namespace: "fixture",
    componentId: "CUSHION",
    primaryPartNo: "P-ONE",
    altPartNo: "P-ALT",
    qtyPerReplacement: 1,
    unit: "EA",
    constraint: { variant: ["V01"] },
    locations,
    released: true,
    effectiveFrom: "2024-01-01",
    effectiveTo: null,
    sourceId: "FX-DOC-A",
  });
  const twoRules = (sub?: SubstituteApproval) =>
    withCushionRules(
      [
        cushionRule("R-ONE", "P-ONE", { variant: ["V01"] }, { kind: "SEAT", letters: ["A"] }),
        cushionRule("R-TWO", "P-TWO", { variant: ["V01"] }, { kind: "SEAT", letters: ["B", "C", "D", "E", "F"] }),
        cushionRule("R-ONE-AGAIN", "P-ONE", { variant: ["V01"] }, { kind: "SEAT", letters: ["B"] }, { componentId: "BACKREST" }),
      ],
      (c) => {
        c.rules = c.rules.filter((r) => r.id === "R-ONE-AGAIN" || !(r.componentId === "BACKREST" && r.constraint.variant?.includes("V01")));
        c.rules.push(cushionRule("R-BACK", "P-BACK", { variant: ["V01"] }, { kind: "SEAT", letters: ["A", "C", "D", "E", "F"] }, { componentId: "BACKREST" }));
        c.parts.push({ partNo: "P-BACK", namespace: "fixture", description: "P-BACK" }, { partNo: "P-ALT", namespace: "fixture", description: "P-ALT" });
        if (sub) c.substitutes.push(sub);
      },
    );

  it("counts.parts is the number of distinct part numbers", () => {
    const prep = buildPreparation(snapshotFor(twoRules(), "N100TL", "2026-11-12"));
    const lines = prep.lines.filter((l) => l.partNo === "P-ONE");
    expect(lines.map((l) => l.componentId).sort()).toEqual(["BACKREST", "CUSHION"]);
    expect(prep.counts.parts).toBe(new Set(prep.lines.map((l) => l.partNo)).size);
    expect(prep.counts.parts).toBe(prep.lines.length - 1);
  });

  it("a substitute whose scope never meets the rule's locations is not attached", () => {
    const outside = lookup(twoRules(substitute({ kind: "SEAT", letters: ["B"] })), "N100TL", "2026-11-12");
    const rule = entry(outside.resolution!.rules, "R-ONE");
    expect(rule.substitutes).toEqual([]);
    expect(rule.excludedSubstitutes).toEqual([]);
    const prep = buildPreparation(snapshotFor(twoRules(substitute({ kind: "SEAT", letters: ["B"] })), "N100TL", "2026-11-12"));
    expect(prep.counts.alternates).toBe(buildPreparation(snapshotFor(twoRules(), "N100TL", "2026-11-12")).counts.alternates);
    expect(prep.lines.find((l) => l.ruleId === "R-ONE")?.alternates).toEqual([]);
    // scope that meets the rule at some seats attaches it there
    const meeting = lookup(twoRules(substitute({ kind: "SEAT", letters: ["A", "B"] })), "N100TL", "2026-11-12");
    const attached = entry(meeting.resolution!.rules, "R-ONE").substitutes;
    expect(attached.map((s) => s.id)).toEqual(["X-SUB"]);
  });
});
