// End-to-end verification against a real server and the installed Google Chrome.
//   node tests/e2e/run.ts            (writes verification/e2e/*)
// Uses disposable stores in a temp directory and a free port. Never touches ./data.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { Report } from "../../src/domain/types.ts";
import { launchBrowser, PROJECT_ROOT, type Server, sceneInfo, settle, startServer, waitFor3D } from "./lib.ts";

const OUT = join(PROJECT_ROOT, "verification", "e2e");
const CAPTURES = join(PROJECT_ROOT, "verification", "captures");
const SAMPLES = join(PROJECT_ROOT, "verification", "samples");
for (const dir of [OUT, CAPTURES, SAMPLES]) mkdirSync(dir, { recursive: true });

interface Result {
  group: string;
  name: string;
  status: "PASS" | "FAIL";
  ms: number;
  detail?: string;
}
const results: Result[] = [];
let group = "";
async function check(name: string, fn: () => Promise<void>): Promise<boolean> {
  const start = Date.now();
  try {
    await fn();
    results.push({ group, name, status: "PASS", ms: Date.now() - start });
    console.log(`  PASS  ${name}`);
    return true;
  } catch (e) {
    const detail = e instanceof Error ? e.message.split("\n").slice(0, 6).join(" | ") : String(e);
    results.push({ group, name, status: "FAIL", ms: Date.now() - start, detail });
    console.log(`  FAIL  ${name}\n        ${detail}`);
    return false;
  }
}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function equal<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const SIX = [
  ["FAKE-CK-2000", 1, "KIT"],
  ["FAKE-P-39", 2, "PANEL"],
  ["FAKE-P-40", 2, "PANEL"],
  ["FAKE-P-41", 1, "PANEL"],
  ["FAKE-P-42", 1, "PANEL"],
  ["FAKE-SC-1001", 1, "EA"],
];

/** Reach an element with the Tab key alone, proving it is in the keyboard order. */
async function tabTo(page: Page, selector: string, max = 140): Promise<void> {
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
async function api<T>(server: Server, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as T };
}
async function pdfText(bytes: Uint8Array): Promise<{ pages: number; text: string }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    parts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  return { pages: doc.numPages, text: parts.join("\n") };
}
const flat = (s: string) => s.replace(/\s+/g, "");
async function lookupUi(page: Page, tail: string, date: string): Promise<string> {
  const before = await page.evaluate(() => document.querySelector(".status-card[data-state]")?.getAttribute("data-seq") ?? "none");
  await page.fill("input[name=tail]", tail);
  await page.fill("input[name=date]", date);
  await page.click("form.lookup-form button[type=submit]");
  await page.waitForFunction((prev) => {
    const card = document.querySelector(".status-card[data-state]");
    return card !== null && card.getAttribute("data-seq") !== prev;
  }, before);
  return (await page.getAttribute(".status-card[data-state]", "data-state")) ?? "";
}
async function startVisitUi(page: Page, tail: string, date: string, technician = ""): Promise<string> {
  await page.goto(`${page.url().split("#")[0]}#/check`);
  await page.waitForSelector("input[name=tail]");
  if (technician) await page.fill("input[name=technician]", technician);
  const state = await lookupUi(page, tail, date);
  expect(state === "RESOLVED" || state === "PARTIAL", `lookup state was ${state}`);
  await page.click("text=Start visit (saves a draft)");
  await page.waitForSelector("#visit-h");
  await page.waitForFunction(() => /#\/visit\/[0-9a-f-]{36}$/.test(location.hash));
  return page.evaluate(() => location.hash.split("/")[2] ?? "");
}
async function openMap(page: Page): Promise<void> {
  await page.click("#tab-map");
  await page.waitForSelector(".cabin-map");
}
async function selectViaGoTo(page: Page, text: string): Promise<void> {
  await page.fill("#goto-input", text);
  await page.press("#goto-input", "Enter");
  await page.waitForFunction(
    (t) =>
      document.querySelector(".cabin-map .goto [role=status]")?.textContent?.includes("Selected") &&
      document.querySelector("#inspector-heading") !== null &&
      t.length > 0,
    text,
  );
}
async function recordPrimary(page: Page, component: string): Promise<void> {
  const card = page.locator(`.component-card[data-component=${component}]`);
  await card.locator("button[type=submit]").click();
  await card.locator(".save-state.saved").waitFor();
}
async function canvasIsPainted(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
    if (!canvas) return false;
    const probe = document.createElement("canvas");
    probe.width = 64;
    probe.height = 64;
    const g = probe.getContext("2d")!;
    g.drawImage(canvas, 0, 0, 64, 64);
    const data = g.getImageData(0, 0, 64, 64).data;
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      const [r = 0, g = 0, b = 0] = data.subarray(i, i + 3);
      seen.add((r >> 4) * 256 + (g >> 4) * 16 + (b >> 4));
    }
    return seen.size > 12; // many distinct colours: a rendered scene, not a blank surface
  });
}
async function clickLocation(page: Page, locationId: string, part: "head" | "pan" = "head"): Promise<void> {
  await page.locator("canvas").scrollIntoViewIfNeeded();
  await page.evaluate(() => document.querySelector("canvas")!.scrollIntoView({ block: "center" }));
  const point = await page.evaluate(([id, p]) => window.__cabinKit!.scene!.screenPointOf(id, p), [locationId, part] as const);
  expect(point, `no screen point for ${locationId}`);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.up();
}
/** Camera position and target, for comparing a camera before and after something that must not move it. */
async function cameraOf(page: Page): Promise<number[]> {
  const c = (await sceneInfo(page)).camera as { position: number[]; target: number[] };
  return [...c.position, ...c.target];
}
function sameCamera(actual: number[], expected: number[], when: string): void {
  const drift = Math.max(...actual.map((v, i) => Math.abs(v - (expected[i] ?? Number.NaN))));
  expect(drift < 0.02, `camera moved ${when}: ${JSON.stringify(expected)} -> ${JSON.stringify(actual)}`);
}
const cam = (page: Page, view: string, id?: string) =>
  page.evaluate(([v, i]) => window.__cabinKit!.scene!.setCamera(v as never, i), [view, id ?? null] as const);
const sceneSet = (page: Page, fn: string, arg: unknown) =>
  page.evaluate(
    ([f, a]) => {
      const scene = window.__cabinKit!.scene as unknown as Record<string, ((x: unknown) => void) | undefined>;
      const method = scene[f];
      if (!method) throw new Error(`scene has no method ${f}`);
      method.call(scene, a);
    },
    [fn, arg] as const,
  );
async function axe(page: Page, label: string): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const serious = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  writeFileSync(
    join(OUT, `axe-${label}.json`),
    JSON.stringify(
      {
        url: page.url(),
        violations: result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, sample: v.nodes[0]?.html })),
        passes: result.passes.length,
      },
      null,
      2,
    ),
  );
  expect(
    serious.length === 0,
    `${serious.length} serious/critical axe violations on ${label}: ${serious.map((v) => `${v.id} (${v.nodes.length})`).join(", ")}`,
  );
}

const server = await startServer({ testFaults: true });
let browser: Browser | null = null;
const startedAt = new Date().toISOString();
console.log(`server ${server.url}  data ${server.dataDir}`);

