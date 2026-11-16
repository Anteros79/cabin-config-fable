import { createHash } from "node:crypto";

/** Node-only (excluded from the web project); kept apart from canonical.ts so the browser bundle never pulls in node:crypto. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
