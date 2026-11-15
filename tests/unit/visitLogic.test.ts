import { describe, expect, it } from "vitest";
import { expandKit, KitError } from "../../src/domain/kits.ts";
import { buildPreparation } from "../../src/domain/prep.ts";
import { buildReport } from "../../src/domain/report.ts";
import { lookup } from "../../src/domain/resolve.ts";
import { summarizeLocations } from "../../src/domain/summarize.ts";
import type { KitChild, Part, Visit, VisitRecord, VisitSnapshot } from "../../src/domain/types.ts";
import { buildSnapshot, deriveRecord, DomainError } from "../../src/domain/visitLogic.ts";
import { CUSHION_3A, fixtureRelease, KIT_ALTERNATE, KIT_PRIMARY, SIX_LINE_TOTALS, snapshotFor } from "../helpers.ts";

const release = fixtureRelease();
const snapshot = snapshotFor(release, "N100TL", "2026-11-12");

function visitWith(snap: VisitSnapshot, inputs: unknown[]): Visit {
  const records: VisitRecord[] = inputs.map((input) => ({ ...deriveRecord(snap, input), version: 1, createdAt: "2026-11-12T12:01:00.000Z", updatedAt: "2026-11-12T12:01:00.000Z" }));
  return {
    id: "visit-1", number: 1, tail: snap.tail, checkDate: snap.checkDate, technician: "Demo", status: "DRAFT", version: 1 + records.length,
    createdAt: "2026-11-12T12:00:00.000Z", updatedAt: "2026-11-12T12:01:00.000Z", completedAt: null, recordCount: records.length,
    referenceReleaseId: snap.referenceReleaseId, lookupState: snap.lookupState, variantId: snap.context.variant.id, layoutRevisionId: snap.context.layoutRevision.id,
    snapshot: snap, snapshotSha256: "test", records, events: [],
  };
}
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof DomainError ? e.code : `other:${(e as Error).message}`;
  }
  return "no-error";
};

