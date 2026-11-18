import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, newKey } from "../api.ts";

export type SaveStatus =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "saved"; at: string; replayed: boolean }
  | { phase: "failed"; message: string; retryable: boolean } // server answered: not saved; retryable when the refusal was a 5xx
  | { phase: "unknown"; message: string } // no answer: may or may not be saved
  | { phase: "conflict"; code: string; message: string; current: unknown }; // code: which conflict (VISIT_LOCKED, STALE_RECORD, ...)

export interface Mutations<R> {
  statusOf(target: string): SaveStatus;
  isBusy(target: string): boolean;
  anyBusy: boolean;
  /** True while any target's last write has an unknown outcome (PF-18: the leave-page guard needs it). */
  anyUnknown: boolean;
  run(target: string, send: (idempotencyKey: string) => Promise<R>, fingerprint: string): Promise<R | undefined>;
  /** Re-sends the last write of a target with its key. Valid when `canRetry(statusOf(target))`; otherwise ignored. */
  retry(target: string): Promise<R | undefined>;
  dismiss(target: string): void;
}

interface Entry<R> {
  status: SaveStatus;
  key: string;
  fingerprint: string;
  send: (idempotencyKey: string) => Promise<R>;
  /** The key once had an unknown outcome, so its first attempt may be stored until an answer settles it (N2). */
  mayBeStored: boolean;
}

const IDLE: SaveStatus = { phase: "idle" };
/** Answers that mean someone else changed the visit first: the caller reloads and shows the current state. */
const CONFLICT_CODES = new Set(["STALE_RECORD", "STALE_VISIT", "VISIT_LOCKED", "RECORD_NOT_FOUND", "STALE_OBSERVATION", "OBSERVATION_NOT_FOUND"]);
export const UNKNOWN_OUTCOME = "Outcome unknown: the server did not answer, so this may or may not have been saved. Retrying is safe and cannot duplicate it.";

/** A retry of a key whose first attempt may be stored was refused: the refusal says nothing about that first attempt. */
export const retryRefused = (message: string): string =>
  `Outcome unknown: the first attempt may already be stored, and the server refused the retry (${message}). Retrying is safe and cannot duplicate it.`;

export const recordTarget = (locationId: string, componentId: string): string => `record:${locationId}|${componentId}`;
/** A new problem on a piece, or (with `id`) a change to or close of one problem. */
export const observationTarget = (p: { id: string } | { locationId: string; componentId: string }): string =>
  "id" in p ? `observation:${p.id}` : `observation:${p.locationId}:${p.componentId}`;

/** Refusals of a problem write in plain words: the server's own message can name codes ("MUST_FIX"), which the UI never shows. */
const PLAIN_REFUSAL: Record<string, string> = {
  OUTCOME_NOT_ALLOWED: "This can't be saved that way any more. Check the choices and try again.",
  INVALID_OBSERVATION: "Some details are missing or not allowed.",
  REPLACEMENT_MISSING: "Record the replacement first.",
  RECORD_IN_USE: "This replacement is linked to a problem marked replaced.",
};

function outcomeOf(error: unknown, mayBeStored: boolean): SaveStatus {
  if (error instanceof ApiError && error.kind === "http") {
    if (CONFLICT_CODES.has(error.code)) return { phase: "conflict", code: error.code, message: error.message, current: error.details };
    const message = PLAIN_REFUSAL[error.code] ?? error.message;
    // After an unknown outcome a refusal answers only for this attempt: a 5xx can come before the key is looked up,
    // and the create route resolves the configuration (a 4xx) before the store checks the key. So the first attempt
    // may still be stored, and the same key must be kept. Conflicts are raised only after the key is looked up.
    if (mayBeStored) return { phase: "unknown", message: retryRefused(message) };
    return { phase: "failed", message, retryable: error.status >= 500 };
  }
  // No answer, a cancelled request, or anything else: the write may have reached the server.
  return { phase: "unknown", message: UNKNOWN_OUTCOME };
}

/**
 * Whether "Retry safely" applies: after an unknown outcome (same key, so it is stored at most once), or after a
 * server-side failure (5xx: nothing was stored, so the same key is free). A 4xx refusal would only fail again.
 * A refusal of a key whose earlier outcome was unknown stays unknown (see outcomeOf), so it keeps the retry.
 */
export const canRetry = (status: SaveStatus): boolean => status.phase === "unknown" || (status.phase === "failed" && status.retryable);

const isReplay = (result: unknown): boolean => typeof result === "object" && result !== null && (result as { replayed?: unknown }).replayed === true;

