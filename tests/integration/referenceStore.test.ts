import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { contentHash, legacyContentHash } from "../../src/domain/hash.ts";
import { lookup } from "../../src/domain/resolve.ts";
import { buildStagedRelease } from "../../src/importer/assemble.ts";
import { importReference } from "../../src/importer/cli.ts";
import { canonicalPath, isSameFile, resolveServerConfig, resolveStoreConfig } from "../../src/server/config.ts";
import { assertSafeReferenceTarget, inspectStore, ReferenceStore, ReferenceStoreError, resetReferenceStore } from "../../src/server/referenceStore.ts";
import { StorageError, VisitStore } from "../../src/server/visitStore.ts";
import { at, CUSHION_3A, changedFixturePath, cleanupTempDirs, KIT_ALTERNATE, makeApp, makeStores, openVisits, snapshotFor, tempDir } from "../helpers.ts";

afterAll(cleanupTempDirs);

const refCode = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof ReferenceStoreError ? e.code : `other:${(e as Error).message}`;
  }
  return "no-error";
};

function storesWithHistory() {
  const stores = makeStores();
  const ref = ReferenceStore.open(stores.referencePath, stores.visitsPath, { readOnly: true });
  const release = ref.loadActive();
  ref.close();
  const visits = openVisits(stores);
  const draft = visits.createVisit(snapshotFor(release, "N100TL", "2026-11-12"), "Demo").visit;
  visits.upsertRecord(draft.id, CUSHION_3A, undefined);
  const done = visits.createVisit(snapshotFor(release, "N100TL", "2026-11-12"), "Demo").visit;
  visits.upsertRecord(done.id, KIT_ALTERNATE, undefined);
  visits.completeVisit(done.id, undefined);
  const fingerprint = visits.fingerprint();
  visits.close();
  return { stores, fingerprint, releaseId: release.id };
}
const fingerprintOf = (s: { visitsPath: string; referencePath: string }) => {
  const v = VisitStore.open(s.visitsPath, s.referencePath);
  try {
    return v.fingerprint();
  } finally {
    v.close();
  }
};

