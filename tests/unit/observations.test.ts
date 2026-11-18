import { describe, expect, it } from "vitest";
import {
  allowedOutcomes,
  binRowsFromLabel,
  classify,
  dueDateFor,
  effectiveClass,
  isOverdue,
  mapCarried,
  melEntryFor,
  seatIsBlocked,
} from "../../src/domain/observations.ts";
import type { CabinLocation, MelClass, Observation } from "../../src/domain/types.ts";
import { stagedFull } from "../helpers.ts";

const mel = stagedFull().content.mel;
const layouts = stagedFull().content.layoutRevisions;
const locationsOf = (id: string): CabinLocation[] => {
  const revision = layouts.find((r) => r.id === id);
  if (!revision) throw new Error(`no layout ${id}`);
  return structuredClone(revision.locations);
};

const MEL_C: MelClass = { class: "MEL", item: "X-1", category: "C", intervalDays: 10, conditions: "c" };

function obs(extra: Partial<Observation> = {}): Observation {
  return {
    id: "O1",
    tail: "N100TL",
    status: "OPEN",
    version: 1,
    locationId: "SEAT:12A",
    componentId: "SEATBELT",
    condition: "BROKEN",
    note: "",
    outcome: "DEFERRED",
    melClass: MEL_C,
    dueDate: "2026-11-28",
    blocksSeat: true,
    openedInVisitId: "V1",
    closedInVisitId: null,
    closedAs: null,
    locationLabel: "Seat 12A",
    componentName: "Seat belt",
    createdAt: "2026-11-18T00:00:00Z",
    updatedAt: "2026-11-18T00:00:00Z",
    ...extra,
  };
}

describe("melEntryFor", () => {
  it("returns null with no entry", () => {
    expect(melEntryFor(mel, "NOPE", "BROKEN", "V01")).toBeNull();
  });
  it("a V09 override wins for TRAY BROKEN", () => {
    expect(melEntryFor(mel, "TRAY", "BROKEN", "V09")?.id).toBe("FX-MEL-TRAY-BROKEN-V09");
    expect(melEntryFor(mel, "TRAY", "BROKEN", "V01")?.id).toBe("FX-MEL-TRAY-BROKEN");
    const v09 = classify({ mel, componentId: "TRAY", condition: "BROKEN", variant: "V09", seatBlocked: false });
    const base = classify({ mel, componentId: "TRAY", condition: "BROKEN", variant: "V01", seatBlocked: false });
    expect(v09).toMatchObject({ class: "MEL", category: "C", intervalDays: 10 });
    expect(base).toMatchObject({ class: "MEL", category: "D", intervalDays: 120 });
  });
});

describe("classify", () => {
  it("defaults to COSMETIC with no entry", () => {
    expect(classify({ mel, componentId: "NOPE", condition: "OTHER", variant: "V01", seatBlocked: false })).toEqual({ class: "COSMETIC" });
  });

  it("life vest missing is NO_GO, MEL once the seat belt deferral blocks the seat", () => {
    const args = { mel, componentId: "LIFE_VEST", condition: "MISSING" as const, variant: "V01" };
    const seatBelt = classify({ mel, componentId: "SEATBELT", condition: "BROKEN", variant: "V01", seatBlocked: false });
    expect(seatBelt).toMatchObject({ class: "MEL", blocksSeat: true });
    expect(classify({ ...args, seatBlocked: seatIsBlocked([], "SEAT:12A") })).toMatchObject({ class: "NO_GO" });
    const blocking = [obs({ melClass: seatBelt })];
    expect(classify({ ...args, seatBlocked: seatIsBlocked(blocking, "SEAT:12A") })).toMatchObject({ class: "MEL", item: "FX-25-61-01" });
  });

  it("raising COSMETIC to MEL gives the TECH-RAISED entry; lowering is ignored", () => {
    const base = { mel, componentId: "CUSHION", condition: "STAINED" as const, variant: "V01", seatBlocked: false };
    expect(classify({ ...base, raisedTo: "MEL" })).toEqual({
      class: "MEL",
      item: "TECH-RAISED",
      category: "C",
      intervalDays: 10,
      conditions: "Raised by the technician",
    });
    expect(classify({ ...base, raisedTo: "NO_GO" })).toEqual({ class: "NO_GO", reason: "Raised by the technician" });
    const tray = { ...base, componentId: "TRAY", condition: "BROKEN" as const };
    expect(classify({ ...tray, raisedTo: "MEL" })).toMatchObject({ item: "FX-25-22-01" });
    const vest = { ...base, componentId: "LIFE_VEST", condition: "MISSING" as const };
    expect(classify({ ...vest, raisedTo: "MEL" })).toMatchObject({ class: "NO_GO" });
  });
});

