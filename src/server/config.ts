import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(here, "..", "..");

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
const LOG_LEVELS: readonly string[] = ["silent", "error", "warn", "info", "debug"];

export interface StoreConfig {
  dataDir: string;
  referencePath: string;
  visitsPath: string;
}

export interface ServerConfig extends StoreConfig {
  host: string;
  allowedHosts: string[];
  port: number;
  webRoot: string;
  testFaults: boolean;
  logLevel: LogLevel;
}

/**
 * One place decides where the stores live, used by the server, the import CLI and the tests,
 * so "seed" and "start" can never disagree about paths.
 * Precedence: explicit argument > environment variable > default under ./data.
 */
export function resolveStoreConfig(overrides: Partial<StoreConfig> = {}, env: NodeJS.ProcessEnv = process.env): StoreConfig {
  const dataDir = resolve(overrides.dataDir ?? env.CABIN_KIT_DATA_DIR ?? join(PROJECT_ROOT, "data"));
  return {
    dataDir,
    referencePath: resolve(overrides.referencePath ?? env.CABIN_KIT_REFERENCE_DB ?? join(dataDir, "reference.sqlite")),
    visitsPath: resolve(overrides.visitsPath ?? env.CABIN_KIT_VISITS_DB ?? join(dataDir, "visits.sqlite")),
  };
}

/** Comma-separated host names, trimmed and lower-cased. Empty or whitespace-only means none. */
function parseHostList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== "");
}

export function resolveServerConfig(overrides: Partial<ServerConfig> = {}, env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const stores = resolveStoreConfig(overrides, env);
  return {
    ...stores,
    host: overrides.host ?? env.CABIN_KIT_HOST ?? "127.0.0.1",
    allowedHosts: overrides.allowedHosts ?? parseHostList(env.CABIN_KIT_ALLOWED_HOSTS),
    port: overrides.port ?? Number(env.CABIN_KIT_PORT ?? 4310),
    webRoot: overrides.webRoot ?? join(PROJECT_ROOT, "dist", "web"),
    testFaults: overrides.testFaults ?? env.CABIN_KIT_TEST_FAULTS === "1",
    logLevel: overrides.logLevel ?? (LOG_LEVELS.includes(env.CABIN_KIT_LOG_LEVEL ?? "") ? (env.CABIN_KIT_LOG_LEVEL as LogLevel) : "info"),
  };
}

/** Resolve symlinks for the deepest existing ancestor so two spellings of one file compare equal. */
export function canonicalPath(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(basename(current));
    current = parent;
  }
  const real = existsSync(current) ? realpathSync(current) : current;
  return tail.length ? join(real, ...tail) : real;
}

/** True when both paths name the same file: same canonical path, or same device and inode (hard links). */
export function isSameFile(a: string, b: string): boolean {
  const ca = canonicalPath(a);
  const cb = canonicalPath(b);
  if (ca === cb) return true;
  if (process.platform === "darwin" || process.platform === "win32") {
    if (ca.toLowerCase() === cb.toLowerCase()) return true;
  }
  if (existsSync(ca) && existsSync(cb)) {
    const sa = statSync(ca);
    const sb = statSync(cb);
    if (sa.dev === sb.dev && sa.ino === sb.ino) return true;
  }
  return false;
}
