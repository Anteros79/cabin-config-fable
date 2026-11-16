// Bundle budgets (Task 6.5): gzips every file the production build wrote to dist/web/assets, classifies it by name, and
// compares it with budgets.json. Prints a table; exits 1 when any asset is over its budget, when an asset matches no
// budget (a new chunk must get a budget of its own), or when a budgeted class is missing from the build.
//   npm run budgets      build, then check
// Sizes are gzip level 9, in kB of 1000 bytes. The API, scene and coverage numbers in budgets.json are asserted by the
// tests that measure them (tests/integration, e2e/scene.spec.ts, tests/web/seatBudget.test.ts, vitest.config.ts).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, gzipSync } from "node:zlib";
import budgets from "../budgets.json" with { type: "json" };
import { isEntryPoint } from "../src/importer/args.ts";

export type BundleBudgets = typeof budgets.bundle;
type BudgetName = keyof BundleBudgets;

/** Which budget an asset counts against, by its file name: Vite names each chunk after its entry module. */
const CLASSES: { budget: BudgetName; matches: (name: string) => boolean }[] = [
  { budget: "indexJsGzipKb", matches: (n) => n.startsWith("index-") && n.endsWith(".js") },
  { budget: "sceneJsGzipKb", matches: (n) => n.startsWith("CabinScene-") && n.endsWith(".js") },
  { budget: "cssGzipKb", matches: (n) => n.endsWith(".css") },
];

export interface BudgetRow {
  /** the asset, or "(missing)" for a budgeted class the build did not produce */
  name: string;
  budget: BudgetName | null;
  gzipKb: number | null;
  limitKb: number | null;
  ok: boolean;
}

/** The gzip -9 size of `bytes` in kB (1000 bytes). */
export function gzipKb(bytes: Buffer): number {
  return gzipSync(bytes, { level: constants.Z_BEST_COMPRESSION }).length / 1000;
}

/** One row per asset, then one per budgeted class with no asset. */
export function checkBundle(assets: { name: string; gzipKb: number }[], limits: BundleBudgets): BudgetRow[] {
  const rows: BudgetRow[] = assets.map(({ name, gzipKb: size }) => {
    const budget = CLASSES.find((c) => c.matches(name))?.budget ?? null;
    const limitKb = budget ? limits[budget] : null;
    return { name, budget, gzipKb: size, limitKb, ok: limitKb !== null && size <= limitKb };
  });
  for (const { budget } of CLASSES) {
    if (!rows.some((r) => r.budget === budget)) rows.push({ name: "(missing)", budget, gzipKb: null, limitKb: limits[budget], ok: false });
  }
  return rows;
}

function table(rows: BudgetRow[]): string[] {
  const cells = rows.map((r) => [
    r.name,
    r.budget ?? "(no budget)",
    r.gzipKb === null ? "-" : r.gzipKb.toFixed(1),
    r.limitKb === null ? "-" : r.limitKb.toFixed(1),
    r.ok ? "ok" : "OVER",
  ]);
  const head = ["asset", "budget", "gzip kB", "limit kB", ""];
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => (c[i] ?? "").length)));
  return [head, ...cells].map((c) =>
    c
      .map((v, i) => v.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd(),
  );
}

export function main(assetsDir: string, limits: BundleBudgets, log: (line: string) => void = console.log): number {
  if (!existsSync(assetsDir)) {
    log(`No build at ${assetsDir}: run npm run build first (npm run budgets does both).`);
    return 1;
  }
  const assets = readdirSync(assetsDir)
    .filter((name) => name.endsWith(".js") || name.endsWith(".css"))
    .sort()
    .map((name) => ({ name, gzipKb: gzipKb(readFileSync(join(assetsDir, name))) }));
  const rows = checkBundle(assets, limits);
  for (const line of table(rows)) log(line);
  const failed = rows.filter((r) => !r.ok);
  log(failed.length === 0 ? "Every asset is within budget (budgets.json)." : `${failed.length} asset(s) over budget or without one (budgets.json).`);
  return failed.length === 0 ? 0 : 1;
}

if (isEntryPoint(import.meta.url, import.meta.main)) process.exitCode = main(fileURLToPath(new URL("../dist/web/assets", import.meta.url)), budgets.bundle);
