import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { ARMREST_BOTTOM, ARMREST_HEIGHT, BIN_DRAWN_TOP, FORWARD_MARGIN } from "../../domain/geometry.ts";
import { type BinType, binTypeOf, type CabinLocation, type LayoutRevision } from "../../domain/types.ts";
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
): PieceMesh[] & { geometries: THREE.BufferGeometry[]; panels: THREE.Matrix4[] } {
  const out = Object.assign([] as PieceMesh[], { geometries: [] as THREE.BufferGeometry[], panels: [] as THREE.Matrix4[] });
  const seats = layout.locations.filter((l) => l.kind === "SEAT");
  if (seats.length === 0) return out;
  const armrests = layout.locations.filter((l) => l.kind === "ARMREST");
  type Instance = { location: CabinLocation; matrix: THREE.Matrix4; component?: string | null };
  const atSeats: Instance[] = seats.map((s) => ({ location: s, matrix: translation(s) }));
  const { carriers, bulkhead } = trayCarriers(seats);
  const pitch = new THREE.Matrix4().makeTranslation(-layout.geometry.rowPitch, 0, 0);
  // a bulkhead panel only where it carries a tray or a net (buildBulkheadPanel), in the frame of the seat that would be there
  out.panels = bulkhead
    .filter((s) => s.componentIds.includes("TRAY") || s.componentIds.includes("SEATBACK_NET"))
    .map((s) => pitch.clone().multiply(translation(s)));
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

// ---- overhead bins ------------------------------------------------------------------------------

/** The pieces of a bin module (the fixture's component ids). Which a bin has depends on its type (importer/fixtures.ts). */
export type BinPiece =
  | "BIN_DOOR"
  | "BIN_LATCH"
  | "BIN_STRIKER"
  | "BIN_PIVOT"
  | "BIN_ASSIST"
  | "BIN_LINER"
  | "BIN_SIDE_PANEL"
  | "BIN_BUMPER"
  | "BIN_SEAL"
  | "BIN_PLACARD"
  | "BIN_LABEL";

/** A point of a bin's cross-section: cabin z (lateral, left side), then height. */
type ZY = readonly [z: number, y: number];

const DEG = Math.PI / 180;
/** The door's cross-section: a convex arc from its upper, aisle-side edge down to its lower, outboard edge (left side). */
const DOOR_ARC = { cz: 1.31, cy: 2.2, r: 0.55, from: -5 * DEG, to: -95 * DEG, segments: 14 } as const;
const arcPoint = (a: number, r: number = DOOR_ARC.r): ZY => [DOOR_ARC.cz - r * Math.cos(a), DOOR_ARC.cy + r * Math.sin(a)];
function arcPoints(r: number, from: number = DOOR_ARC.from, to: number = DOOR_ARC.to, segments: number = DOOR_ARC.segments): ZY[] {
  return Array.from({ length: segments + 1 }, (_, i) => arcPoint(from + ((to - from) * i) / segments, r));
}
/** The door's upper, aisle-side edge: the hinge line of a classic door. */
const DOOR_TOP = arcPoint(DOOR_ARC.from);
/** The door's lower, outboard edge. */
const DOOR_BOTTOM = arcPoint(DOOR_ARC.to);
/** The fixed housing an open bin shows: its top, its outboard wall and the underside of the closed bin. */
const HOUSING = { top: BIN_DRAWN_TOP, outboard: 1.74, bottom: 1.652, wall: 0.014 } as const;
/** The top of the housing's floor: a classic bin's fixed shelf. */
export const BIN_FLOOR_TOP = HOUSING.bottom + HOUSING.wall;
/** How far outboard a pivot bin's bucket reaches (its back wall): the large bucket is deeper. Its pivots sit this high. */
const BUCKET_BACK = { PIVOT: 1.44, LARGE_PIVOT: 1.49 } as const;
const BUCKET_PIVOT_Y = 2.05;
/** A large pivot bin's open bucket hangs this much lower than a pivot bin's (docs/research: about 2 in). */
const LARGE_PIVOT_DROP = 0.05;

/** Turn a cross-section point by `a` (radians, as THREE's makeRotationX) about a pivot. */
function turnAbout(p: ZY, pivot: ZY, a: number): ZY {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dz = p[0] - pivot[0];
  const dy = p[1] - pivot[1];
  return [pivot[0] + dy * s + dz * c, pivot[1] + dy * c - dz * s];
}

/**
 * A classic bin's door is split (ruling R29): the upper arc, down to this angle, is a fixed fascia; the shorter lower
 * panel below it swings up about its top edge, inside the housing, so nothing it carries rises above BIN_DRAWN_TOP.
 */
const CLASSIC_SPLIT = -38 * DEG;
const CLASSIC_HINGE = arcPoint(CLASSIC_SPLIT);

/** The arc of the face that turns open: the whole door of a pivot bin's bucket, the lower panel of a classic door. */
const movingArc = (binType: BinType, r: number = DOOR_ARC.r, segments: number = DOOR_ARC.segments) =>
  binType === "CLASSIC" ? arcPoints(r, CLASSIC_SPLIT, DOOR_ARC.to, segments) : arcPoints(r, DOOR_ARC.from, DOOR_ARC.to, segments);

/** The lowest point of a left-side face (`arc`) turned open by `angleDeg` about `pivot`. */
function lowestOpen(pivot: ZY, angleDeg: number, arc: readonly ZY[] = arcPoints(DOOR_ARC.r)): number {
  return Math.min(...arc.map((p) => turnAbout(p, pivot, -angleDeg * DEG)[1]));
}

/**
 * The pivot that turns a bucket by `angleDeg` to where it would come to rest about `base`, lowered by `drop`. The open
 * transform is p → Rp + t with t = (I − R)·base; lowering it adds (0, −drop) to t, and that is a turn about (I − R)⁻¹·t.
 */
function loweredPivot(base: ZY, angleDeg: number, drop: number): ZY {
  const a = -angleDeg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // R on (z, y): z' = c z + s y, y' = −s z + c y
  const tz = base[0] - (c * base[0] + s * base[1]);
  const ty = base[1] - (-s * base[0] + c * base[1]) - drop;
  const det = (1 - c) ** 2 + s ** 2;
  return [((1 - c) * tz + s * ty) / det, (-s * tz + (1 - c) * ty) / det];
}

/** How a bin type opens: the turn in degrees, the axis it turns about (left side; mirrored on the right) and the pieces that turn with the door or bucket. */
export interface BinMotion {
  angleDeg: number;
  pivot: { z: number; y: number };
  moving: readonly BinPiece[];
}

const PIVOT_AXIS: ZY = [BUCKET_BACK.PIVOT, BUCKET_PIVOT_Y];
const LARGE_AXIS: ZY = (() => {
  const base: ZY = [BUCKET_BACK.LARGE_PIVOT, BUCKET_PIVOT_Y];
  const wanted = lowestOpen(PIVOT_AXIS, 35) - LARGE_PIVOT_DROP;
  return loweredPivot(base, 38, lowestOpen(base, 38) - wanted);
})();
const BUCKET_PIECES: readonly BinPiece[] = ["BIN_DOOR", "BIN_LATCH", "BIN_LINER", "BIN_SIDE_PANEL"];

/**
 * How each bin type opens (docs/research/2026-11-18-southwest-737-overhead-bins.md). A classic door's lower panel turns up
 * 75° about its top edge, under a fixed fascia and over a fixed shelf (a fictional stand-in: no public source shows it;
 * ruling R29). A pivot bin's whole bucket turns 35° down on its side pivots; a large pivot bin's deeper bucket 38°, its
 * open bottom edge 5 cm lower than a pivot bin's.
 */
export const BIN_OPENING: Readonly<Record<BinType, BinMotion>> = {
  CLASSIC: { angleDeg: 75, pivot: { z: CLASSIC_HINGE[0], y: CLASSIC_HINGE[1] }, moving: ["BIN_DOOR"] },
  PIVOT: { angleDeg: 35, pivot: { z: PIVOT_AXIS[0], y: PIVOT_AXIS[1] }, moving: BUCKET_PIECES },
  LARGE_PIVOT: { angleDeg: 38, pivot: { z: LARGE_AXIS[0], y: LARGE_AXIS[1] }, moving: BUCKET_PIECES },
};

/** The lowest point of the open door or bucket face, in cabin height. */
export function openBottomEdge(binType: BinType): number {
  const { pivot, angleDeg } = BIN_OPENING[binType];
  return lowestOpen([pivot.z, pivot.y], angleDeg, movingArc(binType));
}

/** A bin opens or closes over this long, easing out (none with reduced motion). */
export const BIN_OPEN_MS = 350;
export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

/**
 * Where the door or bucket of a bin on `side` is, `level` of the way open (0 shut, 1 open), in the bin's own frame: a turn
 * about the hinge or pivot line, which runs along the bin (X), so it commutes with a module's length scale.
 */
export function binOpenMatrix(side: 1 | -1, binType: BinType, level: number): THREE.Matrix4 {
  const { pivot, angleDeg } = BIN_OPENING[binType];
  const z = side * pivot.z;
  return new THREE.Matrix4()
    .makeTranslation(0, pivot.y, z)
    .multiply(new THREE.Matrix4().makeRotationX(-side * angleDeg * DEG * level))
    .multiply(new THREE.Matrix4().makeTranslation(0, -pivot.y, -z));
}

/** A thin strip along a cross-section polyline, across the bin from x0 to x1: one box per segment. */
function strip(points: readonly ZY[], thickness: number, x0: number, x1: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  points.forEach((from, i) => {
    const to = points[i + 1];
    if (!to) return;
    const g = new THREE.BoxGeometry(x1 - x0, Math.hypot(to[0] - from[0], to[1] - from[1]), thickness);
    // the box's height runs along the segment: THREE's rotateX takes +Y to (0, cos, sin)
    g.rotateX(Math.atan2(to[0] - from[0], to[1] - from[1]));
    g.translate((x0 + x1) / 2, (from[1] + to[1]) / 2, (from[0] + to[0]) / 2);
    parts.push(g);
  });
  return merged(parts);
}

/** A flat plate across the bin at x, in the shape of a cross-section polygon. */
function plate(points: readonly ZY[], x: number): THREE.BufferGeometry {
  const g = new THREE.ShapeGeometry(new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y))));
  // shape x is cabin z, shape y is height
  g.applyMatrix4(new THREE.Matrix4().set(0, 0, 0, x, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1));
  return g;
}

