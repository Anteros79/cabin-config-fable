import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { validateRelease } from "../../src/domain/validate.ts";
import { buildStagedRelease, canonicalJson, contentHash, defaultSourceRoot } from "../../src/importer/assemble.ts";
import { ORIGINAL_FILES } from "../../src/importer/candidate.ts";
import { importReference } from "../../src/importer/cli.ts";
import { parseCsv } from "../../src/importer/readers/csv.ts";
import { ReferenceStore } from "../../src/server/referenceStore.ts";
import { at, changedFixturePath, cleanupTempDirs, errorsOf, fixtureContent, stagedFull, tempDir } from "../helpers.ts";

afterAll(cleanupTempDirs);

const LETTERS = ["A", "B", "C", "D", "E", "F"];
function expectedSeats(rows: number[], omit: string[]): string[] {
  return rows
    .flatMap((r) => LETTERS.map((l) => `${r}${l}`))
    .filter((c) => !omit.includes(c))
    .sort();
}
function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}
function seatCodes(revisionId: string): string[] {
  const rev = stagedFull().content.layoutRevisions.find((r) => r.id === revisionId);
  if (!rev) throw new Error(`missing ${revisionId}`);
  return rev.locations
    .filter((l) => l.kind === "SEAT")
    .map((l) => l.seat!.code)
    .sort();
}
function tierTotals(revisionId: string): number[] {
  const rev = stagedFull().content.layoutRevisions.find((r) => r.id === revisionId)!;
  return ["Extra Legroom", "Preferred", "Standard"].map((t) => rev.locations.filter((l) => l.seat?.commercialTier === t).length);
}

