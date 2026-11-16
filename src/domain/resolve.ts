import { isIsoDate, withinInclusive } from "./dates.ts";
import { KitError } from "./kits.ts";
import { compareCodePoints } from "./order.ts";
import { type AssignmentContext, buildIndex, isIndexOf, isReleasedPair, matchesContext, type ReleaseIndex, substituteKey, undominated } from "./specificity.ts";
import type {
  Aircraft,
  ApplicabilityRule,
  ComponentResolution,
  ExcludedRule,
  ExcludedSubstitute,
  ExclusionReason,
  FrozenRule,
  FrozenSubstitute,
  IsoDate,
  LayoutRevision,
  LookupResult,
  MaintenanceVariant,
  ReferenceRelease,
  Resolution,
  ResolvedContext,
  SourceArtifact,
  SubstituteApproval,
  TailAssignment,
} from "./types.ts";

export const TAIL_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,9}$/;

export function normalizeTail(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

function sourceExclusions(sourceId: string, source: SourceArtifact | undefined, date: IsoDate): ExclusionReason[] {
  if (!source) return [{ code: "SOURCE_MISSING", message: `Source ${sourceId} is not in the reference release.` }];
  const reasons: ExclusionReason[] = [];
  if (!source.released) reasons.push({ code: "SOURCE_NOT_RELEASED", message: `Source ${source.id} rev ${source.revision} is not released.` });
  if (source.effectiveFrom !== null && date < source.effectiveFrom) {
    reasons.push({ code: "SOURCE_NOT_YET_EFFECTIVE", message: `Source ${source.id} rev ${source.revision} is effective from ${source.effectiveFrom}.` });
  }
  if (source.expiresOn !== null && date > source.expiresOn) {
    reasons.push({ code: "SOURCE_EXPIRED", message: `Source ${source.id} rev ${source.revision} expired after ${source.expiresOn}.` });
  }
  return reasons;
}

/** Why a rule cannot grant eligibility on this date. Empty = eligible. */
export function ruleExclusions(index: ReleaseIndex, rule: ApplicabilityRule, date: IsoDate): ExclusionReason[] {
  const reasons: ExclusionReason[] = [];
  if (!rule.released) reasons.push({ code: "NOT_RELEASED", message: `Rule ${rule.id} is not released; an unreleased change grants no eligibility.` });
  if (date < rule.effectiveFrom) reasons.push({ code: "RULE_NOT_YET_EFFECTIVE", message: `Rule ${rule.id} is effective from ${rule.effectiveFrom}.` });
  if (rule.effectiveTo !== null && date > rule.effectiveTo) reasons.push({ code: "RULE_EXPIRED", message: `Rule ${rule.id} ended after ${rule.effectiveTo}.` });
  return [...reasons, ...sourceExclusions(rule.sourceId, index.sources.get(rule.sourceId), date)];
}

export function substituteExclusions(index: ReleaseIndex, sub: SubstituteApproval, date: IsoDate): ExclusionReason[] {
  const reasons: ExclusionReason[] = [];
  if (!sub.released) reasons.push({ code: "NOT_RELEASED", message: `Substitute approval ${sub.id} is not released.` });
  if (date < sub.effectiveFrom) reasons.push({ code: "APPROVAL_NOT_YET_EFFECTIVE", message: `Approval ${sub.id} is effective from ${sub.effectiveFrom}.` });
  if (sub.effectiveTo !== null && date > sub.effectiveTo)
    reasons.push({ code: "APPROVAL_EXPIRED", message: `Approval ${sub.id} expired after ${sub.effectiveTo}.` });
  return [...reasons, ...sourceExclusions(sub.sourceId, index.sources.get(sub.sourceId), date)];
}

/**
 * Why the mandatory kit below `partNo` cannot be used on this date: one `KIT_SOURCE_INVALID` reason per
 * kit line, at any depth, whose source fails the source check, and the ids of those sources. The lines
 * come from the release's `KitIndex`, the same lines kit expansion uses; each is visited once, so
 * shared sub-kits are not repeated and a cyclic definition cannot loop.
 */
export function kitSourceExclusions(index: ReleaseIndex, partNo: string, date: IsoDate): { reasons: ExclusionReason[]; sourceIds: string[] } {
  const reasons: ExclusionReason[] = [];
  const sourceIds: string[] = [];
  for (const line of index.kits.descendantLines(partNo)) {
    const problems = sourceExclusions(line.sourceId, index.sources.get(line.sourceId), date);
    if (problems.length === 0) continue;
    reasons.push({
      code: "KIT_SOURCE_INVALID",
      message: `Kit child ${line.childPartNo} of ${line.parentPartNo} cites source ${line.sourceId}, which is not valid on ${date}: ${problems.map((p) => p.message).join(" ")}`,
      sourceId: line.sourceId,
    });
    if (!sourceIds.includes(line.sourceId)) sourceIds.push(line.sourceId);
  }
  return { reasons, sourceIds };
}

/**
 * Everything wrong with the kit below `partNo` on this date: its kit-source reasons, then `KIT_INVALID`
 * when the kit cannot be expanded (cyclic, too deep, quantities too large). Expansion is memoised in
 * the index, so freezing the part later reuses this result and cannot throw.
 */
function kitExclusions(index: ReleaseIndex, partNo: string, date: IsoDate): { reasons: ExclusionReason[]; sourceIds: string[] } {
  const kit = kitSourceExclusions(index, partNo, date);
  try {
    index.kits.expand(partNo, 1);
  } catch (e) {
    if (!(e instanceof KitError)) throw e;
    kit.reasons.push({ code: "KIT_INVALID", message: `The mandatory kit below ${partNo} cannot be expanded: ${e.message}` });
  }
  return kit;
}

function base(tail: string, checkDate: string, releaseId: string | null) {
  return { tail, checkDate, referenceReleaseId: releaseId, demo: true as const };
}

/** References an assignment makes that are missing from the release; empty when both exist. */
function missingReferences(a: TailAssignment, variant: MaintenanceVariant | undefined, revision: LayoutRevision | undefined): string[] {
  const missing: string[] = [];
  if (!variant) missing.push(`Variant ${a.variantId} is not in the reference data.`);
  if (!revision) missing.push(`Layout revision ${a.layoutRevisionId} is not in the reference data.`);
  return missing;
}

/**
 * How lookup treats an assignment (DOM-21). A released assignment is treated as released when its
 * variant and layout revision are released data, and also when either is missing: that is an
 * inconsistent configuration, never a planned one. `reason` says why the treatment differs from the
 * stated status, or what is missing; null when there is nothing to explain.
 */
function treatment(a: TailAssignment, variant: MaintenanceVariant | undefined, revision: LayoutRevision | undefined) {
  const missing = missingReferences(a, variant, revision);
  if (a.status !== "released") return { effectiveStatus: "planned" as const, reason: missing.length > 0 ? missing.join(" ") : null };
  if (missing.length > 0) return { effectiveStatus: "released" as const, reason: missing.join(" ") };
  if (isReleasedConfiguration(a, variant, revision)) return { effectiveStatus: "released" as const, reason: null };
  const why: string[] = [];
  if (variant && !variant.released) why.push(`Variant ${variant.id} is not released.`);
  if (revision && (revision.status === "planned" || revision.status === "candidate")) why.push(`Layout revision ${revision.id} is ${revision.status}.`);
  return { effectiveStatus: "planned" as const, reason: `Treated as planned: ${why.join(" ")}` };
}

/**
 * Why an (aircraft, variant, layout revision) triple cannot be a configuration. Empty = consistent.
 * Shared by lookup (which refuses the configuration) and release validation (which reports it).
 */
export function configurationProblems(aircraft: Aircraft, variant: MaintenanceVariant, revision: LayoutRevision): string[] {
  const problems: string[] = [];
  if (!variant.layoutRevisionIds.includes(revision.id)) problems.push(`Layout revision ${revision.id} is not valid for variant ${variant.id}.`);
  if (variant.subtypeId !== aircraft.subtypeId || revision.subtypeId !== aircraft.subtypeId) {
    problems.push(
      `Aircraft, variant and layout subtypes disagree (aircraft ${aircraft.tail} ${aircraft.subtypeId}, variant ${variant.id} ${variant.subtypeId}, layout revision ${revision.id} ${revision.subtypeId}).`,
    );
  }
  if (revision.seatSetStatus !== "complete") problems.push(`Layout revision ${revision.id} has no complete seat set.`);
  return problems;
}

/**
 * Is this assignment a released configuration (as opposed to a planned one)? A released assignment
 * of a released variant and a layout revision that is neither planned nor candidate. Whether the
 * variant lists the revision is not part of it: a released assignment pairing them wrongly is an
 * inconsistent configuration (`configurationProblems`), not a planned one. Shared by lookup and by
 * release validation (`ASSIGNMENT_INCONSISTENT`).
 */
export function isReleasedConfiguration(assignment: TailAssignment, variant: MaintenanceVariant | undefined, revision: LayoutRevision | undefined): boolean {
  return assignment.status === "released" && variant !== undefined && revision !== undefined && isReleasedPair(variant, revision);
}

/**
 * Resolve the effective configuration and applicable parts for a tail on a date.
 * Never guesses: gaps, overlaps, planned layouts and invalid sources are reported as such.
 * `shared` is an index of this release already built (for instance by `validateRelease`); without it
 * the index is built here, or taken from the cache when the release is frozen. An index of another
 * release is refused.
 */
export function lookup(release: ReferenceRelease, rawTail: unknown, rawDate: unknown, shared?: ReleaseIndex): LookupResult {
  if (shared && !isIndexOf(shared, release)) throw new Error("lookup was given the index of a different release.");
  const tail = normalizeTail(rawTail);
  const checkDate = typeof rawDate === "string" ? rawDate.trim() : "";
  const common = base(tail, checkDate, release.id);
  // Absent or blank is a missing date; any other non-string (a number, a Date, an array) is an invalid one (DOM-21).
  const dateMissing = rawDate === undefined || rawDate === null || (typeof rawDate === "string" && checkDate === "");

  if (!tail) return { ...common, state: "INVALID_INPUT", reasonCode: "TAIL_MISSING", message: "Enter a tail number." };
  if (!TAIL_PATTERN.test(tail)) {
    return { ...common, state: "INVALID_INPUT", reasonCode: "TAIL_INVALID", message: "Tail numbers use 2-10 letters, digits or hyphens." };
  }
  if (dateMissing) return { ...common, state: "INVALID_INPUT", reasonCode: "DATE_MISSING", message: "Enter the appearance-check date." };
  if (!isIsoDate(checkDate)) {
    return { ...common, state: "INVALID_INPUT", reasonCode: "DATE_INVALID", message: "The check date must be a real calendar date (YYYY-MM-DD)." };
  }

  const index = shared ?? buildIndex(release);
  const aircraft = index.aircraft.get(tail);
  if (!aircraft) {
    return { ...common, state: "UNKNOWN_TAIL", reasonCode: "TAIL_NOT_IN_REFERENCE", message: `Tail ${tail} is not in the reference data.` };
  }

  const all = [...(index.assignmentsByTail.get(tail) ?? [])].sort((a, b) => compareCodePoints(a.effectiveFrom, b.effectiveFrom));
  const treated = new Map(all.map((a) => [a, treatment(a, index.variants.get(a.variantId), index.layoutRevisions.get(a.layoutRevisionId))] as const));
  const considered = all.map((a) => {
    const { effectiveStatus, reason } = treated.get(a)!;
    return {
      id: a.id,
      variantId: a.variantId,
      layoutRevisionId: a.layoutRevisionId,
      status: a.status,
      effectiveStatus,
      reason,
      effectiveFrom: a.effectiveFrom,
      effectiveTo: a.effectiveTo,
      coversDate: withinInclusive(checkDate, a.effectiveFrom, a.effectiveTo),
    };
  });
  if (all.length === 0) {
    return {
      ...common,
      aircraft,
      assignmentsConsidered: considered,
      state: "UNCONFIGURED",
      reasonCode: "NO_ASSIGNMENTS",
      message: `Tail ${tail} is known but has no cabin configuration assigned.`,
    };
  }

  const covering = all.filter((a) => withinInclusive(checkDate, a.effectiveFrom, a.effectiveTo));
  // isReleasedPair, not isUsablePair: an unlisted pair must stay INCONSISTENT_CONFIGURATION, not become PLANNED;
  // a missing variant or layout revision likewise (DOM-21)
  const isReleased = (a: TailAssignment) => treated.get(a)?.effectiveStatus === "released";
  const released = covering.filter(isReleased);
  const planned = covering.filter((a) => !isReleased(a));

  if (released.length > 1) {
    return {
      ...common,
      aircraft,
      assignmentsConsidered: considered,
      state: "OVERLAP",
      reasonCode: "OVERLAPPING_ASSIGNMENTS",
      message: `Tail ${tail} has ${released.length} overlapping configurations on ${checkDate} (${released.map((a) => `${a.id}: ${a.variantId}`).join(", ")}). None is selected; the reference data must be corrected.`,
    };
  }
  const [assignment] = released;
  if (assignment === undefined) {
    if (planned.length > 0) {
      return {
        ...common,
        aircraft,
        assignmentsConsidered: considered,
        state: "PLANNED",
        reasonCode: "PLANNED_ONLY",
        message: `Tail ${tail} has only a planned configuration (${planned.map((a) => a.variantId).join(", ")}) on ${checkDate}. Planned layouts are not released data.`,
      };
    }
    return {
      ...common,
      aircraft,
      assignmentsConsidered: considered,
      state: "UNCONFIGURED",
      reasonCode: "DATE_GAP",
      message: `Tail ${tail} has no configuration effective on ${checkDate}. Start and end dates are inclusive.`,
    };
  }

  const invalid = (reasonCode: string, message: string): LookupResult => ({
    ...common,
    aircraft,
    assignmentsConsidered: considered,
    state: "SOURCE_INVALID",
    reasonCode,
    message,
  });
  const variant = index.variants.get(assignment.variantId);
  const layoutRevision = index.layoutRevisions.get(assignment.layoutRevisionId);
  if (!variant || !layoutRevision) {
    return invalid(
      "INCONSISTENT_CONFIGURATION",
      `Assignment ${assignment.id} refers to data missing from the reference release. ${missingReferences(assignment, variant, layoutRevision).join(" ")}`,
    );
  }
  const layout = index.layouts.get(layoutRevision.layoutId);
  const subtype = index.subtypes.get(aircraft.subtypeId);
  if (!layout || !subtype) return invalid("INCONSISTENT_CONFIGURATION", "The configuration refers to a layout or subtype missing from the reference data.");
  const problems = configurationProblems(aircraft, variant, layoutRevision);
  if (problems.length > 0) {
    // an incomplete seat set alone is its own reason; any other problem makes the configuration inconsistent
    const seatSetOnly = problems.length === 1 && layoutRevision.seatSetStatus !== "complete";
    return invalid(seatSetOnly ? "SEAT_SET_NOT_SUPPLIED" : "INCONSISTENT_CONFIGURATION", problems.join(" "));
  }
  const configurationSource = index.sources.get(assignment.sourceId);
  const sourceProblems = sourceExclusions(assignment.sourceId, configurationSource, checkDate);
  if (!configurationSource || sourceProblems.length > 0) {
    return invalid("CONFIGURATION_SOURCE_INVALID", `The configuration source is not valid on ${checkDate}: ${sourceProblems.map((r) => r.message).join(" ")}`);
  }
  // The variant and the layout revision are released data too: their sources must be valid on the date (D3).
  const cited: [string, string, string][] = [
    ["VARIANT_SOURCE_INVALID", `Variant ${variant.id}`, variant.sourceId],
    ["LAYOUT_SOURCE_INVALID", `Layout revision ${layoutRevision.id}`, layoutRevision.sourceId],
  ];
  for (const [reasonCode, owner, sourceId] of cited) {
    const problems = sourceExclusions(sourceId, index.sources.get(sourceId), checkDate);
    if (problems.length > 0) {
      return invalid(reasonCode, `${owner} cites source ${sourceId}, which is not valid on ${checkDate}: ${problems.map((r) => r.message).join(" ")}`);
    }
  }

  const context: ResolvedContext = {
    aircraft,
    subtype,
    assignment,
    variant,
    layout,
    layoutRevision,
    configurationSource,
    plannedAdvisories: planned,
  };
  const resolution = resolveComponents(index, context, checkDate);
  const gaps = resolution.counts.noMatch + resolution.counts.ambiguous;
  const state = gaps === 0 ? "RESOLVED" : "PARTIAL";
  return {
    ...common,
    aircraft,
    assignmentsConsidered: considered,
    context,
    resolution,
    state,
    reasonCode: state === "RESOLVED" ? "ALL_COMPONENTS_RESOLVED" : "UNRESOLVED_COMPONENTS",
    message:
      state === "RESOLVED"
        ? `Configuration ${variant.id} resolved; all ${resolution.counts.resolved} components have an applicable primary part.`
        : `Configuration ${variant.id} resolved; ${resolution.counts.resolved} components have a primary part, ${gaps} remain unresolved and cannot be recorded.`,
  };
}

export function contextOf(context: ResolvedContext): AssignmentContext {
  return {
    variantId: context.variant.id,
    layoutRevisionId: context.layoutRevision.id,
    subtypeId: context.variant.subtypeId,
    hardware: context.variant.hardware,
    carpet: context.assignment.carpet,
    seam: context.assignment.seam,
    upholstery: context.assignment.upholstery,
  };
}

const KIT_CODES: ReadonlySet<ExclusionReason["code"]> = new Set(["KIT_INVALID", "KIT_SOURCE_INVALID"]);
const KIT_REASON_TEXT: Partial<Record<ExclusionReason["code"], string>> = {
  KIT_INVALID: "the kit cannot be expanded",
  KIT_SOURCE_INVALID: "a kit child cites a source that is not valid on the check date",
};

/**
 * The NO_MATCH message. When every rule was excluded only for its mandatory kit, the rule is valid on
 * the date and the message says so, naming what is wrong with the kit.
 */
function noMatchMessage(excluded: ExcludedRule[]): string {
  if (excluded.length === 0) return "No released applicability rule matches this component in this configuration.";
  const reasons = excluded.flatMap((e) => e.reasons);
  if (reasons.every((r) => KIT_CODES.has(r.code))) {
    const named = [...new Set(reasons.map((r) => KIT_REASON_TEXT[r.code] ?? r.code))].join("; ");
    return `A rule covers this component but the kit data of its part is unusable: ${named}.`;
  }
  return "A rule covers this component but is not valid on the check date.";
}

export function resolveComponents(index: ReleaseIndex, context: ResolvedContext, date: IsoDate): Resolution {
  const ctx = contextOf(context);
  const pairKey = `${ctx.variantId}|${ctx.layoutRevisionId}`;
  const sources: Record<string, SourceArtifact> = { [context.configurationSource.id]: context.configurationSource };
  const noteSource = (id: string | null) => {
    if (id === null) return;
    const s = index.sources.get(id);
    if (s) sources[s.id] = s;
  };

  // Rules whose context constraints accept this assignment, with their eligibility on the date.
  // A rule is also excluded when a kit child of its primary part cites an invalid source (D3) or the
  // kit cannot be expanded (DOM-08); those reasons are always listed, beside any other.
  // Each component's rules are kept in id order, so every list built from them (exclusions, candidates,
  // dominated rules) is the same whatever the order of the release's rules.
  const inContext = new Map<string, { rule: ApplicabilityRule; locations: Set<string>; exclusions: ExclusionReason[]; kitSourceIds: string[] }[]>();
  for (const rule of index.release.rules) {
    if (!matchesContext(rule.constraint, ctx)) continue;
    const locations = index.ruleMatch.get(rule.id)?.pairs.get(pairKey);
    if (!locations) continue;
    const kit = kitExclusions(index, rule.partNo, date);
    const entry = { rule, locations, exclusions: [...ruleExclusions(index, rule, date), ...kit.reasons], kitSourceIds: kit.sourceIds };
    const list = inContext.get(rule.componentId);
    if (list) list.push(entry);
    else inContext.set(rule.componentId, [entry]);
  }
  for (const list of inContext.values()) list.sort((a, b) => compareCodePoints(a.rule.id, b.rule.id));

  const rules: Record<string, FrozenRule> = {};
  const components: ComponentResolution[] = [];
  const counts = { resolved: 0, noMatch: 0, ambiguous: 0 };

  const freeze = (rule: ApplicabilityRule): FrozenRule => {
    const ruleLocations = index.ruleMatch.get(rule.id)?.pairs.get(pairKey) ?? new Set<string>();
    const substitutes: FrozenSubstitute[] = [];
    const excludedSubstitutes: ExcludedSubstitute[] = [];
    // the approvals for this component and part, in id order
    for (const sub of index.substitutesByKey.get(substituteKey(rule.componentId, rule.partNo)) ?? []) {
      if (sub.componentId !== rule.componentId || sub.primaryPartNo !== rule.partNo) continue; // the key alone can collide
      if (!matchesContext(sub.constraint, ctx)) continue;
      const covered = index.substituteMatch.get(sub.id)?.pairs.get(pairKey);
      // only where the substitute can stand in for this rule: at least one location both cover (DOM-17)
      if (!covered || ![...covered].some((id) => ruleLocations.has(id))) continue;
      const kit = kitExclusions(index, sub.altPartNo, date);
      const exclusions = [...substituteExclusions(index, sub, date), ...kit.reasons];
      if (exclusions.length > 0) {
        excludedSubstitutes.push({ id: sub.id, altPartNo: sub.altPartNo, reasons: exclusions });
        noteSource(sub.sourceId);
        for (const id of kit.sourceIds) noteSource(id);
        continue;
      }
      const children = index.kits.expand(sub.altPartNo, 1);
      children.forEach((c) => {
        noteSource(c.sourceId);
      });
      noteSource(sub.sourceId);
      substitutes.push({
        id: sub.id,
        altPartNo: sub.altPartNo,
        altDescription: index.parts.get(sub.altPartNo)?.description ?? "",
        qtyPerReplacement: sub.qtyPerReplacement,
        unit: sub.unit,
        effectiveFrom: sub.effectiveFrom,
        effectiveTo: sub.effectiveTo,
        sourceId: sub.sourceId,
        children,
        locationIds: sub.locations ? [...covered].sort() : null,
        note: sub.note,
      });
    }
    const pendingChanges = index.pendingByRule.get(rule.id) ?? [];
    pendingChanges.forEach((p) => {
      noteSource(p.sourceId);
    });
    const children = index.kits.expand(rule.partNo, 1); // cannot throw: a rule with a broken kit is excluded above
    children.forEach((c) => {
      noteSource(c.sourceId);
    });
    noteSource(rule.sourceId);
    return {
      id: rule.id,
      componentId: rule.componentId,
      partNo: rule.partNo,
      partDescription: index.parts.get(rule.partNo)?.description ?? "",
      qtyPerReplacement: rule.qtyPerReplacement,
      unit: rule.unit,
      effectiveFrom: rule.effectiveFrom,
      effectiveTo: rule.effectiveTo,
      sourceId: rule.sourceId,
      constraint: rule.constraint,
      locations: rule.locations,
      pendingChanges,
      substitutes,
      excludedSubstitutes,
      children,
      note: rule.note,
    };
  };

  for (const location of context.layoutRevision.locations) {
    for (const componentId of location.componentIds) {
      const covering = (inContext.get(componentId) ?? []).filter((c) => c.locations.has(location.id));
      const eligible = covering.filter((c) => c.exclusions.length === 0).map((c) => c.rule);
      // Every exclusion is kept, whatever the outcome, with the source it cites (DOM-01).
      const excludedEntries = covering.filter((c) => c.exclusions.length > 0);
      const excluded: ExcludedRule[] = excludedEntries.map((c) => ({
        ruleId: c.rule.id,
        partNo: c.rule.partNo,
        sourceId: c.rule.sourceId,
        reasons: c.exclusions,
      }));
      for (const c of excludedEntries) {
        noteSource(c.rule.sourceId);
        for (const id of c.kitSourceIds) noteSource(id);
      }
      if (eligible.length === 0) {
        counts.noMatch += 1;
        components.push({
          locationId: location.id,
          componentId,
          status: "NO_MATCH",
          message: noMatchMessage(excluded),
          excluded,
        });
        continue;
      }
      const winners = undominated(index, eligible);
      const winner = winners.length === 1 ? winners[0] : undefined;
      if (winner === undefined) {
        winners.forEach((r) => {
          noteSource(r.sourceId);
        });
        counts.ambiguous += 1;
        components.push({
          locationId: location.id,
          componentId,
          status: "AMBIGUOUS",
          message: `${winners.length} equally specific or incomparable rules apply; no part is selected.`,
          candidates: winners.map((r) => ({ ruleId: r.id, partNo: r.partNo, sourceId: r.sourceId })),
          excluded,
        });
        continue;
      }
      if (!rules[winner.id]) rules[winner.id] = freeze(winner);
      counts.resolved += 1;
      components.push({
        locationId: location.id,
        componentId,
        status: "RESOLVED",
        ruleId: winner.id,
        dominatedRuleIds: eligible.filter((r) => r !== winner).map((r) => r.id),
        excluded,
      });
    }
  }

  const componentDefs: Resolution["componentDefs"] = {};
  for (const location of context.layoutRevision.locations) {
    for (const id of location.componentIds) {
      const def = index.components.get(id);
      if (def) componentDefs[id] = def;
    }
  }
  return { rules, components, counts, sources, componentDefs };
}
