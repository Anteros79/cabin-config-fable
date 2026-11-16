# Phase 3: Importer and tools

Read [`00-index.md`](00-index.md) first. Requires Phases 0 and 2 (the fixture schema reuses `src/domain/schema.ts` and `limits.ts`).

Outcome: a mistyped command cannot touch the wrong store, a hand-edited export cannot validate, a hostile or merely unusual office file cannot exhaust memory or be mis-read silently, and an unchanged import records nothing.

Conventions:

- Importer tests that need originals copy `fixtures/originals/` into a temp dir, change one file, and call `buildCandidateContent(tempRoot)` or `importReference({ sourceRoot: tempRoot, … })`. This is the pattern at `tests/unit/import.test.ts:158-179`.
- CLI tests spawn `node src/importer/cli.ts …` with `CABIN_KIT_DATA_DIR` set to a temp dir and assert exit code, stderr and what exists on disk afterwards.
- After every task: `npm run originals:verify` must still print 23 of 23 unchanged.

---

### Task 3.1: Strict command-line parsing

Closes IMP-01, the CLI parts of IMP-08.

**Files:**
- Create: `src/importer/args.ts`
- Modify: `src/importer/cli.ts`, `tools/seed-sample-visits.ts`, `tools/verify-originals.ts`, `tools/backup-visits.ts`, `docs/operations.md`
- Test: `tests/unit/args.test.ts`, `tests/process/cli.test.ts`

**Interfaces:**
- ```ts
  export interface OptionSpec { type: "string" | "boolean" }
  export class UsageError extends Error {}
  export function parseCliArgs<S extends Record<string, OptionSpec>>(argv: string[], spec: S): { [K in keyof S]?: S[K]["type"] extends "string" ? string : boolean }
  ```
  Built on `node:util` `parseArgs({ args: argv, options: spec, strict: true, allowPositionals: false })`. Converts every `parseArgs` error into `UsageError`. Additionally rejects a `string` option whose value is empty or starts with `--`.
- Per-command allow-lists in `cli.ts`:

| Command | Options |
| --- | --- |
| `import` | `data-dir`, `reference-db`, `visits-db`, `source-root`, `fixtures`, `label` (strings); `no-activate`, `no-candidate`, `accept-changed` (booleans) |
| `status`, `findings` | `data-dir`, `reference-db`, `visits-db`; `findings` also `release` (string) |
| `reset` | the `import` options plus `yes` (boolean) |
| `help` | none |

  Read the current `cli.ts` and keep every option it already honours; the table is the minimum.
- Exit codes: `0` success; `1` runtime failure; `2` release rejected; `3` visit history changed; `64` usage error (`UsageError`, unknown command, no command). `help` exits 0. Usage errors print one line naming the problem, then the usage text, to stderr.
- Entry-point guard: `if (import.meta.main)`. If the installed Node lacks `import.meta.main`, compare `realpathSync(process.argv[1])` with `fileURLToPath(import.meta.url)`.

- [ ] **Step 1: Write the failing tests.**

