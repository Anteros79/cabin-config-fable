/**
 * npm run visits:backup -- [--out <file>]
 *
 * Writes a consistent copy of the visit store (SQLite VACUUM INTO), then opens the copy read-only,
 * runs PRAGMA quick_check and prints the path, the byte size and the visit count. Safe while the
 * server is running. Never writes to the source store or its write-ahead log, and never overwrites a file.
 * A copy that fails its check is deleted.
 * Default destination: backups/visits-<YYYYMMDD-HHMMSS>Z.sqlite under the project folder.
 * Exit codes: 0 done, 1 refused or failed, 2 bad arguments.
 */
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseCliArgs } from "../src/importer/args.ts";
import { PROJECT_ROOT, resolveStoreConfig } from "../src/server/config.ts";
import { VisitStore } from "../src/server/visitStore.ts";

function defaultDestination(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return join(PROJECT_ROOT, "backups", `visits-${stamp}Z.sqlite`);
}

/** True when the database header says WAL (file format bytes 18 and 19 are 2). */
function isWalMode(path: string): boolean {
  const header = Buffer.alloc(20);
  const fd = openSync(path, "r");
  try {
    readSync(fd, header, 0, 20, 0);
  } finally {
    closeSync(fd);
  }
  return header[18] === 2 && header[19] === 2;
}

/**
 * Opening a WAL store makes SQLite create its -shm (and -wal) file when missing, even on a read-only
 * connection, and fails when the folder is not writable. When -shm is missing no connection has
 * the store open, so the store and any -wal are copied to a private folder and read from there.
 */
function withReadableStore<T>(visitsPath: string, fn: (path: string) => T): T {
  if (!existsSync(visitsPath) || !isWalMode(visitsPath) || existsSync(`${visitsPath}-shm`)) return fn(visitsPath);
  const dir = mkdtempSync(join(tmpdir(), "cabin-kit-backup-"));
  try {
    const copy = join(dir, basename(visitsPath));
    copyFileSync(visitsPath, copy);
    if (existsSync(`${visitsPath}-wal`)) copyFileSync(`${visitsPath}-wal`, `${copy}-wal`);
    return fn(copy);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function verify(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
    if (rows.length !== 1 || rows[0]?.quick_check !== "ok") {
      throw new Error(`The backup at ${path} failed its integrity check: ${rows.map((r) => r.quick_check).join("; ")}`);
    }
    return Number((db.prepare("SELECT count(*) AS n FROM visits").get() as { n: number }).n);
  } finally {
    db.close();
  }
}

function run(argv: string[]): number {
  let out: string | undefined;
  try {
    out = parseCliArgs(argv, { out: { type: "string" } }).out;
  } catch (e) {
    console.error(`${(e as Error).message}\nUsage: npm run visits:backup -- [--out <file>]`);
    return 2;
  }
  const destination = out ? resolve(out) : defaultDestination(new Date());
  if (existsSync(destination)) {
    console.error(`The backup destination ${destination} already exists. Nothing was written.`);
    return 1;
  }
  const { visitsPath, referencePath } = resolveStoreConfig();
  try {
    withReadableStore(visitsPath, (source) => {
      const store = VisitStore.open(source, referencePath, { readOnly: true });
      try {
        store.backupTo(destination);
      } finally {
        store.close();
      }
    });
    let visits: number;
    try {
      visits = verify(destination);
    } catch (e) {
      rmSync(destination, { force: true }); // a copy that fails its check is not a backup
      throw e;
    }
    console.log(`Backup written: ${destination}`);
    console.log(`Size          : ${statSync(destination).size} bytes`);
    console.log(`Visits        : ${visits} visits`);
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

process.exitCode = run(process.argv.slice(2));
