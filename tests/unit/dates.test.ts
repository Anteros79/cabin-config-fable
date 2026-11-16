import { describe, expect, it, test } from "vitest";
import { intervalsOverlap, isIsoDate } from "../../src/domain/dates.ts";

describe("dates", () => {
  test.each([
    ["1900-02-29", false],
    ["2100-02-29", false],
    ["2000-02-29", true],
    ["2028-02-29", true],
    ["2026-1-5", false],
    ["2026-11-12\n", false],
    ["2026-11-12", true],
    ["2026-02-30", false],
  ] as const)("isIsoDate(%j) = %j", (value, expected) => {
    expect(isIsoDate(value)).toBe(expected);
  });

  test.each([20261112, new Date("2026-11-12"), ["2026-11-12"], null, undefined])("isIsoDate(%j) is false for a non-string", (value) => {
    expect(isIsoDate(value)).toBe(false);
  });

  it("intervalsOverlap: equal endpoints overlap, adjacent days do not, null is open", () => {
    expect(intervalsOverlap("2026-01-01", "2026-06-30", "2026-06-30", "2026-12-31")).toBe(true);
    expect(intervalsOverlap("2026-01-01", "2026-06-29", "2026-06-30", "2026-12-31")).toBe(false);
    expect(intervalsOverlap("2026-06-30", "2026-12-31", "2026-01-01", "2026-06-29")).toBe(false);
    expect(intervalsOverlap("2026-01-01", null, "2099-01-01", "2099-01-02")).toBe(true);
    expect(intervalsOverlap("2026-01-01", null, "2020-01-01", null)).toBe(true);
    expect(intervalsOverlap("2026-01-01", null, "2020-01-01", "2025-12-31")).toBe(false);
  });
});