try {
  browser = await launchBrowser();
  const chromeVersion = browser.version();
  const desktop: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await desktop.newPage();
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|net::ERR/.test(m.text())) consoleErrors.push(m.text());
  });
  await page.goto(`${server.url}/#/check`);
  await page.waitForSelector("input[name=tail]");

  // ---------------------------------------------------------------------------------------
  group = "lookup states in the UI";
  console.log(`\n${group}`);
  for (const [tail, date, expected] of [
    ["N999ZZ", "2026-11-12", "UNKNOWN_TAIL"],
    ["N000TL", "2026-11-12", "UNCONFIGURED"],
    ["N500TL", "2026-03-01", "UNCONFIGURED"],
    ["N400TL", "2026-09-15", "OVERLAP"],
    ["N110TL", "2026-11-12", "PLANNED"],
    ["N600TL", "2026-03-01", "SOURCE_INVALID"],
    ["N090TL", "2026-11-12", "PARTIAL"],
    ["N200TL", "2026-06-30", "RESOLVED"],
    ["N200TL", "2026-07-01", "RESOLVED"],
  ] as const) {
    await check(`${tail} ${date} shows ${expected}`, async () => {
      equal(await lookupUi(page, tail, date), expected, "state");
      const hasStart = (await page.locator("text=Start visit (saves a draft)").count()) > 0;
      equal(hasStart, expected === "RESOLVED" || expected === "PARTIAL", "start button offered only for a resolved configuration");
    });
  }
  await check("N200TL retrofit boundary shows V05 then V04", async () => {
    await lookupUi(page, "N200TL", "2026-06-30");
    expect((await page.textContent(".panel.config"))!.includes("V05"), "V05 on 2026-06-30");
    await lookupUi(page, "N200TL", "2026-07-01");
    expect((await page.textContent(".panel.config"))!.includes("V04"), "V04 on 2026-07-01");
  });
  await check("empty tail is reported as invalid input, not a guess", async () => {
    await page.fill("input[name=tail]", "");
    await page.click("form.lookup-form button[type=submit]");
    await page.waitForSelector(".status-card[data-state=INVALID_INPUT]");
  });

  // ---------------------------------------------------------------------------------------
  group = "full workflow by keyboard (desktop)";
  console.log(`\n${group}`);
  let visitId = "";
  await check("look up N100TL and start a visit using only the keyboard", async () => {
    await page.goto(`${server.url}/#/check`);
    await page.reload();
    await page.waitForSelector("input[name=tail]");
    await page.keyboard.press("Tab"); // skip link
    expect(await page.evaluate(() => document.activeElement?.className === "skip"), "skip link is the first tab stop");
    await tabTo(page, "input[name=tail]");
    await page.keyboard.type("n100tl");
    await tabTo(page, "input[name=date]");
    await page.keyboard.type("11122026");
    await tabTo(page, "input[name=technician]");
    await page.keyboard.type("Keyboard Tech");
    await tabTo(page, "form.lookup-form button[type=submit]");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".status-card[data-state=RESOLVED]");
    await tabTo(page, ".status-card .actions button.primary");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /#\/visit\/[0-9a-f-]{36}$/.test(location.hash));
    visitId = await page.evaluate(() => location.hash.split("/")[2] ?? "");
    await page.waitForSelector("#work-h");
  });
  await check("select seat 3A in the map with arrow keys and record the cushion", async () => {
    // Tabs follow the WAI-ARIA pattern: Tab reaches the selected tab, and the arrow keys move to and show the other one.
    await tabTo(page, "#tab-3d");
    await page.keyboard.press("ArrowRight");
    expect(await page.evaluate(() => document.activeElement?.id === "tab-map"), "ArrowRight moved focus to the map tab");
    await page.waitForSelector(".cabin-map");
    await tabTo(page, "button[data-seat='1A']");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-seat") === "3A"), "arrow keys moved focus to 3A");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("#inspector-heading")?.textContent === "Seat 3A");
    equal(await page.getAttribute("button[data-seat='3A']", "aria-pressed"), "true", "3A pressed");
    expect((await page.textContent(".component-card[data-component=CUSHION]"))!.includes("FAKE-SC-1001"), "cushion primary part shown");
    await tabTo(page, ".component-card[data-component=CUSHION] button[type=submit]");
    await page.keyboard.press("Enter");
    await page.locator(".component-card[data-component=CUSHION] .save-state.saved").waitFor();
    expect((await page.getAttribute("button[data-seat='3A']", "aria-label"))!.includes("1 replacement recorded"), "map label announces the record");
  });
  await check("select the full-cabin floor, choose the approved alternate and record it", async () => {
    await tabTo(page, ".cabin-map button.loc[data-location='FLOOR:FULL-CABIN']", 400);
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector("#inspector-heading")?.textContent?.startsWith("Full cabin floor"));
    const card = page.locator(".component-card[data-component=CARPET_KIT]");
    const text = (await card.textContent())!;
    expect(text.includes("FAKE-CK-2001") && text.includes("FAKE-CK-2000"), "primary and alternate both shown, separately");
    for (const part of ["FAKE-P-39", "FAKE-P-40", "FAKE-P-41", "FAKE-P-42"]) expect(text.includes(part), `required supplement ${part} listed`);
    await tabTo(page, ".component-card[data-component=CARPET_KIT] input[type=radio]:checked", 400);
    await page.keyboard.press("ArrowDown"); // radio group: move from Primary to the alternate
    equal(await card.locator("input[type=radio]:checked").getAttribute("value"), "FX-SUB-KIT-1", "alternate selected");
    await tabTo(page, ".component-card[data-component=CARPET_KIT] button[type=submit]");
    await page.keyboard.press("Enter");
    await card.locator(".save-state.saved").waitFor();
    const work = (await page.textContent(".worklist"))!;
    expect(
      work.includes("Alternate: FAKE-CK-2000 1 KIT, FAKE-P-39 2 PANEL, FAKE-P-40 2 PANEL, FAKE-P-41 1 PANEL, FAKE-P-42 1 PANEL"),
      "work list shows alternate with derived children",
    );
    expect(!work.includes("FAKE-CK-2001"), "primary kit is absent from recorded work");
  });
  await check("draft is saved: sample draft exported", async () => {
    const { json } = await api<{ visit: unknown }>(server, "GET", `/api/visits/${visitId}`);
    writeFileSync(join(SAMPLES, "sample-draft-visit.json"), JSON.stringify(json, null, 2));
    const draft = await api<{ report: Report }>(server, "GET", `/api/visits/${visitId}/report`);
    equal(draft.json.report.reportKind, "DRAFT_PREVIEW", "draft preview kind");
    writeFileSync(join(SAMPLES, "sample-draft-report-preview.json"), JSON.stringify(draft.json, null, 2));
    writeFileSync(
      join(SAMPLES, "sample-draft-report-preview.pdf"),
      Buffer.from(await (await fetch(`${server.url}/api/visits/${visitId}/report.pdf`)).arrayBuffer()),
    );
  });
  await check("complete requires an explicit confirmation and opens the locked report", async () => {
    await tabTo(page, ".worklist button.primary", 400);
    await page.keyboard.press("Enter");
    await page.waitForSelector("dialog.confirm[open]");
    expect(
      await page.evaluate(() => document.activeElement?.closest("dialog.confirm") !== null && document.activeElement?.textContent === "Cancel"),
      "focus moved into the dialog, to Cancel",
    );
    await page.keyboard.press("Escape");
    await page.waitForSelector("dialog.confirm:not([open])", { state: "attached" });
    expect(await page.evaluate(() => document.activeElement?.textContent === "Complete visit…"), "Escape closed the dialog and returned focus");
    await page.keyboard.press("Enter");
    await page.waitForSelector("dialog.confirm[open]");
    equal((await api<{ visit: { status: string } }>(server, "GET", `/api/visits/${visitId}`)).json.visit.status, "DRAFT", "still a draft before confirming");
    // Cancel is the last button; the confirm button is just before it.
    await page.keyboard.press("Shift+Tab");
    const active = await page.evaluate(() => document.activeElement?.outerHTML ?? "none");
    expect(active.includes("Confirm completion"), `Shift+Tab from Cancel reaches Confirm completion (focus on ${active.slice(0, 120)})`);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => location.hash.endsWith("/report"));
    await page.waitForSelector("#totals-table");
    expect((await page.textContent(".report-kind"))!.startsWith("FINAL"), "report is final");
  });
  let finalReport: Report | null = null;
  await check("report shows exactly the six mandated part/unit totals", async () => {
    const rows = await page.$$eval("#totals-table tbody tr", (trs) =>
      trs.map((tr) => [tr.getAttribute("data-part"), Number(tr.getAttribute("data-qty")), tr.getAttribute("data-unit")]),
    );
    equal(rows, SIX, "totals in the page");
    const body = (await page.textContent("article.report"))!;
    expect(
      body.includes("Keyboard Tech") && body.includes("N100TL") && body.includes("2026-11-12") && body.includes("V01"),
      "visit and configuration context present",
    );
    expect(body.includes("Not an approved maintenance authority"), "authority notice present");
  });
  await check("structured JSON, server PDF and printed PDF agree with the persisted work", async () => {
    const { json } = await api<{ report: Report; basisSha256: string }>(server, "GET", `/api/visits/${visitId}/report`);
    finalReport = json.report;
    equal(
      json.report.totals.map((t) => [t.partNo, t.quantity, t.unit]),
      SIX,
      "JSON totals",
    );
    const stored = (
      await api<{ visit: { records: { lines: { partNo: string; unit: string; qty: number }[] }[]; status: string } }>(server, "GET", `/api/visits/${visitId}`)
    ).json.visit;
    const sums = new Map<string, number>();
    for (const r of stored.records) for (const l of r.lines) sums.set(`${l.partNo}|${l.unit}`, (sums.get(`${l.partNo}|${l.unit}`) ?? 0) + l.qty);
    equal(
      [...sums.entries()].sort(),
      json.report.totals.map((t) => [`${t.partNo}|${t.unit}`, t.quantity] as [string, number]).sort(),
      "JSON totals equal sums of persisted record lines",
    );
    writeFileSync(join(SAMPLES, "sample-completed-visit.json"), JSON.stringify((await api(server, "GET", `/api/visits/${visitId}`)).json, null, 2));
    writeFileSync(join(SAMPLES, "sample-completed-report.json"), JSON.stringify(json, null, 2));
    const serverPdf = new Uint8Array(await (await fetch(`${server.url}/api/visits/${visitId}/report.pdf`)).arrayBuffer());
    writeFileSync(join(SAMPLES, "sample-completed-report.pdf"), serverPdf);
    const printed = await page.pdf({ format: "Letter", printBackground: true });
    writeFileSync(join(SAMPLES, "sample-completed-report-browser-print.pdf"), printed);
    for (const [label, bytes] of [
      ["server PDF", serverPdf],
      ["browser print PDF", new Uint8Array(printed)],
    ] as const) {
      const { text } = await pdfText(bytes);
      const f = flat(text);
      for (const t of json.report.totals)
        expect(f.includes(flat(`${t.partNo}${t.description}${t.quantity}${t.unit}`)), `${label} carries total ${t.partNo} ${t.quantity} ${t.unit}`);
      expect(!f.includes("FAKE-CK-20011KIT"), `${label} does not total the primary kit`);
      for (const s of ["N100TL", "2026-11-12", "KeyboardTech", "Seat3A", json.report.visit.id]) expect(f.includes(s), `${label} contains ${s}`);
      expect(/FINAL/.test(text), `${label} is marked final`);
    }
  });
  await check("completed visit is locked in the UI and through the API", async () => {
    await page.goto(`${server.url}/#/visit/${visitId}`);
    await page.waitForSelector("#work-h");
    expect((await page.textContent(".visit-head"))!.includes("Completed and locked"), "locked banner");
    equal(await page.locator(".worklist button.primary").count(), 0, "no complete button");
    equal(await page.locator(".worklist button.danger").count(), 0, "no remove buttons");
    await openMap(page);
    await selectViaGoTo(page, "4A");
    equal(await page.locator(".record-form").count(), 0, "no record form on a completed visit");
    const edit = await api<{ error: { code: string } }>(server, "PUT", `/api/visits/${visitId}/records`, {
      record: { locationId: "SEAT:4A", componentId: "CUSHION", selection: "PRIMARY", quantity: 1 },
    });
    equal([edit.status, edit.json.error.code], [409, "VISIT_LOCKED"], "API edit refused");
  });

  // ---------------------------------------------------------------------------------------
  group = "3D cutaway";
  console.log(`\n${group}`);
  let draftId = "";
  await check("genuine WebGL scene with one instance per seat, floor area and bin module", async () => {
    draftId = await startVisitUi(page, "N100TL", "2026-11-12", "3D Tech");
    await waitFor3D(page);
    await settle(page, 700);
    const info = await sceneInfo(page);
    equal([info.seats, info.floorAreas, info.binModules], [176, 3, 20], "scene identities");
    expect(await canvasIsPainted(page), "canvas is painted");
    const gl = await page.evaluate(() => {
      const c = document.createElement("canvas");
      const g = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
      const ext = g?.getExtension("WEBGL_debug_renderer_info");
      return g ? { version: g.getParameter(g.VERSION), renderer: ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown" } : null;
    });
    expect(gl, "WebGL context available");
    writeFileSync(join(OUT, "webgl.json"), JSON.stringify({ ...gl, scene: info }, null, 2));
  });
  await check("spatial picking selects the exact seat and its component", async () => {
    await cam(page, "focus", "SEAT:7C");
    await settle(page);
    await clickLocation(page, "SEAT:7C", "head");
    await page.waitForFunction(() => document.querySelector("#inspector-heading")?.textContent === "Seat 7C");
    expect(await page.locator(".component-card[data-component=BACKREST].highlighted").count(), "picking the headrest highlights the backrest component");
    equal((await sceneInfo(page)).selection, "SEAT:7C", "scene selection");
    // neighbours resolve to their own identities
    await clickLocation(page, "SEAT:7B", "head");
    await page.waitForFunction(() => document.querySelector("#inspector-heading")?.textContent === "Seat 7B");
    // from above the seat pan is exposed: picking it targets the cushion of exactly that seat
    await cam(page, "overhead");
    await settle(page);
    await clickLocation(page, "SEAT:7C", "pan");
    await page.waitForFunction(() => document.querySelector("#inspector-heading")?.textContent === "Seat 7C");
    expect(await page.locator(".component-card[data-component=CUSHION].highlighted").count(), "picking the pan highlights the cushion component");
  });
  await check("selection, recorded and unresolved states stay in sync across 3D, map, inspector and work list", async () => {
    await recordPrimary(page, "CUSHION");
    const states = await page.evaluate(() => {
      const scene = window.__cabinKit!.scene as unknown as { states: Map<string, { components: Record<string, string> }> };
      return scene.states.get("SEAT:7C")?.components ?? null;
    });
    equal(states, { CUSHION: "recorded" }, "3D state for 7C");
    expect((await page.textContent(".viewer-counts"))!.includes("1 recorded"), "viewer count");
    expect((await page.textContent(".worklist"))!.includes("Seat 7C"), "work list has 7C");
    await openMap(page);
    equal(await page.getAttribute("button[data-seat='7C']", "aria-pressed"), "true", "map shows 7C selected");
    expect((await page.getAttribute("button[data-seat='7C']", "class"))!.includes("recorded"), "map shows 7C recorded");
    await page.click("button[data-seat='9D']");
    await page.click("#tab-3d");
    await waitFor3D(page);
    equal((await sceneInfo(page)).selection, "SEAT:9D", "map selection carried into 3D");
  });
  await check("floor areas and bin modules are pickable in 3D", async () => {
    await cam(page, "overhead");
    await settle(page);
    await sceneSet(page, "setLayers", { seats: false, floor: true, bins: false, context: false });
    await clickLocation(page, "FLOOR:MID");
    await page.waitForFunction(() => document.querySelector("#inspector-heading")?.textContent?.startsWith("Mid floor area"));
    await sceneSet(page, "setLayers", { seats: true, floor: true, bins: true, context: false });
    await cam(page, "focus", "BIN:R-03");
    await settle(page);
    await clickLocation(page, "BIN:R-03");
    await page.waitForFunction(() => document.querySelector("#inspector-heading")?.textContent?.startsWith("Overhead bin R-03"));
    expect((await page.textContent(".component-card[data-component=BIN_DOOR]"))!.includes("FAKE-V01-BIN-R-03"), "bin door part resolved");
  });
  await check("a hidden layer never blocks a pick", async () => {
    // select something else first, so a later "bin" heading could only come from picking the hidden bin
    await openMap(page);
    await selectViaGoTo(page, "2A");
    await page.click("#tab-3d");
    await waitFor3D(page);
    await cam(page, "focus", "BIN:R-03");
    await settle(page);
    await page.evaluate(() => document.querySelector("canvas")!.scrollIntoView({ block: "center" }));
    const point = await page.evaluate(() => window.__cabinKit!.scene!.screenPointOf("BIN:R-03"));
    const layer = (name: string) => page.click(`.toolbar [aria-label=Layers] label:has-text('${name}') input`);
    await layer("Bins");
    await settle(page, 200);
    equal(((await sceneInfo(page)).layers as { bins: boolean }).bins, false, "bins layer hidden");
    // Clicking where the hidden bin was must reach whatever lies behind it, never the bin.
    await page.mouse.move(point!.x, point!.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(300);
    const heading = (await page.textContent("#inspector-heading")) ?? "";
    expect(!heading.startsWith("Overhead bin"), `clicking where the hidden bin was reached "${heading}", not a bin`);
    await layer("Bins");
    // with seats hidden the floor under them is reachable
    await cam(page, "focus", "SEAT:20C");
    await layer("Seats");
    await settle(page, 250);
    await clickLocation(page, "SEAT:20C", "pan");
    await page.waitForFunction(() => document.querySelector("#inspector-heading")?.textContent?.includes("floor area"));
    await layer("Seats");
  });
  await check("camera buttons, orbit, pan and zoom change the view; reset restores it", async () => {
    const position = async () => {
      const c = (await sceneInfo(page)).camera as { position: number[]; target: number[]; fov: number };
      // rounded to 5 cm: damping settles asymptotically
      return JSON.stringify([...c.position, ...c.target].map((v) => Math.round(v * 20) / 20).concat(c.fov));
    };
    await page.click(".toolbar button:has-text('Reset')");
    await settle(page, 300);
    const home = await position();
    for (const label of ["Overhead", "Aisle", "Cutaway"]) {
      await page.click(`.toolbar button:has-text('${label}')`);
      await settle(page, 200);
      equal((await sceneInfo(page)).view, label.toLowerCase(), `view ${label}`);
    }
    const box = (await page.locator("canvas").boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 160, cy + 40, { steps: 6 });
    await page.mouse.up();
    await settle(page, 400);
    const orbited = await position();
    expect(orbited !== home, "drag orbits");
    await page.mouse.wheel(0, -600);
    await settle(page, 400);
    const zoomed = await position();
    expect(zoomed !== orbited, "wheel zooms");
    const targetOf = async () => JSON.stringify(((await sceneInfo(page)).camera as { target: number[] }).target.map((v) => Math.round(v * 20) / 20));
    const targetBefore = await targetOf();
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(cx - 120, cy - 30, { steps: 6 });
    await page.mouse.up({ button: "right" });
    await settle(page, 400);
    expect((await targetOf()) !== targetBefore, "right-drag pans the target");
    const panned = await position();
    await page.focus("canvas");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("+");
    await settle(page, 300);
    expect((await position()) !== panned, "keyboard orbits and zooms the canvas");
    await page.keyboard.press("Home");
    await settle(page, 400);
    equal(await position(), home, "Home/Reset restores the default cutaway");
    await page.click(".toolbar button[aria-label='Rotate left']");
    await page.click(".toolbar button[aria-label='Zoom in']");
    await settle(page, 300);
    expect((await position()) !== home, "camera buttons work");
    await page.click(".toolbar button:has-text('Reset')");
  });
  await check("whole cabin is framed to fill the view", async () => {
    await page.click(".toolbar button:has-text('Reset')");
    await settle(page, 500);
    const fill = await page.evaluate(() => {
      const scene = window.__cabinKit!.scene as unknown as {
        layout: { locations: { id: string; kind: string }[] };
        screenPointOf(id: string): { x: number; y: number };
      };
      const rect = document.querySelector("canvas")!.getBoundingClientRect();
      const pts = scene.layout.locations.filter((l) => l.kind === "SEAT").map((l) => scene.screenPointOf(l.id));
      const xs = pts.map((p) => p.x - rect.left);
      const ys = pts.map((p) => p.y - rect.top);
      const inside = pts.every((p) => p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom);
      return { inside, width: (Math.max(...xs) - Math.min(...xs)) / rect.width, height: (Math.max(...ys) - Math.min(...ys)) / rect.height };
    });
    writeFileSync(join(OUT, "framing.json"), JSON.stringify(fill, null, 2));
    expect(fill.inside, "every seat is inside the canvas");
    expect(fill.width > 0.7 || fill.height > 0.7, `cabin spans the view (width ${fill.width.toFixed(2)}, height ${fill.height.toFixed(2)})`);
    await page.evaluate(() => window.scrollTo(0, 0));
    const visible = await page.evaluate(() => {
      const r = document.querySelector("canvas")!.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), viewport: window.innerHeight };
    });
    expect(
      visible.bottom <= visible.viewport,
      `the whole 3D view is on screen without scrolling at 1440x900 (canvas ${visible.top}-${visible.bottom} of ${visible.viewport})`,
    );
  });
  await check("lighting, visual family and colour modes switch independently", async () => {
    await page.selectOption(".toolbar label:has-text('Light') select", "blue");
    await page.selectOption(".toolbar label:has-text('Visual family') select", "concept-gray");
    await page.selectOption(".toolbar label:has-text('Colours') select", "none");
    await settle(page, 400);
    const info = await sceneInfo(page);
    equal([info.light, info.profile, info.colourMode, info.seats], ["blue", "concept-gray", "none", 176], "scene settings");
    expect((await page.textContent(".viewer3d > .fine"))!.includes("unassigned and illustrative"), "family is labelled unassigned and illustrative");
    await page.selectOption(".toolbar label:has-text('Light') select", "neutral");
    await page.selectOption(".toolbar label:has-text('Visual family') select", "photo-navy-band");
    await page.selectOption(".toolbar label:has-text('Colours') select", "status");
  });
  await check("a save, a window resize and a tab switch leave a moved camera, the scene and its settings as they were", async () => {
    await openMap(page);
    await selectViaGoTo(page, "8A");
    await page.click("#tab-3d");
    await waitFor3D(page);
    await page.evaluate(() => {
      (window as unknown as { __e2eScene: unknown }).__e2eScene = window.__cabinKit!.scene;
    });
    const box = (await page.locator("canvas").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2 + 30, { steps: 6 });
    await page.mouse.up();
    await settle(page, 900);
    const moved = await cameraOf(page);
    // two saves: record the cushion, then remove it again so later checks see the same records
    await recordPrimary(page, "CUSHION");
    await settle(page, 300);
    sameCamera(await cameraOf(page), moved, "after recording a part");
    await page.locator(".component-card[data-component=CUSHION] button.danger").click();
    await page.waitForFunction(() => !(document.querySelector(".worklist")?.textContent ?? "").includes("Seat 8A"));
    await settle(page, 300);
    sameCamera(await cameraOf(page), moved, "after removing a part");
    await page.setViewportSize({ width: 1180, height: 760 });
    await settle(page, 500);
    sameCamera(await cameraOf(page), moved, "after a window resize");
    equal((await sceneInfo(page)).view, "free", "a drag leaves the preset");
    await page.setViewportSize({ width: 1440, height: 900 });
    await settle(page, 500);
    await page.selectOption(".toolbar label:has-text('Light') select", "blue");
    await page.click(".toolbar [aria-label=Layers] label:has-text('Context') input");
    await settle(page, 300);
    await openMap(page);
    const hidden = await sceneInfo(page);
    equal(hidden.paused, true, "the hidden scene is paused");
    await settle(page, 300);
    equal((await sceneInfo(page)).frames, hidden.frames, "a paused scene draws nothing");
    await page.click("#tab-3d");
    await page.waitForFunction(() => (window.__cabinKit?.scene?.describe().paused as boolean | undefined) === false);
    await settle(page, 300);
    const shown = await sceneInfo(page);
    expect((shown.frames as number) > (hidden.frames as number), "the scene draws again when shown");
    expect(
      await page.evaluate(() => (window as unknown as { __e2eScene: unknown }).__e2eScene === window.__cabinKit!.scene),
      "the same scene instance after a tab switch",
    );
    equal([shown.light, (shown.layers as { context: boolean }).context], ["blue", true], "light and layers kept");
    sameCamera(await cameraOf(page), moved, "after a tab switch");
    await page.selectOption(".toolbar label:has-text('Light') select", "neutral");
    await page.click(".toolbar [aria-label=Layers] label:has-text('Context') input");
    await page.click(".toolbar button:has-text('Reset')");
  });
  await check("a right click and a long press never pick; the aisle strip picks the full-cabin floor", async () => {
    await cam(page, "focus", "SEAT:7C");
    await settle(page);
    await clickLocation(page, "SEAT:7C", "head");
    await page.waitForFunction(() => document.querySelector("#inspector-heading")?.textContent === "Seat 7C");
    const neighbour = (await page.evaluate(() => window.__cabinKit!.scene!.screenPointOf("SEAT:7B", "head")))!;
    await page.mouse.move(neighbour.x, neighbour.y);
    await page.mouse.down({ button: "right" });
    await page.mouse.up({ button: "right" });
    await page.mouse.down();
    await page.waitForTimeout(900);
    await page.mouse.up();
    await page.waitForTimeout(300);
    equal(await page.textContent("#inspector-heading"), "Seat 7C", "selection unchanged");
    await cam(page, "overhead");
    await sceneSet(page, "setLayers", { seats: false, floor: true, bins: false, context: false });
    await settle(page);
    await clickLocation(page, "FLOOR:FULL-CABIN");
    await page.waitForFunction(() => document.querySelector("#inspector-heading")?.textContent?.startsWith("Full cabin floor"));
    await clickLocation(page, "FLOOR:AFT");
    await page.waitForFunction(() => document.querySelector("#inspector-heading")?.textContent?.startsWith("Aft floor area"));
    await sceneSet(page, "setLayers", { seats: true, floor: true, bins: true, context: false });
    await page.click(".toolbar button:has-text('Reset')");
  });

  // ---------------------------------------------------------------------------------------
  group = "captures and performance";
  console.log(`\n${group}`);
  const reference = (await api<{ releaseId: string }>(server, "GET", "/api/reference")).json;
  const captureMeta: Record<string, unknown>[] = [];
  const capture = async (
    name: string,
    profile: string,
    light: string,
    view: string,
    locationId?: string,
    layers = { seats: true, floor: true, bins: true, context: false },
  ) => {
    await sceneSet(page, "setProfile", profile);
    await sceneSet(page, "setLight", light);
    await sceneSet(page, "setColourMode", "none");
    await sceneSet(page, "setSelection", null);
    await sceneSet(page, "setLayers", layers);
    await cam(page, view, locationId);
    await settle(page, 650);
    const file = `${name}.png`;
    await page.locator("canvas").screenshot({ path: join(CAPTURES, file) });
    const info = await sceneInfo(page);
    const box = (await page.locator("canvas").boundingBox())!;
    captureMeta.push({
      file,
      referenceRelease: reference.releaseId,
      geometryVersion: "cabin-kit.geometry/1",
      layout: "FX-L-S176-MAX8@1",
      profile,
      light,
      cameraView: view,
      location: locationId ?? null,
      layers,
      camera: info.camera,
      viewport: { width: Math.round(box.width), height: Math.round(box.height), deviceScaleFactor: 1 },
      capturedAt: new Date().toISOString(),
    });
  };
  await check("save full-cabin, seat-front, seat-rear, carpet and bin captures for each family and light", async () => {
    const ctx = { seats: true, floor: true, bins: true, context: true };
    // Captures show the render only. A constructable stylesheet is CSSOM, not parsed inline CSS, so it works
    // under the app's strict style-src without weakening the CSP or bypassing it on this checked context.
    await page.evaluate(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(".legend, .hover-label { visibility: hidden !important; }");
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    });
    for (const light of ["neutral", "blue"]) {
      await capture(`full-cabin-cutaway_photo-navy-band_${light}`, "photo-navy-band", light, "cutaway");
      await capture(`full-cabin-aisle_photo-navy-band_${light}`, "photo-navy-band", light, "aisle", undefined, ctx);
      await capture(`seat-front_photo-navy-band_${light}`, "photo-navy-band", light, "focus", "SEAT:7C", ctx);
      await capture(`seat-rear_photo-navy-band_${light}`, "photo-navy-band", light, "focus-rear", "SEAT:7C", ctx);
      await capture(`carpet_photo-navy-band_${light}`, "photo-navy-band", light, "carpet");
      await capture(`bin-detail_photo-navy-band_${light}`, "photo-navy-band", light, "bins", undefined, ctx);
    }
    await capture("full-cabin-overhead_photo-navy-band_neutral", "photo-navy-band", "neutral", "overhead");
    await capture("seat-front_photo-navy-plain_blue", "photo-navy-plain", "blue", "focus", "SEAT:7C", ctx);
    await capture("seat-front_photo-navy-plain_neutral", "photo-navy-plain", "neutral", "focus", "SEAT:7C", ctx);
    await capture("seat-front_concept-gray_neutral", "concept-gray", "neutral", "focus", "SEAT:7C", ctx);
    await capture("full-cabin-cutaway_concept-gray_neutral", "concept-gray", "neutral", "cutaway");
    writeFileSync(
      join(CAPTURES, "captures.json"),
      JSON.stringify(
        { note: "Actual renders of this build. Geometry is an illustrative approximation.", chrome: chromeVersion, captures: captureMeta },
        null,
        2,
      ),
    );
    await sceneSet(page, "setProfile", "photo-navy-band");
    await sceneSet(page, "setLight", "neutral");
    await sceneSet(page, "setColourMode", "status");
    await sceneSet(page, "setLayers", { seats: true, floor: true, bins: true, context: false });
    await cam(page, "cutaway");
    await page.reload();
    await waitFor3D(page);
  });
  await check("measured frame rate and selection feedback on this device", async () => {
    await settle(page, 600);
    const fps = await page.evaluate(() => window.__cabinKit!.scene!.measure(4000));
    await page.evaluate(() => (window.__cabinKit!.scene!.pickLatencies.length = 0));
    for (const seat of ["SEAT:5C", "SEAT:8D", "SEAT:11C", "SEAT:14D", "SEAT:18C", "SEAT:22D", "SEAT:3C", "SEAT:9D", "SEAT:16C", "SEAT:25D"]) {
      await cam(page, "focus", seat);
      await page.waitForTimeout(140);
      await clickLocation(page, seat);
      await page.waitForFunction((label) => document.querySelector("#inspector-heading")?.textContent === label, `Seat ${seat.split(":")[1]}`);
      await page.waitForTimeout(80);
    }
    const latencies = await page.evaluate(() => [...window.__cabinKit!.scene!.pickLatencies]);
    const info = await sceneInfo(page);
    const perf = {
      device: {
        cpu: cpus()[0]?.model,
        cores: cpus().length,
        memoryGb: Math.round(totalmem() / 2 ** 30),
        os: `${platform()} ${release()}`,
        browser: `Chrome ${chromeVersion} (headless)`,
        webgl: JSON.parse(readFileSync(join(OUT, "webgl.json"), "utf8")).renderer,
      },
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      scene: { layout: "FX-L-S176-MAX8@1", seats: info.seats, renderer: info.renderer },
      frameRate: {
        method:
          "continuous orbit for 4 s with seats, floor and bins visible (context layer off), rendering each animation frame; headless Chrome caps at the display refresh rate",
        fps: Number(fps.fps.toFixed(1)),
        frames: fps.frames,
        worstFrameMs: Number(fps.worstFrameMs.toFixed(1)),
        target: "about 30 fps",
      },
      selectionFeedback: {
        method: "pointer pick to the next rendered frame showing the selection, 10 picks",
        samplesMs: latencies.map((v) => Number(v.toFixed(1))),
        maxMs: Number(Math.max(...latencies).toFixed(1)),
        medianMs: Number(([...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)] ?? Number.NaN).toFixed(1)),
        target: "within 250 ms",
      },
      measuredAt: new Date().toISOString(),
    };
    writeFileSync(join(PROJECT_ROOT, "verification", "performance.json"), JSON.stringify(perf, null, 2));
    expect(latencies.length >= 10, `captured ${latencies.length} selection latencies`);
    expect(perf.frameRate.fps >= 30, `frame rate ${perf.frameRate.fps} fps`);
    expect(perf.selectionFeedback.maxMs <= 250, `selection feedback max ${perf.selectionFeedback.maxMs} ms`);
  });

  // ---------------------------------------------------------------------------------------
  group = "draft edits, persistence and restart";
  console.log(`\n${group}`);
  await check("quantity update, primary/alternate switch and remove keep one record with no orphans", async () => {
    await page.goto(`${server.url}/#/visit/${draftId}`);
    await page.waitForSelector("#work-h");
    await openMap(page);
    await selectViaGoTo(page, "FWD");
    const panel = page.locator(".component-card[data-component=CARPET_PANEL]");
    await panel.getByLabel(/^Replacements/).fill("2");
    await panel.locator("button[type=submit]").click();
    await panel.locator(".save-state.saved").waitFor();
    await panel.getByLabel(/^Replacements/).fill("4");
    await panel.locator("button[type=submit]").click();
    await page.waitForFunction(() => document.querySelector(".worklist")?.textContent?.includes("FAKE-V01-FWD-PANEL 4 PANEL"));
    await selectViaGoTo(page, "FULL-CABIN");
    const kit = page.locator(".component-card[data-component=CARPET_KIT]");
    await kit.locator("input[type=radio][value='FX-SUB-KIT-1']").check();
    await kit.locator("button[type=submit]").click();
    await page.waitForFunction(() => document.querySelector(".worklist")?.textContent?.includes("FAKE-P-42 1 PANEL"));
    await kit.locator("input[type=radio][value=PRIMARY]").check();
    await kit.locator("button[type=submit]").click();
    await page.waitForFunction(() => {
      const t = document.querySelector(".worklist")?.textContent ?? "";
      return t.includes("Primary: FAKE-CK-2001 1 KIT") && !t.includes("FAKE-P-39") && !t.includes("FAKE-CK-2000");
    });
    await kit.locator("button.danger").click();
    await page.waitForFunction(() => !(document.querySelector(".worklist")?.textContent ?? "").includes("FAKE-CK-2001"));
    const visit = (await api<{ visit: { records: { locationId: string; componentId: string; quantity: number }[] } }>(server, "GET", `/api/visits/${draftId}`))
      .json.visit;
    equal(
      visit.records.map((r) => `${r.locationId}/${r.componentId}/${r.quantity}`).sort(),
      ["FLOOR:FWD/CARPET_PANEL/4", "SEAT:7C/CUSHION/1"],
      "persisted records",
    );
  });
  await check("draft survives a service restart and a browser reload, and can be resumed from history", async () => {
    await server.restart();
    await page.goto(`${server.url}/#/visits`);
    await page.reload();
    await page.waitForSelector("table tbody tr");
    const row = page.locator("tbody tr", { hasText: "3D Tech" }).first();
    expect((await row.textContent())!.includes("Draft"), "draft listed after restart");
    await row.locator("a", { hasText: "Resume" }).click();
    await page.waitForSelector("#work-h");
    const work = (await page.textContent(".worklist"))!;
    expect(work.includes("Seat 7C") && work.includes("FAKE-V01-FWD-PANEL 4 PANEL"), "saved work restored");
    await openMap(page);
    await selectViaGoTo(page, "7C");
    await page.locator(".component-card[data-component=BACKREST] button[type=submit]").click();
    await page.locator(".component-card[data-component=BACKREST] .save-state.saved").waitFor();
    equal((await api<{ visit: { recordCount: number } }>(server, "GET", `/api/visits/${draftId}`)).json.visit.recordCount, 3, "work continued after restart");
  });
  await check("changing the lookup form does not retarget the open visit", async () => {
    await page.goto(`${server.url}/#/check`);
    await lookupUi(page, "N300TL", "2026-11-12");
    await page.goto(`${server.url}/#/visit/${draftId}`);
    await page.waitForSelector("#work-h");
    expect((await page.textContent("#visit-h"))!.includes("N100TL · 2026-11-12"), "visit still N100TL");
    expect((await page.textContent(".panel.config"))!.includes("V01"), "visit still V01");
  });
  await check("stale edit from a second window is reported as a conflict and reloaded", async () => {
    const other = await desktop.newPage();
    await other.goto(`${server.url}/#/visit/${draftId}`);
    await other.waitForSelector("#work-h");
    await other.click("#tab-map");
    await selectViaGoTo(other, "FWD");
    await page.goto(`${server.url}/#/visit/${draftId}`);
    await page.waitForSelector("#work-h");
    await openMap(page);
    await selectViaGoTo(page, "FWD");
    const mine = page.locator(".component-card[data-component=CARPET_PANEL]");
    await mine.getByLabel(/^Replacements/).fill("3");
    await mine.locator("button[type=submit]").click();
    await mine.locator(".save-state.saved").waitFor();
    const theirs = other.locator(".component-card[data-component=CARPET_PANEL]");
    await theirs.getByLabel(/^Replacements/).fill("1");
    await theirs.locator("button[type=submit]").click();
    await theirs.locator(".save-state.conflict").waitFor();
    expect((await theirs.locator(".save-state").textContent())!.includes("changed elsewhere"), "conflict explained");
    await other.waitForFunction(() => document.querySelector(".worklist")?.textContent?.includes("FAKE-V01-FWD-PANEL 3 PANEL"));
    equal(
      (await api<{ visit: { records: { componentId: string; quantity: number }[] } }>(server, "GET", `/api/visits/${draftId}`)).json.visit.records.find(
        (r) => r.componentId === "CARPET_PANEL",
      )!.quantity,
      3,
      "first writer's value kept",
    );
    await other.close();
  });

  // ---------------------------------------------------------------------------------------
  group = "failure handling and recovery";
  console.log(`\n${group}`);
  await check("network loss during save: outcome reported as unknown, retry is safe", async () => {
    await page.goto(`${server.url}/#/visit/${draftId}`);
    await page.waitForSelector("#work-h");
    await openMap(page);
    await selectViaGoTo(page, "12A");
    await page.route("**/api/visits/*/records", (route) => route.abort("connectionreset"));
    const card = page.locator(".component-card[data-component=CUSHION]");
    await card.locator("textarea").fill("typed before the connection dropped");
    await card.locator("button[type=submit]").click();
    await card.locator(".save-state.unknown").waitFor();
    expect((await card.locator(".save-state").textContent())!.includes("may or may not have been saved"), "honest unknown outcome");
    equal(await card.locator("textarea").inputValue(), "typed before the connection dropped", "typed note preserved");
    equal(await page.getAttribute("button[data-seat='12A']", "aria-pressed"), "true", "selection preserved");
    await page.unroute("**/api/visits/*/records");
    await card.locator("button:has-text('Retry safely')").click();
    await card.locator(".save-state.saved").waitFor();
  });
  await check("response lost after commit: retry confirms the earlier save without duplicating", async () => {
    // The request reaches the server and commits; the answer is then lost on the way back.
    await page.route("**/api/visits/*/records", async (route) => {
      await route.fetch();
      await route.abort("connectionreset");
    });
    await selectViaGoTo(page, "12C");
    const card = page.locator(".component-card[data-component=CUSHION]");
    await card.locator("button[type=submit]").click();
    await card.locator(".save-state.unknown").waitFor();
    await page.unroute("**/api/visits/*/records");
    const during = (
      await api<{ visit: { records: { locationId: string; version: number }[] } }>(server, "GET", `/api/visits/${draftId}`)
    ).json.visit.records.filter((r) => r.locationId === "SEAT:12C");
    equal(during.length, 1, "the write had in fact committed");
    await card.locator("button:has-text('Retry safely')").click();
    await card.locator(".save-state.saved").waitFor();
    expect((await card.locator(".save-state").textContent())!.includes("nothing was duplicated"), "replay reported");
    const after = (
      await api<{ visit: { records: { locationId: string; version: number }[] } }>(server, "GET", `/api/visits/${draftId}`)
    ).json.visit.records.filter((r) => r.locationId === "SEAT:12C");
    equal(
      after.map((r) => r.version),
      [1],
      "one record, version 1",
    );
  });
  await check("storage failure: reported as not saved, retry succeeds after recovery", async () => {
    await api(server, "POST", "/api/__test/faults", { visitWrites: "fail", remaining: 1 });
    await selectViaGoTo(page, "12D");
    const card = page.locator(".component-card[data-component=CUSHION]");
    await card.locator("button[type=submit]").click();
    await card.locator(".save-state.error").waitFor();
    expect((await card.locator(".save-state").textContent())!.toLowerCase().includes("nothing was saved"), "explicit not-saved");
    equal(
      (await api<{ visit: { records: { locationId: string }[] } }>(server, "GET", `/api/visits/${draftId}`)).json.visit.records.filter(
        (r) => r.locationId === "SEAT:12D",
      ).length,
      0,
      "nothing stored",
    );
    await card.locator("button:has-text('Retry safely')").click();
    await card.locator(".save-state.saved").waitFor();
  });
  await check("reference store failure: lookup shows SERVICE_UNAVAILABLE, saved visits stay usable, then recovers", async () => {
    await api(server, "POST", "/api/__test/faults", { reference: "fail" });
    await page.goto(`${server.url}/#/check`);
    equal(await lookupUi(page, "N100TL", "2026-11-12"), "SERVICE_UNAVAILABLE", "state");
    equal(await page.locator("text=Start visit (saves a draft)").count(), 0, "no visit can start");
    await page.goto(`${server.url}/#/visit/${draftId}`);
    await page.waitForSelector("#work-h");
    await openMap(page);
    await selectViaGoTo(page, "13A");
    await recordPrimary(page, "CUSHION"); // the draft works from its own frozen snapshot
    await api(server, "POST", "/api/__test/faults", {});
    await page.goto(`${server.url}/#/check`);
    equal(await lookupUi(page, "N100TL", "2026-11-12"), "RESOLVED", "recovered");
  });
  await check("server down: clear banner, retry buttons, recovery without losing the draft", async () => {
    await page.goto(`${server.url}/#/visit/${draftId}`);
    await page.waitForSelector("#work-h");
    await server.stop();
    await openMap(page);
    await selectViaGoTo(page, "13C");
    const card = page.locator(".component-card[data-component=CUSHION]");
    await card.locator("button[type=submit]").click();
    await card.locator(".save-state.unknown").waitFor();
    await page.goto(`${server.url.replace(/\/$/, "")}/#/visits`).catch(() => undefined);
    await server.restart();
    await page.goto(`${server.url}/#/visit/${draftId}`);
    await page.waitForSelector("#work-h");
    expect((await page.textContent(".worklist"))!.includes("Seat 13A"), "earlier work intact after outage");
    expect(!(await page.textContent(".worklist"))!.includes("Seat 13C"), "the unsent record was not silently saved");
  });
  await check("3D module failure: complete map-and-list fallback, work continues, retry restores 3D", async () => {
    const ctx = await browser!.newContext({ viewport: { width: 1280, height: 860 } });
    const p = await ctx.newPage();
    await p.route("**/assets/CabinScene-*.js", (route) => route.abort());
    await p.goto(`${server.url}/#/visit/${draftId}`);
    await p.waitForSelector(".viewer .alert");
    expect((await p.textContent(".viewer .alert"))!.includes("3D view unavailable"), "failure explained");
    await p.waitForSelector(".cabin-map");
    equal(await p.locator(".cabin-map button[data-seat]").count(), 176, "all seats in the fallback");
    equal(await p.locator(".cabin-map section[aria-labelledby=map-floor] button.loc").count(), 4, "all floor locations in the fallback");
    equal(await p.locator(".cabin-map section[aria-labelledby=map-bins] button.loc").count(), 20, "all bin modules in the fallback");
    await p.fill("#goto-input", "L-04");
    await p.press("#goto-input", "Enter");
    await p.waitForFunction(() => document.querySelector("#inspector-heading")?.textContent?.startsWith("Overhead bin L-04"));
    await p.locator(".component-card[data-component=BIN_DOOR] button[type=submit]").click();
    await p.locator(".component-card[data-component=BIN_DOOR] .save-state.saved").waitFor();
    await p.unroute("**/assets/CabinScene-*.js");
    await p.click(".viewer .alert button");
    await waitFor3D(p);
    equal((await sceneInfo(p)).selection, "BIN:L-04", "selection kept when 3D came back");
    expect((await p.textContent(".worklist"))!.includes("Overhead bin L-04"), "work kept");
    await ctx.close();
  });
  await check("WebGL unavailable: fallback covers seats, floors and bins", async () => {
    const noGl = await launchBrowser(["--disable-3d-apis", "--disable-gpu"]);
    try {
      const p = await noGl.newPage({ viewport: { width: 1280, height: 860 } });
      await p.goto(`${server.url}/#/visit/${draftId}`);
      await p.waitForSelector(".viewer .alert");
      await p.waitForSelector(".cabin-map");
      expect(await p.locator("#tab-3d").isDisabled(), "3D tab disabled while unavailable");
      await p.fill("#goto-input", "MID");
      await p.press("#goto-input", "Enter");
      await p.waitForFunction(() => document.querySelector("#inspector-heading")?.textContent?.startsWith("Mid floor area"));
      await p.locator(".component-card[data-component=CARPET_PANEL] button[type=submit]").click();
      await p.locator(".component-card[data-component=CARPET_PANEL] .save-state.saved").waitFor();
      await p.screenshot({ path: join(OUT, "fallback-no-webgl.png"), fullPage: false });
    } finally {
      await noGl.close();
    }
  });
  await check("blocked localStorage does not break the app", async () => {
    const ctx = await browser!.newContext({ viewport: { width: 1280, height: 860 } });
    await ctx.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get: () => {
          throw new Error("blocked");
        },
      });
    });
    const p = await ctx.newPage();
    await p.goto(`${server.url}/#/check`);
    await lookupUi(p, "N100TL", "2026-11-12");
    await p.click("text=Start visit (saves a draft)");
    await p.waitForSelector("#work-h");
    await ctx.close();
  });

  // ---------------------------------------------------------------------------------------
  group = "partial configuration, preparation, candidates and history";
  console.log(`\n${group}`);
  await check("PARTIAL visit: gaps are visible, cannot be recorded and stay in the report", async () => {
    await startVisitUi(page, "N090TL", "2026-11-12", "Gap Tech");
    await openMap(page);
    expect((await page.textContent(".viewer-counts"))!.includes("24 unresolved"), "24 unresolved shown");
    await selectViaGoTo(page, "L-01");
    const bin = page.locator(".component-card[data-component=BIN_DOOR]");
    expect((await bin.textContent())!.includes("No match"), "bin gap explained");
    equal(await bin.locator(".record-form").count(), 0, "no record form for an unresolved component");
    await selectViaGoTo(page, "FWD");
    expect((await page.textContent(".component-card[data-component=CARPET_PANEL]"))!.includes("Ambiguous"), "ambiguity explained");
    await selectViaGoTo(page, "12A");
    expect((await page.textContent(".component-card[data-component=BACKREST]"))!.includes("expired after 2025-12-31"), "expired source reason shown");
    await recordPrimary(page, "CUSHION");
    await page.click("a:has-text('Preview report')");
    await page.waitForSelector("#r-gaps");
    expect((await page.textContent("#r-gaps"))!.includes("24 components"), "report lists the gaps");
  });
  await check("expired alternate is not offered on 2027-01-01 and the reason is shown", async () => {
    await startVisitUi(page, "N100TL", "2027-01-01", "Expiry Tech");
    await openMap(page);
    await selectViaGoTo(page, "FULL-CABIN");
    const kit = page.locator(".component-card[data-component=CARPET_KIT]");
    equal(await kit.locator("input[type=radio]").count(), 1, "only the primary can be chosen");
    expect((await kit.textContent())!.includes("Not available: FAKE-CK-2000"), "exclusion shown");
    expect((await kit.textContent())!.includes("expired after 2026-12-31"), "expiry reason shown");
    await startVisitUi(page, "N100TL", "2026-12-31", "Expiry Tech");
    await openMap(page);
    await selectViaGoTo(page, "FULL-CABIN");
    equal(await page.locator(".component-card[data-component=CARPET_KIT] input[type=radio]").count(), 2, "alternate offered on the last valid day");
  });
  await check("pending change is an advisory and the rule stays usable", async () => {
    await startVisitUi(page, "N200TL", "2026-07-01", "Pending Tech");
    await openMap(page);
    await selectViaGoTo(page, "FULL-CABIN");
    const kit = page.locator(".component-card[data-component=CARPET_KIT]");
    expect((await kit.textContent())!.includes("FAKE-CK-2002") && (await kit.textContent())!.includes("Pending change (advisory)"), "pending change shown");
    await recordPrimary(page, "CARPET_KIT");
  });
  await check("preparation overview: searchable, filterable, printable, exportable, coverage not confused with work", async () => {
    await page.goto(`${server.url}/#/prep?tail=N100TL&date=2026-11-12`);
    await page.waitForSelector("#prep-table tbody tr");
    const all = await page.locator("#prep-table tbody tr").count();
    expect(all > 50, `lists all applicable parts (${all})`);
    expect((await page.textContent(".prep .advisory"))!.includes("not replacements made"), "coverage disclaimer");
    await page.fill(".prep input[type=search]", "FAKE-P-41");
    await page.waitForFunction(() => document.querySelectorAll("#prep-table tbody tr").length === 1);
    const row = (await page.textContent("#prep-table tbody tr"))!;
    expect(
      row.includes("FAKE-CK-2001") && row.includes("Alternate FAKE-CK-2000") && row.includes("Required: FAKE-P-41 × 1 PANEL"),
      "alternate and supplements are separate from the primary",
    );
    await page.fill(".prep input[type=search]", "");
    await page.selectOption(".prep label:has-text('Component') select", "CUSHION");
    await page.fill(".prep input[type=search]", "1001");
    await page.waitForFunction(() => document.querySelectorAll("#prep-table tbody tr").length === 1);
    expect((await page.textContent("#prep-table tbody tr"))!.includes("Seat A rows 1-5 (5 locations)"), "coverage summary");
    const csv = await (await fetch(`${server.url}/api/preparation?tail=N100TL&date=2026-11-12&format=csv`)).text();
    expect(csv.includes("ALTERNATE,FAKE-CK-2000") && csv.includes("REQUIRED_SUPPLEMENT,FAKE-P-39"), "CSV export");
    writeFileSync(join(SAMPLES, "sample-preparation-N100TL-2026-11-12.csv"), csv);
    await page.fill(".prep input[type=search]", "");
    await page.selectOption(".prep label:has-text('Component') select", "");
    writeFileSync(join(SAMPLES, "sample-preparation-N100TL-2026-11-12.pdf"), await page.pdf({ format: "Letter", printBackground: true }));
  });
  await check("candidate layout is explorable with its status visible and nothing resolvable", async () => {
    await page.goto(`${server.url}/#/layouts`);
    await page.waitForSelector("table");
    const cat = (await page.textContent("li[data-category='DOCX-CAT-700-138']"))!;
    expect(cat.includes("Unresolved: seat set not supplied") && cat.includes("7D, 7E, 7F, 15B and 15C"), "138-seat category is explicit and unresolved");
    await page.click("a:has-text('73G: Boeing 737-700')");
    await page.waitForSelector("#layout-h");
    const head = (await page.textContent("section[aria-labelledby=layout-h]"))!;
    expect(head.includes("Candidate, unassigned") && head.includes("137 seats") && head.includes("floor map not-supplied"), "candidate status visible");
    await waitFor3D(page);
    equal((await sceneInfo(page)).seats, 137, "137 seats in 3D");
    equal([(await sceneInfo(page)).floorAreas, (await sceneInfo(page)).binModules], [0, 0], "no selectable floor or bin locations");
    await cam(page, "focus", "SEAT:14B");
    await settle(page);
    await clickLocation(page, "SEAT:14B");
    await page.waitForFunction(() => document.querySelector("#inspector-heading")?.textContent === "Seat 14B");
    const insp = (await page.textContent(".inspector"))!;
    expect(insp.includes("physical row 10") && insp.includes("Printed row 14"), "printed row and physical order are separate");
    expect(insp.includes("no approved parts"), "unresolved reason shown");
    equal(await page.locator(".record-form").count(), 0, "nothing can be recorded");
    await openMap(page);
    expect((await page.textContent(".seat-grid"))!.includes("Printed rows 10, 11, 12, 13 do not exist in this layout"), "skipped labels shown");
    equal(await page.locator("button[data-seat='14A']").count(), 0, "14A is absent");
    equal(await page.locator(".cabin-map button[data-seat]").count(), 137, "137 seats in the map");
    expect((await page.textContent("section[aria-labelledby=map-floor]"))!.includes("not supplied"), "floor map gap explicit");
    await page.screenshot({ path: join(OUT, "candidate-73G-map.png") });
  });
  await check("more than 100 visits remain navigable in saved history", async () => {
    for (let i = 0; i < 118; i++) {
      const res = await api(server, "POST", "/api/visits", {
        tail: i % 2 ? "N100TL" : "N300TL",
        checkDate: "2026-11-12",
        technician: `Bulk ${String(i).padStart(3, "0")}`,
      });
      equal(res.status, 201, "created");
    }
    await page.goto(`${server.url}/#/visits`);
    await page.waitForSelector("table tbody tr");
    const total = Number(/(\d+) visits/.exec((await page.textContent("section[aria-labelledby=visits-h] [role=status]"))!)![1]);
    expect(total > 120, `total ${total}`);
    await page.click(".pager button:has-text('Last')");
    await page.waitForFunction(() => Array.from(document.querySelectorAll("tbody th")).some((th) => th.textContent === "#1"));
    expect((await page.textContent("tbody"))!.includes("Keyboard Tech"), "the very first visit is reachable by paging");
    await page.fill("form.filters input", "Bulk 007");
    await page.click("form.filters button[type=submit]");
    await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 1);
    await page.selectOption("form.filters select", "COMPLETED");
    await page.fill("form.filters input", "");
    await page.click("form.filters button[type=submit]");
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("tbody tr")).every((tr) => tr.textContent!.includes("Completed")) &&
        document.querySelectorAll("tbody tr").length >= 1,
    );
  });
  await check("a reference update leaves the completed report unchanged and is flagged, not applied", async () => {
    const before = (await api<{ report: Report; basisSha256: string }>(server, "GET", `/api/visits/${visitId}/report`)).json;
    const { importReference } = await import("../../src/importer/cli.ts");
    // A label alone is not hashed (an unchanged import is a no-op), so revise one fictional rule in a temp copy of the fixtures.
    const fixtures = JSON.parse(readFileSync(join(PROJECT_ROOT, "fixtures", "fixture-data.json"), "utf8")) as { extraRules: { id: string; note: string }[] };
    const revised = fixtures.extraRules.find((r) => r.id === "FX-R4");
    if (!revised) throw new Error("fixture rule FX-R4 not found");
    revised.note = `${revised.note} Revised in a later (fictional) release.`;
    const fixturePath = join(server.dataDir, "fixture-data-revised.json");
    writeFileSync(fixturePath, JSON.stringify(fixtures));
    const outcome = importReference({
      referencePath: join(server.dataDir, "reference.sqlite"),
      visitsPath: join(server.dataDir, "visits.sqlite"),
      fixturePath,
      label: "Second release for the stability check",
    });
    expect(outcome.activated && outcome.visitsUnchanged === true, "new release activated; visit history fingerprint unchanged");
    const after = (await api<{ report: Report; basisSha256: string }>(server, "GET", `/api/visits/${visitId}/report`)).json;
    equal(after.basisSha256, before.basisSha256, "report basis hash");
    equal(JSON.stringify(after.report), JSON.stringify(before.report), "report content");
    await page.goto(`${server.url}/#/visit/${draftId}`);
    await page.waitForSelector("#work-h");
    expect((await page.textContent(".visit-head"))!.includes("not rebased"), "draft warns that reference data moved on but is not rebased");
    equal(
      (await api<{ visit: { referenceReleaseId: string } }>(server, "GET", `/api/visits/${draftId}`)).json.visit.referenceReleaseId,
      finalReport!.configuration.referenceReleaseId,
      "draft keeps its original release",
    );
    await page.goto(`${server.url}/#/visit/${visitId}/report`);
    await page.waitForSelector("#totals-table");
    await page.fill(".note-form input[required]", "Rule revised in a later release; no change to work performed.");
    await page.click(".note-form button[type=submit]");
    await page.waitForFunction(() => document.querySelector("section[aria-labelledby=r-linked]")?.textContent?.includes("Rule revised in a later release"));
    equal(
      (await api<{ report: Report; basisSha256: string }>(server, "GET", `/api/visits/${visitId}/report`)).json.basisSha256,
      before.basisSha256,
      "linked advisory leaves the report basis unchanged",
    );
  });

  // ---------------------------------------------------------------------------------------
  group = "accessibility";
  console.log(`\n${group}`);
  const screens: [string, string, string][] = [
    ["check", "#/check", "input[name=tail]"],
    ["visit-3d", `#/visit/${draftId}`, "#work-h"],
    ["report", `#/visit/${visitId}/report`, "#totals-table"],
    ["preparation", "#/prep?tail=N100TL&date=2026-11-12", "#prep-table tbody tr"],
    ["visits", "#/visits", "table tbody tr"],
    ["layouts", "#/layouts", "table"],
    ["reference", "#/reference", ".findings"],
  ];
  for (const [label, hash, ready] of screens) {
    await check(`axe: no serious or critical WCAG A/AA violations on ${label}`, async () => {
      await page.goto(`${server.url}/${hash}`);
      await page.waitForSelector(ready);
      if (label === "visit-3d") await waitFor3D(page);
      await axe(page, label);
    });
  }
  await check("axe: map and list with a selected location and record form", async () => {
    await page.goto(`${server.url}/#/visit/${draftId}`);
    await page.waitForSelector("#work-h");
    await openMap(page);
    await selectViaGoTo(page, "FULL-CABIN");
    await axe(page, "visit-map");
  });
  await check("screen-reader oriented structure: landmarks, headings, labels, live regions", async () => {
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
          (e.tagName === "BUTTON" && e.textContent!.trim());
        return !label;
      }).length,
      tabs: Array.from(document.querySelectorAll("[role=tab]")).map((t) => t.getAttribute("aria-selected")),
      live: document.querySelectorAll("[role=status], [role=alert], [aria-live]").length,
      seatLabel: document.querySelector("button[data-seat='7C']")?.getAttribute("aria-label"),
      canvasFocusable: null as string | null,
      lang: document.documentElement.lang,
    }));
    equal(facts.landmarks, [1, 1, 1, 1], "one header, nav, main and footer");
    equal([facts.h1, facts.unlabeled, facts.lang], [1, 0, "en"], "one h1, no unlabeled controls, lang set");
    equal(facts.tabs, ["false", "true"], "tab state exposed");
    expect(facts.live >= 4, "live regions present");
    expect(facts.seatLabel!.includes("Seat 7C") && facts.seatLabel!.includes("recorded"), `seat label carries state: ${facts.seatLabel}`);
    await page.click("#tab-3d");
    await waitFor3D(page);
    const canvas = await page.evaluate(() => {
      const c = document.querySelector("canvas")!;
      return {
        tabindex: c.getAttribute("tabindex"),
        role: c.getAttribute("role"),
        keys: document.getElementById(c.getAttribute("aria-describedby") ?? "")?.textContent ?? "",
      };
    });
    expect(
      canvas.tabindex === "0" && canvas.role === "application" && canvas.keys.includes("Map and list"),
      "canvas is focusable, has a role, and its description points keyboard users to the map",
    );
  });

  // ---------------------------------------------------------------------------------------
  group = "mobile viewport";
  console.log(`\n${group}`);
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const m = await mobile.newPage();
  let mobileVisit = "";
  await check("mobile: lookup, start visit, no horizontal overflow", async () => {
    await m.goto(`${server.url}/#/check`);
    await m.waitForSelector("input[name=tail]");
    await m.fill("input[name=technician]", "Mobile Tech");
    await m.fill("input[name=tail]", "N100TL");
    await m.fill("input[name=date]", "2026-11-12");
    await m.tap("form.lookup-form button[type=submit]");
    await m.waitForSelector(".status-card[data-state=RESOLVED]");
    await m.tap("text=Start visit (saves a draft)");
    await m.waitForSelector("#work-h");
    mobileVisit = await m.evaluate(() => location.hash.split("/")[2] ?? "");
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow <= 1, `page overflows horizontally by ${overflow}px`);
  });
  await check("mobile: 3D renders in portrait framing and a tap picks a seat", async () => {
    await waitFor3D(m);
    await settle(m, 700);
    expect(await canvasIsPainted(m), "canvas painted");
    await m.locator("canvas").screenshot({ path: join(CAPTURES, "mobile-full-cabin-cutaway_photo-navy-band_neutral.png") });
    await m.evaluate(() => window.__cabinKit!.scene!.setCamera("focus", "SEAT:6D"));
    await settle(m);
    await m.locator("canvas").scrollIntoViewIfNeeded();
    const point = await m.evaluate(() => window.__cabinKit!.scene!.screenPointOf("SEAT:6D", "head"));
    expect(point !== null, "point");
    await m.touchscreen.tap(point!.x, point!.y);
    await m.waitForFunction(() => document.querySelector("#inspector-heading")?.textContent === "Seat 6D");
  });
  await check("mobile: the end of a two-finger gesture selects nothing and a URL-bar resize keeps a moved camera", async () => {
    const near = (await m.evaluate(() => window.__cabinKit!.scene!.screenPointOf("SEAT:6D", "head")))!;
    const other = (await m.evaluate(() => window.__cabinKit!.scene!.screenPointOf("SEAT:6E", "head")))!;
    const cdp = await m.context().newCDPSession(m);
    const finger = (id: number, p: { x: number; y: number }, dx = 0) => ({ x: p.x + dx, y: p.y, id, radiusX: 4, radiusY: 4, force: 1 });
    // Two fingers down, then lifted one at a time without moving: a pinch held still, then a two-finger tap on one seat.
    const gestures: [ReturnType<typeof finger>, ReturnType<typeof finger>][] = [
      [finger(1, near), finger(2, other)],
      [finger(1, other), finger(2, other, 3)],
    ];
    for (const [a, b] of gestures) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [a] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [a, b] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [b] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await settle(m, 300);
      equal(await m.textContent("#inspector-heading"), "Seat 6D", "a two-finger gesture selected nothing");
    }
    await cdp.detach();
    // from the default view, which a resize re-frames, orbit by hand
    await m.tap(".toolbar button:has-text('Reset')");
    await m.tap(".toolbar button[aria-label='Rotate left']");
    await settle(m, 500);
    const moved = await cameraOf(m);
    // the URL bar showing and collapsing changes the viewport height
    await m.setViewportSize({ width: 390, height: 760 });
    await settle(m, 400);
    await m.setViewportSize({ width: 390, height: 844 });
    await settle(m, 400);
    sameCamera(await cameraOf(m), moved, "after the viewport height changed");
    equal((await sceneInfo(m)).view, "free", "a nudge leaves the preset");
  });
  await check("mobile: record through the map with touch-sized targets, complete and read the report", async () => {
    await m.tap("#tab-map");
    await m.waitForSelector(".cabin-map");
    const sizes = await m.$$eval(".cabin-map button[data-seat]", (els) =>
      els
        .slice(0, 40)
        .map((e) => e.getBoundingClientRect())
        .map((r): [number, number] => [r.width, r.height]),
    );
    expect(
      sizes.every(([w, h]) => w >= 36 && h >= 40),
      `seat buttons are touch sized (min ${Math.min(...sizes.map((s) => s[0])).toFixed(0)}x${Math.min(...sizes.map((s) => s[1])).toFixed(0)})`,
    );
    await m.tap("button[data-seat='3A']");
    await m.waitForFunction(() => document.querySelector("#inspector-heading")?.textContent === "Seat 3A");
    await m.tap(".component-card[data-component=CUSHION] button[type=submit]");
    await m.locator(".component-card[data-component=CUSHION] .save-state.saved").waitFor();
    await m.fill("#goto-input", "FULL-CABIN");
    await m.press("#goto-input", "Enter");
    await m.waitForFunction(() => document.querySelector("#inspector-heading")?.textContent?.startsWith("Full cabin floor"));
    await m.locator(".component-card[data-component=CARPET_KIT] input[type=radio][value='FX-SUB-KIT-1']").check();
    await m.tap(".component-card[data-component=CARPET_KIT] button[type=submit]");
    await m.locator(".component-card[data-component=CARPET_KIT] .save-state.saved").waitFor();
    await m.screenshot({ path: join(OUT, "mobile-visit-map.png") });
    await m.tap(".worklist > button.primary");
    await m.tap(".confirm button.primary");
    await m.waitForSelector("#totals-table");
    const rows = await m.$$eval("#totals-table tbody tr", (trs) =>
      trs.map((tr) => [tr.getAttribute("data-part"), Number(tr.getAttribute("data-qty")), tr.getAttribute("data-unit")]),
    );
    equal(rows, SIX, "six totals on mobile");
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow <= 1, `report overflows horizontally by ${overflow}px`);
    await m.screenshot({ path: join(OUT, "mobile-report.png") });
    expect(mobileVisit.length === 36, "visit id");
  });
  await check("axe on mobile: visit map and report", async () => {
    await axe(m, "mobile-report");
    await m.goto(`${server.url}/#/check`);
    await m.waitForSelector("input[name=tail]");
    await axe(m, "mobile-check");
  });
  await mobile.close();

  group = "console";
  console.log(`\n${group}`);
  await check("no uncaught page errors during the desktop run", async () => {
    writeFileSync(join(OUT, "console-errors.json"), JSON.stringify(consoleErrors, null, 2));
    expect(consoleErrors.length === 0, `${consoleErrors.length} console/page errors: ${consoleErrors.slice(0, 3).join(" | ")}`);
  });

  await page.goto(`${server.url}/#/visit/${draftId}`);
  await page.reload();
  await page.waitForSelector("#work-h");
  await waitFor3D(page);
  await settle(page, 600);
  await page.screenshot({ path: join(OUT, "desktop-visit.png") });
  await page.goto(`${server.url}/#/visit/${visitId}/report`);
  await page.waitForSelector("#totals-table");
  await page.screenshot({ path: join(OUT, "desktop-report.png"), fullPage: true });

  const failed = results.filter((r) => r.status === "FAIL");
  const summary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      chrome: chromeVersion,
      os: `${platform()} ${release()}`,
      server: "real server process on a free loopback port with disposable stores",
    },
    totals: { checks: results.length, passed: results.length - failed.length, failed: failed.length },
    results,
  };
  writeFileSync(join(OUT, "e2e-results.json"), JSON.stringify(summary, null, 2));
  writeFileSync(
    join(OUT, "e2e-results.txt"),
    [
      `Cabin Kit end-to-end run ${startedAt}`,
      `Node ${process.version}, Chrome ${chromeVersion}, ${platform()} ${release()}`,
      `${summary.totals.passed}/${summary.totals.checks} passed`,
      "",
      ...results.map((r) => `${r.status}  [${r.group}] ${r.name}${r.detail ? `\n      ${r.detail}` : ""}`),
    ].join("\n") + "\n",
  );
  console.log(`\n${summary.totals.passed}/${summary.totals.checks} checks passed`);
  if (failed.length) process.exitCode = 1;
} finally {
  await browser?.close();
  await server.stop();
  server.cleanup();
}
