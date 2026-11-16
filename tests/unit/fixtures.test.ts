import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { lookup } from "../../src/domain/resolve.ts";
import type { Finding } from "../../src/domain/types.ts";
import { buildStagedRelease, contentHash, DEFAULT_FIXTURE_PATH, type StagedBuild } from "../../src/importer/assemble.ts";
import { importReference } from "../../src/importer/cli.ts";
import { type FixtureData, FixtureError } from "../../src/importer/fixtureSchema.ts";
import { buildFixtureContent, loadFixtureData } from "../../src/importer/fixtures.ts";
import { asRelease, at, cleanupTempDirs, EXPECTED_CONTENT_HASH, stagedFull, tempDir } from "../helpers.ts";

afterAll(cleanupTempDirs);

const isError = (f: Finding) => f.severity === "error";

/** A fresh copy of the committed fixture file. */
function committed(): FixtureData {
  return JSON.parse(readFileSync(DEFAULT_FIXTURE_PATH, "utf8")) as FixtureData;
}

/** A modified copy of the committed fixture file, written to a temp dir; returns its path. */
function writeWith(mutate: (d: FixtureData) => void): string {
  const data = committed();
  mutate(data);
  const fixturePath = join(tempDir("cabin-kit-fixture-"), "fixture-data.json");
  writeFileSync(fixturePath, JSON.stringify(data));
  return fixturePath;
}

/** Stage the fixtures only, from a modified copy of the committed fixture file. */
function buildWith(mutate: (d: FixtureData) => void): StagedBuild {
  return buildStagedRelease({ fixturePath: writeWith(mutate), includeCandidate: false });
}

function firstSeatSpec(d: FixtureData) {
  return at(Object.values(d.seatSpecs), 0);
}

function fixtureInvalid(build: StagedBuild): Finding[] {
  return build.findings.filter((f) => f.code === "FIXTURE_INVALID");
}

