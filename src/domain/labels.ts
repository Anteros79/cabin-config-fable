import { formatDate, formatDatesIn } from "./dates.ts";
import type { Condition, DeferReason, DeferUntil, MelClass, ObservationOutcome } from "./types.ts";

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

/** Why a problem is no-go, in words: an expiry date is written as a date ("5 Nov 2026"), never as stored. */
function noGoReason(cls: Extract<MelClass, { class: "NO_GO" }>): string {
  return cls.expiredOn ? `${cls.reason} on ${formatDate(cls.expiredOn)}` : formatDatesIn(cls.reason);
}

/** What a class means for the aircraft, in words. */
export function melLabel(cls: MelClass): string {
  if (cls.class === "COSMETIC") return "Cosmetic: can wait";
  if (cls.class === "NO_GO") return `No-go: must be fixed before flight. ${noGoReason(cls)}`;
  const item = cls.item === TECH_RAISED_ITEM ? "MEL item" : `MEL item ${cls.item}`;
  return `${item} (category ${cls.category}, fix within ${cls.intervalDays} days): ${cls.conditions}`;
}

const DEFER_LABEL: Record<DeferUntil, string> = { NEXT_CHECK: "Until the next check", NEXT_STOP: "Until the next stop" };
export const deferLabel = (d: DeferUntil): string => DEFER_LABEL[d];

/** The outcome as a choice in the problem form ("Defer"). */
const OUTCOME_LABEL: Record<ObservationOutcome, string> = {
  NOTED: "Note only",
  DEFERRED: "Defer",
  MUST_FIX: "Must be fixed before flight",
  REPLACED: "Replaced",
  FIXED: "Fixed",
};
export const outcomeLabel = (o: ObservationOutcome): string => OUTCOME_LABEL[o];

/** The outcome as a problem's status, once written down ("Deferred"). */
const OUTCOME_STATUS_LABEL: Record<ObservationOutcome, string> = {
  NOTED: "Noted",
  DEFERRED: "Deferred",
  MUST_FIX: "Must be fixed",
  REPLACED: "Replaced",
  FIXED: "Fixed",
};
export const outcomeStatusLabel = (o: ObservationOutcome): string => OUTCOME_STATUS_LABEL[o];

const REASON_LABEL: Record<DeferReason, string> = { NO_STOCK: "No stock on hand", NO_TIME: "No time on this turn", OTHER: "Other" };
export const reasonLabel = (r: DeferReason): string => REASON_LABEL[r];
