import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Finding, ReferenceRelease, ReleaseContent } from "../domain/types.ts";
import { hasBlockingFindings } from "../domain/validate.ts";
import { contentHash } from "../importer/assemble.ts";
import { isSameFile } from "./config.ts";

/**
 * Reference store: append-only, versioned releases.
 *  - A release is staged with all its entities in one transaction.
 *  - Validation findings are stored with it; a release with blocking findings is rejected.
 *  - Activation is a single transaction that flips one pointer row.
 *  - Entities of a release that has left "staged" are immutable (enforced by triggers).
 * The visit store is a different file and is never opened here.
 */
export const REFERENCE_STORE_KIND = "cabin-kit-reference";
export const REFERENCE_SCHEMA_VERSION = "1";
const REFERENCE_TABLES = ["meta", "release", "release_entity", "active_release", "release_event"];
const VISIT_TABLES = ["visits", "visit_records", "visit_events", "reports", "idempotency"];

const ENTITY_TYPES = [
  "vocabulary", "source", "subtype", "aircraft", "variant", "layout", "layoutRevision", "assignment", "component", "part",
  "rule", "substitute", "kitChild", "pendingChange", "layoutCategory", "visualProfile",
] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE release (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged','validated','rejected','active','superseded')),
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  validated_at TEXT,
  activated_at TEXT,
  findings_json TEXT NOT NULL DEFAULT '[]',
  stats_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE release_entity (
  release_id TEXT NOT NULL REFERENCES release(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  position INTEGER NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  PRIMARY KEY (release_id, entity_type, entity_id)
);
CREATE TABLE active_release (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  release_id TEXT NOT NULL REFERENCES release(id),
  activated_at TEXT NOT NULL
);
CREATE TABLE release_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  release_id TEXT,
  type TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TRIGGER release_entity_frozen_insert BEFORE INSERT ON release_entity
WHEN (SELECT status FROM release WHERE id = NEW.release_id) <> 'staged'
BEGIN SELECT RAISE(ABORT, 'RELEASE_IMMUTABLE'); END;
CREATE TRIGGER release_entity_frozen_update BEFORE UPDATE ON release_entity
BEGIN SELECT RAISE(ABORT, 'RELEASE_IMMUTABLE'); END;
CREATE TRIGGER release_entity_frozen_delete BEFORE DELETE ON release_entity
WHEN (SELECT status FROM release WHERE id = OLD.release_id) <> 'staged'
BEGIN SELECT RAISE(ABORT, 'RELEASE_IMMUTABLE'); END;
CREATE TRIGGER release_hash_frozen BEFORE UPDATE OF id, seq, content_hash, created_at ON release
BEGIN SELECT RAISE(ABORT, 'RELEASE_IMMUTABLE'); END;
`;

export class ReferenceStoreError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface StoreInspection {
  exists: boolean;
  kind: "absent" | "reference" | "visits" | "mixed" | "unknown" | "empty" | "not-sqlite";
  tables: string[];
  storeKindMarker: string | null;
  visitRows: number;
}

/** Classify a database file by what it actually contains. A marker row alone is never trusted. */
export function inspectStore(path: string): StoreInspection {
  if (!existsSync(path)) return { exists: false, kind: "absent", tables: [], storeKindMarker: null, visitRows: 0 };
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return { exists: true, kind: "not-sqlite", tables: [], storeKindMarker: null, visitRows: 0 };
  }
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    let marker: string | null = null;
    if (tables.includes("meta")) {
      try {
        marker = ((db.prepare("SELECT value FROM meta WHERE key='store_kind'").get() as { value: string } | undefined)?.value) ?? null;
      } catch {
        marker = null;
      }
    }
    const hasVisitTables = tables.some((t) => VISIT_TABLES.includes(t));
    const hasReferenceTables = tables.some((t) => t !== "meta" && REFERENCE_TABLES.includes(t));
    const unknownTables = tables.filter((t) => !VISIT_TABLES.includes(t) && !REFERENCE_TABLES.includes(t));
    let visitRows = 0;
    if (tables.includes("visits")) {
      try {
        visitRows = Number((db.prepare("SELECT count(*) AS n FROM visits").get() as { n: number }).n);
      } catch {
        visitRows = 0;
      }
    }
    let kind: StoreInspection["kind"];
    if (tables.length === 0) kind = "empty";
    else if (hasVisitTables && hasReferenceTables) kind = "mixed";
    else if (hasVisitTables) kind = unknownTables.length ? "mixed" : "visits";
    else if (unknownTables.length > 0) kind = "unknown";
    else if (hasReferenceTables && marker === REFERENCE_STORE_KIND && REFERENCE_TABLES.every((t) => tables.includes(t))) kind = "reference";
    else kind = "unknown";
    return { exists: true, kind, tables, storeKindMarker: marker, visitRows };
  } catch {
    return { exists: true, kind: "not-sqlite", tables: [], storeKindMarker: null, visitRows: 0 };
  } finally {
    db.close();
  }
}

/**
 * Guard for anything that creates, replaces or resets the reference store.
 * Refuses: the same file as the visit store (including symlink or hard-link aliases), a database
 * that contains visit tables, and any database this application does not recognise.
 */
export function assertSafeReferenceTarget(referencePath: string, visitsPath: string): StoreInspection {
  if (isSameFile(referencePath, visitsPath)) {
    throw new ReferenceStoreError("SAME_STORE", "The reference store and the visit store resolve to the same file. Reference import or reset is refused.");
  }
  const inspection = inspectStore(referencePath);
  if (inspection.kind === "visits" || inspection.kind === "mixed") {
    throw new ReferenceStoreError("VISIT_DATA_PRESENT", `The reference target contains visit tables (${inspection.visitRows} visits). Reference import or reset is refused.`);
  }
  if (inspection.kind === "unknown" || inspection.kind === "not-sqlite") {
    throw new ReferenceStoreError("UNKNOWN_STORE", "The reference target is not a database created by this application. It will not be modified or replaced.");
  }
  return inspection;
}

export interface ReleaseSummary {
  id: string;
  seq: number;
  label: string;
  status: string;
  contentHash: string;
  createdAt: string;
  validatedAt: string | null;
  activatedAt: string | null;
  findingCounts: Record<string, number>;
}

function entityRows(content: ReleaseContent): { type: EntityType; id: string; namespace: string; data: unknown }[] {
  const rows: { type: EntityType; id: string; namespace: string; data: unknown }[] = [];
  const push = (type: EntityType, id: string, namespace: string, data: unknown) => rows.push({ type, id, namespace, data });
  push("vocabulary", "vocabulary", "shared", { ...content.vocabulary, schema: content.schema, label: content.label });
  content.sources.forEach((x) => push("source", x.id, x.namespace, x));
  content.subtypes.forEach((x) => push("subtype", x.id, x.namespace, x));
  content.aircraft.forEach((x) => push("aircraft", x.tail, x.namespace, x));
  content.variants.forEach((x) => push("variant", x.id, x.namespace, x));
  content.layouts.forEach((x) => push("layout", x.id, x.namespace, x));
  content.layoutRevisions.forEach((x) => push("layoutRevision", x.id, x.namespace, x));
  content.assignments.forEach((x) => push("assignment", x.id, x.namespace, x));
  content.components.forEach((x) => push("component", x.id, "shared", x));
  content.parts.forEach((x) => push("part", x.partNo, x.namespace, x));
  content.rules.forEach((x) => push("rule", x.id, x.namespace, x));
  content.substitutes.forEach((x) => push("substitute", x.id, x.namespace, x));
  content.kitChildren.forEach((x) => push("kitChild", `${x.parentPartNo}>${x.childPartNo}`, "fixture", x));
  content.pendingChanges.forEach((x) => push("pendingChange", x.id, "fixture", x));
  content.layoutCategories.forEach((x) => push("layoutCategory", x.id, x.namespace, x));
  content.visualProfiles.forEach((x) => push("visualProfile", x.id, "shared", x));
  return rows;
}

export class ReferenceStore {
  readonly path: string;
  private db: DatabaseSync;
  private cache = new Map<string, ReferenceRelease>();

  private constructor(path: string, db: DatabaseSync) {
    this.path = path;
    this.db = db;
  }

  /** Create a new, empty reference store. Refuses to overwrite anything. */
  static create(path: string, visitsPath: string): ReferenceStore {
    const inspection = assertSafeReferenceTarget(path, visitsPath);
    if (inspection.exists && inspection.kind !== "empty") throw new ReferenceStoreError("STORE_EXISTS", "A reference store already exists at that path.");
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path, { timeout: 8000 });
    db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;");
    try {
      db.exec(SCHEMA);
      const put = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
      put.run("store_kind", REFERENCE_STORE_KIND);
      put.run("schema_version", REFERENCE_SCHEMA_VERSION);
      put.run("created_at", new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      db.close();
      throw e;
    }
    return new ReferenceStore(path, db);
  }

  static open(path: string, visitsPath: string, options: { readOnly?: boolean } = {}): ReferenceStore {
    const inspection = assertSafeReferenceTarget(path, visitsPath);
    if (inspection.kind !== "reference") throw new ReferenceStoreError("STORE_MISSING", "No reference store exists at that path. Run the reference import first.");
    const db = new DatabaseSync(path, { timeout: 8000, readOnly: options.readOnly ?? false });
    db.exec("PRAGMA foreign_keys=ON;");
    if (!options.readOnly) db.exec("PRAGMA journal_mode=WAL;");
    return new ReferenceStore(path, db);
  }

  static openOrCreate(path: string, visitsPath: string): ReferenceStore {
    const inspection = assertSafeReferenceTarget(path, visitsPath);
    return inspection.kind === "reference" ? ReferenceStore.open(path, visitsPath) : ReferenceStore.create(path, visitsPath);
  }

  close(): void {
    this.db.close();
  }

  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }

  private event(releaseId: string | null, type: string, detail: unknown, at: string): void {
    this.db.prepare("INSERT INTO release_event(at, release_id, type, detail_json) VALUES (?, ?, ?, ?)").run(at, releaseId, type, JSON.stringify(detail));
  }

  /**
   * Stage a release and record its validation result. Nothing here changes which release is
   * active. Returns the release id and whether it may be activated.
   */
  stage(content: ReleaseContent, findings: Finding[], stats: Record<string, unknown> = {}, now = new Date().toISOString()): { id: string; status: "validated" | "rejected" } {
    const hash = contentHash(content);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const seq = Number((this.db.prepare("SELECT coalesce(max(seq), 0) + 1 AS n FROM release").get() as { n: number }).n);
      const id = `REL-${String(seq).padStart(4, "0")}-${hash.slice(0, 8)}`;
      this.db.prepare("INSERT INTO release(id, seq, label, status, content_hash, created_at, findings_json, stats_json) VALUES (?, ?, ?, 'staged', ?, ?, ?, ?)").run(
        id, seq, content.label, hash, now, JSON.stringify(findings), JSON.stringify(stats),
      );
      const insert = this.db.prepare("INSERT INTO release_entity(release_id, entity_type, entity_id, namespace, position, data_json) VALUES (?, ?, ?, ?, ?, ?)");
      entityRows(content).forEach((row, position) => insert.run(id, row.type, row.id, row.namespace, position, JSON.stringify(row.data)));
      const status = hasBlockingFindings(findings) ? "rejected" : "validated";
      this.db.prepare("UPDATE release SET status = ?, validated_at = ? WHERE id = ?").run(status, now, id);
      this.event(id, status === "validated" ? "VALIDATED" : "REJECTED", { findings: findings.length, blocking: findings.filter((f) => f.severity === "error").length }, now);
      this.db.exec("COMMIT");
      return { id, status };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Atomically make a validated release the active one. Visits are not touched (different store). */
  activate(releaseId: string, now = new Date().toISOString()): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT status FROM release WHERE id = ?").get(releaseId) as { status: string } | undefined;
      if (!row) throw new ReferenceStoreError("RELEASE_NOT_FOUND", `Release ${releaseId} does not exist.`);
      if (row.status === "active") {
        this.db.exec("COMMIT");
        return;
      }
      if (row.status !== "validated" && row.status !== "superseded") {
        throw new ReferenceStoreError("RELEASE_NOT_VALIDATED", `Release ${releaseId} is ${row.status} and cannot be activated.`);
      }
      const previous = (this.db.prepare("SELECT release_id FROM active_release WHERE singleton = 1").get() as { release_id: string } | undefined)?.release_id ?? null;
      if (previous) this.db.prepare("UPDATE release SET status = 'superseded' WHERE id = ?").run(previous);
      this.db.prepare("UPDATE release SET status = 'active', activated_at = ? WHERE id = ?").run(now, releaseId);
      this.db.prepare("INSERT INTO active_release(singleton, release_id, activated_at) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET release_id = excluded.release_id, activated_at = excluded.activated_at").run(releaseId, now);
      this.event(releaseId, "ACTIVATED", { previous }, now);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  activeReleaseId(): string | null {
    return ((this.db.prepare("SELECT release_id FROM active_release WHERE singleton = 1").get() as { release_id: string } | undefined)?.release_id) ?? null;
  }

  listReleases(): ReleaseSummary[] {
    const rows = this.db.prepare("SELECT * FROM release ORDER BY seq DESC").all() as Record<string, string | number | null>[];
    return rows.map((r) => {
      const findings = JSON.parse(String(r.findings_json)) as Finding[];
      const counts: Record<string, number> = {};
      for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
      return {
        id: String(r.id),
        seq: Number(r.seq),
        label: String(r.label),
        status: String(r.status),
        contentHash: String(r.content_hash),
        createdAt: String(r.created_at),
        validatedAt: r.validated_at === null ? null : String(r.validated_at),
        activatedAt: r.activated_at === null ? null : String(r.activated_at),
        findingCounts: counts,
      };
    });
  }

  findings(releaseId: string): { findings: Finding[]; stats: Record<string, unknown> } {
    const row = this.db.prepare("SELECT findings_json, stats_json FROM release WHERE id = ?").get(releaseId) as { findings_json: string; stats_json: string } | undefined;
    if (!row) throw new ReferenceStoreError("RELEASE_NOT_FOUND", `Release ${releaseId} does not exist.`);
    return { findings: JSON.parse(row.findings_json), stats: JSON.parse(row.stats_json) };
  }

  events(): { at: string; releaseId: string | null; type: string; detail: unknown }[] {
    return (this.db.prepare("SELECT at, release_id, type, detail_json FROM release_event ORDER BY id").all() as { at: string; release_id: string | null; type: string; detail_json: string }[]).map((r) => ({
      at: r.at,
      releaseId: r.release_id,
      type: r.type,
      detail: JSON.parse(r.detail_json),
    }));
  }

  /** Load one release in a single read transaction. Releases are immutable, so results are cached. */
  loadRelease(releaseId: string): ReferenceRelease {
    const cached = this.cache.get(releaseId);
    if (cached) return cached;
    this.db.exec("BEGIN");
    try {
      const head = this.db.prepare("SELECT id, content_hash, activated_at, status FROM release WHERE id = ?").get(releaseId) as
        | { id: string; content_hash: string; activated_at: string | null; status: string }
        | undefined;
      if (!head) throw new ReferenceStoreError("RELEASE_NOT_FOUND", `Release ${releaseId} does not exist.`);
      const rows = this.db.prepare("SELECT entity_type, data_json FROM release_entity WHERE release_id = ? ORDER BY position").all(releaseId) as { entity_type: EntityType; data_json: string }[];
      const by = (type: EntityType) => rows.filter((r) => r.entity_type === type).map((r) => JSON.parse(r.data_json));
      const vocab = by("vocabulary")[0] ?? { carpets: [], seams: [], upholsteries: [], units: [], schema: "cabin-kit.reference/1", label: "" };
      const release: ReferenceRelease = {
        id: head.id,
        contentHash: head.content_hash,
        activatedAt: head.activated_at,
        schema: vocab.schema,
        label: vocab.label,
        vocabulary: { carpets: vocab.carpets, seams: vocab.seams, upholsteries: vocab.upholsteries, units: vocab.units },
        sources: by("source"),
        subtypes: by("subtype"),
        aircraft: by("aircraft"),
        variants: by("variant"),
        layouts: by("layout"),
        layoutRevisions: by("layoutRevision"),
        assignments: by("assignment"),
        components: by("component"),
        parts: by("part"),
        rules: by("rule"),
        substitutes: by("substitute"),
        kitChildren: by("kitChild"),
        pendingChanges: by("pendingChange"),
        layoutCategories: by("layoutCategory"),
        visualProfiles: by("visualProfile"),
      };
      this.db.exec("COMMIT");
      this.cache.set(releaseId, release);
      return release;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** The active release, read consistently: pointer and content come from the same transaction scope. */
  loadActive(): ReferenceRelease {
    const id = this.activeReleaseId();
    if (!id) throw new ReferenceStoreError("NO_ACTIVE_RELEASE", "No reference release is active. Run the reference import.");
    return this.loadRelease(id);
  }
}

/**
 * Destructive rebuild of the reference store only. Builds the replacement beside the target and
 * swaps it in with one rename, after the same guards as every other reference operation.
 */
export function resetReferenceStore(
  referencePath: string,
  visitsPath: string,
  build: (store: ReferenceStore) => void,
): void {
  assertSafeReferenceTarget(referencePath, visitsPath);
  const temp = `${referencePath}.rebuild-${process.pid}.tmp`;
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${temp}${suffix}`, { force: true });
  if (isSameFile(temp, visitsPath)) throw new ReferenceStoreError("SAME_STORE", "Temporary rebuild path collides with the visit store.");
  const store = ReferenceStore.create(temp, visitsPath);
  try {
    build(store);
    store.checkpoint();
  } catch (e) {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${temp}${suffix}`, { force: true });
    throw e;
  }
  store.close();
  // Re-check immediately before the swap: the target must still be a safe reference target.
  assertSafeReferenceTarget(referencePath, visitsPath);
  for (const suffix of ["-wal", "-shm"]) rmSync(`${referencePath}${suffix}`, { force: true });
  renameSync(temp, referencePath);
  for (const suffix of ["-wal", "-shm"]) rmSync(`${temp}${suffix}`, { force: true });
}