describe("fixture file schema (IMP-04)", () => {
  test("the committed fixture file validates and its content hash is unchanged", () => {
    const build = stagedFull();
    expect(build.findings.filter(isError)).toEqual([]);
    expect(build.findings.filter((f) => f.code === "FIXTURE_INVALID")).toEqual([]);
    expect(contentHash(build.content)).toBe(EXPECTED_CONTENT_HASH);
  });

  test("a substitute with released:false stays unreleased and its alternate is excluded at lookup", () => {
    const build = buildWith((d) => {
      at(d.substitutes, 0).released = false;
    });
    expect(build.content.substitutes.find((s) => s.id === "FX-SUB-KIT-1")?.released).toBe(false);
    const result = lookup(asRelease(build.content), "N100TL", "2026-11-12");
    const kitRule = Object.values(result.resolution?.rules ?? {}).find((r) => r.partNo === "FAKE-CK-2001");
    expect(kitRule?.substitutes).toEqual([]);
    expect(kitRule?.excludedSubstitutes.map((s) => [s.id, s.reasons.map((r) => r.code)])).toEqual([["FX-SUB-KIT-1", ["NOT_RELEASED"]]]);
  });

  test("a rule with qtyPerReplacement 3 keeps 3", () => {
    const build = buildWith((d) => {
      at(d.extraRules, 0).qtyPerReplacement = 3;
    });
    const id = at(committed().extraRules, 0).id;
    expect(build.content.rules.find((r) => r.id === id)?.qtyPerReplacement).toBe(3);
  });

  test.each<[string, (d: FixtureData) => void, RegExp]>([
    ["unknown top-level key", (d) => Object.assign(d, { surprise: 1 }), /surprise/],
    [
      "partOverrides key typo",
      (d) => {
        d.partOverrides["V01|ELR|A|CUSHON"] = "FAKE-X";
      },
      /V01\|ELR\|A\|CUSHON/,
    ],
    [
      "partOverrides key for a seat the layout does not have",
      (d) => {
        d.partOverrides["V01|EXIT|B|CUSHION"] = "FAKE-X";
      },
      /V01\|EXIT\|B\|CUSHION/,
    ],
    [
      "variantOmissions for unknown variant",
      (d) => {
        d.variantOmissions.V99 = { noBinRules: true };
      },
      /V99/,
    ],
    ["omitted seat that does not exist", (d) => firstSeatSpec(d).omit.push("99Z"), /99Z/],
    [
      "seat spec used by a variant but not defined",
      (d) => {
        at(d.variants, 0).seatSpec = "S999";
      },
      /S999/,
    ],
    ["duplicate extraParts", (d) => d.extraParts.push({ ...at(d.extraParts, 0), description: "other" }), /FAKE-CK-2002/],
    ["assignment status typo", (d) => Object.assign(at(d.assignments, 0), { status: "relased" }), /assignments\.0\.status/],
    [
      "rows too small for the floor split",
      (d) => {
        firstSeatSpec(d).rows = 5;
      },
      /rows/,
    ],
    ["component claiming the accepted namespace", (d) => Object.assign(at(d.components, 0), { namespace: "accepted" }), /namespace/],
    ["substitute without released", (d) => Reflect.deleteProperty(at(d.substitutes, 0), "released"), /substitutes\.0\.released/],
    ["rule without qtyPerReplacement", (d) => Reflect.deleteProperty(at(d.extraRules, 0), "qtyPerReplacement"), /extraRules\.0\.qtyPerReplacement/],
  ])("%s → FIXTURE_INVALID, release rejected, no exception", (_name, mutate, names) => {
    const build = buildWith(mutate);
    const invalid = fixtureInvalid(build);
    expect(invalid.length).toBeGreaterThan(0);
    expect(invalid.every(isError)).toBe(true);
    expect(invalid.map((f) => f.message).join("\n")).toMatch(names);
    // Nothing from the invalid file reaches the release.
    expect(build.content.rules).toEqual([]);
    expect(build.content.components).toEqual([]);
  });

  test("loadFixtureData throws FixtureError with one `path: message` line per issue; references are checked only once the shape is sound", () => {
    const issuesOf = (path: string): string[] => {
      try {
        loadFixtureData(path);
        return [];
      } catch (error) {
        if (error instanceof FixtureError) return error.issues;
        throw error;
      }
    };
    const both = writeWith((d) => {
      Object.assign(d, { surprise: 1 });
      d.variantOmissions.V99 = {};
    });
    expect(issuesOf(both)).toEqual(['fixture: Unrecognized key: "surprise"']);
    const referenceOnly = writeWith((d) => {
      d.variantOmissions.V99 = {};
    });
    expect(issuesOf(referenceOnly)).toEqual(["variantOmissions.V99: variant V99 does not exist."]);
  });

  test("an import from an invalid fixture file stages a rejected release and does not activate it", () => {
    const dir = tempDir();
    const outcome = importReference({
      referencePath: join(dir, "reference.sqlite"),
      visitsPath: join(dir, "visits.sqlite"),
      fixturePath: writeWith((d) => Object.assign(at(d.assignments, 0), { status: "relased" })),
      includeCandidate: false,
    });
    expect(outcome).toMatchObject({ status: "rejected", activated: false });
  });

  test("a file that is not JSON is FIXTURE_INVALID, not an exception", () => {
    const fixturePath = join(tempDir("cabin-kit-fixture-"), "fixture-data.json");
    writeFileSync(fixturePath, "{ not json");
    const build = buildStagedRelease({ fixturePath, includeCandidate: false });
    expect(fixtureInvalid(build)).toHaveLength(1);
  });

  test("a missing fixture file says it cannot be read, with the path; a file that is not JSON says so", () => {
    const dir = tempDir("cabin-kit-fixture-");
    const missing = join(dir, "no-such-fixture.json");
    const missingMessages = fixtureInvalid(buildStagedRelease({ fixturePath: missing, includeCandidate: false })).map((f) => f.message);
    expect(missingMessages).toHaveLength(1);
    expect(missingMessages[0]).toContain("cannot be read");
    expect(missingMessages[0]).toContain(missing);
    expect(missingMessages[0]).not.toMatch(/JSON/);
    const notJson = join(dir, "fixture-data.json");
    writeFileSync(notJson, "{ not json");
    const notJsonMessages = fixtureInvalid(buildStagedRelease({ fixturePath: notJson, includeCandidate: false })).map((f) => f.message);
    expect(notJsonMessages).toHaveLength(1);
    expect(notJsonMessages[0]).toContain("is not valid JSON");
    expect(notJsonMessages[0]).toContain(notJson);
    expect(notJsonMessages[0]).not.toContain("cannot be read");
  });

  test("a part override for an existing but unreleased variant with a seat spec does not block", () => {
    const build = buildWith((d) => {
      const v11 = d.variants.find((v) => v.id === "V11");
      if (!v11 || v11.released) throw new Error("fixture changed: V11 is expected to be unreleased");
      v11.seatSpec = "S176";
      d.partOverrides["V11|ELR|A|CUSHION"] = "FAKE-X";
      d.partOverrides["V11|CARPET_KIT"] = "FAKE-Y";
    });
    expect(fixtureInvalid(build)).toEqual([]);
  });

  test.each<[string, (d: FixtureData) => void, RegExp]>([
    ["an unknown variant", (d) => Object.assign(d.partOverrides, { "V99|ELR|A|CUSHION": "FAKE-X" }), /V99 does not exist/],
    ["a variant with no seat spec", (d) => Object.assign(d.partOverrides, { "V11|ELR|A|CUSHION": "FAKE-X" }), /V11 has no seat spec/],
    [
      "an unreleased variant's zone and letter that no seat has",
      (d) => {
        Object.assign(d.variants.find((v) => v.id === "V11") ?? {}, { seatSpec: "S176" });
        d.partOverrides["V11|EXIT|B|CUSHION"] = "FAKE-X";
      },
      /no seat of variant V11/,
    ],
  ])("a part override for %s still blocks", (_name, mutate, message) => {
    const invalid = fixtureInvalid(buildWith(mutate));
    expect(invalid.map((f) => f.message).join("\n")).toMatch(message);
    expect(invalid.every(isError)).toBe(true);
  });

  test("at most 50 FIXTURE_INVALID findings are listed", () => {
    const build = buildWith((d) => {
      for (let i = 0; i < 80; i++) d.partOverrides[`V99|ELR|A|CUSHION|${i}`] = "FAKE-X";
    });
    const invalid = fixtureInvalid(build);
    expect(invalid).toHaveLength(50);
    expect(at(invalid, 49).message).toMatch(/31 more/);
  });

  test("components, vocabulary and pending changes are copied, not passed through", () => {
    const data = committed();
    const content = buildFixtureContent(data);
    expect(content.components).toEqual(data.components);
    expect(content.vocabulary).toEqual(data.vocabulary);
    expect(content.pendingChanges).toEqual(data.pendingChanges);
    expect(at(content.components, 0)).not.toBe(at(data.components, 0));
    expect(content.vocabulary).not.toBe(data.vocabulary);
    expect(content.vocabulary.units).not.toBe(data.vocabulary.units);
    expect(at(content.pendingChanges, 0)).not.toBe(at(data.pendingChanges, 0));
  });
});