describe("staged import and atomic activation", () => {
  it("activates a validated release and keeps history of releases", () => {
    const stores = makeStores();
    const store = ReferenceStore.open(stores.referencePath, stores.visitsPath);
    const first = store.activeReleaseId()!;
    const second = importReferenceInto(stores);
    expect(second.activated).toBe(true);
    const list = store.listReleases();
    expect(list.map((r) => r.status)).toEqual(["active", "superseded"]);
    expect(store.activeReleaseId()).toBe(second.releaseId);
    expect(list[1]?.id).toBe(first);
    expect(store.events().map((e) => e.type)).toEqual(["VALIDATED", "ACTIVATED", "VALIDATED", "ACTIVATED"]);
    store.close();
  });

  it("stage keeps the original error when rollback also fails", () => {
    const stores = makeStores();
    const store = ReferenceStore.open(stores.referencePath, stores.visitsPath);
    const bad = buildStagedRelease({ includeCandidate: false });
    const db = (store as unknown as { db: DatabaseSync }).db;
    const realExec = db.exec.bind(db);
    db.exec = (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("rollback failed");
      return realExec(sql);
    };
    // a BigInt in the findings makes JSON.stringify throw inside the transaction
    const poisoned = [{ severity: "error" as const, code: "X", message: "m", n: 1n }] as never;
    expect(() => store.stage(bad.content, poisoned, {})).toThrow(/BigInt/);
    db.exec = realExec;
    realExec("ROLLBACK");
    store.close();
  });

  it("a release with blocking findings is stored as rejected and never becomes active", () => {
    const stores = makeStores();
    const store = ReferenceStore.open(stores.referencePath, stores.visitsPath);
    const active = store.activeReleaseId()!;
    const bad = buildStagedRelease({ includeCandidate: false });
    at(bad.content.rules, 0).partNo = "NOPE";
    const findings = [{ severity: "error" as const, code: "ORPHAN", message: "bad" }];
    const staged = store.stage(bad.content, findings, {});
    expect(staged.status).toBe("rejected");
    expect(refCode(() => store.activate(staged.id))).toBe("RELEASE_NOT_VALIDATED");
    expect(store.activeReleaseId()).toBe(active);
    expect(store.loadActive().rules[0]?.partNo).not.toBe("NOPE");
    store.close();
  });

  it("staging does not change the active release until activation", () => {
    const stores = makeStores();
    const store = ReferenceStore.open(stores.referencePath, stores.visitsPath);
    const active = store.activeReleaseId()!;
    const next = buildStagedRelease({ includeCandidate: false, label: "next" });
    const staged = store.stage(next.content, next.findings, {});
    expect(staged.status).toBe("validated");
    expect(store.activeReleaseId()).toBe(active);
    store.activate(staged.id);
    expect(store.activeReleaseId()).toBe(staged.id);
    store.activate(staged.id); // idempotent
    expect(store.listReleases().filter((r) => r.status === "active")).toHaveLength(1);
    store.close();
  });

  it("a failed stage rolls back completely", () => {
    const stores = makeStores();
    const store = ReferenceStore.open(stores.referencePath, stores.visitsPath);
    const before = store.listReleases().length;
    const broken = buildStagedRelease({ includeCandidate: false });
    broken.content.rules.push({ ...at(broken.content.rules, 0) }); // duplicate primary key inside the transaction
    expect(() => store.stage(broken.content, [], {})).toThrow();
    expect(store.listReleases()).toHaveLength(before);
    expect(store.loadActive().id).toBe(store.activeReleaseId());
    store.close();
  });

  it("released entities are immutable in storage", () => {
    const stores = makeStores();
    const db = new DatabaseSync(stores.referencePath);
    expect(() => db.exec("UPDATE release_entity SET data_json = '{}' WHERE entity_type = 'rule'")).toThrow(/RELEASE_IMMUTABLE/);
    expect(() => db.exec("DELETE FROM release_entity WHERE entity_type = 'rule'")).toThrow(/RELEASE_IMMUTABLE/);
    expect(() => db.exec("UPDATE release SET content_hash = 'x'")).toThrow(/RELEASE_IMMUTABLE/);
    db.close();
  });

  it("a lookup sees one whole release even if another connection activates a new one mid-flight", () => {
    const stores = makeStores();
    const reader = ReferenceStore.open(stores.referencePath, stores.visitsPath, { readOnly: true });
    const writer = ReferenceStore.open(stores.referencePath, stores.visitsPath);
    const releaseA = reader.loadActive();
    const next = buildStagedRelease({ includeCandidate: false, label: "B" });
    next.content.parts.push({ partNo: "FAKE-SC-9999", namespace: "fixture", description: "changed" });
    next.content.rules.find((r) => r.id === "FX-R-V01-ELR-A-CUSHION")!.partNo = "FAKE-SC-9999";
    const staged = writer.stage(next.content, [], {});
    writer.activate(staged.id);
    // The object loaded before activation is still entirely release A.
    const snapA = snapshotFor(releaseA, "N100TL", "2026-11-12");
    expect(snapA.referenceReleaseId).toBe(releaseA.id);
    expect(snapA.referenceContentHash).toBe(releaseA.contentHash);
    const cushion = snapA.resolution.components.find((c) => c.locationId === "SEAT:3A" && c.componentId === "CUSHION")!;
    expect(cushion.status === "RESOLVED" && snapA.resolution.rules[cushion.ruleId]?.partNo).toBe("FAKE-SC-1001");
    // A fresh read is entirely release B.
    const releaseB = reader.loadActive();
    expect(releaseB.id).toBe(staged.id);
    const r = lookup(releaseB, "N100TL", "2026-11-12");
    const c2 = r.resolution!.components.find((c) => c.locationId === "SEAT:3A" && c.componentId === "CUSHION")!;
    expect(c2.status === "RESOLVED" && r.resolution!.rules[c2.ruleId]?.partNo).toBe("FAKE-SC-9999");
    reader.close();
    writer.close();
  });
});

/** A second import with changed (valid) fixtures, so it stages a new release instead of being a no-op. */
function importReferenceInto(stores: { referencePath: string; visitsPath: string }) {
  return importReference({
    referencePath: stores.referencePath,
    visitsPath: stores.visitsPath,
    includeCandidate: false,
    fixturePath: changedFixturePath("second"),
  });
}

