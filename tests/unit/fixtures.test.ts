import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { lookup } from "../../src/domain/resolve.ts";
import type { Finding } from "../../src/domain/types.ts";
import { buildStagedRelease, contentHash, DEFAULT_FIXTURE_PATH, type StagedBuild } from "../../src/importer/assemble.ts";
import { importReference } from "../../src/importer/cli.ts";
import { type FixtureData, FixtureError } from "../../src/importer/fixtureSchema.ts";
import { buildFixtureContent, loadFixtureData } from "../../src/importer/fixtures.ts";
import { asRelease, at, cleanupTempDirs, EXPECTED_CONTENT_HASH, fixtureRelease, stagedFull, tempDir } from "../helpers.ts";

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
    ["exit row beyond the layout's rows", (d) => firstSeatSpec(d).exitRows.push(99), /seatSpecs\.\w+\.exitRows: row 99 /],
    ["ELR row beyond the layout's rows", (d) => firstSeatSpec(d).elrRows.push(99), /seatSpecs\.\w+\.elrRows: row 99 /],
    ["row that is both an exit row and an ELR row", (d) => firstSeatSpec(d).elrRows.push(at(firstSeatSpec(d).exitRows, 0)), /seatSpecs\.\w+: row 14 is both/],
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
      v11.binType = "PIVOT";
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

