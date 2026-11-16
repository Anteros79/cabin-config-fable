import { afterAll, beforeAll, describe, expect, it, test } from "vitest";
import { cleanupTempDirs, makeApp } from "../helpers.ts";

afterAll(cleanupTempDirs);

describe("query string and path parameter validation", () => {
  let handle: ReturnType<typeof makeApp>;
  beforeAll(() => {
    handle = makeApp();
  });
  afterAll(() => handle.close());
  const get = (url: string) => handle.app.inject({ url });

  test.each(["limit=abc", "limit=0", "limit=201", "limit=1.5", "offset=-1", "offset=x", "bogus=1", `q=${"a".repeat(101)}`])(
    "GET /api/visits?%s gives 400 INVALID_QUERY",
    async (qs) => {
      const r = await get(`/api/visits?${qs}`);
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe("INVALID_QUERY");
    },
  );

  it("keeps INVALID_STATUS for a bad status", async () => {
    const r = await get("/api/visits?status=BOGUS");
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("INVALID_STATUS");
  });

  it("defaults to limit 50 offset 0", async () => {
    expect((await get("/api/visits")).json()).toMatchObject({ limit: 50, offset: 0 });
  });

  it("a repeated tail parameter is INVALID_QUERY, not a crash", async () => {
    for (const path of ["lookup", "preparation"]) {
      const r = await get(`/api/${path}?tail=a&tail=b&date=2026-11-12`);
      expect(r.statusCode, path).toBe(400);
      expect(r.json().error.code, path).toBe("INVALID_QUERY");
    }
  });

  test.each(["/api/visits/not-a-uuid", "/api/visits/not-a-uuid/report", "/api/visits/not-a-uuid/preparation", "/api/visits/..%2Fhealth"])(
    "%s gives 404 VISIT_NOT_FOUND",
    async (url) => {
      const r = await get(url);
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe("VISIT_NOT_FOUND");
    },
  );

  it("a malformed id on a write route is 404 VISIT_NOT_FOUND", async () => {
    const r = await handle.app.inject({ method: "POST", url: "/api/visits/not-a-uuid/complete", payload: { confirm: true } });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("VISIT_NOT_FOUND");
  });

  it("GET /api/layouts/nope gives 404 LAYOUT_NOT_FOUND", async () => {
    const r = await get("/api/layouts/nope");
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("LAYOUT_NOT_FOUND");
  });

  it("the store rejects non-integer paging without the HTTP layer", () => {
    expect(() => handle.visits.listVisits({ limit: Number.NaN })).toThrowError(expect.objectContaining({ code: "INVALID_QUERY", status: 400 }));
    expect(() => handle.visits.listVisits({ offset: 1.5 })).toThrowError(expect.objectContaining({ code: "INVALID_QUERY" }));
  });
});
