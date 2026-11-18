import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lookup } from "../../src/domain/resolve.ts";
import type { Report } from "../../src/domain/types.ts";
import { DomainError } from "../../src/domain/visitLogic.ts";
import { buildStagedRelease } from "../../src/importer/assemble.ts";
import { ReferenceStore } from "../../src/server/referenceStore.ts";
import { IDEMPOTENCY_RETENTION_DAYS } from "../../src/server/visitStore.ts";
import { at, CUSHION_3A, fixtureRelease, KIT_ALTERNATE, KIT_PRIMARY, makeStores, openVisits, SIX_LINE_TOTALS, snapshotFor, track } from "../helpers.ts";

const release = fixtureRelease();
const snap = () => snapshotFor(release, "N100TL", "2026-11-12");
const totals = (report: Report) => report.totals.map((t) => [t.partNo, t.quantity, t.unit]);
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof DomainError ? e.code : `other:${(e as Error).message}`;
  }
  return "no-error";
};

describe("visit records", () => {
  it("keeps one record per visit, location and component; adding again updates it", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "Demo tech");
    expect(visit).toMatchObject({ status: "DRAFT", version: 1, number: 1, technician: "Demo tech", tail: "N100TL", checkDate: "2026-11-12" });
    store.upsertRecord(visit.id, { locationId: "FLOOR:FWD", componentId: "CARPET_PANEL", selection: "PRIMARY", quantity: 1 }, undefined);
    const again = store.upsertRecord(
      visit.id,
      { locationId: "FLOOR:FWD", componentId: "CARPET_PANEL", selection: "PRIMARY", quantity: 3, note: " three panels " },
      undefined,
    ).visit;
    expect(again.records).toHaveLength(1);
    expect(again.records[0]).toMatchObject({ quantity: 3, version: 2, note: "three panels" });
    expect(again.records[0]?.lines).toMatchObject([{ partNo: "FAKE-V01-FWD-PANEL", qty: 3, unit: "PANEL" }]);
    expect(totals(store.getReport(visit.id).report)).toEqual([["FAKE-V01-FWD-PANEL", 3, "PANEL"]]);
  });

  it("cushion and backrest at one seat are independent records", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "");
    store.upsertRecord(visit.id, CUSHION_3A, undefined);
    const v = store.upsertRecord(visit.id, { ...CUSHION_3A, componentId: "BACKREST" }, undefined).visit;
    expect(v.records.map((r) => r.componentId).sort()).toEqual(["BACKREST", "CUSHION"]);
    const after = store.removeRecord(visit.id, "SEAT:3A", "CUSHION", undefined).visit;
    expect(after.records.map((r) => r.componentId)).toEqual(["BACKREST"]);
  });

  it("switching primary <-> alternate replaces main and child lines with no duplicates or orphans", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "");
    store.upsertRecord(visit.id, CUSHION_3A, undefined);
    store.upsertRecord(visit.id, KIT_PRIMARY, undefined);
    expect(totals(store.getReport(visit.id).report)).toEqual([
      ["FAKE-CK-2001", 1, "KIT"],
      ["FAKE-SC-1001", 1, "EA"],
    ]);
    store.upsertRecord(visit.id, KIT_ALTERNATE, undefined);
    expect(totals(store.getReport(visit.id).report)).toEqual(SIX_LINE_TOTALS.map((x) => [...x]));
    store.upsertRecord(visit.id, KIT_ALTERNATE, undefined); // retry of the same choice
    expect(totals(store.getReport(visit.id).report)).toEqual(SIX_LINE_TOTALS.map((x) => [...x]));
    store.upsertRecord(visit.id, KIT_PRIMARY, undefined);
    expect(totals(store.getReport(visit.id).report)).toEqual([
      ["FAKE-CK-2001", 1, "KIT"],
      ["FAKE-SC-1001", 1, "EA"],
    ]);
    store.upsertRecord(visit.id, KIT_ALTERNATE, undefined);
    store.removeRecord(visit.id, "FLOOR:FULL-CABIN", "CARPET_KIT", undefined);
    expect(totals(store.getReport(visit.id).report)).toEqual([["FAKE-SC-1001", 1, "EA"]]);
    expect(store.getVisit(visit.id).records).toHaveLength(1);
  });

  it("rejects forged input at the store boundary and leaves the draft untouched", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "");
    expect(codeOf(() => store.upsertRecord(visit.id, { ...CUSHION_3A, locationId: "SEAT:14B" }, undefined))).toBe("UNKNOWN_LOCATION");
    expect(codeOf(() => store.upsertRecord(visit.id, { ...KIT_ALTERNATE, substituteId: "FORGED" }, undefined))).toBe("SUBSTITUTE_NOT_APPROVED");
    expect(codeOf(() => store.upsertRecord(visit.id, { ...KIT_ALTERNATE, quantity: 7 }, undefined))).toBe("INVALID_QUANTITY");
    expect(codeOf(() => store.upsertRecord("no-such-visit", CUSHION_3A, undefined))).toBe("VISIT_NOT_FOUND");
    expect(codeOf(() => store.removeRecord(visit.id, "SEAT:3A", "CUSHION", undefined))).toBe("RECORD_NOT_FOUND");
    expect(codeOf(() => store.createVisit(snap(), "x".repeat(81)))).toBe("INVALID_TECHNICIAN");
    expect(store.getVisit(visit.id)).toMatchObject({ version: 1, recordCount: 0 });
  });
});

describe("stale edits and safe retries", () => {
  it("detects a stale update or removal instead of overwriting", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "");
    const panel = { locationId: "FLOOR:FWD", componentId: "CARPET_PANEL", selection: "PRIMARY", quantity: 1 };
    store.upsertRecord(visit.id, panel, 0); // both editors loaded "no record"
    expect(codeOf(() => store.upsertRecord(visit.id, { ...panel, quantity: 2 }, 0))).toBe("STALE_RECORD");
    store.upsertRecord(visit.id, { ...panel, quantity: 2 }, 1);
    expect(codeOf(() => store.upsertRecord(visit.id, { ...panel, quantity: 4 }, 1))).toBe("STALE_RECORD");
    expect(codeOf(() => store.removeRecord(visit.id, panel.locationId, panel.componentId, 1))).toBe("STALE_RECORD");
    expect(store.getVisit(visit.id).records[0]).toMatchObject({ quantity: 2, version: 2 });
    store.removeRecord(visit.id, panel.locationId, panel.componentId, 2);
    expect(codeOf(() => store.upsertRecord(visit.id, { ...panel, quantity: 3 }, 2))).toBe("STALE_RECORD"); // removed elsewhere
    const removedElsewhere = () => store.upsertRecord(visit.id, { ...panel, quantity: 3 }, 2);
    expect(removedElsewhere).toThrow(expect.objectContaining({ status: 409, code: "STALE_RECORD" }));
    expect(removedElsewhere).toThrow(expect.objectContaining({ details: { current: null } }));
  });

  it("a retry with the same key is applied once", () => {
    const store = openVisits(makeStores());
    const key = "retry-key-0001";
    const first = store.createVisit(snap(), "Demo", { idempotencyKey: key });
    const second = store.createVisit(snap(), "Demo", { idempotencyKey: key });
    expect(second.replayed).toBe(true);
    expect(second.visit.id).toBe(first.visit.id);
    expect(store.counts().visits).toBe(1);
    const panel = { locationId: "FLOOR:FWD", componentId: "CARPET_PANEL", selection: "PRIMARY", quantity: 2 };
    const a = store.upsertRecord(first.visit.id, panel, 0, { idempotencyKey: "retry-key-0002" });
    const b = store.upsertRecord(first.visit.id, panel, 0, { idempotencyKey: "retry-key-0002" });
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true); // not a STALE_RECORD conflict, and not applied twice
    expect(b.visit.records[0]?.version).toBe(1);
    expect(b.visit.version).toBe(2);
    expect(codeOf(() => store.upsertRecord(first.visit.id, { ...panel, quantity: 3 }, 0, { idempotencyKey: "retry-key-0002" }))).toBe("IDEMPOTENCY_KEY_REUSED");
    store.removeRecord(first.visit.id, panel.locationId, panel.componentId, 1, { idempotencyKey: "retry-key-0003" });
    expect(store.removeRecord(first.visit.id, panel.locationId, panel.componentId, 1, { idempotencyKey: "retry-key-0003" }).replayed).toBe(true);
  });
});

