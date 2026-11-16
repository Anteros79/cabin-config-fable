import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/**
 * Seat part geometries in seat-local coordinates: origin on the floor under the seat centre,
 * +X aft (the seat faces -X), +Y up, Z lateral. Sizes are illustrative approximations shaped
 * after the supplied photographs; they are not hardware dimensions.
 */
export const SEAT = {
  width: 0.43,
  panY: 0.455,
  backBaseX: 0.2,
  backBaseY: 0.47,
  backHeight: 0.7,
  backLean: 0.24, // radians, top leans aft
  backThickness: 0.07,
};

/** Width of the back at height fraction v: wider at the hips, tapering toward the headrest. */
function backWidth(v: number): number {
  return SEAT.width - 0.05 * v;
}

/** Fore-aft offset of the back surface: the edges wrap slightly forward, more so lower down. */
function backWrap(u: number, v: number): number {
  return -0.028 * (1 - 0.5 * v) * (2 * u) * (2 * u);
}

/** Map (u across -0.5..0.5, v up 0..1, t thickness offset) on the leaning back to seat-local space. */
function backPoint(u: number, v: number, t: number): THREE.Vector3 {
  const along = v * SEAT.backHeight;
  const cos = Math.cos(SEAT.backLean);
  const sin = Math.sin(SEAT.backLean);
  const tx = t + backWrap(u, v);
  return new THREE.Vector3(SEAT.backBaseX + along * sin + tx * cos, SEAT.backBaseY + along * cos - tx * sin, u * backWidth(v));
}

function lofted(tFront: number, tBack: number, segU: number, segV: number): THREE.BufferGeometry {
  const box = new THREE.BoxGeometry(1, 1, 1, 1, segV, segU);
  const pos = box.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getX(i) < 0 ? tFront : tBack;
    const p = backPoint(pos.getZ(i), pos.getY(i) + 0.5, t);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  box.computeVertexNormals();
  return box;
}

function surface(t: number, faceForward: boolean, segU: number, segV: number, v0 = 0, v1 = 1): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  for (let j = 0; j <= segV; j++) {
    for (let i = 0; i <= segU; i++) {
      const u = i / segU - 0.5;
      const v = v0 + ((v1 - v0) * j) / segV;
      const p = backPoint(u, v, t);
      positions.push(p.x, p.y, p.z);
      // texture u runs left-to-right as seen by someone looking at the surface
      uvs.push(faceForward ? i / segU : 1 - i / segU, j / segV);
    }
  }
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = j * (segU + 1) + i;
      const b = a + 1;
      const c = a + segU + 1;
      const d = c + 1;
      if (faceForward) index.push(a, b, c, b, d, c);
      else index.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/**
 * Edge detail per part (WEB-20): 2 rounded segments only where the silhouette is seen (headrest, back cushion, pan),
 * 1 for the sculpted arm structures and pads, a plain box for legs, ledges and the tray. Surface relief belongs in the
 * texture, not in geometry.
 */
type Detail = 0 | 1 | 2;

function box(lx: number, ly: number, lz: number, x: number, y: number, z: number, detail: Detail, r = 0.012, rotZ = 0, rotY = 0): THREE.BufferGeometry {
  const g = detail === 0 ? new THREE.BoxGeometry(lx, ly, lz) : new RoundedBoxGeometry(lx, ly, lz, detail, Math.min(r, lx / 2.01, ly / 2.01, lz / 2.01));
  if (rotZ) g.rotateZ(rotZ);
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  return g;
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const clean = parts.map((p) => {
    const g = p.index ? p.toNonIndexed() : p;
    for (const name of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(name)) g.deleteAttribute(name);
    return g;
  });
  const out = mergeGeometries(clean, false);
  if (!out) throw new Error("geometry merge failed");
  return out;
}

