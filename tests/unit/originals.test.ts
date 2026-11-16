import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PROJECT_ROOT } from "../../src/importer/assemble.ts";
import { assertSourceRoot, DATA_ORIGINALS, resolveImageRoot, resolveSourceRoot } from "../../src/importer/originals.ts";

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

test("empty CABIN_KIT_SOURCE_ROOT is treated as unset", () => {
  expect(resolveSourceRoot({ CABIN_KIT_SOURCE_ROOT: "" })).toBe(join(PROJECT_ROOT, "fixtures", "originals"));
  expect(resolveSourceRoot({ CABIN_KIT_SOURCE_ROOT: "   " })).toBe(join(PROJECT_ROOT, "fixtures", "originals"));
});

test("explicit root wins", () => {
  expect(resolveSourceRoot({ CABIN_KIT_SOURCE_ROOT: "/x/y" })).toBe("/x/y");
});

test("image root skips the vendored folder: explicit root, else the development folder", () => {
  expect(resolveImageRoot({ CABIN_KIT_SOURCE_ROOT: "/x/y" })).toBe("/x/y");
  expect(resolveImageRoot({ CABIN_KIT_SOURCE_ROOT: " " })).toBe(join(PROJECT_ROOT, "..", ".."));
});

test("vendored originals match the manifest byte for byte", () => {
  const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, "evidence", "originals-manifest.json"), "utf8"));
  for (const file of DATA_ORIGINALS) {
    const entry = manifest.files.find((f: { path: string }) => f.path === file);
    expect(statSync(join(PROJECT_ROOT, "fixtures", "originals", file)).size).toBe(entry.bytes);
    expect(sha256(readFileSync(join(PROJECT_ROOT, "fixtures", "originals", file)))).toBe(entry.sha256);
  }
});

test("assertSourceRoot rejects a file and a missing path", () => {
  expect(() => assertSourceRoot(join(PROJECT_ROOT, "package.json"))).toThrow(/not a directory/);
  expect(() => assertSourceRoot("/no/such/dir")).toThrow(/not a directory/);
});
