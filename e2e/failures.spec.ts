import { expect, test } from "./fixtures.ts";
import { lookup, open3D, openMap, openVisit, recordPrimary, scene, selectLocation } from "./helpers.ts";

// Each failure is set inside its test (a fault, a route, a stopped server) and cleared by the fixtures: faults by the api
// fixture's teardown, routes with the page, and a stopped server is restarted before the test ends.

const RECORDS = "**/api/visits/*/records";
const cushion = (page: import("@playwright/test").Page) => page.locator(".component-card[data-component=CUSHION]");
const recordsAt = async (api: import("./fixtures.ts").Api, visitId: string, locationId: string) =>
  (await api.call<{ visit: { records: { locationId: string; version: number }[] } }>("GET", `/api/visits/${visitId}`)).json.visit.records.filter(
    (r) => r.locationId === locationId,
  );

test("network loss during save: the outcome is reported as unknown, typed input and selection are kept, retry is safe", async ({
  page,
  visit,
  api,
  allowConsoleErrors,
}) => {
  allowConsoleErrors(/Failed to load resource: net::ERR_CONNECTION_RESET/);
  await openVisit(page, visit.id);
  await openMap(page);
  await selectLocation(page, "Seat 12A");
  await page.route(RECORDS, (route) => route.abort("connectionreset"));
  const card = cushion(page);
  await card.locator("textarea").fill("typed before the connection dropped");
  await card.locator("button[type=submit]").click();
  await expect(card.locator(".save-state.unknown")).toContainText("may or may not have been saved");
  await expect(card.locator("textarea")).toHaveValue("typed before the connection dropped");
  await expect(page.locator("button[data-seat='12A']")).toHaveAttribute("aria-pressed", "true");
  await page.unroute(RECORDS);
  await card.getByRole("button", { name: "Retry safely" }).click();
  await expect(card.locator(".save-state.saved")).toBeVisible();
  expect((await recordsAt(api, visit.id, "SEAT:12A")).map((r) => r.version)).toEqual([1]);
});

test("response lost after commit: retry confirms the earlier save without duplicating it", async ({ page, visit, api, allowConsoleErrors }) => {
  allowConsoleErrors(/Failed to load resource: net::ERR_CONNECTION_RESET/);
  await openVisit(page, visit.id);
  await openMap(page);
  await selectLocation(page, "Seat 12C");
  // the request reaches the server and commits; the answer is then lost on the way back
  await page.route(RECORDS, async (route) => {
    await route.fetch();
    await route.abort("connectionreset");
  });
  const card = cushion(page);
  await card.locator("button[type=submit]").click();
  await expect(card.locator(".save-state.unknown")).toBeVisible();
  await page.unroute(RECORDS);
  expect(await recordsAt(api, visit.id, "SEAT:12C"), "the write had in fact committed").toHaveLength(1);
  await card.getByRole("button", { name: "Retry safely" }).click();
  await expect(card.locator(".save-state.saved")).toContainText("nothing was duplicated");
  expect(
    (await recordsAt(api, visit.id, "SEAT:12C")).map((r) => r.version),
    "one record, version 1",
  ).toEqual([1]);
});

test("storage failure: reported as Not saved, nothing is stored, retry succeeds after recovery", async ({ page, visit, api, allowConsoleErrors }) => {
  allowConsoleErrors(/status of 503/); // the simulated storage failure
  await openVisit(page, visit.id);
  await openMap(page);
  await selectLocation(page, "Seat 12D");
  await api.setFault({ visitWrites: "fail", remaining: 1 });
  const card = cushion(page);
  await card.locator("button[type=submit]").click();
  const state = card.locator(".save-state.error");
  // the client's own "Not saved" prefix, then the server's explanation
  await expect(state).toHaveText(/^Not saved: /);
  await expect(state).toContainText(/nothing was saved/i);
  expect(await recordsAt(api, visit.id, "SEAT:12D"), "nothing stored").toHaveLength(0);
  await card.getByRole("button", { name: "Retry safely" }).click();
  await expect(card.locator(".save-state.saved")).toBeVisible();
  expect(await recordsAt(api, visit.id, "SEAT:12D")).toHaveLength(1);
});

