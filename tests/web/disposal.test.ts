import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { describe, expect, test } from "vitest";
import { ResourceTracker } from "../../src/web/scene/CabinScene.ts";

const probe = () => {
  let calls = 0;
  return {
    dispose: () => {
      calls += 1;
    },
    calls: () => calls,
  };
};

describe("ResourceTracker", () => {
  test("disposes everything it tracked exactly once", () => {
    const tracker = new ResourceTracker();
    const [a, b, c] = [probe(), probe(), probe()];
    expect(tracker.track(a)).toBe(a);
    tracker.track(b);
    tracker.track(c);
    tracker.disposeAll();
    expect([a.calls(), b.calls(), c.calls()]).toEqual([1, 1, 1]);
    tracker.disposeAll();
    expect([a.calls(), b.calls(), c.calls()]).toEqual([1, 1, 1]);
  });

  test("a resource tracked after disposeAll belongs to the next round", () => {
    const tracker = new ResourceTracker();
    const first = probe();
    tracker.track(first);
    tracker.disposeAll();
    const second = probe();
    tracker.track(second);
    expect(second.calls()).toBe(0);
    tracker.disposeAll();
    expect([first.calls(), second.calls()]).toEqual([1, 1]);
  });

  test("tracking the same resource twice disposes it once", () => {
    const tracker = new ResourceTracker();
    const a = probe();
    tracker.track(a);
    tracker.track(a);
    tracker.disposeAll();
    expect(a.calls()).toBe(1);
  });

  test("disposeEach releases every tracker even when one throws", () => {
    const bad = new ResourceTracker();
    bad.track({
      dispose: () => {
        throw new Error("boom");
      },
    });
    const good = new ResourceTracker();
    const a = probe();
    good.track(a);
    expect(() => ResourceTracker.disposeEach(bad, good)).toThrow("boom");
    expect(a.calls()).toBe(1);
  });

  test("one failing dispose does not stop the others", () => {
    const tracker = new ResourceTracker();
    const after = probe();
    tracker.track({
      dispose: () => {
        throw new Error("boom");
      },
    });
    tracker.track(after);
    expect(() => tracker.disposeAll()).toThrow("boom");
    expect(after.calls()).toBe(1);
  });
});

// These builds go to a temporary directory, so the result never depends on a stale dist/web (PF-14).
async function bundleText(hooks: boolean): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), "cabin-kit-bundle-"));
  const saved = process.env.VITE_TEST_HOOKS;
  const savedEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production"; // vitest sets "test", which would bundle React's development build
  if (hooks) process.env.VITE_TEST_HOOKS = "1";
  else delete process.env.VITE_TEST_HOOKS;
  try {
    await build({ configFile: join(process.cwd(), "vite.config.ts"), logLevel: "silent", mode: "production", build: { outDir, emptyOutDir: true } });
    const assets = join(outDir, "assets");
    return readdirSync(assets)
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(join(assets, f), "utf8"))
      .join("\n");
  } finally {
    if (saved === undefined) delete process.env.VITE_TEST_HOOKS;
    else process.env.VITE_TEST_HOOKS = saved;
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
    rmSync(outDir, { recursive: true, force: true });
  }
}

const NAMES = ["__cabinKit", "screenPointOf", "describeScene", "pickLatencies", "markInteraction"];

describe("test hooks in the bundle", () => {
  test("the production bundle contains no test hooks", { timeout: 120_000 }, async () => {
    const text = await bundleText(false);
    expect(text.length).toBeGreaterThan(100_000); // a real bundle was read
    for (const name of NAMES) expect(text.includes(name), name).toBe(false);
    expect(text.includes("preserveDrawingBuffer:!0")).toBe(false);
    expect(text.includes("preserveDrawingBuffer:!1")).toBe(true); // the renderer option is the visible literal false
  });

  test("the e2e bundle does contain them (so the check above is not vacuous)", { timeout: 120_000 }, async () => {
    const text = await bundleText(true);
    for (const name of NAMES) expect(text.includes(name), name).toBe(true);
    expect(text.includes("preserveDrawingBuffer:!0")).toBe(true);
  });
});
