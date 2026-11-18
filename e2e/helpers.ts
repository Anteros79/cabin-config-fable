import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import budgets from "../budgets.json" with { type: "json" };

/** The six part/unit totals of the README walk-through (N100TL: seat 3A cushion, full-cabin carpet alternate). */
export const SIX: [string, number, string][] = [
  ["FAKE-CK-2000", 1, "KIT"],
  ["FAKE-P-39", 2, "PANEL"],
  ["FAKE-P-40", 2, "PANEL"],
  ["FAKE-P-41", 1, "PANEL"],
  ["FAKE-P-42", 1, "PANEL"],
  ["FAKE-SC-1001", 1, "EA"],
];

/** Scene budgets for the 176-seat layout (PF-21), from budgets.json: the one source for every budget (Task 6.5). */
export const SCENE_BUDGET_176 = { drawCalls: budgets.scene.drawCalls176, triangles: budgets.scene.triangles176 };

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Types into "Go to location" (the map tab), presses Enter and waits for the inspector heading of that label. The heading
 * must start with the label, so an earlier selection whose heading merely contains it ("Seat 12A" for "Seat 2A") never counts.
 */
export async function selectLocation(page: Page, label: string): Promise<void> {
  await page.locator("#goto-input").fill(label);
  await page.locator("#goto-input").press("Enter");
  // level 3 is the location heading; each piece's level-4 heading also starts with the location label
  await expect(page.locator(".inspector").getByRole("heading", { level: 3, name: new RegExp(`^${escapeRegExp(label)}`, "i") })).toBeVisible();
}

/** The inspector shows this location (its heading starts with the label). */
export async function expectInspector(page: Page, label: string): Promise<void> {
  await expect(page.locator("#inspector-heading")).toHaveText(new RegExp(`^${escapeRegExp(label)}`));
}

/** Sets the check date without typing keystrokes, so the result never depends on the locale's date order. (Plain /date/i also matches the tail field, whose suggestions mention dates.) */
export async function setDate(page: Page, iso: string): Promise<void> {
  await page.getByLabel(/check date/i).fill(iso);
}

const NO_HOOKS = "test hooks missing (not the e2e build?)";

/** The scene's own description (e2e build only). */
export async function scene(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate((noHooks) => {
    if (!window.__cabinKit) throw new Error(noHooks);
    return window.__cabinKit.scene?.describeScene() ?? {};
  }, NO_HOOKS);
}

/** Lets the page draw `count` animation frames. A frame is the unit of change in the scene, so this is no fixed delay. */
export async function nextFrames(page: Page, count = 2): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((res) => {
        let left = n;
        const step = () => (--left <= 0 ? res() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    count,
  );
}

/**
 * Wait until the scene has a layout and has drawn everything asked of it. Frames are drawn on demand (WEB-20), so require a
 * built layout, at least one drawn frame and none pending.
 */
export async function waitFor3D(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = window.__cabinKit?.scene;
    if (document.querySelector("canvas[data-ready='true']") === null || !s) return false;
    const info = s.describeScene() as { seats?: number; floorAreas?: number; binModules?: number; framePending?: boolean };
    return (info.seats ?? 0) + (info.floorAreas ?? 0) + (info.binModules ?? 0) > 0 && s.frameCount >= 1 && info.framePending === false;
  });
}

/**
 * Let the scene come to rest: a resize or click has been seen (two frames), then no camera transition, no ghosting fade
 * and no frame pending. Once frames stop, the damping has settled.
 */
export async function settle(page: Page): Promise<void> {
  await nextFrames(page, 2);
  if (!(await page.evaluate(() => window.__cabinKit !== undefined))) throw new Error(NO_HOOKS);
  await page.waitForFunction(() => {
    const info = window.__cabinKit?.scene?.describeScene() as { transitioning?: boolean; ghostFading?: boolean; framePending?: boolean } | undefined;
    return !info || (!info.transitioning && !info.ghostFading && info.framePending === false);
  });
}

/** Holds still for a gesture's duration (a long press). This is the input itself, not a wait for the page. */
export async function holdFor(page: Page, ms: number): Promise<void> {
  await page.evaluate((t) => new Promise((res) => setTimeout(res, t)), ms);
}

export async function openMap(page: Page): Promise<void> {
  await page.locator("#tab-map").click();
  await expect(page.locator(".cabin-map")).toBeVisible();
}

export async function open3D(page: Page): Promise<void> {
  await page.locator("#tab-3d").click();
  await waitFor3D(page);
}

/** The six nudge buttons live in the toolbar's "Move camera" disclosure (Task 5.8); open it if it is closed. */
export async function openMoveCamera(page: Page, how: "click" | "tap" = "click"): Promise<void> {
  const button = page.locator(".toolbar button.disclosure", { hasText: "Move camera" });
  if ((await button.getAttribute("aria-expanded")) !== "true") await (how === "tap" ? button.tap() : button.click());
}

/** Runs a lookup from the check page and returns the state it shows. */
export async function lookup(page: Page, tail: string, date: string): Promise<string> {
  const card = page.locator(".status-card[data-state]");
  const before = (await card.count()) ? await card.getAttribute("data-seq") : "none";
  await page.locator("input[name=tail]").fill(tail);
  await setDate(page, date);
  await page.locator("form.lookup-form button[type=submit]").click();
  await expect(card).not.toHaveAttribute("data-seq", before ?? "none");
  return (await card.getAttribute("data-state")) ?? "";
}

