import { afterAll, describe, expect, it } from "vitest";
import type { Report } from "../../src/domain/types.ts";
import { CUSHION_3A, cleanupTempDirs, KIT_ALTERNATE, makeApp, makeStores, SIX_LINE_TOTALS } from "../helpers.ts";

afterAll(cleanupTempDirs);

type App = ReturnType<typeof makeApp>;
const json = (res: { body: string }) => JSON.parse(res.body);
async function post(app: App, url: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.app.inject({ method: "POST", url, payload: payload as object, headers });
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

describe("mutation responses", () => {
  it("omit the snapshot and stay small", async () => {
    const app = makeApp();
    const created = json(await post(app, "/api/visits", { tail: "N100TL", checkDate: "2026-11-12" }));
    expect(created.visit.snapshot).toBeDefined();
    const res = await put(app, `/api/visits/${created.visit.id}/records`, { record: CUSHION_3A });
    expect(res.statusCode).toBe(200);
    expect("snapshot" in json(res).visit).toBe(false);
    expect(res.rawPayload.length).toBeLessThan(8_000);
    expect(json(res).visit.records).toHaveLength(1);
    expect(json(res).visit.snapshotSha256).toBe(created.visit.snapshotSha256);
    const removed = await post(app, `/api/visits/${created.visit.id}/records/remove`, {
      locationId: CUSHION_3A.locationId,
      componentId: CUSHION_3A.componentId,
    });
    expect("snapshot" in json(removed).visit).toBe(false);
    await put(app, `/api/visits/${created.visit.id}/records`, { record: CUSHION_3A });
    const done = await post(app, `/api/visits/${created.visit.id}/complete`, { confirm: true });
    expect(done.statusCode).toBe(200);
    expect("snapshot" in json(done).visit).toBe(false);
    expect(json(done).report.schema).toBeDefined();
    const ev = await post(app, `/api/visits/${created.visit.id}/events`, { type: "ADVISORY", note: "n", author: "a" });
    expect("snapshot" in json(ev).visit).toBe(false);
    const got = json(await app.app.inject(`/api/visits/${created.visit.id}`));
    expect(got.visit.snapshot).toBeDefined();
    await app.close();
  });
});

describe("lookup API", () => {
  it("returns each state with an explicit reason and never a guessed configuration", async () => {
    const app = makeApp();
    const state = async (tail: string, date: string) => {
      const res = await app.app.inject(`/api/lookup?tail=${encodeURIComponent(tail)}&date=${date}`);
      expect(res.statusCode).toBe(200);
      return json(res);
    };
    expect(await state("n100tl", "2026-11-12")).toMatchObject({ state: "RESOLVED", tail: "N100TL", demo: true });
    expect(await state("N090TL", "2026-11-12")).toMatchObject({ state: "PARTIAL" });
    expect(await state("N999ZZ", "2026-11-12")).toMatchObject({ state: "UNKNOWN_TAIL" });
    expect(await state("N000TL", "2026-11-12")).toMatchObject({ state: "UNCONFIGURED", reasonCode: "NO_ASSIGNMENTS" });
    expect(await state("N400TL", "2026-09-15")).toMatchObject({ state: "OVERLAP" });
    expect(await state("N110TL", "2026-11-12")).toMatchObject({ state: "PLANNED" });
    expect(await state("N100TL", "nonsense")).toMatchObject({ state: "INVALID_INPUT" });
    expect(await state("", "")).toMatchObject({ state: "INVALID_INPUT", reasonCode: "TAIL_MISSING" });
    await app.close();
  });

  it("reports a reference store failure as SERVICE_UNAVAILABLE and refuses to create visits", async () => {
    const app = makeApp({ testFaults: true });
    await post(app, "/api/__test/faults", { reference: "fail" });
    const res = await app.app.inject("/api/lookup?tail=N100TL&date=2026-11-12");
    expect(res.statusCode).toBe(503);
    expect(json(res)).toMatchObject({ state: "SERVICE_UNAVAILABLE", referenceReleaseId: null });
    const create = await post(app, "/api/visits", { tail: "N100TL", checkDate: "2026-11-12" });
    expect(create.statusCode).toBe(503);
    expect(json(create).error.code).toBe("REFERENCE_UNAVAILABLE");
    const health = json(await app.app.inject("/api/health"));
    expect(health).toMatchObject({ status: "degraded", reference: { available: false }, visits: { available: true } });
    // saved history stays readable while reference data is down
    expect((await app.app.inject("/api/visits")).statusCode).toBe(200);
    await post(app, "/api/__test/faults", {});
    expect((await app.app.inject("/api/lookup?tail=N100TL&date=2026-11-12")).statusCode).toBe(200);
    await app.close();
  });

  it("a visit needs an unambiguous configuration", async () => {
    const app = makeApp();
    for (const [tail, date, state] of [
      ["N400TL", "2026-09-15", "OVERLAP"],
      ["N000TL", "2026-11-12", "UNCONFIGURED"],
      ["N110TL", "2026-11-12", "PLANNED"],
      ["N999ZZ", "2026-11-12", "UNKNOWN_TAIL"],
      ["N600TL", "2026-03-01", "SOURCE_INVALID"],
    ]) {
      const res = await post(app, "/api/visits", { tail, checkDate: date });
      expect(res.statusCode).toBe(422);
      expect(json(res).error).toMatchObject({ code: "CONFIGURATION_NOT_RESOLVED", details: { state } });
    }
    expect(json(await app.app.inject("/api/visits")).total).toBe(0);
    // a partial configuration can start a visit; its gaps stay unrecordable and reported
    const partial = await newVisit(app, "N090TL");
    const refused = await put(app, `/api/visits/${partial.id}/records`, {
      record: { locationId: "BIN:L-01", componentId: "BIN_DOOR", selection: "PRIMARY", quantity: 1 },
    });
    expect(refused.statusCode).toBe(422);
    expect(json(refused).error.code).toBe("UNRESOLVED_COMPONENT");
    const report = json(await app.app.inject(`/api/visits/${partial.id}/report`)).report as Report;
    expect(report.counts.unresolvedComponents).toBe(24);
    await app.close();
  });
});

describe("visit API with the browser bypassed", () => {
  it("derives totals on the server and rejects forged requests", async () => {
    const app = makeApp();
    const visit = await newVisit(app);
    const url = `/api/visits/${visit.id}/records`;
    const forged: [unknown, number, string][] = [
      [{ record: { ...CUSHION_3A, locationId: "SEAT:14B" } }, 422, "UNKNOWN_LOCATION"],
      [{ record: { ...CUSHION_3A, ruleId: "FX-R-V02-ELR-A-CUSHION" } }, 422, "RULE_NOT_APPLICABLE"],
      [{ record: { ...KIT_ALTERNATE, substituteId: "FORGED" } }, 422, "SUBSTITUTE_NOT_APPROVED"],
      [{ record: { ...CUSHION_3A, componentId: "CARPET_KIT" } }, 422, "INCOMPATIBLE_COMPONENT"],
      [{ record: { ...CUSHION_3A, quantity: 5 } }, 422, "INVALID_QUANTITY"],
      [{ record: { ...CUSHION_3A, quantity: "1" } }, 422, "INVALID_QUANTITY"],
      [{ record: { ...CUSHION_3A, unit: "KIT" } }, 422, "UNIT_MISMATCH"],
      [{ record: { ...CUSHION_3A, lines: [{ partNo: "FAKE-SC-1001", qty: 99, unit: "EA" }] } }, 422, "UNSUPPORTED_FIELD"],
      [{ record: CUSHION_3A, totals: [{ partNo: "FAKE-SC-1001", quantity: 99 }] }, 422, "UNSUPPORTED_FIELD"],
      [{ record: CUSHION_3A, expectedRecordVersion: -1 }, 400, "INVALID_VERSION"],
      [{ record: "SEAT:3A" }, 422, "INVALID_RECORD"],
    ];
    for (const [payload, status, code] of forged) {
      const res = await put(app, url, payload);
      expect([res.statusCode, json(res).error.code]).toEqual([status, code]);
    }
    expect((await app.app.inject({ method: "PUT", url, payload: "not json", headers: { "content-type": "application/json" } })).statusCode).toBe(400);
    expect(json(await app.app.inject(`/api/visits/${visit.id}`)).visit.recordCount).toBe(0);

    expect((await put(app, url, { record: CUSHION_3A, expectedRecordVersion: 0 })).statusCode).toBe(200);
    expect((await put(app, url, { record: KIT_ALTERNATE, expectedRecordVersion: 0 })).statusCode).toBe(200);
    const stale = await put(app, url, { record: KIT_ALTERNATE, expectedRecordVersion: 0 });
    expect([stale.statusCode, json(stale).error.code]).toEqual([409, "STALE_RECORD"]);
    const report = json(await app.app.inject(`/api/visits/${visit.id}/report`)).report as Report;
    expect(report.reportKind).toBe("DRAFT_PREVIEW");
    expect(report.totals.map((t) => [t.partNo, t.quantity, t.unit])).toEqual(SIX_LINE_TOTALS.map((x) => [...x]));
    await app.close();
  });

  it("requires explicit, non-empty completion and locks the visit afterwards", async () => {
    const app = makeApp();
    const visit = await newVisit(app);
    const complete = (payload: unknown) => post(app, `/api/visits/${visit.id}/complete`, payload);
    expect(json(await complete({})).error.code).toBe("CONFIRMATION_REQUIRED");
    expect(json(await complete({ confirm: "yes" })).error.code).toBe("CONFIRMATION_REQUIRED");
    const empty = await complete({ confirm: true });
    expect([empty.statusCode, json(empty).error.code]).toEqual([409, "EMPTY_VISIT"]);
    await put(app, `/api/visits/${visit.id}/records`, { record: CUSHION_3A });
    const staleComplete = await complete({ confirm: true, expectedVisitVersion: 1 });
    expect([staleComplete.statusCode, json(staleComplete).error.code]).toEqual([409, "STALE_VISIT"]);
    const done = await complete({ confirm: true, expectedVisitVersion: 2 });
    expect(done.statusCode).toBe(200);
    expect(json(done)).toMatchObject({ alreadyCompleted: false, visit: { status: "COMPLETED" }, report: { reportKind: "FINAL" } });
    expect(json(await complete({ confirm: true }))).toMatchObject({ alreadyCompleted: true });
    for (const res of [
      await put(app, `/api/visits/${visit.id}/records`, { record: { ...CUSHION_3A, locationId: "SEAT:4A" } }),
      await put(app, `/api/visits/${visit.id}/records`, { record: { ...CUSHION_3A, note: "edited after completion" } }),
      await post(app, `/api/visits/${visit.id}/records/remove`, { locationId: "SEAT:3A", componentId: "CUSHION" }),
    ]) {
      expect([res.statusCode, json(res).error.code]).toEqual([409, "VISIT_LOCKED"]);
    }
    expect(json(await app.app.inject(`/api/visits/${visit.id}/report`)).report).toEqual(json(done).report);
    await app.close();
  });

  it("a rebinding host is refused on reads and writes", async () => {
    const app = makeApp();
    const get = await app.app.inject({ method: "GET", url: "/api/health", headers: { host: "evil.example:4310" } });
    expect(get.statusCode).toBe(403);
    expect(json(get).error).toMatchObject({ code: "HOST_NOT_ALLOWED", details: null });
    const bad = await post(app, "/api/visits", { tail: "N100TL", checkDate: "2026-11-12" }, { host: "evil.example:4310", origin: "http://evil.example:4310" });
    expect(bad.statusCode).toBe(403);
    expect(json(bad).error.code).toBe("HOST_NOT_ALLOWED");
    expect(app.visits.counts().visits).toBe(0);
    await app.close();
  });

  it.each([
    [{ origin: "null" }, 403],
    [{ origin: "http://localhost:81" }, 403],
    [{ origin: "notaurl" }, 403],
    [{ "sec-fetch-site": "cross-site" }, 403],
    [{ "sec-fetch-site": "same-site" }, 403],
    [{ origin: "http://localhost:80", "sec-fetch-site": "same-origin" }, 201],
    [{ origin: "http://localhost", "sec-fetch-site": "same-origin" }, 201],
    [{ "sec-fetch-site": "none" }, 201],
    [{}, 201],
  ])("write with %j gives %i", async (headers, status) => {
    const app = makeApp();
    const res = await post(app, "/api/visits", { tail: "N100TL", checkDate: "2026-11-12" }, headers);
    expect(res.statusCode).toBe(status);
    if (status === 403) expect(json(res).error.code).toBe("CROSS_ORIGIN_WRITE");
    await app.close();
  });

  it("the origin rule covers every write route", async () => {
    const app = makeApp();
    const visit = await newVisit(app);
    const headers = { origin: "http://x.test" };
    const base = `/api/visits/${visit.id}`;
    const results = await Promise.all([
      app.app.inject({ method: "PUT", url: `${base}/records`, payload: { record: CUSHION_3A }, headers }),
      app.app.inject({ method: "POST", url: `${base}/records/remove`, payload: {}, headers }),
      app.app.inject({ method: "POST", url: `${base}/complete`, payload: { confirm: true }, headers }),
      app.app.inject({ method: "POST", url: `${base}/events`, payload: {}, headers }),
    ]);
    for (const res of results) {
      expect(res.statusCode).toBe(403);
      expect(json(res).error.code).toBe("CROSS_ORIGIN_WRITE");
    }
    await app.close();
  });

  it("a host named in CABIN_KIT_ALLOWED_HOSTS is accepted", async () => {
    const app = makeApp({ allowedHosts: ["kit.internal"] });
    const ok = await app.app.inject({ method: "GET", url: "/api/health", headers: { host: "kit.internal:4310" } });
    expect(ok.statusCode).toBe(200);
    const other = await app.app.inject({ method: "GET", url: "/api/health", headers: { host: "evil.example" } });
    expect(other.statusCode).toBe(403);
    await app.close();
  });

  it("refuses cross-origin writes and unknown visits", async () => {
    const app = makeApp();
    const res = await post(app, "/api/visits", { tail: "N100TL", checkDate: "2026-11-12" }, { origin: "http://evil.example", host: "127.0.0.1:4310" });
    expect([res.statusCode, json(res).error.code]).toEqual([403, "CROSS_ORIGIN_WRITE"]);
    const same = await post(app, "/api/visits", { tail: "N100TL", checkDate: "2026-11-12" }, { origin: "http://127.0.0.1:4310", host: "127.0.0.1:4310" });
    expect(same.statusCode).toBe(201);
    expect((await app.app.inject("/api/visits/nope")).statusCode).toBe(404);
    expect((await app.app.inject("/api/visits/nope/report.pdf")).statusCode).toBe(404);
    expect((await app.app.inject("/api/nope")).statusCode).toBe(404);
    expect((await app.app.inject("/api/__test/faults")).statusCode).toBe(404); // fault hooks exist only in test mode
    await app.close();
  });

  it("a storage failure is reported as not saved, and a retry after recovery succeeds once", async () => {
    const app = makeApp({ testFaults: true });
    const visit = await newVisit(app);
    await post(app, "/api/__test/faults", { visitWrites: "fail", remaining: 1 });
    const failed = await put(app, `/api/visits/${visit.id}/records`, { record: CUSHION_3A, expectedRecordVersion: 0, idempotencyKey: "key-storage-1" });
    expect(failed.statusCode).toBe(503);
    expect(json(failed).error).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(json(failed).error.message).toMatch(/Nothing was saved/);
    expect(failed.body).not.toContain("Simulated");
    expect(json(failed).error.details.requestId).toBe(failed.headers["x-request-id"]);
    expect(json(await app.app.inject(`/api/visits/${visit.id}`)).visit.recordCount).toBe(0);
    const retry = await put(app, `/api/visits/${visit.id}/records`, { record: CUSHION_3A, expectedRecordVersion: 0, idempotencyKey: "key-storage-1" });
    expect(retry.statusCode).toBe(200);
    const again = await put(app, `/api/visits/${visit.id}/records`, { record: CUSHION_3A, expectedRecordVersion: 0, idempotencyKey: "key-storage-1" });
    expect(json(again).replayed).toBe(true);
    expect(json(again).visit.records).toHaveLength(1);
    expect(json(again).visit.records[0].version).toBe(1);
    await app.close();
  });
});

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
    expect(report.totals.find((t) => t.partNo === "FAKE-SC-1001")!.quantity).toBe(5);
    expect(report.totals.find((t) => t.partNo === "FAKE-SC-1002")!.quantity).toBe(23);
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

describe("preparation and reference endpoints", () => {
  it("serves the pre-work overview as JSON and CSV", async () => {
    const app = makeApp();
    const prep = json(await app.app.inject("/api/preparation?tail=N100TL&date=2026-11-12"));
    expect(prep.schema).toBe("cabin-kit.preparation/1");
    expect(prep.lines.find((l: { partNo: string }) => l.partNo === "FAKE-CK-2001").alternates[0].requiredSupplements).toHaveLength(4);
    const csv = await app.app.inject("/api/preparation?tail=N100TL&date=2026-11-12&format=csv");
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    const lines = csv.body.trim().split("\r\n");
    expect(lines[0]?.split(",")[0]).toBe("line_type");
    expect(lines.filter((l) => l.startsWith("ALTERNATE,FAKE-CK-2000"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("REQUIRED_SUPPLEMENT,FAKE-P-"))).toHaveLength(4);
    expect(lines.find((l) => l.startsWith("PRIMARY,FAKE-SC-1001"))).toContain("Seat A rows 1-5 (5 locations)");
    const refused = await app.app.inject("/api/preparation?tail=N000TL&date=2026-11-12");
    expect([refused.statusCode, json(refused).error.code]).toEqual([422, "CONFIGURATION_NOT_RESOLVED"]);
    // from a saved visit: frozen, independent of live reference data
    const visit = await newVisit(app);
    expect(json(await app.app.inject(`/api/visits/${visit.id}/preparation`)).lines.length).toBe(prep.lines.length);
    await app.close();
  });

  it("exposes namespaces, findings and candidate layouts with their status", async () => {
    const app = makeApp({ stores: makeStores({ includeCandidate: true }) });
    const reference = json(await app.app.inject("/api/reference"));
    expect(reference.counts).toMatchObject({ layoutRevisions: { fixture: 6, candidate: 5 }, accepted: 0 });
    expect(reference.findings.some((f: { code: string }) => f.code === "AIRLINE_DATA_NOT_SUPPLIED")).toBe(true);
    expect(reference.authorityNotice).toMatch(/Fictional home-lab demonstration/);
    const layouts = json(await app.app.inject("/api/layouts"));
    const cand = layouts.layouts.find((l: { id: string }) => l.id === "CAND-73G@2026.1");
    expect(cand).toMatchObject({ namespace: "candidate", status: "candidate", seatCount: 137, floorMapStatus: "not-supplied", variants: [] });
    expect(layouts.layoutCategories.find((c: { id: string }) => c.id === "DOCX-CAT-700-138").seatSetStatus).toBe("not-supplied");
    const one = json(await app.app.inject(`/api/layouts/${encodeURIComponent("CAND-73G@2026.1")}`));
    expect(one.layoutRevision.locations).toHaveLength(137);
    expect(one.categories.map((c: { id: string }) => c.id)).toEqual(["DOCX-CAT-700-137"]);
    expect(json(await app.app.inject("/api/tails")).tails.every((t: { namespace: string }) => t.namespace === "fixture")).toBe(true);
    await app.close();
  });

  it("an unexpected exception is 500 INTERNAL_ERROR and does not leak its message", async () => {
    const app = makeApp();
    app.app.get("/api/__boom", async () => {
      throw new TypeError("secret detail");
    });
    const r = await app.app.inject({ url: "/api/__boom" });
    expect(r.statusCode).toBe(500);
    expect(json(r).error.code).toBe("INTERNAL_ERROR");
    expect(r.body).not.toContain("secret detail");
    expect(json(r).error.details.requestId).toBe(r.headers["x-request-id"]);
    await app.close();
  });

  it("malformed JSON keeps the error envelope", async () => {
    const app = makeApp();
    const r = await app.app.inject({ method: "POST", url: "/api/visits", headers: { "content-type": "application/json" }, payload: "{nope" });
    expect(r.statusCode).toBe(400);
    expect(json(r).error.code).toBe("BAD_REQUEST");
    expect(json(r).error.details).toBeNull();
    await app.close();
  });

  it("a body over 256 KB is 413 with the envelope", async () => {
    const app = makeApp();
    const r = await app.app.inject({
      method: "POST",
      url: "/api/visits",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ pad: "x".repeat(300 * 1024) }),
    });
    expect(r.statusCode).toBe(413);
    expect(json(r).error.code).toBe("BAD_REQUEST");
    await app.close();
  });

  it("an array or scalar JSON body is 400 INVALID_BODY", async () => {
    const app = makeApp();
    for (const payload of ["[]", "5", '"text"']) {
      const r = await app.app.inject({ method: "POST", url: "/api/visits", headers: { "content-type": "application/json" }, payload });
      expect([r.statusCode, json(r).error.code]).toEqual([400, "INVALID_BODY"]);
    }
    await app.close();
  });

  it("an idempotencyKey of length 7, 101, or not a string is 400 INVALID_IDEMPOTENCY_KEY", async () => {
    const app = makeApp();
    const visit = await newVisit(app);
    for (const key of ["a".repeat(7), "a".repeat(101), 12345678]) {
      const r = await put(app, `/api/visits/${visit.id}/records`, { record: CUSHION_3A, expectedRecordVersion: 0, idempotencyKey: key });
      expect([r.statusCode, json(r).error.code]).toEqual([400, "INVALID_IDEMPOTENCY_KEY"]);
    }
    await app.close();
  });
});