describe("staged import of fixtures and the supplied candidate registry", () => {
  it("validates with no blocking findings and keeps conflicts visible", () => {
    const { findings } = stagedFull();
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    const codes = findings.map((f) => f.code);
    expect(codes).toContain("AIRLINE_DATA_NOT_SUPPLIED");
    expect(codes).toContain("LAYOUT_NOT_SUPPLIED");
    expect(codes).toContain("ASSIGNMENT_OVERLAP");
    expect(codes).toContain("CROSS_FORMAT_AGREEMENT");
  });

  it("records the two template JSON files as invalid and identical, without repairing or importing them", () => {
    const { content, stats } = stagedFull();
    const templates = stats.templates as { spaceNamed: string; gemini: string; byteIdentical: boolean };
    expect(templates.byteIdentical).toBe(true);
    expect(templates.spaceNamed).toBe("invalid: not valid JSON");
    expect(templates.gemini).toBe("invalid: not valid JSON");
    for (const id of ["CAND-SRC-TEMPLATE-JSON", "CAND-SRC-GEMINI-JSON"]) {
      const source = content.sources.find((s) => s.id === id)!;
      expect(source.file!.bytes).toBe(548);
      expect(source.file!.parseStatus).toBe("invalid: not valid JSON");
      expect(content.layoutRevisions.some((r) => r.sourceId === id)).toBe(false);
    }
  });

  it("imports 5 configurations, 147 row records (4 non-existent labels) and 837 seats", () => {
    const { content, stats } = stagedFull();
    expect(stats.registry).toMatchObject({ configurations: 5, rowRecords: 147, seats: 837, schemaVersion: "2026.1" });
    const candidates = content.layoutRevisions.filter((r) => r.namespace === "candidate");
    expect(candidates.map((r) => r.id)).toEqual(["CAND-73G@2026.1", "CAND-738@2026.1", "CAND-7M8-1@2026.1", "CAND-738-2@2026.1", "CAND-7M8-2@2026.1"]);
    expect(candidates.reduce((n, r) => n + r.rows.length, 0)).toBe(147);
    expect(candidates.reduce((n, r) => n + r.rows.filter((x) => !x.exists).length, 0)).toBe(4);
    expect(candidates.reduce((n, r) => n + r.locations.length, 0)).toBe(837);
  });

  it("agrees across JSON, CSV and XLSX for every shared attribute under declared conversions", () => {
    const cross = stagedFull().stats.crossFormat as { attributeValuesCompared: number; conversions: Record<string, number> };
    expect(cross.attributeValuesCompared).toBe(16641);
    expect(cross.conversions.numericIdentifierToString).toBe(30);
  });

  it("holds the exact candidate 73G seat set: labels 1-9 and 14-27, A-F except 14A; 10-13 do not exist", () => {
    expect(seatCodes("CAND-73G@2026.1")).toEqual(expectedSeats([...range(1, 9), ...range(14, 27)], ["14A"]));
    expect(seatCodes("CAND-73G@2026.1")).toHaveLength(137);
    const rev = stagedFull().content.layoutRevisions.find((r) => r.id === "CAND-73G@2026.1")!;
    expect(rev.rows.filter((r) => !r.exists).map((r) => r.printedLabel)).toEqual(["10", "11", "12", "13"]);
    expect(rev.rows.filter((r) => !r.exists).every((r) => r.physicalOrder === null)).toBe(true);
    // printed row 14 is the 10th physical row: printed label and physical order are separate
    expect(rev.rows.find((r) => r.printedLabel === "14")!.physicalOrder).toBe(10);
    expect(rev.locations.find((l) => l.id === "SEAT:14B")!.seat!.physicalRow).toBe(10);
  });

  it("holds the exact 175-seat sets for 738 / 7M8-1 and for 738-2 / 7M8-2", () => {
    const legacy = expectedSeats(range(1, 30), ["1A", "1B", "1C", "15A", "15F"]);
    const elevate = expectedSeats(range(1, 30), ["1A", "1B", "1C", "30A", "30F"]);
    expect(legacy).toHaveLength(175);
    expect(elevate).toHaveLength(175);
    expect(seatCodes("CAND-738@2026.1")).toEqual(legacy);
    expect(seatCodes("CAND-7M8-1@2026.1")).toEqual(legacy);
    expect(seatCodes("CAND-738-2@2026.1")).toEqual(elevate);
    expect(seatCodes("CAND-7M8-2@2026.1")).toEqual(elevate);
    expect(seatCodes("CAND-738-2@2026.1")).toContain("15A");
    expect(seatCodes("CAND-738-2@2026.1")).not.toContain("30A");
  });

  it("matches the declared tier totals and never classifies a split row as one tier", () => {
    expect(tierTotals("CAND-73G@2026.1")).toEqual([42, 23, 72]);
    expect(tierTotals("CAND-738@2026.1")).toEqual([46, 45, 84]);
    expect(tierTotals("CAND-7M8-1@2026.1")).toEqual([46, 45, 84]);
    expect(tierTotals("CAND-738-2@2026.1")).toEqual([48, 45, 82]);
    expect(tierTotals("CAND-7M8-2@2026.1")).toEqual([48, 45, 82]);
    const rev = stagedFull().content.layoutRevisions.find((r) => r.id === "CAND-738@2026.1")!;
    const tier = (code: string) => rev.locations.find((l) => l.id === `SEAT:${code}`)!.seat!.commercialTier;
    expect(new Set(["6A", "6B", "6C"].map(tier)).size).toBe(1);
    expect(new Set(["6D", "6E", "6F"].map(tier)).size).toBe(1);
    expect(tier("6A")).not.toBe(tier("6D"));
    expect(rev.notes.join(" ")).toMatch(/different commercial tiers.*\b6\b/);
  });

  it("keeps commercial tier, pitch claim, width claim, exit and bulkhead as separate attributes with raw values", () => {
    const rev = stagedFull().content.layoutRevisions.find((r) => r.id === "CAND-738-2@2026.1")!;
    const seat = rev.locations.find((l) => l.id === "SEAT:14B")!.seat!;
    expect(seat.pitch).toMatchObject({ raw: "37", min: 37, max: 37, unit: "in", approximate: true });
    expect(seat.width!.measurementKind).toBe("unspecified");
    expect(seat.raw).toBeTruthy();
    expect(seat.locator).toMatch(/southwest_737_lopa_normalized\.json#\/lopa_seats\/\d+/);
    const ranged = rev.locations.find((l) => l.seat?.pitch?.raw === "31-32")!.seat!.pitch!;
    expect(ranged).toMatchObject({ min: 31, max: 32, approximate: false });
    expect(seat.seatGroup).toBeNull(); // hardware group construction is not established by the sources
  });

  it("keeps candidate layouts unassigned: no tails, rules, floor or bin maps, and an empty accepted namespace", () => {
    const { content } = stagedFull();
    const all = [...content.aircraft, ...content.assignments, ...content.rules, ...content.substitutes, ...content.parts, ...content.variants];
    expect(all.every((x) => x.namespace === "fixture")).toBe(true);
    expect(JSON.stringify(content).includes('"namespace":"accepted"')).toBe(false);
    for (const rev of content.layoutRevisions.filter((r) => r.namespace === "candidate")) {
      expect(rev.status).toBe("candidate");
      expect(rev.floorMapStatus).toBe("not-supplied");
      expect(rev.binMapStatus).toBe("not-supplied");
      expect(rev.locations.every((l) => l.kind === "SEAT")).toBe(true);
      expect(content.variants.some((v) => v.layoutRevisionIds.includes(rev.id))).toBe(false);
    }
  });

  it("represents the DOCX 138-seat 737-700 as an unresolved category, not a layout", () => {
    const { content } = stagedFull();
    const cat = content.layoutCategories.find((c) => c.id === "DOCX-CAT-700-138")!;
    expect(cat.seatSetStatus).toBe("not-supplied");
    expect(cat.crosswalk).toEqual([]);
    expect(cat.claimedSeatCount).toBe(138);
    expect(cat.claims.some((c) => /7D, 7E, 7F, 15B and 15C/.test(c.text))).toBe(true);
    expect(cat.claims.every((c) => /Current Aircraft Seat Configurations\.docx#P\d+/.test(c.locator))).toBe(true);
    expect(content.layoutRevisions.filter((r) => r.namespace === "candidate").some((r) => r.locations.length === 138)).toBe(false);
    // four document categories vs five registry ids is a grain difference: both five records survive
    const active = content.layoutCategories.filter((c) => c.id !== "DOCX-CAT-MAX7-NOT-CURRENT");
    expect(active).toHaveLength(4);
    expect(active.flatMap((c) => c.crosswalk).every((x) => x.basis === "inferred")).toBe(true);
    // the 138-seat exception is not applied to the 137-seat candidate
    const rev = content.layoutRevisions.find((r) => r.id === "CAND-73G@2026.1")!;
    expect(rev.locations.find((l) => l.id === "SEAT:7D")!.seat!.raw).toMatchObject({ commercial_tier: "Preferred", pitch_range_inches: "31-33" });
  });

  it("flags partial-side bulkhead rows instead of applying the row flag to every seat", () => {
    const partial = stagedFull().findings.filter((f) => f.code === "BULKHEAD_PARTIAL_SIDE");
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.every((f) => f.severity === "conflict")).toBe(true);
  });

  it("refuses to choose between exports when a value differs (no JSON-wins precedence)", () => {
    const root = tempDir("cabin-kit-src-");
    for (const file of Object.values(ORIGINAL_FILES)) cpSync(join(defaultSourceRoot(), file), join(root, file));
    const seatsPath = join(root, ORIGINAL_FILES.seatsCsv);
    const text = readFileSync(seatsPath, "utf8");
    const changed = text.replace("73G,1,A,1A,Window,Extra Legroom", "73G,1,A,1A,Window,Preferred");
    expect(changed).not.toBe(text);
    writeFileSync(seatsPath, changed);
    const staged = buildStagedRelease({ sourceRoot: root });
    const mismatch = staged.findings.filter((f) => f.code === "CROSS_FORMAT_MISMATCH");
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]?.severity).toBe("error");
    expect(mismatch[0]?.message).toMatch(/commercial_tier/);
  });

  it("reports a missing supplied file instead of inventing content", () => {
    const root = tempDir("cabin-kit-src-");
    for (const file of Object.values(ORIGINAL_FILES)) if (file !== ORIGINAL_FILES.docx) cpSync(join(defaultSourceRoot(), file), join(root, file));
    const staged = buildStagedRelease({ sourceRoot: root });
    expect(staged.findings.some((f) => f.code === "SOURCE_FILE_MISSING" && f.severity === "error")).toBe(true);
    expect(staged.content.layoutCategories).toEqual([]);
  });

  it("preserves CSV strings exactly, including label-like values and leading zeros", () => {
    const table = parseCsv('\ufeffid,label,note\r\n007,"1-9, 14-27",\r\n738,"say ""hi""",x\r\n');
    expect(table.hasBom).toBe(true);
    expect(table.records).toEqual([
      { id: "007", label: "1-9, 14-27", note: "" },
      { id: "738", label: 'say "hi"', note: "x" },
    ]);
  });
});

