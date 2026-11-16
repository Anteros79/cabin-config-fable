import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { ConfigError, resolveServerConfig, resolveStoreConfig } from "../../src/server/config.ts";

const errorOf = (fn: () => unknown): ConfigError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error("expected a ConfigError");
};

describe("CABIN_KIT_PORT", () => {
  test.each(["abc", "-1", "65536", "80.5", "1e3", "0x10"])("port %s is rejected", (p) =>
    expect(() => resolveServerConfig({}, { CABIN_KIT_PORT: p })).toThrow(ConfigError),
  );

  test("the message names the variable, the range and the value", () => {
    expect(errorOf(() => resolveServerConfig({}, { CABIN_KIT_PORT: "abc" })).message).toBe(
      'CABIN_KIT_PORT must be a whole number from 0 to 65535 (got "abc").',
    );
  });

  test.each([
    ["0", 0],
    ["4311", 4311],
    ["65535", 65535],
    [" 8080 ", 8080],
  ])("port %s is accepted", (p, expected) => expect(resolveServerConfig({}, { CABIN_KIT_PORT: p }).port).toBe(expected));

  test.each(["", "  "])("an empty or blank port (%j) means the default", (p) => expect(resolveServerConfig({}, { CABIN_KIT_PORT: p }).port).toBe(4310));

  test("an explicit port override is validated too", () => {
    expect(() => resolveServerConfig({ port: 70000 }, {})).toThrow(ConfigError);
    expect(resolveServerConfig({ port: 0 }, {}).port).toBe(0);
  });
});

describe("CABIN_KIT_HOST", () => {
  test("a non-loopback host needs CABIN_KIT_ALLOW_REMOTE=1", () => {
    expect(() => resolveServerConfig({}, { CABIN_KIT_HOST: "0.0.0.0" })).toThrow(/no authentication/);
    expect(errorOf(() => resolveServerConfig({}, { CABIN_KIT_HOST: "0.0.0.0" })).message).toBe(
      'CABIN_KIT_HOST "0.0.0.0" is not a loopback address. This server has no authentication. Set CABIN_KIT_ALLOW_REMOTE=1 to accept the risk.',
    );
    expect(() => resolveServerConfig({}, { CABIN_KIT_HOST: "0.0.0.0", CABIN_KIT_ALLOW_REMOTE: "true" })).toThrow(ConfigError);
    expect(resolveServerConfig({}, { CABIN_KIT_HOST: "0.0.0.0", CABIN_KIT_ALLOW_REMOTE: "1" }).host).toBe("0.0.0.0");
  });

  test.each(["127.0.0.1", "::1", "localhost"])("loopback host %s needs no opt-in", (host) =>
    expect(resolveServerConfig({}, { CABIN_KIT_HOST: host }).host).toBe(host),
  );

  test("an empty or blank host means the default", () => {
    expect(resolveServerConfig({}, { CABIN_KIT_HOST: "  " }).host).toBe("127.0.0.1");
  });
});

describe("CABIN_KIT_ALLOWED_HOSTS", () => {
  test.each(["kit.internal/x", "*", "a b", "http://kit.internal", "kit.internal:8080"])("entry %j is rejected", (entry) => {
    const error = errorOf(() => resolveServerConfig({}, { CABIN_KIT_ALLOWED_HOSTS: `ok.test, ${entry}` }));
    expect(error.message).toContain(`"${entry.toLowerCase()}"`);
    expect(error.message).toContain("CABIN_KIT_ALLOWED_HOSTS");
  });

  test("host names and bracketed IPv6 addresses are accepted", () => {
    expect(resolveServerConfig({}, { CABIN_KIT_ALLOWED_HOSTS: "kit.internal, 10.0.0.5, [fe80::1]" }).allowedHosts).toEqual([
      "kit.internal",
      "10.0.0.5",
      "[fe80::1]",
    ]);
  });
});

describe("CABIN_KIT_LOG_LEVEL", () => {
  test("an unknown level is rejected", () => {
    expect(errorOf(() => resolveServerConfig({}, { CABIN_KIT_LOG_LEVEL: "verbose" })).message).toBe(
      'CABIN_KIT_LOG_LEVEL must be one of silent, error, warn, info, debug (got "verbose").',
    );
  });

  test("a known level is used; empty or blank means info", () => {
    expect(resolveServerConfig({}, { CABIN_KIT_LOG_LEVEL: "debug" }).logLevel).toBe("debug");
    expect(resolveServerConfig({}, { CABIN_KIT_LOG_LEVEL: " warn " }).logLevel).toBe("warn");
    expect(resolveServerConfig({}, { CABIN_KIT_LOG_LEVEL: "" }).logLevel).toBe("info");
    expect(resolveServerConfig({}, { CABIN_KIT_LOG_LEVEL: "   " }).logLevel).toBe("info");
    expect(resolveServerConfig({}, {}).logLevel).toBe("info");
  });
});

describe("store paths and flags", () => {
  test("relative store paths resolve against the working directory; TEST_FAULTS only on '1'", () => {
    const config = resolveServerConfig({}, { CABIN_KIT_DATA_DIR: "rel-data", CABIN_KIT_VISITS_DB: "elsewhere/v.sqlite" });
    expect(config.dataDir).toBe(resolve(process.cwd(), "rel-data"));
    expect(config.referencePath).toBe(join(process.cwd(), "rel-data", "reference.sqlite"));
    expect(config.visitsPath).toBe(resolve(process.cwd(), "elsewhere/v.sqlite"));
    expect(resolveServerConfig({}, { CABIN_KIT_TEST_FAULTS: "1" }).testFaults).toBe(true);
    for (const value of ["0", "true", "yes", "", " "]) expect(resolveServerConfig({}, { CABIN_KIT_TEST_FAULTS: value }).testFaults).toBe(false);
  });

  test("empty or blank store variables mean unset", () => {
    const defaults = resolveStoreConfig({}, {});
    expect(resolveStoreConfig({}, { CABIN_KIT_DATA_DIR: " ", CABIN_KIT_REFERENCE_DB: "", CABIN_KIT_VISITS_DB: "  " })).toEqual(defaults);
    const custom = resolveStoreConfig({}, { CABIN_KIT_DATA_DIR: "/tmp/ck-x", CABIN_KIT_VISITS_DB: "" });
    expect(custom.visitsPath).toBe("/tmp/ck-x/visits.sqlite");
  });
});