describe("primary and alternate selections", () => {
  it("one 3A cushion and one full-cabin alternate kit give exactly the six mandated part/unit totals", () => {
    const report = buildReport(visitWith(snapshot, [CUSHION_3A, KIT_ALTERNATE]), "DRAFT_PREVIEW", "2026-11-12T12:02:00.000Z");
    expect(report.totals.map((t) => [t.partNo, t.quantity, t.unit])).toEqual(SIX_LINE_TOTALS.map((x) => [...x]));
    expect(report.totals.some((t) => t.partNo === "FAKE-CK-2001")).toBe(false);
    expect(report.counts).toMatchObject({ workItems: 2, replacements: 2, totalLines: 6 });
    const kit = report.work.find((w) => w.componentId === "CARPET_KIT")!;
    expect(kit).toMatchObject({ selection: "ALTERNATE", primaryPartNo: "FAKE-CK-2001", selectedPartNo: "FAKE-CK-2000", locationId: "FLOOR:FULL-CABIN" });
    expect(kit.lines.filter((l) => l.role === "MANDATORY_CHILD").every((l) => l.parentPartNo === "FAKE-CK-2000" && l.sourceId === "FX-DOC-DEV")).toBe(true);
    // traceability: every total line lists its location
    expect(report.totals.find((t) => t.partNo === "FAKE-P-39")!.locations).toEqual([
      { locationId: "FLOOR:FULL-CABIN", locationLabel: "Full cabin floor (fictional carpet-kit scope)", componentId: "CARPET_KIT", quantity: 2, role: "MANDATORY_CHILD" },
    ]);
  });

  it("the primary selection carries only the primary part", () => {
    const record = deriveRecord(snapshot, KIT_PRIMARY);
    expect(record.lines.map((l) => [l.partNo, l.qty, l.unit, l.role])).toEqual([["FAKE-CK-2001", 1, "KIT", "PRIMARY"]]);
  });

  it("quantities scale the main line and every mandatory child", () => {
    const rel = fixtureRelease((c) => (c.components.find((x) => x.id === "CARPET_KIT")!.maxReplacementsPerLocation = 3));
    const snap = snapshotFor(rel, "N100TL", "2026-11-12");
    const record = deriveRecord(snap, { ...KIT_ALTERNATE, quantity: 3 });
    expect(record.lines.map((l) => [l.partNo, l.qty])).toEqual([["FAKE-CK-2000", 3], ["FAKE-P-39", 6], ["FAKE-P-40", 6], ["FAKE-P-41", 3], ["FAKE-P-42", 3]]);
    const panel = deriveRecord(snapshot, { locationId: "FLOOR:FWD", componentId: "CARPET_PANEL", selection: "PRIMARY", substituteId: null, quantity: 4, note: "" });
    expect(panel.lines).toMatchObject([{ partNo: "FAKE-V01-FWD-PANEL", qty: 4, unit: "PANEL" }]);
  });

  it("totals are grouped by part AND unit", () => {
    const rel = fixtureRelease((c) => {
      c.kitChildren.push({ parentPartNo: "FAKE-CK-2000", childPartNo: "FAKE-SC-1001", qty: 3, unit: "PANEL", sourceId: "FX-DOC-DEV" });
    });
    const snap = snapshotFor(rel, "N100TL", "2026-11-12");
    const report = buildReport(visitWith(snap, [CUSHION_3A, KIT_ALTERNATE]), "DRAFT_PREVIEW", "2026-11-12T12:02:00.000Z");
    expect(report.totals.filter((t) => t.partNo === "FAKE-SC-1001").map((t) => [t.quantity, t.unit])).toEqual([[1, "EA"], [3, "PANEL"]]);
  });

  it("nested kits are expanded with multiplied quantities and cycles are refused", () => {
    const parts = new Map<string, Part>(["K", "A", "B", "C"].map((p) => [p, { partNo: p, namespace: "fixture", description: p }]));
    const by = (list: KitChild[]) => {
      const m = new Map<string, KitChild[]>();
      for (const k of list) m.set(k.parentPartNo, [...(m.get(k.parentPartNo) ?? []), k]);
      return m;
    };
    const k = (parentPartNo: string, childPartNo: string, qty: number): KitChild => ({ parentPartNo, childPartNo, qty, unit: "EA", sourceId: "S" });
    expect(expandKit("K", by([k("K", "A", 2), k("A", "B", 3), k("K", "B", 1)]), parts).map((c) => [c.partNo, c.qty])).toEqual([["A", 2], ["B", 7]]);
    expect(() => expandKit("K", by([k("K", "A", 1), k("A", "K", 1)]), parts)).toThrow(KitError);
  });
});