/** Opens the check page, looks up and starts a visit through the UI; returns the visit id. */
export async function startVisitUi(page: Page, tail: string, date: string, technician = ""): Promise<string> {
  await page.goto("/#/check");
  await expect(page.locator("input[name=tail]")).toBeVisible();
  if (technician) await page.locator("input[name=technician]").fill(technician);
  expect(["RESOLVED", "PARTIAL"]).toContain(await lookup(page, tail, date));
  await page.getByRole("button", { name: "Start visit (saves a draft)" }).click();
  await expect(page).toHaveURL(/#\/visit\/[0-9a-f-]{36}$/);
  await expect(page.locator("#work-h")).toBeVisible();
  return page.evaluate(() => location.hash.split("/")[2] ?? "");
}

/** Opens a visit and waits for its work list. */
export async function openVisit(page: Page, visitId: string): Promise<void> {
  await page.goto(`/#/visit/${visitId}`);
  await expect(page.locator("#work-h")).toBeVisible();
}

export async function recordPrimary(page: Page, component: string): Promise<void> {
  const card = page.locator(`.component-card[data-component=${component}]`);
  await card.locator("button[type=submit]").click();
  await expect(card.locator(".save-state.saved")).toBeVisible();
}

/** Reach an element with the Tab key alone, proving it is in the keyboard order. */
export async function tabTo(page: Page, selector: string, max = 400): Promise<void> {
  for (let i = 0; i < max; i++) {
    const focused = await page.evaluate((sel) => {
      const el = document.activeElement;
      return el !== null && el !== document.body && el.matches(sel);
    }, selector);
    if (focused) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`could not reach ${selector} with Tab`);
}

/** Puts the canvas in the middle of the window and presses and releases the mouse on a location. */
export async function clickLocation(page: Page, locationId: string, part: "head" | "pan" = "head"): Promise<void> {
  await page.evaluate(() => document.querySelector("canvas")?.scrollIntoView({ block: "center" }));
  await settle(page);
  const point = await page.evaluate(([id, p]) => window.__cabinKit?.scene?.screenPointOf(id, p) ?? null, [locationId, part] as const);
  if (!point) throw new Error(`no screen point for ${locationId}`);
  await pressAt(page, point);
}

/**
 * A click as the pick gesture sees it. The pointer moves first and the scene draws the hover that move causes; only then
 * are the press and the release sent, back to back, so no frame's work lands between them. On a slow software renderer
 * (SwiftShader in CI) that keeps the press inside the pick window (600 ms).
 */
export async function pressAt(page: Page, point: { x: number; y: number }): Promise<void> {
  await page.mouse.move(point.x, point.y);
  await settle(page);
  await page.mouse.down();
  await page.mouse.up();
}

export async function setCamera(page: Page, view: string, locationId?: string): Promise<void> {
  await page.evaluate(([v, i]) => window.__cabinKit?.scene?.setCamera(v as never, i ?? undefined), [view, locationId ?? null] as const);
  await settle(page);
}

/** Calls a scene setter (setLayers, setProfile, ...) by name. */
export async function sceneCall(page: Page, method: string, arg: unknown): Promise<void> {
  await page.evaluate(
    ([f, a]) => {
      const s = window.__cabinKit?.scene as unknown as Record<string, ((x: unknown) => void) | undefined> | undefined;
      const fn = s?.[f];
      if (!s || !fn) throw new Error(`scene has no method ${f}`);
      fn.call(s, a);
    },
    [method, arg] as const,
  );
}

/** Camera position and target, for comparing a camera before and after something that must not move it. */
export async function cameraOf(page: Page): Promise<number[]> {
  const c = (await scene(page)).camera as { position: number[]; target: number[] };
  return [...c.position, ...c.target];
}

export function drift(a: number[], b: number[]): number {
  return Math.max(...a.map((v, i) => Math.abs(v - (b[i] ?? Number.NaN))));
}

export function expectSameCamera(actual: number[], expected: number[], when: string): void {
  expect(drift(actual, expected), `camera moved ${when}: ${JSON.stringify(expected)} -> ${JSON.stringify(actual)}`).toBeLessThan(0.02);
}

export async function canvasIsPainted(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return false;
    const probe = document.createElement("canvas");
    probe.width = 64;
    probe.height = 64;
    const g = probe.getContext("2d");
    if (!g) return false;
    g.drawImage(canvas, 0, 0, 64, 64);
    const data = g.getImageData(0, 0, 64, 64).data;
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      const [r = 0, gr = 0, b = 0] = data.subarray(i, i + 3);
      seen.add((r >> 4) * 256 + (gr >> 4) * 16 + (b >> 4));
    }
    return seen.size > 12; // many distinct colours: a rendered scene, not a blank surface
  });
}

/** axe with WCAG 2.1 A and AA rules, every impact: zero violations. */
export async function expectNoAxeViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const found = result.violations.map((v) => `${v.id} [${v.impact}] (${v.nodes.length}): ${v.nodes[0]?.html ?? ""}`);
  expect(found, `axe violations on ${page.url()}`).toEqual([]);
}

/** The text of a PDF, one string per document. */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    parts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  return parts.join("\n");
}

export const flat = (s: string) => s.replace(/\s+/g, "");

/** The totals table of a report page as [part, quantity, unit] rows. */
export async function totalsOnPage(page: Page): Promise<[string, number, string][]> {
  return page
    .locator("#totals-table tbody tr")
    .evaluateAll((trs) =>
      trs.map((tr): [string, number, string] => [tr.getAttribute("data-part") ?? "", Number(tr.getAttribute("data-qty")), tr.getAttribute("data-unit") ?? ""]),
    );
}
