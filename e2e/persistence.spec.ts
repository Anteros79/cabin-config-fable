import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Report } from "../src/domain/types.ts";
import { importReference } from "../src/importer/cli.ts";
import { expect, makeApi, test } from "./fixtures.ts";
import { lookup, openMap, openVisit, recordPrimary, selectLocation } from "./helpers.ts";
import { PROJECT_ROOT, startServer } from "./server.ts";

const CUSHION = (locationId: string) => ({ locationId, componentId: "CUSHION", selection: "PRIMARY", quantity: 1 });

test("quantity update, primary/alternate switch and remove keep one record with no orphans", async ({ page, api, visit }) => {
  await api.addRecord(visit.id, CUSHION("SEAT:7C"));
  await openVisit(page, visit.id);
  await openMap(page);
  await selectLocation(page, "Forward floor area");
  const panel = page.locator(".component-card[data-component=CARPET_PANEL]");
  await panel.getByLabel(/^Replacements/).fill("2");
  await panel.locator("button[type=submit]").click();
  await expect(panel.locator(".save-state.saved")).toBeVisible();
  await panel.getByLabel(/^Replacements/).fill("4");
  await panel.locator("button[type=submit]").click();
  await expect(page.locator(".worklist")).toContainText("FAKE-V01-FWD-PANEL 4 PANEL");
  await selectLocation(page, "Full cabin floor");
  const kit = page.locator(".component-card[data-component=CARPET_KIT]");
  await kit.locator("input[type=radio][value='FX-SUB-KIT-1']").check();
  await kit.locator("button[type=submit]").click();
  await expect(page.locator(".worklist")).toContainText("FAKE-P-42 1 PANEL");
  await kit.locator("input[type=radio][value=PRIMARY]").check();
  await kit.locator("button[type=submit]").click();
  await expect(page.locator(".worklist")).toContainText("Primary: FAKE-CK-2001 1 KIT");
  await expect(page.locator(".worklist")).not.toContainText("FAKE-P-39");
  await expect(page.locator(".worklist")).not.toContainText("FAKE-CK-2000");
  await kit.locator("button.danger").click();
  await expect(page.locator(".worklist")).not.toContainText("FAKE-CK-2001");
  const stored = (await api.call<{ visit: { records: { locationId: string; componentId: string; quantity: number }[] } }>("GET", `/api/visits/${visit.id}`))
    .json.visit;
  expect(stored.records.map((r) => `${r.locationId}/${r.componentId}/${r.quantity}`).sort()).toEqual(["FLOOR:FWD/CARPET_PANEL/4", "SEAT:7C/CUSHION/1"]);
});

