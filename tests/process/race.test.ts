import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Report, Visit } from "../../src/domain/types.ts";
import { ReferenceStore } from "../../src/server/referenceStore.ts";
import { STORE_BUSY_TIMEOUT_MS } from "../../src/server/storageError.ts";
import type { VisitStore } from "../../src/server/visitStore.ts";
import { at, CUSHION_3A, makeStores, openVisits, snapshotFor, type TestStores } from "../helpers.ts";

const workerPath = join(dirname(fileURLToPath(import.meta.url)), "worker.ts");
const BACKREST_3A = { ...CUSHION_3A, componentId: "BACKREST" };
const PANEL = { locationId: "FLOOR:FWD", componentId: "CARPET_PANEL", selection: "PRIMARY", substituteId: null, note: "" };
/** Fresh visits per simultaneous-release test. Which worker wins is up to SQLite; the invariants must hold every time. */
const ROUNDS = 3;

interface Outcome {
  op: string;
  ok: boolean;
  code?: string;
  message?: string;
  alreadyCompleted?: boolean;
  report?: Report;
  version?: number;
  records?: number;
}

/** How long a worker may take to print its next line: well under the 60 s test timeout, so a hung worker is named, not timed out. */
const LINE_TIMEOUT_MS = 15_000;
/** Every worker spawned by the current test; any still running afterwards is killed, whether the test passed or failed. */
const live: Worker[] = [];
afterEach(() => {
  for (const worker of live.splice(0)) worker.kill();
});

