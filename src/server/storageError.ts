import { DomainError } from "../domain/visitLogic.ts";

/** A failure of a SQLite store itself, as opposed to a domain refusal or a programming error. Answered as 503. */
export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
  }
}

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

/** Wraps a SQLite fault in StorageError; anything else is returned unchanged. */
export function asStorageError(e: unknown): unknown {
  return isStorageFailure(e) ? new StorageError((e as Error).message ?? "", { cause: e }) : e;
}
