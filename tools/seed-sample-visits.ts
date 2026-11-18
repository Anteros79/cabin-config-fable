// Adds three fictional sample visits to the configured visit store: a completed one on N100TL that deferred one problem,
// a draft on N200TL, and a later draft on N100TL that shows the deferred problem carried over.
// Non-destructive: it only runs when the visit store has no visits, and never touches reference data
// beyond creating the reference store if it does not exist yet.
//   node tools/seed-sample-visits.ts [--data-dir DIR]

import { lookup } from "../src/domain/resolve.ts";
import type { ReferenceRelease } from "../src/domain/types.ts";
import { buildSnapshot } from "../src/domain/visitLogic.ts";
import { isEntryPoint, parseCliArgs, UsageError } from "../src/importer/args.ts";
import { importReference } from "../src/importer/cli.ts";
import { resolveStoreConfig } from "../src/server/config.ts";
import { inspectStore, ReferenceStore } from "../src/server/referenceStore.ts";
import { VisitStore } from "../src/server/visitStore.ts";

const TECHNICIAN = "Sample Technician (fictional)";

/** The command failed in a way the operator should read about in one line. */
class SeedError extends Error {}

function main(argv: string[]): number {
  let dataDir: string | undefined;
  try {
    dataDir = parseCliArgs(argv, { "data-dir": { type: "string" } })["data-dir"];
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`${e.message}\nUsage: node tools/seed-sample-visits.ts [--data-dir DIR]`);
    return 64;
  }
  const stores = resolveStoreConfig({ dataDir });

  if (inspectStore(stores.referencePath).kind !== "reference") {
    const outcome = importReference({ referencePath: stores.referencePath, visitsPath: stores.visitsPath });
    if (outcome.status === "rejected")
      throw new SeedError(
        `The reference import was rejected (${outcome.releaseId}); run "npm run reference:findings" to see why. No sample visits were added.`,
      );
    console.log(`Reference store created: ${outcome.releaseId} (${outcome.status}).`);
  }
  const reference = ReferenceStore.open(stores.referencePath, stores.visitsPath, { readOnly: true });
  let release: ReferenceRelease;
  try {
    release = reference.loadActive();
  } catch (e) {
    throw new SeedError(`No usable reference release: ${(e as Error).message} No sample visits were added.`);
  } finally {
    reference.close();
  }

  const visits = VisitStore.open(stores.visitsPath, stores.referencePath);
  try {
    const existing = visits.listVisits({ limit: 2 });
    const sampleVisits = existing.items.filter((v) => v.technician === TECHNICIAN);
    const partial =
      existing.total === 1 || (existing.total === 2 && sampleVisits.length === 2 && sampleVisits.some((v) => v.status === "DRAFT" && v.recordCount < 2));
    if (partial && sampleVisits.length === existing.total) {
      throw new SeedError(
        `The visit store holds an incomplete sample (${existing.total === 1 ? "one visit" : "a draft with fewer than 2 records"}): an earlier seeding stopped part-way. Delete ${stores.visitsPath} (or use a fresh --data-dir) and run this again.`,
      );
    }
    if (existing.total > 0) {
      console.log("The visit store already has visits; sample visits were not added.");
      console.log(`Stores: ${stores.referencePath} | ${stores.visitsPath}`);
      return 0;
    }

    // Build both snapshots before anything is written: if either lookup does not resolve, nothing is added.
    const now = new Date().toISOString();
    const snapshot = (tail: string, date: string) => {
      const result = lookup(release, tail, date);
      if (result.state !== "RESOLVED")
        throw new SeedError(`The lookup for ${tail} on ${date} is ${result.state}, not RESOLVED: ${result.message} No sample visits were added.`);
      return buildSnapshot(release, result, now);
    };
    const completedSnapshot = snapshot("N100TL", "2026-11-12");
    const draftSnapshot = snapshot("N200TL", "2026-07-01");
    const carriedSnapshot = snapshot("N100TL", "2026-11-19");

    const completed = visits.createVisit(completedSnapshot, TECHNICIAN).visit;
    visits.upsertRecord(
      completed.id,
      { locationId: "SEAT:3A", componentId: "CUSHION", selection: "PRIMARY", substituteId: null, quantity: 1, note: "Sample: torn seam on the leading edge." },
      0,
    );
    visits.upsertRecord(
      completed.id,
      {
        locationId: "FLOOR:FULL-CABIN",
        componentId: "CARPET_KIT",
        selection: "ALTERNATE",
        substituteId: "FX-SUB-KIT-1",
        quantity: 1,
        note: "Sample: alternate kit used under the fictional deviation.",
      },
      0,
    );
    // A tray table broken at 7C, deferred for lack of stock: fictional MEL item FX-25-22-01, category D (120 days).
    visits.addObservation(completed.id, {
      locationId: "SEAT:7C",
      componentId: "TRAY",
      condition: "BROKEN",
      note: "Sample: the latch does not hold the tray table stowed.",
      outcome: "DEFERRED",
      deferUntil: "NEXT_CHECK",
      reason: "NO_STOCK",
    });
    const done = visits.completeVisit(completed.id, undefined);
    console.log(`Completed sample visit #${done.visit.number}: ${done.report.totals.map((t) => `${t.partNo} ${t.quantity} ${t.unit}`).join(", ")}`);

    const draft = visits.createVisit(draftSnapshot, TECHNICIAN).visit;
    visits.upsertRecord(
      draft.id,
      { locationId: "SEAT:12C", componentId: "BACKREST", selection: "PRIMARY", substituteId: null, quantity: 1, note: "Sample draft record." },
      0,
    );
    visits.upsertRecord(draft.id, { locationId: "BIN:L-04", componentId: "BIN_DOOR", selection: "PRIMARY", substituteId: null, quantity: 1, note: "" }, 0);
    console.log(`Draft sample visit #${draft.number} left open with 2 records.`);

    // The next check on N100TL: the deferred tray table is carried over and waits to be closed or deferred again.
    const next = visits.createVisit(carriedSnapshot, TECHNICIAN).visit;
    const carried = visits.getVisit(next.id).carried;
    if (carried.length !== 1) throw new SeedError(`Expected the deferred problem to carry over to the next N100TL check, found ${carried.length}.`);
    console.log(
      `Sample visit #${done.visit.number} was completed with 1 deferred problem (tray table at 7C, due ${carried[0]?.observation.dueDate ?? "n/a"}).`,
    );
    console.log(`Draft sample visit #${next.number} on N100TL shows 1 carried-over problem.`);
  } finally {
    visits.close();
  }
  console.log(`Stores: ${stores.referencePath} | ${stores.visitsPath}`);
  return 0;
}

if (isEntryPoint(import.meta.url, import.meta.main)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof SeedError ? e.message : `Seeding failed: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
