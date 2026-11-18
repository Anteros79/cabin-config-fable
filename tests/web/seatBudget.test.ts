import { expect, test } from "vitest";
import budgets from "../../budgets.json" with { type: "json" };
import { buildSeatGeometries, geometryTriangles, seatTriangleCount } from "../../src/web/scene/seatParts.ts";

/** A plain box is 12 triangles. */
const PLAIN_BOX = 12;

// The seat geometry is profile-independent (PF-27): one build, one budget.
test("one seat is within the triangle budget", () => {
  expect(seatTriangleCount(buildSeatGeometries())).toBeLessThanOrEqual(budgets.scene.seatTriangles);
});

/** seatTriangleCount() with the pieces (2946 before VAC-10, when the budget was 3100) */
const SEAT_TRIANGLES = 2886;
/** measured in e2e/scene.spec.ts PF-21: 35 calls in cutaway + context, 496 642 triangles in carpet + context (before: 30 and 499 860) */
const DRAW_CALLS_176 = Math.ceil(35 * 1.1);
const TRIANGLES_176 = Math.ceil(496_642 * 1.1);

// Re-measured once with the tappable pieces (VAC-10): the measured values plus 10 %, under the hard caps of 48 draw calls
// and 700 000 triangles on the 176-seat layout. They do not drift after this task.
test("the scene budget is the one measured with every seat piece drawn", () => {
  const g = buildSeatGeometries();
  // one seat: its seven pieces, the legs and arm structures, one armrest pad, the tier overlay and the contact patch
  expect(seatTriangleCount(g)).toBe(SEAT_TRIANGLES);
  expect(budgets.scene.seatTriangles).toBe(Math.ceil(SEAT_TRIANGLES * 1.1));
  expect(budgets.scene).toEqual({ drawCalls176: DRAW_CALLS_176, triangles176: TRIANGLES_176, seatTriangles: Math.ceil(SEAT_TRIANGLES * 1.1) });
  expect(budgets.scene.drawCalls176).toBeLessThanOrEqual(48);
  expect(budgets.scene.triangles176).toBeLessThanOrEqual(700_000);
  for (const piece of ["belt", "tray", "net", "vest", "armPad"] as const) expect(geometryTriangles(g[piece]), piece).toBeGreaterThanOrEqual(PLAIN_BOX);
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
