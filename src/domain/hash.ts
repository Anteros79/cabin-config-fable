import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import type { ReleaseContent } from "./types.ts";

/** Node-only (excluded from the web project); kept apart from canonical.ts so the browser bundle never pulls in node:crypto. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function contentHash(content: ReleaseContent): string {
  return sha256Hex(canonicalJson(content));
}
