import { inflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import type { Report, VisitEvent } from "../../src/domain/types.ts";
import { renderReportPdf } from "../../src/server/pdf.ts";
import { CUSHION_3A, cleanupTempDirs, KIT_ALTERNATE, makeApp } from "../helpers.ts";

afterAll(cleanupTempDirs);

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
      schema: "cabin-kit.report/1",
      reportKind: "FINAL",
      visit: { tail: "N100TL", checkDate: "2026-11-12", technician: "Demo tech", status: "COMPLETED" },
      configuration: { variantId: "V01", carpet: "MOHAWK", seam: "PRE", seatCount: 176, layoutRevisionId: "FX-L-S176-MAX8@1", namespace: "fixture" },
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
      "2026-11-12",
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
    await app.close();
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
    await app.close();
  });

  it("a draft preview is marked as such and a PARTIAL visit prints its gaps", async () => {
    const app = makeApp();
    const visit = await newVisit(app, "N090TL");
    await put(app, `/api/visits/${visit.id}/records`, { record: CUSHION_3A });
    const { text } = await pdfText((await app.app.inject(`/api/visits/${visit.id}/report.pdf`)).rawPayload);
    expect(text).toContain("DRAFT PREVIEW - visit not completed");
    expect(text).toContain("Unresolved applicability gaps (24 components)");
    expect(text).toContain("Ambiguous");
    expect(text).toContain("expired after 2025-12-31");
    await app.close();
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
    await app.close();
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
    await app.close();
  });

  it("linked events and the basis hash are printed", async () => {
    const app = makeApp();
    const { report, basisSha256 } = await completedReport(app);
    const { text } = await pdfText(await renderReportPdf(report, [event({ note: "Check seam again" })], basisSha256));
    expect(text).toContain("Linked advisories and corrections");
    expect(text).toContain("Check seam again");
    expect(text).toContain("2026-11-13T09:00:00.000Z");
    expect(text.replace(/\s+/g, "")).toContain(basisSha256);
    await app.close();
  });

  it("characters outside WinAnsi are replaced, never dropped silently", async () => {
    const app = makeApp();
    const { report, basisSha256 } = await completedReport(app, "漢字 → ok");
    const { text } = await pdfText(await renderReportPdf(report, [], basisSha256));
    expect(text).toContain("?? -> ok");
    await app.close();
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
    const inflated = [...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
      .map((m) => {
        try {
          return inflateSync(Buffer.from(m[1] ?? "", "latin1")).toString("latin1");
        } catch {
          return "";
        }
      })
      .join("\n");
    expect(inflated).toContain("/Artifact");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 }).promise;
    const meta = await doc.getMetadata();
    expect((meta.info as { Title: string }).Title).toMatch(/^Cabin Kit report/);
    await app.close();
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
    await app.close();
  });

  it("rendering the same stored report twice gives identical bytes", async () => {
    const app = makeApp();
    const { id } = await completedReport(app, "Torn seam");
    const a = (await app.app.inject(`/api/visits/${id}/report.pdf`)).rawPayload;
    await new Promise((r) => setTimeout(r, 1100));
    const b = (await app.app.inject(`/api/visits/${id}/report.pdf`)).rawPayload;
    expect(Buffer.compare(a, b)).toBe(0);
    await app.close();
  });

  it("a table row taller than a page throws a loud error", async () => {
    const app = makeApp();
    const { report, basisSha256 } = await completedReport(app);
    // Many pending changes make the sources cell taller than any page while the note rule does not apply.
    const pending = Array.from({ length: 400 }, (_, i) => ({ note: `Pending item ${i} with some words to wrap` }));
    const tall = { ...report, work: report.work.map((w) => ({ ...w, pendingChanges: pending })) } as unknown as Report;
    await expect(renderReportPdf(tall, [], basisSha256)).rejects.toThrow("pdf: row taller than a page in");
    await app.close();
  });
});
