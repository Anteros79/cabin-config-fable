import type { CabinLocation, ComponentDef, ComponentResolution, FrozenRule, LayoutRevision, Resolution, SourceArtifact, VisitRecord } from "../domain/types.ts";
import type { LocationState } from "./scene/CabinScene.ts";

/**
 * The work status of a location or one of its components: a replacement is recorded, the component is unresolved, an
 * approved alternate part is eligible here (and nothing is recorded yet), or none of these.
 */
export type LocationStatus = "recorded" | "unresolved" | "alternate" | "none";
export type StatusGlyph = "tick" | "question" | "alternate" | "none";

/**
 * How each status is shown, so the 3D badges, the map and the legends cannot disagree (WEB-21). Status never rests on
 * colour alone: every status but "none" has its own glyph, drawn in a disc of its colour token. "none" shows nothing.
 */
export const STATUS_ENCODING: Record<LocationStatus, { glyph: StatusGlyph; token: string; label: string }> = {
  recorded: { glyph: "tick", token: "--status-recorded", label: "Recorded" },
  unresolved: { glyph: "question", token: "--status-unresolved", label: "Unresolved" },
  alternate: { glyph: "alternate", token: "--status-alternate", label: "Has alternate" },
  none: { glyph: "none", token: "", label: "No status" },
};

/**
 * Each glyph as an SVG path in a 24 × 24 box centred on (12, 12), drawn as a round-capped stroke. The map and legends
 * render it as inline SVG and the 3D badge atlas strokes the same path on a canvas.
 */
export const GLYPH_PATHS: Record<Exclude<StatusGlyph, "none">, string> = {
  tick: "M6.5 12.5l3.6 3.6L17.6 8.4",
  question: "M9 9.4a3.1 3.1 0 1 1 4.6 2.7c-1 .55-1.6 1.2-1.6 2.3v.5M12 17.6v.1",
  alternate: "M6 9.5h11M14 6.5l3 3-3 3M18 14.5H7M10 11.5l-3 3 3 3",
};

/**
 * The status a whole location shows: an unresolved component wins (the location still needs attention, even with other
 * parts recorded), then a record, then an eligible alternate.
 */
export function aggregateStatus(statuses: Iterable<LocationStatus>): LocationStatus {
  let out: LocationStatus = "none";
  const rank: Record<LocationStatus, number> = { none: 0, alternate: 1, recorded: 2, unresolved: 3 };
  for (const s of statuses) if (rank[s] > rank[out]) out = s;
  return out;
}

/** What the viewer, the map, the inspector and the work list all render from. */
export interface Workspace {
  /** visit: frozen snapshot, records may be editable. preview: live lookup, read-only. explore: a layout with no tail. */
  mode: "visit" | "preview" | "explore";
  layout: LayoutRevision;
  resolution: Resolution | null;
  componentDefs: Record<string, ComponentDef>;
  records: VisitRecord[];
  editable: boolean;
  /** why nothing can be resolved here (explore mode) */
  unresolvedReason: string | null;
}

export interface ComponentView {
  componentId: string;
  name: string;
  maxReplacements: number;
  countNote: string;
  status: "RESOLVED" | "NO_MATCH" | "AMBIGUOUS" | "NOT_SUPPLIED";
  rule: FrozenRule | null;
  resolution: ComponentResolution | null;
  record: VisitRecord | null;
}

export function componentsAt(ws: Workspace, location: CabinLocation): ComponentView[] {
  return location.componentIds.map((componentId) => {
    const def = ws.componentDefs[componentId];
    const resolution = ws.resolution?.components.find((c) => c.locationId === location.id && c.componentId === componentId) ?? null;
    const rule = resolution?.status === "RESOLVED" ? (ws.resolution?.rules[resolution.ruleId] ?? null) : null;
    return {
      componentId,
      name: def?.name ?? componentId,
      maxReplacements: def?.maxReplacementsPerLocation ?? 1,
      countNote: def?.countNote ?? "",
      status: resolution ? resolution.status : "NOT_SUPPLIED",
      rule,
      resolution,
      record: ws.records.find((r) => r.locationId === location.id && r.componentId === componentId) ?? null,
    };
  });
}

export interface LocationFlags {
  recorded: number;
  unresolved: number;
  resolved: number;
  /** components with an eligible alternate part and no record */
  alternate: number;
  /** what the location shows: aggregateStatus() of its components */
  status: LocationStatus;
}