/** One operation in a separate OS process with its own database connection, driven line by line (see worker.ts). */
class Worker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: string[] = [];
  private readonly waiting: { resolve: (line: string) => void; reject: (e: Error) => void }[] = [];
  private stderr = "";
  private exit: number | null | undefined;
  private spawnError: Error | undefined;
  private readonly exited: Promise<number | null>;
  readonly op: string;
  readonly name: string;

  constructor(stores: TestStores, visitId: string, op: string, payload: unknown, index: number) {
    this.op = op;
    this.child = spawn(process.execPath, [workerPath, stores.visitsPath, stores.referencePath, visitId, op, JSON.stringify(payload)]);
    this.name = `worker ${index} (${op}, pid ${this.child.pid ?? "none"})`;
    live.push(this);
    this.child.stderr.on("data", (d) => (this.stderr += d));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const waiter = this.waiting.shift();
      if (waiter) waiter.resolve(line);
      else this.lines.push(line);
    });
    this.exited = new Promise((resolve, reject) => {
      this.child.on("error", (e) => {
        this.spawnError = e;
        for (const waiter of this.waiting.splice(0)) waiter.reject(this.failure());
        reject(e);
      });
      this.child.on("close", (code) => {
        this.exit = code;
        for (const waiter of this.waiting.splice(0)) waiter.reject(this.failure());
        resolve(code);
      });
    });
    // A spawn error reaches the test through the next line it waits for; this keeps it from also being an unhandled rejection.
    this.exited.catch(() => undefined);
  }

  kill(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
  }

  private failure(): Error {
    if (this.spawnError) return new Error(`${this.name} could not start: ${this.spawnError.message}`);
    return new Error(`${this.name} exited (${this.exit}) before its next line: ${this.stderr}`);
  }

  /** The worker's next line, or a failure naming the worker and the line it was expected to print. */
  private next(expected: string): Promise<string> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.exit !== undefined || this.spawnError) return Promise.reject(this.failure());
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (l: string) => {
          clearTimeout(timer);
          resolve(l);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        this.waiting.splice(this.waiting.indexOf(waiter), 1);
        reject(new Error(`${this.name} did not print ${expected} within ${LINE_TIMEOUT_MS} ms; stderr: ${this.stderr || "(empty)"}`));
      }, LINE_TIMEOUT_MS);
      this.waiting.push(waiter);
    });
  }

  /** The worker's exit code, or a failure naming the worker when it has not exited within the line timeout. */
  private exitCode(): Promise<number | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${this.name} did not exit within ${LINE_TIMEOUT_MS} ms; stderr: ${this.stderr || "(empty)"}`)),
        LINE_TIMEOUT_MS,
      );
    });
    return Promise.race([this.exited, timeout]).finally(() => clearTimeout(timer));
  }

  async ready(): Promise<void> {
    expect(await this.next('"ready"'), this.name).toBe("ready");
  }

  go(): void {
    this.child.stdin.end("go\n");
  }

  async started(): Promise<void> {
    expect(await this.next('"started"'), this.name).toBe("started");
  }

  async result(): Promise<Outcome> {
    // "started" may still be unread when the release did not wait for it (inOrder).
    let line = await this.next("its result");
    if (line === "started") line = await this.next("its result");
    const outcome = JSON.parse(line) as Outcome;
    expect(await this.exitCode(), `${this.name}: ${this.stderr}`).toBe(0);
    return outcome;
  }
}

/** Spawn every worker, then wait until each one has its store open: from here on nothing runs until a "go". */
async function spawnReady(stores: TestStores, visitId: string, specs: [op: string, payload: unknown][]): Promise<Worker[]> {
  const workers = specs.map(([op, payload], index) => new Worker(stores, visitId, op, payload, index));
  await Promise.all(workers.map((w) => w.ready()));
  return workers;
}

/** Release the workers one at a time, each only after the previous one has printed its result. */
async function inOrder(workers: Worker[]): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const w of workers) {
    w.go();
    outcomes.push(await w.result());
  }
  return outcomes;
}

/**
 * Release every worker in one tick while this test holds the store's write lock, and keep holding it until each worker
 * has printed "started" (written synchronously just before it calls the store). What this proves: every worker had passed
 * "started", and none had committed (the visit version is unchanged), before the lock was released. Which one SQLite lets
 * in first, and how far each got before blocking on the lock, is not asserted.
 */
async function together(stores: TestStores, visitId: string, workers: Worker[]): Promise<Outcome[]> {
  const gate = new DatabaseSync(stores.visitsPath, { timeout: STORE_BUSY_TIMEOUT_MS });
  const versionOf = () => (gate.prepare("SELECT version FROM visits WHERE id = ?").get(visitId) as { version: number }).version;
  gate.exec("BEGIN IMMEDIATE");
  try {
    const before = versionOf();
    for (const w of workers) w.go();
    await Promise.all(workers.map((w) => w.started()));
    expect(versionOf(), "no worker may commit while the gate holds the write lock").toBe(before);
  } finally {
    gate.exec("COMMIT");
    gate.close();
  }
  return Promise.all(workers.map((w) => w.result()));
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

const keyOf = (r: { locationId: string; componentId: string }) => `${r.locationId}/${r.componentId}`;
const workKeys = (report: Report) => report.work.map(keyOf).sort();
const recordKeys = (visit: Visit) => visit.records.map(keyOf).sort();
const eventTypes = (visit: Visit) => visit.events.map((e) => e.type);

/** The visit has records, each with part lines, and every line carries its record's quantity: no half-written row. */
function expectWholeRecords(visit: Visit): void {
  expect(visit.records.length, "a visit with no records proves nothing here").toBeGreaterThan(0);
  for (const record of visit.records) {
    expect(record.lines.length, `${keyOf(record)} has no part lines`).toBeGreaterThan(0);
    expect(record.lines.every((line) => line.qty === record.quantity)).toBe(true);
  }
}

/**
 * The invariants of a completion racing one edit (an upsert or a removal of `key`), for any order: completion succeeds;
 * the edit commits or gets VISIT_LOCKED; the stored report is the one returned, equals the persisted records and has
 * the edit exactly when the edit's event comes before COMPLETED. Returns which order the store took.
 */
function expectEditVersusComplete(store: VisitStore, id: string, edit: Outcome, complete: Outcome, editEvent: string): "edit-first" | "complete-first" {
  expect(complete.ok).toBe(true);
  expect(complete.alreadyCompleted).toBe(false);
  const visit = store.getVisit(id);
  const stored = store.getReport(id).report;
  expect(visit.status).toBe("COMPLETED");
  expect(stored).toEqual(complete.report);
  expect(workKeys(stored)).toEqual(recordKeys(visit));
  expectWholeRecords(visit);
  const types = eventTypes(visit);
  expect(types.filter((t) => t === "COMPLETED")).toHaveLength(1);
  if (edit.ok) {
    expect(types.lastIndexOf(editEvent)).toBeLessThan(types.indexOf("COMPLETED"));
    return "edit-first";
  }
  expect(edit.code).toBe("VISIT_LOCKED");
  expect(types.at(-1)).toBe("COMPLETED");
  return "complete-first";
}

/** One editor of a record that does not exist yet wins; the other gets STALE_RECORD; the record is the winner's. */
function expectOneEditorWins(store: VisitStore, id: string, a: Outcome, b: Outcome): "a" | "b" {
  expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  expect((a.ok ? b : a).code).toBe("STALE_RECORD");
  const visit = store.getVisit(id);
  expect(visit.records).toHaveLength(1);
  const record = at(visit.records, 0);
  expect(record.version).toBe(1);
  expect(record.quantity).toBe(a.ok ? 2 : 4);
  expectWholeRecords(visit);
  expect(visit.version).toBe(2);
  expect(eventTypes(visit).filter((t) => t === "RECORD_ADDED")).toHaveLength(1);
  return a.ok ? "a" : "b";
}

/** Removing the last record versus completing: either a draft with nothing in it, or a completed visit with the record. */
function expectNoEmptyCompletion(store: VisitStore, id: string, remove: Outcome, complete: Outcome): "remove-first" | "complete-first" {
  const visit = store.getVisit(id);
  if (remove.ok) {
    expect(complete).toMatchObject({ ok: false, code: "EMPTY_VISIT" });
    expect(visit).toMatchObject({ status: "DRAFT", recordCount: 0 });
    return "remove-first";
  }
  expect(remove.code).toBe("VISIT_LOCKED");
  expect(complete).toMatchObject({ ok: true, alreadyCompleted: false });
  expect(visit).toMatchObject({ status: "COMPLETED", recordCount: 1 });
  expect(workKeys(store.getReport(id).report)).toEqual(["SEAT:3A/CUSHION"]);
  return "complete-first";
}

/** Completions of one visit: exactly one completes, every one returns the same stored report, one COMPLETED event. */
function expectOneCompletion(store: VisitStore, id: string, outcomes: Outcome[]): void {
  expect(outcomes.every((r) => r.ok)).toBe(true);
  expect(outcomes.filter((r) => r.alreadyCompleted === false)).toHaveLength(1);
  const stored = store.getReport(id).report;
  for (const r of outcomes) expect(r.report).toEqual(stored);
  expect(workKeys(stored)).toEqual(["SEAT:3A/BACKREST", "SEAT:3A/CUSHION"]);
  expect(eventTypes(store.getVisit(id)).filter((t) => t === "COMPLETED")).toHaveLength(1);
}

const SEATS = ["1A", "2A", "3A", "4A", "5A", "6A", "7A", "8A"];
const seatWriters = (): [string, unknown][] => SEATS.map((s) => ["upsert", { record: { ...CUSHION_3A, locationId: `SEAT:${s}` }, expectedRecordVersion: 0 }]);

/** Writers of different records: every one commits, and the visit version counts every change. */
function expectAllWritersCommitted(store: VisitStore, id: string, outcomes: Outcome[]): void {
  expect(outcomes.every((r) => r.ok)).toBe(true);
  const visit = store.getVisit(id);
  expect(recordKeys(visit)).toEqual(SEATS.map((s) => `SEAT:${s}/CUSHION`).sort());
  expectWholeRecords(visit);
  expect(visit.version).toBe(1 + SEATS.length);
  expect(eventTypes(visit).filter((t) => t === "RECORD_ADDED")).toHaveLength(SEATS.length);
  expect(outcomes.map((r) => r.version).sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual(SEATS.map((_, i) => 2 + i));
}

describe("separate-process races, released in a fixed order", () => {
  it("two editors of one record, A then B: A's edit stands and B gets STALE_RECORD", async () => {
    const { stores, store, newVisit } = setup();
    const id = newVisit([]);
    const [a, b] = await inOrder(
      await spawnReady(stores, id, [
        ["upsert", { record: { ...PANEL, quantity: 2 }, expectedRecordVersion: 0 }],
        ["upsert", { record: { ...PANEL, quantity: 4 }, expectedRecordVersion: 0 }],
      ]),
    );
    expect(expectOneEditorWins(store, id, a as Outcome, b as Outcome)).toBe("a");
  });

  it("two editors of one record, B then A: B's edit stands and A gets STALE_RECORD", async () => {
    const { stores, store, newVisit } = setup();
    const id = newVisit([]);
    const [a, b] = await spawnReady(stores, id, [
      ["upsert", { record: { ...PANEL, quantity: 2 }, expectedRecordVersion: 0 }],
      ["upsert", { record: { ...PANEL, quantity: 4 }, expectedRecordVersion: 0 }],
    ]);
    const [bOut, aOut] = await inOrder([b as Worker, a as Worker]);
    expect(expectOneEditorWins(store, id, aOut as Outcome, bOut as Outcome)).toBe("b");
  });

  it("edit then complete: the edit is in the completed report", async () => {
    const { stores, store, newVisit } = setup();
    const id = newVisit([CUSHION_3A]);
    const [edit, complete] = await inOrder(
      await spawnReady(stores, id, [
        ["upsert", { record: BACKREST_3A }],
        ["complete", {}],
      ]),
    );
    expect(expectEditVersusComplete(store, id, edit as Outcome, complete as Outcome, "RECORD_ADDED")).toBe("edit-first");
    const stored = store.getReport(id).report;
    expect(workKeys(stored)).toEqual(["SEAT:3A/BACKREST", "SEAT:3A/CUSHION"]);
    expect(stored.totals.map((x) => x.partNo)).toEqual(["FAKE-SC-1001", "FAKE-V01-ELR-A-BACKREST"]);
  });

  it("complete then edit: the edit is rejected with VISIT_LOCKED and the report holds only the earlier work", async () => {
    const { stores, store, newVisit } = setup();
    const id = newVisit([CUSHION_3A]);
    const [edit, complete] = await spawnReady(stores, id, [
      ["upsert", { record: BACKREST_3A }],
      ["complete", {}],
    ]);
    const [completeOut, editOut] = await inOrder([complete as Worker, edit as Worker]);
    expect(expectEditVersusComplete(store, id, editOut as Outcome, completeOut as Outcome, "RECORD_ADDED")).toBe("complete-first");
    expect(workKeys(store.getReport(id).report)).toEqual(["SEAT:3A/CUSHION"]);
  });

  it("remove then complete: the removed work is absent from the report", async () => {
    const { stores, store, newVisit } = setup();
    const id = newVisit([CUSHION_3A, BACKREST_3A]);
    const [remove, complete] = await inOrder(
      await spawnReady(stores, id, [
        ["remove", { locationId: "SEAT:3A", componentId: "BACKREST" }],
        ["complete", {}],
      ]),
    );
    expect(expectEditVersusComplete(store, id, remove as Outcome, complete as Outcome, "RECORD_REMOVED")).toBe("edit-first");
    expect(workKeys(store.getReport(id).report)).toEqual(["SEAT:3A/CUSHION"]);
  });

  it("complete then remove: the removal is rejected with VISIT_LOCKED and the report keeps the work", async () => {
    const { stores, store, newVisit } = setup();
    const id = newVisit([CUSHION_3A, BACKREST_3A]);
    const [remove, complete] = await spawnReady(stores, id, [
      ["remove", { locationId: "SEAT:3A", componentId: "BACKREST" }],
      ["complete", {}],
    ]);
    const [completeOut, removeOut] = await inOrder([complete as Worker, remove as Worker]);
    expect(expectEditVersusComplete(store, id, removeOut as Outcome, completeOut as Outcome, "RECORD_REMOVED")).toBe("complete-first");
    expect(workKeys(store.getReport(id).report)).toEqual(["SEAT:3A/BACKREST", "SEAT:3A/CUSHION"]);
  });

  it("removing the last record, then completing: completion is refused with EMPTY_VISIT", async () => {
    const { stores, store, newVisit } = setup();
    const id = newVisit([CUSHION_3A]);
    const [remove, complete] = await inOrder(
      await spawnReady(stores, id, [
        ["remove", { locationId: "SEAT:3A", componentId: "CUSHION" }],
        ["complete", {}],
      ]),
    );
    expect(expectNoEmptyCompletion(store, id, remove as Outcome, complete as Outcome)).toBe("remove-first");
  });

  it("completing, then removing the last record: the removal is refused with VISIT_LOCKED", async () => {
    const { stores, store, newVisit } = setup();
    const id = newVisit([CUSHION_3A]);
    const [remove, complete] = await spawnReady(stores, id, [
      ["remove", { locationId: "SEAT:3A", componentId: "CUSHION" }],
      ["complete", {}],
    ]);
    const [completeOut, removeOut] = await inOrder([complete as Worker, remove as Worker]);
    expect(expectNoEmptyCompletion(store, id, removeOut as Outcome, completeOut as Outcome)).toBe("complete-first");
  });

  it("repeated completion: the first process completes, the later ones get the same report", async () => {
    const { stores, store, newVisit } = setup();
    const id = newVisit([CUSHION_3A, BACKREST_3A]);
    const outcomes = await inOrder(
      await spawnReady(stores, id, [
        ["complete", {}],
        ["complete", {}],
        ["complete", {}],
      ]),
    );
    expectOneCompletion(store, id, outcomes);
    expect(outcomes.map((r) => r.alreadyCompleted)).toEqual([false, true, true]);
  });

  it("writers of different records one after another: each sees the version after the previous change", async () => {
    const { stores, store, newVisit } = setup();
    const id = newVisit([]);
    const outcomes = await inOrder(await spawnReady(stores, id, seatWriters()));
    expectAllWritersCommitted(store, id, outcomes);
    expect(outcomes.map((r) => r.version)).toEqual(SEATS.map((_, i) => 2 + i));
    expect(outcomes.map((r) => r.records)).toEqual(SEATS.map((_, i) => 1 + i));
  });
});

describe("separate-process races, released together (invariants that hold for every interleaving)", () => {
  it("two editors of one record: exactly one wins, the other gets a conflict (no silent overwrite)", async () => {
    const { stores, store, newVisit } = setup();
    for (let round = 0; round < ROUNDS; round++) {
      const id = newVisit([]);
      const workers = await spawnReady(stores, id, [
        ["upsert", { record: { ...PANEL, quantity: 2 }, expectedRecordVersion: 0 }],
        ["upsert", { record: { ...PANEL, quantity: 4 }, expectedRecordVersion: 0 }],
      ]);
      const [a, b] = await together(stores, id, workers);
      expectOneEditorWins(store, id, a as Outcome, b as Outcome);
    }
  });

  it("edit versus complete: the edit is in the completed report, or it is rejected", async () => {
    const { stores, store, newVisit } = setup();
    for (let round = 0; round < ROUNDS; round++) {
      const id = newVisit([CUSHION_3A]);
      const [edit, complete] = await together(
        stores,
        id,
        await spawnReady(stores, id, [
          ["upsert", { record: BACKREST_3A }],
          ["complete", {}],
        ]),
      );
      const order = expectEditVersusComplete(store, id, edit as Outcome, complete as Outcome, "RECORD_ADDED");
      expect(workKeys(store.getReport(id).report)).toEqual(order === "edit-first" ? ["SEAT:3A/BACKREST", "SEAT:3A/CUSHION"] : ["SEAT:3A/CUSHION"]);
    }
  });

  it("remove versus complete: removed work is absent from the report, or the removal is rejected", async () => {
    const { stores, store, newVisit } = setup();
    for (let round = 0; round < ROUNDS; round++) {
      const id = newVisit([CUSHION_3A, BACKREST_3A]);
      const [remove, complete] = await together(
        stores,
        id,
        await spawnReady(stores, id, [
          ["remove", { locationId: "SEAT:3A", componentId: "BACKREST" }],
          ["complete", {}],
        ]),
      );
      const order = expectEditVersusComplete(store, id, remove as Outcome, complete as Outcome, "RECORD_REMOVED");
      expect(workKeys(store.getReport(id).report)).toEqual(order === "edit-first" ? ["SEAT:3A/CUSHION"] : ["SEAT:3A/BACKREST", "SEAT:3A/CUSHION"]);
    }
  });

  it("removing the last record versus completing never yields a completed empty visit", async () => {
    const { stores, store, newVisit } = setup();
    for (let round = 0; round < ROUNDS; round++) {
      const id = newVisit([CUSHION_3A]);
      const [remove, complete] = await together(
        stores,
        id,
        await spawnReady(stores, id, [
          ["remove", { locationId: "SEAT:3A", componentId: "CUSHION" }],
          ["complete", {}],
        ]),
      );
      expectNoEmptyCompletion(store, id, remove as Outcome, complete as Outcome);
    }
  });

  it("concurrent completion is idempotent: one process completes, the others get the same report", async () => {
    const { stores, store, newVisit } = setup();
    for (let round = 0; round < ROUNDS; round++) {
      const id = newVisit([CUSHION_3A, BACKREST_3A]);
      const outcomes = await together(
        stores,
        id,
        await spawnReady(
          stores,
          id,
          [0, 1, 2, 3].map((): [string, unknown] => ["complete", {}]),
        ),
      );
      expectOneCompletion(store, id, outcomes);
    }
  });

  it("many processes adding different records all commit and the visit version counts every change", async () => {
    const { stores, store, newVisit } = setup();
    const id = newVisit([]);
    expectAllWritersCommitted(store, id, await together(stores, id, await spawnReady(stores, id, seatWriters())));
  });
});