describe("fictional pieces, armrests, bin modules and types, MEL (VAC-2)", () => {
  const release = fixtureRelease();
  const revisionOf = (id: string) => {
    const revision = release.layoutRevisions.find((r) => r.id === id);
    if (!revision) throw new Error(`fixture has no layout revision ${id}`);
    return revision;
  };
  const locationOf = (revisionId: string, locationId: string) => {
    const location = revisionOf(revisionId).locations.find((l) => l.id === locationId);
    if (!location) throw new Error(`${revisionId} has no location ${locationId}`);
    return location;
  };
  const binsOfVariant = (variantId: string) => {
    const revisionId = release.variants.find((v) => v.id === variantId)?.layoutRevisionIds[0] ?? "";
    return revisionOf(revisionId).locations.filter((l) => l.kind === "BIN");
  };

  test("every variant points at the layout for its seat spec and bin type", () => {
    expect(Object.fromEntries(release.variants.map((v) => [v.id, v.layoutRevisionIds]))).toEqual({
      V01: ["FX-L-S176-MAX8-LP@1"],
      V02: ["FX-L-S176-MAX8-PV@1"],
      V03: ["FX-L-S170-PV@1"],
      V04: ["FX-L-S176-800-LP@1"],
      V05: ["FX-L-S176-800-PV@1"],
      V06: ["FX-L-S176-800-PV@1"],
      V07: ["FX-L-S176-800-PV@1"],
      V08: ["FX-L-S176-800-PV@1"],
      V09: ["FX-L-S137-CL@1"],
      V10: ["FX-L-S138-CL@1"],
      V11: ["FX-L-V11-PLANNED@0"],
    });
  });

  test("S176 LARGE_PIVOT layout has 176 seats, 11 bins per side, and the armrests", () => {
    const revision = revisionOf("FX-L-S176-MAX8-LP@1");
    const kinds = { SEAT: 0, ARMREST: 0, FLOOR: 0, BIN: 0 };
    for (const l of revision.locations) kinds[l.kind] += 1;
    // 30 rows x 2 sides x 4 armrests (wall, two between-seat spans, aisle) = 240. Rows 14 and 15 omit B and E, but each
    // span touching the omitted seat also touches a present one (A or C, D or F), so it stays as that seat's inner armrest.
    expect(kinds).toEqual({ SEAT: 176, ARMREST: 240, FLOOR: 4, BIN: 22 });
    expect(revision.locations.filter((l) => l.bin?.side === "L").map((l) => l.label)).toEqual([
      "Overhead bin L-01 (rows 1-2, 6 bags)",
      "Overhead bin L-02 (rows 3-5, 6 bags)",
      "Overhead bin L-03 (rows 6-8, 6 bags)",
      "Overhead bin L-04 (rows 9-11, 6 bags)",
      "Overhead bin L-05 (rows 12-14, 6 bags)",
      "Overhead bin L-06 (rows 15-16, 6 bags)",
      "Overhead bin L-07 (rows 17-19, 6 bags)",
      "Overhead bin L-08 (rows 20-22, 6 bags)",
      "Overhead bin L-09 (rows 23-25, 6 bags)",
      "Overhead bin L-10 (rows 26-28, 6 bags)",
      "Overhead bin L-11 (rows 29-30, 6 bags)",
    ]);
    expect(locationOf("FX-L-S176-MAX8-LP@1", "BIN:R-04").bin).toEqual({ side: "R", module: 4, rowFrom: 9, rowTo: 11, binType: "LARGE_PIVOT", capacityBags: 6 });
    const armrests = (row: number) => revision.locations.filter((l) => l.armrest?.row === row).map((l) => [l.id, l.label, l.armrest?.between]);
    expect(armrests(12)).toEqual([
      ["ARMREST:12-A", "Armrest at the window, 12A", [null, "12A"]],
      ["ARMREST:12-AB", "Armrest between 12A and 12B", ["12A", "12B"]],
      ["ARMREST:12-BC", "Armrest between 12B and 12C", ["12B", "12C"]],
      ["ARMREST:12-C", "Armrest at the aisle, 12C", ["12C", null]],
      ["ARMREST:12-D", "Armrest at the aisle, 12D", [null, "12D"]],
      ["ARMREST:12-DE", "Armrest between 12D and 12E", ["12D", "12E"]],
      ["ARMREST:12-EF", "Armrest between 12E and 12F", ["12E", "12F"]],
      ["ARMREST:12-F", "Armrest at the window, 12F", ["12F", null]],
    ]);
    expect(armrests(14).slice(1, 3)).toEqual([
      ["ARMREST:14-AB", "Armrest beside 14A (no seat 14B)", ["14A", null]],
      ["ARMREST:14-BC", "Armrest beside 14C (no seat 14B)", [null, "14C"]],
    ]);
    expect(locationOf("FX-L-S176-MAX8-LP@1", "ARMREST:12-AB")).toMatchObject({ kind: "ARMREST", componentIds: ["ARMREST"] });
  });

  test("a span that touches only omitted seats is dropped (S137 omits 23C)", () => {
    const row23 = revisionOf("FX-L-S137-CL@1").locations.filter((l) => l.armrest?.row === 23 && l.armrest.side === "L");
    expect(row23.map((l) => [l.id, l.armrest?.between])).toEqual([
      ["ARMREST:23-A", [null, "23A"]],
      ["ARMREST:23-AB", ["23A", "23B"]],
      ["ARMREST:23-BC", ["23B", null]],
    ]);
  });

  test("every seat has the seven seat pieces in order", () => {
    const seats = release.layoutRevisions.flatMap((r) => r.locations.filter((l) => l.kind === "SEAT"));
    expect(seats.length).toBeGreaterThan(0);
    for (const seat of seats) expect(seat.componentIds).toEqual(["CUSHION", "BACKREST", "HEADREST", "SEATBELT", "TRAY", "SEATBACK_NET", "LIFE_VEST"]);
  });

  test("bin pieces follow the bin type", () => {
    const all = [
      "BIN_DOOR",
      "BIN_LATCH",
      "BIN_STRIKER",
      "BIN_PIVOT",
      "BIN_ASSIST",
      "BIN_LINER",
      "BIN_SIDE_PANEL",
      "BIN_BUMPER",
      "BIN_SEAL",
      "BIN_PLACARD",
      "BIN_LABEL",
    ];
    const without = (...ids: string[]) => all.filter((id) => !ids.includes(id));
    for (const [variant, binType, capacityBags, pieces] of [
      ["V01", "LARGE_PIVOT", 6, without("BIN_ASSIST")],
      ["V05", "PIVOT", 4, all],
      ["V09", "CLASSIC", 3, without("BIN_ASSIST", "BIN_BUMPER")],
    ] as const) {
      const bins = binsOfVariant(variant);
      expect(bins.length).toBeGreaterThan(0);
      for (const bin of bins) {
        expect(bin.componentIds).toEqual(pieces);
        expect(bin.bin).toMatchObject({ binType, capacityBags });
      }
    }
  });

  test("binModules must sum to rows", () => {
    const invalid = fixtureInvalid(
      buildWith((d) => {
        const spec = d.seatSpecs.S176;
        if (spec) spec.binModules.L = [3, 3];
      }),
    );
    expect(invalid.map((f) => f.message)).toEqual(["seatSpecs.S176.binModules.L: the modules cover 6 rows, but the layout has 30."]);
  });

  test("N100TL, N200TL and N300TL resolve RESOLVED with every component matched", () => {
    // and every generic example tail that resolved before VAC-2 (one per variant V01-V08 and V10)
    for (const tail of ["N100TL", "N200TL", "N300TL", "N010TL", "N020TL", "N030TL", "N040TL", "N050TL", "N060TL", "N070TL", "N080TL", "N101TL"]) {
      const result = lookup(release, tail, "2026-11-12");
      expect(result.state).toBe("RESOLVED");
      const revision = revisionOf(result.context?.layoutRevision.id ?? "");
      const pieces = revision.locations.reduce((n, l) => n + l.componentIds.length, 0);
      expect(result.resolution?.counts).toEqual({ resolved: pieces, noMatch: 0, ambiguous: 0 });
    }
  });

  test("N090TL stays PARTIAL with the bin gaps", () => {
    const result = lookup(release, "N090TL", "2026-11-12");
    expect(result.state).toBe("PARTIAL");
    // S137, 23 rows, 23C omitted: 137 seats x 7 pieces = 959; armrests 22 rows x 8 + row 23 (3 port, 4 starboard) = 183;
    // 4 floor locations; bins [2,3,3,3,2,3,3,2,2] = 9 per side x 9 CLASSIC pieces x 2 sides = 162. 959 + 183 + 4 + 162 = 1308.
    // No match: every bin piece (V09 has no bin rules) 162, the six exit-row backrests on row 12 (expired source) and the
    // aft carpet panel (unreleased) = 169. Ambiguous: the forward carpet panel. Resolved: 1308 - 169 - 1 = 1138.
    expect(result.resolution?.counts).toEqual({ resolved: 1138, noMatch: 169, ambiguous: 1 });
    const binGaps = result.resolution?.components.filter((c) => c.locationId.startsWith("BIN:") && c.status === "NO_MATCH") ?? [];
    expect(binGaps).toHaveLength(162);
  });

  test("every component and condition used by the UI has exactly one base MEL entry", () => {
    const covers = ["STAINED", "TORN", "WORN", "MISSING", "OTHER"];
    const expected: Record<string, string[]> = {
      CUSHION: covers,
      BACKREST: covers,
      HEADREST: covers,
      SEATBELT: ["BROKEN", "MISSING", "WORN", "OTHER"],
      TRAY: [...covers, "BROKEN"],
      SEATBACK_NET: covers,
      LIFE_VEST: covers,
      ARMREST: covers,
      CARPET_KIT: covers,
      CARPET_PANEL: covers,
      BIN_DOOR: [...covers, "WONT_LATCH"],
      BIN_LATCH: [...covers, "BROKEN", "WONT_LATCH"],
      BIN_STRIKER: [...covers, "BROKEN", "WONT_LATCH"],
      BIN_PIVOT: [...covers, "BROKEN"],
      BIN_ASSIST: [...covers, "BROKEN"],
      BIN_LINER: covers,
      BIN_SIDE_PANEL: covers,
      BIN_BUMPER: covers,
      BIN_SEAL: covers,
      BIN_PLACARD: covers,
      BIN_LABEL: covers,
    };
    const base = release.mel.filter((e) => e.constraint === undefined);
    const got: Record<string, string[]> = {};
    for (const e of base) got[e.componentId] = [...(got[e.componentId] ?? []), e.condition];
    const sorted = (r: Record<string, string[]>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, [...v].sort()]));
    expect(sorted(got)).toEqual(sorted(expected));
    expect(new Set(release.components.map((c) => c.id))).toEqual(new Set(Object.keys(expected)));
    expect(new Set(release.mel.map((e) => e.id)).size).toBe(release.mel.length);
    expect(release.mel.every((e) => e.sourceId === "FX-DOC-MEL")).toBe(true);

    const entry = (componentId: string, condition: string, variant?: string) =>
      release.mel.find((e) => e.componentId === componentId && e.condition === condition && (e.constraint?.variant?.[0] ?? undefined) === variant);
    expect(entry("SEATBELT", "BROKEN")?.result).toEqual({
      class: "MEL",
      item: "FX-25-21-01",
      category: "C",
      intervalDays: 10,
      conditions: "Seat blocked and placarded INOP",
      blocksSeat: true,
    });
    expect(entry("LIFE_VEST", "MISSING")).toMatchObject({
      result: { class: "NO_GO", reason: "A life vest is required at every occupied seat" },
      whenSeatBlocked: { class: "MEL", item: "FX-25-61-01", category: "C", intervalDays: 10, conditions: "Seat blocked" },
    });
    expect(entry("TRAY", "BROKEN")?.result).toMatchObject({ class: "MEL", item: "FX-25-22-01", category: "D", intervalDays: 120 });
    expect(entry("TRAY", "BROKEN", "V09")?.result).toMatchObject({ class: "MEL", item: "FX-25-22-01", category: "C", intervalDays: 10 });
    expect(release.mel.filter((e) => e.constraint !== undefined)).toHaveLength(1);
    expect(entry("BIN_DOOR", "WONT_LATCH")?.result).toEqual({ class: "NO_GO", reason: "Bin cannot be secured" });
    expect(entry("BIN_PIVOT", "MISSING")?.result).toEqual({ class: "NO_GO", reason: "Bin cannot be secured" });
    expect(entry("BIN_STRIKER", "WONT_LATCH")?.result).toMatchObject({ class: "MEL", item: "FX-25-31-01", category: "C" });
    expect(entry("BIN_ASSIST", "BROKEN")?.result).toMatchObject({ class: "MEL", item: "FX-25-31-02", category: "D", intervalDays: 120 });
    expect(entry("BIN_PLACARD", "TORN")?.result).toEqual({ class: "NO_GO", reason: "Maximum-weight placard required" });
    expect(entry("BIN_PLACARD", "WORN")?.result).toEqual({ class: "COSMETIC" });
  });
});
