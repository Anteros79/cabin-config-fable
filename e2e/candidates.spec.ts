import { expect, test } from "./fixtures.ts";
import { clickLocation, openMap, scene, setCamera, waitFor3D } from "./helpers.ts";

test("the candidate 73G layout is explorable with its status visible and nothing resolvable or recordable", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("cabin-kit.hint.3d", "dismissed"));
  await page.goto("/#/layouts");
  await expect(page.locator("table").first()).toBeVisible();
  const category = page.locator("li[data-category='DOCX-CAT-700-138']");
  await expect(category, "the 138-seat category is explicit and unresolved").toContainText("Unresolved: seat set not supplied");
  await expect(category).toContainText("7D, 7E, 7F, 15B and 15C");
  await page.getByRole("link", { name: "73G: Boeing 737-700" }).click();
  const head = page.locator("section[aria-labelledby=layout-h]");
  for (const s of ["Candidate, unassigned", "137 seats", "floor map not-supplied"]) await expect(head).toContainText(s);
  await waitFor3D(page);
  const info = await scene(page);
  expect([info.seats, info.floorAreas, info.binModules], "137 seats, no selectable floor or bin locations").toEqual([137, 0, 0]);
  await setCamera(page, "focus", "SEAT:14B");
  await clickLocation(page, "SEAT:14B");
  await expect(page.locator("#inspector-heading")).toHaveText("Seat 14B");
  const inspector = page.locator(".inspector");
  for (const s of ["physical row 10", "Printed row 14", "no approved parts"]) await expect(inspector).toContainText(s);
  // a candidate layout cannot start a visit, so nothing can be recorded on it
  await expect(page.locator(".record-form")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Start visit/ })).toHaveCount(0);
  await openMap(page);
  await expect(page.locator(".seat-grid")).toContainText("Printed rows 10, 11, 12, 13 do not exist in this layout");
  await expect(page.locator("button[data-seat='14A']"), "14A is absent").toHaveCount(0);
  await expect(page.locator(".cabin-map button[data-seat]")).toHaveCount(137);
  await expect(page.locator("section[aria-labelledby=map-floor]"), "the floor map gap is explicit").toContainText("not supplied");
});

test("the reference view shows the active release, its sources and its import findings", async ({ page }) => {
  await page.goto("/#/reference");
  await expect(page.locator("#ref-h")).toBeVisible();
  await expect(page.locator(".findings")).toBeVisible();
  for (const heading of ["Namespaces", "Counts", "Visual families", "Releases"])
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Import findings \(\d+\)$/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Sources \(\d+\)$/ })).toBeVisible();
});
