import { compareCodePoints } from "./order.ts";
import { summarizeLocations } from "./summarize.ts";
import type {
  CabinLocation,
  ComponentResolution,
  ExcludedRule,
  Report,
  ReportGap,
  ReportTotalLine,
  ReportWorkItem,
  SourceArtifact,
  Visit,
  VisitSnapshot,
} from "./types.ts";
import { AUTHORITY_NOTICE, DATE_RULE, REPLACEMENT_COUNT_SEMANTICS, REPORT_SCHEMA } from "./types.ts";
import { DomainError } from "./visitLogic.ts";

const KIND_ORDER: Readonly<Record<string, number>> = { SEAT: 0, FLOOR: 1, BIN: 2 };

function inconsistent(message: string): DomainError {
  return new DomainError("SNAPSHOT_INCONSISTENT", `The visit snapshot is inconsistent: ${message}`, 500);
}

/**
 * Physical order of the snapshot's locations (DOM-20): seats by physical row then letter, then the
 * floor areas by first row, then the bins by module; ties by id. An unknown location kind is refused.
 */
function locationOrder(snapshot: VisitSnapshot): Map<string, number> {
  const key = (l: CabinLocation): [number, number, string] => {
    const kind = KIND_ORDER[l.kind];
    if (kind === undefined) throw inconsistent(`location ${l.id} has unknown kind ${JSON.stringify(l.kind)}.`);
    if (l.kind === "SEAT") return [kind, l.seat?.physicalRow ?? 0, l.seat?.letter ?? ""];
    return [kind, l.floor?.rowFrom ?? l.bin?.module ?? 0, ""];
  };
  const keyed = snapshot.context.layoutRevision.locations.map((l) => ({ l, k: key(l) }));
  keyed.sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || compareCodePoints(a.k[2], b.k[2]) || compareCodePoints(a.l.id, b.l.id));
  const order = new Map<string, number>();
  keyed.forEach(({ l }, i) => {
    order.set(l.id, i);
  });
  return order;
}

/** Position of a location in `order`; a location absent from the snapshot is refused. */
function positionOf(order: Map<string, number>, locationId: string, what: string): number {
  const position = order.get(locationId);
  if (position === undefined) throw inconsistent(`${what} refers to location ${locationId}, which is not in the frozen layout.`);
  return position;
}

/** The exclusions kept on a component. A snapshot frozen before report schema 2 may lack them: that reads as none. */
export function excludedOf(c: ComponentResolution): ExcludedRule[] {
  return c.excluded ?? [];
}

/** "Rules not used: <ruleId> (<partNo>): <reasons>", or null when nothing was excluded. */
export function rulesNotUsedLine(excluded: readonly ExcludedRule[] | undefined): string | null {
  if (!excluded || excluded.length === 0) return null;
  return `Rules not used: ${excluded.map((e) => `${e.ruleId} (${e.partNo}): ${e.reasons.map((r) => r.message).join(" ")}`).join("; ")}`;
}

/**
 * Sources an excluded rule cites: its own (when the snapshot recorded it) and, for a `KIT_SOURCE_INVALID`
 * reason, the kit child's source that made it unusable (DOM-16).
 */
function excludedSourceIds(e: ExcludedRule): string[] {
  const ids = e.sourceId ? [e.sourceId] : [];
  for (const r of e.reasons) if (r.sourceId) ids.push(r.sourceId);
  return ids;
}

/** Sources a gap cites: its ambiguous candidates' and its excluded rules'. */
function gapSourceIds(c: Exclude<ComponentResolution, { status: "RESOLVED" }>): string[] {
  const ids = excludedOf(c).flatMap(excludedSourceIds);
  if (c.status === "AMBIGUOUS") ids.push(...c.candidates.map((x) => x.sourceId));
  return ids;
}

