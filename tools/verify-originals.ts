// Re-hash every supplied original and compare with the manifest recorded at the start of the work.
//   node tools/verify-originals.ts            verify against evidence/originals-manifest.json
//   node tools/verify-originals.ts --write    (re)write the manifest from the current files
// Originals are only read. Exit code 1 if any file is missing or differs.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(process.env.CABIN_KIT_SOURCE_ROOT ?? join(projectRoot, "..", ".."));
const manifestPath = join(projectRoot, "evidence", "originals-manifest.json");

export const ORIGINALS = [
  "southwest 737 lopa normalized.json",
  "southwest_737_lopa_normalized.json",
  "Southwest Cabin Configuration Standard.rtf",
  "gemini-code-1794587815855.json",
  "cabin schema architecture.csv",
  "southwest_737_lopa_seats.csv",
  "southwest_737_lopa_rows.xlsx",
  "southwest_737_lopa_configurations.csv",
  "Current Aircraft Seat Configurations.docx",
  "Southwest-Airlines-new-RECARO-seats-Video-still-Southwest.png",
  "barrier.webp",
  "carpet.jpg",
  "forward galley flight deck.jpg",
  "rear galley.jpg",
  "recarro 2.jpg",
  "seats 1.jpeg",
  "seats 2 .jpeg",
  "seats 3.jpg",
  "seats 4.jpg",
  "seats 5.jpg",
  "seats 6.avif",
  "seats 8.jpg",
  "southwest seats-7.webp",
];

interface Entry {
  path: string;
  bytes: number;
  sha256: string;
}

function current(): (Entry | { path: string; missing: true })[] {
  return ORIGINALS.map((path) => {
    const full = join(sourceRoot, path);
    if (!existsSync(full)) return { path, missing: true as const };
    const bytes = readFileSync(full);
    return { path, bytes: statSync(full).size, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
}

const now = current();
if (process.argv.includes("--write")) {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({ sourceRoot: "../.. (development folder root)", recordedAt: new Date().toISOString(), files: now }, null, 2) + "\n");
  console.log(`manifest written: ${now.length} files`);
} else {
  if (!existsSync(manifestPath)) {
    console.error("No manifest found. Run with --write first.");
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { recordedAt: string; files: Entry[] };
  let bad = 0;
  for (const expected of manifest.files) {
    const actual = now.find((f) => f.path === expected.path);
    const ok = actual && !("missing" in actual) && actual.sha256 === expected.sha256 && actual.bytes === expected.bytes;
    if (!ok) bad += 1;
    console.log(`${ok ? "unchanged" : "CHANGED  "}  ${expected.sha256.slice(0, 16)}  ${String(expected.bytes).padStart(8)}  ${expected.path}`);
  }
  console.log(`\n${manifest.files.length - bad}/${manifest.files.length} originals unchanged since ${manifest.recordedAt} (checked ${new Date().toISOString()})`);
  if (bad) process.exit(1);
}