describe("completion and locking", () => {
  it("refuses empty completion", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "");
    expect(codeOf(() => store.completeVisit(visit.id, undefined))).toBe("EMPTY_VISIT");
    store.upsertRecord(visit.id, CUSHION_3A, undefined);
    store.removeRecord(visit.id, "SEAT:3A", "CUSHION", undefined);
    expect(codeOf(() => store.completeVisit(visit.id, undefined))).toBe("EMPTY_VISIT");
    expect(store.getVisit(visit.id).status).toBe("DRAFT");
  });

  it("locks the visit, stores the six-line report and is idempotent", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "Demo");
    store.upsertRecord(visit.id, CUSHION_3A, undefined);
    store.upsertRecord(visit.id, KIT_ALTERNATE, undefined);
    expect(codeOf(() => store.completeVisit(visit.id, 1))).toBe("STALE_VISIT"); // completing a stale view is refused
    const done = store.completeVisit(visit.id, 3);
    expect(done.alreadyCompleted).toBe(false);
    expect(done.report.reportKind).toBe("FINAL");
    expect(done.report.visit.status).toBe("COMPLETED");
    expect(done.report.visit.completedAt).toBeTruthy();
    expect(totals(done.report)).toEqual(SIX_LINE_TOTALS.map((x) => [...x]));
    const again = store.completeVisit(visit.id, 3);
    expect(again.alreadyCompleted).toBe(true);
    expect(again.report).toEqual(done.report);
    // application-level lock
    expect(codeOf(() => store.upsertRecord(visit.id, { ...CUSHION_3A, locationId: "SEAT:4A" }, undefined))).toBe("VISIT_LOCKED");
    expect(codeOf(() => store.upsertRecord(visit.id, KIT_PRIMARY, undefined))).toBe("VISIT_LOCKED");
    expect(codeOf(() => store.removeRecord(visit.id, "SEAT:3A", "CUSHION", undefined))).toBe("VISIT_LOCKED");
    expect(store.getReport(visit.id).report).toEqual(done.report);
  });

  it("is also locked at storage level when the application layer is bypassed", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "Demo");
    store.upsertRecord(visit.id, CUSHION_3A, undefined);
    // drafts: the frozen snapshot can never be rewritten, and a visit cannot be deleted
    expect(() => store.rawExec(`UPDATE visits SET snapshot_json = '{}' WHERE id = '${visit.id}'`)).toThrow(/SNAPSHOT_IMMUTABLE/);
    expect(() => store.rawExec(`UPDATE visits SET tail = 'N200TL' WHERE id = '${visit.id}'`)).toThrow(/SNAPSHOT_IMMUTABLE/);
    expect(() => store.rawExec(`DELETE FROM visits WHERE id = '${visit.id}'`)).toThrow(/VISIT_DELETE_FORBIDDEN/);
    store.completeVisit(visit.id, undefined);
    expect(() => store.rawExec(`UPDATE visit_records SET quantity = 9 WHERE visit_id = '${visit.id}'`)).toThrow(/VISIT_LOCKED/);
    expect(() => store.rawExec(`DELETE FROM visit_records WHERE visit_id = '${visit.id}'`)).toThrow(/VISIT_LOCKED/);
    expect(() =>
      store.rawExec(
        `INSERT INTO visit_records SELECT visit_id, 'SEAT:9A', component_id, version, selection, substitute_id, quantity, note, rule_id, primary_part_no, location_label, component_name, lines_json, created_at, updated_at FROM visit_records WHERE visit_id = '${visit.id}'`,
      ),
    ).toThrow(/VISIT_LOCKED/);
    expect(() => store.rawExec(`UPDATE visits SET status = 'DRAFT', completed_at = NULL WHERE id = '${visit.id}'`)).toThrow(/VISIT_LOCKED/);
    expect(() => store.rawExec(`UPDATE reports SET report_json = '{}' WHERE visit_id = '${visit.id}'`)).toThrow(/REPORT_IMMUTABLE/);
    expect(() => store.rawExec(`DELETE FROM reports WHERE visit_id = '${visit.id}'`)).toThrow(/REPORT_IMMUTABLE/);
    expect(() => store.rawExec(`DELETE FROM visit_events WHERE visit_id = '${visit.id}'`)).toThrow(/EVENT_IMMUTABLE/);
    // an empty visit cannot be forced to COMPLETED even with raw SQL
    const empty = store.createVisit(snap(), "").visit;
    expect(() => store.rawExec(`UPDATE visits SET status = 'COMPLETED', completed_at = 'x' WHERE id = '${empty.id}'`)).toThrow(/EMPTY_VISIT/);
  });

  it("later advisories and corrections are linked events that leave the report unchanged", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "Demo");
    store.upsertRecord(visit.id, CUSHION_3A, undefined);
    const done = store.completeVisit(visit.id, undefined);
    store.addLinkedEvent(visit.id, "ADVISORY", "Rule revised in a later release.", "Engineer");
    store.addLinkedEvent(visit.id, "CORRECTION_NOTE", "Technician name misspelled.", "Lead");
    const after = store.getReport(visit.id);
    expect(after.report).toEqual(done.report);
    expect(after.linkedEvents.map((e) => e.type)).toEqual(["ADVISORY", "CORRECTION_NOTE"]);
    expect(codeOf(() => store.addLinkedEvent(visit.id, "EDIT", "x", ""))).toBe("INVALID_EVENT");
  });
});

describe("persistence and history", () => {
  it("drafts and completed visits survive a service restart and can be resumed", () => {
    const stores = makeStores();
    let store = openVisits(stores);
    const draft = store.createVisit(snap(), "Demo").visit;
    store.upsertRecord(draft.id, CUSHION_3A, undefined);
    const finished = store.createVisit(snapshotFor(release, "N200TL", "2026-07-01"), "Other").visit;
    store.upsertRecord(finished.id, { locationId: "FLOOR:FULL-CABIN", componentId: "CARPET_KIT", selection: "PRIMARY", quantity: 1 }, undefined);
    const report = store.completeVisit(finished.id, undefined).report;
    store.close();

    store = openVisits(stores); // "restart"
    const resumed = store.getVisit(draft.id);
    expect(resumed).toMatchObject({ status: "DRAFT", recordCount: 1, version: 2 });
    expect(resumed.snapshot.context.layoutRevision.locations.filter((l) => l.kind === "SEAT")).toHaveLength(176);
    const v = store.upsertRecord(draft.id, KIT_ALTERNATE, 0).visit; // continue the draft
    expect(v.records).toHaveLength(2);
    expect(store.getReport(finished.id).report).toEqual(report);
    expect(totals(report)).toEqual([["FAKE-CK-2002", 1, "KIT"]]);
    expect(report.work[0]?.pendingChanges.map((p) => p.note)).toEqual(["Fictional STA 521 revision pending."]);
    expect(store.listVisits().items.map((x) => x.status)).toEqual(["COMPLETED", "DRAFT"]);
  });

  it("navigates more than 100 visits with paging, status filter and search", () => {
    const store = openVisits(makeStores());
    const snapA = snap();
    const snapB = snapshotFor(release, "N300TL", "2026-11-12");
    const ids: string[] = [];
    for (let i = 0; i < 130; i++) ids.push(store.createVisit(i % 10 === 0 ? snapB : snapA, `Tech ${i}`).visit.id);
    for (const id of ids.slice(0, 7)) {
      store.upsertRecord(id, { locationId: "SEAT:1A", componentId: "CUSHION", selection: "PRIMARY", quantity: 1 }, undefined);
      store.completeVisit(id, undefined);
    }
    const all: string[] = [];
    for (let offset = 0; ; offset += 50) {
      const page = store.listVisits({ limit: 50, offset });
      expect(page.total).toBe(130);
      all.push(...page.items.map((x) => x.id));
      if (page.items.length < 50) break;
    }
    expect(all).toHaveLength(130);
    expect(new Set(all).size).toBe(130);
    expect(all[0]).toBe(ids[129]); // newest first
    expect(all[129]).toBe(ids[0]); // the oldest visit is still reachable by navigation
    expect(store.listVisits({ status: "COMPLETED", limit: 200 }).total).toBe(7);
    expect(store.listVisits({ status: "DRAFT", limit: 200 }).items).toHaveLength(123);
    expect(store.listVisits({ q: "N300TL" }).total).toBe(13);
    expect(
      store
        .listVisits({ q: "Tech 12" })
        .items.map((x) => x.technician)
        .sort(),
    ).toEqual(["Tech 12", "Tech 120", "Tech 121", "Tech 122", "Tech 123", "Tech 124", "Tech 125", "Tech 126", "Tech 127", "Tech 128", "Tech 129"]);
    expect(store.listVisits({ q: "50%" }).total).toBe(0); // LIKE wildcards are escaped
    expect(store.counts()).toMatchObject({ visits: 130, drafts: 123, completed: 7 });
  });
});

