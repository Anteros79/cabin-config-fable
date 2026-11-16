import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { Finding } from "../../src/domain/types.ts";
import { buildStagedRelease, defaultSourceRoot, PROJECT_ROOT } from "../../src/importer/assemble.ts";
import { ORIGINAL_FILES } from "../../src/importer/candidate.ts";
import { importReference } from "../../src/importer/cli.ts";
import { checkOriginals } from "../../src/importer/originals.ts";
import { cleanupTempDirs, tempDir } from "../helpers.ts";

afterAll(cleanupTempDirs);

const MANIFEST = join(PROJECT_ROOT, "evidence", "originals-manifest.json");

/** A temp copy of the nine originals; the committed originals are never edited. */
function copyOfOriginals(edit?: (root: string) => void): string {
  const root = tempDir("cabin-kit-src-");
  for (const file of Object.values(ORIGINAL_FILES)) cpSync(join(defaultSourceRoot(), file), join(root, file));
  edit?.(root);
  return root;
}

const withCode = (findings: Finding[], code: string) => findings.filter((f) => f.code === code);
const HONEST_STATUS = /^(parsed: |not read: file missing$|not parsed: narrative evidence, hash recorded$|invalid: )/;

function importInto(root: string, acceptChanged = false) {
  const dir = tempDir();
  return importReference({ referencePath: join(dir, "reference.sqlite"), visitsPath: join(dir, "visits.sqlite"), sourceRoot: root, acceptChanged });
}

