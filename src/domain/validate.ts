import { intervalsOverlap } from "./dates.ts";
import { isKnownSeatLetter, sideOf } from "./geometry.ts";
import { validateKits } from "./kits.ts";
import { compareCodePoints } from "./order.ts";
import { configurationProblems, isReleasedConfiguration } from "./resolve.ts";
import { structuralFindings } from "./schema.ts";
import {
  buildIndex,
  buildMatchSet,
  intersectMatchSets,
  isStrictlyMoreSpecific,
  isSubset,
  locationMatches,
  type MatchSet,
  matchSetsEqual,
  matchSetsIntersect,
  reachableRevisions,
} from "./specificity.ts";
import type { ApplicabilityRule, ContextConstraint, Finding, LocationSelector, ReleaseContent, SourceArtifact } from "./types.ts";

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

const laterDate = (a: string, b: string) => (compareCodePoints(a, b) >= 0 ? a : b);
const earlierDate = (a: string, b: string) => (compareCodePoints(a, b) <= 0 ? a : b);

const NO_MATCH: MatchSet = { pairs: new Map(), carpet: null, seam: null, upholstery: null, empty: true };

/** Does the interval `start`..`end` (null end = open-ended) cover every date from `from` to `to` (null = open-ended)? */
function intervalCovers(start: string | null, end: string | null, from: string, to: string | null): boolean {
  if (start !== null && compareCodePoints(start, from) > 0) return false;
  if (end === null) return true;
  return to !== null && compareCodePoints(end, to) >= 0;
}

/** Does a rule's own validity cover every date from `from` to `to`? */
function validityCovers(rule: ApplicabilityRule, from: string, to: string | null): boolean {
  return intervalCovers(rule.effectiveFrom, rule.effectiveTo, from, to);
}

/** Is the source a rule cites released and valid on every date from `from` to `to`? */
function sourceCovers(source: SourceArtifact | undefined, from: string, to: string | null): boolean {
  return source !== undefined && source.released && intervalCovers(source.effectiveFrom, source.expiresOn, from, to);
}

/**
 * Validate a staged release. "error" findings block activation. "conflict" findings are recorded
 * and activation proceeds, because the resolver refuses the affected lookups instead of guessing.
 * Structure (shape, enums, dates, quantity bounds, tail form) is checked first by the schema; when
 * it fails only those findings are returned, because the semantic checks assume sound structure.
 */
