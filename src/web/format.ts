import { MONTHS } from "../domain/dates.ts";
import type { FindingSeverity, LookupState } from "../domain/types.ts";

/**
 * How the interface writes dates, times, states and counts (WEB-21). One fixed form, en-GB, whatever the browser's
 * language: "12 Nov 2026" and "12 Nov 2026, 14:05 UTC". Instants are shown in UTC unless a zone is passed, and the zone
 * is always written. Calendar dates are never converted through a time zone, so a check date cannot move a day.
 * The machine value stays available: views put a timestamp in `<time dateTime={iso} title={iso}>`.
 */

// "12 Nov 2026": shared with the domain's labels and the PDF.
export { formatDate } from "../domain/dates.ts";

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

export { conditionLabel, deferLabel, melLabel, outcomeLabel, outcomeStatusLabel, reasonLabel } from "../domain/labels.ts";
