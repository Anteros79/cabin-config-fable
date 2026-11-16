import { buildKitIndex, type KitIndex } from "./kits.ts";
import type {
  Aircraft,
  AircraftSubtype,
  ApplicabilityRule,
  CabinLocation,
  ComponentDef,
  ContextConstraint,
  Layout,
  LayoutRevision,
  LocationSelector,
  MaintenanceVariant,
  Part,
  PendingChange,
  ReleaseContent,
  SourceArtifact,
  SubstituteApproval,
  TailAssignment,
} from "./types.ts";

/**
 * Rule specificity by logical implication.
 *
 * A rule's match set is the set of every (variant, layout revision, location, carpet, seam,
 * upholstery) situation it accepts. Rule A is more specific than rule B exactly when A's match
 * set is a strict subset of B's, i.e. "A applies" logically implies "B applies" but not the
 * reverse. Numeric priority, the number of selectors and insertion order play no part.
 *
 * Variant, subtype and hardware are not independent (a variant fixes its subtype and hardware),
 * so those constraints are first reduced to the set of feasible (variant, layout revision) pairs
 * taken from the release. Only usable pairs count (`isUsablePair`: a released variant and a layout
 * revision it lists that is neither planned nor candidate), so unreleased data can never change
 * which of two released rules is more specific (D2). Location selectors are expanded to exact
 * location ids per layout revision. Carpet, seam and upholstery are independent dimensions whose universe is the declared
 * vocabulary plus "unknown"; an unconstrained dimension accepts unknown, a constrained one does not.
 */
export interface MatchSet {
  /** key "variant|layoutRevision" -> accepted location ids in that revision */
  pairs: Map<string, Set<string>>;
  carpet: Set<string> | null;
  seam: Set<string> | null;
  upholstery: Set<string> | null;
  empty: boolean;
}

export interface AssignmentContext {
  variantId: string;
  layoutRevisionId: string;
  subtypeId: string;
  hardware: string | null;
  carpet: string | null;
  seam: string | null;
  upholstery: string | null;
}

export interface ReleaseIndex {
  release: ReleaseContent;
  sources: Map<string, SourceArtifact>;
  subtypes: Map<string, AircraftSubtype>;
  aircraft: Map<string, Aircraft>;
  variants: Map<string, MaintenanceVariant>;
  layouts: Map<string, Layout>;
  layoutRevisions: Map<string, LayoutRevision>;
  locations: Map<string, Map<string, CabinLocation>>;
  components: Map<string, ComponentDef>;
  parts: Map<string, Part>;
  assignmentsByTail: Map<string, TailAssignment[]>;
  /** Kit expansion, memoised per part; shared by lookup, kit-source checks and validation. */
  kits: KitIndex;
  pendingByRule: Map<string, PendingChange[]>;
  rulesByComponent: Map<string, ApplicabilityRule[]>;
  ruleMatch: Map<string, MatchSet>;
  substituteMatch: Map<string, MatchSet>;
  dominance: Map<string, boolean>;
}

/** Indexes of frozen releases only; see `buildIndex`. */
const indexCache = new WeakMap<ReleaseContent, ReleaseIndex>();

/**
 * A released variant paired with a layout revision that is neither planned nor candidate, whatever
 * the variant lists. This is the status half of `isUsablePair`; `lookup` uses it to tell a released
 * configuration from a planned one, so the two cannot drift.
 */
export function isReleasedPair(variant: MaintenanceVariant, revision: LayoutRevision): boolean {
  return variant.released && revision.status !== "planned" && revision.status !== "candidate";
}

/** A (variant, layout revision) pair that released data can resolve: released, and listed by the variant (D2). */
export function isUsablePair(variant: MaintenanceVariant, revision: LayoutRevision): boolean {
  return isReleasedPair(variant, revision) && variant.layoutRevisionIds.includes(revision.id);
}

function toMap<T>(items: T[], key: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(key(item), item);
  return map;
}

function group<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

export function selectLocations(selector: LocationSelector, revision: LayoutRevision): CabinLocation[] {
  return revision.locations.filter((loc) => locationMatches(selector, loc));
}

export function locationMatches(selector: LocationSelector, loc: CabinLocation): boolean {
  if (loc.kind !== selector.kind) return false;
  if (selector.ids && !selector.ids.includes(loc.id)) return false;
  if (selector.zones) {
    if (!loc.seat || loc.seat.maintenanceZone === null || !selector.zones.includes(loc.seat.maintenanceZone)) return false;
  }
  if (selector.letters) {
    if (!loc.seat || !selector.letters.includes(loc.seat.letter)) return false;
  }
  if (selector.sides) {
    const side = loc.seat?.side ?? loc.bin?.side;
    if (!side || !selector.sides.includes(side)) return false;
  }
  if (selector.rowFrom !== undefined || selector.rowTo !== undefined) {
    if (!loc.seat) return false;
    const row = Number(loc.seat.printedRow);
    if (!Number.isFinite(row)) return false;
    if (selector.rowFrom !== undefined && row < selector.rowFrom) return false;
    if (selector.rowTo !== undefined && row > selector.rowTo) return false;
  }
  if (selector.floorAreaTypes) {
    if (!loc.floor || !selector.floorAreaTypes.includes(loc.floor.areaType)) return false;
  }
  return true;
}

