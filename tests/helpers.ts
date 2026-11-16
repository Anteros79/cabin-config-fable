import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookup } from "../src/domain/resolve.ts";
import type { LookupResult, ReferenceRelease, ReleaseContent, VisitSnapshot } from "../src/domain/types.ts";
import { validateRelease } from "../src/domain/validate.ts";
import { buildSnapshot } from "../src/domain/visitLogic.ts";
import { buildStagedRelease, contentHash, type StagedBuild } from "../src/importer/assemble.ts";
import { importReference } from "../src/importer/cli.ts";
import { type AppHandle, createApp } from "../src/server/app.ts";
import { resolveServerConfig } from "../src/server/config.ts";
import { VisitStore } from "../src/server/visitStore.ts";

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
  return r.status === "RESOLVED" ? result.resolution!.rules[r.ruleId].partNo : null;
}

export function snapshotFor(release: ReferenceRelease, tail: string, date: string): VisitSnapshot {
  return buildSnapshot(release, lookup(release, tail, date), "2026-11-12T12:00:00.000Z");
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

export function makeApp(stores: TestStores = makeStores(), testFaults = false): AppHandle & { stores: TestStores } {
  const config = resolveServerConfig(
    { dataDir: stores.dir, referencePath: stores.referencePath, visitsPath: stores.visitsPath, port: 0, testFaults, webRoot: join(stores.dir, "no-web") },
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
