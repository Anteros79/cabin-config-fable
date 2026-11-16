import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { importReference } from "../../src/importer/cli.ts";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      s.close(() => res(port));
    });
  });
}

export interface Server {
  url: string;
  port: number;
  dataDir: string;
  stop(): Promise<void>;
  restart(): Promise<void>;
  cleanup(): void;
}

/**
 * A real server process on a free loopback port with disposable stores in a temp directory.
 * It never uses ./data, port 4310, or any existing history.
 */
export async function startServer(options: { dataDir?: string; testFaults?: boolean } = {}): Promise<Server> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "cabin-kit-e2e-"));
  const referencePath = join(dataDir, "reference.sqlite");
  const visitsPath = join(dataDir, "visits.sqlite");
  importReference({ referencePath, visitsPath });
  const port = await freePort();
  let child: ChildProcess | null = null;
  const launch = () =>
    new Promise<void>((res, rej) => {
      child = spawn(process.execPath, [join(PROJECT_ROOT, "src", "server", "main.ts")], {
        env: {
          ...process.env,
          CABIN_KIT_DATA_DIR: dataDir,
          CABIN_KIT_PORT: String(port),
          CABIN_KIT_HOST: "127.0.0.1",
          // the e2e build carries window.__cabinKit; the normal build does not (PF-14)
          CABIN_KIT_WEB_ROOT: process.env.CABIN_KIT_WEB_ROOT ?? join(PROJECT_ROOT, "dist", "web-e2e"),
          CABIN_KIT_TEST_FAULTS: options.testFaults === false ? "0" : "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let err = "";
      const timer = setTimeout(() => rej(new Error(`server did not start: ${err}`)), 20000);
      child.stdout?.on("data", (d) => {
        if (String(d).includes("listening on")) {
          clearTimeout(timer);
          res();
        }
      });
      child.stderr?.on("data", (d) => (err += d));
      child.on("exit", (code) => {
        if (code !== 0 && code !== null) rej(new Error(`server exited ${code}: ${err}`));
      });
    });
  const stop = () =>
    new Promise<void>((res) => {
      if (!child || child.exitCode !== null) return res();
      child.once("exit", () => res());
      child.kill("SIGTERM");
    });
  await launch();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    dataDir,
    stop,
    async restart() {
      await stop();
      await launch();
    },
    cleanup() {
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Uses the installed Google Chrome; no browser download. */
export async function launchBrowser(extraArgs: string[] = []): Promise<Browser> {
  return chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--hide-scrollbars", ...extraArgs],
  });
}

export async function waitFor3D(page: Page, timeout = 20000): Promise<void> {
  await page.waitForFunction(() => document.querySelector("canvas[data-ready='true']") !== null && (window.__cabinKit?.scene?.frameCount ?? 0) > 1, undefined, {
    timeout,
  });
}

/** Let the scene settle (damping, texture upload) before a capture. */
export async function settle(page: Page, ms = 450): Promise<void> {
  await page.waitForTimeout(ms);
}

export async function sceneInfo(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => window.__cabinKit?.scene?.describeScene() ?? {});
}
