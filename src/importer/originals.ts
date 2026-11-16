import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding } from "../domain/types.ts";

// Computed here rather than imported from assemble.ts, which imports this module through candidate.ts.
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Sizes and SHA-256 of the originals as first supplied. */
export const ORIGINALS_MANIFEST_PATH = join(PROJECT_ROOT, "evidence", "originals-manifest.json");

/** The nine data and document originals the importer reads. */
export const ORIGINAL_FILES = {
  registryJson: "southwest_737_lopa_normalized.json",
  templateJson: "southwest 737 lopa normalized.json",
  geminiJson: "gemini-code-1794587815855.json",
  configCsv: "southwest_737_lopa_configurations.csv",
  seatsCsv: "southwest_737_lopa_seats.csv",
  rowsXlsx: "southwest_737_lopa_rows.xlsx",
  schemaCsv: "cabin schema architecture.csv",
  rtf: "Southwest Cabin Configuration Standard.rtf",
  docx: "Current Aircraft Seat Configurations.docx",
} as const;

export const DATA_ORIGINALS: readonly string[] = Object.values(ORIGINAL_FILES);

/** The 14 supplied images. They stay in the development folder and are used only by local tools. */
export const IMAGE_ORIGINALS: readonly string[] = [
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

function explicitRoot(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.CABIN_KIT_SOURCE_ROOT?.trim();
  return value ? value : undefined;
}

/** Where the data originals are read from: CABIN_KIT_SOURCE_ROOT, then fixtures/originals, then ../.. */
export function resolveSourceRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = explicitRoot(env);
  if (explicit) return explicit;
  const vendored = join(PROJECT_ROOT, "fixtures", "originals");
  if (existsSync(vendored)) return vendored;
  return join(PROJECT_ROOT, "..", "..");
}

/** Where the images are read from: CABIN_KIT_SOURCE_ROOT, then ../.. (images are never vendored). */
export function resolveImageRoot(env: NodeJS.ProcessEnv = process.env): string {
  return explicitRoot(env) ?? join(PROJECT_ROOT, "..", "..");
}

export function assertSourceRoot(root: string): void {
  let ok = false;
  try {
    ok = statSync(root).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`Source root is not a directory: ${root}`);
}

interface ManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

/** The manifest entries by path, or a description of why the manifest cannot be used. */
function readManifest(manifestPath: string): Map<string, ManifestEntry> | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    return `cannot be read (${(e as Error).message})`;
  }
  const files = (parsed as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return 'has no "files" list';
  const entries = new Map<string, ManifestEntry>();
  for (const f of files as Partial<ManifestEntry>[]) {
    if (typeof f?.path === "string" && typeof f.bytes === "number" && typeof f.sha256 === "string") entries.set(f.path, f as ManifestEntry);
  }
  return entries;
}

/**
 * Compare the nine data originals under `root` with the manifest. A path that is not a regular file is
 * SOURCE_FILE_MISSING (error). A size or SHA-256 that differs from the manifest is SOURCE_HASH_CHANGED:
 * an error, or a warning when the operator accepts changed originals. Every problem is reported.
 */
export function checkOriginals(root: string, manifestPath: string, { acceptChanged = false }: { acceptChanged?: boolean } = {}): Finding[] {
  const findings: Finding[] = [];
  const manifest = readManifest(manifestPath);
  if (typeof manifest === "string") {
    return [
      {
        severity: "error",
        code: "SOURCE_MANIFEST_UNREADABLE",
        message: `The originals manifest ${manifestPath} ${manifest}; the originals cannot be verified.`,
        refs: [manifestPath],
      },
    ];
  }
  for (const file of DATA_ORIGINALS) {
    const path = join(root, file);
    let isFile = false;
    try {
      isFile = statSync(path).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      findings.push({ severity: "error", code: "SOURCE_FILE_MISSING", message: `Supplied file "${file}" was not found under the source root.`, refs: [file] });
      continue;
    }
    const expected = manifest.get(file);
    if (!expected) {
      findings.push({
        severity: "error",
        code: "SOURCE_HASH_CHANGED",
        message: `Supplied file "${file}" is not listed in the originals manifest, so it cannot be verified.`,
        refs: [file],
      });
      continue;
    }
    const bytes = readFileSync(path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== expected.bytes || sha256 !== expected.sha256) {
      findings.push({
        severity: acceptChanged ? "warning" : "error",
        code: "SOURCE_HASH_CHANGED",
        message: `Supplied file "${file}" differs from the originals manifest (${bytes.length} bytes, SHA-256 ${sha256.slice(0, 12)}; expected ${expected.bytes} bytes, ${expected.sha256.slice(0, 12)}).${acceptChanged ? " Accepted with --accept-changed." : " Restore the original, or re-run with --accept-changed to stage it anyway."}`,
        refs: [file],
      });
    }
  }
  return findings;
}
