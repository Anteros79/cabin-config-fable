import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures.ts";

test("preparation overview: lists every applicable part, filters, and says coverage is not work done", async ({ page }) => {
  await page.goto("/#/prep?tail=N100TL&date=2026-11-12");
  const rows = page.locator("#prep-table tbody tr");
  const served = (await (await page.request.get("/api/preparation?tail=N100TL&date=2026-11-12")).json()) as { lines: { partNo: string }[] };
  expect(served.lines.length).toBeGreaterThan(50);
  await expect(rows, "a row for every applicable part line the server lists").toHaveCount(served.lines.length);
  expect(await rows.evaluateAll((trs) => trs.map((tr) => tr.getAttribute("data-part"))), "the same parts, in the same order").toEqual(
    served.lines.map((l) => l.partNo),
  );
  await expect(page.locator(".prep .advisory")).toContainText("not replacements made");
  await page.locator(".prep input[type=search]").fill("FAKE-P-41");
  await expect(rows).toHaveCount(1);
  // the alternate and its supplements are separate from the primary
  for (const s of ["FAKE-CK-2001", "Alternate FAKE-CK-2000", "Required: FAKE-P-41 × 1 PANEL"]) await expect(rows).toContainText(s);
  await page.locator(".prep input[type=search]").fill("");
  await page.locator(".prep label", { hasText: "Component" }).locator("select").selectOption("CUSHION");
  await page.locator(".prep input[type=search]").fill("1001");
  await expect(rows).toHaveCount(1);
  await expect(rows, "coverage summary").toContainText("Seat A rows 1-5 (5 locations)");
});

test("preparation CSV export: its filename and its content", async ({ page }) => {
  await page.goto("/#/prep?tail=N100TL&date=2026-11-12");
  await expect(page.locator("#prep-table tbody tr").first()).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page.getByRole("link", { name: /CSV/ }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("cabin-kit-preparation-N100TL-2026-11-12.csv");
  const csv = readFileSync(await download.path(), "utf8");
  expect(csv).toContain("ALTERNATE,FAKE-CK-2000");
  expect(csv).toContain("REQUIRED_SUPPLEMENT,FAKE-P-39");
  const served = (await (await page.request.get("/api/preparation?tail=N100TL&date=2026-11-12")).json()) as { lines: unknown[] };
  expect(csv.split("\n").filter((l) => l.startsWith("PRIMARY,")).length, "a PRIMARY line per applicable part line").toBe(served.lines.length);
});
