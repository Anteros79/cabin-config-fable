import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../domain/canonical.ts";
import { sha256Hex } from "../domain/hash.ts";
import { allowedOutcomes, classify, currentClass, dueDateFor, effectiveClass, isMustFixNow, mapCarried, seatIsBlocked } from "../domain/observations.ts";
import { buildReport } from "../domain/report.ts";
import type {
  CarriedObservation,
  Condition,
  MelClass,
  Observation,
  ObservationInput,
  Report,
  Visit,
  VisitEvent,
  VisitRecord,
  VisitSnapshot,
  VisitState,
  VisitSummary,
} from "../domain/types.ts";
import { DomainError, deriveRecord } from "../domain/visitLogic.ts";
import { isSameFile } from "./config.ts";
import { migrate, VISIT_MIGRATIONS } from "./migrations.ts";
import { inspectStore } from "./referenceStore.ts";
import { asStorageError, isBusy, isCorruption, isStorageFailure, STORE_BUSY_TIMEOUT_MS, StorageError } from "./storageError.ts";

export { StorageError };

/**
 * Visit store: drafts, frozen snapshots, replacement records, audit events, final reports and
 * idempotency keys. Every mutation runs in one BEGIN IMMEDIATE transaction, so writers from
 * separate connections or processes are serialised by SQLite. Completed visits are locked both
 * by the application and by triggers in the database itself.
 */
export const VISIT_STORE_KIND = "cabin-kit-visits";
/** The newest schema this code knows: the base schema (1) plus every entry of VISIT_MIGRATIONS. */
export const VISIT_SCHEMA_VERSION = "3";
/** The first schema with `visit_observations` and `visits.aircraft_held`. */
const OBSERVATIONS_SCHEMA_VERSION = 3;
const BASE_SCHEMA_VERSION = 1;

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

/**
 * A technician name may not contain a control character (C0, DEL or C1), a format character (such as a bidi override or a
 * zero-width space) or a line or paragraph separator, checked after surrounding whitespace is trimmed. The zero-width
 * non-joiner and joiner (U+200C, U+200D) are allowed: some names are written with them.
 * Only new visits are checked: a name stored before this rule is read, listed, reported and completed as it is.
 */
const HIDDEN_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}]|(?![\u200C\u200D])\p{Cf}/u;

const CONDITIONS: readonly Condition[] = ["STAINED", "TORN", "WORN", "BROKEN", "MISSING", "WONT_LATCH", "OTHER"];
const OBSERVATION_FIELDS = new Set(["locationId", "componentId", "condition", "note", "outcome", "deferUntil", "reason", "raisedTo"]);
const RAISE_RANK = { NONE: 0, MEL: 1, NO_GO: 2 } as const;
const CLASS_RANK: Record<MelClass["class"], number> = { COSMETIC: 0, MEL: 1, NO_GO: 2 };

const invalidObservation = (message: string): DomainError => new DomainError("INVALID_OBSERVATION", message, 422);

/**
 * Shape check of what a technician writes about a problem. The piece and the MEL class are checked
 * against the visit by the store. A field given as `undefined` counts as absent.
 */
function parseObservationInput(raw: unknown): ObservationInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalidObservation("The observation must be an object.");
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!OBSERVATION_FIELDS.has(key)) {
      throw new DomainError("UNSUPPORTED_FIELD", `Field "${key}" is not accepted. The class, due date and status are derived by the server.`);
    }
  }
  const { locationId, componentId, condition, outcome, deferUntil, reason, raisedTo } = input;
  const note = input.note ?? "";
  if (typeof locationId !== "string" || locationId.length === 0 || locationId.length > 80) throw invalidObservation("A location id is required.");
  if (typeof componentId !== "string" || componentId.length === 0 || componentId.length > 80) throw invalidObservation("A component id is required.");
  if (!CONDITIONS.includes(condition as Condition)) throw invalidObservation(`Condition must be one of ${CONDITIONS.join(", ")}.`);
  if (typeof note !== "string" || note.trim().length > 1000) throw invalidObservation("The note must be text of at most 1000 characters.");
  if (outcome !== "NOTED" && outcome !== "DEFERRED" && outcome !== "MUST_FIX") throw invalidObservation("Outcome must be NOTED, DEFERRED or MUST_FIX.");
  if (outcome === "DEFERRED") {
    if (deferUntil !== "NEXT_CHECK" && deferUntil !== "NEXT_STOP") throw invalidObservation("A deferral needs deferUntil: NEXT_CHECK or NEXT_STOP.");
    if (reason !== "NO_STOCK" && reason !== "NO_TIME" && reason !== "OTHER") throw invalidObservation("A deferral needs a reason: NO_STOCK, NO_TIME or OTHER.");
  } else if (deferUntil !== undefined || reason !== undefined) {
    throw invalidObservation("deferUntil and reason are only given for a deferral.");
  }
  if (raisedTo !== undefined && raisedTo !== "MEL" && raisedTo !== "NO_GO") throw invalidObservation("raisedTo must be MEL or NO_GO.");
  return {
    locationId,
    componentId,
    condition: condition as Condition,
    note: note.trim(),
    outcome,
    ...(outcome === "DEFERRED" ? { deferUntil: deferUntil as ObservationInput["deferUntil"], reason: reason as ObservationInput["reason"] } : {}),
    ...(raisedTo !== undefined ? { raisedTo } : {}),
  };
}