/** A plain box centred at x and a cross-section point. */
const block = (lx: number, ly: number, lz: number, x: number, [z, y]: ZY) => box(lx, ly, lz, x, y, z, 0);

/** The same geometry on the other side of the cabin: mirrored across the centreline, every triangle turned back the right way out. */
function onSide(g: THREE.BufferGeometry, side: 1 | -1): THREE.BufferGeometry {
  if (side > 0) return g;
  const out = g.index ? g.toNonIndexed() : g;
  out.applyMatrix4(new THREE.Matrix4().makeScale(1, 1, -1));
  for (const name of Object.keys(out.attributes)) {
    const a = out.getAttribute(name);
    const { array, itemSize } = a;
    for (let t = 0; t + 2 < a.count; t += 3) {
      for (let k = 0; k < itemSize; k++) {
        const i1 = (t + 1) * itemSize + k;
        const i2 = (t + 2) * itemSize + k;
        const v = array[i1] as number;
        array[i1] = array[i2] as number;
        array[i2] = v;
      }
    }
  }
  return out;
}

/** The closed bin of one side (z > 0 = left): the door's convex arc and the body behind it. Extruded along X with unit length. */
function closedBin(side: 1 | -1): { door: THREE.BufferGeometry; closedBody: THREE.BufferGeometry } {
  const { r, segments: seg } = DOOR_ARC;
  const arc = arcPoints(r);
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
  const [innerStart, ...innerRest] = arcPoints(r - 0.02);
  const [arcStart] = arc;
  if (!innerStart || !arcStart) throw new Error("invariant: both arcs have seg + 1 points");
  const shape = new THREE.Shape();
  shape.moveTo(innerStart[0], innerStart[1]);
  for (const [z, y] of innerRest) shape.lineTo(z, y);
  shape.lineTo(HOUSING.outboard, HOUSING.bottom);
  shape.lineTo(HOUSING.outboard, BIN_DRAWN_TOP);
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
  return { door, closedBody: body };
}

