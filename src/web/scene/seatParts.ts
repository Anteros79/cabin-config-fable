import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { ARMREST_BOTTOM, ARMREST_HEIGHT, BIN_DRAWN_TOP } from "../../domain/geometry.ts";
import type { CabinLocation, LayoutRevision } from "../../domain/types.ts";
import { STATUS_TINT_ATTRIBUTE } from "./materials.ts";

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
  /** one armrest's pad, in armrest coordinates (origin on the floor under the armrest's centre); one per ARMREST location */
  armPad: THREE.BufferGeometry;
  legs: THREE.BufferGeometry;
  /** the lap belt and its buckle on the pan, aft of where the cushion is aimed at */
  belt: THREE.BufferGeometry;
  /** the stowed tray table on the rear of the back: the seat behind's tray */
  tray: THREE.BufferGeometry;
  /** the literature net low on the rear of the back: the seat behind's net */
  net: THREE.BufferGeometry;
  /** the life-vest pouch under the pan */
  vest: THREE.BufferGeometry;
  /** a slightly oversized pan for the tier tint */
  panOverlay: THREE.BufferGeometry;
  /** flat quad lying on the carpet under the seat, for the contact shading (WEB-21) */
  contact: THREE.BufferGeometry;
}

/** Height of the contact quad above the carpet: enough to stay clear of it in the depth buffer, too little to see. */
export const CONTACT_LIFT = 0.004;

/** Triangles in one geometry, indexed or not. */
export function geometryTriangles(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : g.getAttribute("position").count) / 3;
}

/** Triangles in one seat: the sum over its part geometries. */
export function seatTriangleCount(g: SeatGeometries): number {
  let total = 0;
  for (const part of Object.values(g)) total += geometryTriangles(part);
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

  // Rear relief in pale shell material: literature ledge and device-holder ledge. The stowed tray and the net are pieces
  // of the seat behind, so each is a mesh of its own.
  const ledge = (v: number, wFrac: number, depth: number, height: number) => {
    const p = backPoint(0, v, half + depth / 2 + 0.004);
    return box(depth, height, backWidth(v) * wFrac, p.x, p.y, 0, 0, 0.004, -SEAT.backLean);
  };
  const rearRelief = merged([
    ledge(0.875, 0.78, 0.022, 0.016), // literature slot lip
    ledge(0.665, 0.66, 0.03, 0.014), // device-holder ledge
  ]);
  const tray = ledge(0.4625, 0.84, 0.014, 0.17);
  const net = ledge(0.17, 0.7, 0.012, 0.13);

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
  for (const sign of [1, -1]) {
    const z = sign * (SEAT.width / 2 + 0.012);
    armParts.push(box(0.38, 0.055, 0.042, -0.045, 0.655, z, 1, 0.02));
    armParts.push(box(0.07, 0.2, 0.036, 0.17, 0.56, z, 1, 0.014, -0.2));
  }
  // The pad sits on the arm structures either side of the armrest's centre line, its top on the top of the armrest's
  // placement box (ARMREST_BOTTOM + ARMREST_HEIGHT), so the drawn pad and the declared armrest agree.
  const padTop = ARMREST_BOTTOM + ARMREST_HEIGHT;
  const armPad = box(0.3, 0.016, 0.036, -0.03, padTop - 0.008, 0, 1, 0.006);

  // Lap belt across the aft part of the pan, buckled in the middle; the pan follows a 0.06 rad tilt.
  const beltY = SEAT.panY + 0.066;
  const belt = merged([box(0.036, 0.008, 0.36, 0.075, beltY, 0, 0, 0, 0.06), box(0.05, 0.016, 0.07, 0.075, beltY + 0.004, 0, 0, 0, 0.06)]);
  // Life-vest pouch under the pan, between the legs.
  const vest = box(0.22, 0.05, 0.24, -0.08, 0.33, 0, 0);

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

  // Contact patch: a little larger than the footprint of the legs and the pan, centred under the pan.
  const contact = new THREE.PlaneGeometry(0.72, SEAT.width + 0.1);
  contact.rotateX(-Math.PI / 2);
  contact.translate(0.0, CONTACT_LIFT, 0);

  return {
    pan,
    backCore,
    backFront,
    rearShell,
    rearRelief,
    headrest,
    wingFace,
    arms: merged(armParts),
    armPad,
    legs: merged(legParts),
    belt,
    tray,
    net,
    vest,
    panOverlay,
    contact,
  };
}