/** Retry keys older than this are pruned when the store opens. */
export const IDEMPOTENCY_RETENTION_DAYS = 30;

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
  visit: VisitState;
  replayed: boolean;
}

export interface CompletionResult {
  visit: VisitState;
  report: Report;
  alreadyCompleted: boolean;
  replayed: boolean;
}

type Row = Record<string, string | number | null>;

/**
 * Reads meta.schema_version through a read-only connection (no pragma, no write) and returns it
 * when this code can open it. Newer → VISIT_SCHEMA_NEWER; missing or non-numeric → VISIT_SCHEMA_MISMATCH.
 */
export function supportedVersion(path: string): number {
  let raw: string | undefined;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: STORE_BUSY_TIMEOUT_MS });
    raw = (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined)?.value;
  } catch (e) {
    throw asOpenError(e);
  } finally {
    db?.close();
  }
  const version = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(version >= BASE_SCHEMA_VERSION)) {
    throw new DomainError("VISIT_SCHEMA_MISMATCH", `Visit store schema version ${raw ?? "unknown"} is not supported.`, 500);
  }
  if (version > Number(VISIT_SCHEMA_VERSION)) {
    throw new DomainError("VISIT_SCHEMA_NEWER", "This visit store was written by a newer version of Cabin Kit.", 500);
  }
  return version;
}

const emptyVisit = (): DomainError => new DomainError("EMPTY_VISIT", "Record at least one replacement or problem before completing the visit.", 409);

const corrupt = (problems: string[]): DomainError =>
  new DomainError("VISIT_STORE_CORRUPT", "The visit store file is damaged. It will not be used; restore it from a backup.", 500, { problems });

/** While opening: SQLite corruption (SQLITE_CORRUPT, SQLITE_NOTADB) is VISIT_STORE_CORRUPT, other SQLite faults are StorageError. */
function asOpenError(e: unknown): unknown {
  return isCorruption(e) ? corrupt([(e as Error).message]) : asStorageError(e);
}

function assertIntact(db: DatabaseSync): void {
  const rows = db.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
  if (rows.length !== 1 || rows[0]?.quick_check !== "ok") throw corrupt(rows.slice(0, 5).map((r) => r.quick_check));
}

/** Base schema (version 1, identical to 5d6679d). Migrations bring it to the newest version. */
function createSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='visits'").get();
    if (!exists) {
      db.exec(SCHEMA);
      const put = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
      put.run("store_kind", VISIT_STORE_KIND);
      put.run("schema_version", String(BASE_SCHEMA_VERSION));
      put.run("created_at", new Date().toISOString());
    }
    db.exec("COMMIT");
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}

export class VisitStore {
  readonly path: string;
  private db: DatabaseSync;
  /** False only for a store opened read-only before migrating to v3: it has no observations and no held flag. */
  private readonly hasObservations: boolean;

  private constructor(path: string, db: DatabaseSync, schemaVersion: number) {
    this.path = path;
    this.db = db;
    this.hasObservations = schemaVersion >= OBSERVATIONS_SCHEMA_VERSION;
  }

  /**
   * Open the visit store, creating it only when the file does not exist. Never resets anything.
   * The schema version is read through a read-only connection before anything is written, so a
   * store from a newer Cabin Kit is refused byte-for-byte untouched. Then the store is checked
   * (PRAGMA quick_check) before the WAL switch or any other write, migrated to the newest schema
   * and old retry keys are pruned. SQLite corruption raised while opening is VISIT_STORE_CORRUPT.
   * `readOnly` opens an existing store without migrating or pruning (for backups).
   */
  static open(path: string, referencePath: string, options: { readOnly?: boolean } = {}): VisitStore {
    if (isSameFile(path, referencePath)) {
      throw new DomainError("SAME_STORE", "The visit store and the reference store resolve to the same file.", 500);
    }
    const inspection = inspectStore(path);
    if (inspection.kind !== "absent" && inspection.kind !== "empty" && inspection.kind !== "visits") {
      throw new DomainError("NOT_A_VISIT_STORE", `The visit store path holds a ${inspection.kind} database. It will not be used or modified.`, 500);
    }
    const fresh = inspection.kind === "absent" || inspection.kind === "empty";
    if (options.readOnly && fresh) throw new DomainError("VISIT_STORE_MISSING", "No visit store exists at that path.", 500);
    const current = fresh ? null : supportedVersion(path);
    if (!options.readOnly) mkdirSync(dirname(path), { recursive: true });
    let db: DatabaseSync;
    let version: number;
    try {
      db = new DatabaseSync(path, { timeout: STORE_BUSY_TIMEOUT_MS, readOnly: options.readOnly ?? false });
    } catch (e) {
      throw asOpenError(e);
    }
    try {
      db.exec("PRAGMA foreign_keys=ON;");
      // Checked before the WAL switch, which rewrites header bytes: a damaged store is refused untouched.
      assertIntact(db);
      if (options.readOnly) return new VisitStore(path, db, current ?? BASE_SCHEMA_VERSION);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      if (current === null) createSchema(db);
      version = migrate(db, current ?? BASE_SCHEMA_VERSION, VISIT_MIGRATIONS);
    } catch (e) {
      db.close();
      throw asOpenError(e);
    }
    const store = new VisitStore(path, db, version);
    store.pruneIdempotency(new Date(Date.now() - IDEMPOTENCY_RETENTION_DAYS * 86_400_000).toISOString());
    return store;
  }