function variantSatisfies(constraint: ContextConstraint, variant: MaintenanceVariant, layoutRevisionId: string): boolean {
  if (constraint.variant && !constraint.variant.includes(variant.id)) return false;
  if (constraint.layoutRevision && !constraint.layoutRevision.includes(layoutRevisionId)) return false;
  if (constraint.subtype && !constraint.subtype.includes(variant.subtypeId)) return false;
  if (constraint.hardware && (variant.hardware === null || !constraint.hardware.includes(variant.hardware))) return false;
  return true;
}

/**
 * Layout revisions some variant lists and can pair with under this constraint (selectors and
 * components aside), released or not. For validating what a rule refers to, not for specificity.
 */
export function reachableRevisions(release: ReleaseContent, revisions: Map<string, LayoutRevision>, constraint: ContextConstraint): LayoutRevision[] {
  const reached = new Map<string, LayoutRevision>();
  for (const variant of release.variants) {
    for (const revisionId of variant.layoutRevisionIds) {
      const revision = revisions.get(revisionId);
      if (revision && variantSatisfies(constraint, variant, revisionId)) reached.set(revisionId, revision);
    }
  }
  return [...reached.values()];
}

/**
 * Which (variant, layout revision) pairs a match set draws on. "usable" (the default) is D2: only
 * pairs released data can resolve, for specificity, dominance and conflicts. "listed" is every pair
 * a variant lists, released or not, for checking that staged data refers to something real.
 */
export type PairScope = "usable" | "listed";

export function buildMatchSet(
  release: ReleaseContent,
  revisions: Map<string, LayoutRevision>,
  constraint: ContextConstraint,
  selector: LocationSelector | undefined,
  componentId: string,
  scope: PairScope = "usable",
): MatchSet {
  const pairs = new Map<string, Set<string>>();
  for (const variant of release.variants) {
    for (const revisionId of variant.layoutRevisionIds) {
      if (!variantSatisfies(constraint, variant, revisionId)) continue;
      const revision = revisions.get(revisionId);
      if (!revision || (scope === "usable" && !isUsablePair(variant, revision))) continue;
      const ids = new Set<string>();
      for (const loc of revision.locations) {
        if (!loc.componentIds.includes(componentId)) continue;
        if (selector && !locationMatches(selector, loc)) continue;
        ids.add(loc.id);
      }
      if (ids.size > 0) pairs.set(`${variant.id}|${revisionId}`, ids);
    }
  }
  const dim = (values: string[] | undefined) => (values ? new Set(values) : null);
  const carpet = dim(constraint.carpet);
  const seam = dim(constraint.seam);
  const upholstery = dim(constraint.upholstery);
  const empty =
    pairs.size === 0 || (carpet !== null && carpet.size === 0) || (seam !== null && seam.size === 0) || (upholstery !== null && upholstery.size === 0);
  return { pairs, carpet, seam, upholstery, empty };
}