describe("mandatory fictional fixture seat sets", () => {
  const seatsOfVariant = (variantId: string) => {
    const { content } = stagedFull();
    const variant = content.variants.find((v) => v.id === variantId)!;
    const rev = content.layoutRevisions.find((r) => r.id === variant.layoutRevisionIds[0])!;
    return rev.locations
      .filter((l) => l.kind === "SEAT")
      .map((l) => l.seat!.code)
      .sort();
  };
  it("V01 is rows 1-30 A-F except 14B/14E/15B/15E: 176 seats", () => {
    expect(seatsOfVariant("V01")).toEqual(expectedSeats(range(1, 30), ["14B", "14E", "15B", "15E"]));
    expect(seatsOfVariant("V01")).toHaveLength(176);
  });
  it("V10 is rows 1-23 A-F: 138 seats; V09 is the same without 23C: 137 seats", () => {
    expect(seatsOfVariant("V10")).toEqual(expectedSeats(range(1, 23), []));
    expect(seatsOfVariant("V10")).toHaveLength(138);
    expect(seatsOfVariant("V09")).toEqual(expectedSeats(range(1, 23), ["23C"]));
    expect(seatsOfVariant("V09")).toHaveLength(137);
  });
  it("the fictional 137/138 sets differ from the supplied candidate 73G set and from each other", () => {
    expect(seatsOfVariant("V09")).not.toEqual(seatCodes("CAND-73G@2026.1"));
    expect(seatsOfVariant("V01")).not.toEqual(seatCodes("CAND-738@2026.1"));
  });
  it("one layout serves several maintenance variants", () => {
    const { content } = stagedFull();
    const shared = content.variants.filter((v) => v.layoutRevisionIds.includes("FX-L-S176-800@1")).map((v) => v.id);
    expect(shared).toEqual(["V04", "V05", "V06", "V07", "V08"]);
  });
  it("every generated fixture rule is reachable", () => {
    expect(validateRelease(stagedFull().content).filter((f) => f.code === "UNREACHABLE_RULE")).toEqual([]);
  });
});

