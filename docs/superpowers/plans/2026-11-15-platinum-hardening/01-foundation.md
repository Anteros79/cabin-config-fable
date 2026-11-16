# Phase 0: Foundation

Read [`00-index.md`](00-index.md) first: Global Constraints and Decisions apply to every task.

Outcome: a clean clone installs, imports, tests and builds with no file outside the repository; CI runs on every push; new code is linted and strictly typed.

---

### Task 0.1: Vendor the data originals and centralise source-root resolution

Closes TST-01, IMP-12, part of IMP-14. Decision D1.

**Files:**
- Create: `fixtures/originals/` (9 files, copied byte-identical from `../../`), `fixtures/originals/README.md`
- Create: `src/importer/originals.ts`
- Modify: `src/importer/assemble.ts` (`defaultSourceRoot`), `src/importer/candidate.ts` (`ORIGINAL_FILES`), `tools/verify-originals.ts`, `tools/make-comparisons.mjs`, `tools/make-image-previews.mjs`, `tools/evidence/lib/common.mjs`
- Test: `tests/unit/originals.test.ts`

**Interfaces:**
- Produces:
  - `export const ORIGINAL_FILES` — moved unchanged from `candidate.ts` (9 keys: `registryJson`, `templateJson`, `geminiJson`, `configCsv`, `seatsCsv`, `rowsXlsx`, `schemaCsv`, `rtf`, `docx`). `candidate.ts` re-exports it so existing imports keep working.
  - `export const DATA_ORIGINALS: readonly string[]` — `Object.values(ORIGINAL_FILES)`.
  - `export const IMAGE_ORIGINALS: readonly string[]` — the 14 image file names.
  - `export function resolveSourceRoot(env?: NodeJS.ProcessEnv): string` — precedence: `env.CABIN_KIT_SOURCE_ROOT` if it is a non-empty string after trimming → `<PROJECT_ROOT>/fixtures/originals` if that directory exists → `<PROJECT_ROOT>/../..`.
  - `export function assertSourceRoot(root: string): void` — throws `Error("Source root is not a directory: <root>")` unless `statSync(root).isDirectory()`.

- [ ] **Step 1: Copy the originals.** Copy the 9 files named by `ORIGINAL_FILES` from `../../` into `fixtures/originals/`, names unchanged (two contain spaces). They are the first 9 entries of `evidence/originals-manifest.json`; the other 14 are images and stay where they are. Check each with `shasum -a 256` against the manifest's `sha256`.
- [ ] **Step 2: Write `fixtures/originals/README.md`**: three lines stating these are unmodified copies of the supplied files, the manifest that holds their hashes, and that they must never be edited.
- [ ] **Step 3: Write the failing tests** in `tests/unit/originals.test.ts`:

```ts
test("empty CABIN_KIT_SOURCE_ROOT is treated as unset", () => {
  expect(resolveSourceRoot({ CABIN_KIT_SOURCE_ROOT: "" })).toBe(join(PROJECT_ROOT, "fixtures", "originals"));
  expect(resolveSourceRoot({ CABIN_KIT_SOURCE_ROOT: "   " })).toBe(join(PROJECT_ROOT, "fixtures", "originals"));
});
test("explicit root wins", () => {
  expect(resolveSourceRoot({ CABIN_KIT_SOURCE_ROOT: "/x/y" })).toBe("/x/y");
});
test("vendored originals match the manifest byte for byte", () => {
  const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, "evidence", "originals-manifest.json"), "utf8"));
  for (const file of DATA_ORIGINALS) {
    const entry = manifest.files.find((f: { path: string }) => f.path === file);
    expect(statSync(join(PROJECT_ROOT, "fixtures", "originals", file)).size).toBe(entry.bytes);
    expect(sha256(readFileSync(join(PROJECT_ROOT, "fixtures", "originals", file)))).toBe(entry.sha256);
  }
});
test("assertSourceRoot rejects a file and a missing path", () => {
  expect(() => assertSourceRoot(join(PROJECT_ROOT, "package.json"))).toThrow(/not a directory/);
  expect(() => assertSourceRoot("/no/such/dir")).toThrow(/not a directory/);
});
```

  The manifest shape is `{ sourceRoot, recordedAt, files: [{ path, bytes, sha256 }] }`.
