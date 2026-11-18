import { describe, expect, it } from "vitest";
import budgets from "../../budgets.json" with { type: "json" };
import type { Report } from "../../src/domain/types.ts";
import { csvCell } from "../../src/server/app.ts";
import { CUSHION_3A, KIT_ALTERNATE, makeApp, makeStores, SIX_LINE_TOTALS } from "../helpers.ts";

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

describe("mutation responses", () => {
  it("omit the snapshot and stay small", async () => {
    const app = makeApp();
    const created = json(await post(app, "/api/visits", { tail: "N100TL", checkDate: "2026-11-12" }));
    expect(created.visit.snapshot).toBeDefined();
    const res = await put(app, `/api/visits/${created.visit.id}/records`, { record: CUSHION_3A });
    expect(res.statusCode).toBe(200);
    expect("snapshot" in json(res).visit).toBe(false);
    expect(res.rawPayload.length).toBeLessThanOrEqual(budgets.api.mutationResponseBytes);
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
  });
});

describe("linked events API", () => {
  it("answers 201 then 200 on replay, and refuses a bad type or an unknown field", async () => {
    const app = makeApp();
    const visit = await newVisit(app);
    const url = `/api/visits/${visit.id}/events`;
    const body = { type: "ADVISORY", note: "Check seam", author: "JM", idempotencyKey: "evt-key-api1" };
    const first = await post(app, url, body);
    const again = await post(app, url, body);
    expect([first.statusCode, again.statusCode]).toEqual([201, 200]);
    expect(json(again).visit.events.filter((e: { type: string }) => e.type === "ADVISORY")).toHaveLength(1);
    const bad = await post(app, url, { ...body, type: "EDIT", idempotencyKey: undefined });
    expect([bad.statusCode, json(bad).error.code]).toEqual([422, "INVALID_EVENT"]);
    const extra = await post(app, url, { ...body, extra: 1 });
    expect([extra.statusCode, json(extra).error.code]).toEqual([422, "UNSUPPORTED_FIELD"]);
  });
});

describe("visit creation API", () => {
  it("a technician with a hidden or control character is 422 INVALID_TECHNICIAN in the error envelope, and nothing is stored", async () => {
    const app = makeApp();
    const res = await post(app, "/api/visits", { tail: "N100TL", checkDate: "2026-11-12", technician: "Demo\ttech" });
    expect(res.statusCode).toBe(422);
    expect(json(res)).toEqual({ error: { code: "INVALID_TECHNICIAN", message: expect.stringContaining("hidden or control character"), details: null } });
    expect(json(await app.app.inject("/api/visits")).total).toBe(0);
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
    // Every state carries a reason; only RESOLVED and PARTIAL carry a configuration, so none is guessed for the others.
    const cases: [string, string][] = [
      ["N100TL", "2026-11-12"],
      ["N090TL", "2026-11-12"],
      ["N999ZZ", "2026-11-12"],
      ["N000TL", "2026-11-12"],
      ["N400TL", "2026-09-15"],
      ["N110TL", "2026-11-12"],
      ["N500TL", "2026-03-01"],
      ["N100TL", "nonsense"],
      ["", ""],
    ];
    for (const [tail, date] of cases) {
      const r = await state(tail, date);
      expect(r.reasonCode, `${tail} ${date}`).toMatch(/^[A-Z_]+$/);
      expect(r.message.length, `${tail} ${date}`).toBeGreaterThan(0);
      const configured = r.state === "RESOLVED" || r.state === "PARTIAL";
      expect(r.context !== undefined && r.context !== null, `${tail} ${date} ${r.state} context`).toBe(configured);
      expect(r.resolution !== undefined && r.resolution !== null, `${tail} ${date} ${r.state} resolution`).toBe(configured);
    }
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
    expect(report.counts.unresolvedComponents).toBe(170); // VAC-2: N090TL has 169 no-match pieces and 1 ambiguous
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
  });

  it("the origin rule covers every write route", async () => {
    const app = makeApp();
    const visit = await newVisit(app);
    const headers = { origin: "http://x.test" };
    const base = `/api/visits/${visit.id}`;
    const results = await Promise.all([
      app.app.inject({ method: "POST", url: "/api/visits", payload: { tail: "N100TL", checkDate: "2026-11-12" }, headers }),
      app.app.inject({ method: "PUT", url: `${base}/records`, payload: { record: CUSHION_3A }, headers }),
      app.app.inject({ method: "POST", url: `${base}/records/remove`, payload: {}, headers }),
      app.app.inject({ method: "POST", url: `${base}/complete`, payload: { confirm: true }, headers }),
      app.app.inject({ method: "POST", url: `${base}/events`, payload: {}, headers }),
    ]);
    for (const res of results) {
      expect(res.statusCode).toBe(403);
      expect(json(res).error.code).toBe("CROSS_ORIGIN_WRITE");
    }
  });

  it("a host named in CABIN_KIT_ALLOWED_HOSTS is accepted", async () => {
    const app = makeApp({ allowedHosts: ["kit.internal"] });
    const ok = await app.app.inject({ method: "GET", url: "/api/health", headers: { host: "kit.internal:4310" } });
    expect(ok.statusCode).toBe(200);
    const other = await app.app.inject({ method: "GET", url: "/api/health", headers: { host: "evil.example" } });
    expect(other.statusCode).toBe(403);
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
  });
});