/** One line for a status, in the words every save indicator uses. Empty when there is nothing to say. */
export function describeSaveStatus(status: SaveStatus): string {
  switch (status.phase) {
    case "idle":
      return "";
    case "saving":
      return "Saving…";
    case "saved":
      return status.replayed ? "Saved. The earlier attempt had already been stored; nothing was duplicated." : "Saved.";
    case "unknown":
      return status.message;
    case "failed":
    case "conflict":
      return `Not saved: ${status.message}`;
  }
}

/** CSS class for a status; "failed" keeps the existing "error" styling. */
export const saveStatusClass = (status: SaveStatus): string => (status.phase === "failed" ? "error" : status.phase);

/**
 * A per-target write queue. Each target keeps its own status, so one target's outcome never touches another's.
 * Writes go out one at a time in call order, so their answers apply in order. After an unknown outcome the same
 * request (same fingerprint) is sent again with the same idempotency key, so the server stores it at most once.
 * That key stays marked as "may be stored" until a saved or conflict answer settles it; a refusal in between keeps
 * the outcome unknown (N2), so the leave-page guard stays on and no new key is minted for the same request.
 * State lives in a ref, so a second call in the same tick already sees the first; a counter re-renders the caller.
 */
export function useMutations<R>(onResult: (result: R) => void): Mutations<R> {
  const entries = useRef(new Map<string, Entry<R>>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const onResultRef = useRef(onResult);
  useLayoutEffect(() => {
    onResultRef.current = onResult;
  });
  const [, setRevision] = useState(0);
  // An answer that arrives after the view is gone must not navigate or set state on its behalf.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const put = useCallback((target: string, entry: Entry<R>) => {
    entries.current.set(target, entry);
    setRevision((n) => n + 1);
  }, []);

  const enqueue = useCallback(
    (target: string, key: string, fingerprint: string, send: Entry<R>["send"], mayBeStored: boolean): Promise<R | undefined> => {
      put(target, { status: { phase: "saving" }, key, fingerprint, send, mayBeStored });
      const job = queue.current.then(async () => {
        let result: R;
        try {
          result = await send(key);
        } catch (e) {
          const status = outcomeOf(e, mayBeStored);
          put(target, { status, key, fingerprint, send, mayBeStored: status.phase === "unknown" });
          return undefined;
        }
        put(target, {
          status: { phase: "saved", at: new Date().toISOString(), replayed: isReplay(result) },
          key,
          fingerprint,
          send,
          mayBeStored: false,
        });
        if (mounted.current) {
          try {
            onResultRef.current(result);
          } catch (e) {
            // The write is saved; a fault in applying its answer is reported, not turned into a rejected run().
            console.error(e);
          }
        }
        return result;
      });
      queue.current = job;
      return job;
    },
    [put],
  );

  const run = useCallback(
    (target: string, send: Entry<R>["send"], fingerprint: string): Promise<R | undefined> => {
      const current = entries.current.get(target);
      if (current?.status.phase === "saving") return Promise.resolve(undefined);
      const sameRequestUnknown = current?.status.phase === "unknown" && current.fingerprint === fingerprint;
      return sameRequestUnknown ? enqueue(target, current.key, fingerprint, send, true) : enqueue(target, newKey(), fingerprint, send, false);
    },
    [enqueue],
  );

  const retry = useCallback(
    (target: string): Promise<R | undefined> => {
      const current = entries.current.get(target);
      if (!current || !canRetry(current.status)) return Promise.resolve(undefined);
      return enqueue(target, current.key, current.fingerprint, current.send, current.mayBeStored);
    },
    [enqueue],
  );

  const dismiss = useCallback((target: string) => {
    const phase = entries.current.get(target)?.status.phase;
    // A save in flight or an unknown outcome is never hidden: the person must be able to see it and retry it.
    if (phase === undefined || phase === "saving" || phase === "unknown") return;
    entries.current.delete(target);
    setRevision((n) => n + 1);
  }, []);

  const statusOf = useCallback((target: string): SaveStatus => entries.current.get(target)?.status ?? IDLE, []);
  const isBusy = useCallback((target: string) => entries.current.get(target)?.status.phase === "saving", []);

  const phases = [...entries.current.values()].map((e) => e.status.phase);
  return {
    statusOf,
    isBusy,
    anyBusy: phases.includes("saving"),
    anyUnknown: phases.includes("unknown"),
    run,
    retry,
    dismiss,
  };
}
