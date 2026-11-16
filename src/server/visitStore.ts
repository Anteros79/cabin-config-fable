import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../domain/canonical.ts";
import { sha256Hex } from "../domain/hash.ts";
import { buildReport } from "../domain/report.ts";
import type { Report, Visit, VisitEvent, VisitRecord, VisitSnapshot, VisitSummary } from "../domain/types.ts";
import { DomainError, deriveRecord } from "../domain/visitLogic.ts";
import { isSameFile } from "./config.ts";
import { inspectStore } from "./referenceStore.ts";

/**
 * Visit store: drafts, frozen snapshots, replacement records, audit events, final reports and
 * idempotency keys. Every mutation runs in one BEGIN IMMEDIATE transaction, so writers from
 * separate connections or processes are serialised by SQLite. Completed visits are locked both
 * by the application and by triggers in the database itself.
 */
export const VISIT_STORE_KIND = "cabin-kit-visits";
export const VISIT_SCHEMA_VERSION = "1";

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE visits (
  number INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  tail TEXT NOT NULL,
  check_date TEXT NOT NULL,
  technician TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','COMPLETED')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  reference_release_id TEXT NOT NULL,
  lookup_state TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  layout_revision_id TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
);
CREATE INDEX visits_status_created ON visits(status, number DESC);
CREATE INDEX visits_tail ON visits(tail);
CREATE TABLE visit_records (
  visit_id TEXT NOT NULL REFERENCES visits(id),
  location_id TEXT NOT NULL,
  component_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  selection TEXT NOT NULL CHECK (selection IN ('PRIMARY','ALTERNATE')),
  substitute_id TEXT,
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  note TEXT NOT NULL DEFAULT '',
  rule_id TEXT NOT NULL,
  primary_part_no TEXT NOT NULL,
  location_label TEXT NOT NULL,
  component_name TEXT NOT NULL,
  lines_json TEXT NOT NULL CHECK (json_valid(lines_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (visit_id, location_id, component_id),
  CHECK ((selection = 'ALTERNATE') = (substitute_id IS NOT NULL))
);
CREATE TABLE visit_events (
  visit_id TEXT NOT NULL REFERENCES visits(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (visit_id, seq)
);
CREATE TABLE reports (
  visit_id TEXT PRIMARY KEY REFERENCES visits(id),
  schema TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  basis_sha256 TEXT NOT NULL,
  report_json TEXT NOT NULL CHECK (json_valid(report_json))
);
CREATE TABLE idempotency (
  key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Storage-level locks: these hold even if the application layer is bypassed.
CREATE TRIGGER visit_records_locked_insert BEFORE INSERT ON visit_records
WHEN (SELECT status FROM visits WHERE id = NEW.visit_id) IS NOT 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'VISIT_LOCKED'); END;
CREATE TRIGGER visit_records_locked_update BEFORE UPDATE ON visit_records
WHEN (SELECT status FROM visits WHERE id = OLD.visit_id) IS NOT 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'VISIT_LOCKED'); END;
CREATE TRIGGER visit_records_locked_delete BEFORE DELETE ON visit_records
WHEN (SELECT status FROM visits WHERE id = OLD.visit_id) IS NOT 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'VISIT_LOCKED'); END;
CREATE TRIGGER visits_completed_locked BEFORE UPDATE ON visits
WHEN OLD.status = 'COMPLETED'
BEGIN SELECT RAISE(ABORT, 'VISIT_LOCKED'); END;
CREATE TRIGGER visits_snapshot_immutable BEFORE UPDATE OF id, tail, check_date, created_at, reference_release_id, lookup_state, variant_id, layout_revision_id, snapshot_sha256, snapshot_json ON visits
BEGIN SELECT RAISE(ABORT, 'SNAPSHOT_IMMUTABLE'); END;
CREATE TRIGGER visits_no_delete BEFORE DELETE ON visits
BEGIN SELECT RAISE(ABORT, 'VISIT_DELETE_FORBIDDEN'); END;
CREATE TRIGGER visits_complete_needs_records BEFORE UPDATE OF status ON visits
WHEN NEW.status = 'COMPLETED' AND NOT EXISTS (SELECT 1 FROM visit_records WHERE visit_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'EMPTY_VISIT'); END;
CREATE TRIGGER reports_immutable_update BEFORE UPDATE ON reports
BEGIN SELECT RAISE(ABORT, 'REPORT_IMMUTABLE'); END;
CREATE TRIGGER reports_immutable_delete BEFORE DELETE ON reports
BEGIN SELECT RAISE(ABORT, 'REPORT_IMMUTABLE'); END;
CREATE TRIGGER reports_need_completed BEFORE INSERT ON reports
WHEN (SELECT status FROM visits WHERE id = NEW.visit_id) IS NOT 'COMPLETED'
BEGIN SELECT RAISE(ABORT, 'REPORT_NEEDS_COMPLETED_VISIT'); END;
CREATE TRIGGER events_immutable_update BEFORE UPDATE ON visit_events
BEGIN SELECT RAISE(ABORT, 'EVENT_IMMUTABLE'); END;
CREATE TRIGGER events_immutable_delete BEFORE DELETE ON visit_events
BEGIN SELECT RAISE(ABORT, 'EVENT_IMMUTABLE'); END;
`;

export interface MutationOptions {
  idempotencyKey?: string;
  now?: string;
}

export interface ListOptions {
  status?: "DRAFT" | "COMPLETED";
  q?: string;
  limit?: number;
  offset?: number;
}

export interface VisitMutationResult {
  visit: Visit;
  replayed: boolean;
}

export interface CompletionResult {
  visit: Visit;
  report: Report;
  alreadyCompleted: boolean;
  replayed: boolean;
}

type Row = Record<string, string | number | null>;

function isBusy(e: unknown): boolean {
  const err = e as { code?: string; errcode?: number; message?: string };
  return err?.errcode === 5 || err?.errcode === 6 || /database is locked|SQLITE_BUSY/i.test(err?.message ?? "");
}

export class VisitStore {
  readonly path: string;
  private db: DatabaseSync;

  private constructor(path: string, db: DatabaseSync) {
    this.path = path;
    this.db = db;
  }

  /** Open the visit store, creating it only when the file does not exist. Never resets anything. */
  static open(path: string, referencePath: string): VisitStore {
    if (isSameFile(path, referencePath)) {
      throw new DomainError("SAME_STORE", "The visit store and the reference store resolve to the same file.", 500);
    }
    const inspection = inspectStore(path);
    if (inspection.kind !== "absent" && inspection.kind !== "empty" && inspection.kind !== "visits") {
      throw new DomainError("NOT_A_VISIT_STORE", `The visit store path holds a ${inspection.kind} database. It will not be used or modified.`, 500);
    }
    mkdirSync(dirname(path), { recursive: true });
    const fresh = !existsSync(path) || inspection.kind === "empty";
    const db = new DatabaseSync(path, { timeout: 15000 });
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    if (fresh) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='visits'").get();
        if (!exists) {
          db.exec(SCHEMA);
          const put = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
          put.run("store_kind", VISIT_STORE_KIND);
          put.run("schema_version", VISIT_SCHEMA_VERSION);
          put.run("created_at", new Date().toISOString());
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        db.close();
        throw e;
      }
    } else {
      const version = (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined)?.value;
      if (version !== VISIT_SCHEMA_VERSION) {
        db.close();
        throw new DomainError("VISIT_SCHEMA_MISMATCH", `Visit store schema version ${version ?? "unknown"} is not supported.`, 500);
      }
    }
    return new VisitStore(path, db);
  }

  close(): void {
    this.db.close();
  }

  /** Run fn inside BEGIN IMMEDIATE. The write lock is taken before any read, so no stale reads. */
  private write<T>(fn: () => T): T {
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (e) {
      if (isBusy(e)) throw new DomainError("STORE_BUSY", "The visit store is busy. Nothing was saved; retry.", 503);
      throw e;
    }
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* transaction already ended */
      }
      const message = (e as Error).message ?? "";
      if (/VISIT_LOCKED/.test(message)) throw new DomainError("VISIT_LOCKED", "This visit is completed and locked.", 409);
      if (/EMPTY_VISIT/.test(message)) throw new DomainError("EMPTY_VISIT", "Record at least one replacement before completing the visit.", 409);
      throw e;
    }
  }

  private read<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  private replay(key: string | undefined, scope: string, requestHash: string): unknown | undefined {
    if (!key) return undefined;
    const row = this.db.prepare("SELECT scope, request_hash, response_json FROM idempotency WHERE key = ?").get(key) as
      | { scope: string; request_hash: string; response_json: string }
      | undefined;
    if (!row) return undefined;
    if (row.scope !== scope || row.request_hash !== requestHash) {
      throw new DomainError("IDEMPOTENCY_KEY_REUSED", "This retry key was already used for a different request.", 422);
    }
    return JSON.parse(row.response_json);
  }

  private remember(key: string | undefined, scope: string, requestHash: string, response: unknown, now: string): void {
    if (!key) return;
    this.db
      .prepare("INSERT INTO idempotency(key, scope, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(key, scope, requestHash, JSON.stringify(response), now);
  }

  private event(visitId: string, type: string, payload: Record<string, unknown>, at: string): void {
    const seq = Number((this.db.prepare("SELECT coalesce(max(seq), 0) + 1 AS n FROM visit_events WHERE visit_id = ?").get(visitId) as { n: number }).n);
    this.db
      .prepare("INSERT INTO visit_events(visit_id, seq, type, at, payload_json) VALUES (?, ?, ?, ?, ?)")
      .run(visitId, seq, type, at, JSON.stringify(payload));
  }

  private summaryOf(row: Row, recordCount: number): VisitSummary {
    return {
      id: String(row.id),
      number: Number(row.number),
      tail: String(row.tail),
      checkDate: String(row.check_date),
      technician: String(row.technician),
      status: row.status as VisitSummary["status"],
      version: Number(row.version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: row.completed_at === null ? null : String(row.completed_at),
      recordCount,
      referenceReleaseId: String(row.reference_release_id),
      lookupState: String(row.lookup_state),
      variantId: String(row.variant_id),
      layoutRevisionId: String(row.layout_revision_id),
    };
  }

  private recordOf(row: Row): VisitRecord {
    return {
      locationId: String(row.location_id),
      componentId: String(row.component_id),
      version: Number(row.version),
      selection: row.selection as VisitRecord["selection"],
      substituteId: row.substitute_id === null ? null : String(row.substitute_id),
      quantity: Number(row.quantity),
      note: String(row.note),
      ruleId: String(row.rule_id),
      primaryPartNo: String(row.primary_part_no),
      locationLabel: String(row.location_label),
      componentName: String(row.component_name),
      lines: JSON.parse(String(row.lines_json)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /** Must be called inside a transaction. */
  private loadVisit(id: string): Visit {
    const row = this.db.prepare("SELECT * FROM visits WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new DomainError("VISIT_NOT_FOUND", "Visit not found.", 404);
    const records = (this.db.prepare("SELECT * FROM visit_records WHERE visit_id = ? ORDER BY created_at, location_id, component_id").all(id) as Row[]).map(
      (r) => this.recordOf(r),
    );
    const events = (this.db.prepare("SELECT seq, type, at, payload_json FROM visit_events WHERE visit_id = ? ORDER BY seq").all(id) as Row[]).map(
      (e): VisitEvent => ({ seq: Number(e.seq), type: String(e.type), at: String(e.at), payload: JSON.parse(String(e.payload_json)) }),
    );
    return {
      ...this.summaryOf(row, records.length),
      snapshot: JSON.parse(String(row.snapshot_json)) as VisitSnapshot,
      snapshotSha256: String(row.snapshot_sha256),
      records,
      events,
    };
  }

  createVisit(snapshot: VisitSnapshot, technician: unknown, options: MutationOptions = {}): VisitMutationResult {
    if (technician !== undefined && technician !== null && typeof technician !== "string")
      throw new DomainError("INVALID_TECHNICIAN", "Technician must be text.");
    const tech = (typeof technician === "string" ? technician : "").trim();
    if (tech.length > 80) throw new DomainError("INVALID_TECHNICIAN", "Technician must be at most 80 characters.");
    const now = options.now ?? new Date().toISOString();
    const snapshotJson = canonicalJson(snapshot);
    const snapshotSha = sha256Hex(snapshotJson);
    const requestHash = sha256Hex(canonicalJson({ tail: snapshot.tail, checkDate: snapshot.checkDate, tech }));
    return this.write(() => {
      const prior = this.replay(options.idempotencyKey, "create", requestHash) as { id: string } | undefined;
      if (prior) return { visit: this.loadVisit(prior.id), replayed: true };
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO visits(id, tail, check_date, technician, created_at, updated_at, reference_release_id, lookup_state, variant_id, layout_revision_id, snapshot_sha256, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          snapshot.tail,
          snapshot.checkDate,
          tech,
          now,
          now,
          snapshot.referenceReleaseId,
          snapshot.lookupState,
          snapshot.context.variant.id,
          snapshot.context.layoutRevision.id,
          snapshotSha,
          snapshotJson,
        );
      this.event(id, "CREATED", { referenceReleaseId: snapshot.referenceReleaseId, snapshotSha256: snapshotSha, lookupState: snapshot.lookupState }, now);
      this.remember(options.idempotencyKey, "create", requestHash, { id }, now);
      return { visit: this.loadVisit(id), replayed: false };
    });
  }

  getVisit(id: string): Visit {
    return this.read(() => this.loadVisit(id));
  }

  listVisits(options: ListOptions = {}): { items: VisitSummary[]; total: number; limit: number; offset: number } {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
    const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (options.status) {
      where.push("v.status = ?");
      args.push(options.status);
    }
    if (options.q && options.q.trim()) {
      where.push(
        "(v.tail LIKE ? ESCAPE '\\' OR v.technician LIKE ? ESCAPE '\\' OR v.check_date LIKE ? ESCAPE '\\' OR v.variant_id LIKE ? ESCAPE '\\' OR CAST(v.number AS TEXT) = ?)",
      );
      const like = `%${options.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      args.push(like, like, like, like, options.q.trim());
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return this.read(() => {
      const total = Number((this.db.prepare(`SELECT count(*) AS n FROM visits v ${clause}`).get(...args) as { n: number }).n);
      const rows = this.db
        .prepare(
          `SELECT v.number, v.id, v.tail, v.check_date, v.technician, v.status, v.version, v.created_at, v.updated_at, v.completed_at, v.reference_release_id, v.lookup_state, v.variant_id, v.layout_revision_id,
                  (SELECT count(*) FROM visit_records r WHERE r.visit_id = v.id) AS record_count
           FROM visits v ${clause} ORDER BY v.number DESC LIMIT ? OFFSET ?`,
        )
        .all(...args, limit, offset) as Row[];
      return { items: rows.map((r) => this.summaryOf(r, Number(r.record_count))), total, limit, offset };
    });
  }

  /**
   * Add or update the single record for (visit, location, component).
   * expectedRecordVersion: undefined = plain upsert; 0 = caller believes no record exists;
   * n = caller is editing version n. A mismatch is a conflict, never a silent overwrite.
   */
  upsertRecord(visitId: string, input: unknown, expectedRecordVersion: number | undefined, options: MutationOptions = {}): VisitMutationResult {
    const now = options.now ?? new Date().toISOString();
    const requestHash = sha256Hex(canonicalJson({ op: "upsert", visitId, input, expectedRecordVersion: expectedRecordVersion ?? null }));
    return this.write(() => {
      const prior = this.replay(options.idempotencyKey, `visit:${visitId}`, requestHash);
      if (prior) return { visit: this.loadVisit(visitId), replayed: true };
      const visit = this.loadVisit(visitId);
      if (visit.status !== "DRAFT") throw new DomainError("VISIT_LOCKED", "This visit is completed and locked.", 409);
      const derived = deriveRecord(visit.snapshot, input);
      const existing = visit.records.find((r) => r.locationId === derived.locationId && r.componentId === derived.componentId);
      if (expectedRecordVersion !== undefined && expectedRecordVersion !== (existing?.version ?? 0)) {
        throw new DomainError(
          "STALE_RECORD",
          existing
            ? "This replacement was changed elsewhere since you loaded it. Review the current record and try again."
            : "This replacement was removed elsewhere since you loaded it. Review and try again.",
          409,
          { current: existing ?? null },
        );
      }
      const version = (existing?.version ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO visit_records(visit_id, location_id, component_id, version, selection, substitute_id, quantity, note, rule_id, primary_part_no, location_label, component_name, lines_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(visit_id, location_id, component_id) DO UPDATE SET
             version = excluded.version, selection = excluded.selection, substitute_id = excluded.substitute_id, quantity = excluded.quantity,
             note = excluded.note, rule_id = excluded.rule_id, primary_part_no = excluded.primary_part_no, lines_json = excluded.lines_json, updated_at = excluded.updated_at`,
        )
        .run(
          visitId,
          derived.locationId,
          derived.componentId,
          version,
          derived.selection,
          derived.substituteId,
          derived.quantity,
          derived.note,
          derived.ruleId,
          derived.primaryPartNo,
          derived.locationLabel,
          derived.componentName,
          JSON.stringify(derived.lines),
          existing?.createdAt ?? now,
          now,
        );
      this.db.prepare("UPDATE visits SET version = version + 1, updated_at = ? WHERE id = ?").run(now, visitId);
      this.event(
        visitId,
        existing ? "RECORD_UPDATED" : "RECORD_ADDED",
        {
          locationId: derived.locationId,
          componentId: derived.componentId,
          selection: derived.selection,
          substituteId: derived.substituteId,
          quantity: derived.quantity,
          recordVersion: version,
        },
        now,
      );
      this.remember(options.idempotencyKey, `visit:${visitId}`, requestHash, { ok: true }, now);
      return { visit: this.loadVisit(visitId), replayed: false };
    });
  }

  removeRecord(
    visitId: string,
    locationId: unknown,
    componentId: unknown,
    expectedRecordVersion: number | undefined,
    options: MutationOptions = {},
  ): VisitMutationResult {
    if (typeof locationId !== "string" || typeof componentId !== "string") throw new DomainError("INVALID_RECORD", "locationId and componentId are required.");
    const now = options.now ?? new Date().toISOString();
    const requestHash = sha256Hex(canonicalJson({ op: "remove", visitId, locationId, componentId, expectedRecordVersion: expectedRecordVersion ?? null }));
    return this.write(() => {
      const prior = this.replay(options.idempotencyKey, `visit:${visitId}`, requestHash);
      if (prior) return { visit: this.loadVisit(visitId), replayed: true };
      const visit = this.loadVisit(visitId);
      if (visit.status !== "DRAFT") throw new DomainError("VISIT_LOCKED", "This visit is completed and locked.", 409);
      const existing = visit.records.find((r) => r.locationId === locationId && r.componentId === componentId);
      if (!existing) throw new DomainError("RECORD_NOT_FOUND", "That replacement is not recorded on this visit (it may already have been removed).", 404);
      if (expectedRecordVersion !== undefined && expectedRecordVersion !== existing.version) {
        throw new DomainError("STALE_RECORD", "This replacement was changed elsewhere since you loaded it. Review the current record and try again.", 409, {
          current: existing,
        });
      }
      this.db.prepare("DELETE FROM visit_records WHERE visit_id = ? AND location_id = ? AND component_id = ?").run(visitId, locationId, componentId);
      this.db.prepare("UPDATE visits SET version = version + 1, updated_at = ? WHERE id = ?").run(now, visitId);
      this.event(visitId, "RECORD_REMOVED", { locationId, componentId, recordVersion: existing.version }, now);
      this.remember(options.idempotencyKey, `visit:${visitId}`, requestHash, { ok: true }, now);
      return { visit: this.loadVisit(visitId), replayed: false };
    });
  }

  /**
   * Explicit, non-empty completion. Validation, locking and the report basis are one transaction:
   * an edit from another connection either commits first (and is in the report) or is refused.
   * Completing an already completed visit returns the stored report unchanged.
   */
  completeVisit(visitId: string, expectedVisitVersion: number | undefined, options: MutationOptions = {}): CompletionResult {
    const now = options.now ?? new Date().toISOString();
    return this.write(() => {
      const visit = this.loadVisit(visitId);
      if (visit.status === "COMPLETED") {
        return { visit, report: this.storedReport(visitId), alreadyCompleted: true, replayed: Boolean(options.idempotencyKey) };
      }
      if (expectedVisitVersion !== undefined && expectedVisitVersion !== visit.version) {
        throw new DomainError("STALE_VISIT", "This visit changed elsewhere since you loaded it. Review the current work, then complete again.", 409, {
          currentVersion: visit.version,
        });
      }
      if (visit.records.length === 0) throw new DomainError("EMPTY_VISIT", "Record at least one replacement before completing the visit.", 409);
      // Re-derive every record from the frozen snapshot: what is locked must be what the rules produce.
      for (const record of visit.records) {
        const derived = deriveRecord(visit.snapshot, {
          locationId: record.locationId,
          componentId: record.componentId,
          selection: record.selection,
          substituteId: record.substituteId,
          quantity: record.quantity,
          note: record.note,
        });
        if (canonicalJson(derived.lines) !== canonicalJson(record.lines)) {
          throw new DomainError(
            "RECORD_INCONSISTENT",
            `Stored part lines for ${record.locationLabel} / ${record.componentName} do not match the frozen rules. Completion refused.`,
            409,
          );
        }
      }
      this.db.prepare("UPDATE visits SET status = 'COMPLETED', completed_at = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(now, now, visitId);
      this.event(visitId, "COMPLETED", { records: visit.records.length }, now);
      const completed = this.loadVisit(visitId);
      const report = buildReport(completed, "FINAL", now);
      const reportJson = canonicalJson(report);
      this.db
        .prepare("INSERT INTO reports(visit_id, schema, generated_at, basis_sha256, report_json) VALUES (?, ?, ?, ?, ?)")
        .run(visitId, report.schema, now, sha256Hex(reportJson), reportJson);
      return { visit: completed, report, alreadyCompleted: false, replayed: false };
    });
  }

  private storedReport(visitId: string): Report {
    const row = this.db.prepare("SELECT report_json FROM reports WHERE visit_id = ?").get(visitId) as { report_json: string } | undefined;
    if (!row) throw new DomainError("REPORT_MISSING", "The completed visit has no stored report.", 500);
    return JSON.parse(row.report_json) as Report;
  }

  /**
   * Final report for a completed visit (exactly as stored at completion), or a clearly marked
   * draft preview. Events linked after completion are returned beside the report, not inside it.
   */
  getReport(visitId: string, now = new Date().toISOString()): { report: Report; basisSha256: string | null; linkedEvents: VisitEvent[] } {
    return this.read(() => {
      const visit = this.loadVisit(visitId);
      const linkedEvents = visit.events.filter((e) => e.type === "ADVISORY" || e.type === "CORRECTION_NOTE");
      if (visit.status === "COMPLETED") {
        const row = this.db.prepare("SELECT report_json, basis_sha256 FROM reports WHERE visit_id = ?").get(visitId) as
          | { report_json: string; basis_sha256: string }
          | undefined;
        if (!row) throw new DomainError("REPORT_MISSING", "The completed visit has no stored report.", 500);
        return { report: JSON.parse(row.report_json) as Report, basisSha256: row.basis_sha256, linkedEvents };
      }
      return { report: buildReport(visit, "DRAFT_PREVIEW", now), basisSha256: null, linkedEvents };
    });
  }

  /** Later advisories and corrections are appended as linked events; visit content is not edited. */
  addLinkedEvent(visitId: string, type: unknown, note: unknown, author: unknown, options: MutationOptions = {}): Visit {
    if (type !== "ADVISORY" && type !== "CORRECTION_NOTE") throw new DomainError("INVALID_EVENT", "Event type must be ADVISORY or CORRECTION_NOTE.");
    if (typeof note !== "string" || note.trim().length === 0 || note.length > 2000)
      throw new DomainError("INVALID_EVENT", "A note of 1-2000 characters is required.");
    const by = typeof author === "string" ? author.trim().slice(0, 80) : "";
    const now = options.now ?? new Date().toISOString();
    return this.write(() => {
      this.loadVisit(visitId);
      this.event(visitId, type, { note: note.trim(), author: by }, now);
      return this.loadVisit(visitId);
    });
  }

  counts(): { visits: number; drafts: number; completed: number; records: number } {
    return this.read(() => {
      const v = this.db.prepare("SELECT count(*) AS n, sum(status = 'DRAFT') AS d, sum(status = 'COMPLETED') AS c FROM visits").get() as {
        n: number;
        d: number | null;
        c: number | null;
      };
      const r = this.db.prepare("SELECT count(*) AS n FROM visit_records").get() as { n: number };
      return { visits: Number(v.n), drafts: Number(v.d ?? 0), completed: Number(v.c ?? 0), records: Number(r.n) };
    });
  }

  /** Content fingerprint of all history, used to prove that reference operations leave visits unchanged. */
  fingerprint(): string {
    return this.read(() => {
      const hash = createHash("sha256");
      for (const table of ["visits", "visit_records", "visit_events", "reports"]) {
        const order =
          table === "visits" ? "number" : table === "reports" ? "visit_id" : table === "visit_events" ? "visit_id, seq" : "visit_id, location_id, component_id";
        for (const row of this.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as Row[]) hash.update(JSON.stringify(row));
      }
      return hash.digest("hex");
    });
  }

  /** Consistent online backup into a new file (refuses to overwrite). */
  backupTo(destination: string): void {
    if (existsSync(destination)) throw new DomainError("BACKUP_EXISTS", "The backup destination already exists.", 409);
    mkdirSync(dirname(destination), { recursive: true });
    this.db.prepare("VACUUM INTO ?").run(destination);
  }

  /** Test seam: direct SQL against the store, to prove the storage-level locks. */
  rawExec(sql: string): void {
    this.db.exec(sql);
  }
}
