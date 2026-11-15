// Child process used by the race tests. It opens its own connection to the visit store,
// waits for an agreed start time, performs one operation and prints the outcome as JSON.
import { DomainError } from "../../src/domain/visitLogic.ts";
import { VisitStore } from "../../src/server/visitStore.ts";

const [visitsPath, referencePath, visitId, op, startAtText, payloadText] = process.argv.slice(2);
const payload = payloadText ? JSON.parse(payloadText) : {};
const store = VisitStore.open(visitsPath, referencePath);
const startAt = Number(startAtText);
while (Date.now() < startAt) {
  /* spin until the agreed start so both processes collide */
}
let outcome: Record<string, unknown>;
try {
  if (op === "upsert") {
    const result = store.upsertRecord(visitId, payload.record, payload.expectedRecordVersion);
    outcome = { ok: true, version: result.visit.version, records: result.visit.records.length };
  } else if (op === "remove") {
    const result = store.removeRecord(visitId, payload.locationId, payload.componentId, payload.expectedRecordVersion);
    outcome = { ok: true, version: result.visit.version, records: result.visit.records.length };
  } else if (op === "complete") {
    const result = store.completeVisit(visitId, payload.expectedVisitVersion);
    outcome = { ok: true, alreadyCompleted: result.alreadyCompleted, report: result.report };
  } else {
    outcome = { ok: false, code: "UNKNOWN_OP" };
  }
} catch (e) {
  outcome = { ok: false, code: e instanceof DomainError ? e.code : "ERROR", message: (e as Error).message };
}
store.close();
process.stdout.write(JSON.stringify({ op, at: Date.now(), ...outcome }));
