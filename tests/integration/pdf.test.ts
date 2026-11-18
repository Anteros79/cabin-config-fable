import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { Report, VisitEvent } from "../../src/domain/types.ts";
import { renderReportPdf } from "../../src/server/pdf.ts";
import { CUSHION_3A, KIT_ALTERNATE, makeApp } from "../helpers.ts";

type App = ReturnType<typeof makeApp>;
const json = (res: { body: string }) => JSON.parse(res.body);
async function post(app: App, url: string, payload: unknown) {
  return app.app.inject({ method: "POST", url, payload: payload as object });
}
async function put(app: App, url: string, payload: unknown) {
  return app.app.inject({ method: "PUT", url, payload: payload as object });
}
async function newVisit(app: App, tail = "N100TL", checkDate = "2026-11-12") {
  const res = await post(app, "/api/visits", { tail, checkDate, technician: "Demo tech" });
  expect(res.statusCode).toBe(201);
  return json(res).visit as { id: string; version: number };
}

async function pdfText(bytes: Buffer): Promise<{ pages: number; text: string }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  return { pages: doc.numPages, text: parts.join("\n").replace(/\s+/g, " ") };
}

/**
 * The decoded bytes of every stream, each read by its /Length and inflated when it is FlateDecode; a malformed stream throws.
 * Searching from "stream" to the next "\nendstream" instead would drop the last byte of a compressed stream that ends in \r
 * (about 1 render in 1,000, as the ids and times in the page change), and the inflate would then fail.
 */
function pdfStreams(bytes: Buffer): string[] {
  const raw = bytes.toString("latin1");
  const streams: string[] = [];
  const head = />>\s*stream(\r\n|\n)/g;
  for (let m = head.exec(raw); m; m = head.exec(raw)) {
    const start = m.index + m[0].length;
    const dict = raw.slice(raw.lastIndexOf(" obj", m.index), m.index);
    if (/\/Length \d+ \d+ R\b/.test(dict)) throw new Error(`stream at byte ${m.index}: indirect /Length not supported`);
    const length = Number(/\/Length (\d+)\b/.exec(dict)?.[1]);
    if (!Number.isInteger(length)) throw new Error(`stream at byte ${m.index} has no direct /Length`);
    if (!/^\r?\nendstream/.test(raw.slice(start + length, start + length + 12)))
      throw new Error(`stream at byte ${m.index}: /Length does not end at endstream`);
    const data = bytes.subarray(start, start + length);
    streams.push((/\/Filter \/FlateDecode/.test(dict) ? inflateSync(data) : data).toString("latin1"));
    head.lastIndex = start + length;
  }
  return streams;
}

/** Every text run with its page and position (PDF user space: y is the baseline, measured up from the bottom edge). */
async function pdfItems(bytes: Buffer): Promise<{ page: number; str: string; y: number; height: number }[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 }).promise;
  const out: { page: number; str: string; y: number; height: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    for (const item of content.items) {
      if ("str" in item && item.str.trim()) out.push({ page: i, str: item.str, y: item.transform[5] as number, height: item.height });
    }
  }
  return out;
}