/** A bin's geometry for one side and type: the closed shape, and what an open bin shows inside. */
export interface BinGeometry {
  /** the closed body, extruded along X with unit length (a module's instance scales it): the same for every type */
  closedBody: THREE.BufferGeometry;
  /** the door or bucket face, unit length like the body; binOpenMatrix() turns it open */
  door: THREE.BufferGeometry;
  /** the housing an open bin shows in place of its closed body, `length` long: it selects the bin as a whole */
  openBody: THREE.BufferGeometry;
  /** the rest of a pivot bin's bucket (its bottom and back wall), which turns with the face and selects BIN_DOOR; none for a classic bin */
  bucket: THREE.BufferGeometry | null;
  /**
   * A classic bin's split door, `length` long, both BIN_DOOR: the fixed upper fascia and the lower panel that swings up.
   * An open classic bin draws these in place of its instanced door. Null for the pivot types, whose door instance turns.
   */
  fascia: THREE.BufferGeometry | null;
  panel: THREE.BufferGeometry | null;
  /** each piece the type has inside, `length` long; BIN_DOOR is the door itself (or fascia and panel) */
  interior: Partial<Record<BinPiece, THREE.BufferGeometry>>;
}

/**
 * The geometry of a bin of one type on one side (z > 0 = left), with the interior for a module `length` long, centred on
 * x = 0. Sizes are illustrative, not from a drawing: only the opening angles and the large bucket's drop are given.
 */
