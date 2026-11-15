import { intervalsOverlap, isIsoDate } from "./dates.ts";
import { validateKits } from "./kits.ts";
import { buildMatchSet, matchSetsEqual, type MatchSet } from "./specificity.ts";
import type { ContextConstraint, Finding, LayoutRevision, ReleaseContent } from "./types.ts";

function duplicates<T>(items: T[], key: (item: T) => string): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) dup.add(k);
    seen.add(k);
  }
  return [...dup];
}

/**
 * Validate a staged release. "error" findings block activation. "conflict" findings are recorded
 * and activation proceeds, because the resolver refuses the affected lookups instead of guessing.
 */
export function validateRelease(content: ReleaseContent): Finding[] {
  const findings: Finding[] = [];
  const err = (code: string, message: string, refs?: string[]) => findings.push({ severity: "error", code, message, refs });
  const conflict = (code: string, message: string, refs?: string[]) => findings.push({ severity: "conflict", code, message, refs });
  const warn = (code: string, message: string, refs?: string[]) => findings.push({ severity: "warning", code, message, refs });

  const checkDup = <T>(label: string, items: T[], key: (item: T) => string) => {
    for (const k of duplicates(items, key)) err("DUPLICATE_KEY", `Duplicate ${label} key "${k}".`, [k]);
  };
  checkDup("source", content.sources, (s) => s.id);
  checkDup("subtype", content.subtypes, (s) => s.id);
  checkDup("aircraft", content.aircraft, (a) => a.tail);
  checkDup("variant", content.variants, (v) => v.id);
  checkDup("layout", content.layouts, (l) => l.id);
  checkDup("layout revision", content.layoutRevisions, (r) => r.id);
  checkDup("assignment", content.assignments, (a) => a.id);
  checkDup("component", content.components, (c) => c.id);
  checkDup("part", content.parts, (p) => p.partNo);
  checkDup("rule", content.rules, (r) => r.id);
  checkDup("substitute", content.substitutes, (s) => s.id);
  checkDup("pending change", content.pendingChanges, (p) => p.id);
  checkDup("layout category", content.layoutCategories, (c) => c.id);

  const sources = new Set(content.sources.map((s) => s.id));
  const subtypes = new Set(content.subtypes.map((s) => s.id));
  const aircraft = new Map(content.aircraft.map((a) => [a.tail, a]));
  const variants = new Map(content.variants.map((v) => [v.id, v]));
  const layouts = new Set(content.layouts.map((l) => l.id));
  const revisions = new Map<string, LayoutRevision>(content.layoutRevisions.map((r) => [r.id, r]));
  const components = new Map(content.components.map((c) => [c.id, c]));
  const parts = new Map(content.parts.map((p) => [p.partNo, p]));
  const { units, carpets, seams, upholsteries } = content.vocabulary;

  const dateOk = (value: string | null, label: string, ref: string, nullable = true) => {
    if (value === null) {
      if (!nullable) err("INVALID_DATE", `${label} is required on ${ref}.`, [ref]);
      return;
    }
    if (!isIsoDate(value)) err("INVALID_DATE", `${label} "${value}" on ${ref} is not a valid calendar date.`, [ref]);
  };
  const intervalOk = (from: string | null, to: string | null, ref: string) => {
    if (from !== null && to !== null && isIsoDate(from) && isIsoDate(to) && to < from) {
      err("INVALID_INTERVAL", `${ref} ends (${to}) before it starts (${from}).`, [ref]);
    }
  };

  for (const s of content.sources) {
    dateOk(s.effectiveFrom, "effectiveFrom", s.id);
    dateOk(s.expiresOn, "expiresOn", s.id);
    intervalOk(s.effectiveFrom, s.expiresOn, s.id);
    if (s.authority === "approved") err("UNSUPPORTED_AUTHORITY", `Source ${s.id} claims approved authority; no approved airline source has been supplied.`, [s.id]);
  }
  for (const a of content.aircraft) {
    if (!subtypes.has(a.subtypeId)) err("ORPHAN", `Aircraft ${a.tail} refers to unknown subtype ${a.subtypeId}.`, [a.tail]);
    if (a.namespace !== "fixture") err("NAMESPACE", `Aircraft ${a.tail} is in namespace ${a.namespace}; no approved or candidate tail data has been supplied.`, [a.tail]);
  }
  for (const l of content.layouts) if (!subtypes.has(l.subtypeId)) err("ORPHAN", `Layout ${l.id} refers to unknown subtype ${l.subtypeId}.`, [l.id]);

  // layout revisions: seat sets, totals, rows
  for (const r of content.layoutRevisions) {
    if (!layouts.has(r.layoutId)) err("ORPHAN", `Layout revision ${r.id} refers to unknown layout ${r.layoutId}.`, [r.id]);
    if (!subtypes.has(r.subtypeId)) err("ORPHAN", `Layout revision ${r.id} refers to unknown subtype ${r.subtypeId}.`, [r.id]);
    if (!sources.has(r.sourceId)) err("ORPHAN", `Layout revision ${r.id} cites unknown source ${r.sourceId}.`, [r.id]);
    for (const k of duplicates(r.rows, (row) => row.printedLabel)) err("DUPLICATE_KEY", `Layout revision ${r.id} has duplicate printed row "${k}".`, [r.id]);
    for (const k of duplicates(r.locations, (l) => l.id)) err("DUPLICATE_KEY", `Layout revision ${r.id} has duplicate location "${k}".`, [r.id]);
    const existing = r.rows.filter((row) => row.exists);
    const orders = existing.map((row) => row.physicalOrder);
    if (orders.some((o) => o === null) || new Set(orders).size !== orders.length) {
      err("ROW_ORDER", `Layout revision ${r.id} has rows without a unique physical order.`, [r.id]);
    }
    for (const row of r.rows) {
      if (!row.exists && row.physicalOrder !== null) err("ROW_ORDER", `Layout revision ${r.id} row "${row.printedLabel}" does not exist but has a physical order.`, [r.id]);
    }
    const rowByLabel = new Map(r.rows.map((row) => [row.printedLabel, row]));
    const seats = r.locations.filter((l) => l.kind === "SEAT");
    for (const loc of r.locations) {
      for (const c of loc.componentIds) {
        const def = components.get(c);
        if (!def) err("ORPHAN", `Location ${r.id}#${loc.id} lists unknown component ${c}.`, [`${r.id}#${loc.id}`]);
        else if (def.locationKind !== loc.kind) err("COMPONENT_KIND", `Component ${c} is not valid for ${loc.kind} location ${r.id}#${loc.id}.`, [`${r.id}#${loc.id}`]);
      }
      if (loc.kind === "SEAT") {
        const seat = loc.seat;
        if (!seat) {
          err("SEAT_INVALID", `Seat location ${r.id}#${loc.id} has no seat attributes.`, [`${r.id}#${loc.id}`]);
          continue;
        }
        const row = rowByLabel.get(seat.printedRow);
        if (!row || !row.exists) err("SEAT_ROW", `Seat ${r.id}#${seat.code} sits on printed row ${seat.printedRow}, which does not exist in this layout.`, [`${r.id}#${loc.id}`]);
        else if (row.physicalOrder !== seat.physicalRow) err("SEAT_ROW", `Seat ${r.id}#${seat.code} physical row disagrees with its printed row.`, [`${r.id}#${loc.id}`]);
        if (seat.code !== `${seat.printedRow}${seat.letter}` || loc.id !== `SEAT:${seat.code}`) {
          err("SEAT_IDENTITY", `Seat ${r.id}#${loc.id} has inconsistent identity (${seat.printedRow}/${seat.letter}/${seat.code}).`, [`${r.id}#${loc.id}`]);
        }
        if (seat.pitch && seat.pitch.min !== null && seat.pitch.max !== null && seat.pitch.max < seat.pitch.min) {
          err("RANGE_INVALID", `Seat ${r.id}#${seat.code} pitch range is inverted.`, [`${r.id}#${loc.id}`]);
        }
      }
    }
    if (r.seatSetStatus === "complete") {
      if (r.declaredSeatCount !== null && r.declaredSeatCount !== seats.length) {
        err("SEAT_TOTAL", `Layout revision ${r.id} declares ${r.declaredSeatCount} seats but ${seats.length} seat identities are present.`, [r.id]);
      }
      if (r.declaredTierTotals) {
        for (const [tier, declared] of Object.entries(r.declaredTierTotals)) {
          const counted = seats.filter((s) => s.seat?.commercialTier === tier).length;
          if (counted !== declared) err("TIER_TOTAL", `Layout revision ${r.id} declares ${declared} ${tier} seats but ${counted} are present.`, [r.id]);
        }
      }
    } else if (seats.length > 0) {
      err("SEAT_SET_STATUS", `Layout revision ${r.id} is marked "seat set not supplied" but contains seats.`, [r.id]);
    }
    if (r.namespace === "candidate" && r.status !== "candidate") err("NAMESPACE", `Candidate layout revision ${r.id} must have status "candidate".`, [r.id]);
    if (r.namespace === "candidate" && (r.floorMapStatus !== "not-supplied" || r.binMapStatus !== "not-supplied")) {
      err("UNSUPPORTED_FIELD", `Candidate layout revision ${r.id} claims a floor or bin map that was not supplied.`, [r.id]);
    }
  }

  for (const v of content.variants) {
    if (!subtypes.has(v.subtypeId)) err("ORPHAN", `Variant ${v.id} refers to unknown subtype ${v.subtypeId}.`, [v.id]);
    if (!sources.has(v.sourceId)) err("ORPHAN", `Variant ${v.id} cites unknown source ${v.sourceId}.`, [v.id]);
    for (const id of v.layoutRevisionIds) {
      const rev = revisions.get(id);
      if (!rev) err("ORPHAN", `Variant ${v.id} refers to unknown layout revision ${id}.`, [v.id]);
      else if (rev.namespace !== v.namespace) err("NAMESPACE", `Variant ${v.id} (${v.namespace}) uses layout revision ${id} from namespace ${rev.namespace}.`, [v.id]);
    }
  }

  // assignments
  for (const a of content.assignments) {
    const ref = a.id;
    if (!aircraft.has(a.tail)) err("ORPHAN", `Assignment ${ref} refers to unknown tail ${a.tail}.`, [ref]);
    const variant = variants.get(a.variantId);
    if (!variant) err("ORPHAN", `Assignment ${ref} refers to unknown variant ${a.variantId}.`, [ref]);
    if (!revisions.has(a.layoutRevisionId)) err("ORPHAN", `Assignment ${ref} refers to unknown layout revision ${a.layoutRevisionId}.`, [ref]);
    else if (variant && !variant.layoutRevisionIds.includes(a.layoutRevisionId)) err("ORPHAN", `Assignment ${ref} pairs variant ${a.variantId} with layout revision ${a.layoutRevisionId}, which that variant does not list.`, [ref]);
    if (!sources.has(a.sourceId)) err("ORPHAN", `Assignment ${ref} cites unknown source ${a.sourceId}.`, [ref]);
    if (a.namespace !== "fixture") err("NAMESPACE", `Assignment ${ref} is in namespace ${a.namespace}; no approved dated tail assignment has been supplied.`, [ref]);
    dateOk(a.effectiveFrom, "effectiveFrom", ref, false);
    dateOk(a.effectiveTo, "effectiveTo", ref);
    intervalOk(a.effectiveFrom, a.effectiveTo, ref);
    if (a.carpet !== null && !carpets.includes(a.carpet)) err("VOCABULARY", `Assignment ${ref} uses unknown carpet ${a.carpet}.`, [ref]);
    if (a.seam !== null && !seams.includes(a.seam)) err("VOCABULARY", `Assignment ${ref} uses unknown seam ${a.seam}.`, [ref]);
    if (a.upholstery !== null && !upholsteries.includes(a.upholstery)) err("VOCABULARY", `Assignment ${ref} uses unknown upholstery ${a.upholstery}.`, [ref]);
  }
  const byTail = new Map<string, typeof content.assignments>();
  for (const a of content.assignments) byTail.set(a.tail, [...(byTail.get(a.tail) ?? []), a]);
  for (const [tail, list] of byTail) {
    const released = list.filter((a) => a.status === "released");
    for (let i = 0; i < released.length; i++) {
      for (let j = i + 1; j < released.length; j++) {
        const a = released[i];
        const b = released[j];
        if (isIsoDate(a.effectiveFrom) && isIsoDate(b.effectiveFrom) && intervalsOverlap(a.effectiveFrom, a.effectiveTo, b.effectiveFrom, b.effectiveTo)) {
          conflict("ASSIGNMENT_OVERLAP", `Tail ${tail} has overlapping released assignments ${a.id} and ${b.id}. Lookups inside the overlap are refused.`, [a.id, b.id]);
        }
      }
    }
  }

  // rules and substitutes
  const constraintOk = (c: ContextConstraint, ref: string) => {
    for (const id of c.variant ?? []) if (!variants.has(id)) err("ORPHAN", `${ref} constrains unknown variant ${id}.`, [ref]);
    for (const id of c.layoutRevision ?? []) if (!revisions.has(id)) err("ORPHAN", `${ref} constrains unknown layout revision ${id}.`, [ref]);
    for (const id of c.subtype ?? []) if (!subtypes.has(id)) err("ORPHAN", `${ref} constrains unknown subtype ${id}.`, [ref]);
    for (const id of c.carpet ?? []) if (!carpets.includes(id)) err("VOCABULARY", `${ref} constrains unknown carpet ${id}.`, [ref]);
    for (const id of c.seam ?? []) if (!seams.includes(id)) err("VOCABULARY", `${ref} constrains unknown seam ${id}.`, [ref]);
    for (const id of c.upholstery ?? []) if (!upholsteries.includes(id)) err("VOCABULARY", `${ref} constrains unknown upholstery ${id}.`, [ref]);
  };
  const ruleSets = new Map<string, MatchSet>();
  for (const r of content.rules) {
    const ref = `rule ${r.id}`;
    const def = components.get(r.componentId);
    if (!def) err("ORPHAN", `${ref} refers to unknown component ${r.componentId}.`, [r.id]);
    else if (def.locationKind !== r.locations.kind) err("COMPONENT_KIND", `${ref} selects ${r.locations.kind} locations for a ${def.locationKind} component.`, [r.id]);
    if (!parts.has(r.partNo)) err("ORPHAN", `${ref} refers to unknown part ${r.partNo}.`, [r.id]);
    if (!sources.has(r.sourceId)) err("ORPHAN", `${ref} cites unknown source ${r.sourceId}.`, [r.id]);
    if (!units.includes(r.unit)) err("UNKNOWN_UNIT", `${ref} uses unknown unit ${r.unit}.`, [r.id]);
    if (!Number.isInteger(r.qtyPerReplacement) || r.qtyPerReplacement <= 0) err("INVALID_QUANTITY", `${ref} has invalid quantity ${r.qtyPerReplacement}.`, [r.id]);
    if (r.namespace !== "fixture") err("NAMESPACE", `${ref} is in namespace ${r.namespace}; no approved parts applicability has been supplied.`, [r.id]);
    dateOk(r.effectiveFrom, "effectiveFrom", ref, false);
    dateOk(r.effectiveTo, "effectiveTo", ref);
    intervalOk(r.effectiveFrom, r.effectiveTo, ref);
    constraintOk(r.constraint, ref);
    const set = buildMatchSet(content, revisions, r.constraint, r.locations, r.componentId);
    ruleSets.set(r.id, set);
    if (set.empty) err("UNREACHABLE_RULE", `${ref} cannot match any location in any configuration (unreachable).`, [r.id]);
    else {
      for (const pair of set.pairs.keys()) {
        const revision = revisions.get(pair.split("|")[1]);
        if (revision && revision.namespace !== r.namespace) err("NAMESPACE", `${ref} (${r.namespace}) reaches layout revision ${revision.id} in namespace ${revision.namespace}.`, [r.id]);
      }
    }
  }
  // equal released rules for the same component with overlapping validity can never be resolved
  const byComponent = new Map<string, typeof content.rules>();
  for (const r of content.rules) if (r.released) byComponent.set(r.componentId, [...(byComponent.get(r.componentId) ?? []), r]);
  for (const list of byComponent.values()) {
    const bySignature = new Map<string, typeof content.rules>();
    for (const r of list) {
      const set = ruleSets.get(r.id);
      if (!set || set.empty) continue;
      const sig = [...set.pairs.entries()].map(([k, v]) => `${k}:${v.size}`).sort().join(";");
      bySignature.set(sig, [...(bySignature.get(sig) ?? []), r]);
    }
    for (const group of bySignature.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          if (!isIsoDate(a.effectiveFrom) || !isIsoDate(b.effectiveFrom)) continue;
          if (!intervalsOverlap(a.effectiveFrom, a.effectiveTo, b.effectiveFrom, b.effectiveTo)) continue;
          if (matchSetsEqual(ruleSets.get(a.id)!, ruleSets.get(b.id)!)) {
            conflict("EQUAL_RULES", `Rules ${a.id} and ${b.id} have identical scope and overlapping validity. Affected components are reported as ambiguous.`, [a.id, b.id]);
          }
        }
      }
    }
  }
  const primaryParts = new Set(content.rules.map((r) => `${r.componentId}|${r.partNo}`));
  for (const s of content.substitutes) {
    const ref = `substitute ${s.id}`;
    const def = components.get(s.componentId);
    if (!def) err("ORPHAN", `${ref} refers to unknown component ${s.componentId}.`, [s.id]);
    if (!parts.has(s.primaryPartNo)) err("ORPHAN", `${ref} refers to unknown primary part ${s.primaryPartNo}.`, [s.id]);
    if (!parts.has(s.altPartNo)) err("ORPHAN", `${ref} refers to unknown alternate part ${s.altPartNo}.`, [s.id]);
    if (s.altPartNo === s.primaryPartNo) err("SUBSTITUTE_INVALID", `${ref} substitutes a part for itself.`, [s.id]);
    if (!sources.has(s.sourceId)) err("ORPHAN", `${ref} cites unknown approval source ${s.sourceId}.`, [s.id]);
    if (!units.includes(s.unit)) err("UNKNOWN_UNIT", `${ref} uses unknown unit ${s.unit}.`, [s.id]);
    if (!Number.isInteger(s.qtyPerReplacement) || s.qtyPerReplacement <= 0) err("INVALID_QUANTITY", `${ref} has invalid quantity ${s.qtyPerReplacement}.`, [s.id]);
    if (s.namespace !== "fixture") err("NAMESPACE", `${ref} is in namespace ${s.namespace}; no approved substitute catalogue has been supplied.`, [s.id]);
    if (def && s.locations && def.locationKind !== s.locations.kind) err("COMPONENT_KIND", `${ref} selects ${s.locations.kind} locations for a ${def.locationKind} component.`, [s.id]);
    dateOk(s.effectiveFrom, "effectiveFrom", ref, false);
    dateOk(s.effectiveTo, "effectiveTo", ref);
    intervalOk(s.effectiveFrom, s.effectiveTo, ref);
    constraintOk(s.constraint, ref);
    if (!primaryParts.has(`${s.componentId}|${s.primaryPartNo}`)) warn("SUBSTITUTE_UNUSED", `${ref} stands in for ${s.primaryPartNo}, which no rule for ${s.componentId} selects.`, [s.id]);
    else if (buildMatchSet(content, revisions, s.constraint, s.locations, s.componentId).empty) err("UNREACHABLE_SUBSTITUTE", `${ref} cannot match any location in any configuration.`, [s.id]);
  }
  const ruleIds = new Set(content.rules.map((r) => r.id));
  for (const p of content.pendingChanges) {
    if (!ruleIds.has(p.ruleId)) err("ORPHAN", `Pending change ${p.id} refers to unknown rule ${p.ruleId}.`, [p.id]);
    if (p.sourceId !== null && !sources.has(p.sourceId)) err("ORPHAN", `Pending change ${p.id} cites unknown source ${p.sourceId}.`, [p.id]);
    dateOk(p.proposedEffectiveFrom, "proposedEffectiveFrom", p.id);
  }
  for (const c of content.components) {
    if (!Number.isInteger(c.maxReplacementsPerLocation) || c.maxReplacementsPerLocation < 1) err("INVALID_QUANTITY", `Component ${c.id} has an invalid replacement limit.`, [c.id]);
  }
  findings.push(...validateKits(content.kitChildren, parts, units, sources));

  for (const c of content.layoutCategories) {
    for (const x of c.crosswalk) if (!revisions.has(x.layoutRevisionId)) err("ORPHAN", `Layout category ${c.id} crosswalks to unknown layout revision ${x.layoutRevisionId}.`, [c.id]);
    for (const claim of c.claims) if (!sources.has(claim.sourceId)) err("ORPHAN", `Layout category ${c.id} cites unknown source ${claim.sourceId}.`, [c.id]);
    if (c.seatSetStatus === "not-supplied" && c.crosswalk.length > 0) err("CROSSWALK", `Layout category ${c.id} has no supplied seat set but is crosswalked to a layout.`, [c.id]);
  }
  return findings;
}

export function hasBlockingFindings(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === "error");
}