describe("reports: PDF and JSON agree with persisted work", () => {
  it("the six-line report matches in JSON, PDF and the stored records", async () => {
    const app = makeApp();
    const visit = await newVisit(app);
    await put(app, `/api/visits/${visit.id}/records`, { record: { ...CUSHION_3A, note: "Torn seam on leading edge" } });
    await put(app, `/api/visits/${visit.id}/records`, { record: KIT_ALTERNATE });
    const done = json(await post(app, `/api/visits/${visit.id}/complete`, { confirm: true }));
    const report = done.report as Report;

    // JSON vs persisted records
    const stored = json(await app.app.inject(`/api/visits/${visit.id}`)).visit;
    const fromRecords = new Map<string, number>();
    for (const r of stored.records) for (const l of r.lines) fromRecords.set(`${l.partNo}|${l.unit}`, (fromRecords.get(`${l.partNo}|${l.unit}`) ?? 0) + l.qty);
    expect(Object.fromEntries(report.totals.map((t) => [`${t.partNo}|${t.unit}`, t.quantity]))).toEqual(Object.fromEntries(fromRecords));
    for (const t of report.totals) expect(t.locations.reduce((n, l) => n + l.quantity, 0)).toBe(t.quantity);
    expect(report).toMatchObject({
      schema: "cabin-kit.report/2",
      reportKind: "FINAL",
      visit: { tail: "N100TL", checkDate: "2026-11-12", technician: "Demo tech", status: "COMPLETED" },
      configuration: { variantId: "V01", carpet: "MOHAWK", seam: "PRE", seatCount: 176, layoutRevisionId: "FX-L-S176-MAX8-LP@1", namespace: "fixture" },
      counts: { workItems: 2, replacements: 2, totalLines: 6, unresolvedComponents: 0 },
    });
    expect(report.authorityNotice).toMatch(/Not an approved maintenance authority/);
    expect(report.sources.map((s) => s.id)).toEqual(["FX-DOC-A", "FX-DOC-B", "FX-DOC-CONFIG", "FX-DOC-DEV"]);

    const download = await app.app.inject(`/api/visits/${visit.id}/report?download=1`);
    expect(download.headers["content-disposition"]).toMatch(/attachment; filename="cabin-kit-report-N100TL-2026-11-12-visit-1\.json"/);
    expect(json(download).report).toEqual(report);
    expect(json(download).basisSha256).toMatch(/^[0-9a-f]{64}$/);

    // PDF
    const pdfRes = await app.app.inject(`/api/visits/${visit.id}/report.pdf`);
    expect(pdfRes.statusCode).toBe(200);
    expect(pdfRes.headers["content-type"]).toBe("application/pdf");
    expect(pdfRes.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    const { text } = await pdfText(pdfRes.rawPayload);
    const flat = text.replace(/\s+/g, ""); // table cells wrap, so compare with whitespace removed
    expect(text).toContain("FINAL - visit completed and locked");
    expect(text).toContain("Not an approved maintenance authority");
    for (const t of report.totals) {
      expect(text).toContain(t.partNo);
      expect(text).toMatch(new RegExp(`${t.partNo}\\s.*?\\s${t.quantity}\\s+${t.unit}\\b`));
    }
    expect(flat).not.toContain("FAKE-CK-20011KIT");
    for (const expected of [
      "N100TL",
      "12Nov2026", // dates are written as on the web report (Task 5.8)
      "Demo tech",
      report.visit.id,
      "V01",
      "MOHAWK / PRE",
      "Seat 3A",
      "Torn seam on leading edge",
      "ALTERNATE FAKE-CK-2000 (replaces primary FAKE-CK-2001)",
      "FX-DOC-DEV",
      report.configuration.snapshotSha256,
    ]) {
      expect(flat).toContain(expected.replace(/\s+/g, ""));
    }
  });

  it("renders a long report across several pages with every work item present", async () => {
    const app = makeApp();
    const visit = await newVisit(app);
    const seats: string[] = [];
    for (let row = 1; row <= 30; row++) for (const letter of ["A", "C", "D", "F"]) seats.push(`${row}${letter}`);
    for (const seat of seats) {
      for (const componentId of ["CUSHION", "BACKREST"]) {
        const res = await put(app, `/api/visits/${visit.id}/records`, {
          record: { locationId: `SEAT:${seat}`, componentId, selection: "PRIMARY", quantity: 1, note: seat === "7C" ? "Stain" : "" },
        });
        expect(res.statusCode).toBe(200);
      }
    }
    const done = json(await post(app, `/api/visits/${visit.id}/complete`, { confirm: true }));
    const report = done.report as Report;
    expect(report.counts).toMatchObject({ workItems: 240, replacements: 240 });
    expect(report.totals.reduce((n, t) => n + t.quantity, 0)).toBe(240);
    const { pages, text } = await pdfText((await app.app.inject(`/api/visits/${visit.id}/report.pdf`)).rawPayload);
    expect(pages).toBeGreaterThan(3);
    expect(text).toContain(`Page 1 of ${pages}`);
    expect(text).toContain(`Page ${pages} of ${pages}`);
    for (const seat of ["1A", "15F", "30F"]) expect(text).toContain(`Seat ${seat}`);
    for (const t of report.totals) expect(text).toContain(t.partNo);
    // 30 rows of A covers: 5 ELR, 23 STD, 2 EXIT
    expect(report.totals.find((t) => t.partNo === "FAKE-SC-1001")?.quantity).toBe(5);
    expect(report.totals.find((t) => t.partNo === "FAKE-SC-1002")?.quantity).toBe(23);
  });

  it("a draft preview is marked as such and a PARTIAL visit prints its gaps", async () => {
    const app = makeApp();
    const visit = await newVisit(app, "N090TL");
    await put(app, `/api/visits/${visit.id}/records`, { record: CUSHION_3A });
    const { text } = await pdfText((await app.app.inject(`/api/visits/${visit.id}/report.pdf`)).rawPayload);
    expect(text).toContain("DRAFT PREVIEW - visit not completed");
    expect(text).toContain("Unresolved applicability gaps (170 components)");
    expect(text).toContain("Ambiguous");
    expect(text).toContain("expired after 2025-12-31");
  });
});

/** Build a stored FINAL report through the API so the PDF tests start from a real report. */
async function completedReport(app: App, note = ""): Promise<{ report: Report; basisSha256: string; id: string }> {
  const visit = await newVisit(app);
  await put(app, `/api/visits/${visit.id}/records`, { record: { ...CUSHION_3A, note } });
  const done = json(await post(app, `/api/visits/${visit.id}/complete`, { confirm: true }));
  const download = json(await app.app.inject(`/api/visits/${visit.id}/report?download=1`));
  return { report: done.report as Report, basisSha256: download.basisSha256 as string, id: visit.id };
}

function event(over: Partial<VisitEvent> & { note: string }): VisitEvent {
  const { note, ...rest } = over;
  return {
    id: "evt-1",
    visitId: "v",
    type: "ADVISORY",
    at: "2026-11-13T09:00:00.000Z",
    payload: { author: "JM", note },
    ...rest,
  } as VisitEvent;
}

/** `n` mandatory-child part lines, one printed line each in the parts cell. */
function manyLines(n: number): Report["work"][number]["lines"] {
  return Array.from({ length: n }, (_, i) => ({
    partNo: `LINEPART${i}`,
    description: "",
    qty: 1,
    unit: "EA",
    role: "MANDATORY_CHILD" as const,
    parentPartNo: null,
    sourceId: "FX-DOC-A",
  }));
}

/** `n` excluded rules, each with two reasons, as a work item with many rules not used would carry. */
function manyExclusions(n: number): Report["work"][number]["excludedRules"] {
  return Array.from({ length: n }, (_, i) => ({
    ruleId: `X-EXCL-${i}`,
    partNo: "FAKE-SC-1001",
    sourceId: "FX-DOC-A",
    reasons: [
      { code: "RULE_EXPIRED" as const, message: `Rule X-EXCL-${i} ended after 2026-11-11.` },
      { code: "SOURCE_NOT_RELEASED" as const, message: "Source FX-DOC-A rev 1 is not released." },
    ],
  }));
}

describe("PDF robustness and accessibility", () => {
  it("a 2000-character note is printed in full in the Notes section", async () => {
    const app = makeApp();
    const { report, basisSha256 } = await completedReport(app);
    const note = `START${"abcdefghij".repeat(199)}FINIS`;
    expect(note).toHaveLength(2000);
    const long = { ...report, work: report.work.map((w) => ({ ...w, note })) } as Report;
    const { pages, text } = await pdfText(await renderReportPdf(long, [], basisSha256));
    const flat = text.replace(/\s+/g, "");
    expect(text).toContain("See note 1");
    expect(text).toContain("Notes");
    expect(flat).toContain(note.slice(0, 40));
    expect(flat).toContain(note.slice(-40));
    expect(pages).toBeGreaterThan(1); // the note paginates rather than being cut off
  });

  it("short notes stay in the table and long linked-event notes are numbered with an E prefix", async () => {
    const app = makeApp();
    const { report, basisSha256 } = await completedReport(app, "Torn seam");
    const longEvent = `EVSTART${"x".repeat(300)}EVEND`;
    const { text } = await pdfText(await renderReportPdf(report, [event({ note: longEvent })], basisSha256));
    const flat = text.replace(/\s+/g, "");
    expect(text).toContain("Torn seam");
    expect(text).not.toContain("See note 1");
    expect(text).toContain("See note E1");
    expect(flat).toContain(longEvent);
  });

  it("linked events and the basis hash are printed", async () => {
    const app = makeApp();
    const { report, basisSha256 } = await completedReport(app);
    const { text } = await pdfText(await renderReportPdf(report, [event({ note: "Check seam again" })], basisSha256));
    expect(text).toContain("Linked advisories and corrections");
    expect(text).toContain("Check seam again");
    expect(text).toContain("13 Nov 2026, 09:00 UTC");
    expect(text.replace(/\s+/g, "")).toContain(basisSha256);
  });

  it("characters outside WinAnsi are replaced, never dropped silently", async () => {
    const app = makeApp();
    const { report, basisSha256 } = await completedReport(app, "漢字 → ok");
    const { text } = await pdfText(await renderReportPdf(report, [], basisSha256));
    expect(text).toContain("?? -> ok");
  });

  it("the document declares its language, title and tagged structure", async () => {
    const app = makeApp();
    const { report, basisSha256 } = await completedReport(app);
    const bytes = await renderReportPdf(report, [], basisSha256);
    const raw = bytes.toString("latin1");
    expect(raw.startsWith("%PDF-1.7")).toBe(true);
    expect(raw).toContain("/Lang (en-GB)");
    expect(raw).toMatch(/\/MarkInfo \d+ 0 R/);
    expect(raw).toMatch(/\/Marked true/);
    expect(raw).toContain("/StructTreeRoot");
    expect(raw).toContain("/DisplayDocTitle true");
    for (const tag of ["/H1", "/H2", "/P", "/Table", "/TR", "/TH", "/TD"]) expect(raw).toContain(tag);
    // Page content is compressed, so inflate the streams to see the Artifact marks on header and footer.
    expect(pdfStreams(bytes).join("\n")).toContain("/Artifact");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 }).promise;
    const meta = await doc.getMetadata();
    expect((meta.info as { Title: string }).Title).toMatch(/^Cabin Kit report/);
  });

  it("stream extraction keeps the last byte of a compressed stream that ends in \\r", () => {
    // The old search ("stream" up to "\\nendstream") took this byte for part of the line ending: the inflate failed and
    // the /Artifact check above saw no page content, about once in 1,000 runs.
    const content = "BT /Artifact <</Type /Pagination>> BDC 10199 EMC ET";
    const data = deflateSync(content);
    expect(data.at(-1)).toBe(0x0d);
    const head = Buffer.from(`1 0 obj\n<<\n/Length ${data.length}\n/Filter /FlateDecode\n>>\nstream\n`, "latin1");
    const pdf = Buffer.concat([head, data, Buffer.from("\nendstream\nendobj\n", "latin1")]);
    expect(pdfStreams(pdf)).toEqual([content]);
  });

  it("stream extraction refuses an indirect /Length by name instead of misreading the object number as a length", () => {
    const data = Buffer.from("BT (x) Tj ET", "latin1");
    const pdf = Buffer.from(
      `4 0 obj\n<<\n/Length 5 0 R\n>>\nstream\n${data.toString("latin1")}\nendstream\nendobj\n5 0 obj\n${data.length}\nendobj\n`,
      "latin1",
    );
    expect(() => pdfStreams(pdf)).toThrow(/indirect \/Length not supported/);
  });

  it("CreationDate equals report.generatedAt", async () => {
    const app = makeApp();
    const { report, basisSha256 } = await completedReport(app);
    const bytes = await renderReportPdf(report, [], basisSha256);
    const d = new Date(report.generatedAt);
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 }).promise;
    const info = (await doc.getMetadata()).info as { CreationDate: string; ModDate: string };
    expect(info.CreationDate).toBe(`D:${stamp}`);
    expect(info.ModDate).toBe(`D:${stamp}`);
  });

  it("rendering the same stored report twice gives identical bytes", async () => {
    const app = makeApp();
    const { id } = await completedReport(app, "Torn seam");
    const a = (await app.app.inject(`/api/visits/${id}/report.pdf`)).rawPayload;
    await new Promise((r) => setTimeout(r, 1100));
    const b = (await app.app.inject(`/api/visits/${id}/report.pdf`)).rawPayload;
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it("the tallest row that does not throw still fits on one page below the repeated header", async () => {
    const app = makeApp();
    const { report, basisSha256 } = await completedReport(app);
    // Pending changes and rules not used now move to Notes when long, so many part lines make the tall row.
    const withLines = (n: number) => ({ ...report, work: report.work.map((w) => ({ ...w, lines: manyLines(n) })) }) as Report;
    const renders = async (n: number) =>
      renderReportPdf(withLines(n), [], basisSha256).then(
        (bytes) => bytes,
        () => null,
      );
    // Find the largest number of pending changes the guard still accepts.
    let lo = 1;
    let hi = 400;
    expect(await renders(lo)).not.toBeNull();
    expect(await renders(hi)).toBeNull();
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (await renders(mid)) lo = mid;
      else hi = mid;
    }
    const bytes = await renders(lo);
    if (!bytes) throw new Error("expected the accepted row to render");
    const items = await pdfItems(bytes);
    const rowPages = new Set(items.filter((i) => /LINEPART\d+/.test(i.str)).map((i) => i.page));
    expect(rowPages.size).toBe(1); // the row was not split across pages by an overflowing text run
    const page = [...rowPages][0];
    const lowest = Math.min(...items.filter((i) => i.page === page && /LINEPART\d+|\(required\)/.test(i.str)).map((i) => i.y));
    // Page content ends MARGIN + FOOTER_SPACE (74 pt) above the bottom edge; no row text crosses it.
    expect(lowest).toBeGreaterThanOrEqual(74);
  });

  it("a long authority notice grows its box: the next content starts below it", async () => {
    const app = makeApp();
    const { report, basisSha256 } = await completedReport(app);
    const notice = `NOTICESTART ${"Fictional demonstration only, not for use. ".repeat(40)}NOTICEEND`;
    const items = await pdfItems(await renderReportPdf({ ...report, authorityNotice: notice }, [], basisSha256));
    const first = items.filter((i) => i.page === 1);
    const noticeLines = first.filter((i) => /Fictional demonstration only|NOTICESTART|NOTICEEND/.test(i.str));
    expect(noticeLines.length).toBeGreaterThan(8); // the notice wraps over many lines
    const noticeBottom = Math.min(...noticeLines.map((i) => i.y));
    const visit = first.find((i) => i.str === "Visit");
    if (!visit) throw new Error("no Visit heading on page 1");
    // y grows upwards: the heading's top (baseline + its height) sits below the notice's last line
    // with at least the box's 6 pt inner padding and 8 pt gap between them.
    expect(visit.y + visit.height).toBeLessThan(noticeBottom - 14);
  });

  it("a work item with excluded rules prints the rules not used", async () => {
    const app = makeApp();
    const { report, basisSha256 } = await completedReport(app);
    const excludedRules = [
      {
        ruleId: "X-EXPIRED-EXACT",
        partNo: "FAKE-SC-1001",
        sourceId: "FX-DOC-A",
        reasons: [{ code: "RULE_EXPIRED", message: "Rule X-EXPIRED-EXACT ended after 2026-11-11." }],
      },
    ];
    const withExcluded = { ...report, work: report.work.map((w) => ({ ...w, excludedRules })) } as Report;
    const { text } = await pdfText(await renderReportPdf(withExcluded, [], basisSha256));
    expect(text.replace(/\s+/g, "")).toContain("Rulesnotused:X-EXPIRED-EXACT(FAKE-SC-1001):RuleX-EXPIRED-EXACTendedafter2026-11-11.");
    const { text: plain } = await pdfText(await renderReportPdf(report, [], basisSha256));
    expect(plain).not.toContain("Rules not used");
  });

  it("a work item with 60 exclusions and pending changes renders, the full text in Notes", async () => {
    const app = makeApp();
    const { report, basisSha256 } = await completedReport(app, "Torn seam");
    const pendingChanges = Array.from({ length: 30 }, (_, i) => ({ note: `Pending change ${i} with some words to wrap` }));
    const heavy = { ...report, work: report.work.map((w) => ({ ...w, excludedRules: manyExclusions(60), pendingChanges })) } as unknown as Report;
    const { text } = await pdfText(await renderReportPdf(heavy, [], basisSha256));
    const flat = text.replace(/\s+/g, "");
    expect(text).toContain("See note 1");
    expect(flat).toContain("1.Seat3A/CUSHION:Note:Tornseam");
    for (const id of ["X-EXCL-0", "X-EXCL-59"]) expect(flat).toContain(`${id}(FAKE-SC-1001):Rule${id}endedafter2026-11-11.`);
    expect(flat).toContain("Pendingchange29withsomewordstowrap");
  });

  it("a gap with a very long reason renders, the full reason in Notes", async () => {
    const app = makeApp();
    const { report, basisSha256 } = await completedReport(app);
    const reason = `GAPSTART ${"The rule ended after 2026-11-11. ".repeat(200)}GAPEND`;
    const gaps = [
      {
        componentId: "CUSHION",
        status: "NO_MATCH" as const,
        message: reason,
        locationIds: ["SEAT:3A"],
        locationSummary: "Seat A row 3 (1 location)",
        sourceIds: [],
      },
    ];
    const { text } = await pdfText(await renderReportPdf({ ...report, gaps }, [], basisSha256));
    expect(text).toContain("See note G1");
    expect(text).toContain("Notes on unresolved gaps");
    const flat = text.replace(/\s+/g, "");
    expect(flat).toContain("GAPSTART");
    expect(flat).toContain("GAPEND");
  });

  it("a table row taller than a page throws a loud error", async () => {
    const app = makeApp();
    const { report, basisSha256 } = await completedReport(app);
    // Many part lines make the parts cell taller than any page; that column has no overflow section.
    const tall = { ...report, work: report.work.map((w) => ({ ...w, lines: manyLines(400) })) } as Report;
    await expect(renderReportPdf(tall, [], basisSha256)).rejects.toThrow("pdf: row taller than a page in");
  });
});
