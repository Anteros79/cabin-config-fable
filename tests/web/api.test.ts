import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../../src/web/api.ts";

interface Stub {
  status?: number;
  body?: unknown;
  /** raw text instead of JSON */
  text?: string;
  /** headers resolve, the body never arrives */
  stalled?: boolean;
  /** headers resolve, reading the body fails */
  unreadable?: boolean;
}

let lastUrl = "";
let lastInit: RequestInit | undefined;

function stubFetch(stub: Stub | "reject"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      lastUrl = url;
      lastInit = init;
      if (stub === "reject") return Promise.reject(new TypeError("failed to fetch"));
      const status = stub.status ?? 200;
      const read = (): Promise<unknown> => {
        if (stub.stalled)
          return new Promise((_, reject) => {
            if (init?.signal?.aborted) reject(new DOMException("aborted", "AbortError"));
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          });
        if (stub.unreadable) return Promise.reject(new TypeError("body stream failed"));
        if (stub.text !== undefined) return Promise.reject(new SyntaxError("Unexpected token"));
        return Promise.resolve(stub.body ?? {});
      };
      return Promise.resolve({ ok: status >= 200 && status < 300, status, json: read } as unknown as Response);
    }),
  );
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("expected the request to fail");
}

const record = { locationId: "SEAT:3A", componentId: "CUSHION", selection: "PRIMARY", substituteId: null, quantity: 1, note: "" } as const;
const envelope = (code: string, details: unknown = null) => ({ error: { code, message: `${code} message`, details } });

beforeEach(() => {
  lastUrl = "";
  lastInit = undefined;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request", () => {
  it("a body that never arrives times out as an unknown outcome", async () => {
    stubFetch({ stalled: true });
    const err = await failure(api.upsertRecord("v1", record, 0, "key-key-key-1", { timeoutMs: 50 }));
    expect(err.kind).toBe("network");
    expect(err.message).toMatch(/did not answer in time/);
  });

  it("an unreadable body on a write is an unknown outcome", async () => {
    stubFetch({ status: 200, unreadable: true });
    const err = await failure(api.upsertRecord("v1", record, 0, "key-key-key-1"));
    expect(err.kind).toBe("network");
  });

  it("a non-JSON 502 on a write is an unknown outcome", async () => {
    stubFetch({ status: 502, text: "<html>Bad gateway</html>" });
    const err = await failure(api.upsertRecord("v1", record, 0, "key-key-key-1"));
    expect(err).toMatchObject({ kind: "network", status: 502 });
  });

  it("a non-JSON 502 on a read is an http error", async () => {
    stubFetch({ status: 502, text: "<html>Bad gateway</html>" });
    const err = await failure(api.visit("v1"));
    expect(err).toMatchObject({ kind: "http", status: 502, code: "HTTP_502" });
  });

  it("a 5xx on a write whose JSON is not the error envelope is an unknown outcome", async () => {
    stubFetch({ status: 502, body: { message: "upstream" } });
    expect((await failure(api.upsertRecord("v1", record, 0, "key-key-key-1"))).kind).toBe("network");
  });

  it.each(["STORAGE_UNAVAILABLE", "INTERNAL_ERROR"])("an enveloped %s on a write means nothing was saved", async (code) => {
    stubFetch({ status: code === "STORAGE_UNAVAILABLE" ? 503 : 500, body: envelope(code) });
    const err = await failure(api.upsertRecord("v1", record, 0, "key-key-key-1"));
    expect(err).toMatchObject({ kind: "http", code });
  });

  it("an enveloped 5xx with any other code on a write is still an unknown outcome", async () => {
    stubFetch({ status: 500, body: envelope("SOMETHING_ELSE") });
    expect((await failure(api.upsertRecord("v1", record, 0, "key-key-key-1"))).kind).toBe("network");
  });

  it("409 carries the current record", async () => {
    const current = { locationId: "SEAT:3A", version: 4 };
    stubFetch({ status: 409, body: envelope("RECORD_VERSION_CONFLICT", { current }) });
    const err = await failure(api.upsertRecord("v1", record, 0, "key-key-key-1"));
    expect(err).toMatchObject({ kind: "http", status: 409, code: "RECORD_VERSION_CONFLICT" });
    expect((err.details as { current: unknown }).current).toEqual(current);
  });

  it("no response is a network error", async () => {
    stubFetch("reject");
    expect(await failure(api.visit("v1"))).toMatchObject({ kind: "network", status: 0 });
  });

  it("a caller abort rejects with kind aborted", async () => {
    stubFetch({ stalled: true });
    const controller = new AbortController();
    const pending = failure(api.visit("v1", { signal: controller.signal }));
    controller.abort();
    expect((await pending).kind).toBe("aborted");
  });

  it("an already aborted signal rejects with kind aborted", async () => {
    stubFetch({ stalled: true });
    const controller = new AbortController();
    controller.abort();
    expect((await failure(api.visit("v1", { signal: controller.signal }))).kind).toBe("aborted");
  });

  it("ids are encoded", async () => {
    stubFetch({ status: 404, body: envelope("NOT_FOUND") });
    await api.visit("../health?x#y").catch(() => {});
    expect(lastUrl).toBe("/api/visits/..%2Fhealth%3Fx%23y");
    await api.visitPreparation("a/b").catch(() => {});
    expect(lastUrl).toBe("/api/visits/a%2Fb/preparation");
    await api.report("a b").catch(() => {});
    expect(lastUrl).toBe("/api/visits/a%20b/report");
    await api.complete("a#b", 1, "key-key-key-1").catch(() => {});
    expect(lastUrl).toBe("/api/visits/a%23b/complete");
  });

  it("a lookup 503 with a state body resolves with that body", async () => {
    stubFetch({ status: 503, body: { state: "REFERENCE_UNAVAILABLE", message: "No reference data is active." } });
    await expect(api.lookup("N100TL", "2026-11-12")).resolves.toMatchObject({ state: "REFERENCE_UNAVAILABLE" });
  });

  it("a state body on a failed write is not treated as a lookup answer", async () => {
    stubFetch({ status: 503, body: { state: "REFERENCE_UNAVAILABLE" } });
    const err = await failure(api.upsertRecord("v1", record, 0, "key-key-key-1"));
    expect(err.kind).toBe("network");
  });

  it("addEvent sends the idempotency key", async () => {
    stubFetch({ body: { visit: {}, replayed: false } });
    await api.addEvent("v1", "NOTE", "text", "Sam", "key-key-key-2");
    expect(lastUrl).toBe("/api/visits/v1/events");
    expect(JSON.parse(String(lastInit?.body))).toMatchObject({ type: "NOTE", idempotencyKey: "key-key-key-2" });
  });

  it("a successful answer resolves with its body", async () => {
    stubFetch({ body: { status: "ok" } });
    await expect(api.health()).resolves.toEqual({ status: "ok" });
  });
});
