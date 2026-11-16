/**
 * Decides whether a pointer sequence on the canvas is a pick (a short, still, primary left press) or part of a camera
 * gesture. A right click, a drag, a long press or the end of a pinch never picks (WEB-12). No three.js here, so it is
 * tested on its own.
 */

export interface PointerSample {
  pointerId: number;
  button: number;
  isPrimary: boolean;
  x: number;
  y: number;
  time: number;
}

/** Largest distance, in CSS pixels, the pointer may travel from where it went down and still pick. */
export const PICK_MAX_MOVE_PX = 5;
/** Longest press, in milliseconds, that still picks. */
export const PICK_MAX_MS = 600;

export class PickGesture {
  /** pointers currently down on the canvas */
  private readonly active = new Set<number>();
  /** the press that may become a pick; null once the gesture can no longer pick */
  private candidate: PointerSample | null = null;

  down(p: PointerSample): void {
    // A primary pointer only goes down when no other pointer of its type is down, so it always starts a fresh gesture,
    // even if an earlier up was lost.
    if (p.isPrimary) this.active.clear();
    this.active.add(p.pointerId);
    this.candidate = this.active.size === 1 && p.isPrimary && p.button === 0 ? p : null;
  }

  move(p: PointerSample): void {
    const c = this.candidate;
    if (c && p.pointerId === c.pointerId && Math.hypot(p.x - c.x, p.y - c.y) > PICK_MAX_MOVE_PX) this.candidate = null;
  }

  up(p: PointerSample): { x: number; y: number } | null {
    this.active.delete(p.pointerId);
    const c = this.candidate;
    // Any up ends the chance of a pick: the candidate's own up decides it; another pointer's up means more than one was down.
    this.candidate = null;
    if (!c || p.pointerId !== c.pointerId) return null;
    if (Math.hypot(p.x - c.x, p.y - c.y) > PICK_MAX_MOVE_PX) return null;
    if (p.time - c.time > PICK_MAX_MS) return null;
    return { x: p.x, y: p.y };
  }

  cancel(): void {
    this.active.clear();
    this.candidate = null;
  }
}

/** A one-finger touch must move this far, in CSS pixels, before it is known whether it scrolls the page or orbits. */
export const TOUCH_AXIS_SLOP_PX = 8;

/**
 * Who gets a one-finger touch drag on the canvas (WEB-21). The canvas has `touch-action: pan-y`, so the browser scrolls
 * the page on a vertical drag, but it may deliver a few moves before it decides. A mostly vertical drag is the page's: the
 * camera sees none of it. A mostly sideways drag orbits. Until the finger has moved far enough to tell, the camera sees
 * nothing. With two fingers down the camera sees everything (pinch and pan).
 */
export class TouchAxisLock {
  private readonly touches = new Map<number, { x: number; y: number }>();
  private owner: "page" | "camera" | null = null;

  down(p: { pointerId: number; x: number; y: number }): void {
    this.touches.set(p.pointerId, { x: p.x, y: p.y });
    this.owner = this.touches.size > 1 ? "camera" : null;
  }

  /** Whether the camera may see this move. */
  move(p: { pointerId: number; x: number; y: number }): boolean {
    const start = this.touches.get(p.pointerId);
    if (!start) return true;
    if (this.owner === null) {
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      if (Math.hypot(dx, dy) < TOUCH_AXIS_SLOP_PX) return false;
      this.owner = Math.abs(dy) > Math.abs(dx) ? "page" : "camera";
    }
    return this.owner === "camera";
  }

  up(p: { pointerId: number }): void {
    this.touches.delete(p.pointerId);
    if (this.touches.size === 0) this.owner = null;
  }

  cancel(): void {
    this.touches.clear();
    this.owner = null;
  }
}