describe("release validation blocks bad reference data", () => {
  it("duplicate keys", () => {
    expect(errorsOf(fixtureContent((c) => c.rules.push({ ...at(c.rules, 0) })))).toContain("DUPLICATE_KEY");
    expect(errorsOf(fixtureContent((c) => c.aircraft.push({ ...at(c.aircraft, 0) })))).toContain("DUPLICATE_KEY");
    expect(errorsOf(fixtureContent((c) => at(c.layoutRevisions, 0).locations.push({ ...at(at(c.layoutRevisions, 0).locations, 0) })))).toContain(
      "DUPLICATE_KEY",
    );
  });
  it("orphans", () => {
    expect(errorsOf(fixtureContent((c) => (at(c.rules, 0).partNo = "NOPE")))).toContain("ORPHAN");
    expect(errorsOf(fixtureContent((c) => (at(c.rules, 0).sourceId = "NOPE")))).toContain("ORPHAN");
    expect(errorsOf(fixtureContent((c) => (at(c.assignments, 0).variantId = "V99")))).toContain("ORPHAN");
    expect(errorsOf(fixtureContent((c) => (at(c.assignments, 0).tail = "N999XX")))).toContain("ORPHAN");
  });
  it("seat totals and identities", () => {
    expect(errorsOf(fixtureContent((c) => (at(c.layoutRevisions, 0).declaredSeatCount = 175)))).toContain("SEAT_TOTAL");
    expect(errorsOf(fixtureContent((c) => (at(at(c.layoutRevisions, 0).locations, 0).seat!.printedRow = "77")))).toContain("SEAT_ROW");
  });
  it("units, quantities and date intervals", () => {
    expect(errorsOf(fixtureContent((c) => (at(c.rules, 0).unit = "BOX")))).toContain("UNKNOWN_UNIT");
    expect(errorsOf(fixtureContent((c) => (at(c.rules, 0).qtyPerReplacement = 0)))).toContain("SCHEMA_INVALID");
    expect(errorsOf(fixtureContent((c) => (at(c.rules, 0).effectiveTo = "2020-01-01")))).toContain("INVALID_INTERVAL");
    expect(errorsOf(fixtureContent((c) => (at(c.assignments, 0).effectiveFrom = "2026-02-30")))).toContain("SCHEMA_INVALID");
    expect(errorsOf(fixtureContent((c) => (at(c.assignments, 0).carpet = "SHAG")))).toContain("VOCABULARY");
  });
  it("unreachable rule locations", () => {
    const codes = errorsOf(
      fixtureContent((c) => {
        const rule = c.rules.find((r) => r.id === "FX-R-V01-ELR-A-CUSHION")!;
        c.rules.push({ ...rule, id: "X-UNREACHABLE", locations: { kind: "SEAT", zones: ["EXIT"], letters: ["B"] } });
      }),
    );
    expect(codes).toContain("UNREACHABLE_RULE");
  });
  it("invalid, duplicate, conflicting and cyclic kit definitions", () => {
    const kit = (parentPartNo: string, childPartNo: string, qty = 1) => ({ parentPartNo, childPartNo, qty, unit: "PANEL", sourceId: "FX-DOC-DEV" });
    expect(errorsOf(fixtureContent((c) => c.kitChildren.push(kit("FAKE-P-39", "FAKE-CK-2000"))))).toContain("KIT_CYCLE");
    expect(errorsOf(fixtureContent((c) => c.kitChildren.push(kit("FAKE-P-39", "FAKE-P-39"))))).toContain("KIT_SELF_REFERENCE");
    expect(errorsOf(fixtureContent((c) => c.kitChildren.push(kit("FAKE-CK-2000", "FAKE-P-39", 2))))).toContain("KIT_DUPLICATE");
    expect(errorsOf(fixtureContent((c) => c.kitChildren.push(kit("FAKE-CK-2000", "FAKE-P-39", 3))))).toContain("KIT_CONFLICT");
    expect(errorsOf(fixtureContent((c) => c.kitChildren.push(kit("FAKE-CK-2000", "FAKE-P-41", 0))))).toContain("SCHEMA_INVALID");
    expect(errorsOf(fixtureContent((c) => c.kitChildren.push(kit("FAKE-CK-2000", "NOPE"))))).toContain("KIT_ORPHAN_CHILD");
  });
  it("airline-looking data cannot enter without an approved source", () => {
    expect(errorsOf(fixtureContent((c) => (at(c.rules, 0).namespace = "accepted")))).toContain("NAMESPACE");
    expect(errorsOf(fixtureContent((c) => (at(c.sources, 0).authority = "approved")))).toContain("UNSUPPORTED_AUTHORITY");
  });
  it("overlapping assignments and identical rules are recorded as conflicts, not silently accepted", () => {
    const findings = validateRelease(
      fixtureContent((c) => {
        const rule = c.rules.find((r) => r.id === "FX-R-V02-CARPET-KIT")!;
        c.rules.push({ ...rule, id: "X-EQUAL" });
      }),
    );
    expect(findings.filter((f) => f.code === "EQUAL_RULES" && f.severity === "conflict")).toHaveLength(1);
    expect(findings.filter((f) => f.code === "ASSIGNMENT_OVERLAP" && f.severity === "conflict")).toHaveLength(1);
  });
});

