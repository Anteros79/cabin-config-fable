import { describe, expect, it } from "vitest";
import { buildPreparation } from "../../src/domain/prep.ts";
import { buildReport, rulesNotUsedLine } from "../../src/domain/report.ts";
import { REPORT_SCHEMA } from "../../src/domain/types.ts";
import { asRelease, CUSHION_3A, fixtureContent, fixtureRelease, oldShapeSnapshot, snapshotFor, visitWith } from "../helpers.ts";

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
