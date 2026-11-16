import { describe, expect, it, test } from "vitest";
import { CABIN_HALF_WIDTH, lateralCentre, seatPlacement, sideOf } from "../../src/domain/geometry.ts";
import type { Finding, ReleaseContent } from "../../src/domain/types.ts";
import { validateRelease } from "../../src/domain/validate.ts";
import { fixtureContent, stagedFull } from "../helpers.ts";

const seatRevisions = () => stagedFull().content.layoutRevisions.filter((r) => r.locations.some((l) => l.kind === "SEAT"));

describe("seat geometry (DOM-18)", () => {
  it("every seat of every fixture layout lies inside the cabin and A/B/C are port side", () => {
    const revisions = seatRevisions();
    expect(revisions.length).toBeGreaterThan(0);
    for (const r of revisions) {
      for (const l of r.locations) {
        if (!l.seat) continue;
        const { x, z } = l.placement;
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(r.geometry.cabinLength);
        expect(Math.abs(z)).toBeLessThanOrEqual(CABIN_HALF_WIDTH);
        if (["A", "B", "C"].includes(l.seat.letter)) expect(z, `${r.id} ${l.id}`).toBeGreaterThan(0);
        else expect(z, `${r.id} ${l.id}`).toBeLessThan(0);
        expect(l.seat.side).toBe(z > 0 ? "L" : "R");
      }
    }
  });

  it("no two seats of a layout share a placement", () => {
    for (const r of seatRevisions()) {
      const seats = r.locations.filter((l) => l.seat);
      const keys = new Set(seats.map((l) => `${l.placement.x}|${l.placement.z}`));
      expect(keys.size, r.id).toBe(seats.length);
    }
  });

  test.each(["G", "a", "", "AA"])("unknown letter %j throws RangeError", (letter) => {
    const message = `Unknown seat letter: ${letter}`;
    expect(() => lateralCentre(letter)).toThrow(new RangeError(message));
    expect(() => sideOf(letter)).toThrow(RangeError);
    expect(() => seatPlacement(1, letter)).toThrow(RangeError);
  });

  it("known letters keep their sides", () => {
    expect(["A", "B", "C", "D", "E", "F"].map(sideOf)).toEqual(["L", "L", "L", "R", "R", "R"]);
  });
});

describe("seat letter and side findings", () => {
  const seat3A = (c: ReleaseContent) => {
    const revision = c.layoutRevisions.find((r) => r.locations.some((l) => l.id === "SEAT:3A"));
    const loc = revision?.locations.find((l) => l.id === "SEAT:3A");
    if (!revision || !loc?.seat) throw new Error("fixture has no SEAT:3A");
    return { revision, loc, seat: loc.seat };
  };
  const codes = (findings: Finding[], code: string) => findings.filter((f) => f.code === code);

  it("SEAT_LETTER_UNKNOWN: a seat letter outside the geometry table is an error, and validation does not throw", () => {
    const findings = validateRelease(
      fixtureContent((c) => {
        seat3A(c).seat.letter = "G";
      }),
    );
    const hits = codes(findings, "SEAT_LETTER_UNKNOWN");
    expect(hits.length).toBeGreaterThan(0);
    for (const f of hits) expect(f.severity).toBe("error");
    expect(hits[0]?.message).toMatch(/"G"/);
    expect(codes(findings, "SEAT_SIDE_MISMATCH")).toEqual([]);
  });

  it("SEAT_SIDE_MISMATCH: a seat whose side disagrees with its letter is an error", () => {
    const findings = validateRelease(
      fixtureContent((c) => {
        seat3A(c).seat.side = "R";
      }),
    );
    const hits = codes(findings, "SEAT_SIDE_MISMATCH");
    expect(hits.length).toBeGreaterThan(0);
    for (const f of hits) expect(f.severity).toBe("error");
    expect(hits[0]?.message).toMatch(/side R, but letter A is on side L/);
  });

  it("the fixture and candidate data have neither finding", () => {
    const findings = validateRelease(stagedFull().content);
    expect(codes(findings, "SEAT_LETTER_UNKNOWN")).toEqual([]);
    expect(codes(findings, "SEAT_SIDE_MISMATCH")).toEqual([]);
  });
});
