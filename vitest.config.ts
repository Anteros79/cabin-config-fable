import { defineConfig } from "vitest/config";

// Three projects so each tier gets its own timeout. Phase 4 adds a `web` project.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          testTimeout: 5000,
          hookTimeout: 5000,
          pool: "forks",
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
      thresholds: { lines: 90, branches: 75, "src/domain/**": { lines: 90, branches: 85 } },
    },
  },
});
