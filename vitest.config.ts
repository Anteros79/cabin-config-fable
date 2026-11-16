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
      // Measured after Task 1.10: 90.66% lines / 78.19% branches, rounded down to 5. Later phases raise these.
      thresholds: { lines: 90, branches: 75 },
    },
  },
});
