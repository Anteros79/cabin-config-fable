/**
 * The cabin shell of the context layer (WEB-21): the curved sidewall with recessed windows and the bin recess, the arched
 * ceiling with a light channel each side, and the two plain end bulkheads, all built from shellProfile(). Faces wind
 * outward (away from the cabin), so a material drawing only back faces shows the inside of the shell and nothing of a
 * wall seen from outside. three.js geometry only, so it is tested on its own.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { BIN_DRAWN_INNER_Z, BIN_DRAWN_TOP, LIGHT_CHANNEL_Z } from "../../domain/geometry.ts";

type ProfilePoint = { y: number; z: number };

/** The window recesses: rounded rectangles one per row pitch, set into the sidewall with their centre at this height. */
export const WINDOW = { centreY: 1.06, width: 0.26, height: 0.36, cornerRadius: 0.075, depth: 0.05 } as const;
/** Pale wall, a shade darker in the window reveals, and a dim blue-grey pane. */
export const SHELL_COLOURS = { wall: "#eef0f3", reveal: "#d3d8e0", pane: "#9fb0c6" } as const;
/** Adjacent profile segments turning less than this share a smooth normal; sharper corners stay crisp. */
const CREASE = THREE.MathUtils.degToRad(25);
const CORNER_STEPS = 4;
/** The band of wall around the windows reaches this far past them, up and down. */
const WINDOW_BAND_MARGIN = 0.05;

export interface ShellGeometries {
  /** the port (+z) and starboard sidewalls, floor edge to the inboard edge over the bins; with vertex colours */
  left: THREE.BufferGeometry;
  right: THREE.BufferGeometry;
  /** both halves of the ceiling; uv.x is 0.75 on the light channels and 0.25 elsewhere (see lightChannelMask) */
  ceiling: THREE.BufferGeometry;
  /** the forward and aft bulkheads, flat plates of the full cross-section */
  bulkheads: THREE.BufferGeometry;
}

interface Vertex {
  p: THREE.Vector3;
  n: THREE.Vector3;
  colour: THREE.Color;
  u: number;
}

/** Triangles without an index, each wound so its face normal points the way it is told. */
class TriangleSoup {
  private positions: number[] = [];
  private normals: number[] = [];
  private colours: number[] = [];
  private uvs: number[] = [];

  /** A triangle facing `outward`. Vertices without their own normal take the face normal (a flat face). */
  add(a: Vertex, b: Vertex, c: Vertex, outward: THREE.Vector3): void {
    const face = b.p.clone().sub(a.p).cross(c.p.clone().sub(a.p));
    if (face.lengthSq() < 1e-14) return;
    const [v0, v1, v2] = face.dot(outward) >= 0 ? [a, b, c] : [a, c, b];
    for (const v of [v0, v1, v2]) {
      this.positions.push(v.p.x, v.p.y, v.p.z);
      this.normals.push(v.n.x, v.n.y, v.n.z);
      this.colours.push(v.colour.r, v.colour.g, v.colour.b);
      this.uvs.push(v.u, 0.5);
    }
  }

