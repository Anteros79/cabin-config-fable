import type { Page } from "@playwright/test";
import { HEADREST_TINT_OPACITY, STATUS_COLOUR } from "../src/web/scene/materials.ts";
import { expect, test } from "./fixtures.ts";
import {
  cameraOf,
  canvasIsPainted,
  clickLocation,
  drift,
  expectInspector,
  expectSameCamera,
  holdFor,
  nextFrames,
  open3D,
  openMap,
  openMoveCamera,
  openVisit,
  pressAt,
  recordPrimary,
  SCENE_BUDGET_176,
  scene,
  sceneCall,
  selectLocation,
  setCamera,
  settle,
  waitFor3D,
} from "./helpers.ts";

const CUSHION_7C = { locationId: "SEAT:7C", componentId: "CUSHION", selection: "PRIMARY", quantity: 1 };
const ALL_LAYERS_NO_CONTEXT = { seats: true, floor: true, bins: true, underSeat: false, context: false };

/** Opens the visit on the 3D tab with the scene at rest. The first-use hint is dismissed (it has its own test). */
async function openScene(page: Page, visitId: string): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("cabin-kit.hint.3d", "dismissed"));
  await openVisit(page, visitId);
  await waitFor3D(page);
  await settle(page);
}

const toolbarButton = (page: Page, name: string) => page.locator(".toolbar button", { hasText: name }).first();

async function pressPreset(page: Page, name: string): Promise<void> {
  await toolbarButton(page, name).click();
  await settle(page);
}

const reducedMotionProject = (projectName: string) => projectName === "reduced-motion";

test("genuine WebGL scene with one instance per seat, floor area and bin module", async ({ page, visit }) => {
  await openScene(page, visit.id);
  const info = await scene(page);
  expect([info.seats, info.floorAreas, info.binModules]).toEqual([176, 3, 22]);
  expect(await canvasIsPainted(page), "the canvas is painted").toBe(true);
  const gl = await page.evaluate(() => {
    const c = document.createElement("canvas");
    const g = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
    return g ? String(g.getParameter(g.VERSION)) : null;
  });
  expect(gl, "a WebGL context is available").toMatch(/WebGL/);
});

/**
 * The status set of the measured worst case (Task 5.4/5.6 reports): every floor location tinted (FWD unresolved, MID
 * alternate, AFT recorded, FULL-CABIN alternate), recorded, unresolved and alternate seats, recorded and unresolved bins,
 * and the mixed seat 7C (cushion recorded, backrest unresolved). A real visit on the 176-seat layout has no unresolved or
 * seat-alternate state, so those are layered over the visit's own states through the scene's setStates().
 */
const WORST_CASE_EXTRA: Record<string, Record<string, string>> = {
  "FLOOR:FWD": { CARPET_PANEL: "unresolved" },
  "FLOOR:MID": { CARPET_PANEL: "alternate" },
  "SEAT:7C": { BACKREST: "unresolved" },
  "SEAT:12A": { BACKREST: "unresolved" },
  "SEAT:12B": { CUSHION: "unresolved" },
  "SEAT:15D": { CUSHION: "alternate" },
  "SEAT:16E": { BACKREST: "alternate" },
  "BIN:L-01": { BIN_DOOR: "unresolved" },
};

/** Layers a status set over the visit's own states through the scene's setStates() (the e2e build's test hooks). */
async function injectStates(page: Page, extra: Record<string, Record<string, string>>): Promise<void> {
  await page.evaluate((add) => {
    const s = window.__cabinKit?.scene as unknown as
      | { states: Map<string, { components: Record<string, string> }>; setStates(m: Map<string, { components: Record<string, string> }>): void }
      | undefined;
    if (!s) throw new Error("test hooks missing (not the e2e build?)");
    const next = new Map(s.states);
    for (const [id, components] of Object.entries(add)) next.set(id, { components: { ...(next.get(id)?.components ?? {}), ...components } });
    s.setStates(next);
  }, extra);
}

/** Hovers a location: the first point of a grid over the canvas that hovers one, so the hover outline is drawn too. */
async function hoverALocation(page: Page): Promise<string | null> {
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  for (const fy of [0.5, 0.35, 0.65]) {
    for (const fx of [0.3, 0.5, 0.7, 0.15, 0.85]) {
      const x = box.x + box.width * fx;
      const y = box.y + box.height * fy;
      await page.mouse.move(x, y);
      await page.mouse.move(x + 2, y + 2);
      await nextFrames(page, 2);
      const hover = ((await scene(page)).marks as { hover: string | null }).hover;
      if (hover !== null) return hover;
    }
  }
  return null;
}

/**
 * Draws the 176-seat layout in every preset, with and without the context layer and with every other layer on (the
 * life vests under the seats too), with `states` layered on, the selection outlined and a location hovered, and asserts
 * the draw calls and triangles of each view against budgets.json (PF-21).
 * `check` asserts the status set is in place in each view.
 */