describe("reference updates do not rebase visits", () => {
  it("a draft and a completed report keep their frozen content after a new release is activated", () => {
    const stores = makeStores();
    const refA = track(ReferenceStore.open(stores.referencePath, stores.visitsPath));
    const releaseA = refA.loadActive();
    const store = openVisits(stores);

    const draft = store.createVisit(snapshotFor(releaseA, "N100TL", "2026-11-12"), "Demo").visit;
    store.upsertRecord(draft.id, CUSHION_3A, undefined);
    const done = store.createVisit(snapshotFor(releaseA, "N100TL", "2026-11-12"), "Demo").visit;
    store.upsertRecord(done.id, CUSHION_3A, undefined);
    store.upsertRecord(done.id, KIT_ALTERNATE, undefined);
    const report = store.completeVisit(done.id, undefined).report;
    const fingerprintBefore = store.fingerprint();
    const draftSnapshotSha = store.getVisit(draft.id).snapshotSha256;

    // New release: the cushion part number changes, the alternate kit loses a panel, the approval is withdrawn.
    const staged = buildStagedRelease({ includeCandidate: false });
    staged.content.parts.push({ partNo: "FAKE-SC-9999", namespace: "fixture", description: "Replacement cushion in a later release" });
    staged.content.rules.find((r) => r.id === "FX-R-V01-ELR-A-CUSHION")!.partNo = "FAKE-SC-9999";
    staged.content.kitChildren = staged.content.kitChildren.filter((k) => k.childPartNo !== "FAKE-P-42");
    staged.content.substitutes = [];
    const { id, status } = refA.stage(staged.content, [], {});
    expect(status).toBe("validated");
    refA.activate(id);
    const releaseB = refA.loadActive();
    expect(releaseB.id).not.toBe(releaseA.id);
    refA.close();

    // The live lookup now differs...
    const live = lookup(releaseB, "N100TL", "2026-11-12");
    const liveRule = live.resolution!.components.find((c) => c.locationId === "SEAT:3A" && c.componentId === "CUSHION")!;
    expect(liveRule.status === "RESOLVED" && live.resolution!.rules[liveRule.ruleId]?.partNo).toBe("FAKE-SC-9999");
    // ...but visit history is byte-for-byte unchanged,
    expect(store.fingerprint()).toBe(fingerprintBefore);
    expect(store.getReport(done.id).report).toEqual(report);
    expect(totals(store.getReport(done.id).report)).toEqual(SIX_LINE_TOTALS.map((x) => [...x]));
    // and the draft keeps resolving against its own frozen snapshot, including the withdrawn alternate.
    const resumed = store.getVisit(draft.id);
    expect(resumed.snapshotSha256).toBe(draftSnapshotSha);
    expect(resumed.referenceReleaseId).toBe(releaseA.id);
    const continued = store.upsertRecord(draft.id, KIT_ALTERNATE, 0).visit;
    expect(totals(store.completeVisit(continued.id, undefined).report)).toEqual(SIX_LINE_TOTALS.map((x) => [...x]));
    // A new visit uses the new release.
    const fresh = store.createVisit(snapshotFor(releaseB, "N100TL", "2026-11-12"), "Demo").visit;
    expect(store.upsertRecord(fresh.id, CUSHION_3A, undefined).visit.records[0]?.lines[0]?.partNo).toBe("FAKE-SC-9999");
  });

  it("a new reference release cannot retarget an existing visit", () => {
    const stores = makeStores();
    const ref = track(ReferenceStore.open(stores.referencePath, stores.visitsPath));
    const releaseA = ref.loadActive();
    const store = openVisits(stores);
    const visit = store.createVisit(snapshotFor(releaseA, "N100TL", "2026-11-12"), "Demo").visit;
    const original = store.getVisit(visit.id);
    expect(original).toMatchObject({ variantId: "V01", layoutRevisionId: "FX-L-S176-MAX8-LP@1", referenceReleaseId: releaseA.id });

    // Release B moves N100TL to V10 on the 138-seat layout, which has a seat 14B; V01's layout does not.
    const staged = buildStagedRelease({ includeCandidate: false, label: "N100TL retrofitted" });
    const assignment = staged.content.assignments.find((a) => a.id === "FX-TA-N100TL-V01-2025-10-01");
    const aircraft = staged.content.aircraft.find((a) => a.tail === "N100TL");
    if (!assignment || !aircraft) throw new Error("the fixture no longer has N100TL's V01 assignment");
    assignment.variantId = "V10";
    assignment.layoutRevisionId = "FX-L-S138-CL@1";
    aircraft.subtypeId = "FX-700";
    const { id, status } = ref.stage(staged.content, [], {});
    expect(status).toBe("validated");
    ref.activate(id);
    const releaseB = ref.loadActive();
    expect(releaseB.id).toBe(id);
    expect(lookup(releaseB, "N100TL", "2026-11-12").context?.variant.id).toBe("V10");
    const seat14B = { locationId: "SEAT:14B", componentId: "CUSHION", selection: "PRIMARY", quantity: 1 };
    // Seat 14B is a valid record under the new variant: a visit started now can record it.
    const fresh = store.createVisit(snapshotFor(releaseB, "N100TL", "2026-11-12"), "Demo").visit;
    expect(store.upsertRecord(fresh.id, seat14B, undefined).visit.records).toHaveLength(1);

    // The existing visit keeps its snapshot, variant and release, and refuses the record that only the new variant allows.
    const loaded = store.getVisit(visit.id);
    expect(loaded.snapshotSha256).toBe(original.snapshotSha256);
    expect(loaded).toMatchObject({ variantId: "V01", layoutRevisionId: "FX-L-S176-MAX8-LP@1", referenceReleaseId: releaseA.id });
    expect(loaded.snapshot.context.variant.id).toBe("V01");
    expect(codeOf(() => store.upsertRecord(visit.id, seat14B, undefined))).toBe("UNKNOWN_LOCATION");
    expect(store.getVisit(visit.id)).toMatchObject({ version: 1, recordCount: 0 });
  });
});

