import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError } from "../api.ts";

/** What a keyed read shows. `idle` is a null key: nothing is asked for. */
export type Resource<T> =
  | { state: "idle"; data: undefined }
  | { state: "loading"; data: T | undefined } // data = previous value while reloading the same key
  | { state: "ready"; data: T }
  | { state: "error"; error: ApiError; data: T | undefined };

export interface ResourceOptions<T> {
  /**
   * True when an answer is older than the copy already on screen (for example a visit with a lower version that a
   * write answer has already overtaken). Such an answer is dropped and the copy on screen stays.
   */
  isOlder?(incoming: T, shown: T): boolean;
}

export type ResourceHandle<T> = Resource<T> & {
  /** Fetches the same key again and keeps the current data on screen until the answer arrives. */
  reload(): void;
  /** Replaces the data for the current key, e.g. with a write answer. An updater that returns undefined changes nothing (PF-18). */
  set(next: T | ((current: T | undefined) => T | undefined)): void;
};

interface Held<T> {
  key: string | null;
  resource: Resource<T>;
}

const IDLE = { state: "idle", data: undefined } as const;
const LOADING = { state: "loading", data: undefined } as const;

function asApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError("http", 0, "CLIENT_ERROR", e instanceof Error ? e.message : String(e));
}

/**
 * One keyed read with cancellation. A new key aborts the request in flight and clears the data; `reload()` keeps it.
 * An answer is applied only when its request is the latest for the current key, and never when `isOlder` says the
 * copy on screen is newer. Unmounting aborts. Cancelled requests are never reported as errors.
 */
export function useResource<T>(key: string | null, fetcher: (signal: AbortSignal) => Promise<T>, options: ResourceOptions<T> = {}): ResourceHandle<T> {
  const [held, setHeld] = useState<Held<T>>({ key: null, resource: IDLE });
  const fetcherRef = useRef(fetcher);
  const isOlderRef = useRef(options.isOlder);
  useLayoutEffect(() => {
    fetcherRef.current = fetcher;
    isOlderRef.current = options.isOlder;
  });
  const keyRef = useRef(key);
  const sequence = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  // After unmount nothing may start: a reload() from a late callback would send a request no cleanup can abort.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = useCallback((keepData: boolean) => {
    if (!mounted.current) return;
    const forKey = keyRef.current;
    inFlight.current?.abort();
    inFlight.current = null;
    const id = ++sequence.current;
    if (forKey === null) {
      setHeld({ key: null, resource: IDLE });
      return;
    }
    const controller = new AbortController();
    inFlight.current = controller;
    setHeld((prev) => ({ key: forKey, resource: { state: "loading", data: keepData && prev.key === forKey ? prev.resource.data : undefined } }));
    const current = () => id === sequence.current && !controller.signal.aborted;
    let answer: Promise<T>;
    try {
      answer = fetcherRef.current(controller.signal);
    } catch (e) {
      answer = Promise.reject(e);
    }
    answer.then(
      (data) => {
        if (!current()) return;
        inFlight.current = null;
        setHeld((prev) => {
          if (prev.key !== forKey) return prev;
          const shown = prev.resource.data;
          const keep = shown !== undefined && isOlderRef.current?.(data, shown) === true;
          return { key: forKey, resource: { state: "ready", data: keep ? shown : data } };
        });
      },
      (e: unknown) => {
        if (!current() || (e instanceof ApiError && e.kind === "aborted")) return;
        inFlight.current = null;
        setHeld((prev) => (prev.key !== forKey ? prev : { key: forKey, resource: { state: "error", error: asApiError(e), data: prev.resource.data } }));
      },
    );
  }, []);

  useEffect(() => {
    keyRef.current = key;
    start(false);
    return () => {
      // A new key or unmount: the old request is cancelled and its answer can no longer apply.
      sequence.current += 1;
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [key, start]);

  const reload = useCallback(() => start(true), [start]);

  const set = useCallback((next: T | ((current: T | undefined) => T | undefined)) => {
    setHeld((prev) => {
      if (prev.key === null || prev.key !== keyRef.current) return prev;
      const value = typeof next === "function" ? (next as (current: T | undefined) => T | undefined)(prev.resource.data) : next;
      if (value === undefined || value === prev.resource.data) return prev;
      const r = prev.resource;
      const resource: Resource<T> =
        r.state === "error"
          ? { state: "error", error: r.error, data: value }
          : r.state === "loading"
            ? { state: "loading", data: value }
            : { state: "ready", data: value };
      return { key: prev.key, resource };
    });
  }, []);

  // Until the effect for a new key has run, the data held is the old key's: it is never shown under the new key.
  const resource: Resource<T> = held.key === key ? held.resource : key === null ? IDLE : LOADING;
  return { ...resource, reload, set };
}
