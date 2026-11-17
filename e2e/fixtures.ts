import { test as base, type Page } from "@playwright/test";
import { startServer, type TestServer } from "./server.ts";

export { expect } from "@playwright/test";

export interface RecordInput {
  locationId: string;
  componentId: string;
  selection: string;
  quantity: number;
  note?: string;
}

export interface Api {
  /** Any API call; the answer's status and parsed JSON (null when there is no JSON body). */
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }>;
  createVisit(tail: string, date: string, technician?: string): Promise<{ id: string; number: number }>;
  addRecord(visitId: string, record: RecordInput): Promise<void>;
  complete(visitId: string): Promise<void>;
  /** POST /api/__test/faults. The fixture clears every fault when the test ends. */
  setFault(body: Record<string, unknown>): Promise<void>;
}

/** An API client for the server at baseURL (the worker's server, or one a test starts for itself). */
export function makeApi(baseURL: string): Api {
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await fetch(`${baseURL}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as T };
  };
  const ok = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await call<T>(method, path, body);
    if (res.status >= 300) throw new Error(`${method} ${path} answered ${res.status}: ${JSON.stringify(res.json)}`);
    return res.json;
  };
  return {
    call,
    async createVisit(tail, date, technician) {
      const { visit } = await ok<{ visit: { id: string; number: number } }>("POST", "/api/visits", { tail, checkDate: date, technician });
      return { id: visit.id, number: visit.number };
    },
    async addRecord(visitId, record) {
      await ok("PUT", `/api/visits/${visitId}/records`, { record });
    },
    async complete(visitId) {
      await ok("POST", `/api/visits/${visitId}/complete`, { confirm: true });
    },
    async setFault(body) {
      await ok("POST", "/api/__test/faults", body);
    },
  };
}

/** The one console error WebKit logs when Playwright screenshots a page under the app's CSP; allowed on WebKit only. */
const WEBKIT_SCREENSHOT_CSP =
  /^console: Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy\. \(/;

interface TestFixtures {
  api: Api;
  /** A fresh draft on N100TL / 2026-11-12, created through the API. */
  visit: { id: string; number: number };
  /** Lets console errors matching the pattern pass the page check (failed loads a test causes on purpose). */
  allowConsoleErrors(pattern: RegExp): void;
  /** Adds a page from another context to the console and page-error check. Pages of the test's own context are watched already. */
  watchPage(page: Page): void;
  /** internal: the errors seen on watched pages, checked at teardown */
  consoleWatch: { allowed: RegExp[]; watch(page: Page): void };
  /** internal: attaches the server's stderr to a failed test */
  serverLog: undefined;
}

interface WorkerFixtures {
  server: TestServer;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  server: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from this destructuring pattern
    async ({}, use) => {
      const server = await startServer();
      await use(server);
      await server.dispose();
    },
    { scope: "worker" },
  ],

  baseURL: async ({ server }, use) => {
    await use(server.baseURL);
  },

  serverLog: [
    async ({ server }, use, testInfo) => {
      const from = server.stderr().length;
      await use(undefined);
      const log = server.stderr().slice(from);
      if (testInfo.status !== testInfo.expectedStatus && log) await testInfo.attach("server stderr", { body: log, contentType: "text/plain" });
    },
    { auto: true },
  ],

  api: async ({ server }, use) => {
    const api = makeApi(server.baseURL);
    try {
      await use(api);
    } finally {
      // a test that stopped the server restarts it before it ends; if it did not, there is no fault left to clear
      await api.call("POST", "/api/__test/faults", {}).catch(() => undefined);
    }
  },

  visit: async ({ api }, use) => {
    await use(await api.createVisit("N100TL", "2026-11-12"));
  },

  consoleWatch: async ({ browserName }, use) => {
    // Playwright's WebKit screenshotter injects a <style> when it takes a screenshot (on a failure, for instance), and
    // the page's CSP refuses it. The app itself logs nothing; Chromium's screenshotter logs nothing either.
    const allowed: RegExp[] = browserName === "webkit" ? [WEBKIT_SCREENSHOT_CSP] : [];
    const errors: string[] = [];
    const watched = new WeakSet<Page>();
    await use({
      allowed,
      watch(page) {
        if (watched.has(page)) return;
        watched.add(page);
        page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
        page.on("console", (m) => {
          // "Failed to load resource" (a failed or refused request) is a console error too, and counts
          if (m.type() === "error") errors.push(`console: ${m.text()}${m.location().url ? ` (${m.location().url})` : ""}`);
        });
      },
    });
    const unexpected = errors.filter((e) => !allowed.some((p) => p.test(e)));
    if (unexpected.length) throw new Error(`A page logged ${unexpected.length} unexpected error(s):\n${unexpected.join("\n")}`);
  },

  allowConsoleErrors: async ({ consoleWatch }, use) => {
    await use((pattern) => consoleWatch.allowed.push(pattern));
  },

  watchPage: async ({ consoleWatch }, use) => {
    await use((page) => consoleWatch.watch(page));
  },

  page: async ({ page, context, consoleWatch }, use) => {
    consoleWatch.watch(page);
    context.on("page", (p) => consoleWatch.watch(p));
    await use(page);
  },
});