describe("authoritative record validation", () => {
  it("rejects forged or unknown locations, components and rules", () => {
    expect(code(() => deriveRecord(snapshot, { ...CUSHION_3A, locationId: "SEAT:14B" }))).toBe("UNKNOWN_LOCATION"); // omitted seat
    expect(code(() => deriveRecord(snapshot, { ...CUSHION_3A, locationId: "SEAT:99Z" }))).toBe("UNKNOWN_LOCATION");
    expect(code(() => deriveRecord(snapshot, { ...CUSHION_3A, componentId: "BIN_DOOR" }))).toBe("INCOMPATIBLE_COMPONENT");
    expect(code(() => deriveRecord(snapshot, { ...CUSHION_3A, componentId: "CARPET_KIT" }))).toBe("INCOMPATIBLE_COMPONENT");
    expect(code(() => deriveRecord(snapshot, { ...CUSHION_3A, ruleId: "FX-R-V02-ELR-A-CUSHION" }))).toBe("RULE_NOT_APPLICABLE");
    expect(code(() => deriveRecord(snapshot, { ...CUSHION_3A, partNo: "FAKE-SC-1002" }))).toBe("PART_MISMATCH");
    expect(code(() => deriveRecord(snapshot, { ...CUSHION_3A, unit: "KIT" }))).toBe("UNIT_MISMATCH");
  });
  it("rejects forged or misapplied alternates", () => {
    expect(code(() => deriveRecord(snapshot, { ...KIT_ALTERNATE, substituteId: "NOPE" }))).toBe("SUBSTITUTE_NOT_APPROVED");
    expect(code(() => deriveRecord(snapshot, { ...KIT_ALTERNATE, substituteId: null }))).toBe("INVALID_SUBSTITUTE");
    expect(code(() => deriveRecord(snapshot, { ...KIT_PRIMARY, substituteId: "FX-SUB-KIT-1" }))).toBe("INVALID_SUBSTITUTE");
    expect(code(() => deriveRecord(snapshot, { ...CUSHION_3A, selection: "ALTERNATE", substituteId: "FX-SUB-KIT-1" }))).toBe("SUBSTITUTE_NOT_APPROVED");
    const expired = snapshotFor(release, "N100TL", "2027-01-01");
    expect(code(() => deriveRecord(expired, KIT_ALTERNATE))).toBe("SUBSTITUTE_NOT_APPROVED");
    expect(deriveRecord(snapshotFor(release, "N100TL", "2026-12-31"), KIT_ALTERNATE).lines).toHaveLength(5);
  });
  it("rejects invalid quantities and types", () => {
    for (const quantity of [0, -1, 2, 1.5, "1", null, Number.NaN]) {
      expect(code(() => deriveRecord(snapshot, { ...CUSHION_3A, quantity }))).toBe("INVALID_QUANTITY");
    }
    expect(code(() => deriveRecord(snapshot, { ...KIT_ALTERNATE, quantity: 7 }))).toBe("INVALID_QUANTITY");
    expect(code(() => deriveRecord(snapshot, { locationId: "BIN:L-01", componentId: "BIN_DOOR", selection: "PRIMARY", quantity: 100 }))).toBe("INVALID_QUANTITY");
    expect(code(() => deriveRecord(snapshot, { ...CUSHION_3A, selection: "BOTH" }))).toBe("INVALID_SELECTION");
    expect(code(() => deriveRecord(snapshot, { ...CUSHION_3A, note: "x".repeat(1001) }))).toBe("INVALID_NOTE");
    expect(code(() => deriveRecord(snapshot, [CUSHION_3A]))).toBe("INVALID_RECORD");
    expect(code(() => deriveRecord(snapshot, null))).toBe("INVALID_RECORD");
  });
  it("refuses client-supplied part lines and totals", () => {
    expect(code(() => deriveRecord(snapshot, { ...CUSHION_3A, lines: [{ partNo: "FAKE-SC-1001", qty: 50 }] }))).toBe("UNSUPPORTED_FIELD");
    expect(code(() => deriveRecord(snapshot, { ...CUSHION_3A, totals: [] }))).toBe("UNSUPPORTED_FIELD");
  });
  it("only resolved components can be recorded; gaps stay in the report", () => {
    const partial = snapshotFor(release, "N090TL", "2026-11-12");
    expect(code(() => deriveRecord(partial, { locationId: "BIN:L-01", componentId: "BIN_DOOR", selection: "PRIMARY", quantity: 1 }))).toBe("UNRESOLVED_COMPONENT");
    expect(code(() => deriveRecord(partial, { locationId: "FLOOR:FWD", componentId: "CARPET_PANEL", selection: "PRIMARY", quantity: 1 }))).toBe("UNRESOLVED_COMPONENT");
    const ok = { locationId: "SEAT:3A", componentId: "CUSHION", selection: "PRIMARY", quantity: 1 };
    const report = buildReport(visitWith(partial, [ok]), "DRAFT_PREVIEW", "2026-11-12T12:02:00.000Z");
    expect(report.counts.unresolvedComponents).toBe(24);
    expect(report.gaps.map((g) => [g.componentId, g.status, g.locationIds.length])).toEqual([
      ["BACKREST", "NO_MATCH", 6],
      ["BIN_DOOR", "NO_MATCH", 16],
      ["CARPET_PANEL", "AMBIGUOUS", 1],
      ["CARPET_PANEL", "NO_MATCH", 1],
    ]);
  });
  it("a visit cannot be built from an unresolved lookup", () => {
    for (const [tail, date] of [["N000TL", "2026-11-12"], ["N400TL", "2026-09-15"], ["N110TL", "2026-11-12"], ["N999ZZ", "2026-11-12"], ["N600TL", "2026-03-01"]]) {
      expect(code(() => buildSnapshot(release, lookup(release, tail, date), "now"))).toBe("CONFIGURATION_NOT_RESOLVED");
    }
  });
});

