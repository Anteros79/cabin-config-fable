import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "../../src/server/config.ts";
import { ReferenceStore } from "../../src/server/referenceStore.ts";
import { VisitStore } from "../../src/server/visitStore.ts";
import { CUSHION_3A, makeStores, snapshotFor, tempDir } from "../helpers.ts";

/** Every child spawned by the current test; any still running afterwards is killed, before helpers remove its data dir. */
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

const MAIN = join(PROJECT_ROOT, "src", "server", "main.ts");
const IMPORTER = join(PROJECT_ROOT, "src", "importer", "cli.ts");
/** How long a started server may take to print "listening on" before the wait fails by name. */
const LISTENING_TIMEOUT_MS = 30_000;
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
    const timer = setTimeout(
      () =>
        reject(new Error(`the "listening" wait timed out: no "listening on" from the server within ${LISTENING_TIMEOUT_MS} ms; stdout: ${output.stdout()}`)),
      LISTENING_TIMEOUT_MS,
    );
    child.stdout?.on("data", () => {
      if (output.stdout().includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    output.done.then((exit) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${exit.code} before listening: ${exit.stderr}`));
    });
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
  children.push(child);
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

/**
 * A data directory with the reference data imported once (beforeAll), so a test that is not about the first-start import
 * starts from a copy and its server does no import work of its own.
 */
let importedTemplate = "";
beforeAll(async () => {
  importedTemplate = mkdtempSync(join(tmpdir(), "cabin-kit-main-template-"));
  const child = spawn(process.execPath, [IMPORTER, "import"], { env: cleanEnv({ CABIN_KIT_DATA_DIR: importedTemplate }), stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const exit = await collect(child).done;
  if (exit.code !== 0) throw new Error(`template import exited ${exit.code}: ${exit.stderr}`);
}, 60_000);
afterAll(() => {
  if (importedTemplate) rmSync(importedTemplate, { recursive: true, force: true });
});
/** A fresh data directory holding a copy of the imported template. */
function importedDataDir(): string {
  const dir = tempDir("cabin-kit-main-");
  cpSync(importedTemplate, dir, { recursive: true });
  return dir;
}

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
    const seed = spawn(process.execPath, [SEED], { env: cleanEnv({ CABIN_KIT_DATA_DIR: dataDir }), stdio: ["ignore", "pipe", "pipe"] });
    children.push(seed);
    const seeded = await collect(seed).done;
    expect(seeded.stderr).toBe("");
    expect(seeded.code).toBe(0);
    const server = startMain(dataDir);
    const res = await fetch(`http://127.0.0.1:${await server.port()}/api/health`);
    const health = (await res.json()) as { status: string; visits: { visits: number; drafts: number; completed: number } };
    server.child.kill("SIGTERM");
    expect((await server.done).code).toBe(0);
    expect(health.status).toBe("ok");
    expect(health.visits).toMatchObject({ visits: 3, drafts: 2, completed: 1 });
    expect(releaseCount(dataDir)).toBe(1); // the server used the seed's reference store instead of importing its own
  });

  it("SIGTERM exits 0 cleanly", async () => {
    const dataDir = importedDataDir();
    const server = startMain(dataDir);
    await server.listening;
    server.child.kill("SIGTERM");
    const exit = await server.done;
    expect(exit.code).toBe(0);
    expect(exit.stderr).toBe("");
    expect(exit.stdout, "the copy was already imported").not.toContain("Reference store created");
  });

  it("a second SIGTERM while the server is closing exits 1 at once, without waiting for the shutdown timeout (SRV-08)", async () => {
    const dataDir = importedDataDir();
    const server = startMain(dataDir);
    const port = await server.port();
    // A request whose body never finishes keeps a connection active, so the first SIGTERM's close cannot complete.
    const pending = connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => pending.once("connect", resolve).once("error", reject));
    pending.on("error", () => {});
    // The headers go first with Expect: 100-continue: the server's 100 answer proves it parsed them, so the request is
    // active before the first SIGTERM. Sending the signal earlier could let close complete (flaky under load).
    let answered = "";
    const continued = new Promise<void>((resolve) => {
      const onData = (chunk: Buffer) => {
        answered += chunk.toString("latin1");
        if (answered.includes("HTTP/1.1 100")) {
          pending.off("data", onData);
          resolve();
        }
      };
      pending.on("data", onData);
    });
    pending.write(
      `POST /api/visits HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n`,
    );
    await continued;
    pending.write("{");
    server.child.kill("SIGTERM");
    // The first signal was handled once the listener refuses new connections; only then is the second one sent.
    for (;;) {
      const refused = await new Promise<boolean>((resolve) => {
        const probe = connect(port, "127.0.0.1");
        probe.once("connect", () => {
          probe.destroy();
          resolve(false);
        });
        probe.once("error", () => resolve(true));
      });
      if (refused) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    server.child.kill("SIGTERM");
    const exit = await server.done;
    pending.destroy();
    expect(exit.code).toBe(1);
    // Exiting through the 5 s timeout would print this line: the exit came from the second signal instead.
    expect(exit.stderr).not.toContain("did not finish");
  });

  it("an unhandled rejection is logged on stderr and exits 1 (SRV-08)", async () => {
    const dataDir = importedDataDir();
    // Test-only preload: once main.ts has installed its handler, reject a promise nobody handles.
    const preload = `data:text/javascript,${encodeURIComponent(
      'const t = setInterval(() => { if (process.listenerCount("unhandledRejection") > 0) { clearInterval(t); Promise.reject(new Error("probe rejection")); } }, 1);',
    )}`;
    const child = spawn(process.execPath, ["--import", preload, MAIN], {
      env: cleanEnv({ CABIN_KIT_DATA_DIR: dataDir, CABIN_KIT_PORT: "0" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const exit = await collect(child).done;
    expect(exit.code).toBe(1);
    expect(exit.stderr).toContain("Unhandled rejection: probe rejection");
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
