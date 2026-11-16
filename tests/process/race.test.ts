import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { Report } from "../../src/domain/types.ts";
import { ReferenceStore } from "../../src/server/referenceStore.ts";
import type { VisitStore } from "../../src/server/visitStore.ts";
import { cleanupTempDirs, CUSHION_3A, makeStores, openVisits, snapshotFor, type TestStores } from "../helpers.ts";

afterAll(cleanupTempDirs);

const worker = join(dirname(fileURLToPath(import.meta.url)), "worker.ts");
const BACKREST_3A = { ...CUSHION_3A, componentId: "BACKREST" };

interface Outcome {
  op: string;
  ok: boolean;
  code?: string;
  message?: string;
  alreadyCompleted?: boolean;
  report?: Report;
  records?: number;
}

/** Run one operation in a separate OS process with its own database connection. */
function run(stores: TestStores, visitId: string, op: string, startAt: number, payload: unknown): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, stores.visitsPath, stores.referencePath, visitId, op, String(startAt), JSON.stringify(payload)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (exit) => {
      if (exit !== 0 || !out) reject(new Error(`worker ${op} failed (${exit}): ${err}`));
      else resolve(JSON.parse(out) as Outcome);
    });
  });
}

function setup(): { stores: TestStores; store: VisitStore; newVisit: (records: unknown[]) => string } {
  const stores = makeStores();
  const ref = ReferenceStore.open(stores.referencePath, stores.visitsPath, { readOnly: true });
  const release = ref.loadActive();
  ref.close();
  const store = openVisits(stores);
  const snapshot = snapshotFor(release, "N100TL", "2026-11-12");
  return {
    stores,
    store,
    newVisit(records) {
      const visit = store.createVisit(snapshot, "Race").visit;
      for (const r of records) store.upsertRecord(visit.id, r, undefined);
      return visit.id;
    },
  };
}

const workKeys = (report: Report) => report.work.map((w) => `${w.locationId}/${w.componentId}`).sort();
const START_DELAY = 450;

