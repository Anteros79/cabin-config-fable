import type { DatabaseSync } from "node:sqlite";

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
];

function storedVersion(db: DatabaseSync): number | null {
  const value = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value;
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

/**
 * Applies every migration with `to > current`, in ascending order, inside one BEGIN IMMEDIATE,
 * and records the new version in `meta.schema_version`. Returns the new version (or `current`
 * when nothing is pending). If another connection migrated first, the version stored under the
 * write lock is the starting point, so no step runs twice. Any failure rolls back every step.
 */
export function migrate(db: DatabaseSync, current: number, migrations: Migration[]): number {
  const newest = Math.max(current, ...migrations.map((m) => m.to));
  if (newest === current) return current;
  db.exec("BEGIN IMMEDIATE");
  try {
    const from = Math.max(current, storedVersion(db) ?? current);
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