  /** Deletes retry keys created before the cutoff (ISO time) and returns how many were removed. Events are never touched. */
  pruneIdempotency(before: string): number {
    return this.write(() => Number(this.db.prepare("DELETE FROM idempotency WHERE created_at < ?").run(before).changes));
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
      if (/EMPTY_VISIT/.test(message)) throw emptyVisit();
      if (isStorageFailure(e)) throw new StorageError(message, { cause: e });
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
      if (isStorageFailure(e)) throw new StorageError((e as Error).message ?? "", { cause: e });
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
      aircraftHeld: Number(row.aircraft_held ?? 0) === 1,
    };
  }

  private observationOf(row: Row): Observation {
    return {
      id: String(row.id),
      tail: String(row.tail),
      locationId: String(row.location_id),
      componentId: String(row.component_id),
      condition: row.condition as Condition,
      note: String(row.note),
      outcome: row.outcome as ObservationInput["outcome"],
      ...(row.defer_until !== null ? { deferUntil: row.defer_until as ObservationInput["deferUntil"] } : {}),
      ...(row.reason !== null ? { reason: row.reason as ObservationInput["reason"] } : {}),
      ...(row.raised_to !== null ? { raisedTo: row.raised_to as ObservationInput["raisedTo"] } : {}),
      status: row.status as Observation["status"],
      version: Number(row.version),
      melClass: JSON.parse(String(row.mel_class_json)) as MelClass,
      dueDate: row.due_date === null ? null : String(row.due_date),
      blocksSeat: Number(row.blocks_seat) === 1,
      openedInVisitId: String(row.opened_in_visit_id),
      closedInVisitId: row.closed_in_visit_id === null ? null : String(row.closed_in_visit_id),
      closedAs: row.closed_as as Observation["closedAs"],
      locationLabel: String(row.location_label),
      componentName: String(row.component_name),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /** Must be called inside a transaction. */
  private loadObservation(id: string): Observation | null {
    const row = this.db.prepare("SELECT * FROM visit_observations WHERE id = ?").get(id) as Row | undefined;
    return row ? this.observationOf(row) : null;
  }

  /** Every OPEN observation on the tail, whichever visit opened it. Must be called inside a transaction. */
  private openObservations(tail: string): Observation[] {
    if (!this.hasObservations) return [];
    return (this.db.prepare("SELECT * FROM visit_observations WHERE tail = ? AND status = 'OPEN' ORDER BY rowid").all(tail) as Row[]).map((r) =>
      this.observationOf(r),
    );
  }

  /** `, <prefix>aircraft_held` when the column exists. */
  private heldColumn(prefix = ""): string {
    return this.hasObservations ? `, ${prefix}aircraft_held` : "";
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

  /** Everything but the snapshot. Must be called inside a transaction. */
  private loadVisitState(id: string): VisitState {
    const row = this.db
      .prepare(
        `SELECT id, number, tail, check_date, technician, status, version, created_at, updated_at, completed_at, reference_release_id, lookup_state, variant_id, layout_revision_id, snapshot_sha256${this.heldColumn()} FROM visits WHERE id = ?`,
      )
      .get(id) as Row | undefined;
    if (!row) throw new DomainError("VISIT_NOT_FOUND", "Visit not found.", 404);
    const records = (this.db.prepare("SELECT * FROM visit_records WHERE visit_id = ? ORDER BY created_at, location_id, component_id").all(id) as Row[]).map(
      (r) => this.recordOf(r),
    );
    const events = (this.db.prepare("SELECT seq, type, at, payload_json FROM visit_events WHERE visit_id = ? ORDER BY seq").all(id) as Row[]).map(
      (e): VisitEvent => ({ seq: Number(e.seq), type: String(e.type), at: String(e.at), payload: JSON.parse(String(e.payload_json)) }),
    );
    const observations = this.hasObservations
      ? (this.db.prepare("SELECT * FROM visit_observations WHERE opened_in_visit_id = ? OR closed_in_visit_id = ? ORDER BY rowid").all(id, id) as Row[]).map(
          (r) => this.observationOf(r),
        )
      : [];
    return {
      ...this.summaryOf(row, records.length),
      snapshotSha256: String(row.snapshot_sha256),
      records,
      events,
      observations,
      carried: this.carriedInto(id, String(row.tail), String(row.check_date)),
    };
  }

  /**
   * The tail's OPEN DEFERRED and MUST_FIX observations that another visit opened, placed on this visit's layout. The snapshot is
   * read only when there is something to place. Must be called inside a transaction.
   */
  private carriedInto(visitId: string, tail: string, checkDate: string): CarriedObservation[] {
    // R13: a NOTED item needs no action, so it stays on its own visit.
    const others = this.openObservations(tail).filter((o) => o.openedInVisitId !== visitId && o.outcome !== "NOTED");
    if (others.length === 0) return [];
    const placed = mapCarried(others, this.loadSnapshot(visitId).context.layoutRevision.locations, checkDate);
    // the opening visit's check date: what "Carried over from the check on …" names (R42)
    const opened = this.db.prepare("SELECT check_date FROM visits WHERE id = ?");
    const dates = new Map<string, string>();
    return placed.map((c) => {
      const id = c.observation.openedInVisitId;
      if (!dates.has(id)) dates.set(id, String((opened.get(id) as { check_date: string } | undefined)?.check_date ?? ""));
      return { ...c, openedCheckDate: dates.get(id) ?? "" };
    });
  }

  /** Must be called inside a transaction. */
  private loadSnapshot(id: string): VisitSnapshot {
    const row = this.db.prepare("SELECT snapshot_json, snapshot_sha256 FROM visits WHERE id = ?").get(id) as
      | { snapshot_json: string; snapshot_sha256: string }
      | undefined;
    if (!row) throw new DomainError("VISIT_NOT_FOUND", "Visit not found.", 404);
    if (sha256Hex(row.snapshot_json) !== row.snapshot_sha256) {
      throw new DomainError("SNAPSHOT_CORRUPT", "The stored configuration for this visit does not match its recorded hash.", 500, { visitId: id });
    }
    return JSON.parse(row.snapshot_json) as VisitSnapshot;
  }

  /** Must be called inside a transaction. */
  private loadVisit(id: string): Visit {
    return { ...this.loadVisitState(id), snapshot: this.loadSnapshot(id) };
  }

  createVisit(snapshot: VisitSnapshot, technician: unknown, options: MutationOptions = {}): VisitMutationResult {
    if (technician !== undefined && technician !== null && typeof technician !== "string")
      throw new DomainError("INVALID_TECHNICIAN", "Technician must be text.");
    const tech = (typeof technician === "string" ? technician : "").trim();
    if (tech.length > 80) throw new DomainError("INVALID_TECHNICIAN", "Technician must be at most 80 characters.");
    if (HIDDEN_CHARACTER.test(tech))
      throw new DomainError(
        "INVALID_TECHNICIAN",
        "The technician name contains a hidden or control character, such as a tab, a line break or an invisible formatting mark. Remove it and try again.",
      );
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
    for (const name of ["limit", "offset"] as const) {
      const value = options[name];
      if (value !== undefined && !Number.isInteger(value)) throw new DomainError("INVALID_QUERY", `${name}: must be a whole number.`, 400);
    }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
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
          `SELECT v.number, v.id, v.tail, v.check_date, v.technician, v.status, v.version, v.created_at, v.updated_at, v.completed_at, v.reference_release_id, v.lookup_state, v.variant_id, v.layout_revision_id${this.heldColumn("v.")},
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
      if (prior) return { visit: this.loadVisitState(visitId), replayed: true };
      const visit = this.loadVisitState(visitId);
      if (visit.status !== "DRAFT") throw new DomainError("VISIT_LOCKED", "This visit is completed and locked.", 409);
      const derived = deriveRecord(this.loadSnapshot(visitId), input);
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
          ...(existing ? { before: existing } : {}),
        },
        now,
      );
      this.remember(options.idempotencyKey, `visit:${visitId}`, requestHash, { ok: true }, now);
      return { visit: this.loadVisitState(visitId), replayed: false };
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
      if (prior) return { visit: this.loadVisitState(visitId), replayed: true };
      const visit = this.loadVisitState(visitId);
      if (visit.status !== "DRAFT") throw new DomainError("VISIT_LOCKED", "This visit is completed and locked.", 409);
      const existing = visit.records.find((r) => r.locationId === locationId && r.componentId === componentId);
      if (!existing) throw new DomainError("RECORD_NOT_FOUND", "That replacement is not recorded on this visit (it may already have been removed).", 404);
      if (expectedRecordVersion !== undefined && expectedRecordVersion !== existing.version) {
        throw new DomainError("STALE_RECORD", "This replacement was changed elsewhere since you loaded it. Review the current record and try again.", 409, {
          current: existing,
        });
      }
      const inUse = this.replacedBy(visitId, visit.checkDate, locationId, componentId);
      if (inUse.length > 0) {
        throw new DomainError(
          "RECORD_IN_USE",
          "A problem was closed as replaced by this replacement. Reopen it as a new problem before removing the replacement.",
          409,
          { observationIds: inUse },
        );
      }
      this.db.prepare("DELETE FROM visit_records WHERE visit_id = ? AND location_id = ? AND component_id = ?").run(visitId, locationId, componentId);
      this.db.prepare("UPDATE visits SET version = version + 1, updated_at = ? WHERE id = ?").run(now, visitId);
      this.event(visitId, "RECORD_REMOVED", { locationId, componentId, recordVersion: existing.version, before: existing }, now);
      this.remember(options.idempotencyKey, `visit:${visitId}`, requestHash, { ok: true }, now);
      return { visit: this.loadVisitState(visitId), replayed: false };
    });
  }

  /**
   * The class of an OPEN observation now (R16): re-classified against `snapshot`'s MEL with the seat-blocked
   * state of the tail's other open observations, never below the class it was stored with (a class is only
   * raised), then NO_GO when its MEL deferral is past due on `onDate`. Must be called inside a transaction.
   */
  private currentClass(o: Observation, snapshot: VisitSnapshot, tail: string, onDate: string): MelClass {
    return currentClass(o, {
      mel: snapshot.mel ?? [],
      variant: snapshot.context.variant.id,
      open: this.openObservations(tail),
      onDate,
    });
  }

  /**
   * Ids of the observations closed as REPLACED in this visit by the record on (location, component): the same
   * piece, placed on this visit's layout as `closeObservation` placed it. Must be called inside a transaction.
   */
  private replacedBy(visitId: string, checkDate: string, locationId: string, componentId: string): string[] {
    if (!this.hasObservations) return [];
    const closed = (
      this.db
        .prepare("SELECT * FROM visit_observations WHERE closed_in_visit_id = ? AND closed_as = 'REPLACED' AND component_id = ? ORDER BY rowid")
        .all(visitId, componentId) as Row[]
    ).map((r) => this.observationOf(r));
    if (closed.length === 0) return [];
    const locations = this.loadSnapshot(visitId).context.layoutRevision.locations;
    return closed.filter((o) => mapCarried([o], locations, checkDate)[0]?.locationId === locationId).map((o) => o.id);
  }

  /** A DRAFT visit to write an observation through. Must be called inside a transaction. */
  private draftForObservation(visitId: string): VisitState {
    const visit = this.loadVisitState(visitId);
    if (visit.status !== "DRAFT") throw new DomainError("VISIT_LOCKED", "This visit is completed and locked.", 409);
    return visit;
  }

  /** An OPEN observation on the visit's tail at the version the caller loaded. Must be called inside a transaction. */
  private openObservationFor(visit: VisitState, observationId: string, expectedVersion: number): Observation {
    const existing = this.loadObservation(observationId);
    if (!existing || existing.tail !== visit.tail || existing.status !== "OPEN") {
      throw new DomainError("OBSERVATION_NOT_FOUND", "That problem is not open on this aircraft (it may already have been closed).", 404);
    }
    if (expectedVersion !== existing.version) {
      throw new DomainError("STALE_OBSERVATION", "This problem was changed elsewhere since you loaded it. Review it and try again.", 409, {
        current: existing,
      });
    }
    return existing;
  }

  /**
   * The class, due date and seat block of `input` written through `visit`, against the visit's frozen MEL.
   * The seat is blocked by the tail's other open deferrals. An MEL item whose first deferral is past due is
   * NO_GO, so it can no longer be deferred. An update keeps at least the observation's current class (R22), so
   * rewording an MEL deferral as a cosmetic condition keeps the MEL class. Throws OUTCOME_NOT_ALLOWED when the
   * outcome does not fit the class.
   */
  private classifyObservation(
    visit: VisitState,
    snapshot: VisitSnapshot,
    input: ObservationInput,
    existing: Observation | null,
  ): { melClass: MelClass; dueDate: string | null; blocksSeat: boolean } {
    const others = this.openObservations(visit.tail).filter((o) => o.id !== existing?.id);
    const base = classify({
      mel: snapshot.mel ?? [],
      componentId: input.componentId,
      condition: input.condition,
      variant: snapshot.context.variant.id,
      seatBlocked: seatIsBlocked(others, input.locationId),
      ...(input.raisedTo !== undefined ? { raisedTo: input.raisedTo } : {}),
    });
    const firstDue = existing?.dueDate ?? null;
    // The class an open deferral of it would have on this date (NO_GO once its first due date has passed),
    // whatever outcome this write gives it. effectiveClass reads only these four fields.
    const asDeferral = { status: "OPEN", outcome: "DEFERRED", melClass: base, dueDate: firstDue } as Observation;
    const asWritten = effectiveClass(asDeferral, visit.checkDate);
    // R22: an update never ranks below the problem's current class; the outcome is then checked against that floor.
    const floor = existing ? this.currentClass(existing, snapshot, visit.tail, visit.checkDate) : null;
    const floored = floor !== null && CLASS_RANK[asWritten.class] < CLASS_RANK[floor.class];
    const melClass = floored ? floor : asWritten;
    const allowed = allowedOutcomes(melClass);
    if (!allowed.includes(input.outcome)) {
      const message = floored ? "This problem can't be made less serious" : `This problem cannot be marked ${input.outcome} under its MEL class.`;
      throw new DomainError("OUTCOME_NOT_ALLOWED", message, 422, { allowed, melClass });
    }
    const dueDate = firstDue ?? (input.outcome === "DEFERRED" ? dueDateFor(melClass, visit.checkDate) : null);
    return { melClass, dueDate, blocksSeat: melClass.class === "MEL" && melClass.blocksSeat === true };
  }

  /**
   * Record a problem on a piece of this visit's layout. Observations belong to the tail: they stay
   * OPEN across visits until a later DRAFT visit on the same tail closes them.
   */
  addObservation(visitId: string, raw: unknown, options: MutationOptions = {}): VisitMutationResult {
    const now = options.now ?? new Date().toISOString();
    const scope = `observation:${visitId}`;
    const requestHash = sha256Hex(canonicalJson({ op: "observation-add", visitId, input: raw ?? null }));
    return this.write(() => {
      if (this.replay(options.idempotencyKey, scope, requestHash)) return { visit: this.loadVisitState(visitId), replayed: true };
      const visit = this.draftForObservation(visitId);
      const input = parseObservationInput(raw);
      const snapshot = this.loadSnapshot(visitId);
      const location = snapshot.context.layoutRevision.locations.find((l) => l.id === input.locationId);
      if (!location) throw invalidObservation(`Location ${input.locationId} is not part of this visit's frozen layout.`);
      if (!location.componentIds.includes(input.componentId)) throw invalidObservation(`Component ${input.componentId} is not a piece of ${location.label}.`);
      const cls = this.classifyObservation(visit, snapshot, input, null);
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO visit_observations(id, tail, location_id, component_id, condition, note, outcome, defer_until, reason, raised_to, mel_class_json, due_date, blocks_seat, status, version, opened_in_visit_id, location_label, component_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          visit.tail,
          input.locationId,
          input.componentId,
          input.condition,
          input.note,
          input.outcome,
          input.deferUntil ?? null,
          input.reason ?? null,
          input.raisedTo ?? null,
          JSON.stringify(cls.melClass),
          cls.dueDate,
          cls.blocksSeat ? 1 : 0,
          visitId,
          location.label,
          snapshot.resolution.componentDefs[input.componentId]?.name ?? input.componentId,
          now,
          now,
        );
      this.db.prepare("UPDATE visits SET version = version + 1, updated_at = ? WHERE id = ?").run(now, visitId);
      this.event(visitId, "OBSERVATION_ADDED", { observation: this.loadObservation(id) }, now);
      this.remember(options.idempotencyKey, scope, requestHash, { ok: true }, now);
      return { visit: this.loadVisitState(visitId), replayed: false };
    });
  }

  /**
   * Change an OPEN observation on this visit's tail, including one carried from an earlier visit. The piece
   * cannot change, a raised class cannot be lowered, and the first due date never moves.
   */
  updateObservation(visitId: string, observationId: string, raw: unknown, expectedVersion: number, options: MutationOptions = {}): VisitMutationResult {
    const now = options.now ?? new Date().toISOString();
    const scope = `observation:${visitId}`;
    const requestHash = sha256Hex(canonicalJson({ op: "observation-update", visitId, observationId, input: raw ?? null, expectedVersion }));
    return this.write(() => {
      if (this.replay(options.idempotencyKey, scope, requestHash)) return { visit: this.loadVisitState(visitId), replayed: true };
      const visit = this.draftForObservation(visitId);
      const before = this.openObservationFor(visit, observationId, expectedVersion);
      const input = parseObservationInput(raw);
      if (input.locationId !== before.locationId || input.componentId !== before.componentId) {
        throw invalidObservation("The piece of a recorded problem cannot be changed. Close it and record a new one.");
      }
      if (RAISE_RANK[input.raisedTo ?? "NONE"] < RAISE_RANK[before.raisedTo ?? "NONE"]) {
        throw invalidObservation("A class raised by the technician cannot be lowered.");
      }
      const cls = this.classifyObservation(visit, this.loadSnapshot(visitId), input, before);
      this.db
        .prepare(
          `UPDATE visit_observations SET condition = ?, note = ?, outcome = ?, defer_until = ?, reason = ?, raised_to = ?, mel_class_json = ?, due_date = ?, blocks_seat = ?,
             version = version + 1, updated_at = ? WHERE id = ?`,
        )
        .run(
          input.condition,
          input.note,
          input.outcome,
          input.deferUntil ?? null,
          input.reason ?? null,
          input.raisedTo ?? null,
          JSON.stringify(cls.melClass),
          cls.dueDate,
          cls.blocksSeat ? 1 : 0,
          now,
          observationId,
        );
      this.db.prepare("UPDATE visits SET version = version + 1, updated_at = ? WHERE id = ?").run(now, visitId);
      this.event(visitId, "OBSERVATION_UPDATED", { before, after: this.loadObservation(observationId) }, now);
      this.remember(options.idempotencyKey, scope, requestHash, { ok: true }, now);
      return { visit: this.loadVisitState(visitId), replayed: false };
    });
  }

  /**
   * Close an OPEN observation on this visit's tail. REPLACED needs a record in this visit on the piece where
   * the observation sits on this visit's layout, so one that is no longer at its position can only be FIXED.
   */
  closeObservation(
    visitId: string,
    observationId: string,
    closedAs: "REPLACED" | "FIXED",
    expectedVersion: number,
    options: MutationOptions = {},
  ): VisitMutationResult {
    if (closedAs !== "REPLACED" && closedAs !== "FIXED") throw invalidObservation("A problem is closed as REPLACED or FIXED.");
    const now = options.now ?? new Date().toISOString();
    const scope = `observation:${visitId}`;
    const requestHash = sha256Hex(canonicalJson({ op: "observation-close", visitId, observationId, closedAs, expectedVersion }));
    return this.write(() => {
      if (this.replay(options.idempotencyKey, scope, requestHash)) return { visit: this.loadVisitState(visitId), replayed: true };
      const visit = this.draftForObservation(visitId);
      const before = this.openObservationFor(visit, observationId, expectedVersion);
      if (closedAs === "REPLACED") {
        const [placed] = mapCarried([before], this.loadSnapshot(visitId).context.layoutRevision.locations, visit.checkDate);
        if (!visit.records.some((r) => r.locationId === placed?.locationId && r.componentId === before.componentId)) {
          throw new DomainError(
            "REPLACEMENT_MISSING",
            `Record the replacement of ${before.componentName} at ${before.locationLabel} in this visit first.`,
            422,
          );
        }
      }
      this.db
        .prepare("UPDATE visit_observations SET status = 'CLOSED', closed_in_visit_id = ?, closed_as = ?, version = version + 1, updated_at = ? WHERE id = ?")
        .run(visitId, closedAs, now, observationId);
      this.db.prepare("UPDATE visits SET version = version + 1, updated_at = ? WHERE id = ?").run(now, visitId);
      this.event(visitId, "OBSERVATION_CLOSED", { before, after: this.loadObservation(observationId) }, now);
      this.remember(options.idempotencyKey, scope, requestHash, { ok: true }, now);
      return { visit: this.loadVisitState(visitId), replayed: false };
    });
  }

  /**
   * Explicit, non-empty completion. Validation, locking and the report basis are one transaction:
   * an edit from another connection either commits first (and is in the report) or is refused.
   * Completing an already completed visit returns the stored report unchanged. While any OPEN observation on
   * the tail is NO_GO on the check date (an overdue MEL deferral included) or marked MUST_FIX, completion
   * needs `aircraftHeld: true`, which is stored on the visit.
   */
  completeVisit(visitId: string, expectedVisitVersion: number | undefined, options: MutationOptions & { aircraftHeld?: boolean } = {}): CompletionResult {
    const now = options.now ?? new Date().toISOString();
    const scope = `complete:${visitId}`;
    const held = options.aircraftHeld === true;
    // `aircraftHeld` joins the hash only when set, so retry keys stored before v3 keep their hash.
    const requestHash = sha256Hex(
      canonicalJson({ op: "complete", visitId, expectedVisitVersion: expectedVisitVersion ?? null, ...(held ? { aircraftHeld: true } : {}) }),
    );
    return this.write(() => {
      const replayed = this.replay(options.idempotencyKey, scope, requestHash) !== undefined;
      const visit = this.loadVisitState(visitId);
      if (visit.status === "COMPLETED") {
        return { visit, report: this.storedReport(visitId).report, alreadyCompleted: true, replayed };
      }
      if (expectedVisitVersion !== undefined && expectedVisitVersion !== visit.version) {
        throw new DomainError("STALE_VISIT", "This visit changed elsewhere since you loaded it. Review the current work, then complete again.", 409, {
          currentVersion: visit.version,
        });
      }
      if (visit.records.length === 0 && !visit.events.some((e) => e.type.startsWith("OBSERVATION_"))) throw emptyVisit();
      // Re-derive every record from the frozen snapshot: what is locked must be what the rules produce.
      const snapshot = this.loadSnapshot(visitId);
      for (const record of visit.records) {
        const derived = deriveRecord(snapshot, {
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
      const mustFix = this.openObservations(visit.tail)
        .filter((o) => isMustFixNow(o, this.currentClass(o, snapshot, visit.tail, visit.checkDate)))
        .map((o) => o.id)
        .sort();
      if (mustFix.length > 0 && !held) {
        throw new DomainError(
          "MUST_FIX_OPEN",
          "A must-fix problem is still open on this aircraft. Fix it, or confirm the aircraft is held and reported.",
          409,
          { observationIds: mustFix },
        );
      }
      this.db
        .prepare("UPDATE visits SET status = 'COMPLETED', completed_at = ?, updated_at = ?, version = version + 1, aircraft_held = ? WHERE id = ?")
        .run(now, now, held ? 1 : 0, visitId);
      this.event(visitId, "COMPLETED", { records: visit.records.length, aircraftHeld: held }, now);
      const completed = this.loadVisitState(visitId);
      const report = buildReport({ ...completed, snapshot }, "FINAL", now);
      const reportJson = canonicalJson(report);
      this.db
        .prepare("INSERT INTO reports(visit_id, schema, generated_at, basis_sha256, report_json) VALUES (?, ?, ?, ?, ?)")
        .run(visitId, report.schema, now, sha256Hex(reportJson), reportJson);
      this.remember(options.idempotencyKey, scope, requestHash, { ok: true }, now);
      return { visit: completed, report, alreadyCompleted: false, replayed: false };
    });
  }

  /** The report stored at completion, after checking it against its recorded hash. Must be called inside a transaction. */
  private storedReport(visitId: string): { report: Report; basisSha256: string } {
    const row = this.db.prepare("SELECT report_json, basis_sha256 FROM reports WHERE visit_id = ?").get(visitId) as
      | { report_json: string; basis_sha256: string }
      | undefined;
    if (!row) throw new DomainError("REPORT_MISSING", "The completed visit has no stored report.", 500);
    if (sha256Hex(row.report_json) !== row.basis_sha256) {
      throw new DomainError("REPORT_CORRUPT", "The stored report for this visit does not match its recorded hash.", 500, { visitId });
    }
    return { report: JSON.parse(row.report_json) as Report, basisSha256: row.basis_sha256 };
  }

  /**
   * Final report for a completed visit (exactly as stored at completion), or a clearly marked
   * draft preview. Events linked after completion are returned beside the report, not inside it.
   */
  getReport(visitId: string, now = new Date().toISOString()): { report: Report; basisSha256: string | null; linkedEvents: VisitEvent[] } {
    return this.read(() => {
      const visit = this.loadVisit(visitId);
      const linkedEvents = visit.events.filter((e) => e.type === "ADVISORY" || e.type === "CORRECTION_NOTE");
      if (visit.status === "COMPLETED") return { ...this.storedReport(visitId), linkedEvents };
      return { report: buildReport(visit, "DRAFT_PREVIEW", now), basisSha256: null, linkedEvents };
    });
  }

  /** Later advisories and corrections are appended as linked events; visit content is not edited. */
  addLinkedEvent(visitId: string, type: unknown, note: unknown, author: unknown, options: MutationOptions = {}): VisitMutationResult {
    if (type !== "ADVISORY" && type !== "CORRECTION_NOTE") throw new DomainError("INVALID_EVENT", "Event type must be ADVISORY or CORRECTION_NOTE.", 422);
    const text = typeof note === "string" ? note.trim() : "";
    if (text.length === 0 || text.length > 2000) throw new DomainError("INVALID_EVENT", "A note of 1-2000 characters is required.", 422);
    const by = typeof author === "string" ? author.trim() : "";
    if (by.length > 80) throw new DomainError("INVALID_EVENT", "Author must be at most 80 characters.", 422);
    const now = options.now ?? new Date().toISOString();
    const scope = `event:${visitId}`;
    const requestHash = sha256Hex(canonicalJson({ op: "event", visitId, type, note: text, author: by }));
    return this.write(() => {
      const prior = this.replay(options.idempotencyKey, scope, requestHash);
      this.loadVisitState(visitId);
      if (prior) return { visit: this.loadVisitState(visitId), replayed: true };
      this.event(visitId, type, { note: text, author: by }, now);
      this.remember(options.idempotencyKey, scope, requestHash, { ok: true }, now);
      return { visit: this.loadVisitState(visitId), replayed: false };
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
      const tables = ["visits", "visit_records", "visit_events", "reports", ...(this.hasObservations ? ["visit_observations"] : [])];
      const orderBy: Record<string, string> = {
        visits: "number",
        visit_records: "visit_id, location_id, component_id",
        visit_events: "visit_id, seq",
        reports: "visit_id",
        visit_observations: "id",
      };
      for (const table of tables) {
        const order = orderBy[table];
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
