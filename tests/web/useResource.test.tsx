import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/web/api.ts";
import { useResource } from "../../src/web/hooks/useResource.ts";

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

/** A fetcher whose answers the test hands out by request, keeping each request's abort signal. */
function controlled<T>() {
  const calls: { key: string; signal: AbortSignal; answer: ReturnType<typeof deferred<T>> }[] = [];
  const fetcherFor = (key: string) => (signal: AbortSignal) => {
    const answer = deferred<T>();
    calls.push({ key, signal, answer });
    return answer.promise;
  };
  return { calls, fetcherFor };
}

const settle = () => act(async () => {});

describe("useResource", () => {
  it("a late response for a previous key is discarded", async () => {
    const { calls, fetcherFor } = controlled<string>();
    const hook = renderHook(({ k }) => useResource(k, fetcherFor(k)), { initialProps: { k: "A" } });
    hook.rerender({ k: "B" });
    const [a, b] = calls;
    await act(async () => b?.answer.resolve("B data"));
    expect(hook.result.current).toMatchObject({ state: "ready", data: "B data" });
    await act(async () => a?.answer.resolve("A data"));
    expect(hook.result.current).toMatchObject({ state: "ready", data: "B data" });
  });

  it("changing key aborts the previous request", async () => {
    const { calls, fetcherFor } = controlled<string>();
    const hook = renderHook(({ k }) => useResource(k, fetcherFor(k)), { initialProps: { k: "A" } });
    await act(async () => calls[0]?.answer.resolve("A data"));
    hook.rerender({ k: "B" });
    expect(calls[1]?.signal.aborted).toBe(false);
    // The data for A is never shown under B, not even in the render before B's request starts.
    expect(hook.result.current).toMatchObject({ state: "loading", data: undefined });
    hook.rerender({ k: "C" });
    expect(calls[1]?.signal.aborted).toBe(true);
    expect(calls[2]?.signal.aborted).toBe(false);
  });

  it("reload keeps the previous data while loading", async () => {
    const { calls, fetcherFor } = controlled<string>();
    const hook = renderHook(() => useResource("A", fetcherFor("A")));
    await act(async () => calls[0]?.answer.resolve("first"));
    act(() => hook.result.current.reload());
    expect(hook.result.current).toMatchObject({ state: "loading", data: "first" });
    await act(async () => calls[1]?.answer.resolve("second"));
    expect(hook.result.current).toMatchObject({ state: "ready", data: "second" });
  });

  it("of two reloads only the latest answer applies", async () => {
    const { calls, fetcherFor } = controlled<string>();
    const hook = renderHook(() => useResource("A", fetcherFor("A")));
    await act(async () => calls[0]?.answer.resolve("first"));
    act(() => hook.result.current.reload());
    act(() => hook.result.current.reload());
    expect(calls[1]?.signal.aborted).toBe(true);
    await act(async () => calls[2]?.answer.resolve("latest"));
    await act(async () => calls[1]?.answer.resolve("earlier"));
    expect(hook.result.current).toMatchObject({ state: "ready", data: "latest" });
  });

  it("an answer older than the copy on screen is dropped", async () => {
    type V = { id: string; version: number };
    const { calls, fetcherFor } = controlled<V>();
    const isOlder = (incoming: V, shown: V) => incoming.id === shown.id && incoming.version < shown.version;
    const hook = renderHook(() => useResource("visit:1", fetcherFor("visit:1"), { isOlder }));
    await act(async () => calls[0]?.answer.resolve({ id: "1", version: 5 }));
    act(() => hook.result.current.reload());
    // A write answer overtakes the read in flight.
    act(() => hook.result.current.set((cur) => cur && { ...cur, version: 7 }));
    await act(async () => calls[1]?.answer.resolve({ id: "1", version: 6 }));
    expect(hook.result.current).toMatchObject({ state: "ready", data: { version: 7 } });
    act(() => hook.result.current.reload());
    await act(async () => calls[2]?.answer.resolve({ id: "1", version: 8 }));
    expect(hook.result.current.data).toEqual({ id: "1", version: 8 });
  });

  it("unmount aborts and does not set state", async () => {
    const { calls, fetcherFor } = controlled<string>();
    const seen: unknown[] = [];
    const hook = renderHook(() => {
      const r = useResource("A", fetcherFor("A"));
      seen.push(r.state);
      return r;
    });
    const renders = seen.length;
    hook.unmount();
    expect(calls[0]?.signal.aborted).toBe(true);
    await act(async () => calls[0]?.answer.resolve("late"));
    expect(seen).toHaveLength(renders);
  });

  it("a null key is idle and sends nothing", () => {
    const { calls, fetcherFor } = controlled<string>();
    const hook = renderHook(() => useResource(null, fetcherFor("none")));
    expect(hook.result.current).toMatchObject({ state: "idle", data: undefined });
    expect(calls).toHaveLength(0);
  });

  it("an error keeps the data; a cancelled request is not reported", async () => {
    const { calls, fetcherFor } = controlled<string>();
    const hook = renderHook(() => useResource("A", fetcherFor("A")));
    await act(async () => calls[0]?.answer.resolve("first"));
    act(() => hook.result.current.reload());
    await act(async () => calls[1]?.answer.reject(new ApiError("aborted", 0, "ABORTED", "cancelled")));
    expect(hook.result.current.state).toBe("loading");
    act(() => hook.result.current.reload());
    await act(async () => calls[2]?.answer.reject(new ApiError("network", 0, "NETWORK", "The server could not be reached.")));
    await waitFor(() => expect(hook.result.current.state).toBe("error"));
    expect(hook.result.current).toMatchObject({ data: "first", error: { kind: "network" } });
  });

  it("set replaces the data for the current key; an updater that returns undefined changes nothing", async () => {
    const { calls, fetcherFor } = controlled<string>();
    const hook = renderHook(() => useResource("A", fetcherFor("A")));
    act(() => hook.result.current.set((cur) => cur && `${cur}!`));
    expect(hook.result.current).toMatchObject({ state: "loading", data: undefined });
    await act(async () => calls[0]?.answer.resolve("first"));
    act(() => hook.result.current.set("written"));
    expect(hook.result.current).toMatchObject({ state: "ready", data: "written" });
    await settle();
  });
});
