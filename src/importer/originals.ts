import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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

/** True when CABIN_KIT_SOURCE_ROOT names the source root (a non-blank value). */
export function isSourceRootExplicit(env: NodeJS.ProcessEnv = process.env): boolean {
  return explicitRoot(env) !== undefined;
}

/** Where the images are read from: CABIN_KIT_SOURCE_ROOT, then ../.. (images are never vendored). */
export function resolveImageRoot(env: NodeJS.ProcessEnv = process.env): string {
  return explicitRoot(env) ?? join(PROJECT_ROOT, "..", "..");
}

/** True only for a regular file; a missing path, a directory or anything unreadable to stat is false. */
export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
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

/** A path as recorded in a finding: relative to the project (with "/"), never an absolute machine path. */
function projectRelative(path: string): string {
  return relative(PROJECT_ROOT, resolve(path)).split(sep).join("/");
}

interface ManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

/** A file-system error as a short code ("ENOENT", "EACCES"), without the absolute path its message carries. */
function errorCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : e instanceof Error ? e.message : String(e);
}

/** The manifest entries by path, or a description of why the manifest cannot be used. */
function readManifest(manifestPath: string): Map<string, ManifestEntry> | string {
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch (e) {
    return `cannot be read (${errorCode(e)})`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "is not valid JSON";
  }
  const files = (parsed as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return 'has no "files" list';
  const entries = new Map<string, ManifestEntry>();
  for (const f of files as Partial<ManifestEntry>[]) {
    if (typeof f?.path === "string" && typeof f.bytes === "number" && typeof f.sha256 === "string") entries.set(f.path, f as ManifestEntry);
  }
  return entries;
}

export interface OriginalsRead {
  findings: Finding[];
  /** The bytes of each original that could be read, by file name: exactly the bytes that were verified. */
  bytes: Map<string, Uint8Array>;
  /** Originals that are regular files but could not be read. */
  unreadable: Set<string>;
}

/**
 * Read each of the nine data originals under `root` once and compare it with the manifest. The bytes
 * returned are the bytes whose size and SHA-256 were checked, so the importer stages exactly what was
 * verified. Never throws; every problem is reported:
 * - the manifest cannot be used: SOURCE_MANIFEST_UNREADABLE (error), and every original is still read;
 * - a path that is not a regular file: SOURCE_FILE_MISSING (error);
 * - a file that cannot be read: SOURCE_UNREADABLE (error);
 * - a file the manifest does not list: SOURCE_HASH_CHANGED (error);
 * - a size or SHA-256 that differs: SOURCE_HASH_CHANGED, an error or, when the operator accepts changed originals, a warning.
 */
export function readOriginals(root: string, manifestPath: string, { acceptChanged = false }: { acceptChanged?: boolean } = {}): OriginalsRead {
  const findings: Finding[] = [];
  const bytes = new Map<string, Uint8Array>();
  const unreadable = new Set<string>();
  const manifest = readManifest(manifestPath);
  if (typeof manifest === "string") {
    const ref = projectRelative(manifestPath);
    findings.push({
      severity: "error",
      code: "SOURCE_MANIFEST_UNREADABLE",
      message: `The originals manifest ${ref} ${manifest}; the originals cannot be verified.`,
      refs: [ref],
    });
  }
  for (const file of DATA_ORIGINALS) {
    const path = join(root, file);
    if (!isRegularFile(path)) {
      findings.push({ severity: "error", code: "SOURCE_FILE_MISSING", message: `Supplied file "${file}" was not found under the source root.`, refs: [file] });
      continue;
    }
    let data: Uint8Array;
    try {
      data = readFileSync(path);
    } catch (e) {
      unreadable.add(file);
      findings.push({ severity: "error", code: "SOURCE_UNREADABLE", message: `Supplied file "${file}" could not be read (${errorCode(e)}).`, refs: [file] });
      continue;
    }
    bytes.set(file, data);
    if (typeof manifest === "string") continue;
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
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (data.length !== expected.bytes || sha256 !== expected.sha256) {
      findings.push({
        severity: acceptChanged ? "warning" : "error",
        code: "SOURCE_HASH_CHANGED",
        message: `Supplied file "${file}" differs from the originals manifest (${data.length} bytes, SHA-256 ${sha256.slice(0, 12)}; expected ${expected.bytes} bytes, ${expected.sha256.slice(0, 12)}).${acceptChanged ? " Accepted with --accept-changed." : " Restore the original, or re-run with --accept-changed to stage it anyway."}`,
        refs: [file],
      });
    }
  }
  return { findings, bytes, unreadable };
}

/** The findings of `readOriginals`: every problem with the nine data originals under `root`. Never throws. */
export function checkOriginals(root: string, manifestPath: string, options: { acceptChanged?: boolean } = {}): Finding[] {
  return readOriginals(root, manifestPath, options).findings;
}
