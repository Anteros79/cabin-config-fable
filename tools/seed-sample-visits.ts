// Adds two fictional sample visits (one draft, one completed) to the configured visit store.
// Non-destructive: it only runs when the visit store has no visits, and never touches reference data
// beyond creating the reference store if it does not exist yet.
//   node tools/seed-sample-visits.ts [--data-dir DIR]
import { lookup } from "../src/domain/resolve.ts";
import { buildSnapshot } from "../src/domain/visitLogic.ts";
import { importReference } from "../src/importer/cli.ts";
import { resolveStoreConfig } from "../src/server/config.ts";
import { inspectStore, ReferenceStore } from "../src/server/referenceStore.ts";
import { VisitStore } from "../src/server/visitStore.ts";

const dirFlag = process.argv.indexOf("--data-dir");
const stores = resolveStoreConfig({ dataDir: dirFlag > 0 ? process.argv[dirFlag + 1] : undefined });

if (inspectStore(stores.referencePath).kind !== "reference") {
  const outcome = importReference({ referencePath: stores.referencePath, visitsPath: stores.visitsPath });
  console.log(`Reference store created: ${outcome.releaseId} (${outcome.status}).`);
}
const reference = ReferenceStore.open(stores.referencePath, stores.visitsPath, { readOnly: true });
const release = reference.loadActive();
reference.close();

const visits = VisitStore.open(stores.visitsPath, stores.referencePath);
try {
  if (visits.counts().visits > 0) {
    console.log("The visit store already has visits; sample visits were not added.");
  } else {
    const now = new Date().toISOString();
    const snapshot = (tail: string, date: string) => buildSnapshot(release, lookup(release, tail, date), now);

    const completed = visits.createVisit(snapshot("N100TL", "2026-11-12"), "Sample Technician (fictional)").visit;
    visits.upsertRecord(completed.id, { locationId: "SEAT:3A", componentId: "CUSHION", selection: "PRIMARY", substituteId: null, quantity: 1, note: "Sample: torn seam on the leading edge." }, 0);
    visits.upsertRecord(completed.id, { locationId: "FLOOR:FULL-CABIN", componentId: "CARPET_KIT", selection: "ALTERNATE", substituteId: "FX-SUB-KIT-1", quantity: 1, note: "Sample: alternate kit used under the fictional deviation." }, 0);
    const done = visits.completeVisit(completed.id, undefined);
    console.log(`Completed sample visit #${done.visit.number}: ${done.report.totals.map((t) => `${t.partNo} ${t.quantity} ${t.unit}`).join(", ")}`);

    const draft = visits.createVisit(snapshot("N200TL", "2026-07-01"), "Sample Technician (fictional)").visit;
    visits.upsertRecord(draft.id, { locationId: "SEAT:12C", componentId: "BACKREST", selection: "PRIMARY", substituteId: null, quantity: 1, note: "Sample draft record." }, 0);
    visits.upsertRecord(draft.id, { locationId: "BIN:L-04", componentId: "BIN_DOOR", selection: "PRIMARY", substituteId: null, quantity: 1, note: "" }, 0);
    console.log(`Draft sample visit #${draft.number} left open with 2 records.`);
  }
} finally {
  visits.close();
}
console.log(`Stores: ${stores.referencePath} | ${stores.visitsPath}`);