async function expectWithinSceneBudget(page: Page, states: Record<string, Record<string, string>>, check: (where: string) => Promise<void>): Promise<void> {
  const seen: string[] = [];
  let worst = { drawCalls: 0, triangles: 0, at: "" };
  for (const context of [false, true]) {
    await sceneCall(page, "setLayers", { ...ALL_LAYERS_NO_CONTEXT, underSeat: true, context });
    for (const view of ["cutaway", "overhead", "aisle", "carpet", "bins"]) {
      await setCamera(page, view);
      await page.evaluate(() => document.querySelector("canvas")?.scrollIntoView({ block: "center" }));
      await settle(page);
      await injectStates(page, states);
      const hover = await hoverALocation(page);
      // force one frame so renderer.info describes this view with everything above in it
      await page.evaluate(() => window.__cabinKit?.scene?.invalidate());
      await settle(page);
      const info = await scene(page);
      const marks = info.marks as { selection: boolean; hover: string | null };
      const where = `${view}${context ? "+context" : ""}`;
      expect(info.colourMode, `${where}: status colours on`).toBe("status");
      expect(marks.selection, `${where}: the selection is outlined`).toBe(true);
      expect(hover, `${where}: a location is hovered`).not.toBeNull();
      expect(marks.hover, `${where}: the hover outline is drawn`).not.toBeNull();
      await check(where);
      const { drawCalls, triangles } = info.renderer as { drawCalls: number; triangles: number };
      seen.push(`${where} (hover ${hover}): ${drawCalls} calls, ${triangles} triangles`);
      if (drawCalls > worst.drawCalls || (drawCalls === worst.drawCalls && triangles > worst.triangles)) worst = { drawCalls, triangles, at: where };
      expect(drawCalls, `${where} draw calls`).toBeLessThanOrEqual(SCENE_BUDGET_176.drawCalls);
      expect(triangles, `${where} triangles`).toBeLessThanOrEqual(SCENE_BUDGET_176.triangles);
    }
  }
  test.info().annotations.push({ type: "scene worst case", description: `${worst.at}: ${worst.drawCalls} calls, ${worst.triangles} triangles` });
  test.info().annotations.push({ type: "scene cost", description: seen.join("; ") });
}

/** Opens the visit's scene with seat 7C selected (chosen on the map, so the selection outline is drawn). */
async function openSceneWith7CSelected(page: Page, visitId: string): Promise<void> {
  await openScene(page, visitId);
  await openMap(page);
  await selectLocation(page, "Seat 7C");
  await open3D(page);
}

test("the 176-seat layout stays within the draw-call and triangle budgets in every preset, in the worst case (PF-21)", async ({ page, api, visit }) => {
  const record = (locationId: string, componentId: string, selection = "PRIMARY", quantity = 1) =>
    api.addRecord(visit.id, { locationId, componentId, selection, quantity });
  await record("SEAT:7C", "CUSHION");
  await record("SEAT:3A", "CUSHION");
  await record("SEAT:20F", "BACKREST");
  await record("FLOOR:AFT", "CARPET_PANEL");
  await record("BIN:R-03", "BIN_DOOR");
  await openSceneWith7CSelected(page, visit.id);
  const statusOf = () =>
    page.evaluate(() => {
      const s = window.__cabinKit?.scene as unknown as { states: Map<string, { components: Record<string, string> }> };
      return Object.fromEntries(["FLOOR:FWD", "FLOOR:MID", "FLOOR:AFT", "FLOOR:FULL-CABIN", "SEAT:7C"].map((id) => [id, s.states.get(id)?.components ?? {}]));
    });
  await expectWithinSceneBudget(page, WORST_CASE_EXTRA, async (where) => {
    expect(await statusOf(), `${where}: every floor location tinted, 7C mixed`).toEqual({
      "FLOOR:FWD": { CARPET_PANEL: "unresolved" },
      "FLOOR:MID": { CARPET_PANEL: "alternate" },
      "FLOOR:AFT": { CARPET_PANEL: "recorded" },
      "FLOOR:FULL-CABIN": { CARPET_KIT: "alternate" },
      "SEAT:7C": { CUSHION: "recorded", BACKREST: "unresolved" },
    });
  });
});

test("the 176-seat layout stays within the budgets when every location carries a status, as on a completed visit (PF-21)", async ({ page, visit }) => {
  await openSceneWith7CSelected(page, visit.id);
  // every piece of every seat, armrest, floor area, the full-cabin floor and every bin module, the statuses in turn
  const statuses = ["recorded", "unresolved", "alternate", "mustFix", "deferred", "carried", "noted"];
  const locations = await page.evaluate(() => {
    const s = window.__cabinKit?.scene as unknown as { layout: { locations: { id: string; componentIds: string[] }[] } };
    return s.layout.locations.map((l) => ({ id: l.id, componentIds: l.componentIds }));
  });
  expect(locations.length, "176 seats, 240 armrests, 4 floor locations and 22 bin modules").toBe(442);
  let n = 0;
  const every = Object.fromEntries(
    locations.map((l) => [l.id, Object.fromEntries(l.componentIds.map((c) => [c, statuses[n++ % statuses.length] ?? "recorded"]))]),
  );
  await expectWithinSceneBudget(page, every, async (where) => {
    const marks = (await scene(page)).marks as { badges: number };
    // 176 seats + 240 armrests + 4 floor locations + 22 bin modules
    expect(marks.badges, `${where}: a badge on every location`).toBe(442);
  });
});

