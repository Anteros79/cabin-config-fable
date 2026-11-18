import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/domain/canonical.ts";
import { sha256Hex } from "../../src/domain/hash.ts";
import { buildPreparation } from "../../src/domain/prep.ts";
import type { VisitSnapshot } from "../../src/domain/types.ts";
import { DomainError } from "../../src/domain/visitLogic.ts";
import { type Migration, migrate, VISIT_MIGRATIONS } from "../../src/server/migrations.ts";
import { renderReportPdf } from "../../src/server/pdf.ts";
import { VISIT_SCHEMA_VERSION, VisitStore } from "../../src/server/visitStore.ts";
import { at, CUSHION_3A, fixtureRelease, oldShapeSnapshot, snapshotFor, tempDir, track } from "../helpers.ts";

/** The committed store written by 5d6679d. Never opened in place: every test works on a copy. */
const FIXTURE = join(import.meta.dirname, "../fixtures/visits-5d6679d.sqlite");
const COMPLETED_ID = "f6e066f8-7d8b-414a-8bdc-6df57ad11387";
const DRAFT_ID = "2c1076b1-ed50-4bc5-a715-73b63984bf78";

function copyOfFixture(): { path: string; referencePath: string } {
  const dir = tempDir("cabin-kit-compat-");
  const path = join(dir, "visits.sqlite");
  copyFileSync(FIXTURE, path);
  return { path, referencePath: join(dir, "reference.sqlite") };
}

function raw<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const db = track(new DatabaseSync(path));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const metaVersion = (path: string): string | undefined =>
  raw(path, (db) => (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value);

const rawReportJson = (path: string, visitId: string): string =>
  raw(path, (db) => (db.prepare("SELECT report_json FROM reports WHERE visit_id = ?").get(visitId) as { report_json: string }).report_json);

const indexNames = (path: string): string[] =>
  raw(path, (db) =>
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all() as { name: string }[]).map((r) => r.name),
  );

const domainError = (fn: () => unknown): DomainError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e;
    throw e;
  }
  throw new Error("expected a DomainError");
};

