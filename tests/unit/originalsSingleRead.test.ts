import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

const reads = vi.hoisted(() => new Map<string, number>());

// Count every readFileSync by path; the real implementation still does the reading.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    reads.set(String(path), (reads.get(String(path)) ?? 0) + 1);
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

const { buildCandidateContent } = await import("../../src/importer/candidate.ts");
const { DATA_ORIGINALS, resolveSourceRoot } = await import("../../src/importer/originals.ts");

describe("originals are verified and staged from one read", () => {
  test("each data original is read exactly once per candidate build", () => {
    const root = resolveSourceRoot();
    reads.clear();
    const content = buildCandidateContent(root);
    expect(content.findings.filter((f) => f.severity === "error")).toEqual([]);
    for (const file of DATA_ORIGINALS) expect({ file, reads: reads.get(join(root, file)) ?? 0 }).toEqual({ file, reads: 1 });
  });
});