/**
 * The thin panel ahead of a seat with no seat in front (row 1, or a bulkhead row), in the frame of the seat that would be
 * there: it lies where that seat's back would, so the tray and net of the seat behind it sit on it as on any back.
 */
export function buildBulkheadPanel(): THREE.BufferGeometry {
  // only as tall as the tray and net need, so it hides little of the first row behind it
  const p = backPoint(0, 0.33, SEAT.backThickness / 2 - 0.008);
  return box(0.024, 0.44, SEAT.width, p.x, p.y, 0, 0, 0, -SEAT.backLean);
}

// ---- pieces -------------------------------------------------------------------------------------

/** Seat parts drawn as one instanced mesh each. */
export type SeatPart =
  | "legs"
  | "pan"
  | "backCore"
  | "backFront"
  | "rearShell"
  | "rearRelief"
  | "headrest"
  | "arms"
  | "armPads"
  | "wings"
  | "belt"
  | "tray"
  | "net"
  | "vest";

/**
 * What a hit on each part selects: the piece (a component id, or null for the seat as a whole) and whose it is. A part
 * owned by "behind" is drawn on a seat's back but belongs to the seat directly aft of it: the tray and the net.
 */
export const PIECE_TAGS: Readonly<Record<SeatPart, { component: string | null; owner: "self" | "behind" }>> = {
  legs: { component: null, owner: "self" },
  arms: { component: null, owner: "self" },
  pan: { component: "CUSHION", owner: "self" },
  backCore: { component: "BACKREST", owner: "self" },
  backFront: { component: "BACKREST", owner: "self" },
  rearShell: { component: "BACKREST", owner: "self" },
  rearRelief: { component: "BACKREST", owner: "self" },
  wings: { component: "BACKREST", owner: "self" },
  headrest: { component: "HEADREST", owner: "self" },
  belt: { component: "SEATBELT", owner: "self" },
  tray: { component: "TRAY", owner: "behind" },
  net: { component: "SEATBACK_NET", owner: "behind" },
  vest: { component: "LIFE_VEST", owner: "self" },
  armPads: { component: "ARMREST", owner: "self" },
};

/**
 * A part whose piece a location does not list (a layout stored before the pieces existed lists only CUSHION and
 * BACKREST) selects this piece instead, if listed: as the scene did before. Otherwise it selects the location as a whole.
 */
const FALLBACK: Partial<Record<SeatPart, string>> = { headrest: "BACKREST", belt: "CUSHION" };

/** The piece a part selects at a location: its own if the location lists it, else its fallback if listed, else none. */
function pieceAt(location: CabinLocation, part: SeatPart): string | null {
  const own = PIECE_TAGS[part].component;
  if (own !== null && location.componentIds.includes(own)) return own;
  const fallback = FALLBACK[part];
  return fallback !== undefined && location.componentIds.includes(fallback) ? fallback : null;
}

/** One instanced mesh of a seat part: what each of its instances belongs to, and the matrix of each. */
export interface PieceMesh {
  part: SeatPart;
  mesh: THREE.InstancedMesh;
  /** the piece the part is (PIECE_TAGS) */
  component: string | null;
  owner: "self" | "behind";
  /** the location instance i belongs to, with the owner applied (the seat behind for a tray or a net) */
  locations: CabinLocation[];
  /** the piece a pick on instance i selects: always one its location lists, or null for the location as a whole */
  components: (string | null)[];
  /** where instance i is drawn */
  matrices: THREE.Matrix4[];
  /** the piece's status tint, one vec4 per instance (see withStatusTint), or null for a part that is no piece */
  tint: THREE.InstancedBufferAttribute | null;
}

