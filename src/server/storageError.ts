import { DomainError } from "../domain/visitLogic.ts";

/** A failure of a SQLite store itself, as opposed to a domain refusal or a programming error. Answered as 503. */
export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
  }
}

/** How long a connection waits for another connection's lock before SQLite reports busy. */
export const STORE_BUSY_TIMEOUT_MS = 15000;

export function isBusy(e: unknown): boolean {
  const err = e as { code?: string; errcode?: number; message?: string };
  return err?.errcode === 5 || err?.errcode === 6 || /database is locked|SQLITE_BUSY/i.test(err?.message ?? "");
}

/** True for an error raised by SQLite (node:sqlite `ERR_SQLITE_*`, or busy/locked). */
export function isStorageFailure(e: unknown): boolean {
  if (e instanceof DomainError || e instanceof StorageError) return false;
  const code = (e as { code?: unknown })?.code;
  return (typeof code === "string" && code.startsWith("ERR_SQLITE")) || isBusy(e);
}

/** True for SQLITE_CORRUPT (11) or SQLITE_NOTADB (26), including their extended codes: the file itself is damaged. */
export function isCorruption(e: unknown): boolean {
  const err = e as { code?: unknown; errcode?: unknown };
  if (typeof err?.code !== "string" || !err.code.startsWith("ERR_SQLITE") || typeof err.errcode !== "number") return false;
  const primary = err.errcode & 0xff;
  return primary === 11 || primary === 26;
}

/** Wraps a SQLite fault in StorageError; anything else is returned unchanged. */
export function asStorageError(e: unknown): unknown {
  return isStorageFailure(e) ? new StorageError((e as Error).message ?? "", { cause: e }) : e;
}
