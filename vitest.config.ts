import { defineConfig } from "vitest/config";

// Projects give each tier its own timeout. `web` runs React component and hook tests in jsdom.
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
          name: "web",
          environment: "jsdom",
          include: ["tests/web/**/*.test.{ts,tsx}"],
          setupFiles: ["tests/web/setup.ts"],
          testTimeout: 10000,
          hookTimeout: 10000,
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
      include: ["src/domain/**", "src/importer/**", "src/server/**", "src/web/**"],
      exclude: ["src/web/scene/**", "src/web/**/*.d.ts", "src/web/index.html"],
      reporter: ["text-summary", "lcov"],
      // Global: measured after Task 4.1 added src/web (78.43% lines / 65.48% branches), rounded down to 5. Before src/web it was
      // 90.66 / 78.19, and the trees below keep their own floors, so the drop is all in the browser code, which Phase 4 raises.
      // src/domain: the plan's floor from Task 2.8 on (measured then at about 97% lines / 87% branches).
      // src/importer: the plan's floor from Task 3.8 on.
      // src/web: measured in Task 4.1 (13.21% lines / 10.54% branches), rounded down to 5; excludes src/web/scene.
      thresholds: {
        lines: 75,
        branches: 60,
        "src/domain/**": { lines: 90, branches: 85 },
        "src/importer/**": { lines: 85, branches: 75 },
        "src/web/**": { lines: 10, branches: 10 },
      },
    },
  },
});
