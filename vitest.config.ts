import { defineConfig } from "vitest/config";

// Projects give each tier its own timeout. Phase 4 adds a `web` project.
// Files whose assertions are wall-clock/CPU bounds live in `perf`: the other projects exclude them, and the
// `perf` runs alone: serial files, in its own sequence group that starts only after every other project has finished.
const PERF_FILES = ["tests/unit/scale.test.ts", "tests/unit/kits.test.ts", "tests/unit/xlsx.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          exclude: [...PERF_FILES, "**/node_modules/**"],
          testTimeout: 5000,
          hookTimeout: 5000,
          pool: "forks",
        },
      },
      {
        test: {
          name: "perf",
          include: PERF_FILES,
          testTimeout: 5000,
          hookTimeout: 5000,
          pool: "forks",
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          testTimeout: 20000,
          hookTimeout: 20000,
          pool: "forks",
        },
      },
      {
        test: {
          name: "process",
          include: ["tests/process/**/*.test.ts"],
          testTimeout: 60000,
          hookTimeout: 60000,
          pool: "forks",
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/domain/**", "src/importer/**", "src/server/**"],
      reporter: ["text-summary", "lcov"],
      // Global: measured after Task 1.10 (90.66% lines / 78.19% branches), rounded down to 5. Later phases raise these.
      // src/domain: the plan's floor from Task 2.8 on (measured then at about 97% lines / 87% branches).
      // src/importer: the plan's floor from Task 3.8 on.
      thresholds: { lines: 90, branches: 75, "src/domain/**": { lines: 90, branches: 85 }, "src/importer/**": { lines: 85, branches: 75 } },
    },
  },
});