/** A temp copy of the nine originals at a fresh path. */
function copyOfOriginals(): string {
  const root = tempDir("cabin-kit-src-");
  for (const file of Object.values(ORIGINAL_FILES)) cpSync(join(defaultSourceRoot(), file), join(root, file));
  return root;
}

function tempStores() {
  const dir = tempDir();
  return { referencePath: join(dir, "reference.sqlite"), visitsPath: join(dir, "visits.sqlite") };
}

function releasesOf(stores: { referencePath: string; visitsPath: string }) {
  const store = ReferenceStore.open(stores.referencePath, stores.visitsPath, { readOnly: true });
  try {
    return store.listReleases();
  } finally {
    store.close();
  }
}

/** A fixture file that is not valid JSON; `variant` changes the bytes (and so the finding) but not the content. */
function brokenFixturePath(variant: string): string {
  const path = join(tempDir("cabin-kit-fx-"), "fixture-data.json");
  writeFileSync(path, `{ "note": "${variant}", `);
  return path;
}

describe("stable content hash and no-op re-import (IMP-09, IMP-10)", () => {
  it("the hash is the same with a different label", () => {
    const a = buildStagedRelease({ includeCandidate: false, label: "a" });
    const b = buildStagedRelease({ includeCandidate: false, label: "b" });
    expect(a.content.label).toBe("a");
    expect(contentHash(a.content)).toBe(contentHash(b.content));
  });

  it("the hash does not contain engine error text; the finding and the stats keep it", () => {
    const { content, findings, stats } = stagedFull();
    const templates = stats.templates as { spaceNamedError: string; geminiError: string };
    expect(templates.spaceNamedError).toBeTruthy();
    expect(templates.geminiError).toBe(templates.spaceNamedError);
    const hashed = canonicalJson(content);
    expect(hashed).not.toMatch(/Unexpected token|is not valid JSON|in JSON at position/);
    expect(hashed).not.toContain(templates.spaceNamedError);
    const notImported = findings.filter((f) => f.code === "TEMPLATE_NOT_IMPORTED");
    expect(notImported).toHaveLength(2);
    for (const f of notImported) expect(f.message).toContain(templates.spaceNamedError);
  });

  it("the hash is the same from a source root at a different path", () => {
    const one = buildStagedRelease({ sourceRoot: copyOfOriginals() });
    const two = buildStagedRelease({ sourceRoot: copyOfOriginals() });
    expect(contentHash(one.content)).toBe(contentHash(two.content));
    expect(contentHash(one.content)).toBe(contentHash(stagedFull().content));
  });

  it("importing identical inputs twice creates one release", () => {
    const stores = tempStores();
    const first = importReference({ ...stores });
    expect(first).toMatchObject({ status: "validated", activated: true, unchanged: false });
    const second = importReference({ ...stores, label: "a different label" });
    expect(second).toMatchObject({ releaseId: first.releaseId, status: "validated", activated: false, unchanged: true });
    expect(releasesOf(stores).map((r) => [r.id, r.status])).toEqual([[first.releaseId, "active"]]);
  });

  it("two rejected runs with the same bad input record one rejected release", () => {
    const stores = tempStores();
    const fixturePath = brokenFixturePath("one");
    const first = importReference({ ...stores, fixturePath, includeCandidate: false });
    expect(first).toMatchObject({ status: "rejected", activated: false, unchanged: false });
    const second = importReference({ ...stores, fixturePath, includeCandidate: false });
    expect(second).toMatchObject({ releaseId: first.releaseId, status: "rejected", activated: false, unchanged: true });
    expect(releasesOf(stores).map((r) => r.id)).toEqual([first.releaseId]);
    // Different bad input with the same (empty) fixture content still records its own findings.
    const third = importReference({ ...stores, fixturePath: brokenFixturePath("two"), includeCandidate: false });
    expect(third).toMatchObject({ status: "rejected", unchanged: false });
    expect(third.releaseId).not.toBe(first.releaseId);
    expect(releasesOf(stores)).toHaveLength(2);
  });

  it("a changed input after an unchanged import still stages and activates", () => {
    const stores = tempStores();
    const first = importReference({ ...stores, includeCandidate: false });
    expect(importReference({ ...stores, includeCandidate: false }).unchanged).toBe(true);
    const changed = importReference({ ...stores, includeCandidate: false, fixturePath: changedFixturePath("changed") });
    expect(changed).toMatchObject({ status: "validated", activated: true, unchanged: false });
    expect(changed.releaseId).not.toBe(first.releaseId);
    expect(releasesOf(stores).map((r) => [r.id, r.status])).toEqual([
      [changed.releaseId, "active"],
      [first.releaseId, "superseded"],
    ]);
  });
});
