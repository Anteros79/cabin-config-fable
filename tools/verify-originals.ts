// Re-hash every supplied original and compare with the manifest recorded at the start of the work.
//   node tools/verify-originals.ts            verify against evidence/originals-manifest.json
//   node tools/verify-originals.ts --write    (re)write the manifest from the current files
// Originals are only read. Exit code 1 if any file is missing or differs.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_ORIGINALS, IMAGE_ORIGINALS, resolveImageRoot } from "../src/importer/originals.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Data originals are checked in the vendored folder; all 23 are checked in the development folder when it is present.
const vendoredRoot = join(projectRoot, "fixtures", "originals");
const sourceRoot = resolveImageRoot();
const sourceRootPresent = existsSync(sourceRoot) && statSync(sourceRoot).isDirectory();
const manifestPath = join(projectRoot, "evidence", "originals-manifest.json");

export const ORIGINALS = [...DATA_ORIGINALS, ...IMAGE_ORIGINALS];

interface Entry {
  path: string;
  bytes: number;
  sha256: string;
}

function hashFile(root: string, path: string): Entry | { path: string; missing: true } {
  const full = join(root, path);
  if (!existsSync(full)) return { path, missing: true as const };
  const bytes = readFileSync(full);
  return { path, bytes: statSync(full).size, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function current(root: string): (Entry | { path: string; missing: true })[] {
  return ORIGINALS.map((path) => hashFile(root, path));
}

if (process.argv.includes("--write")) {
  if (!sourceRootPresent) {
    console.error(`Cannot write the manifest: source root not present: ${sourceRoot}`);
    process.exit(1);
  }
  const now = current(sourceRoot);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    JSON.stringify({ sourceRoot: "../.. (development folder root)", recordedAt: new Date().toISOString(), files: now }, null, 2) + "\n",
  );
  console.log(`manifest written: ${now.length} files`);
} else {
  if (!existsSync(manifestPath)) {
    console.error("No manifest found. Run with --write first.");
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { recordedAt: string; files: Entry[] };
  let bad = 0;
  let checked = 0;
  let skipped = 0;
  const same = (actual: Entry | { path: string; missing: true }, expected: Entry): boolean =>
    !("missing" in actual) && actual.sha256 === expected.sha256 && actual.bytes === expected.bytes;
  for (const expected of manifest.files) {
    const isData = DATA_ORIGINALS.includes(expected.path);
    const vendored = isData ? hashFile(vendoredRoot, expected.path) : undefined;
    const original = sourceRootPresent ? hashFile(sourceRoot, expected.path) : undefined;
    if (!vendored && !original) {
      skipped += 1;
      console.log(`skipped (not present)  ${expected.path}`);
      continue;
    }
    for (const [where, actual] of [
      ["vendored", vendored],
      ["source   ", original],
    ] as const) {
      if (!actual) continue;
      checked += 1;
      const ok = same(actual, expected);
      if (!ok) bad += 1;
      console.log(`${ok ? "unchanged" : "CHANGED  "}  ${where}  ${expected.sha256.slice(0, 16)}  ${String(expected.bytes).padStart(8)}  ${expected.path}`);
    }
  }
  console.log(
    `\n${checked - bad}/${checked} checks unchanged since ${manifest.recordedAt}, ${skipped} skipped (not present), ${bad} changed (checked ${new Date().toISOString()})`,
  );
  if (bad) process.exit(1);
}