test("each piece's tint attribute carries that piece's status colour at 0.6, and nothing in the other colour modes (WEB-20)", async ({ page, visit }) => {
  await openScene(page, visit.id);
  const statuses = { "SEAT:7C": "recorded", "SEAT:12A": "unresolved", "SEAT:15D": "mustFix" } as const;
  await injectStates(page, Object.fromEntries(Object.entries(statuses).map(([id, s]) => [id, { HEADREST: s }])));
  // 12A's tray is drawn on the back of 11A and tinted there; 12A's cushion carries no status
  await injectStates(page, { "SEAT:12A": { TRAY: "deferred" } });
  // the scene's own per-instance attribute of one seat part, read through the e2e build's hook, by owning location
  const tints = (part: string) =>
    page.evaluate((wanted) => {
      const s = window.__cabinKit?.scene as unknown as { pieces: { part: string; locations: { id: string }[]; tint: { array: Float32Array } | null }[] };
      const piece = s.pieces.find((p) => p.part === wanted);
      if (!piece?.tint) throw new Error(`no tint attribute on ${wanted}`);
      const a = piece.tint.array;
      return Object.fromEntries(piece.locations.map((l, i) => [l.id, [a[i * 4], a[i * 4 + 1], a[i * 4 + 2], a[i * 4 + 3]] as number[]]));
    }, part);
  const expected = (status: keyof typeof STATUS_COLOUR) =>
    [STATUS_COLOUR[status].r, STATUS_COLOUR[status].g, STATUS_COLOUR[status].b, HEADREST_TINT_OPACITY].map((v) => Number(Math.fround(v).toFixed(5)));
  const inStatusMode = await tints("headrest");
  expect(Object.keys(inStatusMode)).toHaveLength(176);
  for (const [id, status] of Object.entries(statuses)) {
    expect(
      (inStatusMode[id] ?? []).map((v) => Number(v?.toFixed(5))),
      `${id} ${status}`,
    ).toEqual(expected(status));
  }
  const untinted = Object.entries(inStatusMode).filter(([id]) => !(id in statuses));
  expect(untinted.length).toBe(173);
  expect(
    untinted.filter(([, t]) => t[3] !== 0).map(([id]) => id),
    "a seat with no headrest status has no headrest tint",
  ).toEqual([]);
  expect(
    (await tints("tray"))["SEAT:12A"]?.map((v) => Number(v?.toFixed(5))),
    "12A's tray, on the back of 11A",
  ).toEqual(expected("deferred"));
  expect((await tints("pan"))["SEAT:12A"]?.[3], "a piece with no status is not tinted").toBe(0);
  for (const mode of ["tier", "none"]) {
    await sceneCall(page, "setColourMode", mode);
    await settle(page);
    const tinted = Object.entries(await tints("headrest"))
      .filter(([, t]) => t[3] !== 0)
      .map(([id]) => id);
    expect(tinted, `no headrest is tinted in the ${mode} colour mode`).toEqual([]);
  }
  await sceneCall(page, "setColourMode", "status");
  await settle(page);
  expect((await tints("headrest"))["SEAT:12A"]?.[3], "the tint comes back in the status mode").toBeCloseTo(HEADREST_TINT_OPACITY, 5);
});

test("spatial picking selects the exact seat and its component", async ({ page, visit }) => {
  await openScene(page, visit.id);
  await setCamera(page, "focus", "SEAT:7C");
  await clickLocation(page, "SEAT:7C", "head");
  await expectInspector(page, "Seat 7C");
  // clicking the headrest of 7C focuses HEADREST, not BACKREST
  await expect(page.locator(".component-card[data-component=HEADREST].highlighted"), "the headrest picks the headrest cover").toHaveCount(1);
  await expect(page.locator(".component-card[data-component=BACKREST].highlighted")).toHaveCount(0);
  expect((await scene(page)).selection).toBe("SEAT:7C");
  // neighbours resolve to their own identities
  await clickLocation(page, "SEAT:7B", "head");
  await expectInspector(page, "Seat 7B");
  // from above the seat pan is exposed: picking it targets the cushion of exactly that seat
  await setCamera(page, "overhead");
  await clickLocation(page, "SEAT:7C", "pan");
  await expectInspector(page, "Seat 7C");
  await expect(page.locator(".component-card[data-component=CUSHION].highlighted"), "the pan picks the cushion").toHaveCount(1);
});

test("an armrest pad picks the armrest location; the Under seat layer starts off", async ({ page, visit }) => {
  await openScene(page, visit.id);
  await setCamera(page, "focus", "ARMREST:12-C");
  await clickLocation(page, "ARMREST:12-C");
  await expectInspector(page, "Armrest at the aisle, 12C");
  expect((await scene(page)).selection).toBe("ARMREST:12-C");
  await expect(page.getByRole("group", { name: "Layers" }).getByRole("button", { name: "Under seat" })).toHaveAttribute("aria-pressed", "false");
  expect(((await scene(page)).layers as { underSeat: boolean }).underSeat).toBe(false);
});

test("selection, recorded and unresolved states stay in sync across 3D, map, inspector and work list", async ({ page, visit }) => {
  await openScene(page, visit.id);
  await setCamera(page, "focus", "SEAT:7C");
  await clickLocation(page, "SEAT:7C", "pan");
  await expectInspector(page, "Seat 7C");
  await settle(page);
  const before = (await scene(page)).updates as { buildLayout: number; applyProfile: number; applyStates: number };
  await recordPrimary(page, "CUSHION");
  await settle(page);
  // a recorded replacement repaints the states once; it never rebuilds the layout or re-applies the profile (Task 5.2)
  const after = (await scene(page)).updates as typeof before;
  expect(after).toEqual({ buildLayout: before.buildLayout, applyProfile: before.applyProfile, applyStates: before.applyStates + 1 });
  const states = await page.evaluate(() => {
    const s = window.__cabinKit?.scene as unknown as { states: Map<string, { components: Record<string, string> }> } | undefined;
    return s?.states.get("SEAT:7C")?.components ?? null;
  });
  expect(states).toEqual({ CUSHION: "recorded" });
  await expect(page.locator(".viewer-counts")).toContainText("1 recorded");
  await expect(page.locator(".worklist")).toContainText("Seat 7C");
  await openMap(page);
  await expect(page.locator("button[data-seat='7C']")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("button[data-seat='7C']")).toHaveClass(/recorded/);
  await page.locator("button[data-seat='9D']").click();
  await open3D(page);
  expect((await scene(page)).selection, "the map selection is carried into 3D").toBe("SEAT:9D");
});

