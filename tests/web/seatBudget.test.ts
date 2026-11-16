import type * as THREE from "three";
import { expect, test } from "vitest";
import { buildSeatGeometries, SEAT_TRIANGLE_BUDGET, seatTriangleCount } from "../../src/web/scene/seatParts.ts";

const triangles = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute("position").count) / 3;

// The seat geometry is profile-independent (PF-27): one build, one budget.
test("one seat is within the triangle budget", () => {
  expect(seatTriangleCount(buildSeatGeometries())).toBeLessThanOrEqual(SEAT_TRIANGLE_BUDGET);
});

test("the silhouette parts keep rounded edges", () => {
  const g = buildSeatGeometries();
  // a plain box is 12 triangles; the headrest, back cushion and pan keep more than that
  for (const part of [g.headrest, g.backCore, g.pan]) expect(triangles(part)).toBeGreaterThan(12);
});