export function validateRelease(input: unknown): Finding[] {
  const structural = structuralFindings(input);
  if (structural.length > 0) return structural;
  const content = input as ReleaseContent;
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
  const index = buildIndex(content);
  const revisions = index.layoutRevisions;
  const components = new Map(content.components.map((c) => [c.id, c]));
  const parts = new Map(content.parts.map((p) => [p.partNo, p]));
  const { units, carpets, seams, upholsteries } = content.vocabulary;
  const hardware = new Set(content.variants.flatMap((v) => (v.hardware === null ? [] : [v.hardware])));

  const intervalOk = (from: string | null, to: string | null, ref: string) => {
    if (from !== null && to !== null && to < from) {
      err("INVALID_INTERVAL", `${ref} ends (${to}) before it starts (${from}).`, [ref]);
    }
  };

  for (const s of content.sources) {
    intervalOk(s.effectiveFrom, s.expiresOn, s.id);
    if (s.authority === "approved")
      err("UNSUPPORTED_AUTHORITY", `Source ${s.id} claims approved authority; no approved airline source has been supplied.`, [s.id]);
  }
  for (const a of content.aircraft) {
    if (!subtypes.has(a.subtypeId)) err("ORPHAN", `Aircraft ${a.tail} refers to unknown subtype ${a.subtypeId}.`, [a.tail]);
    if (a.namespace !== "fixture")
      err("NAMESPACE", `Aircraft ${a.tail} is in namespace ${a.namespace}; no approved or candidate tail data has been supplied.`, [a.tail]);
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
      if (!row.exists && row.physicalOrder !== null)
        err("ROW_ORDER", `Layout revision ${r.id} row "${row.printedLabel}" does not exist but has a physical order.`, [r.id]);
    }
    const rowByLabel = new Map(r.rows.map((row) => [row.printedLabel, row]));
    const seats = r.locations.filter((l) => l.kind === "SEAT");
    for (const loc of r.locations) {
      for (const c of loc.componentIds) {
        const def = components.get(c);
        if (!def) err("ORPHAN", `Location ${r.id}#${loc.id} lists unknown component ${c}.`, [`${r.id}#${loc.id}`]);
        else if (def.locationKind !== loc.kind)
          err("COMPONENT_KIND", `Component ${c} is not valid for ${loc.kind} location ${r.id}#${loc.id}.`, [`${r.id}#${loc.id}`]);
      }
      if (loc.kind === "SEAT") {
        const seat = loc.seat;
        if (!seat) {
          err("SEAT_INVALID", `Seat location ${r.id}#${loc.id} has no seat attributes.`, [`${r.id}#${loc.id}`]);
          continue;
        }
        const row = rowByLabel.get(seat.printedRow);
        if (!row || !row.exists)
          err("SEAT_ROW", `Seat ${r.id}#${seat.code} sits on printed row ${seat.printedRow}, which does not exist in this layout.`, [`${r.id}#${loc.id}`]);
        else if (row.physicalOrder !== seat.physicalRow)
          err("SEAT_ROW", `Seat ${r.id}#${seat.code} physical row disagrees with its printed row.`, [`${r.id}#${loc.id}`]);
        if (seat.code !== `${seat.printedRow}${seat.letter}` || loc.id !== `SEAT:${seat.code}`) {
          err("SEAT_IDENTITY", `Seat ${r.id}#${loc.id} has inconsistent identity (${seat.printedRow}/${seat.letter}/${seat.code}).`, [`${r.id}#${loc.id}`]);
        }
        if (!isKnownSeatLetter(seat.letter)) {
          err("SEAT_LETTER_UNKNOWN", `Seat ${r.id}#${loc.id} has seat letter "${seat.letter}", which the geometry frame cannot place (A-F).`, [
            `${r.id}#${loc.id}`,
          ]);
        } else if (seat.side !== sideOf(seat.letter)) {
          err("SEAT_SIDE_MISMATCH", `Seat ${r.id}#${loc.id} is on side ${seat.side}, but letter ${seat.letter} is on side ${sideOf(seat.letter)}.`, [
            `${r.id}#${loc.id}`,
          ]);
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
    if (r.namespace === "candidate") {
      // zones, floor areas and bin modules are fixture shortcuts and never enter candidate layouts
      for (const loc of r.locations) {
        const at = `${r.id}#${loc.id}`;
        const zone = loc.seat?.maintenanceZone ?? null;
        if (loc.kind === "FLOOR" || loc.kind === "BIN")
          err("CANDIDATE_HAS_FIXTURE_DATA", `Candidate layout revision ${r.id} contains fixture ${loc.kind} location ${loc.id}.`, [r.id, at]);
        else if (zone !== null) err("CANDIDATE_HAS_FIXTURE_DATA", `Candidate seat ${at} carries fixture maintenance zone ${zone}.`, [r.id, at]);
      }
    }
  }

  for (const v of content.variants) {
    if (!subtypes.has(v.subtypeId)) err("ORPHAN", `Variant ${v.id} refers to unknown subtype ${v.subtypeId}.`, [v.id]);
    if (!sources.has(v.sourceId)) err("ORPHAN", `Variant ${v.id} cites unknown source ${v.sourceId}.`, [v.id]);
    for (const id of v.layoutRevisionIds) {
      const rev = revisions.get(id);
      if (!rev) err("ORPHAN", `Variant ${v.id} refers to unknown layout revision ${id}.`, [v.id]);
      else if (rev.namespace !== v.namespace)
        err("NAMESPACE", `Variant ${v.id} (${v.namespace}) uses layout revision ${id} from namespace ${rev.namespace}.`, [v.id]);
    }
  }

  // assignments
  for (const a of content.assignments) {
    const ref = a.id;
    const plane = aircraft.get(a.tail);
    if (!plane) err("ORPHAN", `Assignment ${ref} refers to unknown tail ${a.tail}.`, [ref]);
    const variant = variants.get(a.variantId);
    if (!variant) err("ORPHAN", `Assignment ${ref} refers to unknown variant ${a.variantId}.`, [ref]);
    const revision = revisions.get(a.layoutRevisionId);
    if (!revision) err("ORPHAN", `Assignment ${ref} refers to unknown layout revision ${a.layoutRevisionId}.`, [ref]);
    else if (variant && !variant.layoutRevisionIds.includes(a.layoutRevisionId))
      err("ORPHAN", `Assignment ${ref} pairs variant ${a.variantId} with layout revision ${a.layoutRevisionId}, which that variant does not list.`, [ref]);
    // as in lookup, only a released configuration is checked; a planned one is never used
    if (plane && variant && revision && isReleasedConfiguration(a, variant, revision)) {
      const problems = configurationProblems(plane, variant, revision);
      if (problems.length > 0)
        conflict("ASSIGNMENT_INCONSISTENT", `Assignment ${ref} for tail ${a.tail}: ${problems.join(" ")} Lookups for this configuration are refused.`, [
          ref,
          a.tail,
        ]);
    }
    if (!sources.has(a.sourceId)) err("ORPHAN", `Assignment ${ref} cites unknown source ${a.sourceId}.`, [ref]);
    if (a.namespace !== "fixture")
      err("NAMESPACE", `Assignment ${ref} is in namespace ${a.namespace}; no approved dated tail assignment has been supplied.`, [ref]);
    intervalOk(a.effectiveFrom, a.effectiveTo, ref);
    if (a.carpet !== null && !carpets.includes(a.carpet)) err("VOCABULARY", `Assignment ${ref} uses unknown carpet ${a.carpet}.`, [ref]);
    if (a.seam !== null && !seams.includes(a.seam)) err("VOCABULARY", `Assignment ${ref} uses unknown seam ${a.seam}.`, [ref]);
    if (a.upholstery !== null && !upholsteries.includes(a.upholstery)) err("VOCABULARY", `Assignment ${ref} uses unknown upholstery ${a.upholstery}.`, [ref]);
  }
  const byTail = new Map<string, typeof content.assignments>();
  for (const a of content.assignments) byTail.set(a.tail, [...(byTail.get(a.tail) ?? []), a]);
  for (const [tail, list] of byTail) {
    const released = list.filter((a) => a.status === "released");
    for (const [i, a] of released.entries()) {
      for (const b of released.slice(i + 1)) {
        if (intervalsOverlap(a.effectiveFrom, a.effectiveTo, b.effectiveFrom, b.effectiveTo)) {
          conflict("ASSIGNMENT_OVERLAP", `Tail ${tail} has overlapping released assignments ${a.id} and ${b.id}. Lookups inside the overlap are refused.`, [
            a.id,
            b.id,
          ]);
        }
      }
    }
  }

  // rules and substitutes
  const constraintOk = (c: ContextConstraint, ref: string, ownerId: string) => {
    const check = (label: string, values: string[] | undefined, known: (value: string) => boolean) => {
      for (const value of values ?? []) if (!known(value)) err("CONSTRAINT_VALUE_UNKNOWN", `${ref} constrains unknown ${label} ${value}.`, [ownerId, value]);
    };
    check("variant", c.variant, (v) => variants.has(v));
    check("layout revision", c.layoutRevision, (v) => revisions.has(v));
    check("subtype", c.subtype, (v) => subtypes.has(v));
    check("hardware", c.hardware, (v) => hardware.has(v));
    check("carpet", c.carpet, (v) => carpets.includes(v));
    check("seam", c.seam, (v) => seams.includes(v));
    check("upholstery", c.upholstery, (v) => upholsteries.includes(v));
  };
  /**
   * Every selector value must exist somewhere it can reach. Values are checked one at a time; whether
   * they can match together is the unreachable-rule check. A selector whose constraint reaches no
   * layout revision at all is left to that check too.
   */
  const selectorOk = (selector: LocationSelector | undefined, constraint: ContextConstraint, ref: string, ownerId: string) => {
    if (!selector) return;
    const { kind, rowFrom, rowTo } = selector;
    const rowRangeValid = (rowFrom === undefined) === (rowTo === undefined) && (rowFrom === undefined || rowTo === undefined || rowFrom <= rowTo);
    if (!rowRangeValid)
      err("ROW_RANGE_INVALID", `${ref} has row range ${rowFrom ?? "(none)"} to ${rowTo ?? "(none)"}; give both bounds, first not after last.`, [ownerId]);
    const reached = reachableRevisions(content, revisions, constraint);
    if (reached.length === 0) return;
    const matchesSome = (probe: LocationSelector) => reached.some((rev) => rev.locations.some((loc) => locationMatches(probe, loc)));
    for (const id of selector.ids ?? [])
      if (!matchesSome({ kind, ids: [id] }))
        err("SELECTOR_ID_UNKNOWN", `${ref} selects ${id}, which is not a ${kind} location in any layout revision it can reach.`, [ownerId, id]);
    const unmatched = (what: string) => err("SELECTOR_VALUE_UNMATCHED", `${ref} selects ${what}, which matches no ${kind} location it can reach.`, [ownerId]);
    for (const zone of selector.zones ?? []) if (!matchesSome({ kind, zones: [zone] })) unmatched(`zone ${zone}`);
    for (const letter of selector.letters ?? []) if (!matchesSome({ kind, letters: [letter] })) unmatched(`letter ${letter}`);
    for (const side of selector.sides ?? []) if (!matchesSome({ kind, sides: [side] })) unmatched(`side ${side}`);
    for (const area of selector.floorAreaTypes ?? []) if (!matchesSome({ kind, floorAreaTypes: [area] })) unmatched(`floor area type ${area}`);
    if (rowRangeValid && rowFrom !== undefined && rowTo !== undefined && !matchesSome({ kind, rowFrom, rowTo })) unmatched(`rows ${rowFrom} to ${rowTo}`);
  };
  const ruleSet = (id: string): MatchSet => index.ruleMatch.get(id) ?? NO_MATCH;
  for (const r of content.rules) {
    const ref = `rule ${r.id}`;
    const def = components.get(r.componentId);
    if (!def) err("ORPHAN", `${ref} refers to unknown component ${r.componentId}.`, [r.id]);
    else if (def.locationKind !== r.locations.kind)
      err("COMPONENT_KIND", `${ref} selects ${r.locations.kind} locations for a ${def.locationKind} component.`, [r.id]);
    if (!parts.has(r.partNo)) err("ORPHAN", `${ref} refers to unknown part ${r.partNo}.`, [r.id]);
    if (!sources.has(r.sourceId)) err("ORPHAN", `${ref} cites unknown source ${r.sourceId}.`, [r.id]);
    if (!units.includes(r.unit)) err("UNKNOWN_UNIT", `${ref} uses unknown unit ${r.unit}.`, [r.id]);
    if (r.namespace !== "fixture") err("NAMESPACE", `${ref} is in namespace ${r.namespace}; no approved parts applicability has been supplied.`, [r.id]);
    intervalOk(r.effectiveFrom, r.effectiveTo, ref);
    constraintOk(r.constraint, ref, r.id);
    selectorOk(r.locations, r.constraint, ref, r.id);
    // reachability and namespace use every listed pair, released or not, so staged data still validates
    const listed = buildMatchSet(content, revisions, r.constraint, r.locations, r.componentId, "listed");
    if (listed.empty) err("UNREACHABLE_RULE", `${ref} cannot match any location in any configuration (unreachable).`, [r.id]);
    else {
      if (ruleSet(r.id).empty)
        warn("RULE_UNRELEASED_ONLY", `${ref} reaches only unreleased configurations, so no lookup can use it until they are released.`, [r.id]);
      for (const pair of listed.pairs.keys()) {
        const [, revisionId] = pair.split("|");
        const revision = revisionId === undefined ? undefined : revisions.get(revisionId);
        if (revision && revision.namespace !== r.namespace)
          err("NAMESPACE", `${ref} (${r.namespace}) reaches layout revision ${revision.id} in namespace ${revision.namespace}.`, [r.id]);
      }
    }
  }
  // equal or incomparable released rules for the same component with overlapping validity can never be resolved
  const byComponent = new Map<string, typeof content.rules>();
  for (const r of content.rules) if (r.released) byComponent.set(r.componentId, [...(byComponent.get(r.componentId) ?? []), r]);
  for (const list of byComponent.values()) {
    const bySignature = new Map<string, typeof content.rules>();
    for (const r of list) {
      const set = ruleSet(r.id);
      if (set.empty) continue;
      const sig = [...set.pairs.entries()]
        .map(([k, v]) => `${k}:${v.size}`)
        .sort()
        .join(";");
      bySignature.set(sig, [...(bySignature.get(sig) ?? []), r]);
    }
    for (const group of bySignature.values()) {
      for (const [i, a] of group.entries()) {
        for (const b of group.slice(i + 1)) {
          if (!intervalsOverlap(a.effectiveFrom, a.effectiveTo, b.effectiveFrom, b.effectiveTo)) continue;
          if (matchSetsEqual(ruleSet(a.id), ruleSet(b.id))) {
            conflict("EQUAL_RULES", `Rules ${a.id} and ${b.id} have identical scope and overlapping validity. Affected components are reported as ambiguous.`, [
              a.id,
              b.id,
            ]);
          }
        }
      }
    }
    for (const [i, a] of list.entries()) {
      const aSet = ruleSet(a.id);
      if (aSet.empty) continue;
      for (const b of list.slice(i + 1)) {
        const bSet = ruleSet(b.id);
        if (bSet.empty || !intervalsOverlap(a.effectiveFrom, a.effectiveTo, b.effectiveFrom, b.effectiveTo)) continue;
        if (!matchSetsIntersect(aSet, bSet) || isSubset(aSet, bSet) || isSubset(bSet, aSet)) continue;
        // a third rule more specific than both, covering their whole overlap for the whole shared validity, settles it,
        // but only if its source is valid for that whole time too: once the source lapses the pair is ambiguous again
        const shared = intersectMatchSets(aSet, bSet);
        const from = laterDate(a.effectiveFrom, b.effectiveFrom);
        const to = a.effectiveTo === null ? b.effectiveTo : b.effectiveTo === null ? a.effectiveTo : earlierDate(a.effectiveTo, b.effectiveTo);
        const settled = list.some((c) => {
          if (c === a || c === b) return false;
          const cSet = ruleSet(c.id);
          return (
            isStrictlyMoreSpecific(cSet, aSet) &&
            isStrictlyMoreSpecific(cSet, bSet) &&
            isSubset(shared, cSet) &&
            validityCovers(c, from, to) &&
            sourceCovers(index.sources.get(c.sourceId), from, to)
          );
        });
        if (settled) continue;
        const pair = [a.id, b.id].sort(compareCodePoints);
        conflict(
          "RULES_INCOMPARABLE",
          `Rules ${pair[0]} and ${pair[1]} overlap in scope and validity but neither is more specific than the other. Affected components are reported as ambiguous.`,
          pair,
        );
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
    if (s.namespace !== "fixture") err("NAMESPACE", `${ref} is in namespace ${s.namespace}; no approved substitute catalogue has been supplied.`, [s.id]);
    if (def && s.locations && def.locationKind !== s.locations.kind)
      err("COMPONENT_KIND", `${ref} selects ${s.locations.kind} locations for a ${def.locationKind} component.`, [s.id]);
    intervalOk(s.effectiveFrom, s.effectiveTo, ref);
    constraintOk(s.constraint, ref, s.id);
    selectorOk(s.locations, s.constraint, ref, s.id);
    if (!primaryParts.has(`${s.componentId}|${s.primaryPartNo}`)) {
      warn("SUBSTITUTE_UNUSED", `${ref} stands in for ${s.primaryPartNo}, which no rule for ${s.componentId} selects.`, [s.id]);
      continue;
    }
    // the index's usable set decides; the listed set is built only to tell staged data from unreachable data
    const subSet = index.substituteMatch.get(s.id) ?? NO_MATCH;
    if (subSet.empty) {
      if (buildMatchSet(content, revisions, s.constraint, s.locations, s.componentId, "listed").empty)
        err("UNREACHABLE_SUBSTITUTE", `${ref} cannot match any location in any configuration.`, [s.id]);
      else warn("SUBSTITUTE_UNRELEASED_ONLY", `${ref} reaches only unreleased configurations, so no lookup can offer it until they are released.`, [s.id]);
    } else if (!content.rules.some((r) => r.componentId === s.componentId && r.partNo === s.primaryPartNo && matchSetsIntersect(ruleSet(r.id), subSet)))
      warn("SUBSTITUTE_UNREACHABLE", `${ref} covers no location where a rule selects ${s.primaryPartNo}, so it can never be offered.`, [s.id]);
  }
  const ruleIds = new Set(content.rules.map((r) => r.id));
  for (const p of content.pendingChanges) {
    if (!ruleIds.has(p.ruleId)) err("ORPHAN", `Pending change ${p.id} refers to unknown rule ${p.ruleId}.`, [p.id]);
    if (p.sourceId !== null && !sources.has(p.sourceId)) err("ORPHAN", `Pending change ${p.id} cites unknown source ${p.sourceId}.`, [p.id]);
  }
  findings.push(...validateKits(content.kitChildren, parts, units, sources, index.kits));
  // A kit child citing an unreleased source makes every rule or alternate that needs it ineligible at lookup (D3).
  const sourceById = new Map(content.sources.map((s) => [s.id, s]));
  for (const k of content.kitChildren) {
    const source = sourceById.get(k.sourceId);
    if (source && !source.released) {
      warn(
        "KIT_SOURCE_UNRELEASED",
        `Kit line ${k.parentPartNo}>${k.childPartNo} cites unreleased source ${k.sourceId}; no lookup can select ${k.parentPartNo} or any kit containing it.`,
        [`${k.parentPartNo}>${k.childPartNo}`],
      );
    }
  }

  for (const c of content.layoutCategories) {
    for (const x of c.crosswalk)
      if (!revisions.has(x.layoutRevisionId)) err("ORPHAN", `Layout category ${c.id} crosswalks to unknown layout revision ${x.layoutRevisionId}.`, [c.id]);
    for (const claim of c.claims) if (!sources.has(claim.sourceId)) err("ORPHAN", `Layout category ${c.id} cites unknown source ${claim.sourceId}.`, [c.id]);
    if (c.seatSetStatus === "not-supplied" && c.crosswalk.length > 0)
      err("CROSSWALK", `Layout category ${c.id} has no supplied seat set but is crosswalked to a layout.`, [c.id]);
  }
  return findings;
}

export function hasBlockingFindings(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === "error");
}
