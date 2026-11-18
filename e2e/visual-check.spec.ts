import type { Locator, Page } from "@playwright/test";
import * as THREE from "three";
import { HEADREST_TINT_OPACITY } from "../src/web/scene/materials.ts";
import { test as base, expect } from "./fixtures.ts";
import {
  clickLocation,
  expectInspector,
  openMap,
  openVisit,
  pressAt,
  recordPrimary,
  scene,
  setCamera,
  settle,
  startVisitUi,
  tabTo,
  waitFor3D,
} from "./helpers.ts";
import { startServer, type TestServer } from "./server.ts";

// The visual appearance check end to end (VAC-15), desktop project. Problems carry from visit to visit on a tail, so this
// file has a server of its own: what it leaves open never reaches another spec's visits. The worker fixture is overridden
// here, which also gives these tests workers of their own.
const test = base.extend<Record<never, never>, { server: TestServer }>({
  server: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from this destructuring pattern
    async ({}, use) => {
      const server = await startServer();
      await use(server);
      await server.dispose();
    },
    { scope: "worker" },
  ],
});

test.beforeEach(async ({ page }) => {
  // the first-use hint would sit over the canvas
  await page.addInitScript(() => localStorage.setItem("cabin-kit.hint.3d", "dismissed"));
});

const card = (page: Page, component: string): Locator => page.locator(`.component-card[data-component=${component}]`);
const problemForm = (page: Page): Locator => page.locator(".problem-form");

/** Chooses the options of the open problem form by their labels, then saves it and waits for the form to close. */
async function saveProblem(page: Page, choices: string[]): Promise<void> {
  const form = problemForm(page);
  for (const label of choices) await form.getByRole("radio", { name: label, exact: true }).check();
  await form.getByRole("button", { name: "Save problem" }).click();
  await expect(form).toHaveCount(0);
}

/** Completes the open visit from its work list; with a must-fix problem open, the hold must be ticked first. */
async function completeVisit(page: Page, hold = false): Promise<void> {
  await page.getByRole("button", { name: "Complete visit…" }).click();
  const dialog = page.locator("dialog.confirm[open]");
  await expect(dialog).toBeVisible();
  if (hold) {
    const confirm = dialog.getByRole("button", { name: "Complete check" });
    await expect(confirm, "no completion without the hold").toBeDisabled();
    await dialog.getByRole("checkbox", { name: "Aircraft held, reported to maintenance" }).check();
    await confirm.click();
  } else {
    await dialog.getByRole("button", { name: "Confirm completion" }).click();
  }
  await expect(page.getByRole("button", { name: "Complete visit…" })).toHaveCount(0);
}

async function openReport(page: Page, visitId: string): Promise<void> {
  await page.goto(`/#/visit/${visitId}/report`);
  await expect(page.locator("#r-summary")).toBeVisible();
}

/** A summary fact of the report by its term. */
const fact = (page: Page, term: string): Locator => page.locator(`section[aria-labelledby=r-summary] dt:text-is("${term}") + dd`);

