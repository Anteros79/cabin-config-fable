import { describe, expect, it } from "vitest";
import type { CabinLocation, CarriedObservation, Condition, MelClass, Observation, VisitRecord } from "../../src/domain/types.ts";
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
  observations: [],
  carried: [],
  checkDate: "2026-11-12",
  mel: snap.mel ?? [],
  variantId: snap.context.variant.id,
});

const COSMETIC: MelClass = { class: "COSMETIC" };
const MEL_C: MelClass = { class: "MEL", item: "FX-25-21-01", category: "C", intervalDays: 10, conditions: "Seat blocked and placarded INOP" };

const observation = (locationId: string, componentId: string, over: Partial<Observation> = {}): Observation => ({
  id: `OBS-${locationId}-${componentId}`,
  tail: "N100TL",
  status: "OPEN",
  version: 1,
  melClass: COSMETIC,
  dueDate: null,
  blocksSeat: false,
  openedInVisitId: "visit-1",
  closedInVisitId: null,
  closedAs: null,
  locationLabel: locationId,
  componentName: componentId,
  createdAt: "2026-11-12T12:02:00.000Z",
  updatedAt: "2026-11-12T12:02:00.000Z",
  locationId,
  componentId,
  condition: "STAINED" as Condition,
  note: "",
  outcome: "NOTED",
  ...over,
});

const carriedAt = (o: Observation, locationId: string = o.locationId, overdue = false): CarriedObservation => ({
  observation: o,
  placement: "SAME",
  locationId,
  overdue,
});

