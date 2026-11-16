import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { expect, test } from "vitest";

// Biome has no rule for a method name, so the ban on localeCompare outside src/web is enforced here.
const ROOT = join(import.meta.dirname, "..", "..");
const TREES = ["src/domain", "src/importer", "src/server", "tools"];
const EXTENSIONS = new Set([".ts", ".mjs"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

function findMatches(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const tree of TREES) {
    for (const file of sourceFiles(join(ROOT, tree))) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (pattern.test(line)) found.push(`${file.slice(ROOT.length + 1)}:${index + 1}`);
        });
    }
  }
  return found;
}

test("the scan covers a non-empty file set in every tree", () => {
  for (const tree of TREES) expect(sourceFiles(join(ROOT, tree)).length, tree).toBeGreaterThan(0);
});

test("localeCompare is not used outside src/web", () => {
  expect(findMatches(/\.localeCompare\(/)).toEqual([]);
});
