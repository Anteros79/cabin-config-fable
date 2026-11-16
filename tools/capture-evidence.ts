// Captures the verification evidence on purpose, never as a side effect of a test run (TST-05, decision D7).
//   npm run evidence:capture                    build the e2e client, then capture into verification/out/ (git-ignored)
//   npm run evidence:capture -- --promote       capture, then copy the curated subset into verification/
//   npm run evidence:capture -- --promote-only  copy what an earlier capture left in verification/out/ (look first, then promote);
//                                               add --force when that capture was made at another commit than HEAD
//   npm run evidence:capture -- --assert-perf   also fail when the frame rate is under 30 fps or a pick takes over 250 ms
//
// It starts a disposable server on the e2e build (e2e/server.ts: temp stores, port 0, never ./data), drives the bundled
// Chromium with Playwright's library API and writes to verification/out/: 18 captures (17 desktop, 1 mobile) and captures.json, sample visits,
// reports, PDFs and CSV, performance.json, webgl.json, framing.json, axe JSON (light, dark, mobile), the comparison sheets
// (tools/make-comparisons.mjs) and vitest-output.txt. The sample visits are written with fixed idempotency keys and a
// fixed clock, so their ids differ between runs but their content, totals and report body do not. The capture time is
// recorded in PROVENANCE.json, but it is not the only time in the output: the PDFs Chromium prints (the browser-printed
// report and preparation list) carry their own creation date, and PNG and PDF bytes differ between machines and runs.
// Promotion is a human decision.
// PROVENANCE.json names the exact commit the renders were built from. A capture made with changes outside verification/
// records them (`git diff HEAD --stat` and the sha256 of `git diff HEAD`) and can never be promoted: commit first.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { cpus, release as osRelease, platform, totalmem } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, chromium, type Page } from "@playwright/test";
import { canvasIsPainted, clickLocation, openMap, SIX, scene, sceneCall, selectLocation, setCamera, settle, waitFor3D } from "../e2e/helpers.ts";
import { PROJECT_ROOT, startServer, type TestServer } from "../e2e/server.ts";
import { lookup } from "../src/domain/resolve.ts";
import type { ReferenceRelease } from "../src/domain/types.ts";
import { buildSnapshot } from "../src/domain/visitLogic.ts";
import { isEntryPoint, parseCliArgs, UsageError } from "../src/importer/args.ts";
import { renderReportPdf } from "../src/server/pdf.ts";
import { ReferenceStore } from "../src/server/referenceStore.ts";
import { VisitStore } from "../src/server/visitStore.ts";

const VERIFICATION = join(PROJECT_ROOT, "verification");
const OUT = join(VERIFICATION, "out");
const CAPTURES = join(OUT, "captures");
const SAMPLES = join(OUT, "samples");
const AXE = join(OUT, "axe");
/** What --promote copies from verification/out/ into verification/. Everything else stays in out/. */
const CURATED_DIRS = ["captures", "comparisons", "samples"] as const;
const CURATED_FILES = ["performance.json", "PROVENANCE.json"] as const;

/** The sample visits' clock: every stored timestamp in them is this instant. */
const SAMPLE_NOW = "2026-11-12T09:00:00.000Z";
const SAMPLE_TAIL = "N100TL";
const SAMPLE_DATE = "2026-11-12";
const SAMPLE_TECHNICIAN = "Sample Technician (fictional)";
/** The README walk-through: seat 3A cushion, and the full-cabin carpet kit replaced by its approved alternate. */
const SAMPLE_RECORDS = [
  { locationId: "SEAT:3A", componentId: "CUSHION", selection: "PRIMARY", substituteId: null, quantity: 1, note: "Sample: torn seam on the leading edge." },
  {
    locationId: "FLOOR:FULL-CABIN",
    componentId: "CARPET_KIT",
    selection: "ALTERNATE",
    substituteId: "FX-SUB-KIT-1",
    quantity: 1,
    note: "Sample: alternate kit used under the fictional deviation.",
  },
];