test("reference unavailable: lookup shows SERVICE_UNAVAILABLE, saved visits stay usable, then it recovers", async ({
  page,
  visit,
  api,
  allowConsoleErrors,
}) => {
  allowConsoleErrors(/status of 503/);
  await api.setFault({ reference: "fail" });
  await page.goto("/#/check");
  expect(await lookup(page, "N100TL", "2026-11-12")).toBe("SERVICE_UNAVAILABLE");
  await expect(page.getByRole("button", { name: "Start visit (saves a draft)" }), "no visit can start").toHaveCount(0);
  // the draft works from its own frozen snapshot
  await openVisit(page, visit.id);
  await openMap(page);
  await selectLocation(page, "Seat 13A");
  await recordPrimary(page, "CUSHION");
  await api.setFault({});
  await page.goto("/#/check");
  expect(await lookup(page, "N100TL", "2026-11-12"), "recovered").toBe("RESOLVED");
});

test("server down: the unsent record is reported as unknown, and after recovery the draft is intact", async ({
  page,
  visit,
  api,
  server,
  allowConsoleErrors,
}) => {
  allowConsoleErrors(/Failed to load resource: net::ERR_CONNECTION_REFUSED/);
  await api.addRecord(visit.id, { locationId: "SEAT:13A", componentId: "CUSHION", selection: "PRIMARY", quantity: 1 });
  await openVisit(page, visit.id);
  await openMap(page);
  await selectLocation(page, "Seat 13C");
  await server.stop();
  try {
    const card = cushion(page);
    await card.locator("button[type=submit]").click();
    await expect(card.locator(".save-state.unknown")).toContainText("may or may not have been saved");
    await expect(card.getByRole("button", { name: "Retry safely" })).toBeVisible();
  } finally {
    await server.restart();
  }
  await openVisit(page, visit.id);
  await expect(page.locator(".worklist"), "earlier work intact after the outage").toContainText("Seat 13A");
  await expect(page.locator(".worklist"), "the unsent record was not silently saved").not.toContainText("Seat 13C");
});

test("3D module failure: the map and list cover everything, work continues, and retry restores 3D", async ({ page, visit, allowConsoleErrors }) => {
  allowConsoleErrors(/Failed to load resource: net::ERR_FAILED/);
  await page.addInitScript(() => localStorage.setItem("cabin-kit.hint.3d", "dismissed"));
  await page.route("**/assets/CabinScene-*.js", (route) => route.abort());
  await page.goto(`/#/visit/${visit.id}`);
  await expect(page.locator(".viewer .alert")).toContainText("3D view unavailable");
  await expect(page.locator(".cabin-map")).toBeVisible();
  await expect(page.locator(".cabin-map button[data-seat]"), "all seats").toHaveCount(176);
  await expect(page.locator(".cabin-map section[aria-labelledby=map-floor] button.loc"), "all floor locations").toHaveCount(4);
  await expect(page.locator(".cabin-map section[aria-labelledby=map-bins] button.loc"), "all bin modules").toHaveCount(22);
  await selectLocation(page, "Overhead bin L-04");
  await recordPrimary(page, "BIN_DOOR");
  await page.unroute("**/assets/CabinScene-*.js");
  await page.locator(".viewer .alert button").click();
  await open3D(page);
  expect((await scene(page)).selection, "selection kept when 3D came back").toBe("BIN:L-04");
  await expect(page.locator(".worklist"), "work kept").toContainText("Overhead bin L-04");
});

test("blocked localStorage does not break the app", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get: () => {
        throw new Error("blocked");
      },
    });
  });
  await page.goto("/#/check");
  await lookup(page, "N100TL", "2026-11-12");
  await page.getByRole("button", { name: "Start visit (saves a draft)" }).click();
  await expect(page.locator("#work-h")).toBeVisible();
});