test.describe("N100TL: a deferral found in 3D, carried to the next check and closed there", () => {
  // one check after another on the same tail: in order, in one worker, and a failure skips the rest
  test.describe.configure({ mode: "serial" });
  let first = "";

  test("tap 12A's headrest in 3D, defer it as Stained until the next check for No stock: the inspector and the map show it deferred", async ({ page }) => {
    first = await startVisitUi(page, "N100TL", "2026-11-12");
    await waitFor3D(page);
    await setCamera(page, "focus", "SEAT:12A");
    // a real click on the canvas, where the scene draws 12A's headrest
    await clickLocation(page, "SEAT:12A", "head");
    await expectInspector(page, "Seat 12A");
    await expect(card(page, "HEADREST"), "the headrest picks the headrest cover").toHaveClass(/highlighted/);
    await card(page, "HEADREST").getByRole("button", { name: "Defer", exact: true }).click();
    await expect(problemForm(page).locator("legend")).toHaveText("Defer a problem");
    await saveProblem(page, ["Stained", "Defer", "Until the next check", "No stock on hand"]);
    await expect(card(page, "HEADREST").locator(".problems")).toContainText("Stained: Deferred. Until the next check, No stock on hand.");

    await openMap(page);
    const seat = page.locator("button[data-seat='12A']");
    await expect(seat, "the seat names its status").toHaveAttribute("aria-label", /Deferred/);
    await expect(seat).toHaveClass(/problem/);
    await expect(seat.locator(".status-glyph"), "the deferred glyph on the seat").toHaveAttribute("data-glyph", "pause");
    const pieces = page.getByRole("region", { name: "Pieces at Seat 12A" });
    await expect(pieces.locator("button.piece[data-component=HEADREST] .badge-text"), "the piece row says Deferred").toHaveText("Deferred");
    // the work list logs the problem with the replacements (R41): its piece, condition and status word
    const work = page.locator("section[aria-labelledby=work-h]");
    await expect(work.locator("#work-h")).toHaveText("Recorded work (1)");
    const row = work.locator("li", { hasText: "Seat 12A / Headrest cover" });
    await expect(row).toContainText("Stained");
    await expect(row.locator(".badge-text"), "the work list says Deferred").toHaveText("Deferred");
    await expect(work).not.toContainText("Nothing recorded yet");
  });

  test("open bin L-04, select the latch, choose Won't latch: MEL item category C with a fix-by date, and defer it", async ({ page }) => {
    await openVisit(page, first);
    await waitFor3D(page);
    await setCamera(page, "focus", "BIN:L-04");
    // a tap on the shut bin opens it; inside it the latch is a piece of its own
    await clickLocation(page, "BIN:L-04");
    await expectInspector(page, "Overhead bin L-04");
    await settle(page);
    expect((await scene(page)).openBin, "the bin is open").toBe("BIN:L-04");
    const latch = await page.evaluate(() => window.__cabinKit?.scene?.screenPointOfPiece("BIN:L-04", "BIN_LATCH") ?? null);
    if (!latch) throw new Error("no screen point for the latch of BIN:L-04");
    await pressAt(page, latch);
    await expect(card(page, "BIN_LATCH")).toHaveClass(/highlighted/);
    await card(page, "BIN_LATCH").getByRole("button", { name: "Note a problem" }).click();
    await problemForm(page).getByRole("radio", { name: "Won't latch" }).check();
    const meaning = problemForm(page).locator(".meaning");
    await expect(meaning).toContainText("MEL item FX-25-31-01 (category C, fix within 10 days): Bin empty, locked and placarded INOP");
    await expect(meaning).toContainText("Fix by 22 Nov 2026");
    await saveProblem(page, ["Defer", "Until the next check", "No stock on hand"]);
    await expect(card(page, "BIN_LATCH").locator(".problems")).toContainText(
      "Won't latch: Deferred. Until the next check, No stock on hand. Fix by 22 Nov 2026.",
    );
  });

  test("complete the check: the report counts 2 deferred, colours 2 places in the cabin picture and lists both in order", async ({ page }) => {
    await openVisit(page, first);
    await completeVisit(page);
    await openReport(page, first);
    await expect(page.locator("section[aria-labelledby=r-summary] .must-fix"), "nothing must be fixed").toHaveCount(0);
    await expect(fact(page, "Deferred, cosmetic")).toHaveText("1");
    await expect(fact(page, "Deferred under the MEL")).toHaveText("1");
    await expect(fact(page, "Must be fixed")).toHaveText("0");
    await expect(fact(page, "Releasable")).toHaveText("Yes");
    await expect(page.locator("section[aria-labelledby=r-deferred] li")).toHaveCount(2);
    // the cabin picture: exactly the two places with a problem are coloured, each as deferred
    const picture = page.locator("section[aria-labelledby=r-picture] .cabin-map");
    await expect(picture.locator("button[data-seat='12A']")).toBeVisible();
    await expect(picture.locator("button.loc.problem")).toHaveCount(2);
    await expect(picture.locator("button[data-seat='12A']")).toHaveClass(/problem/);
    await expect(picture.locator("button[data-location='BIN:L-04']")).toHaveClass(/problem/);
    await expect(picture.locator("button.loc.problem .status-glyph[data-glyph=pause]")).toHaveCount(2);
    // the timeline: the two problems in the order they were found, then the completion
    await expect(page.locator("section[aria-labelledby=r-timeline] li")).toHaveText([
      /Seat 12A · Headrest cover: .*\(Stained\)$/,
      /Overhead bin L-04 .* · Bin latch and release button: .*\(Won't latch\)$/,
      /Visit completed$/,
    ]);
  });

  test("a new visit on N100TL carries both over; the headrest is marked replaced after a replacement is recorded", async ({ page }) => {
    await startVisitUi(page, "N100TL", "2026-11-14");
    const carried = page.locator("section[aria-labelledby=carried-h]");
    await expect(carried.locator("#carried-h")).toHaveText("Carried over (2)");
    await expect(carried.locator("li")).toHaveText([
      /Seat 12A \/ Headrest cover.*Stained · Deferred.*From the check on 12 Nov 2026/s,
      /Overhead bin L-04 .*Bin latch.*Won't latch · Deferred · Fix by 22 Nov 2026.*From the check on 12 Nov 2026/s,
    ]);
    await carried.getByRole("button", { name: "Show Seat 12A Headrest cover" }).click();
    await expectInspector(page, "Seat 12A");
    const headrest = card(page, "HEADREST");
    await expect(headrest).toHaveClass(/highlighted/);
    // the check that opened it, by its check date (R42)
    await expect(headrest.locator(".problems")).toContainText("Carried over from the check on 12 Nov 2026");
    const replaced = headrest.getByRole("button", { name: "Mark replaced" });
    await expect(replaced, "a replacement must be recorded first").toBeDisabled();
    await recordPrimary(page, "HEADREST");
    await replaced.click();
    await expect(headrest.locator(".problems")).toHaveCount(0);
    await expect(carried.locator("li", { hasText: "Headrest cover" })).toHaveCount(0);
    await expect(carried.locator("li", { hasText: "Bin latch" }), "the latch stays open").toHaveCount(1);
  });
});

test("N200TL V05 → V04: a bin assist deferral from the earlier configuration is listed under No longer at this position", async ({ page, api }) => {
  // seeded through the API on a V05 date (V05 until 30 Jun 2026); bin L-02 is a pivot bin with an assist there
  const before = await api.createVisit("N200TL", "2026-06-15", "Seed");
  const observation = {
    locationId: "BIN:L-02",
    componentId: "BIN_ASSIST",
    condition: "BROKEN",
    note: "Damper weak",
    outcome: "DEFERRED",
    deferUntil: "NEXT_CHECK",
    reason: "NO_STOCK",
  };
  const added = await api.call("POST", `/api/visits/${before.id}/observations`, { observation, idempotencyKey: "vac15-n200tl-assist" });
  expect(added.status).toBe(201);
  await api.complete(before.id);

  // a later date gives V04, where that bin has no assist at that position
  await startVisitUi(page, "N200TL", "2026-07-02");
  await expect(page.locator(".config")).toContainText("V04");
  const carried = page.locator("section[aria-labelledby=carried-h]");
  await expect(carried.getByRole("heading", { name: "No longer at this position" })).toBeVisible();
  const item = carried.locator("li", { hasText: "Bin assist spring and damper" });
  await expect(item).toContainText("Overhead bin L-02 (rows 3-5, 4 bags) / Bin assist spring and damper");
  await expect(item).toContainText("Broken · Deferred · Fix by 13 Oct 2026");
  // it is not on this layout, so it has no Show; it can only be marked fixed
  await expect(item.getByRole("button", { name: /^Show/ })).toHaveCount(0);
  await expect(item.getByRole("button", { name: /^Mark fixed/ })).toBeVisible();
});

test("a life vest picked in 3D with Under seat on and marked Missing can only be fixed; completing needs the hold, and the report says Not releasable", async ({
  page,
}) => {
  const visitId = await startVisitUi(page, "N010TL", "2026-11-12");
  await waitFor3D(page);
  const underSeat = page.getByRole("group", { name: "Layers" }).getByRole("button", { name: "Under seat" });
  await underSeat.click();
  await expect(underSeat).toHaveAttribute("aria-pressed", "true");
  // the cutaway view looks in under the seats from the side; the focus views look down over the pans
  await page.evaluate(() => document.querySelector("canvas")?.scrollIntoView({ block: "center" }));
  await setCamera(page, "cutaway");
  // a real click on a point of 12A's life vest that a pick reaches
  const vest = await page.evaluate(() => window.__cabinKit?.scene?.screenPointOfPiece("SEAT:12A", "LIFE_VEST") ?? null);
  expect(vest, "a point on 12A's life vest that a click reaches").not.toBeNull();
  await pressAt(page, vest as { x: number; y: number });
  await expectInspector(page, "Seat 12A");
  const lifeVest = card(page, "LIFE_VEST");
  await expect(lifeVest, "the click picks the life vest").toHaveClass(/highlighted/);

  await lifeVest.getByRole("button", { name: "Note a problem" }).click();
  await problemForm(page).getByRole("radio", { name: "Missing" }).check();
  // no seat is blocked: a missing vest is no-go, and the one outcome offered is Must be fixed
  await expect(problemForm(page).locator(".meaning")).toContainText("No-go: must be fixed before flight");
  const outcomes = problemForm(page).getByRole("radiogroup", { name: "Outcome" }).getByRole("radio");
  await expect(outcomes).toHaveCount(1);
  await expect(outcomes.first()).toHaveAccessibleName("Must be fixed before flight");
  await expect(outcomes.first()).toBeChecked();
  await saveProblem(page, []);
  await expect(lifeVest.locator(".problems")).toContainText("Missing: Must be fixed.");

  await completeVisit(page, true);
  await openReport(page, visitId);
  await expect(page.locator("section[aria-labelledby=r-summary] .must-fix")).toHaveText("Not releasable: aircraft held");
  await expect(fact(page, "Aircraft held")).toHaveText("Yes");
  await expect(page.locator("section[aria-labelledby=r-mustfix] li")).toContainText("Seat 12A · Life vest (under the seat)");
});

test("keyboard only: Go to location 12A life vest, then record a problem without touching the canvas", async ({ page }) => {
  await startVisitUi(page, "N030TL", "2026-11-12");
  await waitFor3D(page);
  // from here on, keys only: the map tab, the go-to field, the piece's buttons and the problem form
  await page.locator("#tab-3d").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#tab-map")).toBeFocused();
  await expect(page.locator(".cabin-map")).toBeVisible();
  await tabTo(page, "#goto-input");
  await page.keyboard.type("12A life vest");
  await page.keyboard.press("Enter");
  await expectInspector(page, "Seat 12A");
  const lifeVest = card(page, "LIFE_VEST");
  await expect(lifeVest).toHaveClass(/highlighted/);
  await tabToButton(page, ".component-card[data-component=LIFE_VEST] .piece-actions button", "Note a problem");
  await page.keyboard.press("Enter");
  await expect(problemForm(page)).toBeVisible();
  await tabTo(page, ".problem-form input[type=radio][value=TORN]");
  await page.keyboard.press("Space");
  await tabTo(page, ".problem-form input[type=radio][value=NOTED]");
  await page.keyboard.press("Space");
  await tabTo(page, ".problem-form button[type=submit]");
  await page.keyboard.press("Enter");
  await expect(problemForm(page)).toHaveCount(0);
  await expect(lifeVest.locator(".problems")).toContainText("Torn: Noted.");
  expect(await page.evaluate(() => document.activeElement?.tagName), "the canvas never took focus").not.toBe("CANVAS");
  // the map shows it too
  await expect(page.locator("button[data-seat='12A']")).toHaveAttribute("aria-label", /Noted/);
});

/** Tab to the button among `selector` whose text is `name`. */
async function tabToButton(page: Page, selector: string, name: string, max = 400): Promise<void> {
  for (let i = 0; i < max; i++) {
    const found = await page.evaluate(
      ([sel, text]) => {
        const el = document.activeElement;
        return el instanceof HTMLElement && el.matches(sel) && el.textContent?.trim() === text;
      },
      [selector, name] as const,
    );
    if (found) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`could not reach "${name}" with Tab`);
}

test("the problem colours follow the page theme in 3D: a deferred headrest is repainted in the dark value", async ({ page, api }) => {
  const visit = await api.createVisit("N090TL", "2026-11-12");
  const observation = {
    locationId: "SEAT:12A",
    componentId: "HEADREST",
    condition: "STAINED",
    note: "",
    outcome: "DEFERRED",
    deferUntil: "NEXT_CHECK",
    reason: "NO_STOCK",
  };
  expect((await api.call("POST", `/api/visits/${visit.id}/observations`, { observation })).status).toBe(201);
  await openVisit(page, visit.id);
  await waitFor3D(page);
  const colours = async () => (await scene(page)).statusColours as Record<string, string>;
  const applied = async () => ((await scene(page)).updates as { applyStates: number }).applyStates;
  // 12A's headrest tint as the scene paints it: linear RGB and opacity, from the piece's own attribute
  const headrestTint = () =>
    page.evaluate(() => {
      const s = window.__cabinKit?.scene as unknown as { pieces: { part: string; locations: { id: string }[]; tint: { array: Float32Array } | null }[] };
      const piece = s.pieces.find((p) => p.part === "headrest");
      const i = piece?.locations.findIndex((l) => l.id === "SEAT:12A") ?? -1;
      const a = piece?.tint?.array;
      return a && i >= 0 ? [a[i * 4], a[i * 4 + 1], a[i * 4 + 2], a[i * 4 + 3]].map((v) => Number(v?.toFixed(4))) : null;
    });
  const tintOf = (hex: string) => {
    const c = new THREE.Color(hex);
    return [c.r, c.g, c.b, HEADREST_TINT_OPACITY].map((v) => Number(Math.fround(v).toFixed(4)));
  };
  expect(await colours(), "light: the light --scene-status-* values").toEqual({
    mustFix: "#e00b75",
    deferred: "#d26203",
    carried: "#9a10ff",
    noted: "#0f6cb4",
    blocked: "#8791a8",
  });
  expect(await headrestTint(), "the deferred headrest in the light value").toEqual(tintOf("#d26203"));
  const before = await applied();
  await page.getByRole("group", { name: "Colour theme" }).getByRole("button", { name: "Dark" }).click();
  await expect.poll(colours, { message: "dark: the dark values" }).toEqual({
    mustFix: "#ff6bb0",
    deferred: "#ff9d45",
    carried: "#b090e0",
    noted: "#90d0f0",
    blocked: "#7a84a0",
  });
  expect(await applied(), "the states were repainted").toBeGreaterThan(before);
  expect(await headrestTint(), "the deferred headrest in the dark value").toEqual(tintOf("#ff9d45"));
  // bin doors: halfway from white toward the status colour, in the theme's value
  const door = new THREE.Color("#ff9d45").lerp(new THREE.Color("#ffffff"), 0.5);
  expect(((await scene(page)).binDoorColours as Record<string, string>).deferred).toBe(`#${door.getHexString()}`);
  await page.getByRole("group", { name: "Colour theme" }).getByRole("button", { name: "System" }).click();
  await expect.poll(async () => (await colours()).deferred, { message: "back to light" }).toBe("#d26203");
});
