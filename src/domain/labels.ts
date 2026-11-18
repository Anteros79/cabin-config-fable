import { formatDate, formatDatesIn } from "./dates.ts";
import { melEntryFor } from "./observations.ts";
import type { Condition, DeferReason, DeferUntil, MelClass, MelEntry, ObservationOutcome } from "./types.ts";

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

const CONDITION_ORDER: readonly Condition[] = ["STAINED", "TORN", "WORN", "BROKEN", "MISSING", "WONT_LATCH", "OTHER"];

/** "Broken", "Broken or Missing", "Broken, Missing or Won't latch". */
function either(conditions: readonly Condition[]): string {
  const words = conditions.map(conditionLabel);
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

/**
 * What the MEL says about a piece, in one plain line, before any condition is chosen: "Usually cosmetic; Broken or
 * Missing is an MEL item (fix within 120 days)", "No-go if Missing". Read from the entries that apply on `variant`.
 * Null when the MEL lists nothing for the piece.
 */
export function melSummary(mel: readonly MelEntry[], componentId: string, variant: string): string | null {
  const cosmetic: Condition[] = [];
  const noGo: Condition[] = [];
  const byInterval = new Map<number, Condition[]>();
  const blockedMel: Condition[] = [];
  for (const condition of CONDITION_ORDER) {
    const entry = melEntryFor([...mel], componentId, condition, variant);
    if (!entry) continue;
    const cls = entry.result;
    if (cls.class === "COSMETIC") cosmetic.push(condition);
    else if (cls.class === "NO_GO") {
      noGo.push(condition);
      if (entry.whenSeatBlocked?.class === "MEL") blockedMel.push(condition);
    } else byInterval.set(cls.intervalDays, [...(byInterval.get(cls.intervalDays) ?? []), condition]);
  }
  if (cosmetic.length + noGo.length + byInterval.size === 0) return null;
  if (noGo.length === 0 && byInterval.size === 0) return "Cosmetic: can wait";
  const parts: string[] = cosmetic.length > 0 ? ["Usually cosmetic"] : [];
  for (const [days, conditions] of [...byInterval].sort(([a], [b]) => a - b)) {
    parts.push(`${either(conditions)} is an MEL item (fix within ${days} days)`);
  }
  if (noGo.length > 0) {
    const whileBlocked = blockedMel.length > 0 ? " (an MEL item while the seat is blocked)" : "";
    parts.push(`${parts.length === 0 ? "No-go" : "no-go"} if ${either(noGo)}${whileBlocked}`);
  }
  return parts.join("; ");
}