- [ ] **Step 4: Run** `npx vitest run tests/unit/originals.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 5: Implement `src/importer/originals.ts`** and point `defaultSourceRoot()` at `resolveSourceRoot()`. Replace the four other copies of the list and the three `??` env reads in `tools/` with imports from this module (the `.mjs` tools import the `.ts` file directly; Node 24 strips types).
- [ ] **Step 6: Prove the clean-clone path.** Run `CABIN_KIT_SOURCE_ROOT= CABIN_KIT_DATA_DIR=$(mktemp -d) node src/importer/cli.ts import`. Expected: the release is `validated` and `active`, and the content hash prefix is `6df51180` (the same as an import from `../../`, because the bytes are identical). Then `npx vitest run`. Expected: 136 passed (132 existing + 4 new).
- [ ] **Step 7: Commit** `feat(importer): vendor data originals, single source-root resolver (TST-01, IMP-12, IMP-14)`.

---

### Task 0.2: Repository hygiene and the compatibility fixture

Closes part of TST-10. Prepares Review Focus 1.

**Files:**
- Modify: `.gitignore`
- Remove from the index (keep on disk): `.impeccable/`, `inspection/baseline-copy/**/__pycache__/`
- Create: `tests/fixtures/visits-5d6679d.sqlite`, `tests/fixtures/README.md`

- [ ] **Step 1: Capture the compatibility fixture before any source change.** With the working tree at `5d6679d` plus Task 0.1 only:

```bash
D=$(mktemp -d) && CABIN_KIT_DATA_DIR="$D" node src/importer/cli.ts import && CABIN_KIT_DATA_DIR="$D" node tools/seed-sample-visits.ts && node -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]+"/visits.sqlite");d.exec("PRAGMA wal_checkpoint(TRUNCATE)");d.prepare("VACUUM INTO ?").run("tests/fixtures/visits-5d6679d.sqlite")' "$D"
```

  Expected: a single file holding one completed and one draft visit. Record in `tests/fixtures/README.md` the commit, the command, and both visit numbers.
- [ ] **Step 2: Extend `.gitignore`** with: `.impeccable/`, `__pycache__/`, `*.pyc`, `coverage/`, `test-results/`, `playwright-report/`, `verification/out/`, `.DS_Store`, `.env*`, `*.log`, `*.tsbuildinfo`.
- [ ] **Step 3: Untrack** with `git rm -r --cached .impeccable` and `git rm -r --cached inspection/baseline-copy/app/__pycache__ inspection/baseline-copy/tests/__pycache__`.
- [ ] **Step 4: Verify** `git status --short` lists only the intended changes and `git ls-files | grep -c -E '\.pyc$|\.impeccable'` prints `0`.
- [ ] **Step 5: Commit** `chore: ignore caches, add visit-store compatibility fixture (TST-10)`.

---

### Task 0.3: Dependency upgrades

Closes the `npm audit` highs.

**Files:**
- Modify: `package.json`, `package-lock.json`, `src/server/app.ts` only if the `@fastify/static` 10 registration options changed

- [ ] **Step 1: Read the `@fastify/static` 10 changelog** (`node_modules/@fastify/static/README.md` after install, or the GitHub release notes) before touching code. Note any change to `root`, `index`, `cacheControl`, `wildcard` or the decorator names.
- [ ] **Step 2: Upgrade:** `npm install @fastify/static@^10.1.11` and `npm install -D sharp@^0.35.5 pdfjs-dist@^5.7.285` (use the lowest patched `pdfjs-dist` 5.x that `npm audit` accepts; do not move to 6.x in this task).
- [ ] **Step 3: Run** `npm audit --audit-level=moderate`. Expected: `found 0 vulnerabilities`. If a transitive advisory remains, add an `overrides` entry for that package and record why in the commit body.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run && npm run build`. Expected: all pass.
- [ ] **Step 5: Commit** `chore(deps): @fastify/static 10, sharp 0.35, patched pdfjs-dist`.

---

### Task 0.4: Biome, editor config, Node pin, and the `check` script

Closes part of TST-10. Decision D8.

**Files:**
- Create: `biome.json`, `.editorconfig`, `.nvmrc` (content `24`), `.npmrc` (content `engine-strict=true`)
- Modify: `package.json` scripts

**Interfaces:**
- Produces scripts: `lint` = `biome lint .`, `format` = `biome format --write .`, `check` = `biome ci . && npm run typecheck && vitest run`.

