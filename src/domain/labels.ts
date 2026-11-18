import type { Condition, DeferUntil, MelClass } from "./types.ts";

/** A problem's condition in words; the code stays in the data. */
const CONDITION_LABEL: Record<Condition, string> = {
  STAINED: "Stained",
  TORN: "Torn",
  WORN: "Worn",
  BROKEN: "Broken",
  MISSING: "Missing",
  WONT_LATCH: "Won't latch",
  OTHER: "Other",
};
export const conditionLabel = (c: Condition): string => CONDITION_LABEL[c];

/** The item the class takes when a technician raises a problem to MEL: it names no MEL item of its own. */
const TECH_RAISED_ITEM = "TECH-RAISED";

/** What a class means for the aircraft, in words. */
export function melLabel(cls: MelClass): string {
  if (cls.class === "COSMETIC") return "Cosmetic: can wait";
  if (cls.class === "NO_GO") return `No-go: must be fixed before flight. ${cls.reason}`;
  const item = cls.item === TECH_RAISED_ITEM ? "MEL item" : `MEL item ${cls.item}`;
  return `${item} (category ${cls.category}, fix within ${cls.intervalDays} days): ${cls.conditions}`;
}

const DEFER_LABEL: Record<DeferUntil, string> = { NEXT_CHECK: "Until the next check", NEXT_STOP: "Until the next stop" };
export const deferLabel = (d: DeferUntil): string => DEFER_LABEL[d];
