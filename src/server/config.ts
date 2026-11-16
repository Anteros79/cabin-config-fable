import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostnameOf } from "./http/hostGuard.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(here, "..", "..");

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
const LOG_LEVELS: readonly LogLevel[] = ["silent", "error", "warn", "info", "debug"];
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "::1", "localhost"];

/** A setting that cannot be used. The server prints the message and exits with code 2 before touching any store. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

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

/** The trimmed value of an environment variable. Empty or whitespace-only means unset. */
function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * One place decides where the stores live, used by the server, the import CLI and the tests,
 * so "seed" and "start" can never disagree about paths. Relative paths resolve against the working directory.
 * Precedence: explicit argument > environment variable > default under ./data.
 */
export function resolveStoreConfig(overrides: Partial<StoreConfig> = {}, env: NodeJS.ProcessEnv = process.env): StoreConfig {
  const dataDir = resolve(overrides.dataDir ?? setting(env, "CABIN_KIT_DATA_DIR") ?? join(PROJECT_ROOT, "data"));
  return {
    dataDir,
    referencePath: resolve(overrides.referencePath ?? setting(env, "CABIN_KIT_REFERENCE_DB") ?? join(dataDir, "reference.sqlite")),
    visitsPath: resolve(overrides.visitsPath ?? setting(env, "CABIN_KIT_VISITS_DB") ?? join(dataDir, "visits.sqlite")),
  };
}

/** Comma-separated host names, trimmed and lower-cased. Empty or whitespace-only means none. */
function parseHostList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== "");
}

function checkPort(port: number | string): number {
  const text = String(port).trim();
  const value = /^\d{1,5}$/.test(text) ? Number(text) : Number.NaN;
  if (!(value >= 0 && value <= 65535)) throw new ConfigError(`CABIN_KIT_PORT must be a whole number from 0 to 65535 (got "${text}").`);
  return value;
}

function checkHost(host: string, env: NodeJS.ProcessEnv): string {
  if (!LOOPBACK_HOSTS.includes(host) && setting(env, "CABIN_KIT_ALLOW_REMOTE") !== "1") {
    throw new ConfigError(
      `CABIN_KIT_HOST "${host}" is not a loopback address. This server has no authentication. Set CABIN_KIT_ALLOW_REMOTE=1 to accept the risk.`,
    );
  }
  return host;
}

/** Each entry must be a bare host name (or a bracketed IPv6 address): no scheme, path, port, space or wildcard. */
function checkAllowedHosts(hosts: string[]): string[] {
  for (const entry of hosts) {
    const bare = entry.startsWith("[") && entry.endsWith("]") ? entry.slice(1, -1) : entry;
    if (hostnameOf(entry) !== bare.toLowerCase()) {
      throw new ConfigError(
        `CABIN_KIT_ALLOWED_HOSTS entry "${entry}" is not a host name. List host names only, separated by commas, without scheme, path or port.`,
      );
    }
  }
  return hosts;
}

/** CABIN_KIT_WEB_ROOT: the built client to serve. Relative paths resolve against the working directory; it must be an existing directory. */
function checkWebRoot(path: string): string {
  const root = resolve(path);
  let isDirectory = false;
  try {
    isDirectory = statSync(root).isDirectory();
  } catch {
    // missing or unreadable: reported below
  }
  if (!isDirectory) throw new ConfigError(`CABIN_KIT_WEB_ROOT "${path}" is not a directory. Build the client first, or point it at a built client.`);
  return root;
}

function checkLogLevel(value: string | undefined): LogLevel {
  if (value === undefined) return "info";
  const level = LOG_LEVELS.find((l) => l === value);
  if (!level) throw new ConfigError(`CABIN_KIT_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")} (got "${value}").`);
  return level;
}

/** Resolves and validates every server setting; throws ConfigError on the first unusable one. */
export function resolveServerConfig(overrides: Partial<ServerConfig> = {}, env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = checkHost(overrides.host ?? setting(env, "CABIN_KIT_HOST") ?? "127.0.0.1", env);
  const port = checkPort(overrides.port ?? setting(env, "CABIN_KIT_PORT") ?? 4310);
  const allowedHosts = checkAllowedHosts(overrides.allowedHosts ?? parseHostList(env.CABIN_KIT_ALLOWED_HOSTS));
  const logLevel = overrides.logLevel ?? checkLogLevel(setting(env, "CABIN_KIT_LOG_LEVEL"));
  const envWebRoot = setting(env, "CABIN_KIT_WEB_ROOT");
  const webRoot = overrides.webRoot ?? (envWebRoot === undefined ? join(PROJECT_ROOT, "dist", "web") : checkWebRoot(envWebRoot));
  return {
    ...resolveStoreConfig(overrides, env),
    host,
    allowedHosts,
    port,
    webRoot,
    testFaults: overrides.testFaults ?? setting(env, "CABIN_KIT_TEST_FAULTS") === "1",
    logLevel,
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