describe("allowedOutcomes", () => {
  it("lists the outcomes each class allows", () => {
    expect(allowedOutcomes({ class: "COSMETIC" })).toEqual(["NOTED", "DEFERRED"]);
    expect(allowedOutcomes(MEL_C)).toEqual(["DEFERRED", "MUST_FIX"]);
    expect(allowedOutcomes({ class: "NO_GO", reason: "r" })).toEqual(["MUST_FIX"]);
  });
});

describe("due dates", () => {
  it("adds the interval in UTC calendar days, across month and year ends, and gives null outside MEL", () => {
    expect(dueDateFor(MEL_C, "2026-11-18")).toBe("2026-11-28");
    expect(dueDateFor(MEL_C, "2026-12-25")).toBe("2027-01-04");
    expect(dueDateFor({ ...MEL_C, category: "A", intervalDays: 1 }, "2028-02-28")).toBe("2028-02-29");
    expect(dueDateFor({ class: "COSMETIC" }, "2026-11-18")).toBeNull();
    expect(dueDateFor({ class: "NO_GO", reason: "r" }, "2026-11-18")).toBeNull();
  });

  it("due on 2026-11-28 is deferrable on 2026-11-28 and NO_GO on 2026-11-29", () => {
    const o = obs();
    expect(isOverdue("2026-11-28", "2026-11-28")).toBe(false);
    expect(isOverdue("2026-11-28", "2026-11-29")).toBe(true);
    expect(isOverdue(null, "2999-01-01")).toBe(false);
    expect(effectiveClass(o, "2026-11-28")).toEqual(MEL_C);
    expect(effectiveClass(o, "2026-11-29")).toEqual({ class: "NO_GO", reason: "MEL deferral expired on 2026-11-28" });
    expect(effectiveClass(obs({ status: "CLOSED" }), "2026-11-29")).toEqual(MEL_C);
    expect(effectiveClass(obs({ outcome: "MUST_FIX" }), "2026-11-29")).toEqual(MEL_C);
  });
});

describe("seatIsBlocked", () => {
  it("needs an open, deferred, blocking observation on that seat", () => {
    expect(seatIsBlocked([obs()], "SEAT:12A")).toBe(true);
    expect(seatIsBlocked([obs()], "SEAT:12B")).toBe(false);
    expect(seatIsBlocked([obs({ blocksSeat: false })], "SEAT:12A")).toBe(false);
    expect(seatIsBlocked([obs({ status: "CLOSED" })], "SEAT:12A")).toBe(false);
    expect(seatIsBlocked([obs({ outcome: "MUST_FIX" })], "SEAT:12A")).toBe(false);
  });
});

describe("binRowsFromLabel", () => {
  it("reads the row span from a stored bin label", () => {
    expect(binRowsFromLabel("Overhead bin L-04 (rows 10-12, 6 bags)")).toEqual({ from: 10, to: 12 });
    expect(binRowsFromLabel("Overhead bin R-11 (rows 28-29, 4 bags)")).toEqual({ from: 28, to: 29 });
  });
  it("returns null for a label without a row span", () => {
    expect(binRowsFromLabel("Overhead bin L-04")).toBeNull();
    expect(binRowsFromLabel("Seat 12A (rows)")).toBeNull();
  });
});

