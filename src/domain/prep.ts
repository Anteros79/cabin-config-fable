import { compareCodePoints } from "./order.ts";
import { buildGaps, excludedOf } from "./report.ts";
import { summarizeLocations } from "./summarize.ts";
import type { CabinLocation, ExcludedRule, ExcludedSubstitute, PendingChange, ReportGap, SourceArtifact, VisitSnapshot } from "./types.ts";

/** A rule not used where this part applies, with the locations where it was passed over. */
export interface PrepExcludedRule extends ExcludedRule {
  locationIds: string[];
  locationSummary: string;
}

export interface PrepAlternate {
  substituteId: string;
  altPartNo: string;
  altDescription: string;
  qtyPerReplacement: number;
  unit: string;
  approvalSource: SourceArtifact | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** Required supplements per one replacement using this alternate. */
  requiredSupplements: { partNo: string; description: string; qty: number; unit: string; sourceId: string }[];
  locationCount: number;
}

export interface PrepLine {
  ruleId: string;
  partNo: string;
  description: string;
  componentId: string;
  componentName: string;
  locationKind: string;
  qtyPerReplacement: number;
  unit: string;
  /** Locations where this part would apply if that component needed replacing. Not work done. */
  coverageLocationIds: string[];
  coverageCount: number;
  coverageSummary: string;
  source: SourceArtifact | null;
  ruleEffectiveFrom: string;
  ruleEffectiveTo: string | null;
  pendingChanges: PendingChange[];
  requiredSupplements: { partNo: string; description: string; qty: number; unit: string; sourceId: string }[];
  alternates: PrepAlternate[];
  excludedAlternates: ExcludedSubstitute[];
  /** Rules that covered some of these locations but were not used (expired, unreleased, invalid source). */
  excludedRules: PrepExcludedRule[];
}

export interface PrepOverview {
  schema: "cabin-kit.preparation/1";
  tail: string;
  checkDate: string;
  variantId: string;
  layoutRevisionId: string;
  referenceReleaseId: string;
  note: string;
  lines: PrepLine[];
  gaps: ReportGap[];
  /** `parts` is the number of distinct primary part numbers; one part may appear on several lines (DOM-21). */
  counts: { parts: number; resolvedComponents: number; unresolvedComponents: number; alternates: number; pendingChanges: number };
}

/**
 * Pre-work overview: which parts could be needed for this configuration, where, and with what
 * alternates and supplements. Coverage is potential applicability, never replacements made.
 */
export function buildPreparation(snapshot: VisitSnapshot): PrepOverview {
  const { context, resolution } = snapshot;
  const byId = new Map<string, CabinLocation>(context.layoutRevision.locations.map((l) => [l.id, l]));
  const coverage = new Map<string, string[]>();
  /** per winning rule: excluded rule id -> the exclusion and where it was passed over */
  const passedOver = new Map<string, Map<string, { excluded: ExcludedRule; locationIds: string[] }>>();
  for (const c of resolution.components) {
    if (c.status !== "RESOLVED") continue;
    coverage.set(c.ruleId, [...(coverage.get(c.ruleId) ?? []), c.locationId]);
    for (const e of excludedOf(c)) {
      const byRule = passedOver.get(c.ruleId) ?? new Map<string, { excluded: ExcludedRule; locationIds: string[] }>();
      const entry = byRule.get(e.ruleId) ?? { excluded: e, locationIds: [] };
      entry.locationIds.push(c.locationId);
      byRule.set(e.ruleId, entry);
      passedOver.set(c.ruleId, byRule);
    }
  }
  const lines: PrepLine[] = [];
  for (const [ruleId, locationIds] of coverage) {
    const rule = resolution.rules[ruleId];
    if (!rule) continue;
    const def = resolution.componentDefs[rule.componentId];
    const locations = locationIds.map((id) => byId.get(id)!).filter(Boolean);
    lines.push({
      ruleId,
      partNo: rule.partNo,
      description: rule.partDescription,
      componentId: rule.componentId,
      componentName: def?.name ?? rule.componentId,
      locationKind: def?.locationKind ?? locations[0]?.kind ?? "",
      qtyPerReplacement: rule.qtyPerReplacement,
      unit: rule.unit,
      coverageLocationIds: locationIds,
      coverageCount: locationIds.length,
      coverageSummary: summarizeLocations(locations),
      source: resolution.sources[rule.sourceId] ?? null,
      ruleEffectiveFrom: rule.effectiveFrom,
      ruleEffectiveTo: rule.effectiveTo,
      pendingChanges: rule.pendingChanges,
      requiredSupplements: rule.children,
      alternates: rule.substitutes.map((s) => ({
        substituteId: s.id,
        altPartNo: s.altPartNo,
        altDescription: s.altDescription,
        qtyPerReplacement: s.qtyPerReplacement,
        unit: s.unit,
        approvalSource: resolution.sources[s.sourceId] ?? null,
        effectiveFrom: s.effectiveFrom,
        effectiveTo: s.effectiveTo,
        requiredSupplements: s.children,
        locationCount: s.locationIds === null ? locationIds.length : locationIds.filter((id) => s.locationIds!.includes(id)).length,
      })),
      excludedAlternates: rule.excludedSubstitutes,
      excludedRules: [...(passedOver.get(ruleId)?.values() ?? [])]
        .map(({ excluded, locationIds: where }) => ({
          ...excluded,
          locationIds: where,
          locationSummary: summarizeLocations(where.flatMap((id) => byId.get(id) ?? [])),
        }))
        .sort((a, b) => compareCodePoints(a.ruleId, b.ruleId)),
    });
  }
  const kindOrder: Record<string, number> = { SEAT: 0, FLOOR: 1, BIN: 2 };
  lines.sort(
    (a, b) =>
      (kindOrder[a.locationKind] ?? 9) - (kindOrder[b.locationKind] ?? 9) ||
      compareCodePoints(a.componentId, b.componentId) ||
      compareCodePoints(a.partNo, b.partNo),
  );
  const gaps = buildGaps(snapshot);
  return {
    schema: "cabin-kit.preparation/1",
    tail: snapshot.tail,
    checkDate: snapshot.checkDate,
    variantId: context.variant.id,
    layoutRevisionId: context.layoutRevision.id,
    referenceReleaseId: snapshot.referenceReleaseId,
    note: "Applicable-parts overview for preparation. Coverage counts are locations where a part would apply if that component needed replacing; they are not replacements made and not a quantity to order.",
    lines,
    gaps,
    counts: {
      parts: new Set(lines.map((l) => l.partNo)).size,
      resolvedComponents: resolution.counts.resolved,
      unresolvedComponents: resolution.counts.noMatch + resolution.counts.ambiguous,
      alternates: lines.reduce((n, l) => n + l.alternates.length, 0),
      pendingChanges: lines.reduce((n, l) => n + l.pendingChanges.length, 0),
    },
  };
}