test("a draft survives a server restart and a browser reload, and can be resumed from saved visits", async ({ page, api, server }) => {
  const visit = await api.createVisit("N100TL", "2026-11-12", "Restart Tech");
  await api.addRecord(visit.id, CUSHION("SEAT:7C"));
  await server.restart();
  await page.goto("/#/visits?q=Restart%20Tech");
  await page.reload();
  const row = page.locator("tbody tr", { hasText: "Restart Tech" }).first();
  await expect(row, "draft listed after restart").toContainText("Draft");
  await row.getByRole("link", { name: /Resume/ }).click();
  await expect(page.locator("#work-h")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/visit/${visit.id}$`));
  await expect(page.locator(".worklist"), "saved work restored").toContainText("Seat 7C");
  await openMap(page);
  await selectLocation(page, "Seat 7C");
  await recordPrimary(page, "BACKREST");
  expect((await api.call<{ visit: { recordCount: number } }>("GET", `/api/visits/${visit.id}`)).json.visit.recordCount, "work continued").toBe(2);
});

test("the resume link on the check page opens the last draft", async ({ page }) => {
  await page.goto("/#/check");
  await lookup(page, "N100TL", "2026-11-12");
  await page.getByRole("button", { name: "Start visit (saves a draft)" }).click();
  await expect(page.locator("#work-h")).toBeVisible();
  const visitUrl = page.url();
  await page.goto("/#/check");
  await page.getByRole("link", { name: "Resume the last draft visit" }).click();
  await expect(page.locator("#work-h")).toBeVisible();
  expect(page.url()).toBe(visitUrl);
});

test("changing the lookup form does not retarget the open visit", async ({ page, visit }) => {
  await page.goto("/#/check");
  await lookup(page, "N300TL", "2026-11-12");
  await openVisit(page, visit.id);
  await expect(page.locator("#visit-h")).toContainText("N100TL · 12 Nov 2026");
  await expect(page.locator(".panel.config")).toContainText("V01");
});

test("a completed visit is locked in the UI and through the API", async ({ page, api, visit }) => {
  await api.addRecord(visit.id, CUSHION("SEAT:3A"));
  await api.complete(visit.id);
  await openVisit(page, visit.id);
  await expect(page.locator(".visit-head")).toContainText("Completed and locked");
  await expect(page.locator(".worklist button.primary"), "no complete button").toHaveCount(0);
  await expect(page.locator(".worklist button.danger"), "no remove buttons").toHaveCount(0);
  await openMap(page);
  await selectLocation(page, "Seat 4A");
  await expect(page.locator(".record-form"), "no record form on a completed visit").toHaveCount(0);
  const edit = await api.call<{ error: { code: string } }>("PUT", `/api/visits/${visit.id}/records`, { record: CUSHION("SEAT:4A") });
  expect([edit.status, edit.json.error.code], "API edit refused").toEqual([409, "VISIT_LOCKED"]);
});

test("more than 100 visits remain navigable in saved visits", async ({ page, api }) => {
  // its own technician name, so the oldest visit is findable whatever else this worker's store holds
  const first = await api.createVisit("N100TL", "2026-11-12", "Oldest Tech");
  await api.addRecord(first.id, CUSHION("SEAT:3A"));
  await api.complete(first.id);
  for (let i = 0; i < 118; i++) await api.createVisit(i % 2 ? "N100TL" : "N300TL", "2026-11-12", `Bulk ${String(i).padStart(3, "0")}`);
  await page.goto("/#/visits");
  await expect(page.locator("table tbody tr").first()).toBeVisible();
  const total = Number(/(\d+) visits/.exec((await page.locator("section[aria-labelledby=visits-h] [role=status]").textContent()) ?? "")?.[1]);
  expect(total).toBeGreaterThan(118);
  await page.locator(".pager button", { hasText: "Last" }).click();
  await expect(page.locator("tbody th", { hasText: /^#1$/ })).toHaveCount(1);
  await page.locator("form.filters input").fill("Oldest Tech");
  await page.locator("form.filters button[type=submit]").click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody"), "the oldest visit is reachable by its technician").toContainText("Oldest Tech");
  await page.locator("form.filters input").fill("Bulk 007");
  await page.locator("form.filters button[type=submit]").click();
  await expect(page).toHaveURL(/q=Bulk(\+|%20)007/);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("Bulk 007");
  await page.locator("form.filters select").selectOption("COMPLETED");
  await page.locator("form.filters input").fill("");
  await page.locator("form.filters button[type=submit]").click();
  await expect(page).toHaveURL(/#\/visits\?status=COMPLETED$/);
  await expect(page.locator("tbody tr").first()).toContainText("Completed");
  for (const row of await page.locator("tbody tr").all()) await expect(row).toContainText("Completed");
});

test("a reference update leaves the completed report unchanged and is flagged on a draft, not applied", async ({ page }) => {
  // This test activates a second reference release, so it gets a server of its own and leaves the worker's alone.
  const own = await startServer();
  try {
    const ownApi = makeApi(own.baseURL);
    const call = async <T>(method: string, path: string, body?: unknown) => (await ownApi.call<T>(method, path, body)).json;
    const completed = (await call<{ visit: { id: string } }>("POST", "/api/visits", { tail: "N100TL", checkDate: "2026-11-12" })).visit.id;
    await call("PUT", `/api/visits/${completed}/records`, { record: CUSHION("SEAT:3A") });
    await call("POST", `/api/visits/${completed}/complete`, { confirm: true });
    const draft = (await call<{ visit: { id: string; referenceReleaseId: string } }>("POST", "/api/visits", { tail: "N100TL", checkDate: "2026-11-12" })).visit;
    const before = await call<{ report: Report; basisSha256: string }>("GET", `/api/visits/${completed}/report`);

    // A label alone is not hashed (an unchanged import is a no-op), so revise one fictional rule in a temp copy of the fixtures.
    const fixtures = JSON.parse(readFileSync(join(PROJECT_ROOT, "fixtures", "fixture-data.json"), "utf8")) as { extraRules: { id: string; note: string }[] };
    const revised = fixtures.extraRules.find((r) => r.id === "FX-R4");
    if (!revised) throw new Error("fixture rule FX-R4 not found");
    revised.note = `${revised.note} Revised in a later (fictional) release.`;
    const fixturePath = join(own.dataDir, "fixture-data-revised.json");
    writeFileSync(fixturePath, JSON.stringify(fixtures));
    const outcome = importReference({
      referencePath: join(own.dataDir, "reference.sqlite"),
      visitsPath: join(own.dataDir, "visits.sqlite"),
      fixturePath,
      label: "Second release for the stability check",
    });
    expect(outcome.activated && outcome.visitsUnchanged === true, "new release activated; visit history fingerprint unchanged").toBe(true);

    const after = await call<{ report: Report; basisSha256: string }>("GET", `/api/visits/${completed}/report`);
    expect(after.basisSha256, "report basis hash").toBe(before.basisSha256);
    expect(JSON.stringify(after.report), "report content").toBe(JSON.stringify(before.report));

    await page.goto(`${own.baseURL}/#/visit/${draft.id}`);
    await expect(page.locator("#work-h")).toBeVisible();
    await expect(page.locator(".visit-head"), "the draft says reference data moved on but is not rebased").toContainText("not rebased");
    expect((await call<{ visit: { referenceReleaseId: string } }>("GET", `/api/visits/${draft.id}`)).visit.referenceReleaseId, "draft keeps its release").toBe(
      before.report.configuration.referenceReleaseId,
    );

    await page.goto(`${own.baseURL}/#/visit/${completed}/report`);
    await expect(page.locator("#totals-table")).toBeVisible();
    await page.locator(".note-form input[required]").fill("Rule revised in a later release; no change to work performed.");
    await page.locator(".note-form button[type=submit]").click();
    await expect(page.locator("section[aria-labelledby=r-linked]")).toContainText("Rule revised in a later release");
    expect((await call<{ basisSha256: string }>("GET", `/api/visits/${completed}/report`)).basisSha256, "a linked note leaves the basis unchanged").toBe(
      before.basisSha256,
    );
  } finally {
    await page.goto("about:blank");
    await own.dispose();
  }
});