  geometry(withColours: boolean): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uvs, 2));
    if (withColours) g.setAttribute("color", new THREE.Float32BufferAttribute(this.colours, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** Outward unit normal of the profile segment a → b in (z, y), on the port side: the segment turned clockwise. */
function segmentNormal(a: ProfilePoint, b: ProfilePoint): { y: number; z: number } {
  const dz = b.z - a.z;
  const dy = b.y - a.y;
  const length = Math.hypot(dz, dy);
  return { y: -dz / length, z: dy / length };
}

/**
 * A run of profile points (port side) with, per segment, its normal at each end: smooth across a gentle bend, the
 * segment's own across a sharp one. Distances along the run (s) let a point between two profile points be found.
 */
class ProfileRun {
  readonly s: number[] = [0];
  /** per segment i (points i and i + 1): the normal at its start and at its end */
  readonly ends: { start: { y: number; z: number }; end: { y: number; z: number } }[] = [];

  readonly points: ProfilePoint[];

  constructor(points: ProfilePoint[]) {
    this.points = points;
    const normals: { y: number; z: number }[] = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i] as ProfilePoint;
      const b = points[i + 1] as ProfilePoint;
      this.s.push((this.s[i] as number) + Math.hypot(b.z - a.z, b.y - a.y));
      normals.push(segmentNormal(a, b));
    }
    const blend = (n: { y: number; z: number }, other: { y: number; z: number } | undefined) => {
      if (!other || Math.acos(THREE.MathUtils.clamp(n.y * other.y + n.z * other.z, -1, 1)) > CREASE) return n;
      const y = n.y + other.y;
      const z = n.z + other.z;
      const l = Math.hypot(y, z);
      return { y: y / l, z: z / l };
    };
    normals.forEach((n, i) => {
      this.ends.push({ start: blend(n, normals[i - 1]), end: blend(n, normals[i + 1]) });
    });
  }

  get length(): number {
    return this.s[this.s.length - 1] as number;
  }

  /** The point and smooth normal a distance s along the run. */
  at(s: number): { point: ProfilePoint; normal: { y: number; z: number } } {
    let i = 0;
    while (i < this.ends.length - 1 && (this.s[i + 1] as number) < s) i++;
    const s0 = this.s[i] as number;
    const s1 = this.s[i + 1] as number;
    const t = s1 > s0 ? THREE.MathUtils.clamp((s - s0) / (s1 - s0), 0, 1) : 0;
    const a = this.points[i] as ProfilePoint;
    const b = this.points[i + 1] as ProfilePoint;
    const { start, end } = this.ends[i] as { start: { y: number; z: number }; end: { y: number; z: number } };
    const ny = start.y + (end.y - start.y) * t;
    const nz = start.z + (end.z - start.z) * t;
    const l = Math.hypot(ny, nz);
    return { point: { y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }, normal: { y: ny / l, z: nz / l } };
  }

  /** Distance along the run of the first point at height y, on the rising part; null if the run never reaches it. */
  sAtHeight(y: number): number | null {
    for (let i = 0; i + 1 < this.points.length; i++) {
      const a = this.points[i] as ProfilePoint;
      const b = this.points[i + 1] as ProfilePoint;
      if (a.y <= y && b.y >= y && b.y > a.y) return (this.s[i] as number) + ((this.s[i + 1] as number) - (this.s[i] as number)) * ((y - a.y) / (b.y - a.y));
    }
    return null;
  }
}

/** A 3D point and normal of a profile point on one side (sign +1 port, -1 starboard), at distance x along the cabin. */
function place(x: number, point: ProfilePoint, normal: { y: number; z: number }, sign: number): { p: THREE.Vector3; n: THREE.Vector3 } {
  return { p: new THREE.Vector3(x, point.y, sign * point.z), n: new THREE.Vector3(0, normal.y, sign * normal.z) };
}

/** A rounded rectangle (centre cx, cs; half sizes hw, hh; corner radius r) in the (x, s) plane, as a closed loop. */
function roundedRectangle(cx: number, cs: number, hw: number, hh: number, r: number): THREE.Vector2[] {
  const loop: THREE.Vector2[] = [];
  const corners: [number, number, number][] = [
    [cx + hw - r, cs - hh + r, -Math.PI / 2],
    [cx + hw - r, cs + hh - r, 0],
    [cx - hw + r, cs + hh - r, Math.PI / 2],
    [cx - hw + r, cs - hh + r, Math.PI],
  ];
  for (const [ox, os, a0] of corners) {
    for (let i = 0; i <= CORNER_STEPS; i++) {
      const a = a0 + ((Math.PI / 2) * i) / CORNER_STEPS;
      loop.push(new THREE.Vector2(ox + r * Math.cos(a), os + r * Math.sin(a)));
    }
  }
  return loop;
}

/**
 * One sidewall: the profile run extruded along the cabin, with a band around the windows cut into one panel per
 * window, each with a rounded-rectangle hole lined by a reveal and closed by a pane set WINDOW.depth outward.
 */