export function buildBinGeometry(side: 1 | -1, binType: BinType, length = 1): BinGeometry {
  const { door, closedBody } = closedBin(side);
  const h = length / 2;
  const x0 = -h + 0.012;
  const x1 = h - 0.012;
  const { top, outboard, bottom, wall } = HOUSING;
  const wallZ = outboard - wall / 2;
  const valance = strip(
    [
      [DOOR_TOP[0] + wall / 2, DOOR_TOP[1]],
      [DOOR_TOP[0] + wall / 2, top],
    ],
    wall,
    -h,
    h,
  );
  const outboardWall = strip(
    [
      [wallZ, bottom],
      [wallZ, top],
    ],
    wall,
    -h,
    h,
  );
  const roof = (from: number) =>
    strip(
      [
        [from, top - wall / 2],
        [outboard, top - wall / 2],
      ],
      wall,
      -h,
      h,
    );
  const floor = (from: number) =>
    strip(
      [
        [from, bottom + wall / 2],
        [outboard, bottom + wall / 2],
      ],
      wall,
      -h,
      h,
    );
  // on the outboard wall, facing the aisle: the maximum-weight placard and the row label
  const onWall = (lx: number, ly: number, x: number, y: number) => block(lx, ly, 0.004, x, [wallZ - wall / 2 - 0.002, y]);
  const interior: Partial<Record<BinPiece, THREE.BufferGeometry>> = {
    BIN_PLACARD: onWall(0.14, 0.09, length * 0.15, 2.04),
    BIN_LABEL: onWall(0.12, 0.045, -length * 0.15, 2.06),
  };
  let openBody: THREE.BufferGeometry;
  let bucket: THREE.BufferGeometry | null = null;
  let fascia: THREE.BufferGeometry | null = null;
  let panel: THREE.BufferGeometry | null = null;
  if (binType === "CLASSIC") {
    // The fixed shelf is the bin's floor, starting outboard of the circle the panel's free edge sweeps (radius 0.525
    // about the hinge), so the panel never passes through it; what sits on it is seen through the opening below the
    // fascia, where the BIN focus view looks in.
    const shelfFrom = 1.38;
    const shelfTop = bottom + wall;
    openBody = merged([roof(DOOR_TOP[0]), outboardWall, valance, floor(shelfFrom)]);
    fascia = strip(arcPoints(DOOR_ARC.r - 0.006, DOOR_ARC.from, CLASSIC_SPLIT, 6), 0.012, -h, h);
    panel = strip(movingArc("CLASSIC", DOOR_ARC.r - 0.006, 8), 0.012, x0 + 0.004, x1 - 0.004);
    interior.BIN_LINER = strip(
      [
        [1.46, shelfTop + 0.0025],
        [wallZ - wall / 2 - 0.006, shelfTop + 0.0025],
      ],
      0.005,
      x0,
      x1,
    );
    const end = [...arcPoints(DOOR_ARC.r - 0.004), [wallZ - wall / 2, bottom] as ZY, [wallZ - wall / 2, top] as ZY, [DOOR_TOP[0] + 0.004, top] as ZY];
    interior.BIN_SIDE_PANEL = merged([plate(end, x0), plate(end, x1)]);
    // At the shelf's front edge, clear of the panel's sweep: the latch and its striker side by side, the seal behind them.
    interior.BIN_LATCH = block(0.12, 0.024, 0.025, -0.06, [1.4125, shelfTop + 0.012]);
    interior.BIN_STRIKER = block(0.1, 0.024, 0.025, 0.06, [1.4125, shelfTop + 0.012]);
    interior.BIN_SEAL = block(length - 0.04, 0.008, 0.02, 0, [1.44, shelfTop + 0.004]);
    // the hinge on the face, where the panel meets the fascia
    interior.BIN_PIVOT = block(length - 0.06, 0.02, 0.02, 0, arcPoint(CLASSIC_SPLIT, DOOR_ARC.r + 0.012));
    // the placard and the row label lie on the shelf liner, where the opening shows them
    interior.BIN_PLACARD = block(0.14, 0.003, 0.09, length * 0.15, [1.56, shelfTop + 0.0065]);
    interior.BIN_LABEL = block(0.12, 0.003, 0.05, -length * 0.15, [1.53, shelfTop + 0.0065]);
  } else {
    const back = BUCKET_BACK[binType];
    const { pivot } = BIN_OPENING[binType];
    const rim = 1.95;
    openBody = merged([roof(DOOR_TOP[0]), outboardWall, valance, floor(1.62)]);
    bucket = merged([
      strip(
        [
          [DOOR_BOTTOM[0], bottom + 0.006],
          [back, bottom + 0.006],
        ],
        0.012,
        -h + 0.004,
        h - 0.004,
      ),
      strip(
        [
          [back - 0.007, bottom],
          [back - 0.007, rim],
        ],
        0.014,
        -h + 0.004,
        h - 0.004,
      ),
    ]);
    interior.BIN_LINER = strip([...arcPoints(DOOR_ARC.r - 0.03, -50 * DEG, DOOR_ARC.to, 6), [back - 0.02, bottom + 0.016]], 0.006, x0, x1);
    const end = [...arcPoints(DOOR_ARC.r - 0.004), [back, bottom] as ZY, [back, rim] as ZY];
    interior.BIN_SIDE_PANEL = merged([plate(end, x0), plate(end, x1)]);
    // the latch inside the bucket's lip with its release button on the face; the striker on the housing just above it,
    // under the valance
    interior.BIN_LATCH = merged([block(0.16, 0.03, 0.03, 0, [0.8, 2.105]), block(0.05, 0.022, 0.012, 0, arcPoint(-12 * DEG, DOOR_ARC.r + 0.006))]);
    interior.BIN_STRIKER = block(0.1, 0.02, 0.03, 0, [0.8, 2.14]);
    interior.BIN_PIVOT = merged([block(0.03, 0.06, 0.06, x0 + 0.015, [pivot.z, pivot.y]), block(0.03, 0.06, 0.06, x1 - 0.015, [pivot.z, pivot.y])]);
    // the stop the bucket's lip comes up against, beside the striker under the valance
    interior.BIN_BUMPER = block(0.05, 0.02, 0.03, x0 + 0.08, [0.8, 2.14]);
    // the closeout seal along the underside of the housing's front, where the bucket's lip closes against it
    interior.BIN_SEAL = block(length - 0.04, 0.01, 0.022, 0, [DOOR_TOP[0] + 0.01, DOOR_TOP[1] - 0.005]);
    if (binType === "PIVOT")
      interior.BIN_ASSIST = strip(
        [
          [wallZ - wall, top - 0.05],
          [pivot.z - 0.06, pivot.y - 0.22],
        ],
        0.025,
        x1 - 0.07,
        x1 - 0.045,
      );
  }
  return {
    closedBody,
    door,
    openBody: onSide(openBody, side),
    bucket: bucket && onSide(bucket, side),
    fascia: fascia && onSide(fascia, side),
    panel: panel && onSide(panel, side),
    interior: Object.fromEntries(Object.entries(interior).map(([piece, g]) => [piece, onSide(g, side)])) as Partial<Record<BinPiece, THREE.BufferGeometry>>,
  };
}

