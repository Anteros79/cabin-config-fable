import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { expectNoAxeViolations, open3D, openMap, openVisit, scene, selectLocation, waitFor3D } from "./helpers.ts";

// Runs in the desktop, mobile and dark projects: every view is checked in light, at phone width and in the dark theme.

const CUSHION_7C = { locationId: "SEAT:7C", componentId: "CUSHION", selection: "PRIMARY", quantity: 1 };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("cabin-kit.hint.3d", "dismissed"));
});

/** A token's value on <html>, a short hex (the build minifies #ffffff to #fff) written out in full. */
async function rootToken(page: Page, name: string): Promise<string> {
  const value = await page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
  return /^#[0-9a-f]{3}$/i.test(value) ? `#${[...value.slice(1)].map((c) => c + c).join("")}` : value;
}

const dark = (projectName: string) => projectName === "dark";

test.describe("axe: zero WCAG 2.1 A and AA violations of any impact", () => {
  for (const [label, hash, ready] of [
    ["check", "#/check", "input[name=tail]"],
    ["preparation", "#/prep?tail=N100TL&date=2026-11-12", "#prep-table tbody tr"],
    ["layouts", "#/layouts", "table"],
    ["reference", "#/reference", ".findings"],
  ] as const) {
    test(`on ${label}`, async ({ page }) => {
      await page.goto(`/${hash}`);
      await expect(page.locator(ready).first()).toBeVisible();
      await expectNoAxeViolations(page);
    });
  }

  test("on visits, with a draft and a completed visit listed", async ({ page, api, visit }) => {
    const done = await api.createVisit("N100TL", "2026-11-12", "Axe Tech");
    await api.addRecord(done.id, CUSHION_7C);
    await api.complete(done.id);
    await page.goto(`/#/visits`);
    await expect(page.locator("tbody tr", { hasText: "Axe Tech" })).toBeVisible();
    await expect(page.locator(`tbody a[href='#/visit/${visit.id}']`)).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("on visit (3D)", async ({ page, api, visit }) => {
    await api.addRecord(visit.id, CUSHION_7C);
    await openVisit(page, visit.id);
    await waitFor3D(page);
    await expectNoAxeViolations(page);
  });

  test("on visit (map) with a selected location and its record form", async ({ page, visit }) => {
    await openVisit(page, visit.id);
    await openMap(page);
    await selectLocation(page, "Full cabin floor");
    await expectNoAxeViolations(page);
  });

  test("on visit with the completion dialog open", async ({ page, api, visit }) => {
    await api.addRecord(visit.id, CUSHION_7C);
    await openVisit(page, visit.id);
    await page.getByRole("button", { name: "Complete visit…" }).click();
    await expect(page.locator("dialog.confirm[open]")).toBeVisible();
    await expectNoAxeViolations(page);
  });

  // The visual check's states (VAC-15). Problems carry from visit to visit on a tail, so the ones that save problems use
  // tails no other spec makes visits on.
  test("on visit with the problem form open, its meaning and outcomes shown", async ({ page, visit }) => {
    await openVisit(page, visit.id);
    await openMap(page);
    await selectLocation(page, "Seat 12A");
    const headrest = page.locator(".component-card[data-component=HEADREST]");
    await headrest.getByRole("button", { name: "Defer", exact: true }).click();
    await page.locator(".problem-form").getByRole("radio", { name: "Stained" }).check();
    await expect(page.locator(".problem-form .meaning")).toBeVisible();
    await expect(page.locator(".problem-form").getByRole("radiogroup", { name: "Reason" })).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("on visit with the carried-over panel, a blocked seat and problem badges on the map", async ({ page, api }) => {
    const earlier = await api.createVisit("N020TL", "2026-11-12", "Axe Tech");
    const defer = { note: "", outcome: "DEFERRED", deferUntil: "NEXT_CHECK", reason: "NO_STOCK" };
    for (const observation of [
      { ...defer, locationId: "SEAT:14C", componentId: "SEATBELT", condition: "BROKEN" },
      { ...defer, locationId: "SEAT:12A", componentId: "HEADREST", condition: "STAINED" },
      { ...defer, locationId: "BIN:L-04", componentId: "BIN_LATCH", condition: "WONT_LATCH" },
    ]) {
      expect((await api.call("POST", `/api/visits/${earlier.id}/observations`, { observation })).status).toBe(201);
    }
    await api.complete(earlier.id);
    const later = await api.createVisit("N020TL", "2026-11-14");
    await openVisit(page, later.id);
    await expect(page.locator("#carried-h")).toHaveText("Carried over (3)");
    await openMap(page);
    await expect(page.locator(".cell", { has: page.locator("button[data-seat='14C']") })).toContainText("Blocked");
    await selectLocation(page, "Seat 14C");
    await expectNoAxeViolations(page);
  });

  test("on visit with a bin open in 3D", async ({ page, visit }) => {
    await openVisit(page, visit.id);
    await waitFor3D(page);
    await openMap(page);
    // a bin piece opens its bin
    await page.locator("#goto-input").fill("L-04 latch");
    await page.locator("#goto-input").press("Enter");
    await expect(page.locator("#inspector-heading")).toHaveText(/^Overhead bin L-04/);
    await open3D(page);
    await expect(page.getByRole("button", { name: "Close bin" })).toBeVisible();
    await page.waitForFunction(() => window.__cabinKit?.scene?.describeScene().openBin === "BIN:L-04");
    await expectNoAxeViolations(page);
  });

  test("on an after-action report (schema 3) with deferred, must-fix and noted problems and a hold", async ({ page, api }) => {
    const done = await api.createVisit("N030TL", "2026-11-12", "Axe Tech");
    await api.addRecord(done.id, CUSHION_7C);
    for (const observation of [
      { locationId: "SEAT:12A", componentId: "HEADREST", condition: "STAINED", note: "Coffee", outcome: "NOTED" },
      { locationId: "SEAT:14C", componentId: "SEATBELT", condition: "BROKEN", note: "", outcome: "DEFERRED", deferUntil: "NEXT_CHECK", reason: "NO_STOCK" },
      { locationId: "BIN:L-04", componentId: "BIN_DOOR", condition: "WONT_LATCH", note: "", outcome: "MUST_FIX" },
    ]) {
      expect((await api.call("POST", `/api/visits/${done.id}/observations`, { observation })).status).toBe(201);
    }
    expect((await api.call("POST", `/api/visits/${done.id}/complete`, { confirm: true, aircraftHeld: true })).status).toBe(200);
    await page.goto(`/#/visit/${done.id}/report`);
    await expect(page.locator("#r-summary ~ .must-fix")).toHaveText("Not releasable: aircraft held");
    await expect(page.locator(".report .cabin-map button.loc.problem")).toHaveCount(3);
    await expect(page.locator("section[aria-labelledby=r-timeline] li")).toHaveCount(5);
    await expectNoAxeViolations(page);
  });

  test("on report", async ({ page, api, visit }) => {
    await api.addRecord(visit.id, CUSHION_7C);
    await api.complete(visit.id);
    await page.goto(`/#/visit/${visit.id}/report`);
    await expect(page.locator("#totals-table")).toBeVisible();
    // the cabin picture (a read-only map) loads after the report: scan it too
    await expect(page.locator(".report .cabin-map button[data-seat='7C']")).toBeVisible();
    await expectNoAxeViolations(page);
  });
});

test("screen-reader oriented structure: landmarks, headings, labels, live regions", async ({ page, api, visit }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "structure is the same in every project");
  await api.addRecord(visit.id, CUSHION_7C);
  await openVisit(page, visit.id);
  await openMap(page);
  await selectLocation(page, "Full cabin floor");
  const facts = await page.evaluate(() => ({
    landmarks: ["header", "nav", "main", "footer"].map((t) => document.querySelectorAll(t).length),
    h1: document.querySelectorAll("h1").length,
    unlabeled: Array.from(document.querySelectorAll("input, select, textarea, button")).filter((el) => {
      const e = el as HTMLElement;
      const label =
        e.getAttribute("aria-label") ||
        e.getAttribute("aria-labelledby") ||
        (e.id && document.querySelector(`label[for="${e.id}"]`)) ||
        e.closest("label") ||
        (e.tagName === "BUTTON" && e.textContent?.trim());
      return !label;
    }).length,
    tabs: Array.from(document.querySelectorAll("[role=tab]")).map((t) => t.getAttribute("aria-selected")),
    live: document.querySelectorAll("[role=status], [role=alert], [aria-live]").length,
    seatLabel: document.querySelector("button[data-seat='7C']")?.getAttribute("aria-label") ?? "",
    lang: document.documentElement.lang,
  }));
  expect(facts.landmarks, "one header, nav, main and footer").toEqual([1, 1, 1, 1]);
  expect([facts.h1, facts.unlabeled, facts.lang], "one h1, no unlabeled controls, lang set").toEqual([1, 0, "en"]);
  expect(facts.tabs, "tab state exposed").toEqual(["false", "true"]);
  expect(facts.live, "live regions present").toBeGreaterThanOrEqual(4);
  expect(facts.seatLabel).toContain("Seat 7C");
  expect(facts.seatLabel, "the seat label carries its state").toContain("recorded");
  await open3D(page);
  const canvas = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    return {
      tabindex: c?.getAttribute("tabindex"),
      role: c?.getAttribute("role"),
      keys: document.getElementById(c?.getAttribute("aria-describedby") ?? "")?.textContent ?? "",
    };
  });
  expect(canvas.tabindex, "the canvas is focusable").toBe("0");
  expect(canvas.role).toBe("application");
  expect(canvas.keys, "its description points keyboard users to the map").toContain("Map and list");
});

test.describe("colour theme", () => {
  test("the system dark setting applies the dark tokens, the 3D view follows, and print stays light", async ({ page, visit }, testInfo) => {
    test.skip(!dark(testInfo.project.name), "runs in the dark project");
    await page.goto("/#/check");
    await expect(page.locator("input[name=tail]")).toBeVisible();
    expect(await rootToken(page, "--surface-0")).toBe("#10131c");
    await openVisit(page, visit.id);
    await waitFor3D(page);
    expect(await rootToken(page, "--scene-bg")).toBe("#1b2030");
    expect((await scene(page)).background, "the scene background is --scene-bg").toBe("#1b2030");
    expect(((await scene(page)).statusColours as Record<string, string>).deferred, "the problem colours are the dark ones too").toBe("#ff9d45");
    await page.emulateMedia({ media: "print" });
    expect([await rootToken(page, "--surface-1"), await rootToken(page, "--text-body")], "light tokens in print").toEqual(["#ffffff", "#141a2e"]);
  });

  test("the header's theme control chooses light over a dark system, with no axe violations", async ({ page }, testInfo) => {
    test.skip(!dark(testInfo.project.name), "runs in the dark project");
    await page.goto("/#/check");
    await expect(page.locator("input[name=tail]")).toBeVisible();
    await page.getByRole("group", { name: "Colour theme" }).getByRole("button", { name: "Light" }).click();
    expect(await rootToken(page, "--surface-0"), "light tokens").toBe("#f3f4f7");
    await expectNoAxeViolations(page);
    await page.getByRole("group", { name: "Colour theme" }).getByRole("button", { name: "System" }).click();
    expect(await rootToken(page, "--surface-0"), "dark again").toBe("#10131c");
  });

  test("the header's theme control chooses dark over a light system, keeps it, and the 3D view follows", async ({ page, visit }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "needs a light system setting");
    await openVisit(page, visit.id);
    await waitFor3D(page);
    expect((await scene(page)).background, "light scene background").toBe("#eef0f4");
    const theme = page.getByRole("group", { name: "Colour theme" });
    await theme.getByRole("button", { name: "Dark" }).click();
    expect(await page.evaluate(() => [document.documentElement.dataset.theme, localStorage.getItem("cabin-kit.theme")]), "chosen and kept").toEqual([
      "dark",
      "dark",
    ]);
    expect(await rootToken(page, "--surface-0")).toBe("#10131c");
    await page.waitForFunction(() => window.__cabinKit?.scene?.describeScene().background === "#1b2030");
    await page.reload();
    await expect(page.locator("#work-h")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dataset.theme), "the choice survives a reload").toBe("dark");
    await expect(theme.getByRole("button", { name: "Dark" }), "Dark shows as pressed after a reload").toHaveAttribute("aria-pressed", "true");
    await theme.getByRole("button", { name: "System" }).click();
    expect(await page.evaluate(() => [document.documentElement.hasAttribute("data-theme"), localStorage.getItem("cabin-kit.theme")]), "System forgets").toEqual(
      [false, null],
    );
    expect(await rootToken(page, "--surface-0"), "back to light under a light system setting").toBe("#f3f4f7");
  });
});
