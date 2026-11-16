import { readFileSync } from "node:fs";
import type { Report } from "../src/domain/types.ts";
import { expect, test } from "./fixtures.ts";
import { flat, pdfText, SIX, setDate, tabTo, totalsOnPage } from "./helpers.ts";

/**
 * Where focus is while the completion dialog is open: "dialog" (an element inside it), "browser" (the document lost focus:
 * the native modal dialog lets Tab leave the page for the browser's own controls, and does not wrap) or "outside" (an
 * element of the page behind the dialog, or a focused <body>, which must never happen).
 */
const focusWhileDialogOpen = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    if (!document.hasFocus()) return "browser";
    const el = document.activeElement;
    if (el?.closest("dialog.confirm[open]")) return "dialog";
    return `outside: ${el?.outerHTML.slice(0, 80) ?? "nothing"}`;
  });

// The README walk-through, by keyboard only. Each step was one check of the old runner; they share one visit, so they are
// steps of one test.
test("README walk-through by keyboard: look up, record, alternate, complete, and the six totals agree everywhere", async ({
  page,
  api,
  allowConsoleErrors,
}, testInfo) => {
  // three.js reports the context it could not create; the app shows its own notice and the map takes over
  if (testInfo.project.name === "no-webgl") allowConsoleErrors(/THREE\.WebGLRenderer: .*WebGL context/);
  let visitId = "";

  await test.step("the skip link is the first tab stop and keeps the route", async () => {
    await page.goto("/#/check");
    await expect(page.locator("input[name=tail]")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("main#main")).toBeFocused();
    await expect(page).toHaveURL(/#\/check$/);
  });

  await test.step("look up N100TL and start a visit using only the keyboard", async () => {
    await tabTo(page, "input[name=tail]");
    await page.keyboard.type("n100tl");
    await tabTo(page, "input[name=date]");
    await setDate(page, "2026-11-12");
    await tabTo(page, "input[name=technician]");
    await page.keyboard.type("Keyboard Tech");
    await tabTo(page, "form.lookup-form button[type=submit]");
    await page.keyboard.press("Enter");
    await expect(page.locator(".status-card[data-state=RESOLVED]")).toBeVisible();
    await tabTo(page, ".status-card .actions button.primary");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#\/visit\/[0-9a-f-]{36}$/);
    visitId = await page.evaluate(() => location.hash.split("/")[2] ?? "");
    await expect(page.locator("#work-h")).toBeVisible();
  });

  await test.step("select seat 3A in the map with arrow keys and record the cushion", async () => {
    // Tabs follow the WAI-ARIA pattern: Tab reaches the selected tab, and the arrow keys move to and show the other one.
    // Without WebGL the map is already shown and the 3D tab is disabled.
    if ((await page.locator("#tab-map").getAttribute("aria-selected")) !== "true") {
      await tabTo(page, "#tab-3d");
      await page.keyboard.press("ArrowRight");
      await expect(page.locator("#tab-map")).toBeFocused();
    }
    await expect(page.locator(".cabin-map")).toBeVisible();
    await tabTo(page, "button[data-seat='1A']");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("button[data-seat='3A']")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#inspector-heading")).toHaveText("Seat 3A");
    await expect(page.locator("button[data-seat='3A']")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".component-card[data-component=CUSHION]")).toContainText("FAKE-SC-1001");
    await tabTo(page, ".component-card[data-component=CUSHION] button[type=submit]");
    await page.keyboard.press("Enter");
    await expect(page.locator(".component-card[data-component=CUSHION] .save-state.saved")).toBeVisible();
    await expect(page.locator("button[data-seat='3A']")).toHaveAttribute("aria-label", /1 replacement recorded/);
  });

  await test.step("select the full-cabin floor, choose the approved alternate and record it", async () => {
    await tabTo(page, ".cabin-map button.loc[data-location='FLOOR:FULL-CABIN']");
    await page.keyboard.press("Space");
    await expect(page.locator("#inspector-heading")).toHaveText(/^Full cabin floor/);
    const card = page.locator(".component-card[data-component=CARPET_KIT]");
    await expect(card).toContainText("FAKE-CK-2001");
    await expect(card).toContainText("FAKE-CK-2000");
    for (const part of ["FAKE-P-39", "FAKE-P-40", "FAKE-P-41", "FAKE-P-42"]) await expect(card).toContainText(part);
    await tabTo(page, ".component-card[data-component=CARPET_KIT] input[type=radio]:checked");
    await page.keyboard.press("ArrowDown"); // radio group: from Primary to the alternate
    await expect(card.locator("input[type=radio]:checked")).toHaveAttribute("value", "FX-SUB-KIT-1");
    await tabTo(page, ".component-card[data-component=CARPET_KIT] button[type=submit]");
    await page.keyboard.press("Enter");
    await expect(card.locator(".save-state.saved")).toBeVisible();
    const work = page.locator(".worklist");
    await expect(work).toContainText("Alternate: FAKE-CK-2000 1 KIT, FAKE-P-39 2 PANEL, FAKE-P-40 2 PANEL, FAKE-P-41 1 PANEL, FAKE-P-42 1 PANEL");
    await expect(work).not.toContainText("FAKE-CK-2001");
  });

  await test.step("the draft is saved and its report is a draft preview", async () => {
    const draft = await api.call<{ report: Report }>("GET", `/api/visits/${visitId}/report`);
    expect(draft.json.report.reportKind).toBe("DRAFT_PREVIEW");
  });

  await test.step("complete requires an explicit confirmation; focus stays in the dialog; it opens the locked report", async () => {
    await tabTo(page, ".worklist button.primary");
    await page.keyboard.press("Enter");
    const dialog = page.locator("dialog.confirm[open]");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog.confirm[open]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Complete visit…" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    expect((await api.call<{ visit: { status: string } }>("GET", `/api/visits/${visitId}`)).json.visit.status).toBe("DRAFT");
    // Tab and Shift+Tab never focus an element of the page behind the open dialog (wrapping is not required)
    const seen = new Set<string>();
    for (const key of ["Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
      await page.keyboard.press(key);
      const where = await focusWhileDialogOpen(page);
      expect(where, `focus after ${key}`).toMatch(/^(dialog|browser)$/);
      seen.add(where);
    }
    expect(seen.has("dialog"), "Tab keeps reaching the dialog's buttons").toBe(true);
    await dialog.getByRole("button", { name: "Cancel" }).focus();
    // Cancel is the last button; the confirm button is just before it
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "Confirm completion" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/report$/);
    await expect(page.locator("#totals-table")).toBeVisible();
    await expect(page.locator(".report-kind")).toHaveText(/^FINAL/);
  });

  await test.step("report shows exactly the six mandated part/unit totals", async () => {
    expect(await totalsOnPage(page)).toEqual(SIX);
    const body = page.locator("article.report");
    for (const s of ["Keyboard Tech", "N100TL", "12 Nov 2026", "V01", "Not an approved maintenance authority"]) await expect(body).toContainText(s);
  });

  await test.step("JSON download, server PDF and printed PDF carry the same six totals as the persisted work", async () => {
    await tabTo(page, ".report-actions a[download]");
    const downloading = page.waitForEvent("download");
    await page.keyboard.press("Enter");
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/^cabin-kit-report-N100TL-2026-11-12-visit-\d+\.json$/);
    const json = JSON.parse(readFileSync(await download.path(), "utf8")) as { report: Report };
    expect(json.report.totals.map((t) => [t.partNo, t.quantity, t.unit])).toEqual(SIX);

    const stored = (await api.call<{ visit: { records: { lines: { partNo: string; unit: string; qty: number }[] }[] } }>("GET", `/api/visits/${visitId}`)).json
      .visit;
    const sums = new Map<string, number>();
    for (const r of stored.records) for (const l of r.lines) sums.set(`${l.partNo}|${l.unit}`, (sums.get(`${l.partNo}|${l.unit}`) ?? 0) + l.qty);
    expect([...sums.entries()].sort()).toEqual(json.report.totals.map((t) => [`${t.partNo}|${t.unit}`, t.quantity]).sort());

    const serverPdf = new Uint8Array(await (await page.request.get(`/api/visits/${visitId}/report.pdf`)).body());
    const printed = new Uint8Array(await page.pdf({ format: "Letter", printBackground: true }));
    for (const [label, bytes] of [
      ["server PDF", serverPdf],
      ["browser print PDF", printed],
    ] as const) {
      const text = await pdfText(bytes);
      const f = flat(text);
      for (const t of json.report.totals) expect(f, `${label} carries ${t.partNo}`).toContain(flat(`${t.partNo}${t.description}${t.quantity}${t.unit}`));
      expect(f, `${label} does not total the primary kit`).not.toContain("FAKE-CK-20011KIT");
      // both write the check date in words, the same way (Task 5.8)
      for (const s of ["N100TL", "12Nov2026", "KeyboardTech", "Seat3A", json.report.visit.id]) expect(f, `${label} contains ${s}`).toContain(s);
      expect(text, `${label} is marked final`).toMatch(/FINAL/);
    }
  });
});
