import { afterEach, describe, expect, test } from "vitest";
import type { FindingSeverity, LookupState } from "../../src/domain/types.ts";
import { FINDING_SEVERITY_LABEL, formatCounts, formatDate, formatDateTime, LOOKUP_STATE_LABEL, relativeTime } from "../../src/web/format.ts";

const originalTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = originalTz;
});

describe("formatDate", () => {
  // the two ends of the world's time zones: a Date-based format would move the day in one of them
  for (const tz of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "UTC"]) {
    test(`never shifts a calendar date (TZ=${tz})`, () => {
      process.env.TZ = tz;
      expect(formatDate("2026-11-12")).toBe("12 Nov 2026");
      expect(formatDate("2026-01-01")).toBe("1 Jan 2026");
      expect(formatDate("2026-12-31")).toBe("31 Dec 2026");
    });
  }

  test("uses the same three-letter month every time", () => {
    expect(formatDate("2026-09-03")).toBe("3 Sep 2026");
  });

  test("a value that is not a calendar date is shown as it came", () => {
    expect(formatDate("not a date")).toBe("not a date");
  });
});

describe("formatDateTime", () => {
  test("states the zone: UTC by default", () => {
    expect(formatDateTime("2026-11-12T14:05:09.123Z")).toBe("12 Nov 2026, 14:05 UTC");
  });

  test("the same instant reads the same whatever the machine's zone", () => {
    process.env.TZ = "Pacific/Kiritimati";
    expect(formatDateTime("2026-11-12T23:30:00.000Z")).toBe("12 Nov 2026, 23:30 UTC");
    process.env.TZ = "Pacific/Pago_Pago";
    expect(formatDateTime("2026-11-12T23:30:00.000Z")).toBe("12 Nov 2026, 23:30 UTC");
  });

  test("another zone is named", () => {
    expect(formatDateTime("2026-11-12T23:30:00.000Z", "Pacific/Kiritimati")).toBe("13 Nov 2026, 13:30 GMT+14");
    expect(formatDateTime("2026-07-01T09:00:00.000Z", "Europe/London")).toMatch(/^1 Jul 2026, 10:00 (BST|GMT\+1)$/);
  });

  test("midnight is 00:00, not 24:00", () => {
    expect(formatDateTime("2026-11-12T00:00:00.000Z")).toBe("12 Nov 2026, 00:00 UTC");
  });

  test("a value that is not a timestamp is shown as it came", () => {
    expect(formatDateTime("garbage")).toBe("garbage");
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-11-12T14:05:00.000Z");
  test("just now, then minutes, then hours, then the date and time", () => {
    expect(relativeTime("2026-11-12T14:04:31.000Z", now)).toBe("just now");
    expect(relativeTime("2026-11-12T14:00:00.000Z", now)).toBe("5 min ago");
    expect(relativeTime("2026-11-12T13:05:00.000Z", now)).toBe("1 hour ago");
    expect(relativeTime("2026-11-11T15:05:00.000Z", now)).toBe("23 hours ago");
    expect(relativeTime("2026-11-11T14:05:00.000Z", now)).toBe("11 Nov 2026, 14:05 UTC");
  });

  test("a time slightly in the future (clock skew) is just now", () => {
    expect(relativeTime("2026-11-12T14:05:20.000Z", now)).toBe("just now");
  });
});

describe("labels", () => {
  test("every LookupState and FindingSeverity has a label", () => {
    const states: LookupState[] = [
      "INVALID_INPUT",
      "UNKNOWN_TAIL",
      "UNCONFIGURED",
      "OVERLAP",
      "PLANNED",
      "SOURCE_INVALID",
      "PARTIAL",
      "RESOLVED",
      "SERVICE_UNAVAILABLE",
    ];
    expect(Object.keys(LOOKUP_STATE_LABEL).sort()).toEqual([...states].sort());
    for (const s of states) expect(LOOKUP_STATE_LABEL[s]).toMatch(/^[A-Z][a-z ]+$/);
    expect(LOOKUP_STATE_LABEL.RESOLVED).toBe("Resolved");
    expect(LOOKUP_STATE_LABEL.SOURCE_INVALID).toBe("Source not valid");
    const severities: FindingSeverity[] = ["error", "conflict", "warning", "info"];
    expect(Object.keys(FINDING_SEVERITY_LABEL).sort()).toEqual([...severities].sort());
    for (const s of severities) expect(FINDING_SEVERITY_LABEL[s]).toMatch(/^[A-Z]/);
  });
});

describe("formatCounts", () => {
  test("names each count in the order of the labels, plural where needed, and skips zeros", () => {
    expect(formatCounts({ warning: 12, error: 3, info: 0 }, { error: "error", warning: "warning", info: "note" })).toBe("3 errors, 12 warnings");
    expect(formatCounts({ error: 1 }, { error: "error" })).toBe("1 error");
    expect(formatCounts({ fixture: 2, candidate: 5 }, { candidate: "candidate layout", fixture: "fixture layout" })).toBe(
      "5 candidate layouts, 2 fixture layouts",
    );
  });

  test("a key without a label is still shown, and nothing at all reads as none", () => {
    expect(formatCounts({ odd: 2 }, {})).toBe("2 odd");
    expect(formatCounts({}, { error: "error" })).toBe("none");
    expect(formatCounts({ error: 0 }, { error: "error" })).toBe("none");
  });

  test("an English plural for labels ending in y, s, x or ch", () => {
    expect(formatCounts({ a: 2, b: 2, c: 2 }, { a: "category", b: "class", c: "match" })).toBe("2 categories, 2 classes, 2 matches");
  });
});