/** One pass over the resolution: status per location and component for the 3D scene and the map. */
export function buildStates(ws: Workspace): { scene: Map<string, LocationState>; flags: Map<string, LocationFlags> } {
  const scene = new Map<string, LocationState>();
  const flags = new Map<string, LocationFlags>();
  const at = (id: string) => {
    let s = scene.get(id);
    if (!s) {
      s = { components: {} };
      scene.set(id, s);
      flags.set(id, { recorded: 0, unresolved: 0, resolved: 0, alternate: 0, status: "none" });
    }
    return s;
  };
  if (ws.resolution) {
    for (const c of ws.resolution.components) {
      const s = at(c.locationId);
      const f = flags.get(c.locationId)!;
      if (c.status === "RESOLVED") {
        f.resolved += 1;
        // An approved alternate eligible at this location (PF-15); a record made later overrides it below.
        const rule = ws.resolution.rules[c.ruleId];
        if (rule?.substitutes.some((sub) => sub.locationIds === null || sub.locationIds.includes(c.locationId))) s.components[c.componentId] = "alternate";
      } else {
        s.components[c.componentId] = "unresolved";
        f.unresolved += 1;
      }
    }
  }
  for (const r of ws.records) {
    const s = at(r.locationId);
    s.components[r.componentId] = "recorded";
    flags.get(r.locationId)!.recorded += 1;
  }
  for (const [id, s] of scene) {
    const f = flags.get(id);
    if (!f) continue;
    const values = Object.values(s.components);
    f.alternate = values.filter((v) => v === "alternate").length;
    f.status = aggregateStatus(values);
  }
  return { scene, flags };
}

export function sourceText(sources: Record<string, SourceArtifact> | undefined, id: string): string {
  const s = sources?.[id];
  if (!s) return id;
  const validity = `${s.effectiveFrom ?? "start not stated"} to ${s.expiresOn ?? "no expiry"}`;
  return `${s.id} rev ${s.revision} (${s.kind}; ${s.released ? "released" : "NOT released"}; ${validity})`;
}

export function describeSeat(location: CabinLocation): string[] {
  const s = location.seat;
  if (!s) return [];
  const out = [`Printed row ${s.printedRow}, letter ${s.letter}, ${s.side === "L" ? "left (A-C)" : "right (D-F)"} side, physical row ${s.physicalRow}`];
  if (s.positionType) out.push(`Position: ${s.positionType.toLowerCase()}`);
  if (s.maintenanceZone) out.push(`Fixture maintenance zone: ${s.maintenanceZone}`);
  if (s.commercialTier) out.push(`Commercial tier (as claimed): ${s.commercialTier}`);
  if (s.pitch) out.push(`Pitch claim: ${s.pitch.approximate ? "about " : ""}${s.pitch.raw} ${s.pitch.unit}${s.pitch.note ? ` - ${s.pitch.note}` : ""}`);
  if (s.width) out.push(`Width claim: ${s.width.raw} ${s.width.unit} (measurement kind ${s.width.measurementKind})`);
  if (s.exitRow !== null) out.push(`Exit seat/row flag: ${s.exitRow ? "yes" : "no"}`);
  if (s.bulkhead !== null) out.push(`Bulkhead seat flag: ${s.bulkhead ? "yes" : "no"}`);
  out.push(`Hardware group: ${s.seatGroup ?? "not established by the sources"}`);
  return out;
}

export function seatLabelFor(location: CabinLocation, flags: LocationFlags | undefined): string {
  const parts = [location.label];
  const s = location.seat;
  if (s?.maintenanceZone) parts.push(`zone ${s.maintenanceZone}`);
  if (s?.commercialTier) parts.push(s.commercialTier);
  if (flags?.recorded) parts.push(`${flags.recorded} replacement${flags.recorded === 1 ? "" : "s"} recorded`);
  if (flags?.unresolved) parts.push(`${flags.unresolved} component${flags.unresolved === 1 ? "" : "s"} unresolved`);
  if (flags?.alternate) parts.push(alternateText(flags.alternate));
  return parts.join(", ");
}

/** Words for components that have an eligible alternate part, for accessible names. */
export function alternateText(count: number): string {
  return `${count} component${count === 1 ? " has" : "s have"} an alternate part`;
}

/**
 * Pairs each item with a React key built from its content. A repeat of the same content gets
 * an occurrence number, so keys stay unique and stable when the list is read again.
 */
export function contentKeyed<T>(items: readonly T[], keyOf: (item: T) => string): [string, T][] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = keyOf(item);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return [n === 0 ? base : `${base}#${n}`, item];
  });
}
