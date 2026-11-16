/**
 * Camera motion without a renderer (WEB-21): easing, the arc a preset change travels, the box the orbit target stays in,
 * how long a move takes and the pose that frames one location. three.js math classes only, so it is tested on its own.
 */
import * as THREE from "three";
import type { LocationKind } from "../../domain/types.ts";

export interface CameraPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

/** The cabin box: x from 0 to length (fore to aft), z from -halfWidth to halfWidth, y from the floor (0) to height. */
export interface CabinBounds {
  length: number;
  halfWidth: number;
  height: number;
}

/** How far outside the cabin box the orbit target may go. */
export const TARGET_MARGIN = 0.5;
export const TRANSITION_MIN_MS = 250;
export const TRANSITION_MAX_MS = 700;
/** Added per metre the camera and its target travel together. */
const TRANSITION_MS_PER_METRE = 18;
/** How far back from a seat poseToFrame() puts the camera. */
export const SEAT_FRAME_DISTANCE = 2.2;
/** A floor area is framed from at least this far, and further for a long one (36° field of view). */
const FLOOR_FRAME_MIN_DISTANCE = 2.5;
const FLOOR_FRAME_DISTANCE_PER_METRE = 1.3;

export function easeInOutCubic(t: number): number {
  const x = Math.min(Math.max(t, 0), 1);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/**
 * The pose a fraction t of the way from one pose to another. The target moves in a straight line; the camera swings
 * round it (angle and distance interpolated, the short way round), so it never cuts through the cabin between two poses
 * that look into it, and stays above the target when both endpoints are.
 */
export function interpolatePose(from: CameraPose, to: CameraPose, t: number): CameraPose {
  const target = from.target.clone().lerp(to.target, t);
  const a = new THREE.Spherical().setFromVector3(from.position.clone().sub(from.target));
  const b = new THREE.Spherical().setFromVector3(to.position.clone().sub(to.target));
  // a camera straight above or below its target has no meaningful azimuth: take the other end's
  if (a.radius < 1e-9 || a.phi < 1e-6 || Math.PI - a.phi < 1e-6) a.theta = b.theta;
  if (b.radius < 1e-9 || b.phi < 1e-6 || Math.PI - b.phi < 1e-6) b.theta = a.theta;
  let dTheta = b.theta - a.theta;
  if (dTheta > Math.PI) dTheta -= 2 * Math.PI;
  if (dTheta < -Math.PI) dTheta += 2 * Math.PI;
  const s = new THREE.Spherical(a.radius + (b.radius - a.radius) * t, a.phi + (b.phi - a.phi) * t, a.theta + dTheta * t);
  const position = new THREE.Vector3().setFromSpherical(s).add(target);
  // exact endpoints, free of the round trip through spherical coordinates
  if (t <= 0) return { position: from.position.clone(), target: from.target.clone() };
  if (t >= 1) return { position: to.position.clone(), target: to.target.clone() };
  return { position, target };
}

/** The target moved the least distance into the cabin box grown by half a metre on every side. A new vector. */
export function clampTarget(target: THREE.Vector3, bounds: CabinBounds): THREE.Vector3 {
  const m = TARGET_MARGIN;
  return new THREE.Vector3(
    THREE.MathUtils.clamp(target.x, -m, bounds.length + m),
    THREE.MathUtils.clamp(target.y, -m, bounds.height + m),
    THREE.MathUtils.clamp(target.z, -bounds.halfWidth - m, bounds.halfWidth + m),
  );
}

/** The lowest the camera may go: just above the floor. */
export const MIN_CAMERA_HEIGHT = 0.1;

/**
 * A pose kept in bounds: the target clamped into the cabin box (the camera moves by as much, so the view does not turn)
 * and the camera no lower than just above the floor, which a target under the floor could otherwise take it to. New vectors.
 */
export function boundPose(pose: CameraPose, bounds: CabinBounds): CameraPose {
  const target = clampTarget(pose.target, bounds);
  const position = pose.position.clone().add(target.clone().sub(pose.target));
  if (position.y < MIN_CAMERA_HEIGHT) position.y = MIN_CAMERA_HEIGHT;
  return { position, target };
}

/** 0 with reduced motion: the camera cuts. Otherwise 250 ms, plus a little per metre travelled, up to 700 ms. */
export function transitionMs(from: CameraPose, to: CameraPose, reducedMotion: boolean): number {
  if (reducedMotion) return 0;
  const metres = from.position.distanceTo(to.position) + from.target.distanceTo(to.target);
  return Math.round(THREE.MathUtils.clamp(TRANSITION_MIN_MS + metres * TRANSITION_MS_PER_METRE, TRANSITION_MIN_MS, TRANSITION_MAX_MS));
}

/**
 * A view of one location from the aisle side (WEB-21). `location` is its placement point: for a seat the floor under
 * it, for a floor area its middle (and `lx`, its length), for a bin module the bottom of its door.
 * - A seat: three-quarter from the front and the aisle, from standing height, 2.2 m back from its middle.
 * - A floor area: from above and in front, far enough back to take in its length.
 * - A bin module: across the aisle, from just above its own height (the camera never looks up).
 */
export function poseToFrame(location: { x: number; y: number; z: number; lx?: number }, kind: LocationKind, bounds: CabinBounds): CameraPose {
  // toward the aisle: a seat or bin on +z is seen from -z of it, and the other way round
  const toAisle = location.z > 0 ? -1 : 1;
  let target: THREE.Vector3;
  let direction: THREE.Vector3;
  let distance: number;
  if (kind === "SEAT") {
    target = new THREE.Vector3(location.x + 0.12, location.y + 0.86, location.z);
    direction = new THREE.Vector3(-0.8, 0.4, toAisle * 0.42);
    distance = SEAT_FRAME_DISTANCE;
  } else if (kind === "FLOOR") {
    target = new THREE.Vector3(location.x, location.y, location.z);
    direction = new THREE.Vector3(-0.35, 1, 0.5);
    distance = Math.max(FLOOR_FRAME_MIN_DISTANCE, (location.lx ?? 0) * FLOOR_FRAME_DISTANCE_PER_METRE);
  } else {
    target = new THREE.Vector3(location.x, location.y + 0.24, location.z + toAisle * 0.14);
    direction = new THREE.Vector3(-0.75, 0.06, toAisle * 0.65);
    distance = SEAT_FRAME_DISTANCE;
  }
  target = clampTarget(target, bounds);
  return { position: target.clone().addScaledVector(direction.normalize(), distance), target };
}