- [ ] **Step 1: Install** `npm install -D @biomejs/biome`.
- [ ] **Step 2: Write `biome.json`:** formatter with `lineWidth: 160`, `indentStyle: "space"`, `indentWidth: 2`, double quotes, semicolons always, trailing commas all (these match the existing code, so the first format run changes little). Linter: `recommended: true`, plus `suspicious/noExplicitAny: error`, `correctness/noUnusedVariables: error`, `correctness/noUnusedImports: error`, `style/noNonNullAssertion: warn`, `correctness/useExhaustiveDependencies: error`. `files.ignore`: `dist`, `node_modules`, `evidence`, `verification`, `inspection`, `fixtures/originals`, `coverage`, `playwright-report`, `test-results`.
- [ ] **Step 3: Ban `localeCompare` outside the web client.** Biome has no rule for a method name, so add `tests/unit/conventions.test.ts`: read every `.ts` and `.mjs` file under `src/domain`, `src/importer`, `src/server` and `tools`, and fail listing each `file:line` that matches `/\.localeCompare\(/`. Declare it with `test.fails` for now (11 uses exist); Task 0.6 removes them and flips it to `test`.
- [ ] **Step 4: Run** `npx biome format --write .` then `npx biome lint .`. Fix every error. For `useExhaustiveDependencies` errors in `src/web`, add the dependency if that is behaviour-neutral; otherwise add a `// biome-ignore lint/correctness/useExhaustiveDependencies: fixed in Task 4.x` with the task number, and list each in the commit body. Do not change web behaviour in this task.
- [ ] **Step 5: Run** `npm run check`. Expected: PASS.
- [ ] **Step 6: Commit** in two commits so the diff is reviewable: `style: apply biome format` (format only), then `chore: add biome, editorconfig, nvmrc, check script (TST-10)`.

---

### Task 0.5: Split the TypeScript project and turn on strict flags

Closes part of TST-10.

**Files:**
- Create: `tsconfig.base.json`, `tsconfig.node.json`, `tsconfig.web.json`
- Modify: `tsconfig.json` (becomes `{ "files": [], "references": [...] }`), `package.json` (`typecheck` = `tsc -b`)
- Modify: every file `tsc` then reports (about 150 sites, mostly `src/domain`, `src/importer`, `src/web/scene`)

**Interfaces:**
- `tsconfig.base.json` `compilerOptions`: the current options plus `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`, `noFallthroughCasesInSwitch: true`, `noImplicitReturns: true`, `noUnusedLocals: true`, `noUnusedParameters: true`, `composite: true`, `tsBuildInfoFile` under `node_modules/.cache/`.
- `tsconfig.node.json`: `lib: ["ES2023"]`, `types: ["node"]`, includes `src/domain`, `src/importer`, `src/server`, `tests/unit`, `tests/integration`, `tests/process`, `tools/*.ts`, `vitest.config.ts`.
- `tsconfig.web.json`: `lib: ["ES2023","DOM","DOM.Iterable"]`, `types: ["vite/client"]`, `jsx: "react-jsx"`, includes `src/web`, `src/domain` (types only, as a reference to the node project), `vite.config.ts`.
- `exactOptionalPropertyTypes` and `noPropertyAccessFromIndexSignature` stay off: 250 further errors for little safety. Record that in a comment in `tsconfig.base.json`.

- [ ] **Step 1: Create the three configs** and make `tsconfig.json` reference them. Run `npx tsc -b`. Expected: about 150 errors, all `TS2532`/`TS18048`/`TS2345` from index access, plus a handful of unused locals.
- [ ] **Step 2: Fix by kind, not by suppression.**
  - Array or record read that the surrounding code already proves present: restructure so the proof is visible (`for (const [i, row] of rows.entries())`, `const first = arr[0]; if (!first) throw ...`).
  - Regex match groups: `const [, a, b] = m; if (a === undefined || b === undefined) return null;`.
  - `Map.get` results: guard and throw `new Error("invariant: ...")` with the key in the message.
  - Use `!` only where the line above establishes the bound (`i < arr.length`), at most once per function.
  - Domain code must not gain new thrown `TypeError`s: where data could be absent at run time (anything read from a release), return the existing explicit state or push a finding.
- [ ] **Step 3: Server code must not see the DOM.** After the split, `npx tsc -b` must fail if you add `document.title` to `src/server/app.ts`. Try it, see `TS2304`, revert.
- [ ] **Step 4: Run** `npm run check`. Expected: PASS, same test count as after Task 0.1.
- [ ] **Step 5: Commit** `refactor(types): project references, noUncheckedIndexedAccess (TST-10)`.

---

### Task 0.6: One comparator, one canonical-JSON module

Closes DOM-11, SRV-13.

**Files:**
- Create: `src/domain/order.ts`, `src/domain/canonical.ts`
- Modify: `src/importer/assemble.ts` (re-export `canonicalJson`; keep `contentHash`), `src/server/visitStore.ts`, `src/server/referenceStore.ts`, and the 11 `localeCompare` sites in `src/domain/kits.ts`, `report.ts`, `prep.ts`, `resolve.ts`, `src/importer/fixtures.ts`, `src/server/app.ts`
- Test: `tests/unit/order.test.ts`, flip `tests/unit/conventions.test.ts`

