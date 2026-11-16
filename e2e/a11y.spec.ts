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

  test("on report", async ({ page, api, visit }) => {
    await api.addRecord(visit.id, CUSHION_7C);
    await api.complete(visit.id);
    await page.goto(`/#/visit/${visit.id}/report`);
    await expect(page.locator("#totals-table")).toBeVisible();
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
