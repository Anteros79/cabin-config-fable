import { spawn } from "node:child_process";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { VisitStore } from "../../src/server/visitStore.ts";
import { cleanupTempDirs, tempDir } from "../helpers.ts";

afterAll(cleanupTempDirs);

const FIXTURE = join(import.meta.dirname, "../fixtures/visits-5d6679d.sqlite");

/** Another process takes an exclusive lock on a rollback-journal store and releases it after `holdMs`. */
function holdExclusiveLock(path: string, holdMs: number): Promise<{ released: Promise<void> }> {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync(${JSON.stringify(path)});
       db.exec("BEGIN EXCLUSIVE");
       process.stdout.write("locked\\n");
       setTimeout(() => { db.exec("COMMIT"); db.close(); }, ${holdMs});`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const released = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`lock holder exited ${code}`))));
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.stdout.on("data", (d) => {
      if (String(d).includes("locked")) resolve({ released });
    });
  });
}

describe("opening a store another process has locked", () => {
  it("waits for the lock instead of failing (schema version read included)", async () => {
    const dir = tempDir("cabin-kit-busy-");
    const path = join(dir, "visits.sqlite");
    copyFileSync(FIXTURE, path); // rollback-journal mode, so an exclusive lock blocks readers too
    const { released } = await holdExclusiveLock(path, 1500);
    const started = Date.now();
    const store = VisitStore.open(path, join(dir, "reference.sqlite"));
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(store.counts().visits).toBe(2);
    store.close();
    await released;
  });
});
