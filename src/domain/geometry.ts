import type { GeometryDeclaration, Placement } from "./types.ts";

/**
 * Declared geometry frame. Everything here is an illustrative approximation used to draw and
 * pick locations. It is not derived from pitch claims, photographs or any engineering drawing,
 * and must not be read as aircraft dimensions.
 */
export const GEOMETRY_VERSION = "cabin-kit.geometry/1";
export const ROW_PITCH = 0.81;
export const FORWARD_MARGIN = 0.95;
export const AFT_MARGIN = 0.75;
export const CABIN_HALF_WIDTH = 1.76;
export const SEAT_WIDTH = 0.45;
export const SEAT_DEPTH = 0.6;
export const SEAT_HEIGHT = 1.16;
export const BIN_BOTTOM = 1.66;
export const BIN_HEIGHT = 0.44;
export const BIN_DEPTH = 0.78;
/**
 * The drawn bin (scene/seatParts.ts buildBinGeometry) is larger than its placement box: its body reaches this high and
 * its door this far inboard. The shell clears these. Illustrative; tests hold them to the drawn geometry.
 */
export const BIN_DRAWN_TOP = 2.3;
export const BIN_DRAWN_INNER_Z = 0.76;
/**
 * Height of the ceiling on the cabin centreline. Illustrative, not from a drawing; places no location. Above the drawn
 * bins (BIN_DRAWN_TOP), so the ceiling arches over the aisle without cutting them.
 */
export const CEILING_HEIGHT = 2.45;
/** Radius of the curved sidewall, a circle centred on the centreline through the floor edge. Illustrative, not from a drawing; places no location. */
export const SIDEWALL_CURVE_RADIUS = 1.9;
/** The light channel recessed into the ceiling each side runs between these distances from the centreline. Illustrative. */
export const LIGHT_CHANNEL_Z = { from: 0.56, to: 0.68 } as const;

// Right-handed frame with +X aft and +Y up puts +Z on the left (port, A/B/C) side when facing forward.
const LATERAL: ReadonlyMap<string, number> = new Map([
  ["A", 1.42],
  ["B", 0.95],
  ["C", 0.48],
  ["D", -0.48],
  ["E", -0.95],
  ["F", -1.42],
]);

/** True for a seat letter the geometry frame can place (A-F). */
export function isKnownSeatLetter(letter: string): boolean {
  return LATERAL.has(letter);
}

/** Lateral centre of a seat letter; throws `RangeError` for a letter outside the table (DOM-18). */
export function lateralCentre(letter: string): number {
  const z = LATERAL.get(letter);
  if (z === undefined) throw new RangeError(`Unknown seat letter: ${letter}`);
  return z;
}

/** The cabin side of a seat letter; throws `RangeError` for a letter outside the table. */
export function sideOf(letter: string): "L" | "R" {
  return lateralCentre(letter) > 0 ? "L" : "R";
}

export function rowCentreX(physicalRow: number): number {
  return FORWARD_MARGIN + (physicalRow - 0.5) * ROW_PITCH;
}

export function cabinLength(physicalRows: number): number {
  return FORWARD_MARGIN + physicalRows * ROW_PITCH + AFT_MARGIN;
}

export function geometryDeclaration(physicalRows: number): GeometryDeclaration {
  return {
    version: GEOMETRY_VERSION,
    units: "metre",
    axes: {
      x: "+X runs aft along the cabin centreline",
      y: "+Y is up from the cabin floor",
      z: "+Z is toward the left-hand (port, A/B/C) side when facing forward; the frame is right-handed",
    },
    origin: "Cabin centreline at floor level, at the forward edge of the drawn floor",
    status: "illustrative-approximation",
    note: "Uniform illustrative row spacing and seat sizes for display and picking only. Pitch bands and photographs do not establish coordinates, hardware construction or cabin height.",
    cabinLength: cabinLength(physicalRows),
    cabinHalfWidth: CABIN_HALF_WIDTH,
    rowPitch: ROW_PITCH,
  };
}

/** Placement of a seat; throws `RangeError` for a letter outside the table. */
export function seatPlacement(physicalRow: number, letter: string): Placement {
  return { x: rowCentreX(physicalRow), y: 0, z: lateralCentre(letter), lx: SEAT_DEPTH, lz: SEAT_WIDTH, ly: SEAT_HEIGHT };
}

export function floorPlacement(rowFrom: number, rowTo: number, physicalRows: number): Placement {
  const x0 = rowFrom <= 1 ? 0 : rowCentreX(rowFrom) - ROW_PITCH / 2;
  const x1 = rowTo >= physicalRows ? cabinLength(physicalRows) : rowCentreX(rowTo) + ROW_PITCH / 2;
  return { x: (x0 + x1) / 2, y: 0, z: 0, lx: x1 - x0, lz: CABIN_HALF_WIDTH * 2, ly: 0.02 };
}

