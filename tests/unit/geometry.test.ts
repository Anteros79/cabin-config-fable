import { createHash } from "node:crypto";
import { describe, expect, it, test } from "vitest";
import {
  BIN_BOTTOM,
  BIN_DRAWN_INNER_Z,
  BIN_DRAWN_TOP,
  binPlacement,
  CABIN_HALF_WIDTH,
  CEILING_HEIGHT,
  GEOMETRY_VERSION,
  isKnownSeatLetter,
  lateralCentre,
  SIDEWALL_CURVE_RADIUS,
  seatPlacement,
  shellProfile,
  sideOf,
} from "../../src/domain/geometry.ts";
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

describe("cabin shell (WEB-21)", () => {
  it("adds illustrative constants and keeps the geometry version", () => {
    // raised from the brief's 2.15 by controller ruling (Task 5.6 fix 1): the ceiling clears the drawn bins (top 2.30)
    expect(CEILING_HEIGHT).toBe(2.45);
    expect(SIDEWALL_CURVE_RADIUS).toBe(1.9);
    expect(GEOMETRY_VERSION).toBe("cabin-kit.geometry/1");
  });

  it("every placement of the 176-seat layout is unchanged (snapshot taken before the shell was added)", () => {
    const revision = stagedFull().content.layoutRevisions.find((r) => r.id === "FX-L-S176-MAX8@1");
    if (!revision) throw new Error("fixture has no 176-seat layout");
    const kinds = { SEAT: 0, FLOOR: 0, BIN: 0 };
    for (const l of revision.locations) kinds[l.kind] += 1;
    expect(kinds).toEqual({ SEAT: 176, FLOOR: 4, BIN: 20 });
    // the placements seatPlacement, floorPlacement and binPlacement produced for this layout before Task 5.6
    const json = JSON.stringify(revision.locations.map((l) => [l.id, l.placement]));
    expect(createHash("sha256").update(json).digest("hex")).toBe("ffc6b2c564a630d787eb264dd1978fc157ab38a630fa6162c58926332d6e0268");
    expect(revision.geometry.cabinLength).toBe(26);
    expect(revision.geometry.cabinHalfWidth).toBe(1.76);
  });

  const profile = shellProfile();

  it("is a continuous polyline: consecutive points within 0.15 m", () => {
    expect(profile.length).toBeGreaterThan(10);
    for (let i = 1; i < profile.length; i++) {
      const a = profile[i - 1];
      const b = profile[i];
      if (!a || !b) throw new Error("invariant");
      expect(Math.hypot(b.y - a.y, b.z - a.z), `segment ${i}`).toBeLessThanOrEqual(0.15);
      expect(Math.hypot(b.y - a.y, b.z - a.z), `segment ${i} has length`).toBeGreaterThan(0);
    }
  });

  it("starts at the floor edge and ends on the centreline at the ceiling height", () => {
    expect(profile[0]).toEqual({ y: 0, z: CABIN_HALF_WIDTH });
    const last = profile.at(-1);
    expect(last?.z).toBeCloseTo(0, 9);
    expect(last?.y).toBeCloseTo(CEILING_HEIGHT, 9);
  });

  it("the sidewall bulges to the curve radius, and the shell stays on the half it describes", () => {
    for (const p of profile) {
      expect(p.z).toBeGreaterThanOrEqual(0);
      expect(p.z).toBeLessThanOrEqual(SIDEWALL_CURVE_RADIUS + 1e-9);
      expect(p.y).toBeGreaterThanOrEqual(0);
    }
    expect(Math.max(...profile.map((p) => p.z))).toBeCloseTo(SIDEWALL_CURVE_RADIUS, 2);
  });

  it("no point, and no point between two, lies inside a seat envelope or the bin box", () => {
    const boxes = [...["A", "B", "C", "D", "E", "F"].filter(isKnownSeatLetter).map((letter) => seatPlacement(1, letter)), binPlacement("L", 1, 3)].filter(
      (b) => b.z > 0,
    );
    expect(boxes).toHaveLength(4);
    const inside = (y: number, z: number) => boxes.some((b) => y >= b.y && y <= b.y + b.ly && z >= b.z - b.lz / 2 && z <= b.z + b.lz / 2);
    for (let i = 0; i < profile.length; i++) {
      const a = profile[i];
      const b = profile[i + 1] ?? a;
      if (!a || !b) throw new Error("invariant");
      for (let t = 0; t <= 1; t += 0.1) {
        const y = a.y + (b.y - a.y) * t;
        const z = a.z + (b.z - a.z) * t;
        expect(inside(y, z), `point ${i} + ${t.toFixed(1)}: y ${y.toFixed(3)}, z ${z.toFixed(3)}`).toBe(false);
      }
    }
  });

  it("clears the drawn bins: no point, and no point between two, lies in the drawn bin envelope", () => {
    // the drawn bin (buildBinGeometry) is larger than its placement box; tests/web/shell.test.ts holds these two
    // constants to the drawn geometry's bounding box
    const inside = (y: number, z: number) => y >= BIN_BOTTOM - 0.01 && y <= BIN_DRAWN_TOP && z >= BIN_DRAWN_INNER_Z && z <= CABIN_HALF_WIDTH - 0.02;
    for (let i = 0; i < profile.length; i++) {
      const a = profile[i];
      const b = profile[i + 1] ?? a;
      if (!a || !b) throw new Error("invariant");
      for (let t = 0; t <= 1; t += 0.1) {
        const y = a.y + (b.y - a.y) * t;
        const z = a.z + (b.z - a.z) * t;
        expect(inside(y, z), `point ${i} + ${t.toFixed(1)}: y ${y.toFixed(3)}, z ${z.toFixed(3)}`).toBe(false);
      }
    }
  });

  it("the ceiling arches: it is lowest beside the bins and rises at least 9 cm to the centreline", () => {
    const ceiling = profile.filter((p) => p.z < BIN_DRAWN_INNER_Z);
    const edge = ceiling[0];
    expect(edge?.y).toBeGreaterThan(BIN_DRAWN_TOP);
    expect(CEILING_HEIGHT - (edge?.y ?? 0)).toBeGreaterThanOrEqual(0.09);
  });

  it("is pure: every call returns the same new array", () => {
    const again = shellProfile();
    expect(again).toEqual(profile);
    expect(again).not.toBe(profile);
  });
});