const LAYOUT = "FX-L-S176-MAX8@1";
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
/** Same browser arguments as playwright.config.ts: the platform GPU, or SwiftShader on Linux. */
const LAUNCH_ARGS = process.platform === "linux" ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : [];
const PERF_TARGET = { fps: 30, pickMs: 250 };

type Layers = { seats: boolean; floor: boolean; bins: boolean; context: boolean };
const NO_CONTEXT: Layers = { seats: true, floor: true, bins: true, context: false };
const WITH_CONTEXT: Layers = { seats: true, floor: true, bins: true, context: true };

/** The capture tool cannot go on; the message says why. */
class CaptureError extends Error {}

const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

async function getJson<T>(server: TestServer, path: string): Promise<T> {
  const res = await fetch(`${server.baseURL}${path}`);
  if (!res.ok) throw new CaptureError(`GET ${path} answered ${res.status}`);
  return (await res.json()) as T;
}

async function getBytes(server: TestServer, path: string): Promise<Uint8Array> {
  const res = await fetch(`${server.baseURL}${path}`);
  if (!res.ok) throw new CaptureError(`GET ${path} answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function newVisit(server: TestServer, technician: string): Promise<string> {
  const res = await fetch(`${server.baseURL}/api/visits`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tail: SAMPLE_TAIL, checkDate: SAMPLE_DATE, technician }),
  });
  if (res.status !== 201 && res.status !== 200) throw new CaptureError(`POST /api/visits answered ${res.status}`);
  return ((await res.json()) as { visit: { id: string } }).visit.id;
}

async function openVisit3D(page: Page, server: TestServer, visitId: string): Promise<void> {
  await page.goto(`${server.baseURL}/#/visit/${visitId}`);
  await page.waitForSelector("#work-h");
  await waitFor3D(page);
  await settle(page);
}

/**
 * Two sample visits on N100TL, written straight into the server's temp visit store with fixed idempotency keys and a
 * fixed clock: a completed one and a draft with the same two records. Returns their ids.
 */
function createSampleVisits(server: TestServer): {
  completedId: string;
  draftId: string;
  draftPreview: ReturnType<VisitStore["getReport"]>;
  releaseId: string;
} {
  const referencePath = join(server.dataDir, "reference.sqlite");
  const visitsPath = join(server.dataDir, "visits.sqlite");
  const reference = ReferenceStore.open(referencePath, visitsPath, { readOnly: true });
  let release: ReferenceRelease;
  try {
    release = reference.loadActive();
  } finally {
    reference.close();
  }
  const result = lookup(release, SAMPLE_TAIL, SAMPLE_DATE);
  if (result.state !== "RESOLVED") throw new CaptureError(`the sample lookup ${SAMPLE_TAIL} ${SAMPLE_DATE} is ${result.state}, not RESOLVED`);
  const store = VisitStore.open(visitsPath, referencePath);
  try {
    const create = (name: string) => {
      const options = (step: string) => ({ idempotencyKey: `evidence-${name}-${step}`, now: SAMPLE_NOW });
      const { visit } = store.createVisit(buildSnapshot(release, result, SAMPLE_NOW), SAMPLE_TECHNICIAN, options("create"));
      SAMPLE_RECORDS.forEach((record, i) => {
        store.upsertRecord(visit.id, record, 0, options(`record-${i}`));
      });
      return visit.id;
    };
    const completedId = create("completed");
    store.completeVisit(completedId, undefined, { idempotencyKey: "evidence-completed-complete", now: SAMPLE_NOW });
    const draftId = create("draft");
    // the draft preview is built on request; the API would stamp it with the time of the request, the store takes the clock
    const draftPreview = store.getReport(draftId, SAMPLE_NOW);
    return { completedId, draftId, draftPreview, releaseId: release.id };
  } finally {
    store.close();
  }
}

/** Sample visits, their reports as JSON and PDF, the report printed by the browser, and the preparation CSV and print. */
async function writeSamples(server: TestServer, browser: Browser): Promise<{ completedId: string; draftId: string; releaseId: string }> {
  const { completedId, draftId, draftPreview, releaseId } = createSampleVisits(server);
  const report = await getJson<{ report: { reportKind: string; totals: { partNo: string; quantity: number; unit: string }[] } }>(
    server,
    `/api/visits/${completedId}/report`,
  );
  const totals = report.report.totals.map((t) => [t.partNo, t.quantity, t.unit]);
  if (JSON.stringify(totals) !== JSON.stringify(SIX)) throw new CaptureError(`the sample report's totals are ${JSON.stringify(totals)}, not the six expected`);
  writeJson(join(SAMPLES, "sample-completed-visit.json"), await getJson(server, `/api/visits/${completedId}`));
  writeJson(join(SAMPLES, "sample-completed-report.json"), report);
  writeFileSync(join(SAMPLES, "sample-completed-report.pdf"), await getBytes(server, `/api/visits/${completedId}/report.pdf`));
  writeJson(join(SAMPLES, "sample-draft-visit.json"), await getJson(server, `/api/visits/${draftId}`));
  writeJson(join(SAMPLES, "sample-draft-report-preview.json"), draftPreview);
  // the same renderer the server uses, on the fixed-clock preview, so the PDF and the JSON carry the same generation time
  writeFileSync(
    join(SAMPLES, "sample-draft-report-preview.pdf"),
    await renderReportPdf(draftPreview.report, draftPreview.linkedEvents, draftPreview.basisSha256),
  );
  const prep = `/api/preparation?tail=${SAMPLE_TAIL}&date=${SAMPLE_DATE}`;
  writeFileSync(join(SAMPLES, `sample-preparation-${SAMPLE_TAIL}-${SAMPLE_DATE}.csv`), await getBytes(server, `${prep}&format=csv`));

  const context = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1, locale: "en-GB", timezoneId: "UTC" });
  try {
    const page = await context.newPage();
    await page.goto(`${server.baseURL}/#/visit/${completedId}/report`);
    await page.waitForSelector("#totals-table");
    writeFileSync(join(SAMPLES, "sample-completed-report-browser-print.pdf"), await page.pdf({ format: "Letter", printBackground: true }));
    await page.goto(`${server.baseURL}/#/prep?tail=${SAMPLE_TAIL}&date=${SAMPLE_DATE}`);
    await page.waitForSelector("#prep-table tbody tr");
    writeFileSync(join(SAMPLES, `sample-preparation-${SAMPLE_TAIL}-${SAMPLE_DATE}.pdf`), await page.pdf({ format: "Letter", printBackground: true }));
  } finally {
    await context.close();
  }
  return { completedId, draftId, releaseId };
}

