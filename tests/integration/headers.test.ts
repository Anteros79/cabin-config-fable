import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY } from "../../src/server/http/headers.ts";
import { cleanupTempDirs, makeApp, tempDir } from "../helpers.ts";

afterAll(cleanupTempDirs);

describe("headers, caching, compression and static serving", () => {
  let handle: ReturnType<typeof makeApp>;
  beforeAll(() => {
    const webRoot = tempDir("cabin-kit-web-");
    mkdirSync(join(webRoot, "assets"));
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><html><body>Cabin Kit</body></html>");
    writeFileSync(join(webRoot, "assets", "app-abc123.js"), "export const x = 1;\n");
    handle = makeApp({ webRoot });
  });
  afterAll(() => handle.close());

  it("every response carries the security header set", async () => {
    for (const url of ["/api/health", "/", "/assets/app-abc123.js", "/api/nope"]) {
      const r = await handle.app.inject({ url });
      expect(r.headers["content-security-policy"], url).toBe(CONTENT_SECURITY_POLICY);
      expect(r.headers["x-frame-options"], url).toBe("DENY");
      expect(r.headers["referrer-policy"], url).toBe("no-referrer");
      expect(r.headers["x-content-type-options"], url).toBe("nosniff");
      expect(r.headers["cross-origin-resource-policy"], url).toBe("same-origin");
      expect(r.headers["cross-origin-opener-policy"], url).toBe("same-origin");
      expect(r.headers["permissions-policy"], url).toBe("camera=(), microphone=(), geolocation=()");
    }
  });

  it("hashed assets are immutable, everything else is no-store", async () => {
    expect((await handle.app.inject({ url: "/assets/app-abc123.js" })).headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect((await handle.app.inject({ url: "/" })).headers["cache-control"]).toBe("no-store");
    const missing = await handle.app.inject({ url: "/assets/missing.js" });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["cache-control"]).toBe("no-store");
    expect((await handle.app.inject({ url: "/api/health" })).headers["cache-control"]).toBe("no-store");
  });

  it("large JSON is compressed when the client accepts it", async () => {
    const r = await handle.app.inject({ url: "/api/lookup?tail=N100TL&date=2026-11-12", headers: { "accept-encoding": "br, gzip" } });
    expect(["br", "gzip"]).toContain(r.headers["content-encoding"]);
    expect(r.rawPayload.length).toBeLessThan(30_000);
    const plain = await handle.app.inject({ url: "/api/lookup?tail=N100TL&date=2026-11-12", headers: { "accept-encoding": "identity" } });
    expect(plain.headers["content-encoding"]).toBeUndefined();
  });

  it("serves the real web root: index, hashed asset, JSON 404 envelope, traversal refused", async () => {
    const index = await handle.app.inject({ url: "/" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.body).toContain("<!doctype html>");
    const asset = await handle.app.inject({ url: "/assets/app-abc123.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    const missing = await handle.app.inject({ url: "/api/nope" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: "NOT_FOUND", message: "No such API route.", details: null } });
    expect((await handle.app.inject({ url: "/..%2f..%2fpackage.json" })).statusCode).toBe(404);
    expect((await handle.app.inject({ url: "/assets/../../package.json" })).statusCode).toBe(404);
  });

  it("the host guard still covers not-found and static paths", async () => {
    for (const url of ["/api/nope", "/", "/assets/app-abc123.js"]) {
      const r = await handle.app.inject({ url, headers: { host: "evil.example" } });
      expect(r.statusCode, url).toBe(403);
      expect(r.json().error.code).toBe("HOST_NOT_ALLOWED");
    }
  });
});
