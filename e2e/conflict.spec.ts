import { expect, test } from "./fixtures.ts";
import { openMap, openVisit, selectLocation } from "./helpers.ts";

interface StoredRecord {
  locationId: string;
  componentId: string;
  quantity: number;
  version: number;
}
const records = async (api: import("./fixtures.ts").Api, visitId: string) =>
  (await api.call<{ visit: { records: StoredRecord[]; status: string } }>("GET", `/api/visits/${visitId}`)).json.visit;

// Two pages on one visit, as two tabs or two technicians would have them.

test("a stale edit from a second window shows both values, keeps the typed input, and the first writer's value stays", async ({
  page,
  context,
  api,
  visit,
  allowConsoleErrors,
}) => {
  allowConsoleErrors(/status of 409/); // the refused stale write
  const other = await context.newPage();
  for (const p of [other, page]) {
    await openVisit(p, visit.id);
    await openMap(p);
    await selectLocation(p, "Forward floor area");
  }
  const mine = page.locator(".component-card[data-component=CARPET_PANEL]");
  await mine.getByLabel(/^Replacements/).fill("3");
  await mine.locator("button[type=submit]").click();
  await expect(mine.locator(".save-state.saved")).toBeVisible();

  const theirs = other.locator(".component-card[data-component=CARPET_PANEL]");
  // 2, not 1: a typed 1 equals an untouched form, which rightly follows the saved record
  await theirs.getByLabel(/^Replacements/).fill("2");
  await theirs.locator("button[type=submit]").click();
  await expect(theirs.locator(".save-state.conflict")).toContainText("Not saved");
  // the saved value is shown beside the one this window typed, which is kept
  await expect(theirs.locator(".notice")).toContainText("changed elsewhere. Saved value: Primary, 3,");
  await expect(theirs.getByLabel(/^Replacements/)).toHaveValue("2");
  await expect(other.locator(".worklist")).toContainText("FAKE-V01-FWD-PANEL 3 PANEL");
  expect((await records(api, visit.id)).records.find((r) => r.componentId === "CARPET_PANEL")?.quantity, "first writer's value kept").toBe(3);
});

test("an unknown outcome in one tab, seen saved in another, then Retry safely stores it once", async ({ page, context, api, visit, allowConsoleErrors }) => {
  allowConsoleErrors(/Failed to load resource: net::ERR_CONNECTION_RESET/);
  await openVisit(page, visit.id);
  await openMap(page);
  await selectLocation(page, "Seat 12C");
  // the request reaches the server and commits; the answer is then lost on the way back
  await page.route("**/api/visits/*/records", async (route) => {
    await route.fetch();
    await route.abort("connectionreset");
  });
  const card = page.locator(".component-card[data-component=CUSHION]");
  await card.locator("button[type=submit]").click();
  await expect(card.locator(".save-state.unknown")).toContainText("may or may not have been saved");
  await page.unroute("**/api/visits/*/records");

  // a second tab sees what the server stored
  const other = await context.newPage();
  await openVisit(other, visit.id);
  await expect(other.locator(".worklist")).toContainText("Seat 12C");

  await card.getByRole("button", { name: "Retry safely" }).click();
  await expect(card.locator(".save-state.saved")).toContainText("nothing was duplicated");
  const stored = (await records(api, visit.id)).records.filter((r) => r.locationId === "SEAT:12C");
  expect(
    stored.map((r) => r.version),
    "one record, version 1",
  ).toEqual([1]);
});

test("an edit racing completion is refused: nothing is stored and the page follows to the completed, locked visit", async ({
  page,
  api,
  visit,
  allowConsoleErrors,
}) => {
  allowConsoleErrors(/status of 409/);
  await api.addRecord(visit.id, { locationId: "SEAT:3A", componentId: "CUSHION", selection: "PRIMARY", quantity: 1 });
  await openVisit(page, visit.id);
  await openMap(page);
  await selectLocation(page, "Seat 4A");
  // completed elsewhere while this page still shows the draft
  await api.complete(visit.id);
  const card = page.locator(".component-card[data-component=CUSHION]");
  await card.locator("button[type=submit]").click();
  // the refusal reloads the visit: it shows as locked and the form is gone
  await expect(page.locator(".visit-head")).toContainText("Completed and locked");
  await expect(page.locator(".record-form")).toHaveCount(0);
  await expect(card).toContainText("This visit is completed and locked.");
  const stored = await records(api, visit.id);
  expect(stored.status).toBe("COMPLETED");
  expect(
    stored.records.map((r) => r.locationId),
    "nothing stored for 4A",
  ).toEqual(["SEAT:3A"]);
});