describe("separate-process races", () => {
  it("edit versus complete: the edit is in the completed report, or it is rejected", async () => {
    const { stores, store, newVisit } = setup();
    const seen = new Set<string>();
    for (let i = 0; i < 14; i++) {
      const id = newVisit([CUSHION_3A]);
      const t = Date.now() + START_DELAY;
      // stagger alternately so both orders are exercised
      const skew = (i % 3) - 1; // -1, 0, +1
      const [edit, complete] = await Promise.all([
        run(stores, id, "upsert", t + Math.max(0, skew) * 25, { record: BACKREST_3A }),
        run(stores, id, "complete", t + Math.max(0, -skew) * 25, {}),
      ]);
      expect(complete.ok).toBe(true);
      const visit = store.getVisit(id);
      const stored = store.getReport(id).report;
      expect(visit.status).toBe("COMPLETED");
      expect(stored).toEqual(complete.report);
      // the locked report always equals the persisted records
      expect(workKeys(stored)).toEqual(visit.records.map((r) => `${r.locationId}/${r.componentId}`).sort());
      if (edit.ok) {
        seen.add("edit-first");
        expect(workKeys(stored)).toEqual(["SEAT:3A/BACKREST", "SEAT:3A/CUSHION"]);
        expect(stored.totals.map((x) => x.partNo)).toEqual(["FAKE-SC-1001", "FAKE-V01-ELR-A-BACKREST"]);
      } else {
        seen.add("complete-first");
        expect(edit.code).toBe("VISIT_LOCKED");
        expect(workKeys(stored)).toEqual(["SEAT:3A/CUSHION"]);
      }
    }
    expect([...seen].sort()).toEqual(["complete-first", "edit-first"]);
    store.close();
  });

  it("remove versus complete: removed work is absent from the report, or the removal is rejected", async () => {
    const { stores, store, newVisit } = setup();
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const id = newVisit([CUSHION_3A, BACKREST_3A]);
      const t = Date.now() + START_DELAY;
      const skew = (i % 3) - 1;
      const [remove, complete] = await Promise.all([
        run(stores, id, "remove", t + Math.max(0, skew) * 25, { locationId: "SEAT:3A", componentId: "BACKREST" }),
        run(stores, id, "complete", t + Math.max(0, -skew) * 25, {}),
      ]);
      expect(complete.ok).toBe(true);
      const stored = store.getReport(id).report;
      expect(stored).toEqual(complete.report);
      if (remove.ok) {
        seen.add("remove-first");
        expect(workKeys(stored)).toEqual(["SEAT:3A/CUSHION"]);
      } else {
        seen.add("complete-first");
        expect(remove.code).toBe("VISIT_LOCKED");
        expect(workKeys(stored)).toEqual(["SEAT:3A/BACKREST", "SEAT:3A/CUSHION"]);
      }
      expect(store.getVisit(id).records).toHaveLength(stored.work.length);
    }
    expect([...seen].sort()).toEqual(["complete-first", "remove-first"]);
    store.close();
  });

  it("removing the last record versus completing never yields a completed empty visit", async () => {
    const { stores, store, newVisit } = setup();
    for (let i = 0; i < 8; i++) {
      const id = newVisit([CUSHION_3A]);
      const t = Date.now() + START_DELAY;
      const skew = (i % 3) - 1;
      const [remove, complete] = await Promise.all([
        run(stores, id, "remove", t + Math.max(0, skew) * 25, { locationId: "SEAT:3A", componentId: "CUSHION" }),
        run(stores, id, "complete", t + Math.max(0, -skew) * 25, {}),
      ]);
      const visit = store.getVisit(id);
      if (remove.ok) {
        expect(complete).toMatchObject({ ok: false, code: "EMPTY_VISIT" });
        expect(visit).toMatchObject({ status: "DRAFT", recordCount: 0 });
      } else {
        expect(remove.code).toBe("VISIT_LOCKED");
        expect(complete.ok).toBe(true);
        expect(visit).toMatchObject({ status: "COMPLETED", recordCount: 1 });
      }
    }
    store.close();
  });

  it("concurrent completion is idempotent: one process completes, the others get the same report", async () => {
    const { stores, store, newVisit } = setup();
    for (let i = 0; i < 5; i++) {
      const id = newVisit([CUSHION_3A, BACKREST_3A]);
      const t = Date.now() + START_DELAY;
      const results = await Promise.all([0, 1, 2, 3].map(() => run(stores, id, "complete", t, {})));
      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.filter((r) => r.alreadyCompleted === false)).toHaveLength(1);
      for (const r of results) expect(r.report).toEqual(results[0].report);
      expect(store.getVisit(id).events.filter((e) => e.type === "COMPLETED")).toHaveLength(1);
    }
    store.close();
  });

  it("two editors of one record: exactly one wins, the other gets a conflict (no silent overwrite)", async () => {
    const { stores, store, newVisit } = setup();
    const panel = { locationId: "FLOOR:FWD", componentId: "CARPET_PANEL", selection: "PRIMARY", substituteId: null, note: "" };
    for (let i = 0; i < 6; i++) {
      const id = newVisit([]);
      const t = Date.now() + START_DELAY;
      const [a, b] = await Promise.all([
        run(stores, id, "upsert", t, { record: { ...panel, quantity: 2 }, expectedRecordVersion: 0 }),
        run(stores, id, "upsert", t, { record: { ...panel, quantity: 4 }, expectedRecordVersion: 0 }),
      ]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      const loser = a.ok ? b : a;
      expect(loser.code).toBe("STALE_RECORD");
      const record = store.getVisit(id).records[0];
      expect(record.version).toBe(1);
      expect(record.quantity).toBe(a.ok ? 2 : 4);
      expect(record.lines[0].qty).toBe(record.quantity);
    }
    store.close();
  });

  it("many processes adding different records all commit and the visit version counts every change", async () => {
    const { stores, store, newVisit } = setup();
    const id = newVisit([]);
    const seats = ["1A", "2A", "3A", "4A", "5A", "6A", "7A", "8A"];
    const t = Date.now() + START_DELAY;
    const results = await Promise.all(
      seats.map((s) => run(stores, id, "upsert", t, { record: { ...CUSHION_3A, locationId: `SEAT:${s}` }, expectedRecordVersion: 0 })),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const visit = store.getVisit(id);
    expect(visit.records.map((r) => r.locationId).sort()).toEqual(seats.map((s) => `SEAT:${s}`).sort());
    expect(visit.version).toBe(1 + seats.length);
    expect(visit.events.filter((e) => e.type === "RECORD_ADDED")).toHaveLength(seats.length);
    store.close();
  });
});