```ts
// args.test.ts
test.each([
  [["--no-activte"], /Unknown option/], [["--data-dir"], /argument missing|needs a value/], [["--data-dir", "--yes"], /needs a value/],
  [["--data-dir="], /needs a value/], [["stray"], /Unexpected argument/],
])("parseCliArgs(%j) throws UsageError", (argv, re) => expect(() => parseCliArgs(argv, SPEC)).toThrow(re));
test("--name=value and --name value are equivalent", ...);

// cli.test.ts
test("reset --yes with a mistyped path option exits 64 and rebuilds nothing", async () => {
  await run(["import"]);                                   // default store in temp data dir, 1 release
  const before = sha256File(referencePath);
  const r = await run(["reset", "--yes", "--data-dirr", otherDir]);
  expect(r.code).toBe(64);
  expect(sha256File(referencePath)).toBe(before);
  expect(existsSync(otherDir)).toBe(false);
});
test("reset --yes --data-dir=<other> rebuilds <other>, not the default", ...);
test("import --no-activte exits 64 and stages nothing", ...);
test("unknown command and no command exit 64; help exits 0", ...);
test("reset without --yes leaves the file byte-identical and exits 1", ...);
test("the CLI works when invoked through a symlinked project path", ...);   // prints status, exit 0
test("a rejected import exits 2 and prints the blocking findings", ...);
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** On rejection, print each `error` finding (code and message, at most 20) instead of telling the user to run `findings`; `findings --release <id>` shows any release, defaulting to the newest rather than the active one when the newest is rejected.
- [ ] **Step 4: Document** the exit codes in `docs/operations.md`.
- [ ] **Step 5: Run** `npm run check`. **Commit** `fix(cli): strict option parsing, usage exit code, symlink-safe entry (IMP-01, IMP-08)`.

---

### Task 3.2: A schema for the fixture file

Closes IMP-04.

**Files:**
- Create: `src/importer/fixtureSchema.ts`
- Modify: `src/importer/fixtures.ts`, `fixtures/fixture-data.json` (only to add fields the builder used to hard-code)
- Test: `tests/unit/fixtures.test.ts`

**Interfaces:**
- `export const FixtureDataSchema` — strict zod schema matching the `FixtureData` interface in `fixtures.ts`. `export type FixtureData = z.infer<typeof FixtureDataSchema>` replaces the hand-written interface.
- `export class FixtureError extends Error { issues: string[] }`.
- `loadFixtureData(path)` parses then validates; failure throws `FixtureError` listing `path: message` per issue. `buildStagedRelease` catches it and returns error findings with code `FIXTURE_INVALID` (one per issue, at most 50).
- Honour the data: a substitute's `released` and a rule's `qtyPerReplacement` are read from the file. Both become required in the schema; add them to `fixtures/fixture-data.json` with the values the builder hard-codes today (`true`, `1`) so the content hash does not move.
- Referential checks after the schema, each a `FIXTURE_INVALID` finding naming the key:
  - every `partOverrides` key resolves to an existing variant, zone, letter and component;
  - every `variantOmissions` key is an existing variant and every omitted seat exists in that variant's layout;
  - every `seatSpec` name used by a layout is defined;
  - `extraParts` part numbers are unique;
  - `seatSpecs.*.rows` is at least the number of rows the floor-area split needs (derive the minimum from the split arithmetic at `fixtures.ts:116-121`; today a small value yields negative ranges).
- `components`, `vocabulary` and `pendingChanges` no longer pass through raw: the builder sets `namespace` itself, as it does for other entities.

- [ ] **Step 1: Write the failing tests** (each loads a modified copy through `buildStagedRelease({ fixturePath })`):

```ts
test("the committed fixture file validates and its content hash is unchanged", () => { expect(build().findings.filter(isError)).toEqual([]); expect(build().contentHash.slice(0, 8)).toBe("6df51180"); });
test("a substitute with released:false stays unreleased", () => { /* release.substitutes.find(id).released === false; the alternate is excluded at lookup */ });
test("a rule with qtyPerReplacement 3 keeps 3", ...);
test.each([
  ["unknown top-level key", (d) => { d.surprise = 1; }],
  ["partOverrides key typo", (d) => { d.partOverrides["V01|ELR|A|CUSHON"] = "FAKE-X"; }],
  ["variantOmissions for unknown variant", (d) => { d.variantOmissions.V99 = { omit: ["1A"] }; }],
  ["omitted seat that does not exist", (d) => { firstOmission(d).omit.push("99Z"); }],
  ["duplicate extraParts", (d) => { d.extraParts.push({ ...d.extraParts[0], description: "other" }); }],
  ["assignment status typo", (d) => { d.assignments[0].status = "relased"; }],
  ["rows too small for the floor split", (d) => { firstSeatSpec(d).rows = 5; }],
  ["component claiming the accepted namespace", (d) => { d.components[0].namespace = "accepted"; }],
])("%s → FIXTURE_INVALID, release rejected, no exception", ...);
```

  If the hash in the first test is not `6df51180` after Task 0.6, use the value recorded there.
- [ ] **Step 2: Run, implement, run** `npm run check`. **Commit** `fix(importer): strict fixture schema; honour released and quantity from data (IMP-04)`.

---

### Task 3.3: Cross-format comparison that cannot be bypassed

Closes IMP-02. Review Focus 3.

**Files:**
- Modify: `src/importer/candidate.ts` (the three comparison blocks near lines 296-370 and `sameValue` near line 121)
- Test: `tests/unit/crossFormat.test.ts`

**Interfaces:**
- One helper replaces the three near-identical blocks:
  ```ts
  function compareTable(args: {
    sourceId: string;                        // e.g. "CAND-SRC-CONFIG-CSV"
    label: string;                           // "Configuration CSV"
    expectedFields: readonly string[];       // CONFIG_FIELDS | SEAT_FIELDS | ROW_FIELDS
    keyOf: (record: Record<string, unknown>) => string;
    reference: Record<string, unknown>[];    // from the registry JSON
    other: { headers: string[]; records: Record<string, unknown>[] };
    findings: Finding[];
  }): number                                  // values compared
  ```
- It raises `CROSS_FORMAT_MISMATCH` (error) for each of: header set ≠ `expectedFields` (message lists missing and extra columns); duplicate key in either side; a key present on one side only (lists up to 10 keys); a differing value (existing behaviour). It never `continue`s past a missing record or column.
- The runtime asserts the count: after all three comparisons, if the total compared ≠ `reference rows × fields` summed over the three tables, raise `CROSS_FORMAT_INCOMPLETE` (error) with both numbers. Only the first sheet of the workbook is compared; a workbook with more than one sheet raises warning `XLSX_EXTRA_SHEETS`.
- `sameValue(a, b)`: a string equals a number only if it matches `/^-?(0|[1-9]\d*)(\.\d+)?$/` and the numeric values are equal. `"0x10"`, `"1e1"`, `" 16 "` are not equal to `16`.

- [ ] **Step 1: Write the failing tests,** each on a temp copy of the originals, each expecting at least one `CROSS_FORMAT_MISMATCH` and a rejected release:

```ts
test.each([
  ["config CSV id 73G renamed to 73X", editCsv("southwest_737_lopa_configurations.csv", (t) => t.replace(/^73G,/m, "73X,"))],
  ["config CSV header total_seats renamed", editCsv("southwest_737_lopa_configurations.csv", (t) => t.replace("total_seats", "total_seatz"))],
  ["seats CSV header commercial_tier renamed", editCsv("southwest_737_lopa_seats.csv", (t) => t.replace("commercial_tier", "tier"))],
  ["config CSV reduced to the id column", editCsv("southwest_737_lopa_configurations.csv", keepFirstColumn)],
  ["seats CSV with one row duplicated", editCsv("southwest_737_lopa_seats.csv", duplicateSecondLine)],
  ["seats CSV with one row removed", editCsv("southwest_737_lopa_seats.csv", dropSecondLine)],
  ["config CSV with an extra column", editCsv("southwest_737_lopa_configurations.csv", appendColumn)],
])("%s is rejected", ...);
test("the unmodified originals compare exactly 16,641 values at run time", () => { expect(build().stats.attributeValuesCompared).toBe(16641); expect(errors(build())).toEqual([]); });
test.each([["0x10", 16, false], ["1e1", 10, false], [" 16 ", 16, false], ["16", 16, true], ["16.0", 16, true], ["-3", -3, true]])("sameValue(%j, %j) = %j", ...);
```

  Check the actual id prefix format in the config CSV before writing the first regex.
- [ ] **Step 2: Run.** Expected: the seven edits validate today.
- [ ] **Step 3: Implement, run** `npm run check`. **Commit** `fix(importer): strict cross-format comparison with header and key checks (IMP-02)`.

---

### Task 3.4: Source integrity, shape guards, honest parse status

Closes IMP-03, the registry parts of IMP-08.

**Files:**
- Modify: `src/importer/candidate.ts`, `src/importer/originals.ts`, `src/importer/cli.ts`
- Test: `tests/unit/sourceIntegrity.test.ts`

**Interfaces:**
- `export function checkOriginals(root: string, manifestPath: string): Finding[]` in `originals.ts`. For each of the 9 data originals: not a regular file → `SOURCE_FILE_MISSING` (error; existing code); size or SHA-256 differs from the manifest → `SOURCE_HASH_CHANGED`, severity `error` unless `acceptChanged` is set, then `warning`. Reports all problems, not the first.
- `BuildOptions.acceptChanged?: boolean`, wired to `import --accept-changed`.
- `buildCandidateContent` no longer returns early on the first missing file; every source ends with a real `parseStatus`: `"parsed: …"`, `"not read: file missing"`, `"not parsed: narrative evidence, hash recorded"` (the RTF), or `"invalid: …"`.
- The schema CSV is parsed with `parseCsv`; failure → `SOURCE_UNREADABLE` (error).
- Registry shape guard before any property access: the JSON root must be a plain object with `schema_metadata` (object) and array-valued `lopa_configurations`, `rows`, `seats` (use the real keys the code reads), and every array element a plain object. Otherwise one `REGISTRY_SHAPE` (error) per problem. No raw `TypeError` can escape `buildCandidateContent`; wrap the body so an unexpected exception becomes `IMPORT_INTERNAL` (error) with the message.
- Text sources are decoded with `new TextDecoder("utf-8", { fatal: true })`; failure → `SOURCE_ENCODING` (error).
- `importReference` calls `assertSourceRoot` before opening or creating any store.

- [ ] **Step 1: Write the failing tests.**

```ts
test("an emptied RTF is SOURCE_HASH_CHANGED and the release is rejected", ...);
test("--accept-changed downgrades to a warning and the status says not parsed", ...);
test("an unterminated-quote schema CSV is SOURCE_UNREADABLE", ...);
test.each(["null", "[]", "1", '{"lopa_configurations":[1]}', '{"lopa_configurations":"x"}', "{}"])("registry JSON %s → REGISTRY_SHAPE, no exception", ...);
test("a directory in place of an original is SOURCE_FILE_MISSING, not EISDIR", ...);
test("two missing originals are both reported and no source is left 'pending'", ...);
test("invalid UTF-8 in the seats CSV is SOURCE_ENCODING", ...);
test("a non-existent source root fails before any store file is created", ...);   // data dir stays empty, exit 1
```

- [ ] **Step 2: Run, implement, run** `npm run check`. **Commit** `fix(importer): verify originals against the manifest, guard registry shape (IMP-03, IMP-08)`.

---

### Task 3.5: OOXML readers on a real parser with size caps

Closes IMP-05, IMP-06.

**Files:**
- Create: `src/importer/readers/ooxml.ts`
- Modify: `src/importer/readers/xlsx.ts`, `src/importer/readers/docx.ts`, `tools/evidence/lib/ooxml.mjs` (import the shared helpers)
- Test: `tests/unit/xlsx.test.ts`, `tests/unit/docx.test.ts`, `tests/helpers/ooxml.ts` (builds tiny zips with `fflate` `zipSync`)

**Interfaces:**
- `ooxml.ts`:
  - `export const OOXML_LIMITS = { entryBytes: 32 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, rows: 1_048_576, columns: 16_384, cells: 2_000_000 }`
  - `export class OoxmlError extends Error {}`
  - `export function readZipEntries(bytes: Uint8Array, wanted: (name: string) => boolean): Map<string, Uint8Array>` — uses `fflate` `unzipSync` with `filter`: skip entries `wanted` rejects; throw `OoxmlError("entry too large: <name>")` when `originalSize` exceeds the cap, and when the running total does.
  - `export function parseXml(text: string): unknown` — `fast-xml-parser` `XMLParser` with `ignoreAttributes: false`, `processEntities: false`, `removeNSPrefix: true`, `preserveOrder: true`, `trimValues: false`.
- `readXlsx(bytes)` keeps its return type. Behaviour: inflate only `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/sharedStrings.xml`, and the sheet parts the relationships name (resolve relative targets). A row or cell without `r` takes the next position. `<si/>` is an empty string. Rich text joins every `<t>` under `<r>`; `<rPh>` is ignored. `t="d"`, formulas without a cached value, and any cell type the reader does not know → `OoxmlError("unsupported cell type <t> at <ref>")`. Row index above `rows`, column above `columns`, or cell count above `cells` → `OoxmlError`. `_xHHHH_` escapes are decoded.
- `readDocxParagraphs(bytes)` keeps its return type. Walks the parsed tree: every `w:p` directly under `w:body` or a table cell counts once, including self-closing ones; text in a nested text box is emitted as its own paragraph after the paragraph that contains it; under `mc:AlternateContent` only `mc:Choice` is read; `w:delText` is excluded; `w:tab`, `w:br` and `w:noBreakHyphen` map as today. Missing `word/document.xml` → `OoxmlError`.
- Callers in `candidate.ts` turn `OoxmlError` into `SOURCE_UNREADABLE` (error) with the message.

- [ ] **Step 1: Pin today's output.** Before changing a reader, add tests that snapshot `readXlsx` and `readDocxParagraphs` on the vendored originals: sheet name, row and column counts, the first and last row, paragraph count (67) and the text of paragraphs 1, 30 and 67. They pass now and must still pass after the rewrite.
- [ ] **Step 2: Write the failing tests** on synthetic files:

```ts
// xlsx
test("a sparse row index beyond the sheet limit is refused quickly", () => { /* <row r="50000000"> → OoxmlError in under 100 ms */ });
test("an oversized unrelated entry is never inflated", () => { /* 40 MB of zeros as junk.bin → workbook reads fine */ });
test("an oversized wanted entry is refused", ...);
test("rows and cells without r take the next position", () => { /* three cells → [[1,2,3]] */ });
test("<si/> keeps later shared-string indexes aligned", ...);
test("rich text joins runs; phonetic text is ignored", ...);
test("prefixed elements and relative relationship targets are read", ...);
test("lowercase and absolute cell references resolve", ...);
test("a date-typed cell is refused with its reference", ...);
test("not a zip → OoxmlError", ...);
// docx
test("self-closing paragraphs are counted", () => { /* P001 text, <w:p/>, P003 text */ });
test("a text box paragraph does not truncate its parent", () => { /* outer-a … inner … outer-b all present */ });
test("AlternateContent text appears once", ...);
test("missing word/document.xml → OoxmlError", ...);
```

- [ ] **Step 3: Run.** Expected: synthetic tests FAIL, pin tests PASS.
- [ ] **Step 4: Implement.** `fast-xml-parser` is already a production dependency.
- [ ] **Step 5: Run** `npm run check`, then a temp-dir import: the content hash must equal the one recorded in Task 0.6. **Commit** `fix(importer): parse OOXML with a real parser, cap inflate size and sheet extent (IMP-05, IMP-06)`.

---

### Task 3.6: CSV strictness and measurement parsing

Closes IMP-07, IMP-11.

**Files:**
- Modify: `src/importer/readers/csv.ts`, `src/importer/candidate.ts` (pitch, width, approximate)
- Test: `tests/unit/csv.test.ts`, `tests/unit/measurements.test.ts`

**Interfaces:**
- `parseCsv(text)` keeps its return type and throws `Error` with a 1-based **line** number for: a character other than `,`, CR, LF or end of input after a closing quote; a quote inside an unquoted field; a duplicate header name; an empty header name; a ragged row.
- `export function parseRangeClaim(raw: unknown): { claim: RangeClaim | null; problem: string | null }` in `candidate.ts`:
  - `null`, `undefined`, `""` → `{ claim: null, problem: null }`.
  - A finite number → exact claim, `raw` set to `String(value)`.
  - A string: strip a leading `~` or `≈` (sets `approximate: true`), a trailing `"`, `in`, `in.` or `inches`, and surrounding spaces; accept `N` or `N-M` with hyphen, en dash or em dash and optional spaces, each number `\d+(\.\d+)?`; `min > max` → problem `"range reversed"`.
  - Anything else → `{ claim: null, problem: "unparsed" }`.
  Read `RangeClaim` in `types.ts:74` for the exact field names; do not add fields.