describe("csvCell", () => {
  it.each([
    ["=1+1", "'=1+1"],
    ["+1", "'+1"],
    ["-cmd", "'-cmd"],
    ["@x", "'@x"],
    ["\tx", "'\tx"],
    ["plain", "plain"],
    ['a"b', '"a""b"'],
    ["=a,b", '"\'=a,b"'],
  ])("csvCell(%j) = %j", (input, output) => {
    expect(csvCell(input)).toBe(output);
  });
  it("numbers are never prefixed, negative ones included; the same text as a string is", () => {
    for (const n of [-1, -0.5, 0, 3, 1.25, -1e21]) expect(csvCell(n), String(n)).toBe(String(n));
    expect(csvCell("-1")).toBe("'-1");
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
    expect(csv.headers["content-disposition"]).toContain("cabin-kit-preparation-N100TL-2026-11-12.csv");
    // no unquoted field starts with a formula character
    expect(lines.some((l) => l.split(",").some((f) => /^[=+@]/.test(f)))).toBe(false);
    expect(lines.filter((l) => l.startsWith("ALTERNATE,FAKE-CK-2000"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("REQUIRED_SUPPLEMENT,FAKE-P-"))).toHaveLength(4);
    expect(lines.find((l) => l.startsWith("PRIMARY,FAKE-SC-1001"))).toContain("Seat A rows 1-5 (5 locations)");
    const refused = await app.app.inject("/api/preparation?tail=N000TL&date=2026-11-12");
    expect([refused.statusCode, json(refused).error.code]).toEqual([422, "CONFIGURATION_NOT_RESOLVED"]);
    // from a saved visit: frozen, independent of live reference data
    const visit = await newVisit(app);
    expect(json(await app.app.inject(`/api/visits/${visit.id}/preparation`)).lines.length).toBe(prep.lines.length);
  });

  it("exposes namespaces, findings and candidate layouts with their status", async () => {
    const app = makeApp({ stores: makeStores({ includeCandidate: true }) });
    const reference = json(await app.app.inject("/api/reference"));
    expect(reference.counts).toMatchObject({ layoutRevisions: { fixture: 8, candidate: 5 }, accepted: 0 });
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
  });

  it("malformed JSON keeps the error envelope", async () => {
    const app = makeApp();
    const r = await app.app.inject({ method: "POST", url: "/api/visits", headers: { "content-type": "application/json" }, payload: "{nope" });
    expect(r.statusCode).toBe(400);
    expect(json(r).error.code).toBe("BAD_REQUEST");
    expect(json(r).error.details).toBeNull();
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
  });

  it("an array or scalar JSON body is 400 INVALID_BODY", async () => {
    const app = makeApp();
    for (const payload of ["[]", "5", '"text"']) {
      const r = await app.app.inject({ method: "POST", url: "/api/visits", headers: { "content-type": "application/json" }, payload });
      expect([r.statusCode, json(r).error.code]).toEqual([400, "INVALID_BODY"]);
    }
  });

  it("an idempotencyKey of length 7, 101, or not a string is 400 INVALID_IDEMPOTENCY_KEY", async () => {
    const app = makeApp();
    const visit = await newVisit(app);
    for (const key of ["a".repeat(7), "a".repeat(101), 12345678]) {
      const r = await put(app, `/api/visits/${visit.id}/records`, { record: CUSHION_3A, expectedRecordVersion: 0, idempotencyKey: key });
      expect([r.statusCode, json(r).error.code]).toEqual([400, "INVALID_IDEMPOTENCY_KEY"]);
    }
  });
});

describe("app handle", () => {
  it("close can be called more than once, also concurrently", async () => {
    const app = makeApp();
    await Promise.all([app.close(), app.close()]);
    await expect(app.close()).resolves.toBeUndefined();
  });
});