const withProblems = (observations: Observation[] = [], carried: CarriedObservation[] = []): Workspace => ({ ...workspace(), observations, carried });
const pieceStatus = (ws: Workspace, locationId: string, componentId: string) =>
  componentsAt(ws, location(locationId)).find((v) => v.componentId === componentId)?.pieceStatus;

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

  it("a location shows an unresolved component first, then a record, then an alternate", () => {
    expect(aggregateStatus([])).toBe("none");
    expect(aggregateStatus(["alternate", "none"])).toBe("alternate");
    expect(aggregateStatus(["alternate", "unresolved"])).toBe("unresolved");
    expect(aggregateStatus(["alternate", "recorded"])).toBe("recorded");
    expect(aggregateStatus(["unresolved", "recorded", "alternate"])).toBe("unresolved");
    expect(aggregateStatus(["recorded", "unresolved"])).toBe("unresolved");
  });

  it("a seat with one component recorded and another unresolved still needs attention: it shows unresolved", () => {
    const ws = workspace([recordAt("SEAT:3A", "CUSHION")]);
    ws.resolution = {
      ...snap.resolution,
      components: snap.resolution.components.map((c) =>
        c.locationId === "SEAT:3A" && c.componentId === "BACKREST"
          ? { locationId: c.locationId, componentId: c.componentId, status: "NO_MATCH" as const, message: "none", excluded: [] }
          : c,
      ),
    };
    const { scene, flags } = buildStates(ws);
    expect(scene.get("SEAT:3A")?.components).toEqual({ CUSHION: "recorded", BACKREST: "unresolved" });
    expect(flags.get("SEAT:3A")).toMatchObject({ recorded: 1, unresolved: 1, status: "unresolved" });
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
    expect(seatLabelFor(loc, { recorded: 1, unresolved: 1, resolved: 0, alternate: 0, status: "unresolved" })).toBe(
      `${loc.label}, 1 replacement recorded, 1 component unresolved`,
    );
    expect(seatLabelFor(loc, { recorded: 2, unresolved: 3, resolved: 0, alternate: 0, status: "unresolved" })).toBe(
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

describe("piece status from problems", () => {
  it("rank: mustFix beats unresolved beats deferred beats carried beats noted beats recorded beats alternate", () => {
    const order = ["mustFix", "unresolved", "deferred", "carried", "noted", "recorded", "alternate", "none"] as const;
    for (const [i, high] of order.entries()) {
      for (const low of order.slice(i + 1)) {
        expect(aggregateStatus([low, high]), `${high} over ${low}`).toBe(high);
        expect(aggregateStatus([high, low]), `${high} over ${low}`).toBe(high);
      }
    }
  });

  it("a piece with a record and an open NOTED problem is noted", () => {
    const ws = { ...withProblems([observation("SEAT:3A", "CUSHION")]), records: [recordAt("SEAT:3A", "CUSHION")] };
    expect(pieceStatus(ws, "SEAT:3A", "CUSHION")).toBe("noted");
    expect(buildStates(ws).scene.get("SEAT:3A")?.components.CUSHION).toBe("noted");
    expect(buildStates(ws).flags.get("SEAT:3A")?.status).toBe("noted");
  });

  it("a closed problem changes nothing", () => {
    const ws = withProblems([observation("SEAT:3A", "CUSHION", { status: "CLOSED", closedAs: "FIXED" })]);
    expect(pieceStatus(ws, "SEAT:3A", "CUSHION")).not.toBe("noted");
  });

  it("an open deferral opened in this visit is deferred; one carried from an earlier visit is carried", () => {
    const deferral = observation("SEAT:3A", "CUSHION", { outcome: "DEFERRED", deferUntil: "NEXT_CHECK", reason: "NO_STOCK" });
    expect(pieceStatus(withProblems([deferral]), "SEAT:3A", "CUSHION")).toBe("deferred");
    const earlier = { ...deferral, openedInVisitId: "visit-0" };
    const ws = withProblems([], [carriedAt(earlier)]);
    expect(pieceStatus(ws, "SEAT:3A", "CUSHION")).toBe("carried");
    expect(componentsAt(ws, location("SEAT:3A")).find((v) => v.componentId === "CUSHION")?.carried?.observation).toBe(earlier);
    expect(buildStates(ws).scene.get("SEAT:3A")?.components.CUSHION).toBe("carried");
  });

  it("a must-fix outcome makes the piece mustFix over a record and a deferral", () => {
    const ws = {
      ...withProblems([
        observation("SEAT:3A", "CUSHION", { outcome: "MUST_FIX", melClass: MEL_C }),
        observation("SEAT:3A", "CUSHION", { id: "OBS-2", outcome: "DEFERRED", condition: "TORN" }),
      ]),
      records: [recordAt("SEAT:3A", "CUSHION")],
    };
    expect(pieceStatus(ws, "SEAT:3A", "CUSHION")).toBe("mustFix");
  });

  it("an overdue carried MEL deferral is mustFix on the visit's checkDate", () => {
    const deferral = observation("SEAT:3A", "SEATBELT", {
      condition: "BROKEN",
      outcome: "DEFERRED",
      deferUntil: "NEXT_CHECK",
      reason: "NO_STOCK",
      melClass: MEL_C,
      dueDate: "2026-11-11",
      openedInVisitId: "visit-0",
    });
    expect(pieceStatus(withProblems([], [carriedAt(deferral, "SEAT:3A", true)]), "SEAT:3A", "SEATBELT")).toBe("mustFix");
    const notDue = { ...deferral, dueDate: "2026-11-12" };
    expect(pieceStatus(withProblems([], [carriedAt(notDue)]), "SEAT:3A", "SEATBELT")).toBe("carried");
  });

  it("a carried problem placed on another location marks that location's piece", () => {
    const o = observation("BIN:L-04", "CUSHION", { outcome: "MUST_FIX", melClass: MEL_C });
    const ws = withProblems([], [{ observation: o, placement: "MAPPED", locationId: "SEAT:3A", overdue: false }]);
    expect(pieceStatus(ws, "SEAT:3A", "CUSHION")).toBe("mustFix");
  });

  it("an orphaned carried problem adds no piece status", () => {
    const o = observation("SEAT:99Z", "CUSHION", { outcome: "MUST_FIX" });
    const ws = withProblems([], [{ observation: o, placement: "ORPHANED", locationId: null, overdue: false }]);
    expect(buildStates(ws).scene).toEqual(buildStates(workspace()).scene);
  });

  it("melClass reads the frozen MEL and the seat-blocked state", () => {
    const vest = (ws: Workspace) => componentsAt(ws, location("SEAT:3A")).find((v) => v.componentId === "LIFE_VEST");
    expect(vest(workspace())?.melClass("MISSING").class).toBe("NO_GO");
    const belt = observation("SEAT:3A", "SEATBELT", { condition: "BROKEN", outcome: "DEFERRED", melClass: MEL_C, dueDate: "2026-11-22", blocksSeat: true });
    expect(vest(withProblems([belt]))?.melClass("MISSING").class).toBe("MEL");
    expect(vest(withProblems([], [carriedAt({ ...belt, openedInVisitId: "visit-0" })]))?.melClass("MISSING").class).toBe("MEL");
  });

  it("a stored class is a floor: an overdue open MEL deferral is NO_GO even when classified lower", () => {
    const deferral = observation("SEAT:3A", "SEATBELT", { condition: "WORN", outcome: "DEFERRED", melClass: MEL_C, dueDate: "2026-11-01" });
    expect(pieceStatus(withProblems([deferral]), "SEAT:3A", "SEATBELT")).toBe("mustFix");
  });

  it("a blocked seat appears in flags.blocked", () => {
    expect(buildStates(workspace()).flags.blocked.size).toBe(0);
    const belt = observation("SEAT:3A", "SEATBELT", { condition: "BROKEN", outcome: "DEFERRED", melClass: MEL_C, dueDate: "2026-11-22", blocksSeat: true });
    expect([...buildStates(withProblems([belt])).flags.blocked]).toEqual(["SEAT:3A"]);
    expect([...buildStates(withProblems([], [carriedAt({ ...belt, openedInVisitId: "visit-0" })])).flags.blocked]).toEqual(["SEAT:3A"]);
    const notBlocking = { ...belt, blocksSeat: false };
    expect(buildStates(withProblems([notBlocking])).flags.blocked.size).toBe(0);
  });
});