interface CaptureMeta {
  file: string;
  referenceRelease: string;
  geometryVersion: string;
  layout: string;
  profile: string;
  light: string;
  cameraView: string;
  location: string | null;
  layers: Layers;
  camera: unknown;
  viewport: { width: number; height: number; deviceScaleFactor: number };
}

/** webgl.json, framing.json, the 17 desktop captures and performance.json, from one desktop page on an empty visit. */
async function captureDesktop(server: TestServer, browser: Browser, releaseId: string): Promise<{ captures: CaptureMeta[]; performance: PerfRecord }> {
  const context = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1, locale: "en-GB", timezoneId: "UTC" });
  await context.addInitScript(() => localStorage.setItem("cabin-kit.hint.3d", "dismissed"));
  try {
    const page = await context.newPage();
    await openVisit3D(page, server, await newVisit(server, "Capture Technician (fictional)"));
    if (!(await canvasIsPainted(page))) throw new CaptureError("the 3D canvas is blank: no WebGL render to capture");

    const gl = await page.evaluate(() => {
      const c = document.createElement("canvas");
      const g = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
      const ext = g?.getExtension("WEBGL_debug_renderer_info");
      return g ? { version: String(g.getParameter(g.VERSION)), renderer: ext ? String(g.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unknown" } : null;
    });
    if (!gl) throw new CaptureError("no WebGL context");
    writeJson(join(OUT, "webgl.json"), { ...gl, scene: await scene(page) });

    await setCamera(page, "cutaway");
    const framing = await page.evaluate(() => {
      const s = window.__cabinKit?.scene as unknown as {
        layout: { locations: { id: string; kind: string }[] };
        screenPointOf(id: string): { x: number; y: number };
      };
      const canvas = document.querySelector("canvas");
      if (!s || !canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const pts = s.layout.locations.filter((l) => l.kind === "SEAT").map((l) => s.screenPointOf(l.id));
      const xs = pts.map((p) => p.x - rect.left);
      const ys = pts.map((p) => p.y - rect.top);
      return {
        view: "cutaway",
        inside: pts.every((p) => p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom),
        width: (Math.max(...xs) - Math.min(...xs)) / rect.width,
        height: (Math.max(...ys) - Math.min(...ys)) / rect.height,
      };
    });
    writeJson(join(OUT, "framing.json"), framing);

    // Captures show the render only. A constructable stylesheet is CSSOM, so it works under the app's strict style-src.
    await page.evaluate(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(".legend, .hover-label { visibility: hidden !important; }");
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    });
    const captures: CaptureMeta[] = [];
    const capture = async (name: string, profile: string, light: string, view: string, location: string | null, layers: Layers) => {
      await sceneCall(page, "setProfile", profile);
      await sceneCall(page, "setLight", light);
      await sceneCall(page, "setColourMode", "none");
      await sceneCall(page, "setSelection", null);
      await sceneCall(page, "setLayers", layers);
      await setCamera(page, view, location ?? undefined);
      const file = `${name}.png`;
      await page.locator("canvas").screenshot({ path: join(CAPTURES, file) });
      const box = await page.locator("canvas").boundingBox();
      captures.push({
        file,
        referenceRelease: releaseId,
        geometryVersion: "cabin-kit.geometry/1",
        layout: LAYOUT,
        profile,
        light,
        cameraView: view,
        location,
        layers,
        camera: (await scene(page)).camera,
        viewport: { width: Math.round(box?.width ?? 0), height: Math.round(box?.height ?? 0), deviceScaleFactor: 1 },
      });
    };
    for (const light of ["neutral", "blue"]) {
      await capture(`full-cabin-cutaway_photo-navy-band_${light}`, "photo-navy-band", light, "cutaway", null, NO_CONTEXT);
      await capture(`full-cabin-aisle_photo-navy-band_${light}`, "photo-navy-band", light, "aisle", null, WITH_CONTEXT);
      await capture(`seat-front_photo-navy-band_${light}`, "photo-navy-band", light, "focus", "SEAT:7C", WITH_CONTEXT);
      await capture(`seat-rear_photo-navy-band_${light}`, "photo-navy-band", light, "focus-rear", "SEAT:7C", WITH_CONTEXT);
      await capture(`carpet_photo-navy-band_${light}`, "photo-navy-band", light, "carpet", null, NO_CONTEXT);
      await capture(`bin-detail_photo-navy-band_${light}`, "photo-navy-band", light, "bins", null, WITH_CONTEXT);
    }
    await capture("full-cabin-overhead_photo-navy-band_neutral", "photo-navy-band", "neutral", "overhead", null, NO_CONTEXT);
    await capture("seat-front_photo-navy-plain_blue", "photo-navy-plain", "blue", "focus", "SEAT:7C", WITH_CONTEXT);
    await capture("seat-front_photo-navy-plain_neutral", "photo-navy-plain", "neutral", "focus", "SEAT:7C", WITH_CONTEXT);
    await capture("seat-front_concept-gray_neutral", "concept-gray", "neutral", "focus", "SEAT:7C", WITH_CONTEXT);
    await capture("full-cabin-cutaway_concept-gray_neutral", "concept-gray", "neutral", "cutaway", null, NO_CONTEXT);

    // performance: a fresh page in the default settings, then 10 pointer picks
    await page.reload();
    await waitFor3D(page);
    await settle(page);
    const fps = await page.evaluate(() => {
      const s = window.__cabinKit?.scene;
      if (!s) throw new Error("test hooks missing (not the e2e build?)");
      return s.measure(4000);
    });
    await page.evaluate(() => {
      if (window.__cabinKit?.scene) window.__cabinKit.scene.pickLatencies.length = 0;
    });
    for (const seat of ["SEAT:5C", "SEAT:8D", "SEAT:11C", "SEAT:14D", "SEAT:18C", "SEAT:22D", "SEAT:3C", "SEAT:9D", "SEAT:16C", "SEAT:25D"]) {
      await setCamera(page, "focus", seat);
      await clickLocation(page, seat);
      await page.waitForFunction((label) => document.querySelector("#inspector-heading")?.textContent === label, `Seat ${seat.split(":")[1]}`);
      await settle(page);
    }
    const latencies = await page.evaluate(() => [...(window.__cabinKit?.scene?.pickLatencies ?? [])]);
    const info = await scene(page);
    const sorted = [...latencies].sort((a, b) => a - b);
    const performance: PerfRecord = {
      device: {
        cpu: cpus()[0]?.model ?? "unknown",
        cores: cpus().length,
        memoryGb: Math.round(totalmem() / 2 ** 30),
        os: `${platform()} ${osRelease()}`,
        browser: `Chromium ${browser.version()} (headless)`,
        webgl: gl.renderer,
      },
      viewport: { ...DESKTOP, deviceScaleFactor: 1 },
      scene: { layout: LAYOUT, seats: info.seats, renderer: info.renderer },
      frameRate: {
        method:
          "continuous orbit for 4 s with seats, floor and bins visible (context layer off), rendering each animation frame; headless Chromium caps at the display refresh rate",
        fps: Number(fps.fps.toFixed(1)),
        frames: fps.frames,
        worstFrameMs: Number(fps.worstFrameMs.toFixed(1)),
        target: `about ${PERF_TARGET.fps} fps`,
      },
      selectionFeedback: {
        method: "pointer pick to the next rendered frame showing the selection, 10 picks",
        samplesMs: latencies.map((v) => Number(v.toFixed(1))),
        maxMs: Number(Math.max(...latencies).toFixed(1)),
        medianMs: Number((sorted[Math.floor(sorted.length / 2)] ?? Number.NaN).toFixed(1)),
        target: `within ${PERF_TARGET.pickMs} ms`,
      },
    };
    writeJson(join(OUT, "performance.json"), performance);
    return { captures, performance };
  } finally {
    await context.close();
  }
}

interface PerfRecord {
  device: { cpu: string; cores: number; memoryGb: number; os: string; browser: string; webgl: string };
  viewport: { width: number; height: number; deviceScaleFactor: number };
  scene: { layout: string; seats: unknown; renderer: unknown };
  frameRate: { method: string; fps: number; frames: number; worstFrameMs: number; target: string };
  selectionFeedback: { method: string; samplesMs: number[]; maxMs: number; medianMs: number; target: string };
}

/** The 18th capture, the only mobile one: the default cutaway at phone size, as a 390 × 844 touch viewport shows it. */
async function captureMobile(server: TestServer, browser: Browser, releaseId: string): Promise<CaptureMeta> {
  const context = await browser.newContext({ viewport: MOBILE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-GB", timezoneId: "UTC" });
  await context.addInitScript(() => localStorage.setItem("cabin-kit.hint.3d", "dismissed"));
  try {
    const page = await context.newPage();
    await openVisit3D(page, server, await newVisit(server, "Mobile Capture Technician (fictional)"));
    const file = "mobile-full-cabin-cutaway_photo-navy-band_neutral.png";
    await page.locator("canvas").screenshot({ path: join(CAPTURES, file) });
    const box = await page.locator("canvas").boundingBox();
    const info = await scene(page);
    return {
      file,
      referenceRelease: releaseId,
      geometryVersion: "cabin-kit.geometry/1",
      layout: LAYOUT,
      profile: String(info.profile),
      light: String(info.light),
      cameraView: String(info.view),
      location: null,
      layers: info.layers as Layers,
      camera: info.camera,
      viewport: { width: Math.round(box?.width ?? 0), height: Math.round(box?.height ?? 0), deviceScaleFactor: 2 },
    };
  } finally {
    await context.close();
  }
}

/** axe (WCAG 2.1 A and AA, every impact) on each view, in the light and dark themes and at phone width. Recorded, not asserted: test:e2e asserts. */
async function writeAxe(server: TestServer, browser: Browser, visits: { completedId: string; draftId: string }): Promise<number> {
  const views: { label: string; hash: string; ready: string; mobile?: boolean; prepare?: (page: Page) => Promise<void> }[] = [
    { label: "check", hash: "#/check", ready: "input[name=tail]", mobile: true },
    { label: "preparation", hash: `#/prep?tail=${SAMPLE_TAIL}&date=${SAMPLE_DATE}`, ready: "#prep-table tbody tr" },
    { label: "layouts", hash: "#/layouts", ready: "table" },
    { label: "reference", hash: "#/reference", ready: ".findings" },
    { label: "visits", hash: "#/visits", ready: "tbody tr" },
    { label: "visit-3d", hash: `#/visit/${visits.draftId}`, ready: "#work-h", prepare: waitFor3D },
    {
      label: "visit-map",
      hash: `#/visit/${visits.draftId}`,
      ready: "#work-h",
      prepare: async (page) => {
        await openMap(page);
        await selectLocation(page, "Full cabin floor");
      },
    },
    { label: "report", hash: `#/visit/${visits.completedId}/report`, ready: "#totals-table", mobile: true },
  ];
  let violations = 0;
  for (const theme of [
    { prefix: "", options: { viewport: DESKTOP, colorScheme: "light" as const } },
    { prefix: "dark-", options: { viewport: DESKTOP, colorScheme: "dark" as const } },
    { prefix: "mobile-", options: { viewport: MOBILE, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: "light" as const } },
  ]) {
    const context = await browser.newContext({ ...theme.options, locale: "en-GB", timezoneId: "UTC" });
    await context.addInitScript(() => localStorage.setItem("cabin-kit.hint.3d", "dismissed"));
    try {
      const page = await context.newPage();
      for (const view of views) {
        if (theme.prefix === "mobile-" && !view.mobile) continue;
        await page.goto(`${server.baseURL}/${view.hash}`);
        await page.locator(view.ready).first().waitFor();
        if (view.prepare) await view.prepare(page);
        const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        violations += result.violations.length;
        writeJson(join(AXE, `axe-${theme.prefix}${view.label}.json`), {
          view: `${theme.prefix}${view.label}`,
          url: page.url().replace(server.baseURL, ""),
          violations: result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, sample: v.nodes[0]?.html })),
          passes: result.passes.length,
        });
      }
    } finally {
      await context.close();
    }
  }
  return violations;
}