describe("idempotent linked events and key retention", () => {
  const fresh = () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "Demo tech");
    return { store, id: visit.id };
  };
  const day = 86_400_000;

  it("a repeated event key appends once", () => {
    const { store, id } = fresh();
    const a = store.addLinkedEvent(id, "ADVISORY", "Check seam", "JM", { idempotencyKey: "evt-key-0001" });
    const b = store.addLinkedEvent(id, "ADVISORY", "Check seam", "JM", { idempotencyKey: "evt-key-0001" });
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(b.visit.events.filter((e) => e.type === "ADVISORY")).toHaveLength(1);
  });

  it("the same event key with a different note is refused", () => {
    const { store, id } = fresh();
    store.addLinkedEvent(id, "ADVISORY", "Check seam", "JM", { idempotencyKey: "evt-key-0002" });
    expect(codeOf(() => store.addLinkedEvent(id, "ADVISORY", "Other note", "JM", { idempotencyKey: "evt-key-0002" }))).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("note is trimmed before the length check; author over 80 is refused", () => {
    const { store, id } = fresh();
    const ok = store.addLinkedEvent(id, "ADVISORY", "  x  ", "  JM  ");
    expect(ok.visit.events.at(-1)?.payload).toMatchObject({ note: "x", author: "JM" });
    expect(codeOf(() => store.addLinkedEvent(id, "ADVISORY", " ".repeat(5), "JM"))).toBe("INVALID_EVENT");
    expect(codeOf(() => store.addLinkedEvent(id, "ADVISORY", "x", "a".repeat(81)))).toBe("INVALID_EVENT");
  });

  it("pruneIdempotency removes only rows older than the cutoff", () => {
    const { store, id } = fresh();
    const now = Date.now();
    store.addLinkedEvent(id, "ADVISORY", "old", "JM", { idempotencyKey: "evt-key-old1", now: new Date(now - 40 * day).toISOString() });
    store.addLinkedEvent(id, "ADVISORY", "new", "JM", { idempotencyKey: "evt-key-new1", now: new Date(now - 5 * day).toISOString() });
    expect(store.pruneIdempotency(new Date(now - IDEMPOTENCY_RETENTION_DAYS * day).toISOString())).toBe(1);
    expect(store.addLinkedEvent(id, "ADVISORY", "new", "JM", { idempotencyKey: "evt-key-new1" }).replayed).toBe(true);
    expect(store.addLinkedEvent(id, "ADVISORY", "old", "JM", { idempotencyKey: "evt-key-old1" }).replayed).toBe(false);
  });

  it("completion replayed flag reflects a real key match", () => {
    const { store, id } = fresh();
    store.upsertRecord(id, { locationId: "FLOOR:FWD", componentId: "CARPET_PANEL", selection: "PRIMARY", quantity: 1 }, undefined);
    const first = store.completeVisit(id, undefined, { idempotencyKey: "complete-key-1" });
    expect([first.alreadyCompleted, first.replayed]).toEqual([false, false]);
    const again = store.completeVisit(id, undefined, { idempotencyKey: "complete-key-1" });
    expect([again.alreadyCompleted, again.replayed]).toEqual([true, true]);
    const fresh2 = store.completeVisit(id, undefined, { idempotencyKey: "complete-key-2" });
    expect([fresh2.alreadyCompleted, fresh2.replayed]).toEqual([true, false]);
    const none = store.completeVisit(id, undefined);
    expect([none.alreadyCompleted, none.replayed]).toEqual([true, false]);
  });
});

describe("store edge cases (TST-09)", () => {
  it("search treats _ and \\ in q as literal characters, not LIKE wildcards or escapes", () => {
    const store = openVisits(makeStores());
    for (const tech of ["a_b", "axb", "a\\b", "a\\\\b", "c%d"]) store.createVisit(snap(), tech);
    const found = (q: string) =>
      store
        .listVisits({ q })
        .items.map((v) => v.technician)
        .sort();
    expect(found("a_b")).toEqual(["a_b"]);
    expect(found("_")).toEqual(["a_b"]);
    expect(found("a\\b")).toEqual(["a\\b"]);
    expect(found("\\")).toEqual(["a\\\\b", "a\\b"]);
    expect(found("\\\\")).toEqual(["a\\\\b"]);
    expect(found("\\_")).toEqual([]);
    expect(found("c%d")).toEqual(["c%d"]);
  });

  it("a technician of only whitespace is stored empty; one with a control, format or line-separator character is refused with INVALID_TECHNICIAN", () => {
    const store = openVisits(makeStores());
    expect(store.createVisit(snap(), " \t \n ").visit.technician).toBe("");
    expect(store.createVisit(snap(), "  Demo tech\t").visit.technician).toBe("Demo tech");
    for (const tech of [
      "Demo\ttech",
      "Demo\ntech",
      "Demo\u0000",
      "Demo\u0007tech",
      "Demo\u007ftech",
      "Demo\u0085tech",
      "Demo\u009btech",
      "Demo\u202etech", // right-to-left override
      "Demo\u2028tech", // line separator
      "Demo\u2029tech", // paragraph separator
      "Demo\u200btech", // zero-width space
      "Demo\ufefftech", // zero-width no-break space
    ]) {
      expect(() => store.createVisit(snap(), tech), JSON.stringify(tech)).toThrow(expect.objectContaining({ code: "INVALID_TECHNICIAN", status: 422 }));
    }
    expect(store.createVisit(snap(), "Zoë O’Brien-Łukasz").visit.technician).toBe("Zoë O’Brien-Łukasz");
    // zero-width joiner and non-joiner are part of how some names are written
    expect(store.createVisit(snap(), "Anu\u200dpama").visit.technician).toBe("Anu\u200dpama");
    expect(store.createVisit(snap(), "Mi\u200cnoo").visit.technician).toBe("Mi\u200cnoo");
    expect(store.counts().visits).toBe(5);
  });

  it("a visit stored with a control character in its technician still opens, lists, reports and completes", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "Old name");
    store.rawExec(`UPDATE visits SET technician = 'Old' || char(9) || 'name' WHERE id = '${visit.id}'`); // written before the rule existed
    expect(store.getVisit(visit.id).technician).toBe("Old\tname");
    expect(store.listVisits({ q: "Old" }).items.map((v) => v.id)).toEqual([visit.id]);
    store.upsertRecord(visit.id, CUSHION_3A, undefined);
    expect(store.getReport(visit.id).report.visit.technician).toBe("Old\tname");
    const done = store.completeVisit(visit.id, undefined);
    expect(done.report).toMatchObject({ reportKind: "FINAL", visit: { technician: "Old\tname", status: "COMPLETED" } });
  });

  it("one idempotency key used on two different visits is refused for the second and leaves it unchanged", () => {
    const store = openVisits(makeStores());
    const first = store.createVisit(snap(), "").visit;
    const second = store.createVisit(snap(), "").visit;
    const key = "shared-key-0001";
    expect(store.upsertRecord(first.id, CUSHION_3A, 0, { idempotencyKey: key }).replayed).toBe(false);
    expect(() => store.upsertRecord(second.id, CUSHION_3A, 0, { idempotencyKey: key })).toThrow(
      expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED", status: 422 }),
    );
    expect(() => store.removeRecord(second.id, "SEAT:3A", "CUSHION", undefined, { idempotencyKey: key })).toThrow(
      expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }),
    );
    expect(store.getVisit(second.id)).toMatchObject({ version: 1, recordCount: 0 });
    expect(store.getVisit(first.id)).toMatchObject({ version: 2, recordCount: 1 });
  });

  it("backupTo an existing path is refused and the file there is left as it was", () => {
    const stores = makeStores();
    const store = openVisits(stores);
    store.createVisit(snap(), "Demo");
    const destination = join(stores.dir, "existing-backup.sqlite");
    writeFileSync(destination, "not to be overwritten");
    expect(() => store.backupTo(destination)).toThrow(expect.objectContaining({ code: "BACKUP_EXISTS", status: 409 }));
    expect(readFileSync(destination, "utf8")).toBe("not to be overwritten");
  });

  it("a visit on a PARTIAL configuration completes, and its FINAL report keeps the gaps", () => {
    const store = openVisits(makeStores());
    const partial = snapshotFor(release, "N090TL", "2026-11-12");
    expect(partial.lookupState).toBe("PARTIAL");
    const { visit } = store.createVisit(partial, "Demo");
    store.upsertRecord(visit.id, { locationId: "SEAT:1A", componentId: "CUSHION", selection: "PRIMARY", quantity: 1 }, undefined);
    const preview = store.getReport(visit.id).report;
    expect(preview.gaps.length).toBeGreaterThan(0);
    const done = store.completeVisit(visit.id, undefined).report;
    expect(done.reportKind).toBe("FINAL");
    expect(done.configuration.lookupState).toBe("PARTIAL");
    expect(done.gaps).toEqual(preview.gaps);
    expect(done.gaps.reduce((n, g) => n + g.locationIds.length, 0)).toBe(partial.resolution.counts.noMatch + partial.resolution.counts.ambiguous);
    expect(store.getReport(visit.id).report).toEqual(done);
  });
});

