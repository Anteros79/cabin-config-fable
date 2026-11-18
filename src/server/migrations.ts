import type { DatabaseSync } from "node:sqlite";
import { DomainError } from "../domain/visitLogic.ts";

/**
 * Forward-only schema migrations. A migration may add tables, columns, indexes or triggers.
 * It never rewrites stored snapshots, reports or events: those rows are immutable.
 */
export interface Migration {
  to: number;
  description: string;
  sql: string;
}

/** Visit store migrations, from the base schema (version 1, as written by 5d6679d) onwards. */
export const VISIT_MIGRATIONS: Migration[] = [
  { to: 2, description: "index retry keys by age", sql: "CREATE INDEX IF NOT EXISTS idempotency_created ON idempotency(created_at);" },
  {
    to: 3,
    description: "per-tail observations, aircraft held flag, completion with observations",
    sql: `
CREATE TABLE visit_observations (
  id TEXT PRIMARY KEY,
  tail TEXT NOT NULL,
  location_id TEXT NOT NULL,
  component_id TEXT NOT NULL,
  condition TEXT NOT NULL CHECK (condition IN ('STAINED','TORN','WORN','BROKEN','MISSING','WONT_LATCH','OTHER')),
  note TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL CHECK (outcome IN ('NOTED','DEFERRED','MUST_FIX')),
  defer_until TEXT CHECK (defer_until IN ('NEXT_CHECK','NEXT_STOP')),
  reason TEXT CHECK (reason IN ('NO_STOCK','NO_TIME','OTHER')),
  raised_to TEXT CHECK (raised_to IN ('MEL','NO_GO')),
  mel_class_json TEXT NOT NULL CHECK (json_valid(mel_class_json) AND json_extract(mel_class_json, '$.class') IN ('COSMETIC','MEL','NO_GO')),
  due_date TEXT,
  blocks_seat INTEGER NOT NULL DEFAULT 0 CHECK (blocks_seat IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  version INTEGER NOT NULL CHECK (version >= 1),
  opened_in_visit_id TEXT NOT NULL REFERENCES visits(id),
  closed_in_visit_id TEXT REFERENCES visits(id),
  closed_as TEXT CHECK (closed_as IN ('REPLACED','FIXED')),
  location_label TEXT NOT NULL,
  component_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((outcome = 'DEFERRED') = (defer_until IS NOT NULL AND reason IS NOT NULL)),
  CHECK ((status = 'CLOSED') = (closed_in_visit_id IS NOT NULL AND closed_as IS NOT NULL))
);
CREATE INDEX visit_observations_tail_status ON visit_observations(tail, status);
ALTER TABLE visits ADD COLUMN aircraft_held INTEGER NOT NULL DEFAULT 0 CHECK (aircraft_held IN (0, 1));
DROP TRIGGER visits_complete_needs_records;
CREATE TRIGGER visits_complete_needs_records BEFORE UPDATE OF status ON visits
WHEN NEW.status = 'COMPLETED'
  AND NOT EXISTS (SELECT 1 FROM visit_records WHERE visit_id = NEW.id)
  AND NOT EXISTS (SELECT 1 FROM visit_events WHERE visit_id = NEW.id AND type GLOB 'OBSERVATION_*')
BEGIN SELECT RAISE(ABORT, 'EMPTY_VISIT'); END;
CREATE TRIGGER visit_observations_locked BEFORE UPDATE ON visit_observations
WHEN (SELECT status FROM visits WHERE id = OLD.closed_in_visit_id) IS 'COMPLETED'
  OR (SELECT status FROM visits WHERE id = NEW.closed_in_visit_id) IS 'COMPLETED'
BEGIN SELECT RAISE(ABORT, 'VISIT_LOCKED'); END;
CREATE TRIGGER visit_observations_locked_insert BEFORE INSERT ON visit_observations
WHEN (SELECT status FROM visits WHERE id = NEW.opened_in_visit_id) IS NOT 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'VISIT_LOCKED'); END;
CREATE TRIGGER visit_observations_no_delete BEFORE DELETE ON visit_observations
BEGIN SELECT RAISE(ABORT, 'VISIT_DELETE_FORBIDDEN'); END;
`,
  },
];

function storedVersion(db: DatabaseSync): number | null {
  const value = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value;
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

/**
 * Applies every migration with `to > current`, in ascending order, inside one BEGIN IMMEDIATE,
 * and records the new version in `meta.schema_version`. Returns the new version (or `current`
 * when nothing is pending). If another connection migrated first, the version stored under the
 * write lock is the starting point, so no step runs twice; if that version is newer than every
 * migration known here (a newer Cabin Kit got there first), it throws VISIT_SCHEMA_NEWER.
 * Any failure rolls back every step.
 */
export function migrate(db: DatabaseSync, current: number, migrations: Migration[]): number {
  const newest = Math.max(current, ...migrations.map((m) => m.to));
  if (newest === current) return current;
  db.exec("BEGIN IMMEDIATE");
  try {
    const stored = storedVersion(db);
    if (stored !== null && stored > newest) {
      throw new DomainError("VISIT_SCHEMA_NEWER", "This visit store was written by a newer version of Cabin Kit.", 500);
    }
    const from = Math.max(current, stored ?? current);
    const pending = migrations.filter((m) => m.to > from).sort((a, b) => a.to - b.to);
    let version = from;
    for (const step of pending) {
      db.exec(step.sql);
      version = step.to;
    }
    if (version !== from) db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(version));
    db.exec("COMMIT");
    return version;
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}