test("selection and hover are outlined, status is a badge, and the hover label follows the pointer (WEB-21)", async ({ page, api, visit }) => {
  await api.addRecord(visit.id, CUSHION_7C);
  await openScene(page, visit.id);
  await openMap(page);
  await selectLocation(page, "Seat 9D");
  await open3D(page);
  await setCamera(page, "cutaway");
  const marks = (await scene(page)).marks as { selection: boolean; hover: string | null; badges: number };
  expect(marks.selection, "the selected seat is outlined").toBe(true);
  expect(marks.badges, "a badge for the recorded seat").toBeGreaterThanOrEqual(1);
  expect(await page.locator(".legend li[data-status] svg[aria-hidden=true]").count(), "a legend glyph for each status").toBeGreaterThanOrEqual(3);
  await page.evaluate(() => document.querySelector("canvas")?.scrollIntoView({ block: "center" }));
  await settle(page);
  const pt = await page.evaluate(() => window.__cabinKit?.scene?.screenPointOf("SEAT:14C") ?? null);
  if (!pt) throw new Error("no point for 14C");
  await page.mouse.move(pt.x, pt.y);
  await expect(page.locator(".hover-label")).toBeVisible();
  await expect.poll(async () => ((await scene(page)).marks as { hover: string | null }).hover, { message: "hover outline under the pointer" }).toBe("SEAT:14C");
  // the piece is named with its seat, and only that piece is outlined
  await expect(page.locator(".hover-label")).toHaveText("14C · Headrest cover");
  expect(((await scene(page)).marks as { hoverPart: string | null }).hoverPart).toBe("headrest");
  const label = await page.locator(".hover-label").boundingBox();
  const wrap = await page.locator(".canvas-wrap").boundingBox();
  if (!label || !wrap) throw new Error("no label or canvas box");
  expect(Math.abs(label.x - (pt.x + 14)) <= 1 || label.x + label.width <= pt.x, `label beside the pointer (label x ${label.x}, pointer x ${pt.x})`).toBe(true);
  expect(
    label.x >= wrap.x && label.x + label.width <= wrap.x + wrap.width && label.y >= wrap.y && label.y + label.height <= wrap.y + wrap.height,
    "label inside the canvas",
  ).toBe(true);
  await expect(page.locator(".hover-label")).toHaveAttribute("aria-hidden", "true");
  await page.mouse.move(wrap.x + 2, wrap.y + wrap.height - 2);
  await page.mouse.move(0, 0);
  await expect(page.locator(".hover-label")).toHaveCount(0);
});

test("floor areas and bin modules are pickable in 3D", async ({ page, visit }) => {
  await openScene(page, visit.id);
  await setCamera(page, "overhead");
  await sceneCall(page, "setLayers", { seats: false, floor: true, bins: false, underSeat: false, context: false });
  await clickLocation(page, "FLOOR:MID");
  await expectInspector(page, "Mid floor area");
  await sceneCall(page, "setLayers", ALL_LAYERS_NO_CONTEXT);
  await setCamera(page, "focus", "BIN:R-03");
  await clickLocation(page, "BIN:R-03");
  await expectInspector(page, "Overhead bin R-03");
  await expect(page.locator(".component-card[data-component=BIN_DOOR]")).toContainText("FAKE-V01-BIN-R-03");
});

test("open a bin, select the latch: the inspector shows Bin latch and release button; draw calls stay within budget with a bin open (VAC-11)", async ({
  page,
  visit,
}) => {
  await openScene(page, visit.id);
  await setCamera(page, "focus", "BIN:L-04");
  // a tap on the closed bin opens it and selects its door
  await clickLocation(page, "BIN:L-04");
  await expectInspector(page, "Overhead bin L-04");
  await settle(page);
  expect((await scene(page)).openBin, "the bin is open").toBe("BIN:L-04");
  await expect(page.locator(".component-card[data-component=BIN_DOOR].highlighted")).toBeVisible();
  await expect(page.getByRole("button", { name: "Close bin" })).toBeVisible();
  // the latch inside it is a piece of its own
  const latch = await page.evaluate(() => window.__cabinKit?.scene?.screenPointOfPiece("BIN:L-04", "BIN_LATCH") ?? null);
  if (!latch) throw new Error("no screen point for the latch of BIN:L-04");
  await pressAt(page, latch);
  const card = page.locator(".component-card[data-component=BIN_LATCH].highlighted");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Bin latch and release button");
  // Escape on the view closes it again
  await page.locator("canvas").focus();
  await page.keyboard.press("Escape");
  await settle(page);
  expect((await scene(page)).openBin, "Escape closed the bin").toBeNull();
  await expect(page.getByRole("button", { name: "Close bin" })).toHaveCount(0);

  // every location with a status, 7C selected, and bin L-04 open: still within budgets.json in every preset
  await openMap(page);
  await selectLocation(page, "Seat 7C");
  await open3D(page);
  await sceneCall(page, "openBin", "BIN:L-04");
  await settle(page);
  const statuses = ["recorded", "unresolved", "alternate", "mustFix", "deferred", "carried", "noted"];
  const locations = await page.evaluate(() => {
    const s = window.__cabinKit?.scene as unknown as { layout: { locations: { id: string; componentIds: string[] }[] } };
    return s.layout.locations.map((l) => ({ id: l.id, componentIds: l.componentIds }));
  });
  let n = 0;
  const every = Object.fromEntries(
    locations.map((l) => [l.id, Object.fromEntries(l.componentIds.map((c) => [c, statuses[n++ % statuses.length] ?? "recorded"]))]),
  );
  await expectWithinSceneBudget(page, every, async (where) => {
    const info = await scene(page);
    expect(info.openBin, `${where}: the bin is open`).toBe("BIN:L-04");
    // the open bin's pieces are tinted instead of its badge: every other location keeps one
    const marks = info.marks as { badges: number; binMarkers: number };
    expect(marks.badges, `${where}: a badge on every other location`).toBe(441);
    // and a coloured marker on the face of every other bin: 22 modules, one open
    expect(marks.binMarkers, `${where}: a marker on every shut bin`).toBe(21);
  });
});

