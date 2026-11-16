import type { CDPSession, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import {
  cameraOf,
  canvasIsPainted,
  expectSameCamera,
  lookup,
  nextFrames,
  openMoveCamera,
  openVisit,
  SIX,
  scene,
  setCamera,
  settle,
  totalsOnPage,
  waitFor3D,
} from "./helpers.ts";

// Runs only in the mobile project: 390 × 844, touch, device scale 3.

test.beforeEach(async ({ page }) => {
  // the first-use hint has its own test (scene.spec.ts); here it would cover the canvas
  await page.addInitScript(() => localStorage.setItem("cabin-kit.hint.3d", "dismissed"));
});

const overflowX = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function openScene(page: Page, visitId: string): Promise<void> {
  await openVisit(page, visitId);
  await waitFor3D(page);
  await settle(page);
}

type Point = { x: number; y: number };
const touchPoint = (id: number, p: Point, dx = 0) => ({ x: p.x + dx, y: p.y, id, radiusX: 4, radiusY: 4, force: 1 });

/** A one-finger drag in 12 moves, one per animation frame. */
async function touchDrag(page: Page, cdp: CDPSession, from: Point, to: Point): Promise<void> {
  const at = (t: number) => [touchPoint(1, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(0) });
  for (let i = 1; i <= 12; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(i / 12) });
    await nextFrames(page, 1);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("mobile: lookup and start a visit with no horizontal overflow", async ({ page }) => {
  await page.goto("/#/check");
  await page.locator("input[name=technician]").fill("Mobile Tech");
  expect(await lookup(page, "N100TL", "2026-11-12")).toBe("RESOLVED");
  await page.getByRole("button", { name: "Start visit (saves a draft)" }).tap();
  await expect(page.locator("#work-h")).toBeVisible();
  expect(await overflowX(page), "the page does not overflow horizontally").toBeLessThanOrEqual(1);
});

test("mobile: 3D renders in portrait framing and a tap picks a seat", async ({ page, visit }) => {
  await openScene(page, visit.id);
  expect(await canvasIsPainted(page), "canvas painted").toBe(true);
  await setCamera(page, "focus", "SEAT:6D");
  await page.locator("canvas").scrollIntoViewIfNeeded();
  await settle(page);
  const point = await page.evaluate(() => window.__cabinKit?.scene?.screenPointOf("SEAT:6D", "head") ?? null);
  if (!point) throw new Error("no point for 6D");
  await page.touchscreen.tap(point.x, point.y);
  await expect(page.locator("#inspector-heading")).toHaveText("Seat 6D");
});

test("mobile: Overhead and Cutaway show the whole cabin, also in a tall view", async ({ page, visit }) => {
  await openScene(page, visit.id);
  // the seats whose pan projects outside the canvas: none, when the preset frames the whole cabin
  const seatsOutside = () =>
    page.evaluate(() => {
      const s = window.__cabinKit?.scene as unknown as {
        layout: { locations: { id: string; kind: string }[] };
        screenPointOf(id: string, part?: "head" | "pan"): { x: number; y: number };
      };
      const rect = document.querySelector("canvas")?.getBoundingClientRect();
      if (!rect) throw new Error("no canvas");
      return s.layout.locations
        .filter((l) => l.kind === "SEAT")
        .filter((l) => {
          const p = s.screenPointOf(l.id, "pan");
          return !(p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom);
        })
        .map((l) => l.id);
    });
  for (const [width, height] of [
    [390, 844],
    [390, 1120],
  ] as const) {
    await page.setViewportSize({ width, height });
    await settle(page);
    for (const view of ["overhead", "cutaway"]) {
      await setCamera(page, view);
      expect(await seatsOutside(), `${view} at ${width}x${height}: seats outside the view`).toEqual([]);
    }
  }
});

test("mobile: the end of a two-finger gesture selects nothing and a URL-bar resize keeps a moved camera", async ({ page, visit }) => {
  await openScene(page, visit.id);
  await setCamera(page, "focus", "SEAT:6D");
  await page.locator("canvas").scrollIntoViewIfNeeded();
  await settle(page);
  const sixD = await page.evaluate(() => window.__cabinKit?.scene?.screenPointOf("SEAT:6D", "head") ?? null);
  if (!sixD) throw new Error("no point for 6D");
  await page.touchscreen.tap(sixD.x, sixD.y);
  await expect(page.locator("#inspector-heading")).toHaveText("Seat 6D");
  // From above, every seat pan is a separate target: each finger lands on a seat other than the selected 6D, so a
  // gesture that picked would change the selection.
  await setCamera(page, "overhead");
  await page.locator("canvas").scrollIntoViewIfNeeded();
  await settle(page);
  const point = (id: string) => page.evaluate((seat) => window.__cabinKit?.scene?.screenPointOf(seat, "pan") ?? null, id);
  const other = await point("SEAT:6E");
  const third = await point("SEAT:8B");
  if (!other || !third) throw new Error("no seat points");
  const cdp = await page.context().newCDPSession(page);
  // two fingers down, then lifted one at a time without moving: a pinch held still, then a two-finger tap on one seat
  for (const [a, b] of [
    [touchPoint(1, other), touchPoint(2, third)],
    [touchPoint(1, other), touchPoint(2, other, 3)],
  ] as const) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [a] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [a, b] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [b] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await settle(page);
    await expect(page.locator("#inspector-heading"), "a two-finger gesture selected nothing").toHaveText("Seat 6D");
  }
  await cdp.detach();
  // from the default view, which a resize re-frames, orbit by hand
  await page.locator(".toolbar button", { hasText: "Reset" }).first().tap();
  await openMoveCamera(page, "tap");
  await page.locator(".toolbar button[aria-label='Rotate left']").tap();
  await settle(page);
  const moved = await cameraOf(page);
  // the URL bar showing and collapsing changes the viewport height
  await page.setViewportSize({ width: 390, height: 760 });
  await settle(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  expectSameCamera(await cameraOf(page), moved, "after the viewport height changed");
  expect((await scene(page)).view, "a nudge leaves the preset").toBe("free");
});

test("mobile: a one-finger vertical drag on the view scrolls the page; a sideways drag orbits (WEB-21)", async ({ page, visit }) => {
  await openScene(page, visit.id);
  await page.evaluate(() => document.querySelector("canvas")?.scrollIntoView({ block: "center" }));
  await settle(page);
  const home = await cameraOf(page);
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await touchDrag(page, cdp, { x: cx, y: cy + 90 }, { x: cx, y: cy - 90 });
  await settle(page);
  const scrolled = (await page.evaluate(() => window.scrollY)) - scrollBefore;
  expect(scrolled, "a vertical drag scrolls the page").toBeGreaterThan(40);
  expectSameCamera(await cameraOf(page), home, "by a vertical drag");
  expect((await scene(page)).view, "a vertical drag keeps the preset").toBe("cutaway");
  await expect(page.locator(".inspector #inspector-heading"), "a vertical drag selects nothing").toHaveCount(0);
  // sideways: the view orbits and the page stays
  await page.evaluate(() => document.querySelector("canvas")?.scrollIntoView({ block: "center" }));
  await settle(page);
  const side = await page.locator("canvas").boundingBox();
  if (!side) throw new Error("no canvas");
  const scrollSide = await page.evaluate(() => window.scrollY);
  const y = side.y + side.height / 2;
  await touchDrag(page, cdp, { x: side.x + side.width * 0.25, y }, { x: side.x + side.width * 0.75, y });
  await settle(page);
  expect(JSON.stringify(await cameraOf(page)), "a sideways drag orbits").not.toBe(JSON.stringify(home));
  expect((await scene(page)).view, "a sideways drag leaves the preset").toBe("free");
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrollSide), "a sideways drag does not scroll the page").toBeLessThanOrEqual(2);
  await expect(page.locator(".inspector #inspector-heading"), "a sideways drag selects nothing").toHaveCount(0);
  // a camera moved by touch stays where it is when the URL bar changes the viewport height
  const orbited = await cameraOf(page);
  await page.setViewportSize({ width: 390, height: 760 });
  await settle(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  expectSameCamera(await cameraOf(page), orbited, "after a touch orbit and a viewport resize");
  expect((await scene(page)).view, "still free after the resize").toBe("free");
  await cdp.detach();
});