function sidewall(run: ProfileRun, length: number, windowXs: readonly number[], sign: number): THREE.BufferGeometry {
  const soup = new TriangleSoup();
  const wall = new THREE.Color(SHELL_COLOURS.wall);
  const reveal = new THREE.Color(SHELL_COLOURS.reveal);
  const pane = new THREE.Color(SHELL_COLOURS.pane);
  const vertex = (x: number, s: number): Vertex => {
    const { point, normal } = run.at(s);
    return { ...place(x, point, normal, sign), colour: wall, u: 0.25 };
  };
  // the band of segments the windows sit in, snapped out to profile points
  const centreS = run.sAtHeight(WINDOW.centreY);
  let bandFrom = run.ends.length;
  let bandTo = run.ends.length;
  if (centreS !== null && windowXs.length > 0) {
    const low = centreS - WINDOW.height / 2 - WINDOW_BAND_MARGIN;
    const high = centreS + WINDOW.height / 2 + WINDOW_BAND_MARGIN;
    bandFrom = Math.max(
      0,
      run.s.findLastIndex((s) => s <= low),
    );
    bandTo = run.s.findIndex((s) => s >= high);
    if (bandTo < 0) bandTo = run.ends.length;
  }
  // plain strips, one quad the length of the cabin per segment
  for (let i = 0; i < run.ends.length; i++) {
    if (i >= bandFrom && i < bandTo) continue;
    const a = run.points[i] as ProfilePoint;
    const b = run.points[i + 1] as ProfilePoint;
    const { start, end } = run.ends[i] as { start: { y: number; z: number }; end: { y: number; z: number } };
    const q = [place(0, a, start, sign), place(length, a, start, sign), place(length, b, end, sign), place(0, b, end, sign)].map((v) => ({
      ...v,
      colour: wall,
      u: 0.25,
    })) as [Vertex, Vertex, Vertex, Vertex];
    const outward = new THREE.Vector3(0, segmentNormal(a, b).y, sign * segmentNormal(a, b).z);
    soup.add(q[0], q[1], q[2], outward);
    soup.add(q[0], q[2], q[3], outward);
  }
  if (bandFrom >= bandTo) return soup.geometry(true);
  // the window band: one panel per window, from halfway to the previous window to halfway to the next
  const bandS = run.s.slice(bandFrom, bandTo + 1);
  windowXs.forEach((cx, k) => {
    const x0 = k === 0 ? 0 : (cx + (windowXs[k - 1] as number)) / 2;
    const x1 = k === windowXs.length - 1 ? length : (cx + (windowXs[k + 1] as number)) / 2;
    // the panel outline follows the profile points up its edges, so neighbouring panels and strips meet without cracks
    const contour = [...bandS.map((s) => new THREE.Vector2(x1, s)), ...bandS.toReversed().map((s) => new THREE.Vector2(x0, s))];
    const hole = roundedRectangle(cx, centreS as number, WINDOW.width / 2, WINDOW.height / 2, WINDOW.cornerRadius);
    const all = [...contour, ...hole];
    for (const [i, j, l] of THREE.ShapeUtils.triangulateShape(contour, [hole])) {
      const [a, b, c] = [all[i as number], all[j as number], all[l as number]] as [THREE.Vector2, THREE.Vector2, THREE.Vector2];
      const centroid = run.at((a.y + b.y + c.y) / 3).normal;
      soup.add(vertex(a.x, a.y), vertex(b.x, b.y), vertex(c.x, c.y), new THREE.Vector3(0, centroid.y, sign * centroid.z));
    }
    // reveal and pane: the hole outline pushed outward along the wall normal
    const centre = vertex(cx, centreS as number);
    const surface = hole.map((h) => vertex(h.x, h.y));
    const recessed = surface.map((v) => v.p.clone().addScaledVector(v.n, WINDOW.depth));
    const paneCentre = centre.p.clone().addScaledVector(centre.n, WINDOW.depth);
    // reveal and pane faces are flat: every corner takes the face's normal
    const flat = (p: THREE.Vector3, n: THREE.Vector3, colour: THREE.Color): Vertex => ({ p, n, colour, u: 0.25 });
    surface.forEach((v, i) => {
      const next = (i + 1) % surface.length;
      const w = surface[next] as Vertex;
      const quad = [v.p, w.p, recessed[next] as THREE.Vector3, recessed[i] as THREE.Vector3];
      // the reveal faces the window's axis; its outward side looks away from it
      const mid = quad.reduce((m, p) => m.add(p), new THREE.Vector3()).multiplyScalar(0.25);
      const toMid = mid.clone().sub(centre.p);
      const away = toMid.addScaledVector(centre.n, -toMid.dot(centre.n));
      const n = (quad[1] as THREE.Vector3)
        .clone()
        .sub(quad[0] as THREE.Vector3)
        .cross((quad[3] as THREE.Vector3).clone().sub(quad[0] as THREE.Vector3))
        .normalize();
      if (n.dot(away) < 0) n.negate();
      const [q0, q1, q2, q3] = quad.map((p) => flat(p, n, reveal)) as [Vertex, Vertex, Vertex, Vertex];
      soup.add(q0, q1, q2, away);
      soup.add(q0, q2, q3, away);
      soup.add(
        flat(paneCentre, centre.n, pane),
        flat(recessed[i] as THREE.Vector3, centre.n, pane),
        flat(recessed[next] as THREE.Vector3, centre.n, pane),
        centre.n,
      );
    });
  });
  return soup.geometry(true);
}

