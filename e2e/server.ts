import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importReference } from "../src/importer/cli.ts";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface TestServer {
  /** http://127.0.0.1:<port>; the port is kept across restart(). */
  baseURL: string;
  dataDir: string;
  /** Everything the server wrote to stderr so far. */
  stderr(): string;
  restart(): Promise<void>;
  stop(): Promise<void>;
  /** stop() and remove the data directory. */
  dispose(): Promise<void>;
}

const START_TIMEOUT_MS = 20_000;
const KILL_AFTER_MS = 3_000;

/**
 * A real server process on a free loopback port, with stores in a new temp directory (never ./data). The first start asks
 * for port 0 and reads the port from "listening on"; a restart reuses that port so open pages and the base URL stay valid.
 */
export async function startServer(): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), "cabin-kit-e2e-"));
  importReference({ referencePath: join(dataDir, "reference.sqlite"), visitsPath: join(dataDir, "visits.sqlite") });
  let port = 0;
  let child: ChildProcess | null = null;
  let stderr = "";

  const launch = () =>
    new Promise<void>((res, rej) => {
      const proc = spawn(process.execPath, [join(PROJECT_ROOT, "src", "server", "main.ts")], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          CABIN_KIT_DATA_DIR: dataDir,
          CABIN_KIT_HOST: "127.0.0.1",
          CABIN_KIT_PORT: String(port),
          CABIN_KIT_TEST_FAULTS: "1",
          CABIN_KIT_WEB_ROOT: join(PROJECT_ROOT, "dist", "web-e2e"),
          CABIN_KIT_LOG_LEVEL: "warn",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = proc;
      let stdout = "";
      const timer = setTimeout(() => rej(new Error(`server did not start within ${START_TIMEOUT_MS} ms: ${stderr}`)), START_TIMEOUT_MS);
      proc.stdout?.on("data", (d) => {
        stdout += String(d);
        const m = /listening on http:\/\/[^:\s]+:(\d+)/.exec(stdout);
        if (m) {
          clearTimeout(timer);
          port = Number(m[1]);
          res();
        }
      });
      proc.stderr?.on("data", (d) => {
        stderr += String(d);
      });
      proc.on("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0 && code !== null) rej(new Error(`server exited ${code}: ${stderr}`));
      });
    });

  const stop = () =>
    new Promise<void>((res) => {
      const proc = child;
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) return res();
      const kill = setTimeout(() => proc.kill("SIGKILL"), KILL_AFTER_MS);
      proc.once("exit", () => {
        clearTimeout(kill);
        res();
      });
      proc.kill("SIGTERM");
    });

  await launch();
  return {
    baseURL: `http://127.0.0.1:${port}`,
    dataDir,
    stderr: () => stderr,
    async restart() {
      await stop();
      await launch();
    },
    stop,
    async dispose() {
      await stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