interface SourceState {
  /** the full SHA of HEAD: the commit the renders were built from */
  commit: string;
  /** present only when files outside verification/ differ from HEAD; such a capture is never promoted */
  uncommitted?: { diffStat: string; diffSha256: string; untracked: string[] };
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: PROJECT_ROOT, encoding: "utf8", maxBuffer: 256 * 2 ** 20 });

/** HEAD, and what differs from it outside verification/ (tracked changes and untracked files). */
function sourceState(): SourceState {
  const commit = git("rev-parse", "HEAD").trim();
  const outside = ["--", ".", ":(exclude)verification"];
  const diffStat = git("diff", "HEAD", "--stat", ...outside).trim();
  const untracked = git("ls-files", "--others", "--exclude-standard", ...outside)
    .split("\n")
    .filter((line) => line !== "");
  if (diffStat === "" && untracked.length === 0) return { commit };
  return {
    commit,
    uncommitted: {
      diffStat,
      diffSha256: createHash("sha256")
        .update(git("diff", "HEAD", ...outside))
        .digest("hex"),
      untracked,
    },
  };
}

const DIRTY_MESSAGE = "files outside verification/ differ from HEAD; commit them first so PROVENANCE.json names the commit the renders come from";

/** Runs a command in the project, its output to the console; true when it exits 0. */
function run(command: string, args: string[]): boolean {
  return spawnSync(command, args, { cwd: PROJECT_ROOT, stdio: "inherit" }).status === 0;
}

