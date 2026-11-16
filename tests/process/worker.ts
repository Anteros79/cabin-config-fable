// Child process used by the race tests. Protocol over stdio, one line per message:
//   worker → parent  "ready"     the store is open (and its open-time writes are done)
//   parent → worker  "go"        perform the operation now
//   worker → parent  "started"   written synchronously just before the operation is called
//   worker → parent  {JSON}      the outcome, then the worker closes the store and exits
// The parent decides the order by when it writes "go"; nothing here waits on the clock.
import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { DomainError } from "../../src/domain/visitLogic.ts";
import { VisitStore } from "../../src/server/visitStore.ts";

const [visitsPath, referencePath, visitId, op, payloadText] = process.argv.slice(2);
if (visitsPath === undefined || referencePath === undefined || visitId === undefined) {
  throw new Error("usage: worker.ts <visitsPath> <referencePath> <visitId> <op> [payload]");
}
const payload = payloadText ? JSON.parse(payloadText) : {};
// writeSync: a pipe write on macOS is asynchronous, and the operation below blocks the event loop.
const say = (line: string) => writeSync(1, `${line}\n`);

const store = VisitStore.open(visitsPath, referencePath);
const lines = createInterface({ input: process.stdin });
say("ready");
const first = await new Promise<string | undefined>((resolve) => {
  lines.once("line", resolve);
  lines.once("close", () => resolve(undefined));
});
lines.close();
if (first !== "go") throw new Error(`expected "go" on stdin, got ${JSON.stringify(first)}`);

let outcome: Record<string, unknown>;
say("started");
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
say(JSON.stringify({ op, ...outcome }));
