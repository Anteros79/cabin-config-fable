// Re-hash every supplied original and compare with the manifest recorded at the start of the work.
//   node tools/verify-originals.ts                    verify against evidence/originals-manifest.json
//   node tools/verify-originals.ts --write            write the manifest from the current files (refuses to replace one)
//   node tools/verify-originals.ts --write --force    replace an existing manifest
// Originals are only read. The files checked are the union of the nine data originals, the fourteen images and the
// manifest entries. Exit code 1 if the manifest is empty, a file is missing, an original is not in the manifest or a
// file differs; 64 for a command line that cannot be used.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntryPoint, parseCliArgs, UsageError } from "../src/importer/args.ts";
import { DATA_ORIGINALS, IMAGE_ORIGINALS, resolveImageRoot } from "../src/importer/originals.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const ORIGINALS: readonly string[] = [...DATA_ORIGINALS, ...IMAGE_ORIGINALS];

export interface VerifyPaths {
  /** The folder with the vendored data originals. */
  vendoredRoot: string;
  /** The folder with all the originals (images included); may be absent. */
  sourceRoot: string;
  manifestPath: string;
}

export const DEFAULT_PATHS: VerifyPaths = {
  vendoredRoot: join(projectRoot, "fixtures", "originals"),
  sourceRoot: resolveImageRoot(),
  manifestPath: join(projectRoot, "evidence", "originals-manifest.json"),
};

interface Entry {
  path: string;
  bytes: number;
  sha256: string;
}
type Hashed = Entry | { path: string; missing: true };

const USAGE = "Usage: node tools/verify-originals.ts [--write [--force]]";

function hashFile(root: string, path: string): Hashed {
  const full = join(root, path);
  if (!existsSync(full) || !statSync(full).isFile()) return { path, missing: true as const };
  const bytes = readFileSync(full);
  return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export type Log = (line: string) => void;

/** Write the manifest from `paths.sourceRoot`. Returns the exit code. */
export function writeOriginalsManifest(paths: VerifyPaths, { force }: { force: boolean }, log: Log, logError: Log): number {
  if (!isDirectory(paths.sourceRoot)) {
    logError(`Cannot write the manifest: source root not present: ${paths.sourceRoot}`);
    return 1;
  }
  const hashed = ORIGINALS.map((path) => hashFile(paths.sourceRoot, path));
  const missing = hashed.filter((h) => "missing" in h).map((h) => h.path);
  if (missing.length > 0) {
    logError(`Cannot write the manifest: ${missing.length} original(s) missing from ${paths.sourceRoot}: ${missing.join(", ")}`);
    return 1;
  }
  if (existsSync(paths.manifestPath) && !force) {
    logError(`The manifest already exists: ${paths.manifestPath}. Pass --force to replace it.`);
    return 1;
  }
  mkdirSync(dirname(paths.manifestPath), { recursive: true });
  writeFileSync(
    paths.manifestPath,
    `${JSON.stringify({ sourceRoot: "../.. (development folder root)", recordedAt: new Date().toISOString(), files: hashed }, null, 2)}\n`,
  );
  log(`manifest written: ${hashed.length} files`);
  return 0;
}

/** Verify the originals against the manifest. Returns the exit code. */
export function verifyOriginals(paths: VerifyPaths, log: Log, logError: Log): number {
  if (!existsSync(paths.manifestPath)) {
    logError("No manifest found. Run with --write first.");
    return 1;
  }
  let manifest: { recordedAt?: string; files?: Entry[] };
  try {
    manifest = JSON.parse(readFileSync(paths.manifestPath, "utf8"));
  } catch {
    logError(`The manifest is not valid JSON: ${paths.manifestPath}`);
    return 1;
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (files.length === 0) {
    logError("The manifest lists no files; there is nothing to verify.");
    return 1;
  }
  const recorded = new Map(files.map((f) => [f.path, f]));
  const sourcePresent = isDirectory(paths.sourceRoot);
  const hasImageFolder = sourcePresent && resolve(paths.sourceRoot) !== resolve(paths.vendoredRoot);
  const union = [...new Set([...ORIGINALS, ...recorded.keys()])];
  const same = (actual: Hashed, expected: Entry): boolean => !("missing" in actual) && actual.sha256 === expected.sha256 && actual.bytes === expected.bytes;

  let checked = 0;
  let bad = 0;
  let skipped = 0;
  for (const path of union) {
    const expected = recorded.get(path);
    if (!expected) {
      bad += 1;
      log(`NOT IN MANIFEST  ${path}`);
      continue;
    }
    const isData = DATA_ORIGINALS.includes(path);
    const isImage = IMAGE_ORIGINALS.includes(path);
    const places: [string, Hashed][] = [];
    if (isData) places.push(["vendored", hashFile(paths.vendoredRoot, path)]);
    if (sourcePresent) places.push(["source  ", hashFile(paths.sourceRoot, path)]);
    // An image is optional while no folder that holds images is present (the folder is absent, or is the vendored
    // data folder); everything else must be on disk.
    if (isImage && !hasImageFolder) {
      skipped += 1;
      log(`skipped (not present)  ${path}`);
      continue;
    }
    for (const [where, actual] of places) {
      checked += 1;
      const ok = same(actual, expected);
      if (!ok) bad += 1;
      const state = "missing" in actual ? "MISSING  " : ok ? "unchanged" : "CHANGED  ";
      log(`${state}  ${where}  ${expected.sha256.slice(0, 16)}  ${String(expected.bytes).padStart(8)}  ${path}`);
    }
    if (places.length === 0) {
      bad += 1;
      log(`MISSING    ${path} (no folder to check it in)`);
    }
  }
  log(
    `\n${checked - bad}/${checked} checks unchanged since ${manifest.recordedAt ?? "(no date)"}, ${skipped} skipped (not present), ${bad} failed (checked ${new Date().toISOString()})`,
  );
  return bad > 0 ? 1 : 0;
}

/** Runs the tool; returns its exit code. */
export function main(argv: string[], paths: VerifyPaths = DEFAULT_PATHS, log: Log = console.log, logError: Log = console.error): number {
  let args: { write?: boolean; force?: boolean };
  try {
    args = parseCliArgs(argv, { write: { type: "boolean" }, force: { type: "boolean" } });
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    logError(`${e.message}\n${USAGE}`);
    return 64;
  }
  if (args.force && !args.write) {
    logError(`--force only applies to --write\n${USAGE}`);
    return 64;
  }
  return args.write ? writeOriginalsManifest(paths, { force: args.force === true }, log, logError) : verifyOriginals(paths, log, logError);
}

if (isEntryPoint(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2));
