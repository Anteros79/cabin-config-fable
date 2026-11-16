import { expect, test } from "vitest";
import { buildSeatGeometries, geometryTriangles, SEAT_TRIANGLE_BUDGET, seatTriangleCount } from "../../src/web/scene/seatParts.ts";

/** A plain box is 12 triangles. */
const PLAIN_BOX = 12;

// The seat geometry is profile-independent (PF-27): one build, one budget.
test("one seat is within the triangle budget", () => {
  expect(seatTriangleCount(buildSeatGeometries())).toBeLessThanOrEqual(SEAT_TRIANGLE_BUDGET);
});

test("the silhouette parts keep rounded edges", () => {
  const g = buildSeatGeometries();
  // Each part must have more triangles than the same number of plain boxes would: the headrest is a centre pad and two
  // wings (3 boxes), the pan one box, and the back cushion a lofted box.
  const parts = [
    { name: "headrest", geometry: g.headrest, boxes: 3 },
    { name: "pan", geometry: g.pan, boxes: 1 },
    { name: "backCore", geometry: g.backCore, boxes: 1 },
  ];
  for (const { name, geometry, boxes } of parts) expect(geometryTriangles(geometry), name).toBeGreaterThan(boxes * PLAIN_BOX);
});