- Each distinct raw value with a `problem` raises one warning `PITCH_UNPARSED` or `WIDTH_UNPARSED` naming the value and how many seats carry it.
- `export function isApproximate(configText: string, value: number): boolean` — true only when the text contains `~` or `≈` immediately followed by exactly that number: build the pattern from `String(value)` with regex metacharacters escaped and a `(?![\d.])` look-ahead.

- [ ] **Step 1: Write the failing tests.**

```ts
test.each([['"x"y,z', 1], ['a,b\nab"c,d', 2], ["a,a\n1,2", 1], [",b\n1,2", 1], ["a,b\n1", 2]])("parseCsv(%j) throws naming line %i", ...);
test("BOM, CRLF, lone CR, quoted newline, doubled quotes, no trailing newline still parse", ...);   // existing behaviour, pinned
test.each([
  ["31-32", { min: 31, max: 32, approximate: false }], ["37", { min: 37, max: 37, approximate: false }],
  ["31–33", { min: 31, max: 33, approximate: false }], ["31 - 33", { min: 31, max: 33, approximate: false }],
  ["~32", { min: 32, max: 32, approximate: true }], ['32"', { min: 32, max: 32, approximate: false }], [32, { min: 32, max: 32, approximate: false }],
])("parseRangeClaim(%j)", ...);
test.each(["33-31", "wide", "31-", "3 1"])("parseRangeClaim(%j) reports a problem", ...);
test.each([['~37.5"', 37, false], ['~37.5"', 37.5, true], ["~3725", 37.5, false], ["about ~37 in", 37, true]])("isApproximate(%j, %j) = %j", ...);
test("the unmodified originals raise no *_UNPARSED finding and keep their hash", ...);
```

