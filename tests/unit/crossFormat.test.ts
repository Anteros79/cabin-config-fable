import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, describe, expect, test } from "vitest";
import type { Finding } from "../../src/domain/types.ts";
import { buildStagedRelease, defaultSourceRoot } from "../../src/importer/assemble.ts";
import { ORIGINAL_FILES, sameValue } from "../../src/importer/candidate.ts";
import { importReference } from "../../src/importer/cli.ts";
import { ReferenceStore } from "../../src/server/referenceStore.ts";
import { cleanupTempDirs, makeStores, stagedFull, tempDir } from "../helpers.ts";

afterAll(cleanupTempDirs);

/** A temp copy of the nine originals; the committed originals are never edited. */
function copyOfOriginals(): string {
  const root = tempDir("cabin-kit-src-");
  for (const file of Object.values(ORIGINAL_FILES)) cpSync(join(defaultSourceRoot(), file), join(root, file));
  return root;
}

/** A source root whose copy of `file` has been rewritten by `edit`. The edit must change the file. */
function editCsv(file: string, edit: (text: string) => string): () => string {
  return () => {
    const root = copyOfOriginals();
    const path = join(root, file);
    const before = readFileSync(path, "utf8");
    const after = edit(before);
    if (after === before) throw new Error(`edit of ${file} changed nothing`);
    writeFileSync(path, after);
    return root;
  };
}

/** A source root whose rows workbook has had `edit` applied to one of its XML entries. */
function editXlsx(entry: string, edit: (xml: string) => string): () => string {
  return () => {
    const root = copyOfOriginals();
    const path = join(root, ORIGINAL_FILES.rowsXlsx);
    const zip = unzipSync(readFileSync(path));
    const before = strFromU8(zip[entry] ?? new Uint8Array());
    const after = edit(before);
    if (after === before) throw new Error(`edit of ${entry} changed nothing`);
    zip[entry] = strToU8(after);
    writeFileSync(path, zipSync(zip));
    return root;
  };
}

// The supplied CSVs contain no quoted line breaks (one line per record); each edit keeps the file's line ending.
type LineEdit = (lines: string[]) => string[];
const byLine =
  (edit: LineEdit) =>
  (text: string): string => {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const body = text.endsWith(eol) ? text.slice(0, -eol.length) : text;
    return `${edit(body.split(eol)).join(eol)}${eol}`;
  };
const keepFirstColumn = byLine((all) => all.map((line) => line.split(",")[0] ?? ""));
const duplicateSecondLine = byLine((all) => [...all.slice(0, 2), all[1] ?? "", ...all.slice(2)]);
const dropSecondLine = byLine((all) => all.filter((_, i) => i !== 1));
const appendColumn = byLine((all) => all.map((line, i) => `${line},${i === 0 ? "hand_added" : "x"}`));

const errorCodes = (findings: Finding[]) => findings.filter((f) => f.severity === "error").map((f) => f.code);

/** Import `root` over an active fixture release; the outcome, the stored findings and the active release before and after. */
function importOver(root: string) {
  const stores = makeStores();
  const activeId = () => {
    const store = ReferenceStore.open(stores.referencePath, stores.visitsPath, { readOnly: true });
    try {
      return store.activeReleaseId();
    } finally {
      store.close();
    }
  };
  const before = activeId();
  const outcome = importReference({ ...stores, sourceRoot: root, includeCandidate: true });
  const store = ReferenceStore.open(stores.referencePath, stores.visitsPath, { readOnly: true });
  let findings: Finding[];
  try {
    findings = store.findings(outcome.releaseId).findings;
  } finally {
    store.close();
  }
  return { outcome, findings, before, after: activeId() };
}

