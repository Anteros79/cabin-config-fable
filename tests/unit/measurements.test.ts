import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { buildStagedRelease, contentHash, defaultSourceRoot } from "../../src/importer/assemble.ts";
import { isApproximate, ORIGINAL_FILES, parseRangeClaim } from "../../src/importer/candidate.ts";
import { cleanupTempDirs, EXPECTED_CONTENT_HASH, stagedFull, tempDir } from "../helpers.ts";

afterAll(cleanupTempDirs);

const defaults = { unit: "in", measurementKind: "seat pitch" };

describe("parseRangeClaim (IMP-07)", () => {
  test.each([
    ["31-32", { min: 31, max: 32, approximate: false }],
    ["37", { min: 37, max: 37, approximate: false }],
    ["31–33", { min: 31, max: 33, approximate: false }],
    ["31 - 33", { min: 31, max: 33, approximate: false }],
    ["~32", { min: 32, max: 32, approximate: true }],
    ['32"', { min: 32, max: 32, approximate: false }],
    [32, { min: 32, max: 32, approximate: false }],
  ] as const)("parseRangeClaim(%j)", (raw, expected) => {
    const { claim, problem } = parseRangeClaim(raw, defaults);
    expect(problem).toBeNull();
    expect(claim).toMatchObject({ ...expected, raw: String(raw), unit: "in", measurementKind: "seat pitch" });
  });

  test.each(["31—33", "≈ 31.5 - 32 in.", "31 inches", "31 in"])("parseRangeClaim(%j) also parses", (raw) => {
    const { claim, problem } = parseRangeClaim(raw, defaults);
    expect(problem).toBeNull();
    expect(claim?.raw).toBe(raw);
    expect(claim?.min).not.toBeNull();
  });

  test.each([null, undefined, ""])("parseRangeClaim(%j) is no claim and no problem", (raw) => {
    expect(parseRangeClaim(raw, defaults)).toEqual({ claim: null, problem: null });
  });

  test.each(["33-31", "wide", "31-", "3 1", Number.NaN, Number.POSITIVE_INFINITY, true, {}])("parseRangeClaim(%j) reports a problem", (raw) => {
    const { claim, problem } = parseRangeClaim(raw, defaults);
    expect(claim).toBeNull();
    expect(problem).not.toBeNull();
  });

  test("a reversed range says so", () => {
    expect(parseRangeClaim("33-31", defaults).problem).toBe("range reversed");
    expect(parseRangeClaim("wide", defaults).problem).toBe("unparsed");
  });
});

describe("isApproximate (IMP-07)", () => {
  test.each([
    ['~37.5"', 37, false],
    ['~37.5"', 37.5, true],
    ["~3725", 37.5, false],
    ["about ~37 in", 37, true],
    ['33-37 (Row 14 ≈37")', 37, true],
    ["37", 37, false],
  ] as const)("isApproximate(%j, %j) = %j", (text, value, expected) => {
    expect(isApproximate(text, value)).toBe(expected);
  });
});

describe("measurement findings on the originals", () => {
  test("the unmodified originals raise no *_UNPARSED finding and keep their hash", () => {
    const build = stagedFull();
    expect(build.findings.filter((f) => f.code.endsWith("_UNPARSED"))).toEqual([]);
    expect(contentHash(build.content)).toBe(EXPECTED_CONTENT_HASH);
  });

  test("each distinct unreadable pitch or width raises one warning naming the value and its seat count", () => {
    const root = tempDir("cabin-kit-src-");
    for (const file of Object.values(ORIGINAL_FILES)) cpSync(join(defaultSourceRoot(), file), join(root, file));
    const path = join(root, ORIGINAL_FILES.registryJson);
    const registry = JSON.parse(readFileSync(path, "utf8")) as { lopa_seats: Record<string, unknown>[] };
    const seats = registry.lopa_seats;
    for (const s of seats.slice(0, 3)) s.pitch_range_inches = "wide";
    for (const s of seats.slice(3, 5)) s.pitch_range_inches = "33-31";
    for (const s of seats.slice(5, 6)) s.effective_width_inches = "narrow";
    writeFileSync(path, JSON.stringify(registry));

    const { findings, content } = buildStagedRelease({ sourceRoot: root, acceptChanged: true });
    const pitch = findings.filter((f) => f.code === "PITCH_UNPARSED");
    const width = findings.filter((f) => f.code === "WIDTH_UNPARSED");
    expect(pitch.map((f) => f.severity)).toEqual(["warning", "warning"]);
    expect(pitch.map((f) => f.message)).toEqual([expect.stringMatching(/"wide".*3 seats/), expect.stringMatching(/"33-31".*range reversed.*2 seats/)]);
    expect(width.map((f) => f.message)).toEqual([expect.stringMatching(/"narrow".*1 seat\b/)]);

    const seat = (code: string, lopa: string) =>
      content.layoutRevisions.find((r) => r.layoutId === `CAND-${lopa}`)?.locations.find((l) => l.id === `SEAT:${code}`)?.seat;
    const first = seats[0] as { lopa_id: string; seat_code: string };
    expect(seat(first.seat_code, first.lopa_id)?.pitch).toBeNull();
  });
});
