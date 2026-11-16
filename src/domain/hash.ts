import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import type { ReleaseContent } from "./types.ts";

/** Node-only (excluded from the web project); kept apart from canonical.ts so the browser bundle never pulls in node:crypto. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The hash a release is recorded with: its content without the `label`, so two imports of the same
 * data hash the same whatever they are called.
 */
export function contentHash(content: ReleaseContent): string {
  const { label: _label, ...hashed } = content;
  return sha256Hex(canonicalJson(hashed));
}

/**
 * The hash releases were recorded with before the label was taken out (label included). Releases
 * stored then still carry it, so it is accepted when a stored release is verified; it is never
 * used to record a new one.
 */
export function legacyContentHash(content: ReleaseContent): string {
  return sha256Hex(canonicalJson(content));
}