/** The coloured marker on a closed bin's face (one per bin with a status): a band along the lower face, unit length, left side. */
export function buildBinMarker(): THREE.BufferGeometry {
  return strip([arcPoint(-57 * DEG, DOOR_ARC.r + 0.004), arcPoint(-64 * DEG, DOOR_ARC.r + 0.004)], 0.004, -0.5, 0.5);
}

/** The shades of an open bin's inside: plain greys, the pale housing of the closed bin, a white placard. */
const BIN_SHADES: Readonly<Record<BinPiece | "housing", string>> = {
  housing: "#d5d8df",
  BIN_DOOR: "#d5d8df",
  BIN_LINER: "#5b6170",
  BIN_SIDE_PANEL: "#c4c8d1",
  BIN_LATCH: "#3a3f4a",
  BIN_STRIKER: "#8a909c",
  BIN_PIVOT: "#8a909c",
  BIN_ASSIST: "#6b7280",
  BIN_BUMPER: "#2b2f36",
  BIN_SEAL: "#4a4f5a",
  BIN_PLACARD: "#f4f4f0",
  BIN_LABEL: "#e3e6ee",
};

/** One run of triangles of an open bin's interior mesh, and the piece a pick there selects (null: the bin as a whole). */
export interface BinRange {
  mesh: THREE.Mesh;
  piece: string | null;
  /** first triangle and how many */
  start: number;
  count: number;
  /** a classic door's fascia or panel, drawn in place of the instanced door */
  face?: boolean;
}

/**
 * What an open bin draws, built for that one bin (two draw calls): the parts that turn with the door or bucket, and the
 * housing with what is fixed to it. Its closed door instance turns open with it; its closed body is not drawn.
 */
export interface OpenBin {
  location: CabinLocation;
  side: ClosedBins;
  /** the bin's instance in its side's door and body */
  instance: number;
  binType: BinType;
  moving: THREE.Mesh;
  fixed: THREE.Mesh;
  ranges: BinRange[];
}

/** One side's closed bins: an instanced door and body, one instance per module (WEB-20). */
export interface ClosedBins {
  side: "L" | "R";
  sign: 1 | -1;
  door: THREE.InstancedMesh;
  body: THREE.InstancedMesh;
  /** the bin location of instance i; none on a layout without a bin map, whose modules are illustrative and unpickable */
  locations: CabinLocation[];
  /** where instance i sits, shut: the module's length and place */
  matrices: THREE.Matrix4[];
}

/** A pick on the bins: the bin, the piece, and whether the bin was shut (a tap on a shut bin opens it). */
export interface BinPick {
  location: CabinLocation;
  component: string | null;
  closed: boolean;
}

/** A geometry with no triangles, carrying the attributes merged() keeps. */
function emptyGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute([], 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute([], 2));
  return g;
}

const WHITE = new THREE.Color("#ffffff");
const ZERO_SCALE = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * The overhead bins of a layout, renderer-free (as buildPieceMeshes): the closed bins of each side, at most one open bin
 * with its interior, the opening and closing, and what a pick on them selects. The scene owns the materials and adds
 * `group`; dispose() releases every geometry and mesh made here.
 */