export function buildGaps(snapshot: VisitSnapshot): ReportGap[] {
  const byId = new Map<string, CabinLocation>(snapshot.context.layoutRevision.locations.map((l) => [l.id, l]));
  const order = locationOrder(snapshot);
  const groups = new Map<string, { gap: ReportGap; sourceIds: Set<string> }>();
  for (const c of snapshot.resolution.components) {
    if (c.status === "RESOLVED") continue;
    const detail =
      c.status === "NO_MATCH"
        ? [...new Set(excludedOf(c).flatMap((e) => e.reasons.map((r) => r.message.replace(/^Rule \S+ /, "The rule "))))].join(" ")
        : c.candidates.map((x) => `${x.partNo} (${x.ruleId})`).join(" vs ");
    const message = detail ? `${c.message} ${detail}` : c.message;
    const key = `${c.componentId}\u0000${c.status}\u0000${message}`;
    const group = groups.get(key) ?? {
      gap: { componentId: c.componentId, status: c.status, message, locationIds: [], locationSummary: "", sourceIds: [] },
      sourceIds: new Set<string>(),
    };
    group.gap.locationIds.push(c.locationId);
    for (const id of gapSourceIds(c)) group.sourceIds.add(id);
    groups.set(key, group);
  }
  const gaps = [...groups.values()].map(({ gap, sourceIds }) => {
    gap.sourceIds = [...sourceIds].sort(compareCodePoints);
    return gap;
  });
  for (const gap of gaps) {
    const positions = new Map(gap.locationIds.map((id) => [id, positionOf(order, id, `A gap on ${gap.componentId}`)]));
    gap.locationIds.sort((a, b) => (positions.get(a) ?? 0) - (positions.get(b) ?? 0));
    gap.locationSummary = summarizeLocations(gap.locationIds.flatMap((id) => byId.get(id) ?? []));
  }
  return gaps.sort(
    (a, b) => compareCodePoints(a.componentId, b.componentId) || compareCodePoints(a.status, b.status) || compareCodePoints(a.message, b.message),
  );
}

/**
 * The report is a pure function of the visit's frozen snapshot and its persisted records.
 * It never reads live reference data, so completed reports are stable across reference releases.
 */
