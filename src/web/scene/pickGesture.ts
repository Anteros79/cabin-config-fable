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