describe("mapCarried", () => {
  const binObs = (extra: Partial<Observation>) =>
    obs({
      locationId: "BIN:L-04",
      locationLabel: "Overhead bin L-04 (rows 10-12, 6 bags)",
      componentId: "BIN_DOOR",
      condition: "BROKEN",
      blocksSeat: false,
      ...extra,
    });

  it("a SAME seat piece keeps its location", () => {
    const locations = locationsOf("FX-L-S176-MAX8-LP@1");
    const [c] = mapCarried([obs({ componentId: "CUSHION", locationId: "SEAT:12A" })], locations, "2026-11-18");
    expect(c).toMatchObject({ placement: "SAME", locationId: "SEAT:12A", overdue: false });
  });

  it("a PIVOT BIN_ASSIST problem is ORPHANED on a LARGE_PIVOT layout", () => {
    const pivot = locationsOf("FX-L-S176-MAX8-PV@1");
    const large = locationsOf("FX-L-S176-MAX8-LP@1");
    const bin = pivot.find((l) => l.id === "BIN:L-04");
    expect(bin?.componentIds).toContain("BIN_ASSIST");
    const o = binObs({ componentId: "BIN_ASSIST", locationLabel: bin?.label ?? "" });
    expect(mapCarried([o], pivot, "2026-11-18")[0]).toMatchObject({ placement: "SAME", locationId: "BIN:L-04" });
    expect(mapCarried([o], large, "2026-11-18")[0]).toMatchObject({ placement: "ORPHANED", locationId: null });
  });

  it("a BIN_DOOR problem on L-04 (rows 10-12) maps to the bin covering row 10", () => {
    const locations = locationsOf("FX-L-S176-MAX8-LP@1").filter((l) => l.id !== "BIN:L-04");
    const covering = locations.find((l) => l.id === "BIN:L-05");
    if (!covering?.bin) throw new Error("fixture changed");
    covering.bin.rowFrom = 10;
    covering.bin.rowTo = 12;
    const [c] = mapCarried([binObs({})], locations, "2026-11-18");
    expect(c).toMatchObject({ placement: "MAPPED", locationId: "BIN:L-05" });
    // not on the other side
    covering.bin.side = "R";
    expect(mapCarried([binObs({})], locations, "2026-11-18")[0]?.placement).toBe("ORPHANED");
  });

  it("is ORPHANED when the label states no row span", () => {
    const locations = locationsOf("FX-L-S176-MAX8-LP@1").filter((l) => l.id !== "BIN:L-04");
    expect(mapCarried([binObs({ locationLabel: "Overhead bin L-04" })], locations, "2026-11-18")[0]?.placement).toBe("ORPHANED");
  });

  it("is ORPHANED for a missing seat, and orders by location with ORPHANED last", () => {
    const locations = locationsOf("FX-L-S176-MAX8-LP@1");
    const orphan = obs({ id: "A", locationId: "SEAT:99Z" });
    const late = obs({ id: "B", componentId: "CUSHION", locationId: "SEAT:12A" });
    const early = obs({ id: "C", componentId: "CUSHION", locationId: "SEAT:1A" });
    const out = mapCarried([orphan, late, early], locations, "2026-11-18");
    expect(out.map((c) => c.observation.id)).toEqual(["C", "B", "A"]);
    expect(out[2]).toMatchObject({ placement: "ORPHANED", locationId: null });
  });

  it("flags overdue deferrals against the check date", () => {
    const locations = locationsOf("FX-L-S176-MAX8-LP@1");
    expect(mapCarried([obs()], locations, "2026-11-28")[0]?.overdue).toBe(false);
    expect(mapCarried([obs()], locations, "2026-11-29")[0]?.overdue).toBe(true);
  });
});
