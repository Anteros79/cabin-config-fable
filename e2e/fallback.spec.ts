import { expect, test } from "./fixtures.ts";
import { openVisit, recordPrimary, selectLocation, totalsOnPage } from "./helpers.ts";

// Runs only in the no-webgl project (PF-28): Chromium without WebGL.

test("WebGL unavailable: a notice, the map takes over seats, floors and bins, and the whole workflow completes", async ({
  page,
  visit,
  allowConsoleErrors,
}) => {
  // three.js reports the context it could not create; the app shows its own notice instead
  allowConsoleErrors(/THREE\.WebGLRenderer: .*WebGL context/);
  await openVisit(page, visit.id);
  await expect(page.locator(".viewer .alert")).toBeVisible();
  await expect(page.locator(".cabin-map")).toBeVisible();
  await expect(page.locator("#tab-3d"), "3D tab disabled while unavailable").toBeDisabled();
  await expect(page.locator(".cabin-map button[data-seat]")).toHaveCount(176);
  await expect(page.locator(".cabin-map section[aria-labelledby=map-floor] button.loc")).toHaveCount(4);
  await expect(page.locator(".cabin-map section[aria-labelledby=map-bins] button.loc")).toHaveCount(22);
  await selectLocation(page, "Mid floor area");
  await recordPrimary(page, "CARPET_PANEL");
  await selectLocation(page, "Overhead bin L-04");
  await recordPrimary(page, "BIN_DOOR");
  await page.getByRole("button", { name: "Complete visit…" }).click();
  await page.locator("dialog.confirm[open]").getByRole("button", { name: "Confirm completion" }).click();
  await expect(page).toHaveURL(/\/report$/);
  const totals = await totalsOnPage(page);
  expect(totals.map(([part]) => part).sort()).toEqual(["FAKE-V01-BIN-L-04", "FAKE-V01-MID-PANEL"].sort());
  await expect(page.locator(".report-kind")).toHaveText(/^FINAL/);
});