describe("visit stores written by 5d6679d", () => {
  it("opens a store written by 5d6679d and migrates it", () => {
    const copy = copyOfFixture();
    expect(metaVersion(copy.path)).toBe("1");
    const store = track(VisitStore.open(copy.path, copy.referencePath));
    expect(store.counts()).toMatchObject({ visits: 2, drafts: 1, completed: 1 });
    expect(store.listVisits().items.map((v) => [v.id, v.status, v.tail])).toEqual([
      [DRAFT_ID, "DRAFT", "N200TL"],
      [COMPLETED_ID, "COMPLETED", "N100TL"],
    ]);
    store.close();
    expect(metaVersion(copy.path)).toBe("2");
    expect(indexNames(copy.path)).toContain("idempotency_created");
  });

  it("a stored /1 report is served byte-identical", () => {
    const pristine = copyOfFixture();
    const before = rawReportJson(pristine.path, COMPLETED_ID);
    const copy = copyOfFixture();
    const store = track(VisitStore.open(copy.path, copy.referencePath));
    const { report } = store.getReport(COMPLETED_ID);
    expect(report.schema).toBe("cabin-kit.report/1");
    expect(canonicalJson(report)).toBe(before);
    expect(canonicalJson(store.completeVisit(COMPLETED_ID, undefined).report)).toBe(before);
  });

  it("migration leaves every stored visit, record, event and report row unchanged", () => {
    const copy = copyOfFixture();
    const dump = (path: string) =>
      raw(path, (db) =>
        ["visits", "visit_records", "visit_events", "reports"].map((table) => JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())),
      );
    const before = dump(copy.path);
    VisitStore.open(copy.path, copy.referencePath).close();
    expect(dump(copy.path)).toEqual(before);
  });

  it("snapshots without `excluded` fields render and the stored /1 report is served unchanged", async () => {
    const pristine = rawReportJson(copyOfFixture().path, COMPLETED_ID);
    const copy = copyOfFixture();
    // Rewrite both stored snapshots without any `excluded` field (and their hashes) on this temp copy only.
    raw(copy.path, (db) => {
      db.exec("DROP TRIGGER visits_snapshot_immutable; DROP TRIGGER visits_completed_locked;");
      const rows = db.prepare("SELECT id, snapshot_json FROM visits").all() as { id: string; snapshot_json: string }[];
      for (const row of rows) {
        const snapshot = JSON.parse(row.snapshot_json) as VisitSnapshot;
        for (const c of snapshot.resolution.components) delete (c as { excluded?: unknown }).excluded;
        const json = canonicalJson(snapshot);
        db.prepare("UPDATE visits SET snapshot_json = ?, snapshot_sha256 = ? WHERE id = ?").run(json, sha256Hex(json), row.id);
      }
    });
    const store = track(VisitStore.open(copy.path, copy.referencePath));
    for (const id of [COMPLETED_ID, DRAFT_ID]) {
      const visit = store.getVisit(id);
      expect(visit.snapshot.resolution.components.some((c) => "excluded" in c)).toBe(false);
      expect(buildPreparation(visit.snapshot).lines.every((l) => l.excludedRules.length === 0)).toBe(true);
    }
    // the completed visit: its stored /1 report is returned as stored and still prints
    const stored = store.getReport(COMPLETED_ID);
    expect(stored.report.schema).toBe("cabin-kit.report/1");
    expect(canonicalJson(stored.report)).toBe(pristine);
    expect((await renderReportPdf(stored.report, stored.linkedEvents, stored.basisSha256)).subarray(0, 5).toString()).toBe("%PDF-");
    // the draft: a new preview uses /2 and reads the missing fields as empty
    const preview = store.getReport(DRAFT_ID).report;
    expect(preview.schema).toBe("cabin-kit.report/2");
    expect(preview.work.map((w) => w.excludedRules)).toEqual(preview.work.map(() => []));
    expect((await renderReportPdf(preview)).subarray(0, 5).toString()).toBe("%PDF-");
    const done = store.completeVisit(DRAFT_ID, undefined);
    expect(done.report).toMatchObject({ schema: "cabin-kit.report/2", reportKind: "FINAL" });
  });

  it("a hand-built old-shape PARTIAL snapshot records, reports and completes", async () => {
    const copy = copyOfFixture();
    const old = oldShapeSnapshot(snapshotFor(fixtureRelease(), "N090TL", "2026-11-12"));
    const noMatch = old.resolution.components.filter((c) => c.status === "NO_MATCH");
    expect(noMatch.some((c) => c.excluded.length > 0)).toBe(true);
    expect(noMatch.flatMap((c) => c.excluded).some((e) => "sourceId" in e)).toBe(false);
    expect(old.resolution.components.filter((c) => c.status !== "NO_MATCH").some((c) => "excluded" in c)).toBe(false);
    const store = track(VisitStore.open(copy.path, copy.referencePath));
    const id = store.createVisit(old, "Demo tech").visit.id;
    store.upsertRecord(id, CUSHION_3A, undefined);
    const preview = store.getReport(id).report;
    expect(preview.counts.unresolvedComponents).toBe(170); // built from the current fixture release (VAC-2)
    expect(preview.work[0]?.excludedRules).toEqual([]);
    // the ambiguous candidates still name their sources; old no-match exclusions have none to cite
    expect(preview.gaps.find((g) => g.status === "AMBIGUOUS")?.sourceIds).toEqual(["FX-DOC-B"]);
    expect(preview.gaps.find((g) => g.componentId === "BACKREST")?.sourceIds).toEqual([]);
    const done = store.completeVisit(id, undefined);
    expect(done.report).toMatchObject({ schema: "cabin-kit.report/2", reportKind: "FINAL" });
    expect((await renderReportPdf(done.report)).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("the old draft can still be edited and completed", () => {
    const copy = copyOfFixture();
    const store = track(VisitStore.open(copy.path, copy.referencePath));
    const draft = store.getVisit(DRAFT_ID);
    expect(draft.records).toHaveLength(2);
    const edited = store.upsertRecord(DRAFT_ID, CUSHION_3A, undefined).visit;
    expect(edited.records).toHaveLength(3);
    const done = store.completeVisit(DRAFT_ID, edited.version);
    expect(done.visit.status).toBe("COMPLETED");
    expect(done.report.reportKind).toBe("FINAL");
    expect(store.getReport(DRAFT_ID).report).toEqual(done.report);
  });

  it("a newer schema version is refused without modification", () => {
    const copy = copyOfFixture();
    raw(copy.path, (db) => db.exec("UPDATE meta SET value = '99' WHERE key = 'schema_version'"));
    const bytes = readFileSync(copy.path);
    const error = domainError(() => VisitStore.open(copy.path, copy.referencePath));
    expect(error.code).toBe("VISIT_SCHEMA_NEWER");
    expect(error.status).toBe(500);
    expect(error.message).toBe("This visit store was written by a newer version of Cabin Kit.");
    expect(readFileSync(copy.path).equals(bytes)).toBe(true);
    expect(existsSync(`${copy.path}-wal`)).toBe(false);
    expect(existsSync(`${copy.path}-shm`)).toBe(false);
  });

  it("a non-numeric schema version is refused as a mismatch", () => {
    const copy = copyOfFixture();
    raw(copy.path, (db) => db.exec("UPDATE meta SET value = 'one' WHERE key = 'schema_version'"));
    expect(domainError(() => VisitStore.open(copy.path, copy.referencePath)).code).toBe("VISIT_SCHEMA_MISMATCH");
    expect(metaVersion(copy.path)).toBe("one");
  });

  it("a tampered snapshot is detected", () => {
    const copy = copyOfFixture();
    const store = track(VisitStore.open(copy.path, copy.referencePath));
    store.rawExec(
      `DROP TRIGGER visits_snapshot_immutable; UPDATE visits SET snapshot_json = json_set(snapshot_json, '$.technicianNote', 'tampered') WHERE id = '${DRAFT_ID}'`,
    );
    const error = domainError(() => store.getVisit(DRAFT_ID));
    expect(error).toMatchObject({
      code: "SNAPSHOT_CORRUPT",
      status: 500,
      message: "The stored configuration for this visit does not match its recorded hash.",
      details: { visitId: DRAFT_ID },
    });
    expect(domainError(() => store.upsertRecord(DRAFT_ID, CUSHION_3A, undefined)).code).toBe("SNAPSHOT_CORRUPT");
    expect(store.getVisit(COMPLETED_ID).id).toBe(COMPLETED_ID);
  });

  it("a tampered report is detected", () => {
    const copy = copyOfFixture();
    const store = track(VisitStore.open(copy.path, copy.referencePath));
    store.rawExec(
      `DROP TRIGGER reports_immutable_update; UPDATE reports SET report_json = json_set(report_json, '$.technician', 'tampered') WHERE visit_id = '${COMPLETED_ID}'`,
    );
    const error = domainError(() => store.getReport(COMPLETED_ID));
    expect(error).toMatchObject({ code: "REPORT_CORRUPT", status: 500, details: { visitId: COMPLETED_ID } });
    expect(domainError(() => store.completeVisit(COMPLETED_ID, undefined)).code).toBe("REPORT_CORRUPT");
  });

  it("read-only mode neither migrates nor prunes, and still reads the old store", () => {
    const copy = copyOfFixture();
    const bytes = readFileSync(copy.path);
    const store = track(VisitStore.open(copy.path, copy.referencePath, { readOnly: true }));
    expect(store.counts()).toMatchObject({ visits: 2, drafts: 1, completed: 1 });
    expect(store.getReport(COMPLETED_ID).report.schema).toBe("cabin-kit.report/1");
    store.close();
    expect(metaVersion(copy.path)).toBe("1");
    expect(readFileSync(copy.path).equals(bytes)).toBe(true);
  });

  it("a damaged store is refused as corrupt", () => {
    const copy = copyOfFixture();
    const { pageSize, root } = raw(copy.path, (db) => ({
      pageSize: Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size),
      root: Number((db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'visits_tail'").get() as { rootpage: number }).rootpage),
    }));
    const bytes = readFileSync(copy.path);
    // Overwrite the b-tree page type of an index page the version check never reads.
    bytes[(root - 1) * pageSize] = 0xff;
    writeFileSync(copy.path, bytes);
    expect(domainError(() => VisitStore.open(copy.path, copy.referencePath)).code).toBe("VISIT_STORE_CORRUPT");
    // Refused before the WAL switch: not one byte of the damaged file was rewritten.
    expect(readFileSync(copy.path).equals(bytes)).toBe(true);
    expect(existsSync(`${copy.path}-wal`)).toBe(false);
    expect(existsSync(`${copy.path}-shm`)).toBe(false);
  });

  it("a SQLite corruption error raised while opening is VISIT_STORE_CORRUPT, not a storage fault", () => {
    const copy = copyOfFixture();
    const { pageSize, root } = raw(copy.path, (db) => ({
      pageSize: Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size),
      root: Number((db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'meta'").get() as { rootpage: number }).rootpage),
    }));
    const bytes = readFileSync(copy.path);
    // The version check reads `meta`; a damaged meta page makes SQLite raise SQLITE_CORRUPT there.
    bytes[(root - 1) * pageSize] = 0xff;
    writeFileSync(copy.path, bytes);
    const error = domainError(() => VisitStore.open(copy.path, copy.referencePath));
    expect(error).toMatchObject({ code: "VISIT_STORE_CORRUPT", status: 500 });
    expect(readFileSync(copy.path).equals(bytes)).toBe(true);
  });

  it("read-only mode refuses an absent store and creates nothing", () => {
    const dir = tempDir();
    const path = join(dir, "missing", "visits.sqlite");
    expect(domainError(() => VisitStore.open(path, join(dir, "reference.sqlite"), { readOnly: true })).code).toBe("VISIT_STORE_MISSING");
    expect(existsSync(join(dir, "missing"))).toBe(false);
  });
});

describe("visit store migrations", () => {
  it("a fresh store is created at the newest schema version", () => {
    const dir = tempDir();
    const path = join(dir, "visits.sqlite");
    VisitStore.open(path, join(dir, "reference.sqlite")).close();
    expect(metaVersion(path)).toBe(VISIT_SCHEMA_VERSION);
    expect(indexNames(path)).toContain("idempotency_created");
  });

  it("the newest migration is the current schema version", () => {
    expect(at(VISIT_MIGRATIONS, 0)).toEqual({
      to: 2,
      description: "index retry keys by age",
      sql: "CREATE INDEX IF NOT EXISTS idempotency_created ON idempotency(created_at);",
    });
    expect(String(at(VISIT_MIGRATIONS, VISIT_MIGRATIONS.length - 1).to)).toBe(VISIT_SCHEMA_VERSION);
  });

  const scratch = () => {
    const db = track(new DatabaseSync(":memory:"));
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '1'); CREATE TABLE log (step INTEGER);");
    return db;
  };
  const steps: Migration[] = [
    { to: 3, description: "third", sql: "INSERT INTO log VALUES (3);" },
    { to: 2, description: "second", sql: "INSERT INTO log VALUES (2);" },
  ];

  it("applies every newer migration in ascending order and records the version", () => {
    const db = scratch();
    expect(migrate(db, 1, steps)).toBe(3);
    expect((db.prepare("SELECT step FROM log ORDER BY rowid").all() as { step: number }[]).map((r) => r.step)).toEqual([2, 3]);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toMatchObject({ value: "3" });
    expect(migrate(db, 3, steps)).toBe(3);
    expect(migrate(db, 2, steps)).toBe(3);
    expect(db.prepare("SELECT count(*) AS n FROM log").get()).toMatchObject({ n: 2 });
  });

  it("a failing migration rolls back every step and leaves the version unchanged", () => {
    const db = scratch();
    expect(() => migrate(db, 1, [...steps, { to: 4, description: "broken", sql: "INSERT INTO missing VALUES (1);" }])).toThrow(/missing/);
    expect(db.prepare("SELECT count(*) AS n FROM log").get()).toMatchObject({ n: 0 });
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toMatchObject({ value: "1" });
    expect(db.isTransaction).toBe(false);
  });

  it("refuses when the version re-read under the write lock is newer than any migration it knows", () => {
    const db = scratch();
    // Another (newer) process migrated after this one read version 1.
    db.exec("UPDATE meta SET value = '5' WHERE key = 'schema_version'");
    const error = domainError(() => migrate(db, 1, steps));
    expect(error).toMatchObject({ code: "VISIT_SCHEMA_NEWER", status: 500 });
    expect(db.prepare("SELECT count(*) AS n FROM log").get()).toMatchObject({ n: 0 });
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toMatchObject({ value: "5" });
    expect(db.isTransaction).toBe(false);
  });
});
