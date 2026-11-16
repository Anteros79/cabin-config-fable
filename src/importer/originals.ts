import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Computed here rather than imported from assemble.ts, which imports this module through candidate.ts.
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
