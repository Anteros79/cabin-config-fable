import type { IsoDate } from "./types.ts";

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True only for a real calendar date written as YYYY-MM-DD. */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string") return false;
  const m = ISO.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || y < 1900 || y > 2200) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return days !== undefined && d <= days;
}

/**
 * Inclusive on both ends: a record effective 2026-07-01 applies on 2026-07-01,
 * and a record ending/expiring 2026-12-31 still applies on 2026-12-31.
 */
export function withinInclusive(date: IsoDate, from: IsoDate | null, to: IsoDate | null): boolean {
  if (from !== null && date < from) return false;
  if (to !== null && date > to) return false;
  return true;
}

export function intervalsOverlap(aFrom: IsoDate, aTo: IsoDate | null, bFrom: IsoDate, bTo: IsoDate | null): boolean {
  const aEnd = aTo ?? "9999-12-31";
  const bEnd = bTo ?? "9999-12-31";
  return aFrom <= bEnd && bFrom <= aEnd;
}

/** Fixed three-letter months, so September is "Sep" on every ICU version. */
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "12 Nov 2026" from "2026-11-12". Read from the text itself, never through a Date, so no zone can shift it. */
export function formatDate(isoDate: string): string {
  const m = ISO.exec(isoDate);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  if (!m || !month) return isoDate;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/** Text with every YYYY-MM-DD date in it written as "12 Nov 2026", for words stored before dates were kept apart. */
export function formatDatesIn(text: string): string {
  return text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (d) => formatDate(d));
}
