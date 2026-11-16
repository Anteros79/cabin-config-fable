import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "../../src/server/config.ts";
import { ReferenceStore } from "../../src/server/referenceStore.ts";
import { VisitStore } from "../../src/server/visitStore.ts";
import { CUSHION_3A, cleanupTempDirs, makeStores, snapshotFor, tempDir } from "../helpers.ts";

const children: ChildProcess[] = [];
afterAll(() => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  cleanupTempDirs();
});

const MAIN = join(PROJECT_ROOT, "src", "server", "main.ts");
const BACKUP = join(PROJECT_ROOT, "tools", "backup-visits.ts");
const SEED = join(PROJECT_ROOT, "tools", "seed-sample-visits.ts");

/** The parent environment without any CABIN_KIT_* variable, so a child never sees ./data or a developer's settings. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("CABIN_KIT_")) env[key] = value;
  return { ...env, CABIN_KIT_LOG_LEVEL: "silent", ...extra };
}

interface Exit {
  code: number | null;
  stdout: string;
  stderr: string;
}

function collect(child: ChildProcess): { done: Promise<Exit>; stdout: () => string } {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => (stdout += d));
  child.stderr?.on("data", (d) => (stderr += d));
  const done = new Promise<Exit>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { done, stdout: () => stdout };
}

function startMain(dataDir: string, extra: Record<string, string> = {}) {
  const child = spawn(process.execPath, [MAIN], {
    env: cleanEnv({ CABIN_KIT_DATA_DIR: dataDir, CABIN_KIT_PORT: "0", ...extra }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const output = collect(child);
  const listening = new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", () => {
      if (output.stdout().includes("listening on")) resolve();
    });
    output.done.then((exit) => reject(new Error(`server exited ${exit.code} before listening: ${exit.stderr}`)));
  });
  /** The port the server printed once it is listening. */
  const port = async (): Promise<number> => {
    await listening;
    const found = /listening on http:\/\/[^:]+:(\d+)/.exec(output.stdout());
    if (!found) throw new Error(`no port in: ${output.stdout()}`);
    return Number(found[1]);
  };
  return { child, done: output.done, listening, port };
}