describe("reference import and reset never touch visit history", () => {
  it("import leaves visits byte-for-byte unchanged and reports it", () => {
    const { stores, fingerprint } = storesWithHistory();
    const outcome = importReferenceInto(stores);
    expect(outcome.visitsUnchanged).toBe(true);
    expect(fingerprintOf(stores)).toBe(fingerprint);
  });

  it("reset rebuilds only the reference store", () => {
    const { stores, fingerprint, releaseId } = storesWithHistory();
    resetReferenceStore(stores.referencePath, stores.visitsPath, (store) => {
      const staged = buildStagedRelease({ includeCandidate: false, label: "rebuilt" });
      store.activate(store.stage(staged.content, staged.findings, {}).id);
    });
    const ref = ReferenceStore.open(stores.referencePath, stores.visitsPath, { readOnly: true });
    expect(ref.listReleases()).toHaveLength(1);
    expect(ref.loadActive().label).toBe("rebuilt");
    ref.close();
    expect(fingerprintOf(stores)).toBe(fingerprint);
    // completed and draft visits still open and still carry the old release id in their snapshot
    const visits = openVisits(stores);
    const items = visits.listVisits().items;
    expect(items).toHaveLength(2);
    expect(items.every((v) => v.referenceReleaseId === releaseId)).toBe(true);
    expect(visits.getReport(items.find((v) => v.status === "COMPLETED")!.id).report.totals).toHaveLength(5);
    visits.close();
  });

  it("a failing reset leaves the existing reference store and the visits in place", () => {
    const { stores, fingerprint, releaseId } = storesWithHistory();
    const before = readFileSync(stores.referencePath);
    expect(() =>
      resetReferenceStore(stores.referencePath, stores.visitsPath, () => {
        throw new Error("build failed half way");
      }),
    ).toThrow(/build failed half way/);
    const ref = ReferenceStore.open(stores.referencePath, stores.visitsPath, { readOnly: true });
    expect(ref.activeReleaseId()).toBe(releaseId);
    ref.close();
    expect(readFileSync(stores.referencePath).length).toBe(before.length);
    expect(fingerprintOf(stores)).toBe(fingerprint);
    expect(existsSync(`${stores.referencePath}.rebuild-${process.pid}.tmp`)).toBe(false);
  });
});

