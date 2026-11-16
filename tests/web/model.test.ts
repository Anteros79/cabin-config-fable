import { describe, expect, it } from "vitest";
import type { CabinLocation, VisitRecord } from "../../src/domain/types.ts";
import { aggregateStatus, buildStates, componentsAt, describeSeat, seatLabelFor, type Workspace } from "../../src/web/model.ts";
import { at, fixtureRelease, snapshotFor } from "../helpers.ts";

const snap = snapshotFor(fixtureRelease(), "N100TL", "2026-11-12");
const layout = snap.context.layoutRevision;
const location = (id: string): CabinLocation => {
  const found = layout.locations.find((l) => l.id === id);
  if (!found) throw new Error(`fixture has no location ${id}`);
  return found;
};

const recordAt = (locationId: string, componentId: string): VisitRecord => ({
  locationId,
  componentId,
  selection: "PRIMARY",
  substituteId: null,
  quantity: 1,
  note: "",
  version: 1,
  ruleId: "R",
  primaryPartNo: "P",
  locationLabel: locationId,
  componentName: componentId,
  lines: [],
  createdAt: "2026-11-12T12:01:00.000Z",
  updatedAt: "2026-11-12T12:01:00.000Z",
});

const workspace = (records: Workspace["records"] = []): Workspace => ({
  mode: "visit",
  layout,
  resolution: snap.resolution,
  componentDefs: snap.resolution.componentDefs,
  records,
  editable: true,
  unresolvedReason: null,
});

describe("componentsAt", () => {
  it("lists each component of a seat with its resolution, rule and no record", () => {
    const views = componentsAt(workspace(), location("SEAT:3A"));
    expect(views.map((v) => v.componentId)).toEqual(location("SEAT:3A").componentIds);
    const cushion = views.find((v) => v.componentId === "CUSHION");
    expect(cushion?.status).toBe("RESOLVED");
    expect(cushion?.rule).not.toBeNull();
    expect(cushion?.record).toBeNull();
    expect(cushion?.name).toBe(snap.resolution.componentDefs.CUSHION?.name);
  });

  it("attaches the record for the location and component", () => {
    const record = recordAt("SEAT:3A", "CUSHION");
    const cushion = componentsAt(workspace([record]), location("SEAT:3A")).find((v) => v.componentId === "CUSHION");
    expect(cushion?.record).toBe(record);
  });

  it("without a resolution every component is not supplied", () => {
    const ws: Workspace = { ...workspace(), resolution: null, componentDefs: {} };
    const views = componentsAt(ws, location("SEAT:3A"));
    expect(views.every((v) => v.status === "NOT_SUPPLIED" && v.rule === null)).toBe(true);
    expect(views.every((v) => v.name === v.componentId && v.maxReplacements === 1)).toBe(true);
  });
});

