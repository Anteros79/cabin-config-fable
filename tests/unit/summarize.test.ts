import { describe, expect, it, test } from "vitest";
import { locationMatches, parsePrintedRow } from "../../src/domain/specificity.ts";
import { summarizeLocations } from "../../src/domain/summarize.ts";
import type { CabinLocation, LocationSelector } from "../../src/domain/types.ts";
import { fixtureContent } from "../helpers.ts";

const template: CabinLocation = (() => {
  const loc = fixtureContent()
    .layoutRevisions.flatMap((r) => r.locations)
    .find((l) => l.id === "SEAT:3A");
  if (!loc) throw new Error("fixture has no SEAT:3A");
  return loc;
})();

/** A seat on printed row `label`, letter `letter`. */
function seat(label: string, letter = "A"): CabinLocation {
  const loc = structuredClone(template);
  const s = loc.seat!;
  s.printedRow = label;
  s.letter = letter;
  s.code = `${label}${letter}`;
  loc.id = `SEAT:${s.code}`;
  loc.label = `Seat ${s.code}`;
  return loc;
}

/** Row bounds may be null here: unvalidated data can carry null, which must read as "no bound". */
type LooseSelector = Omit<LocationSelector, "kind" | "rowFrom" | "rowTo"> & { rowFrom?: number | null; rowTo?: number | null };
const select = (selector: LooseSelector, seats: CabinLocation[]) =>
  seats.filter((l) => locationMatches({ kind: "SEAT", ...selector } as LocationSelector, l)).map((l) => l.seat!.printedRow);

describe("printed rows (DOM-19)", () => {
  test.each([
    ["12", 12],
    ["", null],
    ["12A", null],
    ["007", 7],
    ["1000", null],
    [" 7", null],
    ["-1", null],
  ] as const)("parsePrintedRow(%j) = %j", (label, expected) => {
    expect(parsePrintedRow(label)).toBe(expected);
  });

  const rows = Array.from({ length: 10 }, (_, i) => seat(String(i + 1)));

  it("rowFrom 5 with no rowTo matches rows 5 and up", () => {
    expect(select({ rowFrom: 5 }, rows)).toEqual(["5", "6", "7", "8", "9", "10"]);
    expect(select({ rowFrom: 5, rowTo: null }, rows)).toEqual(["5", "6", "7", "8", "9", "10"]);
  });

  it("rowTo with no rowFrom matches rows up to it; null bounds on both sides are no bound", () => {
    expect(select({ rowTo: 3 }, rows)).toEqual(["1", "2", "3"]);
    expect(select({ rowFrom: null, rowTo: 3 }, rows)).toEqual(["1", "2", "3"]);
    expect(select({ rowFrom: null, rowTo: null }, rows)).toHaveLength(10);
  });

  it("row range across a skipped printed row", () => {
    const skipped = ["10", "11", "12", "14", "15"].map((label) => seat(label));
    expect(select({ rowFrom: 12, rowTo: 14 }, skipped)).toEqual(["12", "14"]);
    expect(select({ rowFrom: 13, rowTo: 13 }, skipped)).toEqual([]);
  });

  it("a seat whose row is not a number never matches a row range, but does match without one", () => {
    const odd = [seat(""), seat("12A"), seat("1000")];
    expect(select({ rowFrom: 0, rowTo: 999 }, odd)).toEqual([]);
    expect(select({ rowTo: 999 }, odd)).toEqual([]);
    expect(select({}, odd)).toEqual(["", "12A", "1000"]);
  });

  it("summarizeLocations lists unnumbered rows by code instead of calling them row 0", () => {
    const text = summarizeLocations([seat("1"), seat("2"), seat("", "B"), seat("12A", "C")]);
    expect(text).toBe("Seat A rows 1-2; B, 12AC (4 locations)");
    expect(text).not.toMatch(/row 0/);
    expect(summarizeLocations([seat("007"), seat("8")])).toBe("Seat A rows 7-8 (2 locations)");
  });
});
