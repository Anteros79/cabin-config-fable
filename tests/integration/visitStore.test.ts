import { afterAll, describe, expect, it } from "vitest";
import { lookup } from "../../src/domain/resolve.ts";
import type { Report } from "../../src/domain/types.ts";
import { DomainError } from "../../src/domain/visitLogic.ts";
import { buildStagedRelease } from "../../src/importer/assemble.ts";
import { ReferenceStore } from "../../src/server/referenceStore.ts";
import { IDEMPOTENCY_RETENTION_DAYS } from "../../src/server/visitStore.ts";
import { CUSHION_3A, cleanupTempDirs, fixtureRelease, KIT_ALTERNATE, KIT_PRIMARY, makeStores, openVisits, SIX_LINE_TOTALS, snapshotFor } from "../helpers.ts";

afterAll(cleanupTempDirs);

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
    store.close();
  });

  it("cushion and backrest at one seat are independent records", () => {
    const store = openVisits(makeStores());
    const { visit } = store.createVisit(snap(), "");
    store.upsertRecord(visit.id, CUSHION_3A, undefined);
    const v = store.upsertRecord(visit.id, { ...CUSHION_3A, componentId: "BACKREST" }, undefined).visit;
    expect(v.records.map((r) => r.componentId).sort()).toEqual(["BACKREST", "CUSHION"]);
    const after = store.removeRecord(visit.id, "SEAT:3A", "CUSHION", undefined).visit;
    expect(after.records.map((r) => r.componentId)).toEqual(["BACKREST"]);
    store.close();
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
    store.close();
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
    store.close();
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
    try {
      store.upsertRecord(visit.id, { ...panel, quantity: 3 }, 2);
    } catch (e) {
      expect((e as DomainError).status).toBe(409);
      expect((e as DomainError).details).toEqual({ current: null });
    }
    store.close();
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
    store.close();
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
    store.close();
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
    store.close();
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
    store.close();
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
    store.close();
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
    store.close();
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
    store.close();
  });
});

describe("reference updates do not rebase visits", () => {
  it("a draft and a completed report keep their frozen content after a new release is activated", () => {
    const stores = makeStores();
    const refA = ReferenceStore.open(stores.referencePath, stores.visitsPath);
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
    store.close();
  });

  it("changing the lookup form cannot retarget an existing visit", () => {
    const store = openVisits(makeStores());
    const visit = store.createVisit(snap(), "Demo").visit;
    lookup(release, "N200TL", "2026-07-01"); // another lookup has no effect on the stored visit
    const loaded = store.getVisit(visit.id);
    expect(loaded).toMatchObject({ tail: "N100TL", checkDate: "2026-11-12", variantId: "V01" });
    // a location valid only in another tail's layout is refused
    expect(codeOf(() => store.upsertRecord(visit.id, { locationId: "SEAT:14B", componentId: "CUSHION", selection: "PRIMARY", quantity: 1 }, undefined))).toBe(
      "UNKNOWN_LOCATION",
    );
    store.close();
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
    store.close();
  });

  it("the same event key with a different note is refused", () => {
    const { store, id } = fresh();
    store.addLinkedEvent(id, "ADVISORY", "Check seam", "JM", { idempotencyKey: "evt-key-0002" });
    expect(codeOf(() => store.addLinkedEvent(id, "ADVISORY", "Other note", "JM", { idempotencyKey: "evt-key-0002" }))).toBe("IDEMPOTENCY_KEY_REUSED");
    store.close();
  });

  it("note is trimmed before the length check; author over 80 is refused", () => {
    const { store, id } = fresh();
    const ok = store.addLinkedEvent(id, "ADVISORY", "  x  ", "  JM  ");
    expect(ok.visit.events.at(-1)?.payload).toMatchObject({ note: "x", author: "JM" });
    expect(codeOf(() => store.addLinkedEvent(id, "ADVISORY", " ".repeat(5), "JM"))).toBe("INVALID_EVENT");
    expect(codeOf(() => store.addLinkedEvent(id, "ADVISORY", "x", "a".repeat(81)))).toBe("INVALID_EVENT");
    store.close();
  });

  it("pruneIdempotency removes only rows older than the cutoff", () => {
    const { store, id } = fresh();
    const now = Date.now();
    store.addLinkedEvent(id, "ADVISORY", "old", "JM", { idempotencyKey: "evt-key-old1", now: new Date(now - 40 * day).toISOString() });
    store.addLinkedEvent(id, "ADVISORY", "new", "JM", { idempotencyKey: "evt-key-new1", now: new Date(now - 5 * day).toISOString() });
    expect(store.pruneIdempotency(new Date(now - IDEMPOTENCY_RETENTION_DAYS * day).toISOString())).toBe(1);
    expect(store.addLinkedEvent(id, "ADVISORY", "new", "JM", { idempotencyKey: "evt-key-new1" }).replayed).toBe(true);
    expect(store.addLinkedEvent(id, "ADVISORY", "old", "JM", { idempotencyKey: "evt-key-old1" }).replayed).toBe(false);
    store.close();
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
    store.close();
  });
});
