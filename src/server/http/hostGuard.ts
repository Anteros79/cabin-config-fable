import type { ServerConfig } from "../config.ts";

const LOOPBACK = ["localhost", "127.0.0.1", "::1"];
const HOST_PATTERN = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?$/i;

interface HostParts {
  hostname: string;
  port: number | null;
}

function parseHostHeader(value: string | undefined): HostParts | null {
  if (!value) return null;
  const match = HOST_PATTERN.exec(value.trim());
  const name = match?.[1];
  if (!name) return null;
  const hostname = (name.startsWith("[") ? name.slice(1, -1) : name).toLowerCase();
  return { hostname, port: match[2] === undefined ? null : Number(match[2]) };
}

/** Host names the server answers to: loopback, the configured listen host and CABIN_KIT_ALLOWED_HOSTS. */
export function allowedHostnames(config: Pick<ServerConfig, "host" | "allowedHosts">): Set<string> {
  const names = new Set(LOOPBACK);
  const listen = parseHostHeader(config.host)?.hostname ?? config.host.trim().toLowerCase();
  if (listen) names.add(listen);
  for (const host of config.allowedHosts) {
    const name = parseHostHeader(host)?.hostname ?? host.trim().toLowerCase();
    if (name) names.add(name);
  }
  return names;
}

/** Lower-cased host name without port; handles `[::1]:4310`. Null when missing or unparseable. */
export function hostnameOf(hostHeader: string | undefined): string | null {
  return parseHostHeader(hostHeader)?.hostname ?? null;
}

const defaultPort = (protocol: string): number | null => (protocol === "http:" ? 80 : protocol === "https:" ? 443 : null);

/**
 * Whether a state-changing request may proceed. Origin must match Host on (host name, effective port),
 * where an absent port means the scheme default. Sec-Fetch-Site, when sent, must be same-origin or none.
 * Requests with neither header (curl) are allowed.
 */
export function isWriteAllowed(headers: { origin?: string; host?: string; "sec-fetch-site"?: string }): boolean {
  const site = headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const fallback = defaultPort(url.protocol);
  if (fallback === null) return false;
  const host = parseHostHeader(headers.host);
  if (!host) return false;
  const originName = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const originPort = url.port === "" ? fallback : Number(url.port);
  return originName.toLowerCase() === host.hostname && originPort === (host.port ?? fallback);
}