test("in an outside view only the near side's bins are ghosted: each side has its own materials (VAC-11)", async ({ page, visit }) => {
  await openScene(page, visit.id);
  // the cutaway looks in from the left (+z): the left bins are ghosted, the right ones solid
  await setCamera(page, "cutaway");
  const ghost = (await scene(page)).binGhost as Record<"L" | "R", { transparent: boolean; opacity: number; bodyOpacity: number }>;
  expect(ghost.L, "the near side is ghosted").toEqual({ transparent: true, opacity: expect.closeTo(0.16, 5), bodyOpacity: expect.closeTo(0.16, 5) });
  expect(ghost.R, "the far side is solid").toEqual({ transparent: false, opacity: 1, bodyOpacity: 1 });
  // and picking agrees with the look: only the solid side's bins are pick targets
  expect(ghost.L.transparent).not.toBe(ghost.R.transparent);
});

test("a new layout reports the open bin closed: the Close bin button goes (VAC-11)", async ({ page, visit }) => {
  await openScene(page, visit.id);
  await sceneCall(page, "openBin", "BIN:L-04");
  await settle(page);
  expect((await scene(page)).openBin).toBe("BIN:L-04");
  await expect(page.getByRole("button", { name: "Close bin" })).toBeVisible();
  // another revision of the layout: the scene rebuilds, and the bin it had open is gone with it
  await page.evaluate(() => {
    const s = window.__cabinKit?.scene as unknown as { layout: { id: string }; setLayout(layout: unknown, pickable: boolean): void };
    s.setLayout({ ...s.layout, id: `${s.layout.id}-other` }, true);
  });
  await settle(page);
  expect((await scene(page)).openBin, "no bin open on the new layout").toBeNull();
  await expect(page.getByRole("button", { name: "Close bin" })).toHaveCount(0);
});

test("a hidden layer never blocks a pick: the seat behind a hidden bin is selected", async ({ page, visit }) => {
  await openScene(page, visit.id);
  const layer = (name: string) => page.getByRole("group", { name: "Layers" }).getByRole("button", { name });
  // Framed on the mid floor area, bin R-03 covers the headrest of seat 8F under it.
  await setCamera(page, "focus", "FLOOR:MID");
  await page.evaluate(() => document.querySelector("canvas")?.scrollIntoView({ block: "center" }));
  await settle(page);
  const point = await page.evaluate(() => window.__cabinKit?.scene?.screenPointOf("SEAT:8F", "head") ?? null);
  if (!point) throw new Error("no point for SEAT:8F");
  await pressAt(page, point);
  await expectInspector(page, "Overhead bin R-03");
  await layer("Bins").click();
  await settle(page);
  expect(((await scene(page)).layers as { bins: boolean }).bins, "bins layer hidden").toBe(false);
  // the same click now reaches the seat behind where the bin was
  await pressAt(page, point);
  await expect(page.locator("#inspector-heading")).toHaveText("Seat 8F");
  expect((await scene(page)).selection).toBe("SEAT:8F");
  await layer("Bins").click();
  // with seats hidden the floor under them is reachable
  await setCamera(page, "focus", "SEAT:20C");
  await layer("Seats").click();
  await settle(page);
  await clickLocation(page, "SEAT:20C", "pan");
  await expect(page.locator("#inspector-heading")).toContainText("floor area");
});

test("camera buttons, orbit, pan and zoom change the view; reset restores it", async ({ page, visit }) => {
  await openScene(page, visit.id);
  // rounded to 5 cm: damping settles asymptotically
  const position = async () => {
    const c = (await scene(page)).camera as { position: number[]; target: number[]; fov: number };
    return JSON.stringify([...c.position, ...c.target].map((v) => Math.round(v * 20) / 20).concat(c.fov));
  };
  await pressPreset(page, "Reset");
  const home = await position();
  for (const label of ["Overhead", "Aisle", "Cutaway"]) {
    await pressPreset(page, label);
    expect((await scene(page)).view).toBe(label.toLowerCase());
  }
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 160, cy + 40, { steps: 6 });
  await page.mouse.up();
  await settle(page);
  const orbited = await position();
  expect(orbited, "drag orbits").not.toBe(home);
  // the wheel zooms while the view has focus
  await page.locator("canvas").focus();
  await page.mouse.wheel(0, -600);
  await settle(page);
  const zoomed = await position();
  expect(zoomed, "wheel zooms").not.toBe(orbited);
  const targetOf = async () => JSON.stringify(((await scene(page)).camera as { target: number[] }).target.map((v) => Math.round(v * 20) / 20));
  const targetBefore = await targetOf();
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(cx - 120, cy - 30, { steps: 6 });
  await page.mouse.up({ button: "right" });
  await settle(page);
  expect(await targetOf(), "right-drag pans the target").not.toBe(targetBefore);
  const panned = await position();
  await page.locator("canvas").focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("+");
  await settle(page);
  expect(await position(), "keyboard orbits and zooms the canvas").not.toBe(panned);
  await page.keyboard.press("Home");
  await settle(page);
  expect(await position(), "Home restores the default cutaway").toBe(home);
  await openMoveCamera(page);
  await page.locator(".toolbar button[aria-label='Rotate left']").click();
  await page.locator(".toolbar button[aria-label='Zoom in']").click();
  await settle(page);
  expect(await position(), "camera buttons work").not.toBe(home);
});

