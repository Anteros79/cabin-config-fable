import { vi } from "vitest";

/** One answer to a request: a JSON body with a status, a dropped connection, or a promise the test settles by hand. */
export type Answer = { status?: number; body: unknown } | "reject" | Promise<{ status?: number; body: unknown } | "reject">;
export interface Sent {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

/**
 * Stubs `fetch` with a handler that picks an answer per request. Nothing reaches a network.
 * Returns the list of requests sent, in order.
 */
export function stubFetch(handler: (method: string, url: string, body: Record<string, unknown> | null) => Answer): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      sent.push({ method, url, body });
      const answer = await handler(method, url, body);
      if (answer === "reject") throw new TypeError("failed to fetch");
      const status = answer.status ?? 200;
      return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(answer.body) } as unknown as Response;
    }),
  );
  return sent;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
