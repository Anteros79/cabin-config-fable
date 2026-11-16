import { isIsoDate, withinInclusive } from "./dates.ts";
import { expandKit } from "./kits.ts";
import { compareCodePoints } from "./order.ts";
import { type AssignmentContext, buildIndex, matchesContext, type ReleaseIndex, undominated } from "./specificity.ts";
import type {
  ApplicabilityRule,
  ComponentResolution,
  ExcludedSubstitute,
  ExclusionReason,
  FrozenRule,
  FrozenSubstitute,
  IsoDate,
  LookupResult,
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

function sourceExclusions(source: SourceArtifact | undefined, date: IsoDate): ExclusionReason[] {
  if (!source) return [{ code: "SOURCE_MISSING", message: "The cited source is not in the reference release." }];
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
  return [...reasons, ...sourceExclusions(index.sources.get(rule.sourceId), date)];
}

export function substituteExclusions(index: ReleaseIndex, sub: SubstituteApproval, date: IsoDate): ExclusionReason[] {
  const reasons: ExclusionReason[] = [];
  if (!sub.released) reasons.push({ code: "NOT_RELEASED", message: `Substitute approval ${sub.id} is not released.` });
  if (date < sub.effectiveFrom) reasons.push({ code: "APPROVAL_NOT_YET_EFFECTIVE", message: `Approval ${sub.id} is effective from ${sub.effectiveFrom}.` });
  if (sub.effectiveTo !== null && date > sub.effectiveTo)
    reasons.push({ code: "APPROVAL_EXPIRED", message: `Approval ${sub.id} expired after ${sub.effectiveTo}.` });
  return [...reasons, ...sourceExclusions(index.sources.get(sub.sourceId), date)];
}

function base(tail: string, checkDate: string, releaseId: string | null) {
  return { tail, checkDate, referenceReleaseId: releaseId, demo: true as const };
}

function describe(a: TailAssignment, date: IsoDate) {
  return {
    id: a.id,
    variantId: a.variantId,
    layoutRevisionId: a.layoutRevisionId,
    status: a.status,
    effectiveFrom: a.effectiveFrom,
    effectiveTo: a.effectiveTo,
    coversDate: withinInclusive(date, a.effectiveFrom, a.effectiveTo),
  };
}

/**
 * Resolve the effective configuration and applicable parts for a tail on a date.
 * Never guesses: gaps, overlaps, planned layouts and invalid sources are reported as such.
 */
export function lookup(release: ReferenceRelease, rawTail: unknown, rawDate: unknown): LookupResult {
  const index = buildIndex(release);
  const tail = normalizeTail(rawTail);
  const checkDate = typeof rawDate === "string" ? rawDate.trim() : "";
  const common = base(tail, checkDate, release.id);

  if (!tail) return { ...common, state: "INVALID_INPUT", reasonCode: "TAIL_MISSING", message: "Enter a tail number." };
  if (!TAIL_PATTERN.test(tail)) {
    return { ...common, state: "INVALID_INPUT", reasonCode: "TAIL_INVALID", message: "Tail numbers use 2-10 letters, digits or hyphens." };
  }
  if (!checkDate) return { ...common, state: "INVALID_INPUT", reasonCode: "DATE_MISSING", message: "Enter the appearance-check date." };
  if (!isIsoDate(checkDate)) {
    return { ...common, state: "INVALID_INPUT", reasonCode: "DATE_INVALID", message: "The check date must be a real calendar date (YYYY-MM-DD)." };
  }

  const aircraft = index.aircraft.get(tail);
  if (!aircraft) {
    return { ...common, state: "UNKNOWN_TAIL", reasonCode: "TAIL_NOT_IN_REFERENCE", message: `Tail ${tail} is not in the reference data.` };
  }

  const all = [...(index.assignmentsByTail.get(tail) ?? [])].sort((a, b) => compareCodePoints(a.effectiveFrom, b.effectiveFrom));
  const considered = all.map((a) => describe(a, checkDate));
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
  const isReleased = (a: TailAssignment) =>
    a.status === "released" && index.variants.get(a.variantId)?.released === true && index.layoutRevisions.get(a.layoutRevisionId)?.status === "released";
  const released = covering.filter(isReleased);
  const planned = covering.filter((a) => !isReleased(a));

  if (released.length > 1) {
    return {
      ...common,
      aircraft,
      assignmentsConsidered: considered,
      state: "OVERLAP",
      reasonCode: "OVERLAPPING_ASSIGNMENTS",
      message: `Tail ${tail} has ${released.length} overlapping configurations on ${checkDate} (${released.map((a) => a.variantId).join(", ")}). None is selected; the reference data must be corrected.`,
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

  const variant = index.variants.get(assignment.variantId)!;
  const layoutRevision = index.layoutRevisions.get(assignment.layoutRevisionId)!;
  const layout = index.layouts.get(layoutRevision.layoutId);
  const subtype = index.subtypes.get(aircraft.subtypeId);
  const invalid = (reasonCode: string, message: string): LookupResult => ({
    ...common,
    aircraft,
    assignmentsConsidered: considered,
    state: "SOURCE_INVALID",
    reasonCode,
    message,
  });
  if (!layout || !subtype) return invalid("INCONSISTENT_CONFIGURATION", "The configuration refers to a layout or subtype missing from the reference data.");
  if (!variant.layoutRevisionIds.includes(layoutRevision.id)) {
    return invalid("INCONSISTENT_CONFIGURATION", `Layout revision ${layoutRevision.id} is not valid for variant ${variant.id}.`);
  }
  if (variant.subtypeId !== aircraft.subtypeId || layoutRevision.subtypeId !== aircraft.subtypeId) {
    return invalid("INCONSISTENT_CONFIGURATION", "Aircraft, variant and layout subtypes disagree.");
  }
  if (layoutRevision.seatSetStatus !== "complete") {
    return invalid("SEAT_SET_NOT_SUPPLIED", `Layout revision ${layoutRevision.id} has no complete seat set.`);
  }
  const configurationSource = index.sources.get(assignment.sourceId);
  const sourceProblems = sourceExclusions(configurationSource, checkDate);
  if (!configurationSource || sourceProblems.length > 0) {
    return invalid("CONFIGURATION_SOURCE_INVALID", `The configuration source is not valid on ${checkDate}: ${sourceProblems.map((r) => r.message).join(" ")}`);
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
  const inContext = new Map<string, { rule: ApplicabilityRule; locations: Set<string>; exclusions: ExclusionReason[] }[]>();
  for (const rule of index.release.rules) {
    if (!matchesContext(rule.constraint, ctx)) continue;
    const locations = index.ruleMatch.get(rule.id)?.pairs.get(pairKey);
    if (!locations) continue;
    const list = inContext.get(rule.componentId) ?? [];
    list.push({ rule, locations, exclusions: ruleExclusions(index, rule, date) });
    inContext.set(rule.componentId, list);
  }

  const rules: Record<string, FrozenRule> = {};
  const components: ComponentResolution[] = [];
  const counts = { resolved: 0, noMatch: 0, ambiguous: 0 };

  const freeze = (rule: ApplicabilityRule): FrozenRule => {
    const substitutes: FrozenSubstitute[] = [];
    const excludedSubstitutes: ExcludedSubstitute[] = [];
    for (const sub of index.release.substitutes) {
      if (sub.componentId !== rule.componentId || sub.primaryPartNo !== rule.partNo) continue;
      if (!matchesContext(sub.constraint, ctx)) continue;
      const covered = index.substituteMatch.get(sub.id)?.pairs.get(pairKey);
      if (!covered) continue;
      const exclusions = substituteExclusions(index, sub, date);
      if (exclusions.length > 0) {
        excludedSubstitutes.push({ id: sub.id, altPartNo: sub.altPartNo, reasons: exclusions });
        noteSource(sub.sourceId);
        continue;
      }
      const children = expandKit(sub.altPartNo, index.kitChildrenByParent, index.parts);
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
    const children = expandKit(rule.partNo, index.kitChildrenByParent, index.parts);
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
      const excluded = covering.filter((c) => c.exclusions.length > 0).map((c) => ({ ruleId: c.rule.id, partNo: c.rule.partNo, reasons: c.exclusions }));
      if (eligible.length === 0) {
        excluded.forEach((e) => {
          noteSource(index.release.rules.find((r) => r.id === e.ruleId)?.sourceId ?? null);
        });
        counts.noMatch += 1;
        components.push({
          locationId: location.id,
          componentId,
          status: "NO_MATCH",
          message:
            excluded.length > 0
              ? "A rule covers this component but is not valid on the check date."
              : "No released applicability rule matches this component in this configuration.",
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
