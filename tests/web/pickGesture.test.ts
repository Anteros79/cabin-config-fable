import { expect, test } from "vitest";
import { PICK_MAX_MOVE_PX, PICK_MAX_MS, PickGesture, type PointerSample } from "../../src/web/scene/pickGesture.ts";

const sample = (over: Partial<PointerSample> = {}): PointerSample => ({ pointerId: 1, button: 0, isPrimary: true, x: 100, y: 100, time: 1000, ...over });

test("a primary left click picks", () => {
  const g = new PickGesture();
  g.down(sample());
  g.move(sample({ x: 102, y: 101, time: 1050 }));
  expect(g.up(sample({ x: 102, y: 101, time: 1100 }))).toEqual({ x: 102, y: 101 });
});

test.each([
  ["right button", { button: 2 }],
  ["middle button", { button: 1 }],
  ["non-primary pointer", { isPrimary: false }],
])("%s does not pick", (_name, over) => {
  const g = new PickGesture();
  g.down(sample(over));
  expect(g.up(sample({ ...over, time: 1100 }))).toBeNull();
});

test("lifting one finger at the end of a pinch does not pick", () => {
  const g = new PickGesture();
  g.down(sample({ pointerId: 1 }));
  g.down(sample({ pointerId: 2, isPrimary: false, x: 200, time: 1020 }));
  expect(g.up(sample({ pointerId: 2, isPrimary: false, x: 200, time: 1200 }))).toBeNull();
  expect(g.up(sample({ pointerId: 1, time: 1250 }))).toBeNull();
});

test("the first finger lifting before the second does not pick either", () => {
  const g = new PickGesture();
  g.down(sample({ pointerId: 1 }));
  g.down(sample({ pointerId: 2, isPrimary: false, x: 200, time: 1020 }));
  expect(g.up(sample({ pointerId: 1, time: 1200 }))).toBeNull();
  expect(g.up(sample({ pointerId: 2, isPrimary: false, x: 200, time: 1250 }))).toBeNull();
});

test("an up from a different pointer does not pick", () => {
  const g = new PickGesture();
  g.down(sample({ pointerId: 1 }));
  expect(g.up(sample({ pointerId: 7, time: 1100 }))).toBeNull();
});

test("a drag beyond 5 px does not pick, even when it returns to the start", () => {
  const g = new PickGesture();
  g.down(sample());
  g.move(sample({ x: 100 + PICK_MAX_MOVE_PX + 1, time: 1050 }));
  expect(g.up(sample({ time: 1100 }))).toBeNull();

  g.down(sample({ time: 2000 }));
  expect(g.up(sample({ x: 104, y: 103, time: 2100 }))).toEqual({ x: 104, y: 103 });
  g.down(sample({ time: 3000 }));
  expect(g.up(sample({ x: 104, y: 104, time: 3100 }))).toBeNull();
});

test("a long press does not pick", () => {
  const g = new PickGesture();
  g.down(sample());
  expect(g.up(sample({ time: 1000 + PICK_MAX_MS + 1 }))).toBeNull();
  g.down(sample({ time: 5000 }));
  expect(g.up(sample({ time: 5000 + PICK_MAX_MS }))).toEqual({ x: 100, y: 100 });
});

test("pointercancel clears the gesture", () => {
  const g = new PickGesture();
  g.down(sample());
  g.cancel();
  expect(g.up(sample({ time: 1100 }))).toBeNull();
  // the next tap is a fresh gesture
  g.down(sample({ time: 2000 }));
  expect(g.up(sample({ time: 2100 }))).toEqual({ x: 100, y: 100 });
});

test("a new primary press starts a fresh gesture even if an earlier up was lost", () => {
  const g = new PickGesture();
  g.down(sample({ pointerId: 1 }));
  g.down(sample({ pointerId: 2, isPrimary: false }));
  // both ups lost (for example released outside the window); a new primary touch begins
  g.down(sample({ pointerId: 3, time: 4000 }));
  expect(g.up(sample({ pointerId: 3, time: 4100 }))).toEqual({ x: 100, y: 100 });
});

test("moves from other pointers do not count against the primary", () => {
  const g = new PickGesture();
  g.down(sample());
  g.move(sample({ pointerId: 9, x: 400, time: 1050 }));
  expect(g.up(sample({ time: 1100 }))).toEqual({ x: 100, y: 100 });
});