function runTool(args: string[], dataDir: string): Promise<Exit> {
  const child = spawn(process.execPath, [BACKUP, ...args], {
    env: cleanEnv({ CABIN_KIT_DATA_DIR: dataDir }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return collect(child).done;
}

const releaseCount = (dataDir: string): number => {
  const ref = ReferenceStore.open(join(dataDir, "reference.sqlite"), join(dataDir, "visits.sqlite"), { readOnly: true });
  try {
    return ref.listReleases().length;
  } finally {
    ref.close();
  }
};

describe("server process", () => {
  it("first start imports, second start does not re-import", async () => {
    const dataDir = tempDir("cabin-kit-main-");
    const first = startMain(dataDir);
    await first.listening;
    first.child.kill("SIGTERM");
    expect((await first.done).code).toBe(0);
    expect(releaseCount(dataDir)).toBe(1);

    const second = startMain(dataDir);
    await second.listening;
    second.child.kill("SIGTERM");
    const exit = await second.done;
    expect(exit.code).toBe(0);
    expect(exit.stdout).not.toContain("Reference store created");
    expect(releaseCount(dataDir)).toBe(1);
  });

  it("sample:seed and the server read the same CABIN_KIT_DATA_DIR: the server reports the seeded visits", async () => {
    const dataDir = tempDir("cabin-kit-main-");
    const seeded = await collect(spawn(process.execPath, [SEED], { env: cleanEnv({ CABIN_KIT_DATA_DIR: dataDir }), stdio: ["ignore", "pipe", "pipe"] })).done;
    expect(seeded.stderr).toBe("");
    expect(seeded.code).toBe(0);
    const server = startMain(dataDir);
    const res = await fetch(`http://127.0.0.1:${await server.port()}/api/health`);
    const health = (await res.json()) as { status: string; visits: { visits: number; drafts: number; completed: number } };
    server.child.kill("SIGTERM");
    expect((await server.done).code).toBe(0);
    expect(health.status).toBe("ok");
    expect(health.visits).toMatchObject({ visits: 2, drafts: 1, completed: 1 });
    expect(releaseCount(dataDir)).toBe(1); // the server used the seed's reference store instead of importing its own
  });

  it("SIGTERM exits 0 within 5 s", async () => {
    const dataDir = tempDir("cabin-kit-main-");
    const server = startMain(dataDir);
    await server.listening;
    const sent = Date.now();
    server.child.kill("SIGTERM");
    const exit = await server.done;
    expect(exit.code).toBe(0);
    expect(Date.now() - sent).toBeLessThan(5000);
    expect(exit.stderr).toBe("");
  });

  it("an occupied port exits 1 with a clear message", async () => {
    const blocker: Server = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const server = startMain(tempDir("cabin-kit-main-"), { CABIN_KIT_PORT: String(port) });
      server.listening.catch(() => {});
      const exit = await server.done;
      expect(exit.code).toBe(1);
      expect(exit.stderr.trim()).toBe(`Port ${port} is in use. Set CABIN_KIT_PORT.`);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it("a bad port exits 2 before touching any store", async () => {
    const dataDir = tempDir("cabin-kit-main-");
    const server = startMain(dataDir, { CABIN_KIT_PORT: "abc" });
    server.listening.catch(() => {});
    const exit = await server.done;
    expect(exit.code).toBe(2);
    expect(exit.stderr.trim()).toBe('CABIN_KIT_PORT must be a whole number from 0 to 65535 (got "abc").');
    expect(readdirSync(dataDir)).toEqual([]);
  });

  it("an unknown log level exits 2", async () => {
    const dataDir = tempDir("cabin-kit-main-");
    const server = startMain(dataDir, { CABIN_KIT_LOG_LEVEL: "loud" });
    server.listening.catch(() => {});
    const exit = await server.done;
    expect(exit.code).toBe(2);
    expect(exit.stderr).toContain("CABIN_KIT_LOG_LEVEL");
    expect(readdirSync(dataDir)).toEqual([]);
  });
});

/** Two visits in a fresh temp store, closed cleanly (WAL mode, no -wal or -shm left behind). */
function storeWithVisits(): { dataDir: string; visitsPath: string } {
  const stores = makeStores();
  const ref = ReferenceStore.open(stores.referencePath, stores.visitsPath, { readOnly: true });
  const release = ref.loadActive();
  ref.close();
  const store = VisitStore.open(stores.visitsPath, stores.referencePath);
  const snapshot = snapshotFor(release, "N100TL", "2026-11-12");
  const first = store.createVisit(snapshot, "Backup one").visit;
  store.upsertRecord(first.id, CUSHION_3A, undefined);
  store.createVisit(snapshot, "Backup two");
  store.close();
  return { dataDir: stores.dir, visitsPath: stores.visitsPath };
}

const listing = (dir: string) => readdirSync(dir).sort();

describe("visits:backup", () => {
  it("visits:backup writes a verifiable copy and refuses to overwrite", async () => {
    const { dataDir, visitsPath } = storeWithVisits();
    const out = join(tempDir("cabin-kit-backup-"), "nested", "copy.sqlite");
    const before = listing(dataDir);
    const bytes = readFileSync(visitsPath);

    const made = await runTool(["--out", out], dataDir);
    expect(made.stderr).toBe("");
    expect(made.code).toBe(0);
    expect(made.stdout).toContain(out);
    expect(made.stdout).toContain(`${statSync(out).size} bytes`);
    expect(made.stdout).toContain("2 visits");
    const copy = VisitStore.open(out, join(dataDir, "reference.sqlite"), { readOnly: true });
    expect(copy.counts()).toMatchObject({ visits: 2, drafts: 2 });
    copy.close();
    // The source store and its folder are untouched: no -wal or -shm was created beside it.
    expect(listing(dataDir)).toEqual(before);
    expect(readFileSync(visitsPath).equals(bytes)).toBe(true);

    const again = await runTool(["--out", out], dataDir);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("already exists");
  });

  it("backs up a WAL store whose -shm was deleted, including committed WAL pages, without writing beside it", async () => {
    const { dataDir, visitsPath } = storeWithVisits();
    // A writer that commits one more visit and dies without checkpointing leaves the visit only in -wal.
    const writer = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { DatabaseSync } from "node:sqlite";
         const db = new DatabaseSync(${JSON.stringify(visitsPath)});
         db.exec("PRAGMA wal_autocheckpoint=0");
         const row = db.prepare("SELECT * FROM visits LIMIT 1").get();
         const cols = Object.keys(row);
         row.id = "00000000-0000-4000-8000-000000000000"; row.number = 999;
         db.prepare("INSERT INTO visits (" + cols.join(",") + ") VALUES (" + cols.map(() => "?").join(",") + ")").run(...cols.map((c) => row[c]));
         process.kill(process.pid, "SIGKILL");`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const crashed = await collect(writer).done;
    expect(crashed.stderr).toBe("");
    expect(existsSync(`${visitsPath}-wal`)).toBe(true);
    rmSync(`${visitsPath}-shm`);
    const before = listing(dataDir);
    const bytes = readFileSync(visitsPath);
    const wal = readFileSync(`${visitsPath}-wal`);

    const outDir = tempDir("cabin-kit-backup-");
    mkdirSync(join(outDir, "b"));
    const out = join(outDir, "b", "copy.sqlite");
    const made = await runTool(["--out", out], dataDir);
    expect(made.stderr).toBe("");
    expect(made.code).toBe(0);
    expect(made.stdout).toContain("3 visits");
    expect(listing(dataDir)).toEqual(before);
    expect(readFileSync(visitsPath).equals(bytes)).toBe(true);
    expect(readFileSync(`${visitsPath}-wal`).equals(wal)).toBe(true);
  });

  it("backs up a store a running server has open, reading it in place without changing it", async () => {
    const { dataDir, visitsPath } = storeWithVisits();
    const open = VisitStore.open(visitsPath, join(dataDir, "reference.sqlite")); // as a running server would
    try {
      open.rawExec("PRAGMA wal_autocheckpoint=0");
      const ref = ReferenceStore.open(join(dataDir, "reference.sqlite"), visitsPath, { readOnly: true });
      const release = ref.loadActive();
      ref.close();
      open.createVisit(snapshotFor(release, "N100TL", "2026-11-12"), "Backup three"); // lives only in -wal
      expect(existsSync(`${visitsPath}-shm`)).toBe(true);
      const before = listing(dataDir);
      const bytes = readFileSync(visitsPath);

      const out = join(tempDir("cabin-kit-backup-"), "live.sqlite");
      const made = await runTool(["--out", out], dataDir);
      expect(made.stderr).toBe("");
      expect(made.code).toBe(0);
      expect(made.stdout).toContain("3 visits");
      expect(listing(dataDir)).toEqual(before);
      expect(readFileSync(visitsPath).equals(bytes)).toBe(true);
      expect(open.counts().visits).toBe(3);
    } finally {
      open.close();
    }
  });

  it("refuses a missing store and unknown arguments", async () => {
    const empty = tempDir("cabin-kit-backup-");
    const missing = await runTool(["--out", join(empty, "x.sqlite")], empty);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("No visit store exists");
    expect(readdirSync(empty)).toEqual([]);

    const unknown = await runTool(["--into", "x"], empty);
    expect(unknown.code).toBe(2);
    expect(readdirSync(empty)).toEqual([]);
  });
});