**Interfaces:**
- Produces:
  - `export function compareCodePoints(a: string, b: string): number` returning -1, 0 or 1 by UTF-16 code-unit order (`a < b ? -1 : a > b ? 1 : 0`).
  - `export function byKey<T>(key: (item: T) => string): (a: T, b: T) => number`.
  - `export function canonicalJson(value: unknown): string` (moved unchanged from `assemble.ts`).
  - `export function sha256Hex(text: string): string`.

- [ ] **Step 1: Write the failing tests:**

```ts
test("order is independent of the host locale", () => {
  expect(["FAKE-AZ-1", "FAKE-AA-1", "A_B", "AB"].sort(compareCodePoints)).toEqual(["AB", "A_B", "FAKE-AA-1", "FAKE-AZ-1"]);
});
test("canonicalJson sorts keys at every depth and is stable", () => {
  expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
});
test("canonicalJson refuses non-finite numbers", () => {
  expect(() => canonicalJson({ q: Infinity })).toThrow(/non-finite/);
  expect(() => canonicalJson({ q: NaN })).toThrow(/non-finite/);
});
```

  The third test is new behaviour: today `Infinity` serialises as `null` (DOM-05). Add the check in `canonicalJson`: throw `Error("canonicalJson: non-finite number at <path>")`.
- [ ] **Step 2: Run.** Expected: FAIL, modules not found.
- [ ] **Step 3: Implement,** then replace every `localeCompare` in the four trees. The `/api/tails` sort in `app.ts` counts.
- [ ] **Step 4: Prove hashes did not move.** Before the change, record `node src/importer/cli.ts status` content hash from a temp-dir import (`6df51180…` at `5d6679d`). After the change, import again into a fresh temp dir. The hash must be identical. If it differs, a fixture string sorts differently by code unit than by ICU; that is a real reordering, so list the affected ids in the commit body and accept the new hash.
- [ ] **Step 5: Flip the conventions test** from `test.fails` to `test`. Run `npm run check`. Expected: PASS.
- [ ] **Step 6: Commit** `refactor(domain): code-point ordering and canonical JSON in domain (DOM-11, SRV-13)`.

---

### Task 0.7: Coverage and CI

Closes part of TST-09, TST-10.

**Files:**
- Create: `.github/workflows/ci.yml`, `SECURITY.md`, `CHANGELOG.md`
- Modify: `vitest.config.ts`, `package.json`

**Interfaces:**
- `vitest.config.ts` uses `test.projects`: `unit` (`tests/unit`, timeout 5 s), `integration` (`tests/integration`, 20 s), `process` (`tests/process`, 60 s, `pool: "forks"`). Phase 4 adds a `web` project.
- Coverage: provider `v8`, `include: ["src/domain/**","src/importer/**","src/server/**"]`, reporters `text-summary` and `lcov`, thresholds set to the measured baseline rounded down to the nearest 5 for lines and branches. Phases 1–3 each end by raising them; the final floor is 90 lines / 85 branches for `src/domain` and 85 / 75 for `src/server` and `src/importer`.
- Scripts: `coverage` = `vitest run --coverage`.

- [ ] **Step 1: Install** `npm install -D @vitest/coverage-v8`. Configure projects and coverage. Run `npm run coverage` and write the measured numbers into the thresholds and into `CHANGELOG.md` under "Unreleased / Baseline".
- [ ] **Step 2: Write `.github/workflows/ci.yml`:** trigger on `push` and `pull_request`; one job on `ubuntu-latest` and one on `macos-latest`; steps `actions/checkout@v4`, `actions/setup-node@v4` with `node-version-file: .nvmrc` and `cache: npm`, `npm ci`, `npm run lint`, `npm run typecheck`, `npm run coverage`, `npm run build`, `npm audit --omit=dev --audit-level=high`, then `CABIN_KIT_DATA_DIR=$RUNNER_TEMP/ck node src/importer/cli.ts import` to prove the clean-clone import. Upload `coverage/lcov.info` as an artifact. The E2E job is added in Task 6.1.
- [ ] **Step 3: Write `SECURITY.md`:** loopback only, no authentication, what the Host and Origin checks cover (filled in by Task 1.1), how to report a problem.
- [ ] **Step 4: Validate the workflow locally** with `npx --yes action-validator .github/workflows/ci.yml` if network access allows; otherwise check the YAML parses with `node -e 'require("node:fs").readFileSync(".github/workflows/ci.yml","utf8")'` and review by eye.
- [ ] **Step 5: Run** `npm run check && npm run coverage`. Expected: PASS at or above thresholds.
- [ ] **Step 6: Commit** `ci: coverage thresholds and GitHub Actions workflow (TST-09, TST-10)`.
