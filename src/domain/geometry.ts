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

// Right-handed frame with +X aft and +Y up puts +Z on the left (port, A/B/C) side when facing forward.
const LATERAL: Record<string, number> = { A: 1.42, B: 0.95, C: 0.48, D: -0.48, E: -0.95, F: -1.42 };

export function lateralCentre(letter: string): number {
  return LATERAL[letter] ?? 0;
}

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
    note:
      "Uniform illustrative row spacing and seat sizes for display and picking only. Pitch bands and photographs do not establish coordinates, hardware construction or cabin height.",
    cabinLength: cabinLength(physicalRows),
    cabinHalfWidth: CABIN_HALF_WIDTH,
    rowPitch: ROW_PITCH,
  };
}

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