test("a camera preset eases along an arc and drawing stops when it arrives; reduced motion, once turned on, cuts (WEB-21, WEB-20)", async ({
  page,
  visit,
}, testInfo) => {
  test.skip(reducedMotionProject(testInfo.project.name), "the glide needs motion; the reduced-motion project has its own test");
  await openScene(page, visit.id);
  await pressPreset(page, "Reset");
  const start = await cameraOf(page);
  // sample the camera on every frame from before the click until the transition has started and ended
  await page.evaluate(() => {
    const w = window as unknown as { __poses: number[][]; __posesDone: boolean };
    w.__poses = [];
    w.__posesDone = false;
    let started = false;
    const step = () => {
      const i = window.__cabinKit?.scene?.describeScene() as { transitioning: boolean; camera: { position: number[]; target: number[] } };
      w.__poses.push([...i.camera.position, ...i.camera.target]);
      if (i.transitioning) started = true;
      if (started && !i.transitioning) w.__posesDone = true;
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  await toolbarButton(page, "Aisle").click();
  await page.waitForFunction(() => (window as unknown as { __posesDone: boolean }).__posesDone);
  await settle(page);
  const end = await cameraOf(page);
  const poses = await page.evaluate(() => (window as unknown as { __poses: number[][] }).__poses);
  expect(
    poses.some((p) => drift(p, start) > 0.05 && drift(p, end) > 0.05),
    "the camera passes through poses between the two presets",
  ).toBe(true);
  const arrived = await scene(page);
  expect([arrived.view, arrived.transitioning, arrived.framePending]).toEqual(["aisle", false, false]);
  // on-demand frames (WEB-20): a still camera draws nothing, however many frames go by
  await nextFrames(page, 20);
  expect((await scene(page)).frames, "no frames drawn once the camera is still").toBe(arrived.frames);
  // prefers-reduced-motion is read when it changes: presets cut and the orbit does not glide
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => window.__cabinKit?.scene?.describeScene().reducedMotion === true);
  expect((await scene(page)).damping, "orbit damping is off with reduced motion").toBe(false);
  await toolbarButton(page, "Overhead").click();
  const cut = await scene(page);
  expect([cut.view, cut.transitioning], "the preset is reached at once").toEqual(["overhead", false]);
  const placed = await cameraOf(page);
  await settle(page);
  expectSameCamera(await cameraOf(page), placed, "with reduced motion");
  await page.emulateMedia({ reducedMotion: null });
  await page.waitForFunction(() => window.__cabinKit?.scene?.describeScene().reducedMotion === false);
  expect((await scene(page)).damping, "damping is back without reduced motion").toBe(true);
});

test("a scene that starts with reduced motion applies a preset within one frame and does not glide (WEB-21)", async ({ page, visit }, testInfo) => {
  test.skip(!reducedMotionProject(testInfo.project.name), "runs in the reduced-motion project");
  await openScene(page, visit.id);
  const info = await scene(page);
  expect([info.reducedMotion, info.damping], "reduced motion read at start").toEqual([true, false]);
  await toolbarButton(page, "Aisle").click();
  const cut = await scene(page);
  expect([cut.view, cut.transitioning], "the preset is reached at once").toEqual(["aisle", false]);
  const placed = await cameraOf(page);
  await nextFrames(page, 1);
  const afterOneFrame = await scene(page);
  expect(afterOneFrame.framePending, "nothing left to draw after one frame").toBe(false);
  expectSameCamera(await cameraOf(page), placed, "after the first frame");
});

test("the wheel scrolls the page past the view until the view has focus, with a hint once; Ctrl or focus zooms (WEB-21)", async ({ page, visit }) => {
  await openScene(page, visit.id);
  await pressPreset(page, "Reset");
  await page.evaluate(() => {
    sessionStorage.removeItem("cabin-kit.wheel-hint-shown");
    window.scrollTo(0, 0);
    (document.activeElement as HTMLElement | null)?.blur();
  });
  const overCanvas = async () => {
    const box = await page.locator("canvas").boundingBox();
    if (!box) throw new Error("no canvas");
    await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 120));
  };
  const home = await cameraOf(page);
  await overCanvas();
  await page.mouse.wheel(0, 240);
  await page.waitForFunction(() => window.scrollY > 0);
  await expect(page.locator(".canvas-hint")).toHaveText("Click the view, then scroll to zoom");
  await settle(page);
  expectSameCamera(await cameraOf(page), home, "by an unfocused wheel");
  expect((await scene(page)).view, "an unfocused wheel keeps the preset").toBe("cutaway");
  await expect(page.locator(".canvas-hint")).toHaveText("", { timeout: 5000 });
  await expect(page.locator(".canvas-hint"), "the hint is a live region that stays in place").toHaveAttribute("role", "status");
  await page.mouse.wheel(0, -240);
  await page.waitForFunction(() => window.scrollY === 0);
  await nextFrames(page, 3);
  await expect(page.locator(".canvas-hint"), "the hint shows at most once per session").toHaveText("");
  // Ctrl and the wheel zoom without focus
  await overCanvas();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -240);
  await page.keyboard.up("Control");
  await settle(page);
  expect(drift(await cameraOf(page), home), "Ctrl and the wheel zoom").toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY), "Ctrl and the wheel do not scroll the page").toBe(0);
  // a focused view zooms
  await pressPreset(page, "Reset");
  await page.locator("canvas").focus();
  await overCanvas();
  await page.mouse.wheel(0, -240);
  await settle(page);
  expect(drift(await cameraOf(page), home), "a focused view zooms").toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY), "a focused view does not scroll the page").toBe(0);
  expect((await scene(page)).view, "a zoom by hand leaves the preset").toBe("free");
});