/** The geometry each part draws. */
function partGeometry(geoms: SeatGeometries, part: SeatPart): THREE.BufferGeometry {
  if (part === "armPads") return geoms.armPad;
  if (part === "wings") return geoms.wingFace;
  return geoms[part];
}

const translation = (l: CabinLocation) => new THREE.Matrix4().makeTranslation(l.placement.x, 0, l.placement.z);

/**
 * Which seats draw a tray and a net on their back for the seat behind, and which seats have theirs on a bulkhead panel.
 * The seat behind is the same letter in the next physical row. A seat with no seat directly ahead has its tray and net on
 * a panel ahead of it, one row pitch forward, if it is in the first row or marked as a bulkhead seat; otherwise (behind
 * an omitted seat) none is drawn.
 */
export function trayCarriers(seats: CabinLocation[]): { carriers: { on: CabinLocation; owner: CabinLocation }[]; bulkhead: CabinLocation[] } {
  const byPosition = new Map(seats.map((s) => [`${s.seat?.physicalRow}|${s.seat?.letter}`, s]));
  const firstRow = Math.min(...seats.map((s) => s.seat?.physicalRow ?? Number.POSITIVE_INFINITY));
  const at = (s: CabinLocation, rows: number) => (s.seat ? byPosition.get(`${s.seat.physicalRow + rows}|${s.seat.letter}`) : undefined);
  const carriers: { on: CabinLocation; owner: CabinLocation }[] = [];
  for (const on of seats) {
    const owner = at(on, 1);
    if (owner) carriers.push({ on, owner });
  }
  const bulkhead = seats.filter((s) => !at(s, -1) && (s.seat?.physicalRow === firstRow || s.seat?.bulkhead === true));
  return { carriers, bulkhead };
}

/**
 * Every seat part of a layout as one instanced mesh, with what each instance belongs to (WEB-20: one draw call per part,
 * however many seats). Parts that are pieces carry a per-instance status tint on their own copy of the geometry. The
 * meshes start with `material`; the scene gives each part its own. Returns nothing for a layout with no seats. The caller
 * owns the meshes and the copied geometries (`geometries`).
 */