async function capture(assertPerf: boolean): Promise<number> {
  const source = sourceState();
  if (source.uncommitted) console.warn(`Warning: ${DIRTY_MESSAGE}. This capture cannot be promoted.`);
  if (!existsSync(join(PROJECT_ROOT, "dist", "web-e2e", "index.html"))) throw new CaptureError('No e2e build in dist/web-e2e. Run "npm run build:e2e" first.');
  rmSync(OUT, { recursive: true, force: true });
  for (const dir of [CAPTURES, SAMPLES, AXE]) mkdirSync(dir, { recursive: true });
  const capturedAt = new Date().toISOString();

  const server = await startServer();
  const browser = await chromium.launch({ channel: "chromium", args: LAUNCH_ARGS });
  let performance: PerfRecord;
  const browserVersion = `Chromium ${browser.version()} (headless)`;
  try {
    const samples = await writeSamples(server, browser);
    console.log(`samples written to ${SAMPLES}`);
    const desktop = await captureDesktop(server, browser, samples.releaseId);
    const mobile = await captureMobile(server, browser, samples.releaseId);
    performance = desktop.performance;
    writeJson(join(CAPTURES, "captures.json"), {
      note: "Actual renders of this build. Geometry is an illustrative approximation. When and where they were captured: PROVENANCE.json.",
      browser: browserVersion,
      captures: [...desktop.captures, mobile],
    });
    console.log(`${desktop.captures.length + 1} captures written to ${CAPTURES}`);
    const axeViolations = await writeAxe(server, browser, samples);
    console.log(`axe results written to ${AXE} (${axeViolations} violations)`);
  } finally {
    await browser.close();
    await server.dispose();
  }

  const cpu = cpus()[0]?.model ?? "unknown CPU";
  writeJson(join(OUT, "PROVENANCE.json"), {
    capturedAt,
    commit: source.commit,
    machine: `${cpu}, ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB, ${platform()} ${osRelease()}`,
    node: process.version,
    browser: browserVersion,
    ...(source.uncommitted ? { uncommitted: source.uncommitted } : {}),
  });

  let failed = 0;
  if (!run(process.execPath, [join("tools", "make-comparisons.mjs")])) {
    console.error("The comparison sheets were not made.");
    failed = 1;
  }
  const vitest = spawnSync("npx", ["vitest", "run", "--reporter", "verbose"], { cwd: PROJECT_ROOT, encoding: "utf8", maxBuffer: 64 * 2 ** 20 });
  writeFileSync(join(OUT, "vitest-output.txt"), `${vitest.stdout ?? ""}${vitest.stderr ?? ""}`);
  if (vitest.status !== 0) {
    console.error(`vitest failed (exit ${vitest.status}); see ${join(OUT, "vitest-output.txt")}`);
    failed = 1;
  }

  const { fps } = performance.frameRate;
  const { maxMs } = performance.selectionFeedback;
  console.log(`frame rate ${fps} fps (target ${PERF_TARGET.fps}); selection feedback max ${maxMs} ms (target ${PERF_TARGET.pickMs})`);
  if (assertPerf && (!(fps >= PERF_TARGET.fps) || !(maxMs <= PERF_TARGET.pickMs) || performance.selectionFeedback.samplesMs.length < 10)) {
    console.error("--assert-perf: the performance targets were not met on this machine.");
    failed = 1;
  }
  console.log(`Evidence captured in ${OUT}`);
  return failed;
}