describe("a hand-edited export is rejected and the previous release stays active (IMP-02)", () => {
  test.each([
    ["config CSV id 73G renamed to 73X", editCsv(ORIGINAL_FILES.configCsv, (t) => t.replace(/^73G,/m, "73X,"))],
    ["config CSV header total_seats renamed", editCsv(ORIGINAL_FILES.configCsv, (t) => t.replace("total_seats", "total_seatz"))],
    ["seats CSV header commercial_tier renamed", editCsv(ORIGINAL_FILES.seatsCsv, (t) => t.replace("commercial_tier", "tier"))],
    ["config CSV reduced to the id column", editCsv(ORIGINAL_FILES.configCsv, keepFirstColumn)],
    ["seats CSV with one row duplicated", editCsv(ORIGINAL_FILES.seatsCsv, duplicateSecondLine)],
    ["seats CSV with one row removed", editCsv(ORIGINAL_FILES.seatsCsv, dropSecondLine)],
    ["config CSV with an extra column", editCsv(ORIGINAL_FILES.configCsv, appendColumn)],
    ["rows workbook header row_notes renamed", editXlsx("xl/sharedStrings.xml", (x) => x.replace("<t>row_notes</t>", "<t>row_note</t>"))],
  ])("%s is rejected", (_name, makeRoot) => {
    const { outcome, findings, before, after } = importOver(makeRoot());
    expect(errorCodes(findings)).toContain("CROSS_FORMAT_MISMATCH");
    expect(outcome).toMatchObject({ status: "rejected", activated: false });
    expect(before).not.toBeNull();
    expect(after).toBe(before);
  });

  test("a renamed id names the key missing on each side", () => {
    const { findings } = buildStagedRelease({ sourceRoot: editCsv(ORIGINAL_FILES.configCsv, (t) => t.replace(/^73G,/m, "73X,"))() });
    const messages = findings.filter((f) => f.code === "CROSS_FORMAT_MISMATCH").map((f) => f.message);
    expect(messages.some((m) => /73G/.test(m) && /only in the JSON/.test(m))).toBe(true);
    expect(messages.some((m) => /73X/.test(m) && /only in the Configuration CSV/.test(m))).toBe(true);
  });

  test("a renamed header lists the missing and the extra column", () => {
    const { findings } = buildStagedRelease({
      sourceRoot: editCsv(ORIGINAL_FILES.seatsCsv, (t) => t.replace("commercial_tier", "tier"))(),
    });
    const header = findings.find((f) => f.code === "CROSS_FORMAT_MISMATCH" && /columns/.test(f.message));
    expect(header?.message).toMatch(/missing: commercial_tier/);
    expect(header?.message).toMatch(/extra: tier/);
  });

  test("a dropped column also leaves the comparison short, reported with both counts", () => {
    const { findings, stats } = buildStagedRelease({ sourceRoot: editCsv(ORIGINAL_FILES.configCsv, keepFirstColumn)() });
    const compared = (stats.crossFormat as { attributeValuesCompared: number }).attributeValuesCompared;
    expect(compared).toBe(16641 - 5 * 20);
    const incomplete = findings.filter((f) => f.code === "CROSS_FORMAT_INCOMPLETE");
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]?.severity).toBe("error");
    expect(incomplete[0]?.message).toMatch(/16541/);
    expect(incomplete[0]?.message).toMatch(/16641/);
  });

  test("only the first workbook sheet is compared; another sheet is a warning", () => {
    const root = editXlsx("xl/workbook.xml", (x) =>
      x.replace('<sheet name="southwest_737_lopa_rows" sheetId="1" r:id="rId1"/>', '$&<sheet name="copy" sheetId="2" r:id="rId1"/>'),
    )();
    const { findings } = buildStagedRelease({ sourceRoot: root });
    expect(findings.filter((f) => f.code === "XLSX_EXTRA_SHEETS").map((f) => f.severity)).toEqual(["warning"]);
    expect(errorCodes(findings)).toEqual([]);
  });
});

describe("the unmodified originals", () => {
  test("compare exactly 16,641 values at run time, with no error", () => {
    const { stats, findings } = stagedFull();
    expect((stats.crossFormat as { attributeValuesCompared: number }).attributeValuesCompared).toBe(16641);
    expect(errorCodes(findings)).toEqual([]);
    expect(findings.map((f) => f.code)).not.toContain("XLSX_EXTRA_SHEETS");
  });
});

describe("sameValue", () => {
  test.each([
    ["0x10", 16, false],
    ["1e1", 10, false],
    [" 16 ", 16, false],
    ["16", 16, true],
    ["16.0", 16, true],
    ["-3", -3, true],
  ] as const)("sameValue(%j, %j) = %j", (text, number, equal) => {
    expect(sameValue(text, number)).toBe(equal);
    expect(sameValue(number, text)).toBe(equal);
  });
});