export function binPlacement(side: "L" | "R", rowFrom: number, rowTo: number): Placement {
  const x0 = rowCentreX(rowFrom) - ROW_PITCH / 2;
  const x1 = rowCentreX(rowTo) + ROW_PITCH / 2;
  const z = (side === "L" ? 1 : -1) * (CABIN_HALF_WIDTH - BIN_DEPTH / 2 - 0.08);
  return { x: (x0 + x1) / 2, y: BIN_BOTTOM, z, lx: x1 - x0, lz: BIN_DEPTH, ly: BIN_HEIGHT };
}

/** Longest step between two consecutive points of shellProfile(). */
const SHELL_STEP = 0.1;
/** The sidewall arc ends this far below the bins, where the shell steps out behind them. */
const BIN_RECESS_BELOW = 0.06;
/** Clearance between the shell and the drawn bins above and inboard of them. */
const BIN_CLEARANCE = 0.03;
const LIGHT_CHANNEL_DEPTH = 0.05;

/**
 * The half cross-section of the cabin shell, from the floor edge (z = CABIN_HALF_WIDTH) to the ceiling on the centreline,
 * as a polyline in the y-z plane on the port (+z) side; the starboard half is its mirror. Illustrative, like every other
 * value here: it places no location. In order:
 * - the sidewall: an arc of SIDEWALL_CURVE_RADIUS centred on the centreline, through the floor edge, up to just below the bins;
 * - the bin recess: out to the floor-edge width, up behind the drawn bins and in over them;
 * - the ceiling: an arch from just inboard of the drawn bins' top edge up to CEILING_HEIGHT on the centreline, with a
 *   light channel recessed into it (LIGHT_CHANNEL_Z).
 * No two consecutive points are more than 0.1 m apart, and no point lies inside a seat or bin placement box or the
 * drawn bin envelope (BIN_DRAWN_TOP, BIN_DRAWN_INNER_Z).
 */
export function shellProfile(): { y: number; z: number }[] {
  const points: { y: number; z: number }[] = [{ y: 0, z: CABIN_HALF_WIDTH }];
  const lineTo = (z: number, y: number) => {
    const from = points[points.length - 1] ?? { y, z };
    const n = Math.max(1, Math.ceil(Math.hypot(z - from.z, y - from.y) / SHELL_STEP));
    for (let i = 1; i <= n; i++) points.push({ y: from.y + ((y - from.y) * i) / n, z: from.z + ((z - from.z) * i) / n });
  };
  // sidewall arc
  const r = SIDEWALL_CURVE_RADIUS;
  const centreY = Math.sqrt(r * r - CABIN_HALF_WIDTH * CABIN_HALF_WIDTH);
  const a0 = Math.asin(-centreY / r);
  const a1 = Math.asin((BIN_BOTTOM - BIN_RECESS_BELOW - centreY) / r);
  const arcSteps = Math.ceil((r * (a1 - a0)) / SHELL_STEP);
  for (let i = 1; i <= arcSteps; i++) {
    const a = a0 + ((a1 - a0) * i) / arcSteps;
    points.push({ y: centreY + r * Math.sin(a), z: r * Math.cos(a) });
  }
  // bin recess, round the drawn bins (which enclose the bin box of binPlacement())
  const overBins = BIN_DRAWN_TOP + BIN_CLEARANCE;
  const edgeZ = BIN_DRAWN_INNER_Z - BIN_CLEARANCE;
  lineTo(CABIN_HALF_WIDTH, BIN_BOTTOM - BIN_RECESS_BELOW);
  lineTo(CABIN_HALF_WIDTH, overBins);
  lineTo(edgeZ, overBins);
  // ceiling: a circular arch from where the recess ends (edgeZ, overBins) to (0, CEILING_HEIGHT)
  const rise = CEILING_HEIGHT - overBins;
  const archR = (edgeZ * edgeZ + rise * rise) / (2 * rise);
  const ceilingY = (z: number) => CEILING_HEIGHT - archR + Math.sqrt(archR * archR - z * z);
  const archTo = (z: number) => {
    const from = points[points.length - 1]?.z ?? z;
    const n = Math.max(1, Math.ceil((from - z) / SHELL_STEP));
    for (let i = 1; i <= n; i++) {
      const zi = from + ((z - from) * i) / n;
      points.push({ y: ceilingY(zi), z: zi });
    }
  };
  archTo(LIGHT_CHANNEL_Z.to);
  lineTo(LIGHT_CHANNEL_Z.to, ceilingY(LIGHT_CHANNEL_Z.to) + LIGHT_CHANNEL_DEPTH);
  lineTo(LIGHT_CHANNEL_Z.from, ceilingY(LIGHT_CHANNEL_Z.from) + LIGHT_CHANNEL_DEPTH);
  lineTo(LIGHT_CHANNEL_Z.from, ceilingY(LIGHT_CHANNEL_Z.from));
  archTo(0);
  return points;
}
