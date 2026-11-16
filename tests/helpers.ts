import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookup } from "../src/domain/resolve.ts";
import type { ApplicabilityRule, LookupResult, ReferenceRelease, ReleaseContent, Visit, VisitRecord, VisitSnapshot } from "../src/domain/types.ts";
import { validateRelease } from "../src/domain/validate.ts";
import { buildSnapshot, deriveRecord } from "../src/domain/visitLogic.ts";
import { buildStagedRelease, contentHash, DEFAULT_FIXTURE_PATH, type StagedBuild } from "../src/importer/assemble.ts";
import { importReference } from "../src/importer/cli.ts";
import { type AppHandle, createApp } from "../src/server/app.ts";
import { resolveServerConfig } from "../src/server/config.ts";
import { VisitStore } from "../src/server/visitStore.ts";

/**
 * Content hash of the release the importer stages from the committed fixtures and originals (PF-2).
 * A task that moves it on purpose updates it here and records old → new in CHANGELOG.md and its commit body.
 */
export const EXPECTED_CONTENT_HASH = "9cf6c6d29e468c944381a11f9042c89f2ad30cfd07d852720796ce14b2d8ed72";

let fullBuild: StagedBuild | null = null;
let fixtureBuild: StagedBuild | null = null;

/** Fixtures + supplied candidate registry, exactly as the importer stages them. */
export function stagedFull(): StagedBuild {
  fullBuild ??= buildStagedRelease();
  return fullBuild;
}

/** A private, mutable copy of the fixture-only release content. */
export function fixtureContent(mutate?: (content: ReleaseContent) => void): ReleaseContent {
  fixtureBuild ??= buildStagedRelease({ includeCandidate: false });
  const content = structuredClone(fixtureBuild.content);
  mutate?.(content);
  return content;
}

export function asRelease(content: ReleaseContent, id = "TEST-REL"): ReferenceRelease {
  return { ...content, id, contentHash: contentHash(content), activatedAt: null };
}

export function fixtureRelease(mutate?: (content: ReleaseContent) => void): ReferenceRelease {
  return asRelease(fixtureContent(mutate));
}

/** A released fixture-namespace CUSHION rule, valid from 2024-01-01, citing FX-DOC-A unless `extra` says otherwise. */
export function cushionRule(
  id: string,
  partNo: string,
  constraint: ApplicabilityRule["constraint"],
  locations: ApplicabilityRule["locations"],
  extra: Partial<ApplicabilityRule> = {},
): ApplicabilityRule {
  return {
    id,
    namespace: "fixture",
    componentId: "CUSHION",
    partNo,
    qtyPerReplacement: 1,
    unit: "EA",
    constraint,
    locations,
    released: true,
    effectiveFrom: "2024-01-01",
    effectiveTo: null,
    sourceId: "FX-DOC-A",
    ...extra,
  };
}

/** The fixture release with its V01 CUSHION rules replaced by `rules` (parts added as needed). */
export function withCushionRules(rules: ApplicabilityRule[], more?: (c: ReleaseContent) => void): ReferenceRelease {
  return fixtureRelease((c) => {
    c.rules = c.rules.filter((r) => !(r.componentId === "CUSHION" && r.constraint.variant?.includes("V01")));
    for (const r of rules) {
      if (!c.parts.some((p) => p.partNo === r.partNo)) c.parts.push({ partNo: r.partNo, namespace: "fixture", description: r.partNo });
      c.rules.push(r);
    }
    more?.(c);
  });
}

export function errorsOf(content: ReleaseContent): string[] {
  return validateRelease(content)
    .filter((f) => f.severity === "error")
    .map((f) => f.code);
}

export function resolutionAt(result: LookupResult, locationId: string, componentId: string) {
  const found = result.resolution?.components.find((c) => c.locationId === locationId && c.componentId === componentId);
  if (!found) throw new Error(`no resolution for ${locationId}/${componentId}`);
  return found;
}

export function partAt(result: LookupResult, locationId: string, componentId: string): string | null {
  const r = resolutionAt(result, locationId, componentId);
  return r.status === "RESOLVED" ? entry(result.resolution!.rules, r.ruleId).partNo : null;
}

/** The element a test expects at `index`; fails the test, naming the index, when it is absent. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`test expected an element at index ${index} of ${items.length}`);
  return item;
}

/** The record entry a test expects under `key`; fails the test, naming the key, when it is absent. */
export function entry<T>(record: Readonly<Record<string, T>>, key: string): T {
  const value = record[key];
  if (value === undefined) throw new Error(`test expected an entry for ${key}`);
  return value;
}

export function snapshotFor(release: ReferenceRelease, tail: string, date: string): VisitSnapshot {
  return buildSnapshot(release, lookup(release, tail, date), "2026-11-12T12:00:00.000Z");
}