test("an unmoved preset re-frames on resize, also after a pick, which never moves the camera (WEB-09)", async ({ page, visit }) => {
  await openScene(page, visit.id);
  await pressPreset(page, "Reset");
  const home = await cameraOf(page);
  await page.setViewportSize({ width: 1180, height: 760 });
  await settle(page);
  const refit = await cameraOf(page);
  expect(drift(refit, home), "the preset is fitted to the new shape").toBeGreaterThan(0.05);
  expect((await scene(page)).view, "still the preset after a resize").toBe("cutaway");
  await page.setViewportSize({ width: 1440, height: 900 });
  await settle(page);
  expectSameCamera(await cameraOf(page), home, "back at the first size");
  // a click that picks fires no camera change: the preset stays, and the next resize re-frames it
  await clickLocation(page, "SEAT:14C", "head");
  await expectInspector(page, "Seat 14C");
  await settle(page);
  expectSameCamera(await cameraOf(page), home, "by a pick in the canvas");
  expect((await scene(page)).view, "a pick keeps the preset").toBe("cutaway");
  await page.setViewportSize({ width: 1180, height: 760 });
  await settle(page);
  expectSameCamera(await cameraOf(page), refit, "a picked-in preset is re-framed like an unmoved one");
});

test("a location chosen in the work list while 3D shows is brought into view if it is off to the side", async ({ page, api, visit }) => {
  await api.addRecord(visit.id, CUSHION_7C);
  await openScene(page, visit.id);
  const showSeat7C = page.locator(".worklist button[aria-label^='Show Seat 7C']").first();
  await setCamera(page, "focus", "SEAT:25A");
  await showSeat7C.click();
  await expectInspector(page, "Seat 7C");
  await settle(page);
  const info = await scene(page);
  const target = (info.camera as { target: number[] }).target;
  const seatX = await page.evaluate(() => {
    const s = window.__cabinKit?.scene as unknown as { layout: { locations: { id: string; placement: { x: number } }[] } };
    return s.layout.locations.find((l) => l.id === "SEAT:7C")?.placement.x ?? Number.NaN;
  });
  expect(info.view, "framed on the chosen seat").toBe("focus");
  expect(Math.abs((target[0] ?? 0) - seatX), `the camera looks at seat 7C (target ${JSON.stringify(target)}, seat x ${seatX})`).toBeLessThan(0.5);
  const point = await page.evaluate(() => window.__cabinKit?.scene?.screenPointOf("SEAT:7C", "head") ?? null);
  const box = await page.locator("canvas").boundingBox();
  if (!point || !box) throw new Error("no point or canvas");
  expect(
    Math.abs(point.x - (box.x + box.width / 2)) < box.width * 0.4 && Math.abs(point.y - (box.y + box.height / 2)) < box.height * 0.4,
    "the seat is in the central part of the view",
  ).toBe(true);
  // chosen while already in view: the camera stays
  await pressPreset(page, "Overhead");
  await clickLocation(page, "SEAT:20C", "pan");
  await expectInspector(page, "Seat 20C");
  await settle(page);
  const overhead = await cameraOf(page);
  await showSeat7C.click();
  await expectInspector(page, "Seat 7C");
  await settle(page);
  expectSameCamera(await cameraOf(page), overhead, "for a location already in view");
  expect((await scene(page)).view, "the preset stays").toBe("overhead");
});

test("whole cabin is framed to fill the view", async ({ page, visit }) => {
  await openScene(page, visit.id);
  await pressPreset(page, "Reset");
  const fill = await page.evaluate(() => {
    const s = window.__cabinKit?.scene as unknown as {
      layout: { locations: { id: string; kind: string }[] };
      screenPointOf(id: string): { x: number; y: number };
    };
    const canvas = document.querySelector("canvas");
    if (!canvas) throw new Error("no canvas");
    const rect = canvas.getBoundingClientRect();
    const pts = s.layout.locations.filter((l) => l.kind === "SEAT").map((l) => s.screenPointOf(l.id));
    const xs = pts.map((p) => p.x - rect.left);
    const ys = pts.map((p) => p.y - rect.top);
    const inside = pts.every((p) => p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom);
    return { inside, width: (Math.max(...xs) - Math.min(...xs)) / rect.width, height: (Math.max(...ys) - Math.min(...ys)) / rect.height };
  });
  expect(fill.inside, "every seat is inside the canvas").toBe(true);
  expect(fill.width > 0.7 || fill.height > 0.7, `cabin spans the view (width ${fill.width.toFixed(2)}, height ${fill.height.toFixed(2)})`).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  const visible = await page.evaluate(() => {
    const r = document.querySelector("canvas")?.getBoundingClientRect();
    return { bottom: Math.round(r?.bottom ?? Number.POSITIVE_INFINITY), viewport: window.innerHeight };
  });
  expect(visible.bottom, "the whole 3D view is on screen without scrolling at 1440x900").toBeLessThanOrEqual(visible.viewport);
});