export interface SeatGeometries {
  pan: THREE.BufferGeometry;
  backCore: THREE.BufferGeometry;
  backFront: THREE.BufferGeometry;
  rearShell: THREE.BufferGeometry;
  rearRelief: THREE.BufferGeometry;
  headrest: THREE.BufferGeometry;
  /** pale outer face of the +Z wing; mirrored per instance for the other wing */
  wingFace: THREE.BufferGeometry;
  arms: THREE.BufferGeometry;
  armPads: THREE.BufferGeometry;
  legs: THREE.BufferGeometry;
  /** slightly oversized shells used for status and tier overlays */
  panOverlay: THREE.BufferGeometry;
  backOverlay: THREE.BufferGeometry;
}

/** Most triangles one seat may draw, summed over every part geometry (WEB-20). */
export const SEAT_TRIANGLE_BUDGET = 3_200;

/** Triangles in one seat: the sum over its part geometries, indexed or not. */
export function seatTriangleCount(g: SeatGeometries): number {
  let total = 0;
  for (const part of Object.values(g)) total += (part.index ? part.index.count : part.getAttribute("position").count) / 3;
  return total;
}

export function buildSeatGeometries(): SeatGeometries {
  // Seat pan: a separate smooth cushion, front edge slightly raised.
  const pan = new RoundedBoxGeometry(0.47, 0.115, SEAT.width - 0.03, 2, 0.04);
  pan.rotateZ(0.06);
  pan.translate(-0.045, SEAT.panY, 0);

  const half = SEAT.backThickness / 2;
  const backCore = lofted(-half, half, 6, 8);
  const backFront = surface(-half - 0.004, true, 8, 10, 0.0, 0.985);
  const rearShell = surface(half + 0.004, false, 8, 10, 0.0, 0.985);

  // Rear relief in pale shell material: literature ledge, device-holder ledge and the stowed tray slab.
  const relief: THREE.BufferGeometry[] = [];
  const ledge = (v: number, wFrac: number, depth: number, height: number) => {
    const p = backPoint(0, v, half + depth / 2 + 0.004);
    relief.push(box(depth, height, backWidth(v) * wFrac, p.x, p.y, 0, 0, 0.004, -SEAT.backLean));
  };
  ledge(0.875, 0.78, 0.022, 0.016); // literature slot lip
  ledge(0.665, 0.66, 0.03, 0.014); // device-holder ledge
  ledge(0.4625, 0.84, 0.014, 0.17); // stowed tray table
  const rearRelief = merged(relief);

  // Headrest: broad centre pad with two projecting wings.
  // The headrest is mounted on the front of the upper back, as in the photographs: the back runs
  // up behind it, so the pale upper band shows around it and the rear shell reaches the top.
  const top = backPoint(0, 0.845, -half - 0.044);
  const hx = top.x;
  const hy = top.y;
  const wingAngle = 0.5;
  // The headrest is narrower than the back, so the upper back shows on both sides of it.
  const wing = (sign: number) => box(0.074, 0.205, 0.085, hx - 0.014, hy, sign * 0.132, 2, 0.032, 0, -sign * wingAngle);
  const headrest = merged([box(0.086, 0.215, 0.2, hx, hy, 0, 2, 0.04, -SEAT.backLean), wing(1), wing(-1)]);
  const wingFace = box(0.054, 0.16, 0.01, hx - 0.036, hy, 0.173, 1, 0.004, 0, -wingAngle);

  // Arms: pale sculpted arm with a dark pad, on both sides of the seat.
  const armParts: THREE.BufferGeometry[] = [];
  const padParts: THREE.BufferGeometry[] = [];
  for (const sign of [1, -1]) {
    const z = sign * (SEAT.width / 2 + 0.012);
    armParts.push(box(0.38, 0.055, 0.042, -0.045, 0.655, z, 1, 0.02));
    armParts.push(box(0.07, 0.2, 0.036, 0.17, 0.56, z, 1, 0.014, -0.2));
    padParts.push(box(0.3, 0.016, 0.036, -0.03, 0.688, z, 1, 0.006));
  }

  // Legs: silver braces and feet.
  const legParts: THREE.BufferGeometry[] = [];
  for (const sign of [1, -1]) {
    const z = sign * 0.165;
    legParts.push(box(0.024, 0.42, 0.024, -0.14, 0.2, z, 0, 0.006, -0.38));
    legParts.push(box(0.024, 0.42, 0.024, 0.11, 0.2, z, 0, 0.006, 0.34));
    legParts.push(box(0.34, 0.022, 0.03, -0.01, 0.014, z, 0, 0.006));
  }
  legParts.push(box(0.03, 0.03, 0.36, -0.02, 0.39, 0, 0, 0.006));

  const panOverlay = new RoundedBoxGeometry(0.49, 0.13, SEAT.width - 0.015, 2, 0.04);
  panOverlay.rotateZ(0.06);
  panOverlay.translate(-0.045, SEAT.panY + 0.004, 0);
  const backOverlay = lofted(-half - 0.012, half + 0.012, 4, 4);

  return {
    pan,
    backCore,
    backFront,
    rearShell,
    rearRelief,
    headrest,
    wingFace,
    arms: merged(armParts),
    armPads: merged(padParts),
    legs: merged(legParts),
    panOverlay,
    backOverlay,
  };
}

