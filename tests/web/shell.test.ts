import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  AFT_MARGIN,
  BIN_DRAWN_INNER_Z,
  BIN_DRAWN_TOP,
  cabinLength,
  FORWARD_MARGIN,
  LIGHT_CHANNEL_Z,
  ROW_PITCH,
  shellProfile,
} from "../../src/domain/geometry.ts";
import { buildBinGeometry } from "../../src/web/scene/seatParts.ts";
import { buildShellGeometries, WINDOW } from "../../src/web/scene/shell.ts";

// the 176-seat layout: 30 physical rows, 26 m
const rows = 30;
const length = cabinLength(rows);
const windowXs = Array.from({ length: Math.round((length - FORWARD_MARGIN - AFT_MARGIN) / ROW_PITCH) }, (_, i) => FORWARD_MARGIN + (i + 0.5) * ROW_PITCH);
const shell = buildShellGeometries(shellProfile(), length, windowXs);
const triangles = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute("position").count) / 3;

describe("cabin shell geometry (WEB-21)", () => {
  it("has a window per row pitch and stays within the 25,000-triangle budget on the 176-seat layout", () => {
    expect(windowXs).toHaveLength(rows);
    const total = Object.values(shell).reduce((n, g) => n + triangles(g), 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(25_000);
  });

  it("each sidewall stays on its own side and spans the cabin", () => {
    for (const [g, sign] of [
      [shell.left, 1],
      [shell.right, -1],
    ] as const) {
      g.computeBoundingBox();
      const box = g.boundingBox as THREE.Box3;
      expect(box.min.x).toBeCloseTo(0, 9);
      expect(box.max.x).toBeCloseTo(length, 9);
      if (sign > 0) expect(box.min.z).toBeGreaterThan(0);
      else expect(box.max.z).toBeLessThan(0);
    }
  });

  it("BIN_DRAWN_TOP and BIN_DRAWN_INNER_Z bound the drawn bin of every type, shut and open inside, and the shell profile stays outside it", () => {
    const box = new THREE.Box3();
    for (const binType of ["CLASSIC", "PIVOT", "LARGE_PIVOT"] as const) {
      const { door, closedBody, openBody, interior } = buildBinGeometry(1, binType);
      for (const g of [door, closedBody, openBody, ...Object.values(interior)]) {
        g.computeBoundingBox();
        box.union(g.boundingBox as THREE.Box3);
      }
    }
    // float32 positions
    expect(box.max.y).toBeCloseTo(BIN_DRAWN_TOP, 6);
    expect(box.min.z).toBeGreaterThanOrEqual(BIN_DRAWN_INNER_Z);
    for (const p of shellProfile()) {
      const inside = p.y >= box.min.y && p.y <= box.max.y && p.z >= box.min.z && p.z <= box.max.z;
      expect(inside, `y ${p.y.toFixed(3)}, z ${p.z.toFixed(3)}`).toBe(false);
    }
  });

  it("every triangle is wound the way its normals face, so back faces are the inside of the shell", () => {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (const indexed of [shell.left, shell.right, shell.ceiling, shell.bulkheads]) {
      const g = indexed.index ? indexed.toNonIndexed() : indexed;
      const p = g.getAttribute("position");
      const n = g.getAttribute("normal");
      for (let i = 0; i < p.count; i += 3) {
        a.fromBufferAttribute(p, i);
        b.fromBufferAttribute(p, i + 1);
        c.fromBufferAttribute(p, i + 2);
        const face = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
        const normal = new THREE.Vector3().fromBufferAttribute(n, i);
        expect(face.dot(normal), `triangle ${i / 3}`).toBeGreaterThan(0);
      }
    }
    // on the port sidewall at window height, the plain wall faces +z (outward)
    const p = shell.left.getAttribute("position");
    const n = shell.left.getAttribute("normal");
    for (let i = 0; i < p.count; i++) {
      if (Math.abs(p.getY(i) - 0.6) < 0.05) expect(n.getZ(i)).toBeGreaterThan(0.9);
    }
  });

  it("windows are recessed outward by their depth", () => {
    const p = shell.left.getAttribute("position");
    let deepest = 0;
    for (let i = 0; i < p.count; i++) deepest = Math.max(deepest, p.getZ(i));
    // the arc bulges to 1.9 m; the panes sit up to WINDOW.depth beyond it
    expect(deepest).toBeGreaterThan(1.88 + WINDOW.depth * 0.8);
  });

  it("the ceiling marks only its light channels for the emissive map", () => {
    const p = shell.ceiling.getAttribute("position");
    const uv = shell.ceiling.getAttribute("uv");
    const lit = { port: 0, starboard: 0 };
    for (let i = 0; i < p.count; i++) {
      if (uv.getX(i) > 0.5) {
        lit[p.getZ(i) > 0 ? "port" : "starboard"] += 1;
        expect(Math.abs(p.getZ(i))).toBeGreaterThanOrEqual(LIGHT_CHANNEL_Z.from - 1e-6);
        expect(Math.abs(p.getZ(i))).toBeLessThanOrEqual(LIGHT_CHANNEL_Z.to + 1e-6);
      }
    }
    // whole quads (six vertices each), the same on both sides
    expect(lit.port).toBeGreaterThan(0);
    expect(lit.port % 6).toBe(0);
    expect(lit.starboard).toBe(lit.port);
  });
});