- [ ] **Step 2: Run, implement, run** `npm run check`. If the last test fails because the originals contain a value the old parser nulled silently, that is a real discovery: keep the finding, record the value in `docs/missing-evidence.md`, and accept the new hash. **Commit** `fix(importer): strict CSV quoting, explicit measurement parsing (IMP-07, IMP-11)`.

---

### Task 3.7: Stable hash, no-op re-import

Closes IMP-09, IMP-10.

**Files:**
- Modify: `src/importer/assemble.ts`, `src/importer/candidate.ts`, `src/importer/cli.ts`, `src/server/referenceStore.ts`, `README.md`
- Test: `tests/unit/import.test.ts`, `tests/integration/referenceStore.test.ts`

**Interfaces:**
- `contentHash(content)` hashes the content without `label`. `parseStatus` for invalid JSON is the fixed string `"invalid JSON"`; the engine's message goes to the finding and to `stats`, not into hashed content. Both changes move the hash once; record old and new in `CHANGELOG.md`.
- `ReferenceStore.activeContentHash(): string | null`.
- `ImportOutcome` gains `unchanged: boolean`. `importReference`: build and validate in memory; if the result has no blocking finding and its hash equals `activeContentHash()`, return `{ unchanged: true, releaseId: <active id>, … }` without staging. A build with blocking findings is staged as `rejected` only when its hash differs from the most recent rejected release; otherwise it reports the existing rejected id.
- CLI prints `Reference data unchanged: release <id> is already active.` and exits 0.