/** Cross-section of a closed overhead bin for one side (z > 0 = left). Extruded along X with unit length. */
export function buildBinGeometry(side: 1 | -1): { door: THREE.BufferGeometry; body: THREE.BufferGeometry } {
  const cz = 1.31;
  const cy = 2.2;
  const r = 0.55;
  const a0 = (-5 * Math.PI) / 180;
  const a1 = (-95 * Math.PI) / 180;
  const seg = 14;
  const arc: [number, number][] = [];
  for (let i = 0; i <= seg; i++) {
    const a = a0 + ((a1 - a0) * i) / seg;
    arc.push([cz - r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  // door: the convex arc, UV v = 1 at the upper edge, 0 at the lower edge
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  arc.forEach(([z, y], i) => {
    for (const x of [-0.5, 0.5]) {
      positions.push(x, y, side * z);
      uvs.push(side > 0 ? x + 0.5 : 0.5 - x, 1 - i / seg);
    }
  });
  for (let i = 0; i < seg; i++) {
    const a = i * 2;
    if (side > 0) index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    else index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const door = new THREE.BufferGeometry();
  door.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  door.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  door.setIndex(index);
  door.computeVertexNormals();

  // body: top, outboard wall and end caps so the module reads as a solid from outside.
  // Its inner arc sits just inside the door so the two surfaces never coincide.
  const inner: [number, number][] = [];
  for (let i = 0; i <= seg; i++) {
    const a = a0 + ((a1 - a0) * i) / seg;
    inner.push([cz - (r - 0.02) * Math.cos(a), cy + (r - 0.02) * Math.sin(a)]);
  }
  const [innerStart, ...innerRest] = inner;
  const [arcStart] = arc;
  if (!innerStart || !arcStart) throw new Error("invariant: both arcs have seg + 1 points");
  const shape = new THREE.Shape();
  shape.moveTo(innerStart[0], innerStart[1]);
  for (const [z, y] of innerRest) shape.lineTo(z, y);
  shape.lineTo(1.74, 1.652);
  shape.lineTo(1.74, 2.3);
  shape.lineTo(arcStart[0], 2.3);
  shape.closePath();
  const body = new THREE.ExtrudeGeometry(shape, { depth: 0.985, bevelEnabled: false, steps: 1 });
  // extrude runs along +Z of the shape plane (shape x = cabin z, shape y = cabin y): rotate into place
  const m = new THREE.Matrix4().set(0, 0, 1, -0.4925, 0, 1, 0, 0, side, 0, 0, 0, 0, 0, 0, 1);
  body.applyMatrix4(m);
  if (side > 0) {
    const idx = body.index;
    if (idx) {
      for (let i = 0; i < idx.count; i += 3) {
        const b = idx.getX(i + 1);
        idx.setX(i + 1, idx.getX(i + 2));
        idx.setX(i + 2, b);
      }
    } else {
      const p = body.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i += 3) {
        const bx = p.getX(i + 1),
          by = p.getY(i + 1),
          bz = p.getZ(i + 1);
        p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2));
        p.setXYZ(i + 2, bx, by, bz);
      }
    }
  }
  body.computeVertexNormals();
  return { door, body };
}
