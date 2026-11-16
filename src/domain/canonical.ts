import { compareCodePoints } from "./order.ts";

function canonical(value: unknown, path: string): string {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number at ${path}`);
  if (Array.isArray(value)) return `[${value.map((item, index) => canonical(item, `${path}[${index}]`)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => compareCodePoints(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v, path === "$" ? k : `${path}.${k}`)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Stable JSON: object keys sorted so a hash does not depend on insertion order. Pure, so the browser bundle may import it. */
export function canonicalJson(value: unknown): string {
  return canonical(value, "$");
}