describe("buildStates", () => {
  it("counts resolved components per location and marks none as recorded", () => {
    const { scene, flags } = buildStates(workspace());
    const f = flags.get("SEAT:3A");
    expect(f).toMatchObject({ recorded: 0, unresolved: 0 });
    expect(f?.resolved).toBeGreaterThan(0);
    expect(scene.get("SEAT:3A")?.components).toEqual({});
  });

  it("a record marks its component as recorded", () => {
    const record = recordAt("SEAT:3A", "CUSHION");
    const { scene, flags } = buildStates(workspace([record]));
    expect(scene.get("SEAT:3A")?.components.CUSHION).toBe("recorded");
    expect(flags.get("SEAT:3A")?.recorded).toBe(1);
  });

  it("an unresolved component is marked unresolved and a record overrides it", () => {
    const first = at(snap.resolution.components, 0);
    const ws = workspace();
    ws.resolution = {
      ...snap.resolution,
      components: [{ locationId: first.locationId, componentId: first.componentId, status: "NO_MATCH", message: "none", excluded: [] }],
    };
    expect(buildStates(ws).scene.get(first.locationId)?.components[first.componentId]).toBe("unresolved");
    expect(buildStates(ws).flags.get(first.locationId)?.unresolved).toBe(1);
    ws.records = [recordAt(first.locationId, first.componentId)];
    expect(buildStates(ws).scene.get(first.locationId)?.components[first.componentId]).toBe("recorded");
  });

  it("a resolved component with an alternate eligible at the location shows 'alternate' until a record is made (PF-15)", () => {
    const withAlternate = snap.resolution.components.find((c) => {
      if (c.status !== "RESOLVED") return false;
      const rule = snap.resolution.rules[c.ruleId];
      return rule?.substitutes.some((s) => s.locationIds === null || s.locationIds.includes(c.locationId));
    });
    if (!withAlternate) throw new Error("fixture has no component with an alternate");
    const { locationId, componentId } = withAlternate;
    const before = buildStates(workspace());
    expect(before.scene.get(locationId)?.components[componentId]).toBe("alternate");
    expect(before.flags.get(locationId)).toMatchObject({ alternate: 1, status: "alternate" });
    const after = buildStates(workspace([recordAt(locationId, componentId)]));
    expect(after.scene.get(locationId)?.components[componentId]).toBe("recorded");
    expect(after.flags.get(locationId)).toMatchObject({ alternate: 0, status: "recorded" });
  });

  it("an alternate limited to other locations does not count here", () => {
    const resolved = snap.resolution.components.find((c) => c.status === "RESOLVED" && c.locationId === "SEAT:3A");
    if (resolved?.status !== "RESOLVED") throw new Error("fixture has no resolved component at 3A");
    const rule = snap.resolution.rules[resolved.ruleId];
    if (!rule) throw new Error(`fixture has no rule ${resolved.ruleId}`);
    const substitute = {
      id: "SUB-X",
      altPartNo: "FAKE-ALT",
      altDescription: "fictional alternate",
      qtyPerReplacement: 1,
      unit: "EA",
      effectiveFrom: "2020-01-01",
      effectiveTo: null,
      sourceId: rule.sourceId,
      children: [],
    };
    const ws = workspace();
    const withSub = (locationIds: string[] | null) => ({
      ...snap.resolution,
      rules: { ...snap.resolution.rules, [rule.id]: { ...rule, substitutes: [{ ...substitute, locationIds }] } },
    });
    ws.resolution = withSub(["SEAT:9F"]);
    expect(buildStates(ws).scene.get("SEAT:3A")?.components[resolved.componentId]).toBeUndefined();
    ws.resolution = withSub(["SEAT:3A"]);
    expect(buildStates(ws).scene.get("SEAT:3A")?.components[resolved.componentId]).toBe("alternate");
  });

  it("a location shows a record first, then an unresolved component, then an alternate", () => {
    expect(aggregateStatus([])).toBe("none");
    expect(aggregateStatus(["alternate", "none"])).toBe("alternate");
    expect(aggregateStatus(["alternate", "unresolved"])).toBe("unresolved");
    expect(aggregateStatus(["unresolved", "recorded", "alternate"])).toBe("recorded");
  });

  it("without a resolution or records there is nothing to show", () => {
    const { scene, flags } = buildStates({ ...workspace(), resolution: null });
    expect(scene.size).toBe(0);
    expect(flags.size).toBe(0);
  });
});

describe("describeSeat", () => {
  it("describes a seat and states when the hardware group is not established", () => {
    const lines = describeSeat(location("SEAT:3A"));
    expect(lines[0]).toMatch(/^Printed row 3, letter A, left \(A-C\) side, physical row/);
    expect(lines.at(-1)).toMatch(/^Hardware group: /);
  });

  it("returns nothing for a location that is not a seat", () => {
    expect(describeSeat(location("FLOOR:FULL-CABIN"))).toEqual([]);
  });
});

describe("seatLabelFor", () => {
  it("is the label alone without flags", () => {
    expect(seatLabelFor(location("FLOOR:FULL-CABIN"), undefined)).toBe(location("FLOOR:FULL-CABIN").label);
  });

  it("appends recorded and unresolved counts with correct plurals", () => {
    const loc = location("FLOOR:FULL-CABIN");
    expect(seatLabelFor(loc, { recorded: 1, unresolved: 1, resolved: 0, alternate: 0, status: "recorded" })).toBe(
      `${loc.label}, 1 replacement recorded, 1 component unresolved`,
    );
    expect(seatLabelFor(loc, { recorded: 2, unresolved: 3, resolved: 0, alternate: 0, status: "recorded" })).toBe(
      `${loc.label}, 2 replacements recorded, 3 components unresolved`,
    );
    expect(seatLabelFor(loc, { recorded: 0, unresolved: 0, resolved: 2, alternate: 1, status: "alternate" })).toBe(
      `${loc.label}, 1 component has an alternate part`,
    );
  });

  it("names the maintenance zone and tier of a seat", () => {
    const base = location("SEAT:3A");
    const loc: CabinLocation = {
      ...base,
      seat: { ...(base.seat as NonNullable<CabinLocation["seat"]>), maintenanceZone: "Z9", commercialTier: "TIER-X" },
    };
    expect(seatLabelFor(loc, undefined)).toBe(`${loc.label}, zone Z9, TIER-X`);
  });
});