const STAIN_3A = { locationId: "SEAT:3A", componentId: "CUSHION", condition: "STAINED", note: "Coffee on the cushion", outcome: "NOTED" } as const;
const BELT_3A = {
  locationId: "SEAT:3A",
  componentId: "SEATBELT",
  condition: "BROKEN",
  note: "Buckle cracked",
  outcome: "DEFERRED",
  deferUntil: "NEXT_CHECK",
  reason: "NO_STOCK",
} as const;
const errorOf = (fn: () => unknown): DomainError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e;
    throw e;
  }
  throw new Error("expected a DomainError");
};

describe("observations", () => {
  it("add, update, close an observation appends ADDED/UPDATED/CLOSED with before/after", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "Demo");
    const before = store.fingerprint();
    const added = store.addObservation(visit.id, STAIN_3A).visit;
    expect(store.fingerprint()).not.toBe(before);
    expect(added.version).toBe(2);
    expect(added.carried).toEqual([]);
    const first = at(added.observations, 0);
    expect(first).toMatchObject({
      ...STAIN_3A,
      tail: "N100TL",
      status: "OPEN",
      version: 1,
      melClass: { class: "COSMETIC" },
      dueDate: null,
      blocksSeat: false,
      openedInVisitId: visit.id,
      closedInVisitId: null,
      closedAs: null,
      locationLabel: "Seat 3A",
    });
    expect(at(added.events, added.events.length - 1)).toMatchObject({ type: "OBSERVATION_ADDED", payload: { observation: first } });

    const deferred = { ...STAIN_3A, outcome: "DEFERRED", deferUntil: "NEXT_STOP", reason: "NO_TIME", note: "  Deep stain  " };
    const updated = store.updateObservation(visit.id, first.id, deferred, 1).visit;
    const second = at(updated.observations, 0);
    expect(second).toMatchObject({
      id: first.id,
      version: 2,
      outcome: "DEFERRED",
      deferUntil: "NEXT_STOP",
      reason: "NO_TIME",
      note: "Deep stain",
      dueDate: null,
    });
    expect(updated.version).toBe(3);
    expect(at(updated.events, updated.events.length - 1)).toMatchObject({ type: "OBSERVATION_UPDATED", payload: { before: first, after: second } });

    const closed = store.closeObservation(visit.id, first.id, "FIXED", 2).visit;
    const third = at(closed.observations, 0);
    expect(third).toMatchObject({ id: first.id, version: 3, status: "CLOSED", closedAs: "FIXED", closedInVisitId: visit.id });
    expect(at(closed.events, closed.events.length - 1)).toMatchObject({ type: "OBSERVATION_CLOSED", payload: { before: second, after: third } });

    // a closed observation is no longer open for change: OBSERVATION_NOT_FOUND
    expect(errorOf(() => store.updateObservation(visit.id, first.id, STAIN_3A, 3))).toMatchObject({ code: "OBSERVATION_NOT_FOUND", status: 404 });
    expect(codeOf(() => store.closeObservation(visit.id, first.id, "FIXED", 3))).toBe("OBSERVATION_NOT_FOUND");
    expect(codeOf(() => store.updateObservation(visit.id, "no-such-observation", STAIN_3A, 1))).toBe("OBSERVATION_NOT_FOUND");
    expect(store.getVisit(visit.id).version).toBe(4);
  });

  it("record updates and removals carry the previous record", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "Demo");
    const v1 = at(store.upsertRecord(visit.id, CUSHION_3A, undefined).visit.records, 0);
    const updated = store.upsertRecord(visit.id, { ...CUSHION_3A, note: "second" }, 1).visit;
    expect(at(updated.events, updated.events.length - 1)).toMatchObject({ type: "RECORD_UPDATED", payload: { before: v1, recordVersion: 2 } });
    const v2 = at(updated.records, 0);
    const removed = store.removeRecord(visit.id, "SEAT:3A", "CUSHION", 2).visit;
    expect(at(removed.events, removed.events.length - 1)).toMatchObject({ type: "RECORD_REMOVED", payload: { before: v2, recordVersion: 2 } });
  });

  it("rejects an invalid observation and leaves the draft untouched", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "Demo");
    for (const bad of [
      { ...STAIN_3A, locationId: "SEAT:14B" },
      { ...STAIN_3A, componentId: "BIN_DOOR" },
      { ...STAIN_3A, condition: "SCRATCHED" },
      { ...STAIN_3A, note: "x".repeat(1001) },
      { ...BELT_3A, deferUntil: undefined },
      { ...BELT_3A, reason: undefined },
      { ...STAIN_3A, reason: "NO_STOCK" },
      { ...STAIN_3A, outcome: "REPLACED" },
      { ...STAIN_3A, raisedTo: "COSMETIC" },
      "not an object",
    ]) {
      expect(
        errorOf(() => store.addObservation(visit.id, bad)),
        JSON.stringify(bad),
      ).toMatchObject({ code: "INVALID_OBSERVATION", status: 422 });
    }
    expect(codeOf(() => store.addObservation(visit.id, { ...STAIN_3A, melClass: { class: "COSMETIC" } }))).toBe("UNSUPPORTED_FIELD");
    expect(codeOf(() => store.addObservation("no-such-visit", STAIN_3A))).toBe("VISIT_NOT_FOUND");
    expect(store.getVisit(visit.id)).toMatchObject({ version: 1, observations: [] });
  });

  it("MUST_FIX on a COSMETIC problem needs raisedTo", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "Demo");
    expect(errorOf(() => store.addObservation(visit.id, { ...STAIN_3A, outcome: "MUST_FIX" }))).toMatchObject({ code: "OUTCOME_NOT_ALLOWED", status: 422 });
    const raised = at(store.addObservation(visit.id, { ...STAIN_3A, outcome: "MUST_FIX", raisedTo: "NO_GO" }).visit.observations, 0);
    expect(raised).toMatchObject({ outcome: "MUST_FIX", raisedTo: "NO_GO", melClass: { class: "NO_GO", reason: "Raised by the technician" } });
    // a raised class is never lowered: dropping or lowering raisedTo is refused
    expect(codeOf(() => store.updateObservation(visit.id, raised.id, { ...STAIN_3A, outcome: "MUST_FIX" }, 1))).toBe("INVALID_OBSERVATION");
    expect(codeOf(() => store.updateObservation(visit.id, raised.id, { ...STAIN_3A, outcome: "MUST_FIX", raisedTo: "MEL" }, 1))).toBe("INVALID_OBSERVATION");
  });

  it("NO_GO cannot be DEFERRED", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "Demo");
    const latch = {
      locationId: "BIN:L-01",
      componentId: "BIN_DOOR",
      condition: "WONT_LATCH",
      note: "",
      outcome: "DEFERRED",
      deferUntil: "NEXT_STOP",
      reason: "NO_TIME",
    };
    expect(codeOf(() => store.addObservation(visit.id, latch))).toBe("OUTCOME_NOT_ALLOWED");
    const mustFix = at(store.addObservation(visit.id, { ...latch, outcome: "MUST_FIX", deferUntil: undefined, reason: undefined }).visit.observations, 0);
    expect(mustFix.melClass).toEqual({ class: "NO_GO", reason: "Bin cannot be secured" });
    // a missing life vest is NO_GO, until the seat belt deferral blocks the seat: then it is MEL C
    const vest = {
      locationId: "SEAT:3A",
      componentId: "LIFE_VEST",
      condition: "MISSING",
      note: "",
      outcome: "DEFERRED",
      deferUntil: "NEXT_CHECK",
      reason: "NO_STOCK",
    };
    expect(codeOf(() => store.addObservation(visit.id, vest))).toBe("OUTCOME_NOT_ALLOWED");
    const belt = at(store.addObservation(visit.id, BELT_3A).visit.observations, 1);
    expect(belt).toMatchObject({ blocksSeat: true, dueDate: "2026-11-22", melClass: { class: "MEL", item: "FX-25-21-01", category: "C" } });
    const blocked = store.addObservation(visit.id, vest).visit.observations.find((o) => o.componentId === "LIFE_VEST");
    expect(blocked).toMatchObject({ outcome: "DEFERRED", dueDate: "2026-11-22", melClass: { class: "MEL", item: "FX-25-61-01" } });
  });

  it("closing as REPLACED needs a record on that piece", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "Demo");
    const stain = at(store.addObservation(visit.id, STAIN_3A).visit.observations, 0);
    expect(errorOf(() => store.closeObservation(visit.id, stain.id, "REPLACED", 1))).toMatchObject({ code: "REPLACEMENT_MISSING", status: 422 });
    store.upsertRecord(visit.id, { ...CUSHION_3A, componentId: "BACKREST" }, undefined);
    expect(codeOf(() => store.closeObservation(visit.id, stain.id, "REPLACED", 1))).toBe("REPLACEMENT_MISSING");
    store.upsertRecord(visit.id, CUSHION_3A, undefined);
    expect(at(store.closeObservation(visit.id, stain.id, "REPLACED", 1).visit.observations, 0)).toMatchObject({ status: "CLOSED", closedAs: "REPLACED" });
    expect(codeOf(() => store.closeObservation(visit.id, stain.id, "BROKEN" as "FIXED", 2))).toBe("INVALID_OBSERVATION");
  });

  it("a stale expectedVersion gives STALE_OBSERVATION; the same key replays without a second row", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "Demo");
    const a = store.addObservation(visit.id, STAIN_3A, { idempotencyKey: "obs-key-0001" });
    const b = store.addObservation(visit.id, STAIN_3A, { idempotencyKey: "obs-key-0001" });
    expect([a.replayed, b.replayed]).toEqual([false, true]);
    expect(b.visit.observations).toHaveLength(1);
    expect(b.visit.version).toBe(2);
    expect(codeOf(() => store.addObservation(visit.id, { ...STAIN_3A, note: "other" }, { idempotencyKey: "obs-key-0001" }))).toBe("IDEMPOTENCY_KEY_REUSED");
    const id = at(a.visit.observations, 0).id;
    expect(errorOf(() => store.updateObservation(visit.id, id, { ...STAIN_3A, note: "x" }, 0))).toMatchObject({ code: "STALE_OBSERVATION", status: 409 });
    const u1 = store.updateObservation(visit.id, id, { ...STAIN_3A, note: "x" }, 1, { idempotencyKey: "obs-key-0002" });
    const u2 = store.updateObservation(visit.id, id, { ...STAIN_3A, note: "x" }, 1, { idempotencyKey: "obs-key-0002" });
    expect([u1.replayed, u2.replayed]).toEqual([false, true]);
    expect(at(u2.visit.observations, 0).version).toBe(2);
    expect(codeOf(() => store.closeObservation(visit.id, id, "FIXED", 1))).toBe("STALE_OBSERVATION");
    expect(store.closeObservation(visit.id, id, "FIXED", 2, { idempotencyKey: "obs-key-0003" }).replayed).toBe(false);
    expect(store.closeObservation(visit.id, id, "FIXED", 2, { idempotencyKey: "obs-key-0003" }).replayed).toBe(true);
    expect(
      store
        .getVisit(visit.id)
        .events.filter((e) => e.type.startsWith("OBSERVATION_"))
        .map((e) => e.type),
    ).toEqual(["OBSERVATION_ADDED", "OBSERVATION_UPDATED", "OBSERVATION_CLOSED"]);
  });

  it("a deferral carries to the next visit on the tail and is closed there", () => {
    const store = openVisits(makeStores());
    const first = store.createVisit(snap(), "Demo").visit;
    const belt = at(store.addObservation(first.id, BELT_3A).visit.observations, 0);
    // a cosmetic deferral carries too
    store.addObservation(first.id, { ...STAIN_3A, componentId: "HEADREST", outcome: "DEFERRED", deferUntil: "NEXT_STOP", reason: "NO_TIME" });
    const done = store.completeVisit(first.id, undefined);
    expect(done.visit).toMatchObject({ status: "COMPLETED", aircraftHeld: false });
    const other = store.createVisit(snapshotFor(release, "N200TL", "2026-11-12"), "Demo").visit;
    expect(other.carried).toEqual([]);
    expect(codeOf(() => store.updateObservation(other.id, belt.id, BELT_3A, 1))).toBe("OBSERVATION_NOT_FOUND");

    const next = store.createVisit(snapshotFor(release, "N100TL", "2026-11-20"), "Demo").visit;
    expect(next.observations).toEqual([]);
    // both sit on SEAT:3A, so they are ordered by id
    expect(next.carried.map((c) => [c.observation.componentId, c.placement, c.locationId, c.overdue]).sort()).toEqual([
      ["HEADREST", "SAME", "SEAT:3A", false],
      ["SEATBELT", "SAME", "SEAT:3A", false],
    ]);
    // re-deferred on the later date: the due date stays as first set
    const redeferred = store.updateObservation(next.id, belt.id, { ...BELT_3A, reason: "OTHER", note: "Still no stock" }, 1).visit;
    expect(redeferred.carried.find((c) => c.observation.id === belt.id)?.observation).toMatchObject({ version: 2, dueDate: "2026-11-22", reason: "OTHER" });
    expect(at(redeferred.events, redeferred.events.length - 1).type).toBe("OBSERVATION_UPDATED");
    const closed = store.closeObservation(next.id, belt.id, "FIXED", 2).visit;
    expect(closed.observations.map((o) => [o.id, o.status, o.openedInVisitId, o.closedInVisitId])).toEqual([[belt.id, "CLOSED", first.id, next.id]]);
    expect(closed.carried.map((c) => c.observation.componentId)).toEqual(["HEADREST"]);
    // the earlier visit's own events are unchanged; its observation list shows the item as closed later
    expect(store.getVisit(first.id).events).toEqual(done.visit.events);
    expect(store.completeVisit(next.id, undefined).visit.status).toBe("COMPLETED");
    // once its closing visit is completed, the observation row is locked in storage too
    expect(() => store.rawExec(`UPDATE visit_observations SET note = 'x' WHERE id = '${belt.id}'`)).toThrow(/VISIT_LOCKED/);
    expect(codeOf(() => store.closeObservation(next.id, at(closed.carried, 0).observation.id, "FIXED", 1))).toBe("VISIT_LOCKED");
    const third = store.createVisit(snapshotFor(release, "N100TL", "2026-11-21"), "Demo").visit;
    expect(third.carried.map((c) => c.observation.componentId)).toEqual(["HEADREST"]);
  });

  it("a NOTED problem does not carry to the next visit", () => {
    const store = openVisits(makeStores());
    const first = store.createVisit(snap(), "Demo").visit;
    const noted = at(store.addObservation(first.id, STAIN_3A).visit.observations, 0);
    const mustFix = at(
      store.addObservation(first.id, { locationId: "SEAT:3A", componentId: "TRAY", condition: "BROKEN", note: "", outcome: "MUST_FIX" }).visit.observations,
      1,
    );
    store.completeVisit(first.id, undefined, { aircraftHeld: true });
    const next = store.createVisit(snapshotFor(release, "N100TL", "2026-11-20"), "Demo").visit;
    expect(next.carried.map((c) => c.observation.id)).toEqual([mustFix.id]);
    // it stays OPEN and listed on its own visit, and never blocks completion
    expect(store.getVisit(first.id).observations.find((o) => o.id === noted.id)).toMatchObject({ status: "OPEN", outcome: "NOTED" });
    store.closeObservation(next.id, mustFix.id, "FIXED", 1);
    expect(store.completeVisit(next.id, undefined).visit).toMatchObject({ status: "COMPLETED", aircraftHeld: false });
    expect(store.createVisit(snapshotFor(release, "N100TL", "2026-11-21"), "Demo").visit.carried).toEqual([]);
  });

  it("an MEL deferral past its due date blocks completion with MUST_FIX_OPEN until aircraftHeld", () => {
    const store = openVisits(makeStores());
    const first = store.createVisit(snap(), "Demo").visit;
    const belt = at(store.addObservation(first.id, BELT_3A).visit.observations, 0);
    store.completeVisit(first.id, undefined);
    const late = store.createVisit(snapshotFor(release, "N100TL", "2026-11-23"), "Demo").visit;
    expect(late.carried.map((c) => [c.observation.id, c.overdue])).toEqual([[belt.id, true]]);
    store.upsertRecord(late.id, CUSHION_3A, undefined);
    const refused = errorOf(() => store.completeVisit(late.id, undefined, { idempotencyKey: "complete-held-1" }));
    expect(refused).toMatchObject({ code: "MUST_FIX_OPEN", status: 409, details: { observationIds: [belt.id] } });
    // overdue: it can no longer be deferred, only marked must-fix
    expect(codeOf(() => store.updateObservation(late.id, belt.id, BELT_3A, 1))).toBe("OUTCOME_NOT_ALLOWED");
    const mustFix = { ...BELT_3A, outcome: "MUST_FIX", deferUntil: undefined, reason: undefined };
    const marked = store.updateObservation(late.id, belt.id, mustFix, 1).visit;
    expect(at(marked.carried, 0).observation).toMatchObject({ outcome: "MUST_FIX", dueDate: "2026-11-22", melClass: { class: "NO_GO" } });
    expect(codeOf(() => store.updateObservation(late.id, belt.id, BELT_3A, 2))).toBe("OUTCOME_NOT_ALLOWED");
    expect(codeOf(() => store.completeVisit(late.id, undefined))).toBe("MUST_FIX_OPEN");
    const held = store.completeVisit(late.id, undefined, { idempotencyKey: "complete-held-1", aircraftHeld: true });
    expect(held.visit).toMatchObject({ status: "COMPLETED", aircraftHeld: true });
    expect(store.completeVisit(late.id, undefined, { idempotencyKey: "complete-held-1", aircraftHeld: true }).replayed).toBe(true);
    expect(codeOf(() => store.completeVisit(late.id, undefined, { idempotencyKey: "complete-held-1" }))).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(store.listVisits().items.map((v) => [v.id, v.aircraftHeld])).toEqual([
      [late.id, true],
      [first.id, false],
    ]);
  });

  it("a held check with an overdue carried MEL deferral reports it as must-fix; the completed visit carries nothing (R43, R44)", () => {
    const store = openVisits(makeStores());
    const first = store.createVisit(snap(), "Demo").visit;
    const belt = at(store.addObservation(first.id, BELT_3A).visit.observations, 0);
    store.completeVisit(first.id, undefined);
    const late = store.createVisit(snapshotFor(release, "N100TL", "2026-11-23"), "Demo").visit;
    store.upsertRecord(late.id, CUSHION_3A, undefined);
    const { report } = store.completeVisit(late.id, undefined, { aircraftHeld: true });
    expect(report.summary).toMatchObject({ releasable: false, aircraftHeld: true, mustFix: 1, carriedIn: 0, stillOpen: 1 });
    expect(report.observations?.mustFix.map((o) => o.id)).toEqual([belt.id]);
    expect(report.pieceOutcomes).toContainEqual({ locationId: "SEAT:3A", componentId: "SEATBELT", status: "mustFix" });
    // the stored report is what is served afterwards
    expect(store.getReport(late.id).report).toEqual(report);
    // a completed visit is frozen: no live carried list, for either check
    expect(store.getVisit(late.id).carried).toEqual([]);
    expect(store.getVisit(first.id).carried).toEqual([]);
    // a later draft still carries it
    expect(store.createVisit(snapshotFor(release, "N100TL", "2026-11-24"), "Demo").visit.carried.map((c) => c.observation.id)).toEqual([belt.id]);
  });

  it("an update cannot make a problem less serious", () => {
    const store = openVisits(makeStores());
    const first = store.createVisit(snap(), "Demo").visit;
    const belt = at(store.addObservation(first.id, BELT_3A).visit.observations, 0);
    store.completeVisit(first.id, undefined);
    const late = store.createVisit(snapshotFor(release, "N100TL", "2026-11-23"), "Demo").visit;
    store.upsertRecord(late.id, CUSHION_3A, undefined);
    // overdue MEL belt (effective NO_GO) reworded as a worn belt, noted only: refused
    const softened = { ...BELT_3A, condition: "WORN", outcome: "NOTED", deferUntil: undefined, reason: undefined };
    expect(errorOf(() => store.updateObservation(late.id, belt.id, softened, 1))).toMatchObject({
      code: "OUTCOME_NOT_ALLOWED",
      status: 422,
      message: "This problem can't be made less serious",
    });
    expect(errorOf(() => store.completeVisit(late.id, undefined))).toMatchObject({ code: "MUST_FIX_OPEN", details: { observationIds: [belt.id] } });
    // an open MEL MUST_FIX cannot become a noted stain either
    const tray = { locationId: "SEAT:3A", componentId: "TRAY", condition: "BROKEN", note: "", outcome: "MUST_FIX" };
    const trayObs = store.addObservation(late.id, tray).visit.observations.find((o) => o.componentId === "TRAY");
    expect(trayObs?.melClass.class).toBe("MEL");
    expect(codeOf(() => store.updateObservation(late.id, trayObs?.id ?? "", { ...tray, condition: "STAINED", outcome: "NOTED" }, 1))).toBe(
      "OUTCOME_NOT_ALLOWED",
    );
    expect(errorOf(() => store.completeVisit(late.id, undefined)).details).toEqual({ observationIds: [belt.id, trayObs?.id].sort() });
  });

  // R22: an update floors the new class at the problem's current class, then checks the outcome against it.
  it("an MEL deferral edited to a cosmetic condition keeps its MEL class and first due date", () => {
    const store = openVisits(makeStores());
    const first = store.createVisit(snap(), "Demo").visit;
    const belt = at(store.addObservation(first.id, BELT_3A).visit.observations, 0);
    expect(belt).toMatchObject({ melClass: { class: "MEL", item: "FX-25-21-01" }, dueDate: "2026-11-22", blocksSeat: true });
    store.completeVisit(first.id, undefined);
    const next = store.createVisit(snapshotFor(release, "N100TL", "2026-11-20"), "Demo").visit;
    // a worn belt is cosmetic on its own, but the problem stays an MEL deferral
    const reworded = store.updateObservation(next.id, belt.id, { ...BELT_3A, condition: "WORN", note: "Only frayed" }, 1).visit;
    expect(reworded.carried.find((c) => c.observation.id === belt.id)?.observation).toMatchObject({
      version: 2,
      condition: "WORN",
      outcome: "DEFERRED",
      melClass: { class: "MEL", item: "FX-25-21-01", category: "C" },
      dueDate: "2026-11-22",
      blocksSeat: true,
    });
    // noted is not an outcome of the floored MEL class
    expect(
      codeOf(() => store.updateObservation(next.id, belt.id, { ...BELT_3A, condition: "WORN", outcome: "NOTED", deferUntil: undefined, reason: undefined }, 2)),
    ).toBe("OUTCOME_NOT_ALLOWED");
  });

  it("closing the seat belt deferral makes a vest deferred under the seat block must-fix again", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "Demo");
    const belt = at(store.addObservation(visit.id, BELT_3A).visit.observations, 0);
    const vestInput = {
      locationId: "SEAT:3A",
      componentId: "LIFE_VEST",
      condition: "MISSING",
      note: "",
      outcome: "DEFERRED",
      deferUntil: "NEXT_CHECK",
      reason: "NO_STOCK",
    };
    const vest = at(store.addObservation(visit.id, vestInput).visit.observations, 1);
    expect(vest.melClass).toMatchObject({ class: "MEL", item: "FX-25-61-01" });
    store.closeObservation(visit.id, belt.id, "FIXED", 1);
    expect(errorOf(() => store.completeVisit(visit.id, undefined))).toMatchObject({ code: "MUST_FIX_OPEN", details: { observationIds: [vest.id] } });
    // and it can no longer be re-deferred, nor reworded to something milder
    expect(codeOf(() => store.updateObservation(visit.id, vest.id, { ...vestInput, reason: "OTHER" }, 1))).toBe("OUTCOME_NOT_ALLOWED");
    expect(store.completeVisit(visit.id, undefined, { aircraftHeld: true }).visit).toMatchObject({ status: "COMPLETED", aircraftHeld: true });
  });

  it("a record that closed a problem as REPLACED cannot be removed", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "Demo");
    const stain = at(store.addObservation(visit.id, STAIN_3A).visit.observations, 0);
    store.upsertRecord(visit.id, CUSHION_3A, undefined);
    store.upsertRecord(visit.id, { ...CUSHION_3A, componentId: "BACKREST" }, undefined);
    store.closeObservation(visit.id, stain.id, "REPLACED", 1);
    expect(errorOf(() => store.removeRecord(visit.id, "SEAT:3A", "CUSHION", undefined))).toMatchObject({
      code: "RECORD_IN_USE",
      status: 409,
      details: { observationIds: [stain.id] },
    });
    expect(store.removeRecord(visit.id, "SEAT:3A", "BACKREST", undefined).visit.records.map((r) => r.componentId)).toEqual(["CUSHION"]);
  });

  it("observation rows are locked in storage: no delete, no insert or close through a completed visit", () => {
    const store = openVisits(makeStores());
    const done = store.createVisit(snap(), "Demo").visit;
    const noted = at(store.addObservation(done.id, STAIN_3A).visit.observations, 0);
    const draft = store.createVisit(snap(), "Demo").visit;
    const columns =
      "tail, location_id, component_id, condition, note, outcome, mel_class_json, version, opened_in_visit_id, location_label, component_name, created_at, updated_at";
    const forge = (id: string, openedIn: string) =>
      `INSERT INTO visit_observations(id, ${columns}) SELECT '${id}', ${columns.replace("opened_in_visit_id", `'${openedIn}'`)} FROM visit_observations WHERE id = '${noted.id}'`;
    expect(() => store.rawExec(`DELETE FROM visit_observations WHERE id = '${noted.id}'`)).toThrow(/VISIT_DELETE_FORBIDDEN/);
    store.completeVisit(done.id, undefined);
    expect(() => store.rawExec(forge("forged-1", done.id))).toThrow(/VISIT_LOCKED/);
    store.rawExec(forge("forged-2", draft.id)); // through a draft the storage layer allows it
    expect(() =>
      store.rawExec(`UPDATE visit_observations SET status = 'CLOSED', closed_in_visit_id = '${done.id}', closed_as = 'FIXED' WHERE id = '${noted.id}'`),
    ).toThrow(/VISIT_LOCKED/);
    expect(store.getVisit(done.id).observations.map((o) => [o.id, o.status])).toEqual([[noted.id, "OPEN"]]);
  });

  it("observations are listed in the order they were recorded, whatever their timestamps", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "Demo");
    store.addObservation(visit.id, STAIN_3A, { now: "2026-11-12T12:05:00.000Z" });
    const v = store.addObservation(visit.id, { ...STAIN_3A, componentId: "HEADREST" }, { now: "2026-11-12T12:01:00.000Z" }).visit;
    expect(v.observations.map((o) => o.componentId)).toEqual(["CUSHION", "HEADREST"]);
  });

  it("an open MUST_FIX on an MEL item blocks completion too", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "Demo");
    const tray = { locationId: "SEAT:3A", componentId: "TRAY", condition: "BROKEN", note: "", outcome: "MUST_FIX" };
    const id = at(store.addObservation(visit.id, tray).visit.observations, 0).id;
    expect(errorOf(() => store.completeVisit(visit.id, undefined))).toMatchObject({ code: "MUST_FIX_OPEN", details: { observationIds: [id] } });
    store.closeObservation(visit.id, id, "FIXED", 1);
    expect(store.completeVisit(visit.id, undefined).visit.aircraftHeld).toBe(false);
  });

  it("a visit with only an observation completes", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "Demo");
    const v = store.addObservation(visit.id, STAIN_3A).visit;
    const done = store.completeVisit(visit.id, v.version);
    expect(done.visit).toMatchObject({ status: "COMPLETED", recordCount: 0, aircraftHeld: false });
    expect(done.report.reportKind).toBe("FINAL");
    // storage level: a raw completion of a visit with only an observation event is allowed
    const raw = store.createVisit(snap(), "Demo").visit;
    store.addObservation(raw.id, { ...STAIN_3A, componentId: "HEADREST" });
    store.rawExec(`UPDATE visits SET status = 'COMPLETED', completed_at = 'x' WHERE id = '${raw.id}'`);
    expect(store.getVisit(raw.id).status).toBe("COMPLETED");
  });

  it("a visit with nothing still fails with EMPTY_VISIT", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "Demo");
    store.addLinkedEvent(visit.id, "ADVISORY", "Not work.", "Lead");
    expect(errorOf(() => store.completeVisit(visit.id, undefined))).toMatchObject({ code: "EMPTY_VISIT", status: 409 });
    expect(() => store.rawExec(`UPDATE visits SET status = 'COMPLETED', completed_at = 'x' WHERE id = '${visit.id}'`)).toThrow(/EMPTY_VISIT/);
    expect(store.getVisit(visit.id).status).toBe("DRAFT");
  });

  it("N200TL V05 → V04: a BIN_ASSIST deferral arrives ORPHANED", () => {
    const store = openVisits(makeStores());
    const before = store.createVisit(snapshotFor(release, "N200TL", "2026-06-15"), "Demo").visit;
    const defer = { condition: "BROKEN", note: "Damper weak", outcome: "DEFERRED", deferUntil: "NEXT_CHECK", reason: "NO_STOCK" };
    const assist = at(store.addObservation(before.id, { ...defer, locationId: "BIN:L-02", componentId: "BIN_ASSIST" }).visit.observations, 0);
    expect(assist).toMatchObject({ dueDate: "2026-10-13", melClass: { class: "MEL", item: "FX-25-31-02", category: "D" } });
    const latch = at(store.addObservation(before.id, { ...defer, locationId: "BIN:L-02", componentId: "BIN_LATCH" }).visit.observations, 1);
    store.completeVisit(before.id, undefined);

    const late = store.createVisit(snapshotFor(release, "N200TL", "2026-11-12"), "Demo").visit;
    expect(late.carried.map((c) => [c.observation.id, c.placement, c.locationId, c.overdue])).toEqual([
      [latch.id, "SAME", "BIN:L-02", true],
      [assist.id, "ORPHANED", null, true],
    ]);
    const after = store.createVisit(snapshotFor(release, "N200TL", "2026-07-02"), "Demo").visit;
    expect(store.getVisit(after.id).snapshot.context.variant.id).toBe("V04");
    expect(after.carried.map((c) => [c.observation.id, c.placement, c.locationId, c.overdue])).toEqual([
      [latch.id, "SAME", "BIN:L-02", true], // MEL C: due 2026-06-25
      [assist.id, "ORPHANED", null, false], // MEL D: due 2026-10-13
    ]);
    expect(at(after.carried, 1).observation.locationLabel).toBe("Overhead bin L-02 (rows 3-5, 4 bags)");
    // R42: each names the check that opened it, by that visit's check date (not when the problem was written down)
    expect(after.carried.map((c) => c.openedCheckDate)).toEqual(["2026-06-15", "2026-06-15"]);
    // no record can be made on a piece that is not there, so it can only be closed as fixed
    expect(codeOf(() => store.closeObservation(after.id, assist.id, "REPLACED", 1))).toBe("REPLACEMENT_MISSING");
    expect(at(store.closeObservation(after.id, assist.id, "FIXED", 1).visit.observations, 0)).toMatchObject({ id: assist.id, status: "CLOSED" });
  });
});