/** Both halves of the ceiling run extruded along the cabin; the light channel's top carries uv.x 0.75, the rest 0.25. */
function ceiling(run: ProfileRun, length: number): THREE.BufferGeometry {
  const soup = new TriangleSoup();
  const white = new THREE.Color("#ffffff");
  const inChannel = (p: ProfilePoint) => p.z >= LIGHT_CHANNEL_Z.from - 1e-9 && p.z <= LIGHT_CHANNEL_Z.to + 1e-9;
  for (const sign of [1, -1]) {
    for (let i = 0; i < run.ends.length; i++) {
      const a = run.points[i] as ProfilePoint;
      const b = run.points[i + 1] as ProfilePoint;
      // the channel's top, not its sides: both ends in the channel, and not vertical
      const u = inChannel(a) && inChannel(b) && Math.abs(b.z - a.z) > 1e-9 ? 0.75 : 0.25;
      const { start, end } = run.ends[i] as { start: { y: number; z: number }; end: { y: number; z: number } };
      const q = [place(0, a, start, sign), place(length, a, start, sign), place(length, b, end, sign), place(0, b, end, sign)].map((v) => ({
        ...v,
        colour: white,
        u,
      })) as [Vertex, Vertex, Vertex, Vertex];
      const n = segmentNormal(a, b);
      const outward = new THREE.Vector3(0, n.y, sign * n.z);
      soup.add(q[0], q[1], q[2], outward);
      soup.add(q[0], q[2], q[3], outward);
    }
  }
  return soup.geometry(false);
}

/** The full cross-section as a flat plate at each end of the cabin, in one geometry. */
function bulkheads(profile: ProfilePoint[], length: number): THREE.BufferGeometry {
  const port = profile.map((p) => new THREE.Vector2(p.z, p.y));
  const starboard = profile
    .slice(0, -1)
    .toReversed()
    .map((p) => new THREE.Vector2(-p.z, p.y));
  const plate = new THREE.ShapeGeometry(new THREE.Shape([...port, ...starboard]));
  // the shape's x is the cabin's z: turn it into the y-z plane
  plate.applyMatrix4(new THREE.Matrix4().makeRotationY(-Math.PI / 2));
  const ends = [0.02, length - 0.02].map((x) => plate.clone().translate(x, 0, 0));
  const merged = mergeGeometries(ends);
  plate.dispose();
  for (const e of ends) e.dispose();
  if (!merged) throw new Error("invariant: the bulkhead plates share their attributes");
  return merged;
}

/**
 * The shell for a cabin of this length, with a window at each of `windowXs`. The profile is split where the ceiling
 * begins: the first point inboard of the drawn bins and above them.
 */
export function buildShellGeometries(profile: ProfilePoint[], length: number, windowXs: readonly number[]): ShellGeometries {
  const split = profile.findIndex((p) => p.y > BIN_DRAWN_TOP && p.z < BIN_DRAWN_INNER_Z);
  if (split <= 0) throw new Error("invariant: the shell profile passes inboard over the bins");
  const wall = new ProfileRun(profile.slice(0, split + 1));
  const roof = new ProfileRun(profile.slice(split));
  return {
    left: sidewall(wall, length, windowXs, 1),
    right: sidewall(wall, length, windowXs, -1),
    ceiling: ceiling(roof, length),
    bulkheads: bulkheads(profile, length),
  };
}

/** The ceiling's own faint glow (sRGB level of the emissive map off the light channels): it lifts the downward-facing ceiling toward the pale, lit panels of the photographs. */
export const CEILING_GLOW = 96;

/** The ceiling's emissive map, 2 × 1: CEILING_GLOW on the left half, full on the right. The ceiling's uv.x picks the light channels out of it. */
export function lightChannelMask(): THREE.DataTexture {
  const g = CEILING_GLOW;
  const texture = new THREE.DataTexture(new Uint8Array([g, g, g, 255, 255, 255, 255, 255]), 2, 1, THREE.RGBAFormat);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}