test("mobile: record through the map with touch-sized targets, complete and read the report", async ({ page, visit }) => {
  await openScene(page, visit.id);
  await page.locator("#tab-map").tap();
  await expect(page.locator(".cabin-map")).toBeVisible();
  const sizes = await page.locator(".cabin-map button[data-seat]").evaluateAll((els) =>
    els.slice(0, 40).map((e) => {
      const r = e.getBoundingClientRect();
      return [r.width, r.height] as [number, number];
    }),
  );
  expect(
    sizes.every(([w, h]) => w >= 36 && h >= 40),
    `seat buttons are touch sized (min ${Math.min(...sizes.map((s) => s[0])).toFixed(0)}x${Math.min(...sizes.map((s) => s[1])).toFixed(0)})`,
  ).toBe(true);
  await page.locator("button[data-seat='3A']").tap();
  await expect(page.locator("#inspector-heading")).toHaveText("Seat 3A");
  await page.locator(".component-card[data-component=CUSHION] button[type=submit]").tap();
  await expect(page.locator(".component-card[data-component=CUSHION] .save-state.saved")).toBeVisible();
  await page.locator("#goto-input").fill("FULL-CABIN");
  await page.locator("#goto-input").press("Enter");
  await expect(page.locator("#inspector-heading")).toHaveText(/^Full cabin floor/);
  await page.locator(".component-card[data-component=CARPET_KIT] input[type=radio][value='FX-SUB-KIT-1']").check();
  await page.locator(".component-card[data-component=CARPET_KIT] button[type=submit]").tap();
  await expect(page.locator(".component-card[data-component=CARPET_KIT] .save-state.saved")).toBeVisible();
  await page.locator(".worklist > button.primary").tap();
  await page.locator(".confirm button.primary").tap();
  await expect(page.locator("#totals-table")).toBeVisible();
  expect(await totalsOnPage(page), "six totals on mobile").toEqual(SIX);
  expect(await overflowX(page), "the report does not overflow horizontally").toBeLessThanOrEqual(1);
});