test("lighting, visual family and colour modes switch independently", async ({ page, visit }) => {
  await openScene(page, visit.id);
  await page.locator(".toolbar label", { hasText: "Light" }).locator("select").selectOption("blue");
  await page.locator(".toolbar label", { hasText: "Visual family" }).locator("select").selectOption("concept-gray");
  await page.locator(".toolbar label", { hasText: "Colours" }).locator("select").selectOption("none");
  await settle(page);
  const info = await scene(page);
  expect([info.light, info.profile, info.colourMode, info.seats]).toEqual(["blue", "concept-gray", "none", 176]);
  await expect(page.locator(".viewer3d > .fine")).toContainText("unassigned and illustrative");
});

test("20 visual family switches leave the geometry and texture counts unchanged", async ({ page, visit }) => {
  await openScene(page, visit.id);
  const family = page.locator(".toolbar label", { hasText: "Visual family" }).locator("select");
  const counts = async () => {
    const r = (await scene(page)).renderer as { geometries: number; textures: number };
    return { geometries: r.geometries, textures: r.textures };
  };
  // one round through every family first, so each family's textures have been made once
  const families = await family.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(families.length).toBeGreaterThanOrEqual(2);
  for (const f of families) {
    await family.selectOption(f);
    await settle(page);
  }
  const before = await counts();
  for (let i = 0; i < 20; i++) {
    await family.selectOption(families[i % families.length] ?? "");
    await settle(page);
  }
  await family.selectOption(families[(20 + families.length - 1) % families.length] ?? "");
  await settle(page);
  expect(await counts()).toEqual(before);
});

test("a save, a window resize and a tab switch leave a moved camera, the scene and its settings as they were", async ({ page, visit }) => {
  await openScene(page, visit.id);
  await openMap(page);
  await selectLocation(page, "Seat 8A");
  await open3D(page);
  await page.evaluate(() => {
    (window as unknown as { __e2eScene: unknown }).__e2eScene = window.__cabinKit?.scene;
  });
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  await settle(page);
  const moved = await cameraOf(page);
  // two saves: record the cushion, then remove it again
  await recordPrimary(page, "CUSHION");
  await settle(page);
  expectSameCamera(await cameraOf(page), moved, "after recording a part");
  await page.locator(".component-card[data-component=CUSHION] button.danger").click();
  await expect(page.locator(".worklist")).not.toContainText("Seat 8A");
  await settle(page);
  expectSameCamera(await cameraOf(page), moved, "after removing a part");
  await page.setViewportSize({ width: 1180, height: 760 });
  await settle(page);
  expectSameCamera(await cameraOf(page), moved, "after a window resize");
  expect((await scene(page)).view, "a drag leaves the preset").toBe("free");
  await page.setViewportSize({ width: 1440, height: 900 });
  await settle(page);
  await page.locator(".toolbar label", { hasText: "Light" }).locator("select").selectOption("blue");
  await page.getByRole("group", { name: "Layers" }).getByRole("button", { name: "Context (walls)" }).click();
  await settle(page);
  await openMap(page);
  const hidden = await scene(page);
  expect(hidden.paused, "the hidden scene is paused").toBe(true);
  await nextFrames(page, 10);
  expect((await scene(page)).frames, "a paused scene draws nothing").toBe(hidden.frames);
  await page.locator("#tab-3d").click();
  await page.waitForFunction(() => window.__cabinKit?.scene?.describeScene().paused === false);
  await settle(page);
  const shown = await scene(page);
  expect(shown.frames as number, "the scene draws again when shown").toBeGreaterThan(hidden.frames as number);
  expect(
    await page.evaluate(() => (window as unknown as { __e2eScene: unknown }).__e2eScene === window.__cabinKit?.scene),
    "the same scene instance after a tab switch",
  ).toBe(true);
  expect([shown.light, (shown.layers as { context: boolean }).context], "light and layers kept").toEqual(["blue", true]);
  expectSameCamera(await cameraOf(page), moved, "after a tab switch");
});

test("a right click and a long press never pick; the aisle strip picks the full-cabin floor", async ({ page, visit }) => {
  await openScene(page, visit.id);
  await setCamera(page, "focus", "SEAT:7C");
  await clickLocation(page, "SEAT:7C", "head");
  await expectInspector(page, "Seat 7C");
  const neighbour = await page.evaluate(() => window.__cabinKit?.scene?.screenPointOf("SEAT:7B", "head") ?? null);
  if (!neighbour) throw new Error("no point for 7B");
  await page.mouse.move(neighbour.x, neighbour.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  await page.mouse.down();
  await holdFor(page, 900); // a long press: the hold is the gesture
  await page.mouse.up();
  await nextFrames(page, 3);
  await expect(page.locator("#inspector-heading"), "selection unchanged").toHaveText("Seat 7C");
  expect((await scene(page)).selection).toBe("SEAT:7C");
  await setCamera(page, "overhead");
  await sceneCall(page, "setLayers", { seats: false, floor: true, bins: false, underSeat: false, context: false });
  await settle(page);
  await clickLocation(page, "FLOOR:FULL-CABIN");
  await expectInspector(page, "Full cabin floor");
  await clickLocation(page, "FLOOR:AFT");
  await expectInspector(page, "Aft floor area");
});

test("the first-use hint over the canvas goes after Got it and stays gone after a reload (WEB-21)", async ({ page, visit }) => {
  await openVisit(page, visit.id);
  await waitFor3D(page);
  const hint = page.locator(".first-hint");
  await expect(hint, "hint shown until dismissed").toHaveCount(1);
  await hint.getByRole("button", { name: "Got it" }).click();
  await expect(hint, "Got it removes the hint").toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("cabin-kit.hint.3d")), "the dismissal is remembered").not.toBeNull();
  await page.reload();
  await waitFor3D(page);
  await expect(page.locator(".first-hint"), "not shown again after a reload").toHaveCount(0);
});
