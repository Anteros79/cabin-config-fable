import type { DeferReason, DeferUntil, FindingSeverity, LookupState, MelClass, ObservationOutcome } from "../domain/types.ts";

/**
 * How the interface writes dates, times, states and counts (WEB-21). One fixed form, en-GB, whatever the browser's
 * language: "12 Nov 2026" and "12 Nov 2026, 14:05 UTC". Instants are shown in UTC unless a zone is passed, and the zone
 * is always written. Calendar dates are never converted through a time zone, so a check date cannot move a day.
 * The machine value stays available: views put a timestamp in `<time dateTime={iso} title={iso}>`.
 */

/** Fixed three-letter months, so September is "Sep" on every ICU version. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "12 Nov 2026" from "2026-11-12". Read from the text itself, never through a Date, so no zone can shift it. */
export function formatDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  if (!m || !month) return isoDate;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/** "12 Nov 2026, 14:05 UTC": the instant in `timeZone` (UTC by default), with the zone named. */
export function formatDateTime(iso: string, timeZone = "UTC"): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const zone = timeZone === "UTC" ? "UTC" : part("timeZoneName");
  return `${Number(part("day"))} ${MONTHS[Number(part("month")) - 1]} ${part("year")}, ${part("hour")}:${part("minute")} ${zone}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** "just now", "5 min ago", "3 hours ago"; from 24 hours on, the date and time. */
export function relativeTime(iso: string, now: Date): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return iso;
  const ago = now.getTime() - at;
  if (ago < MINUTE) return "just now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  if (ago < 24 * HOUR) {
    const hours = Math.floor(ago / HOUR);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  return formatDateTime(iso);
}

/** The lookup outcome in words; the code stays in `data-state` for tools. */
export const LOOKUP_STATE_LABEL: Record<LookupState, string> = {
  RESOLVED: "Resolved",
  PARTIAL: "Partly resolved",
  INVALID_INPUT: "Input not valid",
  UNKNOWN_TAIL: "Unknown tail",
  UNCONFIGURED: "Not configured on this date",
  OVERLAP: "Overlapping configurations",
  PLANNED: "Planned only",
  SOURCE_INVALID: "Source not valid",
  SERVICE_UNAVAILABLE: "Reference data unavailable",
};

export const FINDING_SEVERITY_LABEL: Record<FindingSeverity, string> = {
  error: "Blocking",
  conflict: "Conflict or unresolved",
  warning: "Warning",
  info: "Information",
};

function plural(noun: string): string {
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  if (/(s|x|ch|sh)$/.test(noun)) return `${noun}es`;
  return `${noun}s`;
}

/**
 * "3 errors, 12 warnings": each non-zero count with its label (a singular noun), in the order of `labels`, then any
 * key the labels do not name. "none" when every count is zero.
 */
export function formatCounts(counts: Record<string, number>, labels: Record<string, string>): string {
  const keys = [...Object.keys(labels).filter((k) => k in counts), ...Object.keys(counts).filter((k) => !(k in labels))];
  const out = keys.flatMap((key) => {
    const n = counts[key] ?? 0;
    if (n === 0) return [];
    const noun = labels[key];
    // a key nobody labelled is shown as it came: guessing its plural could only be wrong
    if (noun === undefined) return [`${n} ${key}`];
    return [`${n} ${n === 1 ? noun : plural(noun)}`];
  });
  return out.length > 0 ? out.join(", ") : "none";
}

export { conditionLabel } from "../domain/labels.ts";

/** The item the class takes when a technician raises a problem to MEL: it names no MEL item of its own. */
const TECH_RAISED_ITEM = "TECH-RAISED";

/** What a class means for the aircraft, in words. */
export function melLabel(cls: MelClass): string {
  if (cls.class === "COSMETIC") return "Cosmetic: can wait";
  if (cls.class === "NO_GO") return `No-go: must be fixed before flight. ${cls.reason}`;
  const item = cls.item === TECH_RAISED_ITEM ? "MEL item" : `MEL item ${cls.item}`;
  return `${item} (category ${cls.category}, fix within ${cls.intervalDays} days): ${cls.conditions}`;
}

const OUTCOME_LABEL: Record<ObservationOutcome, string> = {
  NOTED: "Note only",
  DEFERRED: "Defer",
  MUST_FIX: "Must be fixed before flight",
  REPLACED: "Replaced",
  FIXED: "Fixed",
};
export const outcomeLabel = (o: ObservationOutcome): string => OUTCOME_LABEL[o];

const DEFER_LABEL: Record<DeferUntil, string> = { NEXT_CHECK: "Until the next check", NEXT_STOP: "Until the next stop" };
export const deferLabel = (d: DeferUntil): string => DEFER_LABEL[d];

const REASON_LABEL: Record<DeferReason, string> = { NO_STOCK: "No stock on hand", NO_TIME: "No time on this turn", OTHER: "Other" };
export const reasonLabel = (r: DeferReason): string => REASON_LABEL[r];