- [ ] **Step 1: Write the failing tests.**

```ts
test("the hash is the same with a different label", () => expect(build({ label: "a" }).contentHash).toBe(build({ label: "b" }).contentHash));
test("the hash does not contain engine error text", () => expect(canonicalJson(build().content)).not.toMatch(/Unexpected token|is not valid JSON/));
test("the hash is the same from a source root at a different path", ...);
test("importing identical inputs twice creates one release", () => { /* listReleases().length === 1; second outcome.unchanged === true */ });
test("two rejected runs with the same bad input record one rejected release", ...);
test("a changed input after an unchanged import still stages and activates", ...);
```

- [ ] **Step 2: Run, implement, run** `npm run check`. Update the README sentence about `reference:import`. **Commit** `fix(importer): label and engine text out of the hash; skip unchanged imports (IMP-09, IMP-10)`.

---

### Task 3.8: Tools

Closes IMP-13, the rest of IMP-14.

**Files:**
- Modify: `tools/verify-originals.ts`, `tools/seed-sample-visits.ts`, `tools/make-comparisons.mjs`, `tools/make-image-previews.mjs`, `tools/evidence/build-all.mjs`, `tools/evidence/step-docx.mjs`, `tools/evidence/step-hyperlinks.mjs`, `src/importer/candidate.ts` (line 414)
- Test: `tests/process/tools.test.ts`