/** An in-memory draft visit over `snap` with records derived from `inputs`, for the pure report builders. */
export function visitWith(snap: VisitSnapshot, inputs: unknown[]): Visit {
  const records: VisitRecord[] = inputs.map((input) => ({
    ...deriveRecord(snap, input),
    version: 1,
    createdAt: "2026-11-12T12:01:00.000Z",
    updatedAt: "2026-11-12T12:01:00.000Z",
  }));
  return {
    id: "visit-1",
    number: 1,
    tail: snap.tail,
    checkDate: snap.checkDate,
    technician: "Demo",
    status: "DRAFT",
    version: 1 + records.length,
    createdAt: "2026-11-12T12:00:00.000Z",
    updatedAt: "2026-11-12T12:01:00.000Z",
    completedAt: null,
    recordCount: records.length,
    referenceReleaseId: snap.referenceReleaseId,
    lookupState: snap.lookupState,
    variantId: snap.context.variant.id,
    layoutRevisionId: snap.context.layoutRevision.id,
    snapshot: snap,
    snapshotSha256: "test",
    records,
    events: [],
  };
}

/**
 * The snapshot shape frozen before report schema 2: no `excluded` on resolved or ambiguous
 * components and no `sourceId` on a no-match exclusion. Returns a copy.
 */
export function oldShapeSnapshot(snap: VisitSnapshot): VisitSnapshot {
  const old = structuredClone(snap);
  for (const c of old.resolution.components) {
    if (c.status === "NO_MATCH") {
      for (const e of c.excluded) delete e.sourceId;
    } else delete c.excluded;
  }
  return old;
}

const dirs: string[] = [];
export function tempDir(prefix = "cabin-kit-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * A temp copy of fixtures/fixture-data.json with one harmless change (a part description carries `tag`), for a
 * test that needs a different but valid release. The committed fixture file is never edited.
 */
export function changedFixturePath(tag: string): string {
  const data = JSON.parse(readFileSync(DEFAULT_FIXTURE_PATH, "utf8")) as { extraParts: { description: string }[] };
  const part = at(data.extraParts, 0);
  part.description = `${part.description} (${tag})`;
  const path = join(tempDir("cabin-kit-fx-"), "fixture-data.json");
  writeFileSync(path, JSON.stringify(data));
  return path;
}

export interface TestStores {
  dir: string;
  referencePath: string;
  visitsPath: string;
}

/** Disposable stores with the real import applied. Never touches ./data. */
export function makeStores(options: { includeCandidate?: boolean } = {}): TestStores {
  const dir = tempDir();
  const referencePath = join(dir, "reference.sqlite");
  const visitsPath = join(dir, "visits.sqlite");
  const outcome = importReference({ referencePath, visitsPath, includeCandidate: options.includeCandidate ?? false });
  if (!outcome.activated) throw new Error("test reference import was not activated");
  return { dir, referencePath, visitsPath };
}

export function openVisits(stores: TestStores): VisitStore {
  return VisitStore.open(stores.visitsPath, stores.referencePath);
}

export interface MakeAppOptions {
  stores?: TestStores;
  testFaults?: boolean;
  allowedHosts?: string[];
  webRoot?: string;
  logLevel?: "silent" | "error" | "warn" | "info" | "debug";
}

export function makeApp(options: MakeAppOptions = {}): AppHandle & { stores: TestStores } {
  const stores = options.stores ?? makeStores();
  const config = resolveServerConfig(
    {
      dataDir: stores.dir,
      referencePath: stores.referencePath,
      visitsPath: stores.visitsPath,
      port: 0,
      testFaults: options.testFaults ?? false,
      logLevel: options.logLevel ?? "silent",
      webRoot: options.webRoot ?? join(stores.dir, "no-web"),
      ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}),
    },
    {},
  );
  return Object.assign(createApp(config), { stores });
}

export const SIX_LINE_TOTALS = [
  ["FAKE-CK-2000", 1, "KIT"],
  ["FAKE-P-39", 2, "PANEL"],
  ["FAKE-P-40", 2, "PANEL"],
  ["FAKE-P-41", 1, "PANEL"],
  ["FAKE-P-42", 1, "PANEL"],
  ["FAKE-SC-1001", 1, "EA"],
] as const;

export const CUSHION_3A = { locationId: "SEAT:3A", componentId: "CUSHION", selection: "PRIMARY", substituteId: null, quantity: 1, note: "" } as const;
export const KIT_ALTERNATE = {
  locationId: "FLOOR:FULL-CABIN",
  componentId: "CARPET_KIT",
  selection: "ALTERNATE",
  substituteId: "FX-SUB-KIT-1",
  quantity: 1,
  note: "",
} as const;
export const KIT_PRIMARY = {
  locationId: "FLOOR:FULL-CABIN",
  componentId: "CARPET_KIT",
  selection: "PRIMARY",
  substituteId: null,
  quantity: 1,
  note: "",
} as const;