describe("snapshot", () => {
  it("is self-contained and unaffected by later changes to the release object", () => {
    const rel = fixtureRelease();
    const snap = snapshotFor(rel, "N100TL", "2026-11-12");
    const before = JSON.stringify(snap);
    rel.rules.length = 0;
    rel.layoutRevisions.forEach((r) => (r.locations.length = 0));
    rel.substitutes.length = 0;
    expect(JSON.stringify(snap)).toBe(before);
    expect(deriveRecord(snap, KIT_ALTERNATE).lines).toHaveLength(5);
    expect(snap.context.layoutRevision.locations.filter((l) => l.kind === "SEAT")).toHaveLength(176);
    expect(snap).toMatchObject({ schema: "cabin-kit.snapshot/1", lookupState: "RESOLVED", geometryVersion: "cabin-kit.geometry/1" });
    expect(snap.context.assignment).toMatchObject({ carpet: "MOHAWK", seam: "PRE", effectiveFrom: "2025-10-01" });
  });
});

describe("preparation overview", () => {
  const prep = buildPreparation(snapshot);
  it("lists each applicable primary part with coverage, source and validity", () => {
    const cushion = prep.lines.find((l) => l.partNo === "FAKE-SC-1001")!;
    expect(cushion).toMatchObject({ componentId: "CUSHION", qtyPerReplacement: 1, unit: "EA", coverageCount: 5, ruleEffectiveFrom: "2024-01-01" });
    expect(cushion.coverageLocationIds).toEqual(["SEAT:1A", "SEAT:2A", "SEAT:3A", "SEAT:4A", "SEAT:5A"]);
    expect(cushion.coverageSummary).toBe("Seat A rows 1-5 (5 locations)");
    expect(cushion.source).toMatchObject({ id: "FX-DOC-A", revision: "A" });
    expect(prep.counts.resolvedComponents).toBe(376);
    expect(prep.note).toMatch(/not replacements made/);
  });
  it("keeps alternates and their required supplements separate from the primary", () => {
    const kit = prep.lines.find((l) => l.partNo === "FAKE-CK-2001")!;
    expect(kit.alternates).toHaveLength(1);
    expect(kit.alternates[0]).toMatchObject({ altPartNo: "FAKE-CK-2000", qtyPerReplacement: 1, unit: "KIT", effectiveTo: "2026-12-31" });
    expect(kit.alternates[0].requiredSupplements.map((s) => [s.partNo, s.qty, s.unit])).toEqual([["FAKE-P-39", 2, "PANEL"], ["FAKE-P-40", 2, "PANEL"], ["FAKE-P-41", 1, "PANEL"], ["FAKE-P-42", 1, "PANEL"]]);
    expect(prep.lines.some((l) => l.partNo === "FAKE-CK-2000")).toBe(false);
  });
  it("shows pending changes, excluded alternates and gaps", () => {
    const v04 = buildPreparation(snapshotFor(release, "N200TL", "2026-07-01"));
    expect(v04.lines.find((l) => l.partNo === "FAKE-CK-2002")!.pendingChanges).toHaveLength(1);
    const late = buildPreparation(snapshotFor(release, "N100TL", "2027-01-01"));
    const kit = late.lines.find((l) => l.partNo === "FAKE-CK-2001")!;
    expect(kit.alternates).toEqual([]);
    expect(kit.excludedAlternates[0].altPartNo).toBe("FAKE-CK-2000");
    const partial = buildPreparation(snapshotFor(release, "N090TL", "2026-11-12"));
    expect(partial.counts.unresolvedComponents).toBe(24);
    expect(partial.gaps.find((g) => g.componentId === "BIN_DOOR")!.locationIds).toHaveLength(16);
  });
});

describe("location summaries", () => {
  it("compresses rows and merges letters with the same rows", () => {
    const locs = snapshot.context.layoutRevision.locations;
    const pick = (ids: string[]) => locs.filter((l) => ids.includes(l.id));
    expect(summarizeLocations(pick(["SEAT:1A", "SEAT:2A", "SEAT:4A"]))).toBe("Seat A rows 1-2, 4 (3 locations)");
    expect(summarizeLocations(pick(["SEAT:1A", "SEAT:1B"]))).toBe("Seats A/B row 1 (2 locations)");
    expect(summarizeLocations(pick(["BIN:L-01"]))).toBe("Overhead bin L-01 (rows 1-3) (1 location)");
  });
});