describe("store guards", () => {
  it("refuses identical reference and visit paths", () => {
    const { stores, fingerprint } = storesWithHistory();
    expect(refCode(() => importReference({ referencePath: stores.visitsPath, visitsPath: stores.visitsPath }))).toBe("SAME_STORE");
    expect(refCode(() => resetReferenceStore(stores.visitsPath, stores.visitsPath, () => undefined))).toBe("SAME_STORE");
    expect(fingerprintOf(stores)).toBe(fingerprint);
  });

  it("refuses symlink-equivalent and hard-linked paths", () => {
    const { stores, fingerprint } = storesWithHistory();
    const link = join(stores.dir, "alias.sqlite");
    symlinkSync(stores.visitsPath, link);
    expect(isSameFile(link, stores.visitsPath)).toBe(true);
    expect(refCode(() => resetReferenceStore(link, stores.visitsPath, () => undefined))).toBe("SAME_STORE");
    expect(refCode(() => importReference({ referencePath: link, visitsPath: stores.visitsPath }))).toBe("SAME_STORE");
    const hard = join(stores.dir, "hard.sqlite");
    linkSync(stores.visitsPath, hard);
    expect(refCode(() => resetReferenceStore(hard, stores.visitsPath, () => undefined))).toBe("SAME_STORE");
    // a symlinked directory spelling of the same file
    const dirLink = join(stores.dir, "dirlink");
    symlinkSync(stores.dir, dirLink);
    expect(refCode(() => resetReferenceStore(join(dirLink, "visits.sqlite"), stores.visitsPath, () => undefined))).toBe("SAME_STORE");
    // a not-yet-existing file reached through a symlinked directory still canonicalises
    expect(canonicalPath(join(dirLink, "new.sqlite"))).toBe(canonicalPath(join(stores.dir, "new.sqlite")));
    expect(fingerprintOf(stores)).toBe(fingerprint);
  });

  it("refuses a different file that contains visit tables", () => {
    const { stores, fingerprint } = storesWithHistory();
    const other = tempDir();
    const copy = join(other, "copy-of-visits.sqlite");
    const v = openVisits(stores);
    v.backupTo(copy);
    v.close();
    expect(inspectStore(copy)).toMatchObject({ kind: "visits", visitRows: 2 });
    expect(refCode(() => resetReferenceStore(copy, stores.visitsPath, () => undefined))).toBe("VISIT_DATA_PRESENT");
    expect(refCode(() => importReference({ referencePath: copy, visitsPath: stores.visitsPath }))).toBe("VISIT_DATA_PRESENT");
    expect(inspectStore(copy).visitRows).toBe(2);
    expect(fingerprintOf(stores)).toBe(fingerprint);
  });

  it("never trusts a reference marker alone: mixed and unknown databases are refused", () => {
    const dir = tempDir();
    const visitsPath = join(dir, "visits.sqlite");
    // a visit database that also carries the reference marker and reference tables
    const mixed = join(dir, "mixed.sqlite");
    const db = new DatabaseSync(mixed);
    db.exec(
      "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES('store_kind','cabin-kit-reference'); CREATE TABLE release(id TEXT); CREATE TABLE visits(id TEXT); INSERT INTO visits VALUES('user-history');",
    );
    db.close();
    expect(inspectStore(mixed).kind).toBe("mixed");
    expect(refCode(() => resetReferenceStore(mixed, visitsPath, () => undefined))).toBe("VISIT_DATA_PRESENT");
    // an unrelated database carrying only the marker
    const marked = join(dir, "marked.sqlite");
    const db2 = new DatabaseSync(marked);
    db2.exec(
      "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES('store_kind','cabin-kit-reference'); CREATE TABLE customer_orders(id TEXT); INSERT INTO customer_orders VALUES('keep me');",
    );
    db2.close();
    expect(inspectStore(marked).kind).toBe("unknown");
    expect(refCode(() => resetReferenceStore(marked, visitsPath, () => undefined))).toBe("UNKNOWN_STORE");
    expect(refCode(() => importReference({ referencePath: marked, visitsPath }))).toBe("UNKNOWN_STORE");
    // marker and nothing else is still not a reference store
    const bare = join(dir, "bare.sqlite");
    const db3 = new DatabaseSync(bare);
    db3.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES('store_kind','cabin-kit-reference');");
    db3.close();
    expect(refCode(() => assertSafeReferenceTarget(bare, visitsPath))).toBe("UNKNOWN_STORE");
    // not a database at all
    const text = join(dir, "notes.sqlite");
    writeFileSync(text, "user notes, not a database");
    expect(refCode(() => resetReferenceStore(text, visitsPath, () => undefined))).toBe("UNKNOWN_STORE");
    expect(readFileSync(text, "utf8")).toBe("user notes, not a database");
    const check = new DatabaseSync(marked, { readOnly: true });
    expect(check.prepare("SELECT id FROM customer_orders").get()).toEqual({ id: "keep me" });
    check.close();
  });

  it("the visit store refuses to open a reference or unknown database", () => {
    const stores = makeStores();
    expect(() => VisitStore.open(stores.referencePath, join(stores.dir, "other.sqlite"))).toThrow(/reference database/);
    expect(() => VisitStore.open(stores.referencePath, stores.referencePath)).toThrow(/same file/);
  });

  // chmod does not stop root from writing, so the fault cannot be provoked that way as root.
  it.skipIf(process.getuid?.() === 0)("a SQLite fault while opening the reference store is a StorageError", () => {
    const stores = makeStores();
    const db = new DatabaseSync(stores.referencePath);
    db.exec("PRAGMA journal_mode=DELETE");
    db.close();
    chmodSync(stores.referencePath, 0o444); // read-write open falls back to read-only; the WAL switch then fails
    try {
      let caught: unknown;
      try {
        ReferenceStore.open(stores.referencePath, stores.visitsPath).close();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(StorageError);
      expect((caught as StorageError).message).toMatch(/readonly/);
    } finally {
      chmodSync(stores.referencePath, 0o644);
    }
  });
});

describe("path configuration is shared by seed and start", () => {
  it("the import CLI and the server resolve the same store paths from the same inputs", () => {
    const env = { CABIN_KIT_DATA_DIR: "/tmp/ck-data-x" };
    const cli = resolveStoreConfig({}, env);
    const server = resolveServerConfig({}, env);
    expect(server.referencePath).toBe(cli.referencePath);
    expect(server.visitsPath).toBe(cli.visitsPath);
    expect(cli.referencePath).toBe("/tmp/ck-data-x/reference.sqlite");
    const explicit = { CABIN_KIT_REFERENCE_DB: "/tmp/a/ref.db", CABIN_KIT_VISITS_DB: "/tmp/b/visits.db", CABIN_KIT_DATA_DIR: "/tmp/ignored" };
    expect(resolveServerConfig({}, explicit)).toMatchObject(resolveStoreConfig({}, explicit));
    expect(resolveStoreConfig({}, explicit).referencePath).toBe("/tmp/a/ref.db");
    expect(resolveServerConfig({}, {}).host).toBe("127.0.0.1");
  });

  it("creates the data directory when importing into a new location", () => {
    const dir = join(tempDir(), "nested", "data");
    mkdirSync(join(dir, ".."), { recursive: true });
    const outcome = importReference({ referencePath: join(dir, "reference.sqlite"), visitsPath: join(dir, "visits.sqlite"), includeCandidate: false });
    expect(outcome).toMatchObject({ status: "validated", activated: true, visitsUnchanged: null });
    expect(inspectStore(join(dir, "reference.sqlite")).kind).toBe("reference");
    expect(existsSync(join(dir, "visits.sqlite"))).toBe(false); // importing never creates a visit store
  });
});

describe("release integrity", () => {
  it("a tampered release entity is detected on load", () => {
    const stores = makeStores();
    const db = new DatabaseSync(stores.referencePath);
    db.exec(
      "DROP TRIGGER release_entity_frozen_update; UPDATE release_entity SET data_json = json_set(data_json, '$.partNo', 'FAKE-TAMPERED') WHERE rowid = (SELECT min(rowid) FROM release_entity WHERE entity_type = 'rule')",
    );
    db.close();
    const store = ReferenceStore.open(stores.referencePath, stores.visitsPath, { readOnly: true });
    expect(refCode(() => store.loadActive())).toBe("RELEASE_CORRUPT");
    expect(refCode(() => store.loadRelease(String(store.activeReleaseId())))).toBe("RELEASE_CORRUPT");
    store.close();
  });

  it("a reference store built before the label left the hash still loads (PF-5)", () => {
    // Stage a release as the importer did before: its recorded hash covers the label.
    const dir = tempDir();
    const stores = { referencePath: join(dir, "reference.sqlite"), visitsPath: join(dir, "visits.sqlite") };
    const old = buildStagedRelease({ includeCandidate: false, label: "Imported before the hash change" });
    const legacy = legacyContentHash(old.content);
    expect(legacy).not.toBe(contentHash(old.content));
    const writer = ReferenceStore.openOrCreate(stores.referencePath, stores.visitsPath);
    const { id } = writer.stage(old.content, old.findings, old.stats);
    writer.activate(id);
    writer.close();
    const db = new DatabaseSync(stores.referencePath);
    db.exec(
      `DROP TRIGGER release_hash_frozen; UPDATE release SET content_hash = '${legacy}'; CREATE TRIGGER release_hash_frozen BEFORE UPDATE OF id, seq, content_hash, created_at ON release BEGIN SELECT RAISE(ABORT, 'RELEASE_IMMUTABLE'); END;`,
    );
    db.close();

    const store = ReferenceStore.open(stores.referencePath, stores.visitsPath, { readOnly: true });
    const release = store.loadActive();
    expect(release).toMatchObject({ id, contentHash: legacy, label: "Imported before the hash change" });
    expect(store.activeContentHash()).toBe(legacy);
    store.close();
    // The first import after the upgrade records the new hash once; the next one is a no-op.
    const upgraded = importReference({ ...stores, includeCandidate: false });
    expect(upgraded).toMatchObject({ unchanged: false, activated: true });
    expect(importReference({ ...stores, includeCandidate: false })).toMatchObject({ unchanged: true, releaseId: upgraded.releaseId });
    const after = ReferenceStore.open(stores.referencePath, stores.visitsPath, { readOnly: true });
    expect(after.loadRelease(id).contentHash).toBe(legacy);
    expect(after.activeContentHash()).toBe(contentHash(old.content));
    after.close();
  });

  it("the cached release cannot be mutated", () => {
    const stores = makeStores();
    const store = ReferenceStore.open(stores.referencePath, stores.visitsPath, { readOnly: true });
    const release = store.loadActive();
    expect(Object.isFrozen(release)).toBe(true);
    expect(() => {
      store.loadActive().rules.length = 0;
    }).toThrow(TypeError);
    expect(() => {
      at(release.rules, 0).partNo = "NOPE";
    }).toThrow(TypeError);
    expect(store.loadActive()).toBe(release);
    expect(store.loadRelease(release.id)).toBe(release);
    expect(release.rules.length).toBeGreaterThan(0);
    store.close();
  });

  it("an SQLite fault in the reference store is a storage failure (503), not an internal error", async () => {
    const stores = makeStores();
    const db = new DatabaseSync(stores.referencePath);
    db.exec("ALTER TABLE release_entity RENAME COLUMN data_json TO data_text");
    db.close();
    const store = ReferenceStore.open(stores.referencePath, stores.visitsPath, { readOnly: true });
    expect(() => store.loadActive()).toThrow(StorageError);
    store.close();
    const app = makeApp({ stores });
    const res = await app.app.inject("/api/tails");
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    await app.close();
  });
});