export class BinRun {
  readonly group = new THREE.Group();
  readonly sides: ClosedBins[] = [];
  /** the bin drawn open (opening, open or closing), or null when every bin is shut */
  open: OpenBin | null = null;
  /** the bin opening or open; null while closing or shut */
  target: string | null = null;
  /** how far the open bin is open, eased: 0 shut, 1 open */
  level = 0;
  private motion: { from: number; to: number; start: number } | null = null;
  private readonly interiorMaterial: THREE.Material;
  private readonly closedGeometries: THREE.BufferGeometry[] = [];
  private openGeometries: THREE.BufferGeometry[] = [];

  /**
   * `materials.door` and `materials.body` give each side its own, so one side can be ghosted while the other is solid;
   * the scene owns them. `materials.interior` is the open bin's.
   */
  constructor(
    layout: LayoutRevision,
    materials: { door: (side: "L" | "R") => THREE.Material; body: (side: "L" | "R") => THREE.Material; interior: THREE.Material },
  ) {
    this.interiorMaterial = materials.interior;
    const rows = layout.rows.filter((r) => r.exists).length;
    const bins = layout.locations.filter((l) => l.kind === "BIN");
    for (const side of ["L", "R"] as const) {
      const sign = side === "L" ? 1 : -1;
      const { door, closedBody } = closedBin(sign);
      this.closedGeometries.push(door, closedBody);
      const locations = bins.filter((l) => l.bin?.side === side);
      // Without a supplied bin map the run is drawn as illustrative, unpickable three-row modules.
      const spans: { x: number; lx: number }[] =
        locations.length > 0
          ? locations.map((l) => ({ x: l.placement.x, lx: l.placement.lx }))
          : Array.from({ length: Math.ceil(rows / 3) }, (_, i) => {
              const from = i * 3;
              const to = Math.min(from + 3, rows);
              const x0 = layout.geometry.rowPitch * from + FORWARD_MARGIN;
              const x1 = layout.geometry.rowPitch * to + FORWARD_MARGIN;
              return { x: (x0 + x1) / 2, lx: x1 - x0 };
            });
      const count = Math.max(spans.length, 1);
      const doorMesh = new THREE.InstancedMesh(door, materials.door(side), count);
      const bodyMesh = new THREE.InstancedMesh(closedBody, materials.body(side), count);
      const matrices = spans.map((s) => new THREE.Matrix4().makeScale(s.lx, 1, 1).setPosition(s.x, 0, 0));
      matrices.forEach((m, i) => {
        doorMesh.setMatrixAt(i, m);
        doorMesh.setColorAt(i, WHITE);
        bodyMesh.setMatrixAt(i, m);
      });
      if (spans.length === 0) doorMesh.count = bodyMesh.count = 0;
      for (const mesh of [doorMesh, bodyMesh]) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
      }
      this.group.add(doorMesh, bodyMesh);
      this.sides.push({ side, sign, door: doorMesh, body: bodyMesh, locations, matrices });
    }
    this.group.updateMatrixWorld(true);
  }

  /** True while a bin is opening or closing: each frame calls step(). */
  get animating(): boolean {
    return this.motion !== null;
  }

  /**
   * Open a bin (any other open bin shuts at once, so at most one is open), or close the open one with null. Over
   * BIN_OPEN_MS from `now`, easing out, or at once when `instant` (reduced motion). True if anything changed: the same
   * bin again, or a location that is no pickable bin, changes nothing.
   */
  openBin(locationId: string | null, now: number, instant: boolean): boolean {
    if (locationId === this.target) return false;
    if (locationId === null) {
      this.target = null;
      this.moveTo(0, now, instant);
      return true;
    }
    const side = this.sides.find((s) => s.locations.some((l) => l.id === locationId));
    const instance = side ? side.locations.findIndex((l) => l.id === locationId) : -1;
    const location = side?.locations[instance];
    if (!side || !location) return false;
    if (this.open && this.open.location.id !== locationId) this.shut();
    if (!this.open) this.open = this.build(side, instance, location);
    this.target = locationId;
    this.moveTo(1, now, instant);
    return true;
  }

  /** Advance the opening or closing to `now`. */
  step(now: number): void {
    const m = this.motion;
    if (!m) return;
    const t = Math.min(Math.max(now - m.start, 0) / BIN_OPEN_MS, 1);
    if (t >= 1) this.motion = null;
    this.setLevel(m.from + (m.to - m.from) * easeOutCubic(t));
  }

  /** Finish an opening or closing at once (reduced motion turned on part-way). */
  finish(): void {
    const m = this.motion;
    if (!m) return;
    this.motion = null;
    this.setLevel(m.to);
  }

  /** The meshes a pick may hit on the sides `usable` allows (a ghosted side is not): the closed bins, and the open bin's inside. */
  targets(usable: (side: "L" | "R") => boolean): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const s of this.sides) if (s.locations.length > 0 && usable(s.side)) out.push(s.door, s.body);
    if (this.open && this.target !== null && usable(this.open.side.side)) out.push(this.open.moving, this.open.fixed);
    return out;
  }

  /**
   * What the nearest hit on a bin selects, or null when the nearest hit is something else. A shut bin selects its door
   * (BIN_DOOR, if it lists one); inside an open bin, the piece under the pointer, or the bin as a whole on its housing.
   */
  pick(hits: readonly THREE.Intersection[]): BinPick | null {
    for (const hit of hits) {
      const open = this.open;
      if (open && (hit.object === open.moving || hit.object === open.fixed)) {
        const tri = hit.faceIndex ?? -1;
        const range = open.ranges.find((r) => r.mesh === hit.object && tri >= r.start && tri < r.start + r.count);
        return { location: open.location, component: range?.piece ?? null, closed: false };
      }
      const side = this.sides.find((s) => s.door === hit.object || s.body === hit.object);
      if (!side || hit.instanceId === undefined) return null;
      const location = side.locations[hit.instanceId];
      if (!location) return null;
      const opened = open?.location.id === location.id;
      // an open bin's closed body is not drawn, nor a classic bin's door instance (its split door is)
      if (opened && (hit.object === side.body || open?.ranges.some((r) => r.face))) continue;
      return { location, component: location.componentIds.includes("BIN_DOOR") ? "BIN_DOOR" : null, closed: !(opened && this.target !== null) };
    }
    return null;
  }

  /** Tint the open bin's pieces, each by its own status colour (null: none), at `opacity`. */
  tint(colourOf: (piece: string) => THREE.Color | null, opacity: number): void {
    const open = this.open;
    if (!open) return;
    for (const range of open.ranges) {
      const attribute = range.mesh.geometry.getAttribute(STATUS_TINT_ATTRIBUTE) as THREE.BufferAttribute;
      const colour = range.piece ? colourOf(range.piece) : null;
      for (let v = range.start * 3; v < (range.start + range.count) * 3; v++) {
        if (colour) attribute.setXYZW(v, colour.r, colour.g, colour.b, opacity);
        else attribute.setXYZW(v, 0, 0, 0, 0);
      }
      attribute.needsUpdate = true;
    }
  }

  /**
   * A point on one of the open bin's pieces, in cabin coordinates, or null if it draws none. With `from` (a camera
   * position), a point a pick from there reaches: the first triangle centre whose ray from `from` selects this piece, or
   * null if none does.
   */
  pointOf(piece: string, from?: THREE.Vector3): THREE.Vector3 | null {
    const open = this.open;
    if (!open) return null;
    const candidates: THREE.Vector3[] = [];
    const doorInstance = piece === "BIN_DOOR" && !open.ranges.some((r) => r.piece === "BIN_DOOR" && r.face);
    if (doorInstance) {
      // the turned door instance: points down the middle of its face
      const m = new THREE.Matrix4();
      open.side.door.getMatrixAt(open.instance, m);
      for (let a = -10; a >= -90; a -= 10) {
        const [z, y] = arcPoint(a * DEG);
        candidates.push(new THREE.Vector3(0, y, open.side.sign * z).applyMatrix4(m));
      }
    }
    const position = new THREE.Vector3();
    for (const range of open.ranges) {
      if (range.piece !== piece) continue;
      const p = range.mesh.geometry.getAttribute("position");
      // the middle triangle first, then the rest in order
      const order = Array.from({ length: range.count }, (_, i) => (i + Math.floor(range.count / 2)) % range.count);
      for (const t of order) {
        const centre = new THREE.Vector3();
        for (let v = (range.start + t) * 3; v < (range.start + t) * 3 + 3; v++) centre.add(position.fromBufferAttribute(p, v));
        candidates.push(centre.divideScalar(3).applyMatrix4(range.mesh.matrixWorld));
        if (!from) break;
      }
      if (!from) break;
    }
    if (!from) return candidates[0] ?? null;
    const ray = new THREE.Raycaster();
    const targets = this.targets(() => true);
    for (const c of candidates) {
      ray.set(from, c.clone().sub(from).normalize());
      if (this.pick(ray.intersectObjects(targets, false))?.component === piece) return c;
    }
    return null;
  }

  dispose(): void {
    this.shut();
    for (const s of this.sides) {
      s.door.dispose();
      s.body.dispose();
    }
    for (const g of this.closedGeometries) g.dispose();
    this.group.clear();
  }

  private moveTo(to: number, now: number, instant: boolean): void {
    if (instant) {
      this.motion = null;
      this.setLevel(to);
    } else {
      this.motion = { from: this.level, to, start: now };
      this.place();
    }
  }

  private setLevel(level: number): void {
    this.level = level;
    if (level === 0 && this.target === null) this.shut();
    else this.place();
  }

  /** The open bin's interior: two merged meshes with a colour and a status tint per vertex, and what each run of triangles is. */
  private build(side: ClosedBins, instance: number, location: CabinLocation): OpenBin {
    const { binType } = binTypeOf(location.bin as NonNullable<CabinLocation["bin"]>);
    const geometry = buildBinGeometry(side.sign, binType, location.placement.lx);
    const listed = (piece: string) => location.componentIds.includes(piece);
    const door = listed("BIN_DOOR") ? "BIN_DOOR" : null;
    const moving = new Set<string>(BIN_OPENING[binType].moving);
    type Part = { piece: string | null; shade: string; geometry: THREE.BufferGeometry; face?: boolean };
    const parts = { moving: [] as Part[], fixed: [] as Part[] };
    parts.fixed.push({ piece: null, shade: BIN_SHADES.housing, geometry: geometry.openBody });
    if (geometry.fascia) parts.fixed.push({ piece: door, shade: BIN_SHADES.BIN_DOOR, geometry: geometry.fascia, face: true });
    if (geometry.panel) parts.moving.push({ piece: door, shade: BIN_SHADES.BIN_DOOR, geometry: geometry.panel, face: true });
    if (geometry.bucket) parts.moving.push({ piece: door, shade: BIN_SHADES.BIN_DOOR, geometry: geometry.bucket });
    // only the pieces the bin lists are drawn (a bin stored before the pieces lists its door alone)
    for (const [piece, g] of Object.entries(geometry.interior) as [BinPiece, THREE.BufferGeometry][]) {
      if (listed(piece)) (moving.has(piece) ? parts.moving : parts.fixed).push({ piece, shade: BIN_SHADES[piece], geometry: g });
      else g.dispose();
    }
    for (const g of [geometry.door, geometry.closedBody]) g.dispose();
    const ranges: BinRange[] = [];
    const meshOf = (list: Part[]) => {
      // an empty list draws nothing (mergeGeometries refuses none)
      const g = list.length > 0 ? merged(list.map((p) => p.geometry)) : emptyGeometry();
      for (const p of list) p.geometry.dispose();
      const vertices = g.getAttribute("position").count;
      const colours = new Float32Array(vertices * 3);
      g.setAttribute(STATUS_TINT_ATTRIBUTE, new THREE.BufferAttribute(new Float32Array(vertices * 4), 4));
      const mesh = new THREE.Mesh(g, this.interiorMaterial);
      mesh.matrixAutoUpdate = false;
      let start = 0;
      for (const p of list) {
        const count = geometryTriangles(p.geometry);
        const c = new THREE.Color(p.shade);
        for (let v = start * 3; v < (start + count) * 3; v++) c.toArray(colours, v * 3);
        ranges.push({ mesh, piece: p.piece, start, count, ...(p.face ? { face: true } : {}) });
        start += count;
      }
      g.setAttribute("color", new THREE.BufferAttribute(colours, 3));
      this.openGeometries.push(g);
      this.group.add(mesh);
      return mesh;
    };
    const fixed = meshOf(parts.fixed);
    return { location, side, instance, binType, moving: meshOf(parts.moving), fixed, ranges };
  }

  /** Put the open bin's door, body and interior where `level` has them. */
  private place(): void {
    const open = this.open;
    if (!open) return;
    const { side, instance } = open;
    const closed = side.matrices[instance];
    if (!closed) return;
    const turn = binOpenMatrix(side.sign, open.binType, this.level);
    // a classic bin draws its split door (fascia and panel) in the interior instead of its door instance
    const split = open.ranges.some((r) => r.face);
    side.door.setMatrixAt(instance, split ? ZERO_SCALE : closed.clone().multiply(turn));
    side.body.setMatrixAt(instance, ZERO_SCALE);
    for (const mesh of [side.door, side.body]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    const along = new THREE.Matrix4().makeTranslation(open.location.placement.x, 0, 0);
    open.fixed.matrix.copy(along);
    open.moving.matrix.copy(along).multiply(turn);
    this.group.updateMatrixWorld(true);
  }

  /** Shut the open bin at once: its closed door and body back in place, its interior gone. */
  private shut(): void {
    const open = this.open;
    if (!open) return;
    const closed = open.side.matrices[open.instance];
    if (closed) {
      open.side.door.setMatrixAt(open.instance, closed);
      open.side.body.setMatrixAt(open.instance, closed);
      for (const mesh of [open.side.door, open.side.body]) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
      }
    }
    this.group.remove(open.moving, open.fixed);
    for (const g of this.openGeometries) g.dispose();
    this.openGeometries = [];
    this.open = null;
    this.level = 0;
    this.motion = null;
    if (this.target !== null) this.target = null;
    this.group.updateMatrixWorld(true);
  }
}
