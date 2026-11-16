import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/web/api.ts";
import { type Mutations, useMutations } from "../../src/web/hooks/useMutations.ts";

/** A promise the test settles by hand, so no network and no timers are involved. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const lost = () => new ApiError("network", 0, "NETWORK", "The server could not be reached.");
const refused = (code: string, status = 409, details: unknown = null) => new ApiError("http", status, code, `${code} message`, details);

function setup<R = string>() {
  const results: R[] = [];
  const hook = renderHook(() => useMutations<R>((r) => results.push(r)));
  const m = (): Mutations<R> => hook.result.current;
  return { results, m };
}

describe("useMutations", () => {
  it("a failure on one target survives a success on another", async () => {
    const { m, results } = setup();
    await act(async () => {
      await m().run("A", () => Promise.reject(lost()), "a");
      await m().run("B", () => Promise.resolve("b-done"), "b");
    });
    expect(m().statusOf("A").phase).toBe("unknown");
    expect(m().statusOf("B").phase).toBe("saved");
    expect(m().anyUnknown).toBe(true);
    expect(m().anyBusy).toBe(false);
    expect(results).toEqual(["b-done"]);
  });

  it("retry after an unknown outcome reuses the key", async () => {
    const { m } = setup();
    const keys: string[] = [];
    let attempt = 0;
    const send = (key: string) => {
      keys.push(key);
      attempt += 1;
      return attempt === 1 ? Promise.reject(lost()) : Promise.resolve("ok");
    };
    await act(async () => {
      await m().run("A", send, "a");
    });
    expect(m().statusOf("A").phase).toBe("unknown");
    let retried: string | undefined;
    await act(async () => {
      retried = await m().retry("A");
    });
    expect(retried).toBe("ok");
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(m().statusOf("A").phase).toBe("saved");
    expect(m().anyUnknown).toBe(false);
  });

  it("the same request repeated after an unknown outcome reuses the key; a changed request does not", async () => {
    const { m } = setup();
    const keys: string[] = [];
    const failing = (key: string) => {
      keys.push(key);
      return Promise.reject(lost());
    };
    await act(async () => {
      await m().run("A", failing, '{"note":"x"}');
      await m().run("A", failing, '{"note":"x"}');
      await m().run("A", failing, '{"note":"y"}');
    });
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("a request repeated after a refusal or a success gets a fresh key", async () => {
    const { m } = setup();
    const keys: string[] = [];
    await act(async () => {
      await m().run(
        "A",
        (k) => {
          keys.push(k);
          return Promise.reject(refused("VALIDATION", 400));
        },
        "a",
      );
      await m().run(
        "A",
        (k) => {
          keys.push(k);
          return Promise.resolve("ok");
        },
        "a",
      );
      await m().run(
        "A",
        (k) => {
          keys.push(k);
          return Promise.resolve("ok");
        },
        "a",
      );
    });
    expect(new Set(keys).size).toBe(3);
  });

  it("a second run on a busy target is ignored", async () => {
    const { m, results } = setup();
    const first = deferred<string>();
    const second = vi.fn(() => Promise.resolve("second"));
    let ignored: Promise<string | undefined> | undefined;
    let pending: Promise<string | undefined> | undefined;
    act(() => {
      pending = m().run("A", () => first.promise, "a");
      // Same tick, before any re-render: the busy guard must not depend on React state.
      ignored = m().run("A", second, "a");
    });
    expect(m().isBusy("A")).toBe(true);
    expect(m().anyBusy).toBe(true);
    expect(await ignored).toBeUndefined();
    await act(async () => {
      first.resolve("first");
      await pending;
    });
    expect(second).not.toHaveBeenCalled();
    expect(results).toEqual(["first"]);
    expect(m().isBusy("A")).toBe(false);
  });

  it("results are applied in call order even when the first response is slower", async () => {
    const { m, results } = setup();
    const slow = deferred<string>();
    const fast = vi.fn(() => Promise.resolve("B"));
    let a: Promise<string | undefined> | undefined;
    let b: Promise<string | undefined> | undefined;
    act(() => {
      a = m().run("A", () => slow.promise, "a");
      b = m().run("B", fast, "b");
    });
    // B waits for A: writes go out one at a time.
    expect(fast).not.toHaveBeenCalled();
    expect(m().isBusy("B")).toBe(true);
    await act(async () => {
      slow.resolve("A");
      await a;
      await b;
    });
    expect(results).toEqual(["A", "B"]);
  });

  it("a failed write does not stop the writes queued behind it", async () => {
    const { m, results } = setup();
    await act(async () => {
      const a = m().run("A", () => Promise.reject(refused("STORAGE_UNAVAILABLE", 503)), "a");
      const b = m().run("B", () => Promise.resolve("B"), "b");
      await Promise.all([a, b]);
    });
    expect(m().statusOf("A")).toEqual({ phase: "failed", message: "STORAGE_UNAVAILABLE message" });
    expect(results).toEqual(["B"]);
  });

  it("a conflict carries the server's current state", async () => {
    const { m } = setup();
    await act(async () => {
      await m().run("A", () => Promise.reject(refused("STALE_RECORD", 409, { current: { version: 3 } })), "a");
    });
    expect(m().statusOf("A")).toEqual({ phase: "conflict", message: "STALE_RECORD message", current: { current: { version: 3 } } });
  });

  it("reports a replayed answer as saved without duplication", async () => {
    const { m } = setup<{ replayed: boolean }>();
    await act(async () => {
      await m().run("A", () => Promise.resolve({ replayed: true }), "a");
    });
    const status = m().statusOf("A");
    expect(status.phase === "saved" && status.replayed).toBe(true);
  });

  it("retry is ignored unless the last outcome was unknown or refused", async () => {
    const { m } = setup();
    const send = vi.fn(() => Promise.resolve("ok"));
    await act(async () => {
      expect(await m().retry("A")).toBeUndefined();
      await m().run("A", send, "a");
      expect(await m().retry("A")).toBeUndefined();
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("dismiss clears a finished status but never hides a save in flight or an unknown outcome", async () => {
    const { m } = setup();
    const pending = deferred<string>();
    await act(async () => {
      await m().run("done", () => Promise.resolve("ok"), "d");
      await m().run("lost", () => Promise.reject(lost()), "l");
    });
    let inFlight: Promise<string | undefined> | undefined;
    act(() => {
      inFlight = m().run("busy", () => pending.promise, "b");
      m().dismiss("done");
      m().dismiss("lost");
      m().dismiss("busy");
    });
    expect(m().statusOf("done").phase).toBe("idle");
    expect(m().statusOf("lost").phase).toBe("unknown");
    expect(m().statusOf("busy").phase).toBe("saving");
    await act(async () => {
      pending.resolve("ok");
      await inFlight;
    });
  });

  it("an unknown target reads as idle", () => {
    const { m } = setup();
    expect(m().statusOf("nothing")).toEqual({ phase: "idle" });
    expect(m().isBusy("nothing")).toBe(false);
  });
});
