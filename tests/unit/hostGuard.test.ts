import { describe, expect, test } from "vitest";
import { resolveServerConfig } from "../../src/server/config.ts";
import { allowedHostnames, hostnameOf, isWriteAllowed } from "../../src/server/http/hostGuard.ts";

describe("hostnameOf", () => {
  test.each([
    ["localhost:80", "localhost"],
    ["127.0.0.1:4310", "127.0.0.1"],
    ["[::1]:4310", "::1"],
    ["[::1]", "::1"],
    ["EVIL.example:4310", "evil.example"],
    [undefined, null],
    ["", null],
    ["a b", null],
    ["evil.example/path", null],
    ["user@evil.example", null],
  ])("hostnameOf(%s) = %s", (input, expected) => expect(hostnameOf(input)).toBe(expected));
});

describe("allowedHostnames", () => {
  test("always has loopback, the listen host and configured names", () => {
    const set = allowedHostnames({ host: "10.0.0.5", allowedHosts: ["kit.internal"] });
    expect([...set].sort()).toEqual(["10.0.0.5", "127.0.0.1", "::1", "kit.internal", "localhost"]);
    // and with nothing configured, on a wildcard listen host
    expect([...allowedHostnames({ host: "0.0.0.0", allowedHosts: [] })].sort()).toEqual(["0.0.0.0", "127.0.0.1", "::1", "localhost"]);
  });
});

describe("isWriteAllowed", () => {
  test("http://localhost matches Host localhost:80 and the reverse (default ports)", () => {
    expect(isWriteAllowed({ origin: "http://localhost", host: "localhost:80" })).toBe(true);
    expect(isWriteAllowed({ origin: "http://localhost:80", host: "localhost" })).toBe(true);
    expect(isWriteAllowed({ origin: "https://kit.test", host: "kit.test:443" })).toBe(true);
  });
  test("different port, scheme default or host is refused", () => {
    expect(isWriteAllowed({ origin: "http://localhost:81", host: "localhost:80" })).toBe(false);
    expect(isWriteAllowed({ origin: "https://localhost", host: "localhost:80" })).toBe(false);
    expect(isWriteAllowed({ origin: "http://localhost:4310", host: "127.0.0.1:4310" })).toBe(false);
  });
  test("IPv6 origin matches a bracketed Host", () => {
    expect(isWriteAllowed({ origin: "http://[::1]:4310", host: "[::1]:4310" })).toBe(true);
  });
  test("null, unparseable and non-http origins are refused; no headers is allowed", () => {
    expect(isWriteAllowed({ origin: "null", host: "localhost:80" })).toBe(false);
    expect(isWriteAllowed({ origin: "notaurl", host: "localhost:80" })).toBe(false);
    expect(isWriteAllowed({ origin: "file://localhost", host: "localhost:80" })).toBe(false);
    expect(isWriteAllowed({ origin: "http://localhost", host: undefined })).toBe(false);
    expect(isWriteAllowed({ host: "localhost:80" })).toBe(true);
  });
  test("Sec-Fetch-Site must be same-origin or none", () => {
    expect(isWriteAllowed({ "sec-fetch-site": "same-origin" })).toBe(true);
    expect(isWriteAllowed({ "sec-fetch-site": "none" })).toBe(true);
    expect(isWriteAllowed({ "sec-fetch-site": "same-site" })).toBe(false);
    expect(isWriteAllowed({ "sec-fetch-site": "cross-site" })).toBe(false);
  });
});

describe("CABIN_KIT_ALLOWED_HOSTS", () => {
  test("is split, trimmed and lower-cased; empty or blank means none", () => {
    expect(resolveServerConfig({}, { CABIN_KIT_ALLOWED_HOSTS: " Kit.Internal , b.test ,," }).allowedHosts).toEqual(["kit.internal", "b.test"]);
    expect(resolveServerConfig({}, { CABIN_KIT_ALLOWED_HOSTS: "   " }).allowedHosts).toEqual([]);
    expect(resolveServerConfig({}, {}).allowedHosts).toEqual([]);
  });
});