export function buildReport(visit: Visit, reportKind: "FINAL" | "DRAFT_PREVIEW", generatedAt: string): Report {
  const snapshot = visit.snapshot;
  const { context, resolution } = snapshot;
  const order = locationOrder(snapshot);
  const byId = new Map<string, CabinLocation>(context.layoutRevision.locations.map((l) => [l.id, l]));

  for (const r of visit.records) positionOf(order, r.locationId, `Record ${r.locationId} / ${r.componentId}`);
  const records = [...visit.records].sort(
    (a, b) =>
      (order.get(a.locationId) ?? 0) - (order.get(b.locationId) ?? 0) ||
      compareCodePoints(a.componentId, b.componentId) ||
      compareCodePoints(a.selection, b.selection) ||
      compareCodePoints(a.substituteId ?? "", b.substituteId ?? ""),
  );
  const componentAt = new Map<string, ComponentResolution>(resolution.components.map((c) => [`${c.locationId}\u0000${c.componentId}`, c]));
  // Every source the report cites: work items (rule, selection, mandatory children, pending changes),
  // the rules they did not use, and the gaps (DOM-16).
  const sourceIds = new Set<string>([context.configurationSource.id]);
  const work: ReportWorkItem[] = records.map((r) => {
    const rule = resolution.rules[r.ruleId];
    const sub = r.substituteId ? rule?.substitutes.find((s) => s.id === r.substituteId) : undefined;
    const main = r.lines.find((l) => l.role !== "MANDATORY_CHILD");
    const component = componentAt.get(`${r.locationId}\u0000${r.componentId}`);
    const excludedRules = component ? excludedOf(component) : [];
    r.lines.forEach((l) => {
      sourceIds.add(l.sourceId);
    });
    if (rule) sourceIds.add(rule.sourceId);
    if (sub) sourceIds.add(sub.sourceId);
    rule?.pendingChanges.forEach((p) => {
      if (p.sourceId) sourceIds.add(p.sourceId);
    });
    excludedRules.forEach((e) => {
      for (const id of excludedSourceIds(e)) sourceIds.add(id);
    });
    return {
      locationId: r.locationId,
      locationLabel: r.locationLabel,
      locationKind: byId.get(r.locationId)!.kind, // present: positionOf checked every record above
      componentId: r.componentId,
      componentName: r.componentName,
      selection: r.selection,
      primaryPartNo: r.primaryPartNo,
      selectedPartNo: main?.partNo ?? r.primaryPartNo,
      substituteId: r.substituteId,
      replacements: r.quantity,
      lines: r.lines,
      note: r.note,
      ruleId: r.ruleId,
      ruleSourceId: rule?.sourceId ?? "",
      selectionSourceId: sub?.sourceId ?? rule?.sourceId ?? "",
      pendingChanges: rule?.pendingChanges ?? [],
      recordedAt: r.createdAt,
      updatedAt: r.updatedAt,
      recordVersion: r.version,
      excludedRules,
    };
  });

  const totalsMap = new Map<string, ReportTotalLine>();
  for (const item of work) {
    for (const line of item.lines) {
      const key = `${line.partNo}\u0000${line.unit}`;
      const total =
        totalsMap.get(key) ??
        ({ partNo: line.partNo, description: line.description, unit: line.unit, quantity: 0, roles: [], locations: [] } satisfies ReportTotalLine);
      total.quantity += line.qty;
      if (!total.roles.includes(line.role)) total.roles.push(line.role);
      total.locations.push({
        locationId: item.locationId,
        locationLabel: item.locationLabel,
        componentId: item.componentId,
        quantity: line.qty,
        role: line.role,
      });
      totalsMap.set(key, total);
    }
  }
  const totals = [...totalsMap.values()].sort((a, b) => compareCodePoints(a.partNo, b.partNo) || compareCodePoints(a.unit, b.unit));
  totals.forEach((t) => {
    t.roles.sort(compareCodePoints);
  });

  const gaps = buildGaps(snapshot);
  gaps.forEach((g) => {
    g.sourceIds?.forEach((id) => {
      sourceIds.add(id);
    });
  });
  const sources: SourceArtifact[] = [...sourceIds]
    .map((id) => resolution.sources[id])
    .filter((s): s is SourceArtifact => Boolean(s))
    .sort((a, b) => compareCodePoints(a.id, b.id));

  const seatCount = context.layoutRevision.locations.filter((l) => l.kind === "SEAT").length;
  return {
    schema: REPORT_SCHEMA,
    reportKind,
    generatedAt,
    authorityNotice: AUTHORITY_NOTICE,
    replacementCountSemantics: REPLACEMENT_COUNT_SEMANTICS,
    dateRule: DATE_RULE,
    visit: {
      id: visit.id,
      number: visit.number,
      status: visit.status,
      tail: visit.tail,
      checkDate: visit.checkDate,
      technician: visit.technician,
      createdAt: visit.createdAt,
      completedAt: visit.completedAt,
      version: visit.version,
    },
    configuration: {
      referenceReleaseId: snapshot.referenceReleaseId,
      referenceContentHash: snapshot.referenceContentHash,
      snapshotSha256: visit.snapshotSha256,
      capturedAt: snapshot.capturedAt,
      lookupState: snapshot.lookupState,
      subtype: context.subtype.name,
      variantId: context.variant.id,
      variantName: context.variant.name,
      hardware: context.variant.hardware,
      layoutId: context.layout.id,
      layoutRevisionId: context.layoutRevision.id,
      layoutName: context.layoutRevision.name,
      seatCount,
      carpet: context.assignment.carpet,
      seam: context.assignment.seam,
      upholstery: context.assignment.upholstery,
      assignmentId: context.assignment.id,
      assignmentEffectiveFrom: context.assignment.effectiveFrom,
      assignmentEffectiveTo: context.assignment.effectiveTo,
      configurationSourceId: context.configurationSource.id,
      geometryVersion: snapshot.geometryVersion,
      namespace: context.layoutRevision.namespace,
    },
    work,
    totals,
    gaps,
    sources,
    linkedEvents: visit.events.filter((e) => e.type === "ADVISORY" || e.type === "CORRECTION_NOTE"),
    counts: {
      workItems: work.length,
      replacements: work.reduce((n, w) => n + w.replacements, 0),
      totalLines: totals.length,
      unresolvedComponents: gaps.reduce((n, g) => n + g.locationIds.length, 0),
    },
  };
}