export function buildPieceMeshes(
  layout: LayoutRevision,
  geoms: SeatGeometries,
  material: THREE.Material,
): PieceMesh[] & { geometries: THREE.BufferGeometry[] } {
  const out = Object.assign([] as PieceMesh[], { geometries: [] as THREE.BufferGeometry[] });
  const seats = layout.locations.filter((l) => l.kind === "SEAT");
  if (seats.length === 0) return out;
  const armrests = layout.locations.filter((l) => l.kind === "ARMREST");
  type Instance = { location: CabinLocation; matrix: THREE.Matrix4; component?: string | null };
  const atSeats: Instance[] = seats.map((s) => ({ location: s, matrix: translation(s) }));
  const { carriers, bulkhead } = trayCarriers(seats);
  const pitch = new THREE.Matrix4().makeTranslation(-layout.geometry.rowPitch, 0, 0);
  // The tray and net: on the back of the seat ahead, or on the bulkhead panel one row pitch ahead. A seat behind that
  // does not list the piece leaves it to the back it is drawn on, as part of that seat's backrest.
  const behind = (part: "tray" | "net"): Instance[] => {
    const component = PIECE_TAGS[part].component ?? "";
    return [
      ...carriers.map((c) =>
        c.owner.componentIds.includes(component)
          ? { location: c.owner, matrix: translation(c.on), component }
          : { location: c.on, matrix: translation(c.on), component: c.on.componentIds.includes("BACKREST") ? "BACKREST" : null },
      ),
      ...bulkhead.filter((s) => s.componentIds.includes(component)).map((s) => ({ location: s, matrix: pitch.clone().multiply(translation(s)), component })),
    ];
  };
  // One pad per armrest location; a layout without armrest locations (stored before they existed) keeps two
  // unpickable pads per seat, as it was drawn then.
  const padSide = (sign: number) => new THREE.Matrix4().makeTranslation(0, 0, sign * (SEAT.width / 2 + 0.012));
  const pads: Instance[] =
    armrests.length > 0
      ? armrests.map((a) => ({ location: a, matrix: translation(a) }))
      : [1, -1].flatMap((sign) => atSeats.map((s) => ({ location: s.location, matrix: s.matrix.clone().multiply(padSide(sign)), component: null })));
  // The pale wing faces: the aisle-side wing of every seat (instance i), then the window-side wing (n + i), which only
  // families with both wings pale show (the scene hides them otherwise). One draw call, not two (WEB-20).
  const mirror = new THREE.Matrix4().makeScale(1, 1, -1);
  const wings: Instance[] = [
    ...atSeats.map((s) => ({ location: s.location, matrix: s.location.placement.z > 0 ? s.matrix.clone().multiply(mirror) : s.matrix })),
    ...atSeats.map((s) => ({ location: s.location, matrix: s.location.placement.z > 0 ? s.matrix : s.matrix.clone().multiply(mirror) })),
  ];
  const instances: Record<SeatPart, Instance[]> = {
    legs: atSeats,
    pan: atSeats,
    backCore: atSeats,
    backFront: atSeats,
    rearShell: atSeats,
    rearRelief: atSeats,
    headrest: atSeats,
    belt: atSeats,
    tray: behind("tray"),
    net: behind("net"),
    vest: atSeats,
    arms: atSeats,
    armPads: pads,
    wings,
  };
  for (const part of Object.keys(instances) as SeatPart[]) {
    const list = instances[part];
    if (list.length === 0) continue;
    const { component, owner } = PIECE_TAGS[part];
    let geometry = partGeometry(geoms, part);
    let tint: THREE.InstancedBufferAttribute | null = null;
    if (component !== null) {
      // the tint lives on this layout's copy of the shape, so the shared shape stays free of per-layout attributes
      geometry = geometry.clone();
      tint = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 4), 4);
      geometry.setAttribute(STATUS_TINT_ATTRIBUTE, tint);
      out.geometries.push(geometry);
    }
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    list.forEach((entry, i) => {
      mesh.setMatrixAt(i, entry.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    out.push({
      part,
      mesh,
      component,
      owner,
      locations: list.map((e) => e.location),
      components: list.map((e) => (e.component !== undefined ? e.component : pieceAt(e.location, part))),
      matrices: list.map((e) => e.matrix),
      tint,
    });
  }
  return out;
}

/** The meshes a pick may hit: every part while seats are shown, the life vests only while the under-seat layer is on too. */
export function pieceTargets(pieces: readonly PieceMesh[], layers: { seats: boolean; underSeat: boolean }): THREE.Object3D[] {
  if (!layers.seats) return [];
  return pieces.filter((p) => p.part !== "vest" || layers.underSeat).map((p) => p.mesh);
}

/** What the nearest hit selects, if it is a seat part: the owning location and the piece. */
export function pickPiece(
  hits: readonly THREE.Intersection[],
  pieces: readonly PieceMesh[],
): { location: CabinLocation; component: string | null; piece: PieceMesh; instance: number } | null {
  const first = hits[0];
  const piece = first && pieces.find((p) => p.mesh === first.object);
  if (!piece || first.instanceId === undefined) return null;
  const location = piece.locations[first.instanceId];
  return location ? { location, component: piece.components[first.instanceId] ?? null, piece, instance: first.instanceId } : null;
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
  shape.lineTo(1.74, BIN_DRAWN_TOP);
  shape.lineTo(arcStart[0], BIN_DRAWN_TOP);
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
