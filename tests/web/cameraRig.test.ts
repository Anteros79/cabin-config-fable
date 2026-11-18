import * as THREE from "three";
import { expect, test } from "vitest";
import {
  boundPose,
  type CabinBounds,
  type CameraPose,
  clampTarget,
  easeInOutCubic,
  interpolatePose,
  MIN_CAMERA_HEIGHT,
  NOMINAL_FRAME_MS,
  ORBIT_DAMPING,
  orbitDampingFor,
  poseToFrame,
  TRANSITION_MAX_MS,
  TRANSITION_MIN_MS,
  transitionMs,
} from "../../src/web/scene/cameraRig.ts";

const bounds: CabinBounds = { length: 26, halfWidth: 1.76, height: 2.3 };
const pose = (position: [number, number, number], target: [number, number, number]): CameraPose => ({
  position: new THREE.Vector3(...position),
  target: new THREE.Vector3(...target),
});
// The scene's overhead preset (fitted from almost straight above the middle of the cabin) and its aisle preset.
const overhead = pose([13, 36, 4.3], [13, 0, 0]);
const aisle = pose([0.2, 1.78, 0], [7, 0.85, 0]);

test("easeInOutCubic: 0 → 0, 1 → 1, 0.5 → 0.5, monotonic", () => {
  expect(easeInOutCubic(0)).toBe(0);
  expect(easeInOutCubic(1)).toBe(1);
  expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
  let previous = -1;
  for (let i = 0; i <= 100; i++) {
    const v = easeInOutCubic(i / 100);
    expect(v).toBeGreaterThanOrEqual(previous);
    previous = v;
  }
  // eased: slow at both ends
  expect(easeInOutCubic(0.1)).toBeLessThan(0.1);
  expect(easeInOutCubic(0.9)).toBeGreaterThan(0.9);
});

test("interpolatePose at 0 and 1 returns the endpoints", () => {
  const start = interpolatePose(overhead, aisle, 0);
  const end = interpolatePose(overhead, aisle, 1);
  expect(start.position.distanceTo(overhead.position)).toBeLessThan(1e-9);
  expect(start.target.distanceTo(overhead.target)).toBeLessThan(1e-9);
  expect(end.position.distanceTo(aisle.position)).toBeLessThan(1e-9);
  expect(end.target.distanceTo(aisle.target)).toBeLessThan(1e-9);
  // the endpoints are not modified
  expect(overhead.position.toArray()).toEqual([13, 36, 4.3]);
});

test("the interpolated camera stays above the floor and above its target between two valid poses, on an arc rather than the straight line", () => {
  for (const [from, to] of [
    [overhead, aisle],
    [aisle, overhead],
  ] as const) {
    let straightLineDipsLower = false;
    for (let i = 0; i <= 50; i++) {
      const t = i / 50;
      const p = interpolatePose(from, to, t);
      expect(p.position.y, `step ${i}`).toBeGreaterThanOrEqual(0.3);
      // the camera stays above its target: it never looks up from under the cabin
      expect(p.position.y).toBeGreaterThanOrEqual(p.target.y);
      const straight = from.position.clone().lerp(to.position, t);
      if (p.position.distanceTo(straight) > 0.5) straightLineDipsLower = true;
    }
    // an arc around the target, not the straight line through the cabin
    expect(straightLineDipsLower).toBe(true);
  }
});

test("interpolatePose turns the short way round the target", () => {
  const a = pose([10, 2, 3], [10, 0, 0]);
  const b = pose([10, 2, -3], [10, 0, 0]);
  // half way between +z and -z the short way is through +x or -x, never straight through the target
  const mid = interpolatePose(a, b, 0.5);
  expect(mid.position.distanceTo(mid.target)).toBeCloseTo(a.position.distanceTo(a.target), 6);
});

test("clampTarget keeps the target within bounds plus half a metre", () => {
  const inside = new THREE.Vector3(10, 1, 0.5);
  expect(clampTarget(inside, bounds).toArray()).toEqual([10, 1, 0.5]);
  expect(clampTarget(new THREE.Vector3(-40, -3, 9), bounds).toArray()).toEqual([-0.5, -0.5, 2.26]);
  expect(clampTarget(new THREE.Vector3(80, 12, -9), bounds).toArray()).toEqual([26.5, 2.8, -2.26]);
  // a new vector: the argument is not changed
  const outside = new THREE.Vector3(99, 0, 0);
  clampTarget(outside, bounds);
  expect(outside.x).toBe(99);
});

