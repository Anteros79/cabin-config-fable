import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../domain/canonical.ts";
import { contentHash } from "../domain/hash.ts";
import type { Finding, ReleaseContent, VisualProfile } from "../domain/types.ts";
import { validateRelease } from "../domain/validate.ts";
import { buildCandidateContent } from "./candidate.ts";
import { FixtureError } from "./fixtureSchema.ts";
import { buildFixtureContent, emptyFixtureContent, type FixtureContent, loadFixtureData } from "./fixtures.ts";
import { resolveSourceRoot } from "./originals.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(here, "..", "..");
export const DEFAULT_FIXTURE_PATH = join(PROJECT_ROOT, "fixtures", "fixture-data.json");

/** Default location of the supplied originals: the development folder two levels above the project. */
export function defaultSourceRoot(): string {
  return resolve(resolveSourceRoot());
}

export const VISUAL_PROFILES: VisualProfile[] = [
  {
    id: "photo-navy-band",
    name: "Photographed navy with pale-blue band",
    basis: "Photographs",
    status: "unassigned-illustrative",
    evidence: ["recarro 2.jpg", "seats 1.jpeg", "seats 2 .jpeg", "seats 4.jpg", "southwest seats-7.webp", "seats 3.jpg", "carpet.jpg"],
    note: "Dark navy seat with a pale-blue upper-back band and headrest surround, pale arms and rear shells. Not mapped to any layout, tail, hardware part or material specification.",
  },
  {
    id: "photo-navy-plain",
    name: "Photographed navy without band",
    basis: "Photographs",
    status: "unassigned-illustrative",
    evidence: ["seats 5.jpg", "seats 6.avif"],
    note: "Navy back with no pale upper band and a single pale headrest wing face. Whether this is the same hardware as the banded family is unknown, so it is kept separate.",
  },
  {
    id: "concept-gray",
    name: "Concept/render gray treatment",
    basis: "Probable computer renders",
    status: "unassigned-illustrative",
    evidence: ["Southwest-Airlines-new-RECARO-seats-Video-still-Southwest.png", "seats 8.jpg"],
    note: "Gray-lilac upholstery under warm daylight in what appear to be renders. Compatibility with the photographed blue upholstery is unknown; the two are never blended into one seat.",
  },
];

export { canonicalJson, contentHash };

export interface StagedBuild {
  content: ReleaseContent;
  findings: Finding[];
  stats: Record<string, unknown>;
}

export interface BuildOptions {
  sourceRoot?: string;
  fixturePath?: string;
  label?: string;
  /** Skip the supplied candidate registry (used by tests that only need fixtures). */
  includeCandidate?: boolean;
  /** Stage originals that differ from evidence/originals-manifest.json (a warning instead of an error). */
  acceptChanged?: boolean;
}

/** Most FIXTURE_INVALID findings per build; past that, the last one says how many more there are. */
const MAX_FIXTURE_FINDINGS = 50;

function fixtureFindings(issues: string[]): Finding[] {
  const listed = issues.length > MAX_FIXTURE_FINDINGS ? issues.slice(0, MAX_FIXTURE_FINDINGS - 1) : issues;
  const messages = [...listed];
  if (listed.length < issues.length) messages.push(`${issues.length - listed.length} more fixture problems are not listed.`);
  return messages.map((message) => ({ severity: "error", code: "FIXTURE_INVALID", message, refs: ["fixtures"] }));
}

/** The fixture content, or (for an invalid fixture file) empty content and one blocking finding per problem. */
function loadFixtures(path: string): { fixture: FixtureContent; findings: Finding[] } {
  try {
    return { fixture: buildFixtureContent(loadFixtureData(path)), findings: [] };
  } catch (error) {
    if (!(error instanceof FixtureError)) throw error;
    return { fixture: emptyFixtureContent(), findings: fixtureFindings(error.issues) };
  }
}

/** Build the staged release content from the fictional fixtures plus the supplied candidate registry. */
export function buildStagedRelease(options: BuildOptions = {}): StagedBuild {
  const { fixture, findings: fixtureProblems } = loadFixtures(options.fixturePath ?? DEFAULT_FIXTURE_PATH);
  const includeCandidate = options.includeCandidate ?? true;
  const candidate = includeCandidate
    ? buildCandidateContent(options.sourceRoot ?? defaultSourceRoot(), { acceptChanged: options.acceptChanged ?? false })
    : { sources: [], subtypes: [], layouts: [], layoutRevisions: [], layoutCategories: [], findings: [], stats: {} };
  const content: ReleaseContent = {
    schema: "cabin-kit.reference/1",
    label: options.label ?? "Fictional fixtures + supplied candidate registry",
    vocabulary: fixture.vocabulary,
    sources: [...fixture.sources, ...candidate.sources],
    subtypes: [...fixture.subtypes, ...candidate.subtypes],
    aircraft: fixture.aircraft,
    variants: fixture.variants,
    layouts: [...fixture.layouts, ...candidate.layouts],
    layoutRevisions: [...fixture.layoutRevisions, ...candidate.layoutRevisions],
    assignments: fixture.assignments,
    components: fixture.components,
    parts: fixture.parts,
    rules: fixture.rules,
    substitutes: fixture.substitutes,
    kitChildren: fixture.kitChildren,
    pendingChanges: fixture.pendingChanges,
    layoutCategories: candidate.layoutCategories,
    visualProfiles: VISUAL_PROFILES,
    mel: fixture.mel,
  };
  const findings = [...fixtureProblems, ...candidate.findings, ...validateRelease(content)];
  return { content, findings, stats: candidate.stats };
}