function dimSubset(a: Set<string> | null, b: Set<string> | null): boolean {
  if (b === null) return true; // b accepts everything including unknown
  if (a === null) return false; // a accepts unknown, b does not
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** True when every situation accepted by a is also accepted by b. */
export function isSubset(a: MatchSet, b: MatchSet): boolean {
  if (a.empty) return true;
  if (b.empty) return false;
  if (!dimSubset(a.carpet, b.carpet) || !dimSubset(a.seam, b.seam) || !dimSubset(a.upholstery, b.upholstery)) return false;
  for (const [pair, ids] of a.pairs) {
    const other = b.pairs.get(pair);
    if (!other) return false;
    for (const id of ids) if (!other.has(id)) return false;
  }
  return true;
}

export function isStrictlyMoreSpecific(a: MatchSet, b: MatchSet): boolean {
  return isSubset(a, b) && !isSubset(b, a);
}

export function matchSetsEqual(a: MatchSet, b: MatchSet): boolean {
  return isSubset(a, b) && isSubset(b, a);
}

function dimIntersection(a: Set<string> | null, b: Set<string> | null): Set<string> | null {
  if (a === null) return b;
  if (b === null) return a;
  return new Set([...a].filter((value) => b.has(value)));
}

/** Every situation accepted by both a and b. */
export function intersectMatchSets(a: MatchSet, b: MatchSet): MatchSet {
  const pairs = new Map<string, Set<string>>();
  for (const [pair, ids] of a.pairs) {
    const other = b.pairs.get(pair);
    if (!other) continue;
    const shared = new Set([...ids].filter((id) => other.has(id)));
    if (shared.size > 0) pairs.set(pair, shared);
  }
  const carpet = dimIntersection(a.carpet, b.carpet);
  const seam = dimIntersection(a.seam, b.seam);
  const upholstery = dimIntersection(a.upholstery, b.upholstery);
  const empty =
    a.empty ||
    b.empty ||
    pairs.size === 0 ||
    (carpet !== null && carpet.size === 0) ||
    (seam !== null && seam.size === 0) ||
    (upholstery !== null && upholstery.size === 0);
  return { pairs, carpet, seam, upholstery, empty };
}

/** True when some situation is accepted by both a and b. */
export function matchSetsIntersect(a: MatchSet, b: MatchSet): boolean {
  return !intersectMatchSets(a, b).empty;
}

export function matchesContext(constraint: ContextConstraint, ctx: AssignmentContext): boolean {
  const ok = (allowed: string[] | undefined, value: string | null) => !allowed || (value !== null && allowed.includes(value));
  return (
    ok(constraint.variant, ctx.variantId) &&
    ok(constraint.layoutRevision, ctx.layoutRevisionId) &&
    ok(constraint.subtype, ctx.subtypeId) &&
    ok(constraint.hardware, ctx.hardware) &&
    ok(constraint.carpet, ctx.carpet) &&
    ok(constraint.seam, ctx.seam) &&
    ok(constraint.upholstery, ctx.upholstery)
  );
}

/**
 * A release whose index may be cached: the release object and its rule, variant and layout-revision
 * arrays are frozen. The reference store deep-freezes what it loads (Task 1.7), which passes; a
 * release frozen only at the top, with mutable arrays, does not. This samples the arrays the index
 * is built from rather than walking the whole tree, so it trusts a deep freeze, not a partial one.
 */
function isCacheable(release: ReleaseContent): boolean {
  return Object.isFrozen(release) && Object.isFrozen(release.rules) && Object.isFrozen(release.variants) && Object.isFrozen(release.layoutRevisions);
}

/**
 * Index a release. The index (match sets, dominance) is derived from the content, so it is cached
 * only when the content is frozen (`isCacheable`): content mutated after indexing would otherwise be
 * answered from a stale index (DOM-22). Anything else (staged content under validation, test
 * releases) is indexed afresh on every call.
 */
export function buildIndex(release: ReleaseContent): ReleaseIndex {
  const cached = indexCache.get(release);
  if (cached) return cached;
  const layoutRevisions = toMap(release.layoutRevisions, (r) => r.id);
  const locations = new Map<string, Map<string, CabinLocation>>();
  for (const revision of release.layoutRevisions) {
    locations.set(
      revision.id,
      toMap(revision.locations, (l) => l.id),
    );
  }
  const ruleMatch = new Map<string, MatchSet>();
  for (const rule of release.rules) {
    ruleMatch.set(rule.id, buildMatchSet(release, layoutRevisions, rule.constraint, rule.locations, rule.componentId));
  }
  const substituteMatch = new Map<string, MatchSet>();
  for (const sub of release.substitutes) {
    substituteMatch.set(sub.id, buildMatchSet(release, layoutRevisions, sub.constraint, sub.locations, sub.componentId));
  }
  const parts = toMap(release.parts, (p) => p.partNo);
  const index: ReleaseIndex = {
    release,
    sources: toMap(release.sources, (s) => s.id),
    subtypes: toMap(release.subtypes, (s) => s.id),
    aircraft: toMap(release.aircraft, (a) => a.tail),
    variants: toMap(release.variants, (v) => v.id),
    layouts: toMap(release.layouts, (l) => l.id),
    layoutRevisions,
    locations,
    components: toMap(release.components, (c) => c.id),
    parts,
    assignmentsByTail: group(release.assignments, (a) => a.tail),
    kits: buildKitIndex(release.kitChildren, parts),
    pendingByRule: group(release.pendingChanges, (p) => p.ruleId),
    rulesByComponent: group(release.rules, (r) => r.componentId),
    ruleMatch,
    substituteMatch,
    dominance: new Map(),
  };
  if (isCacheable(release)) indexCache.set(release, index);
  return index;
}

/** Is rule a strictly more specific than rule b? Cached per release. */
export function ruleDominates(index: ReleaseIndex, a: ApplicabilityRule, b: ApplicabilityRule): boolean {
  const key = `${a.id}\u0000${b.id}`;
  const cached = index.dominance.get(key);
  if (cached !== undefined) return cached;
  const result = isStrictlyMoreSpecific(index.ruleMatch.get(a.id)!, index.ruleMatch.get(b.id)!);
  index.dominance.set(key, result);
  return result;
}

/**
 * Rules that no other candidate is strictly more specific than.
 * Exactly one => it implies every other candidate and wins.
 * More than one => the survivors are equal or incomparable, which is ambiguous.
 */
export function undominated(index: ReleaseIndex, candidates: ApplicabilityRule[]): ApplicabilityRule[] {
  return candidates.filter((rule) => !candidates.some((other) => other !== rule && ruleDominates(index, other, rule)));
}

export function substituteCoversLocation(index: ReleaseIndex, sub: SubstituteApproval, ctx: AssignmentContext, locationId: string): boolean {
  const set = index.substituteMatch.get(sub.id);
  if (!set) return false;
  return set.pairs.get(`${ctx.variantId}|${ctx.layoutRevisionId}`)?.has(locationId) ?? false;
}