**Interfaces:**
- `verify-originals`: the module only exports; the script body runs under the entry-point guard. Verifies the **union** of `ORIGINAL_FILES`, `IMAGE_ORIGINALS` and the manifest entries. Zero entries, a file missing on disk, or an original absent from the manifest → non-zero exit. `--write` refuses when any file is missing, and refuses to replace an existing manifest without `--force`. When the source root is `fixtures/originals` (no images present), image entries are reported as `skipped (not vendored)` and do not fail.
- `seed-sample-visits`: exits non-zero with a one-line message when the import is rejected or the lookup is not `RESOLVED`. Creates both sample visits or neither: build both in memory, then write; if the store already holds exactly one sample visit from a failed run, say so and exit 1 rather than reporting "already has visits".
- `make-comparisons`: writes to a temp dir and renames into place when every sheet rendered; `generatedAt` is written only with `--stamp`. Removed from `npm run verify` in Task 6.2.
- `make-image-previews`: output name keeps the source extension (`x.jpg.png`), so two sources that differ only by extension cannot collide.
- `evidence:build`: each step declares `needs: string[]`; `build-all` runs dependencies first and fails with a clear message if a requested subset omits one. Network access is off unless `--online` is passed. With `--online`, `curl` gets `--proto =http,https --max-redirs 3 --max-time 10`, and the private-host test also rejects `127.0.0.0/8`, `169.254.0.0/16`, `0.0.0.0`, `::1`, `fc00::/7`, `fe80::/10` and any bare IP literal.
- Candidate seats carry `componentIds: []` instead of the fixture ids `CUSHION` and `BACKREST`. Check `src/web` for any code that assumes candidate seats have components before changing it; the Layouts view shows them as unresolved either way.

- [ ] **Step 1: Write the failing tests.**

```ts
test("verify-originals fails on an empty manifest", ...);
test("verify-originals fails when an original is missing from the manifest", ...);
test("verify-originals --write refuses when a file is missing, and refuses to overwrite without --force", ...);
test("seeding twice adds nothing; the completed sample has the six README totals", ...);
test("seeding against a rejected import exits non-zero with one line, no stack trace", ...);
test("evidence:build with a subset that omits a dependency names the missing step", ...);
test.each(["127.0.0.1", "169.254.1.1", "0.0.0.0", "[::1]", "10.0.0.5", "192.168.1.1", "localhost"])("link check refuses private host %s", ...);
test("candidate seats have no component ids", ...);
```

- [ ] **Step 2: Run, implement, run** `npm run check && npm run originals:verify`.
- [ ] **Step 3: Raise coverage thresholds** for `src/importer` to at least 85 lines / 75 branches. **Commit** `fix(tools): safe manifest writes, atomic seeding, offline evidence build (IMP-13, IMP-14)`.
