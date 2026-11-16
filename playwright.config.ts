import { defineConfig } from "@playwright/test";

// The bundled Chromium from `npx playwright install chromium`, in its new headless mode ("chromium" channel), which uses the
// platform's GPU backend where there is one. WebGL without a GPU (Linux CI, containers): ANGLE on SwiftShader.
const linuxGl = process.platform === "linux" ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : [];
const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, launchOptions: { args: linuxGl } };

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  use: {
    locale: "en-GB",
    timezoneId: "UTC",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    acceptDownloads: true,
    channel: "chromium",
  },
  projects: [
    // fallback.spec.ts needs WebGL off: it runs only in no-webgl (PF-28)
    { name: "desktop", testIgnore: ["mobile.spec.ts", "fallback.spec.ts"], use: { ...desktop } },
    {
      name: "mobile",
      testMatch: ["mobile.spec.ts", "a11y.spec.ts", "workflow.spec.ts"],
      use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, launchOptions: { args: linuxGl } },
    },
    {
      name: "no-webgl",
      testMatch: ["fallback.spec.ts", "workflow.spec.ts"],
      use: { ...desktop, launchOptions: { args: ["--disable-gpu", "--disable-webgl", "--disable-webgl2"] } },
    },
    { name: "reduced-motion", testMatch: ["scene.spec.ts"], use: { ...desktop, reducedMotion: "reduce" } },
    { name: "dark", testMatch: ["a11y.spec.ts"], use: { ...desktop, colorScheme: "dark" } },
  ],
});