describe("originals are verified against the manifest (IMP-03)", () => {
  test("the unmodified originals pass and every source has an honest parse status", () => {
    expect(checkOriginals(defaultSourceRoot(), MANIFEST)).toEqual([]);
    const { content } = buildStagedRelease();
    const candidates = content.sources.filter((s) => s.namespace === "candidate");
    expect(candidates).toHaveLength(9);
    for (const s of candidates) expect(s.file?.parseStatus).toMatch(HONEST_STATUS);
    expect(candidates.find((s) => s.id === "CAND-SRC-RTF")?.file?.parseStatus).toBe("not parsed: narrative evidence, hash recorded");
    expect(candidates.find((s) => s.id === "CAND-SRC-SCHEMA-CSV")?.file?.parseStatus).toMatch(/^parsed: \d+ records, \d+ columns/);
  });

  test("an emptied RTF is SOURCE_HASH_CHANGED and the release is rejected", () => {
    const root = copyOfOriginals((r) => writeFileSync(join(r, ORIGINAL_FILES.rtf), ""));
    const changed = withCode(buildStagedRelease({ sourceRoot: root }).findings, "SOURCE_HASH_CHANGED");
    expect(changed.map((f) => [f.severity, f.refs])).toEqual([["error", [ORIGINAL_FILES.rtf]]]);
    expect(changed[0]?.message).toMatch(/0 bytes/);
    expect(importInto(root)).toMatchObject({ status: "rejected", activated: false });
  });

  test("--accept-changed downgrades to a warning and the status says not parsed", () => {
    const root = copyOfOriginals((r) => writeFileSync(join(r, ORIGINAL_FILES.rtf), ""));
    const { findings, content } = buildStagedRelease({ sourceRoot: root, acceptChanged: true });
    expect(withCode(findings, "SOURCE_HASH_CHANGED").map((f) => f.severity)).toEqual(["warning"]);
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    const rtf = content.sources.find((s) => s.id === "CAND-SRC-RTF");
    expect(rtf?.file).toMatchObject({ bytes: 0, parseStatus: "not parsed: narrative evidence, hash recorded" });
    expect(importInto(root, true)).toMatchObject({ status: "validated", activated: true });
  });

  test("checkOriginals reports every problem, not the first", () => {
    const root = copyOfOriginals((r) => {
      writeFileSync(join(r, ORIGINAL_FILES.rtf), "");
      writeFileSync(join(r, ORIGINAL_FILES.schemaCsv), "a,b\n");
      rmSync(join(r, ORIGINAL_FILES.docx));
    });
    const findings = checkOriginals(root, MANIFEST);
    expect(findings.map((f) => [f.code, f.refs?.[0]]).sort()).toEqual(
      [
        ["SOURCE_FILE_MISSING", ORIGINAL_FILES.docx],
        ["SOURCE_HASH_CHANGED", ORIGINAL_FILES.rtf],
        ["SOURCE_HASH_CHANGED", ORIGINAL_FILES.schemaCsv],
      ].sort(),
    );
    expect(findings.every((f) => f.severity === "error")).toBe(true);
    // accepting changed files never accepts a missing one
    expect(checkOriginals(root, MANIFEST, { acceptChanged: true }).map((f) => [f.code, f.severity])).toEqual(
      expect.arrayContaining([
        ["SOURCE_FILE_MISSING", "error"],
        ["SOURCE_HASH_CHANGED", "warning"],
      ]),
    );
  });

  test("a directory in place of an original is SOURCE_FILE_MISSING, not EISDIR", () => {
    const root = copyOfOriginals((r) => {
      rmSync(join(r, ORIGINAL_FILES.seatsCsv));
      mkdirSync(join(r, ORIGINAL_FILES.seatsCsv));
    });
    const { findings, content } = buildStagedRelease({ sourceRoot: root });
    expect(withCode(findings, "SOURCE_FILE_MISSING").map((f) => f.refs)).toEqual([[ORIGINAL_FILES.seatsCsv]]);
    expect(withCode(findings, "IMPORT_INTERNAL")).toEqual([]);
    expect(content.sources.find((s) => s.id === "CAND-SRC-SEATS-CSV")?.file?.parseStatus).toBe("not read: file missing");
  });

  test("two missing originals are both reported and no source is left 'pending'", () => {
    const root = copyOfOriginals((r) => {
      rmSync(join(r, ORIGINAL_FILES.configCsv));
      rmSync(join(r, ORIGINAL_FILES.docx));
    });
    const { findings, content } = buildStagedRelease({ sourceRoot: root });
    expect(
      withCode(findings, "SOURCE_FILE_MISSING")
        .map((f) => f.refs?.[0])
        .sort(),
    ).toEqual([ORIGINAL_FILES.configCsv, ORIGINAL_FILES.docx].sort());
    const candidates = content.sources.filter((s) => s.namespace === "candidate");
    expect(candidates).toHaveLength(9);
    for (const s of candidates) expect(s.file?.parseStatus).toMatch(HONEST_STATUS);
    expect(candidates.filter((s) => s.file?.parseStatus === "not read: file missing").map((s) => s.id)).toEqual(["CAND-SRC-CONFIG-CSV", "CAND-SRC-DOCX"]);
    // the files that are present are still read
    expect(candidates.find((s) => s.id === "CAND-SRC-SEATS-CSV")?.file?.parseStatus).toMatch(/^parsed: 837 records/);
  });

  test("a non-existent source root fails before any store file is created", () => {
    const dir = tempDir();
    const missingRoot = join(dir, "no-such-root");
    expect(() =>
      importReference({ referencePath: join(dir, "data", "reference.sqlite"), visitsPath: join(dir, "data", "visits.sqlite"), sourceRoot: missingRoot }),
    ).toThrow(/Source root is not a directory/);
    expect(existsSync(join(dir, "data"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("source parsing is honest (IMP-03, IMP-08)", () => {
  test("an unterminated-quote schema CSV is SOURCE_UNREADABLE", () => {
    const root = copyOfOriginals((r) => writeFileSync(join(r, ORIGINAL_FILES.schemaCsv), 'layer,purpose\n"open,never closed\n'));
    const { findings, content } = buildStagedRelease({ sourceRoot: root, acceptChanged: true });
    const unreadable = withCode(findings, "SOURCE_UNREADABLE");
    expect(unreadable.map((f) => [f.severity, f.refs])).toEqual([["error", ["CAND-SRC-SCHEMA-CSV"]]]);
    expect(content.sources.find((s) => s.id === "CAND-SRC-SCHEMA-CSV")?.file?.parseStatus).toMatch(/^invalid: .*quoted field/);
  });

  test("invalid UTF-8 in the seats CSV is SOURCE_ENCODING", () => {
    const root = copyOfOriginals((r) => {
      const path = join(r, ORIGINAL_FILES.seatsCsv);
      const bytes = readFileSync(path);
      bytes[bytes.indexOf("Extra Legroom")] = 0xff;
      writeFileSync(path, bytes);
    });
    const { findings, content } = buildStagedRelease({ sourceRoot: root, acceptChanged: true });
    expect(withCode(findings, "SOURCE_ENCODING").map((f) => [f.severity, f.refs])).toEqual([["error", ["CAND-SRC-SEATS-CSV"]]]);
    expect(content.sources.find((s) => s.id === "CAND-SRC-SEATS-CSV")?.file?.parseStatus).toMatch(/^invalid: not valid UTF-8/);
  });

  test.each([
    ["null", 1],
    ["[]", 1],
    ["1", 1],
    ['{"lopa_configurations":[1]}', 4],
    ['{"lopa_configurations":"x"}', 4],
    ["{}", 4],
  ])("registry JSON %s → REGISTRY_SHAPE, no exception", (json, problems) => {
    const root = copyOfOriginals((r) => writeFileSync(join(r, ORIGINAL_FILES.registryJson), json));
    let build: ReturnType<typeof buildStagedRelease> | undefined;
    expect(() => {
      build = buildStagedRelease({ sourceRoot: root, acceptChanged: true });
    }).not.toThrow();
    const shape = withCode(build?.findings ?? [], "REGISTRY_SHAPE");
    expect(shape).toHaveLength(problems);
    expect(shape.every((f) => f.severity === "error")).toBe(true);
    expect(withCode(build?.findings ?? [], "IMPORT_INTERNAL")).toEqual([]);
    expect(build?.content.sources.find((s) => s.id === "CAND-SRC-REGISTRY-JSON")?.file?.parseStatus).toMatch(/^invalid: /);
    expect(build?.content.layoutRevisions.filter((r) => r.namespace === "candidate")).toEqual([]);
  });

  test("a seat lettered G is SEAT_LETTER_UNKNOWN and left out, not a crash", () => {
    const root = copyOfOriginals((r) => {
      const path = join(r, ORIGINAL_FILES.registryJson);
      const registry = JSON.parse(readFileSync(path, "utf8")) as { lopa_seats: Record<string, unknown>[] };
      const seat = registry.lopa_seats[0] as Record<string, unknown>;
      seat.seat_letter = "G";
      seat.seat_code = `${seat.row_number}G`;
      writeFileSync(path, JSON.stringify(registry));
    });
    const { findings, content } = buildStagedRelease({ sourceRoot: root, acceptChanged: true });
    const unknown = withCode(findings, "SEAT_LETTER_UNKNOWN");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.severity).toBe("error");
    expect(withCode(findings, "IMPORT_INTERNAL")).toEqual([]);
    const seats = content.layoutRevisions.flatMap((r) => r.locations).filter((l) => l.seat?.letter === "G");
    expect(seats).toEqual([]);
    expect(content.layoutRevisions.filter((r) => r.namespace === "candidate").reduce((n, r) => n + r.locations.length, 0)).toBe(836);
  });

  test("an unexpected exception while staging becomes IMPORT_INTERNAL, not a throw", () => {
    const root = copyOfOriginals((r) => {
      const path = join(r, ORIGINAL_FILES.registryJson);
      const registry = JSON.parse(readFileSync(path, "utf8")) as { lopa_seats: Record<string, unknown>[] };
      // a value with no usable string form: converting it to text throws a TypeError
      (registry.lopa_seats[0] as Record<string, unknown>).seat_letter = { toString: 1, valueOf: 1 };
      writeFileSync(path, JSON.stringify(registry));
    });
    let build: ReturnType<typeof buildStagedRelease> | undefined;
    expect(() => {
      build = buildStagedRelease({ sourceRoot: root, acceptChanged: true });
    }).not.toThrow();
    const internal = withCode(build?.findings ?? [], "IMPORT_INTERNAL");
    expect(internal.map((f) => f.severity)).toEqual(["error"]);
    expect(internal[0]?.message).toMatch(/Cannot convert object to primitive value/);
    expect(importInto(root, true)).toMatchObject({ status: "rejected", activated: false });
  });
});