test("transitionMs is 0 with reduced motion and between 250 and 700 otherwise", () => {
  expect(TRANSITION_MIN_MS).toBe(250);
  expect(TRANSITION_MAX_MS).toBe(700);
  expect(transitionMs(overhead, aisle, true)).toBe(0);
  const near = pose([0.3, 1.78, 0], [7, 0.85, 0]);
  const short = transitionMs(aisle, near, false);
  const long = transitionMs(overhead, aisle, false);
  for (const ms of [short, long, transitionMs(aisle, aisle, false)]) {
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThanOrEqual(700);
  }
  // scaled by distance
  expect(long).toBeGreaterThan(short);
});

test("poseToFrame looks at the location from the aisle side", () => {
  for (const z of [1.42, 0.48, -0.48, -1.42]) {
    const seat = { x: 5, y: 0, z };
    const p = poseToFrame(seat, "SEAT", bounds);
    // looks at the seat
    expect(Math.abs(p.target.x - seat.x)).toBeLessThan(0.3);
    expect(p.target.z).toBeCloseTo(z, 6);
    // from the aisle side: the camera is nearer the centreline than the seat, and from the front (lower x)
    expect(Math.abs(p.position.z)).toBeLessThan(Math.abs(z));
    expect(Math.sign(z - p.position.z)).toBe(Math.sign(z));
    expect(p.position.x).toBeLessThan(p.target.x);
    // a three-quarter view from above, 2.2 m back
    expect(p.position.y).toBeGreaterThan(p.target.y);
    expect(p.position.distanceTo(p.target)).toBeCloseTo(2.2, 6);
  }
  // a bin is seen across the aisle, from just above its own height
  const bin = poseToFrame({ x: 7, y: 1.66, z: 1.29 }, "BIN", bounds);
  expect(bin.position.z).toBeLessThan(0.7);
  expect(bin.position.y).toBeGreaterThan(bin.target.y);
  // a floor area from above, far enough back to see its length
  const floor = poseToFrame({ x: 11, y: 0, z: 0 }, "FLOOR", bounds);
  expect(floor.position.y).toBeGreaterThan(2);
  // every target is inside the bounds
  for (const p of [bin, floor, poseToFrame({ x: 40, y: 0, z: 0 }, "SEAT", bounds)]) {
    expect(clampTarget(p.target, bounds).distanceTo(p.target)).toBe(0);
  }
});

test("boundPose moves the camera with a clamped target and keeps it above the floor", () => {
  // in bounds: unchanged
  const inside = boundPose(aisle, bounds);
  expect(inside.position.toArray()).toEqual(aisle.position.toArray());
  expect(inside.target.toArray()).toEqual(aisle.target.toArray());
  // a target past the aft end comes back, and the camera with it: the view does not turn
  const panned = pose([35, 3, 0], [33, 1, 0]);
  const back = boundPose(panned, bounds);
  expect(back.target.toArray()).toEqual([26.5, 1, 0]);
  expect(back.position.toArray()).toEqual([28.5, 3, 0]);
  // a camera that a target half a metre under the floor would put below it is lifted to just above the floor
  const low = boundPose(pose([5, -0.45, 2], [6, -0.5, 0]), bounds);
  expect(MIN_CAMERA_HEIGHT).toBe(0.1);
  expect(low.position.y).toBe(MIN_CAMERA_HEIGHT);
  expect(low.target.y).toBe(-0.5);
  // new vectors: the pose passed in is not changed
  expect(panned.target.x).toBe(33);
});

test("orbitDampingFor: the glide after a drag lasts a time, not a number of frames", () => {
  // 60 Hz and faster: the share of one frame, as before
  expect(orbitDampingFor(NOMINAL_FRAME_MS)).toBeCloseTo(ORBIT_DAMPING, 12);
  expect(orbitDampingFor(4)).toBeCloseTo(ORBIT_DAMPING, 12);
  expect(orbitDampingFor(0)).toBeCloseTo(ORBIT_DAMPING, 12);
  // a frame as long as two spends what two would
  expect(1 - orbitDampingFor(2 * NOMINAL_FRAME_MS)).toBeCloseTo((1 - ORBIT_DAMPING) ** 2, 12);
  // a second of glide is left in the same share whether it takes 60 frames, 5 or 1
  const left = (frameMs: number, frames: number) => (1 - orbitDampingFor(frameMs)) ** frames;
  expect(left(1000 / 5, 5)).toBeCloseTo(left(NOMINAL_FRAME_MS, 60), 12);
  expect(left(1000, 1)).toBeCloseTo(left(NOMINAL_FRAME_MS, 60), 12);
  // a long frame spends nearly all of it, and never more
  expect(orbitDampingFor(1000)).toBeGreaterThan(0.999);
  expect(orbitDampingFor(60_000)).toBeLessThanOrEqual(1);
});
