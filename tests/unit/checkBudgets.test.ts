import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import budgets from "../../budgets.json" with { type: "json" };
import { checkBundle, gzipKb, main } from "../../tools/check-budgets.ts";

const BUNDLE = { indexJsGzipKb: 100, sceneJsGzipKb: 180, cssGzipKb: 7, sceneJsRawKb: 650, reportJsGzipKb: 6 };

describe("checkBundle", () => {
  test("classifies each asset by its name and passes when every class is within budget; the scene chunk has a raw budget too", () => {
    const rows = checkBundle(
      [
        { name: "index-AbC123.js", gzipKb: 99.9, rawKb: 330 },
        { name: "CabinScene-x_Y-9.js", gzipKb: 150, rawKb: 650 },
        { name: "index-Zz.css", gzipKb: 7, rawKb: 30 },
        { name: "ReportView-q1.js", gzipKb: 5.9, rawKb: 20 },
      ],
      BUNDLE,
    );
    expect(rows.map((r) => [r.name, r.budget, r.sizeKb, r.limitKb, r.ok])).toEqual([
      ["index-AbC123.js", "indexJsGzipKb", 99.9, 100, true],
      ["CabinScene-x_Y-9.js", "sceneJsGzipKb", 150, 180, true],
      ["CabinScene-x_Y-9.js", "sceneJsRawKb", 650, 650, true],
      ["index-Zz.css", "cssGzipKb", 7, 7, true],
      ["ReportView-q1.js", "reportJsGzipKb", 5.9, 6, true],
    ]);
  });

  test("an asset over its budget fails, gzip or raw", () => {
    const rows = checkBundle([{ name: "CabinScene-abc.js", gzipKb: 180.01, rawKb: 650.01 }], BUNDLE);
    expect(rows.map((r) => [r.budget, r.ok])).toEqual([
      ["sceneJsGzipKb", false],
      ["sceneJsRawKb", false],
      ["indexJsGzipKb", false],
      ["cssGzipKb", false],
      ["reportJsGzipKb", false],
    ]);
    const rawOnly = checkBundle([{ name: "CabinScene-abc.js", gzipKb: 100, rawKb: 651 }], BUNDLE);
    expect(rawOnly.filter((r) => r.name !== "(missing)" && !r.ok).map((r) => r.budget)).toEqual(["sceneJsRawKb"]);
  });

  test("an asset no budget names fails, so a new chunk cannot escape the budgets", () => {
    const [row] = checkBundle([{ name: "three-abc.js", gzipKb: 1, rawKb: 1 }], BUNDLE);
    expect([row?.budget, row?.ok]).toEqual([null, false]);
  });

  test("a missing class fails: an empty or partial build is not a pass", () => {
    const rows = checkBundle([{ name: "index-a.js", gzipKb: 1, rawKb: 1 }], BUNDLE);
    expect(rows.filter((r) => !r.ok).map((r) => r.budget)).toEqual(["sceneJsGzipKb", "sceneJsRawKb", "cssGzipKb", "reportJsGzipKb"]);
  });
});

test("gzipKb is the gzip -9 size in kB (1000 bytes)", () => {
  const repetitive = Buffer.alloc(100_000, "a");
  expect(gzipKb(repetitive)).toBeGreaterThan(0);
  expect(gzipKb(repetitive)).toBeLessThan(1);
});

describe("main", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });
  const build = (files: Record<string, string | Buffer>) => {
    dir = mkdtempSync(join(tmpdir(), "budgets-"));
    const assets = join(dir, "assets");
    mkdirSync(assets);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(assets, name), body);
    return assets;
  };
  const run = (assets: string) => {
    const out: string[] = [];
    const code = main(assets, budgets.bundle, (line) => out.push(line));
    return { code, out: out.join("\n") };
  };

  test("prints a table and exits 0 when the build is within budget", () => {
    const { code, out } = run(build({ "index-a.js": "x", "CabinScene-b.js": "y", "index-c.css": "z", "ReportView-d.js": "r" }));
    expect(code).toBe(0);
    expect(out).toContain("index-a.js");
    expect(out).toContain("sceneJsGzipKb");
    expect(out).toMatch(/within budget/);
  });

  test("exits 1 and names the asset when one is over budget", () => {
    // random bytes do not compress: 200 kB stays about 200 kB gzipped, over any CSS budget
    const noise = randomBytes(200_000);
    const { code, out } = run(build({ "index-a.js": "x", "CabinScene-b.js": "y", "index-c.css": noise, "ReportView-d.js": "r" }));
    expect(code).toBe(1);
    expect(out).toMatch(/index-c\.css.*OVER/);
  });

  test("exits 1 when the scene chunk is over its raw budget, however well it compresses", () => {
    const big = "a".repeat(Math.ceil(budgets.bundle.sceneJsRawKb * 1000) + 1);
    const { code, out } = run(build({ "index-a.js": "x", "CabinScene-b.js": big, "index-c.css": "z", "ReportView-d.js": "r" }));
    expect(code).toBe(1);
    expect(out).toMatch(/CabinScene-b\.js\s+sceneJsRawKb.*OVER/);
    expect(out).toMatch(/CabinScene-b\.js\s+sceneJsGzipKb.*ok/);
  });

  test("exits 1 when there is no build", () => {
    expect(run(join(tmpdir(), "no-such-build-dir-6-5")).code).toBe(1);
  });
});