/**
 * Copies the curated subset from verification/out/ into verification/, replacing captures/, comparisons/ and samples/
 * wholesale. Everything is first copied into a staging folder; only then is each target swapped in by rename, and the
 * previous version is removed last, so a failed copy leaves verification/ as it was.
 */
function promote(force: boolean): void {
  const missing = [...CURATED_DIRS, ...CURATED_FILES].filter((name) => !existsSync(join(OUT, name)));
  if (missing.length > 0)
    throw new CaptureError(
      `Nothing promoted: ${missing.join(", ")} missing from ${OUT}. Capture first (the comparison sheets need the image originals in ../../ or CABIN_KIT_SOURCE_ROOT).`,
    );
  const provenance = JSON.parse(readFileSync(join(OUT, "PROVENANCE.json"), "utf8")) as SourceState & { capturedAt: string };
  if (provenance.uncommitted) throw new CaptureError(`Nothing promoted: when this capture was made, ${DIRTY_MESSAGE}.`);
  const now = sourceState();
  if (now.uncommitted) throw new CaptureError(`Nothing promoted: ${DIRTY_MESSAGE}.`);
  if (provenance.commit !== now.commit) {
    if (!force)
      throw new CaptureError(
        `Nothing promoted: the capture in ${OUT} was made at ${provenance.commit}, but HEAD is ${now.commit}. Capture again, or add --force to promote it as made at ${provenance.commit}.`,
      );
    console.warn(`Warning: promoting a capture made at ${provenance.commit}, not at HEAD (${now.commit}).`);
  }

  const names = [...CURATED_DIRS, ...CURATED_FILES];
  const staging = join(VERIFICATION, `.promote-${process.pid}`);
  const previous = join(VERIFICATION, `.previous-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  rmSync(previous, { recursive: true, force: true });
  try {
    for (const name of names) cpSync(join(OUT, name), join(staging, name), { recursive: true });
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  mkdirSync(previous);
  const moved: string[] = [];
  try {
    for (const name of names) {
      if (existsSync(join(VERIFICATION, name))) {
        renameSync(join(VERIFICATION, name), join(previous, name));
        moved.push(name);
      }
      renameSync(join(staging, name), join(VERIFICATION, name));
    }
  } catch (e) {
    // put back what was there; whatever of the new copy was swapped in is replaced by it
    for (const name of moved) {
      rmSync(join(VERIFICATION, name), { recursive: true, force: true });
      renameSync(join(previous, name), join(VERIFICATION, name));
    }
    rmSync(staging, { recursive: true, force: true });
    rmSync(previous, { recursive: true, force: true });
    throw e;
  }
  rmSync(staging, { recursive: true, force: true });
  rmSync(previous, { recursive: true, force: true });
  console.log(`Promoted ${[...CURATED_DIRS.map((d) => `${d}/`), ...CURATED_FILES].join(", ")} (captured ${provenance.capturedAt} at ${provenance.commit}).`);
  console.log("Look at every promoted image, update the judgments in verification/README.md, then commit by hand.");
}

async function main(argv: string[]): Promise<number> {
  let flags: { promote?: boolean; "promote-only"?: boolean; "assert-perf"?: boolean; force?: boolean };
  try {
    flags = parseCliArgs(argv, {
      promote: { type: "boolean" },
      "promote-only": { type: "boolean" },
      "assert-perf": { type: "boolean" },
      force: { type: "boolean" },
    });
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`${e.message}\nUsage: node tools/capture-evidence.ts [--promote | --promote-only [--force]] [--assert-perf]`);
    return 64;
  }
  if (flags.force && !flags["promote-only"]) {
    console.error("--force applies only to --promote-only\nUsage: node tools/capture-evidence.ts [--promote | --promote-only [--force]] [--assert-perf]");
    return 64;
  }
  if (flags["promote-only"]) {
    promote(flags.force === true);
    return 0;
  }
  // refuse before a capture that could never be promoted
  if (flags.promote && sourceState().uncommitted) throw new CaptureError(`Nothing captured: --promote needs a clean tree, but ${DIRTY_MESSAGE}.`);
  const failed = await capture(flags["assert-perf"] === true);
  if (failed !== 0) {
    if (flags.promote) console.error("Nothing promoted: the capture did not complete cleanly.");
    return failed;
  }
  if (flags.promote) promote(false);
  return 0;
}

if (isEntryPoint(import.meta.url, import.meta.main)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof CaptureError ? e.message : `Evidence capture failed: ${(e as Error).stack ?? e}`);
    process.exitCode = 1;
  }
}
