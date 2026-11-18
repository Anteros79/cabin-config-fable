import { classify, effectiveClass, seatIsBlocked } from "../domain/observations.ts";
import type {
  CabinLocation,
  CarriedObservation,
  ComponentDef,
  ComponentResolution,
  Condition,
  FrozenRule,
  LayoutRevision,
  MelClass,
  MelEntry,
  Observation,
  Resolution,
  SourceArtifact,
  VisitRecord,
} from "../domain/types.ts";
import type { LocationState } from "./scene/CabinScene.ts";

/**
 * The work status of a location or one of its components. Problems come from observations: must fix, deferred (opened in
 * this visit), carried (a deferral from an earlier visit) and noted. The rest come from records and the resolution: a
 * replacement is recorded, the component is unresolved, an approved alternate part is eligible here (and nothing is
 * recorded yet), or none of these. The union is in rank order, highest first (aggregateStatus).
 */
export type LocationStatus = "mustFix" | "unresolved" | "deferred" | "carried" | "noted" | "recorded" | "alternate" | "none";
export type StatusGlyph = "tick" | "question" | "alternate" | "none";

/**
 * How each status is shown, so the 3D badges, the map and the legends cannot disagree (WEB-21). Status never rests on
 * colour alone: every status but "none" has its own glyph, drawn in a disc of its colour token. "none" shows nothing.
 */
export const STATUS_ENCODING: Record<LocationStatus, { glyph: StatusGlyph; token: string; label: string }> = {
  // The problem statuses have no glyph or token yet: they show as a 3D tint and as text until their encoding lands.
  mustFix: { glyph: "none", token: "", label: "Must fix" },
  deferred: { glyph: "none", token: "", label: "Deferred" },
  carried: { glyph: "none", token: "", label: "Carried" },
  noted: { glyph: "none", token: "", label: "Noted" },
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
 * The status a whole location shows, the highest-ranked of its pieces: a must-fix problem, an unresolved component (the
 * location still needs attention, even with other parts recorded), a deferral, a carried deferral, a noted problem, a
 * record, then an eligible alternate.
 */
export function aggregateStatus(statuses: Iterable<LocationStatus>): LocationStatus {
  let out: LocationStatus = "none";
  const rank: Record<LocationStatus, number> = { none: 0, alternate: 1, recorded: 2, noted: 3, carried: 4, deferred: 5, unresolved: 6, mustFix: 7 };
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
  /** The visit's own observations (opened or closed in it). Empty where there is no visit. */
  observations: Observation[];
  /** The tail's other open deferred and must-fix observations, placed on this layout. Empty where there is no visit. */
  carried: CarriedObservation[];
  /** The visit's check date (YYYY-MM-DD): overdue is judged against it, never the clock. */
  checkDate: string;
  /** The MEL frozen in the visit's snapshot. Empty where there is no visit. */
  mel: MelEntry[];
  /** The tail's maintenance variant, which picks the MEL entry. Without it only entries that name no variant apply. */
  variantId?: string;
}

/** The observations that are open now, this visit's and carried, each with the location it sits at on this layout. */
function openPlaced(ws: Workspace): { observation: Observation; locationId: string; carried: boolean }[] {
  const own = ws.observations.filter((o) => o.status === "OPEN").map((observation) => ({ observation, locationId: observation.locationId, carried: false }));
  const carried = ws.carried.flatMap((c) => (c.locationId === null ? [] : [{ observation: c.observation, locationId: c.locationId, carried: true }]));
  return [...own, ...carried];
}

const CLASS_RANK: Record<MelClass["class"], number> = { COSMETIC: 0, MEL: 1, NO_GO: 2 };

/** The class of a problem now: re-classified against the MEL with the seat-blocked state of the other open problems, never below its stored class, NO_GO once an MEL deferral is overdue. Mirrors the server. */
function currentClass(ws: Workspace, open: Observation[], o: Observation): MelClass {
  const others = open.filter((x) => x.id !== o.id);
  const now = classify({
    mel: ws.mel,
    componentId: o.componentId,
    condition: o.condition,
    variant: ws.variantId ?? "",
    seatBlocked: seatIsBlocked(others, o.locationId),
    ...(o.raisedTo !== undefined ? { raisedTo: o.raisedTo } : {}),
  });
  const melClass = CLASS_RANK[now.class] > CLASS_RANK[o.melClass.class] ? now : o.melClass;
  return effectiveClass({ ...o, melClass }, ws.checkDate);
}

/** The status a piece's open problems give it, or null when it has none. */
function problemStatus(ws: Workspace, placed: ReturnType<typeof openPlaced>, locationId: string, componentId: string): LocationStatus | null {
  const here = placed.filter((p) => p.locationId === locationId && p.observation.componentId === componentId);
  if (here.length === 0) return null;
  const open = placed.map((p) => ({ ...p.observation, locationId: p.locationId }));
  if (here.some((p) => p.observation.outcome === "MUST_FIX" || currentClass(ws, open, p.observation).class === "NO_GO")) return "mustFix";
  if (here.some((p) => p.observation.outcome === "DEFERRED" && !p.carried)) return "deferred";
  if (here.some((p) => p.observation.outcome === "DEFERRED")) return "carried";
  return here.some((p) => p.observation.outcome === "NOTED") ? "noted" : null;
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
  /** open problems opened in this visit on this piece */
  problems: Observation[];
  /** a problem carried over from an earlier visit onto this piece, if any */
  carried: CarriedObservation | null;
  /** the class a problem with this condition would have on this piece now, given the seat-blocked state */
  melClass: (condition: Condition) => MelClass;
  /** what the piece shows: its problems first, then the record-based status */
  pieceStatus: LocationStatus;
}

export function componentsAt(ws: Workspace, location: CabinLocation): ComponentView[] {
  const placed = openPlaced(ws);
  const seatBlocked = seatIsBlocked(
    placed.map((p) => ({ ...p.observation, locationId: p.locationId })),
    location.id,
  );
  return location.componentIds.map((componentId) => {
    const def = ws.componentDefs[componentId];
    const resolution = ws.resolution?.components.find((c) => c.locationId === location.id && c.componentId === componentId) ?? null;
    const rule = resolution?.status === "RESOLVED" ? (ws.resolution?.rules[resolution.ruleId] ?? null) : null;
    const record = ws.records.find((r) => r.locationId === location.id && r.componentId === componentId) ?? null;
    const alternate = rule?.substitutes.some((sub) => sub.locationIds === null || sub.locationIds.includes(location.id)) ?? false;
    const recordStatus: LocationStatus = record ? "recorded" : resolution && resolution.status !== "RESOLVED" ? "unresolved" : alternate ? "alternate" : "none";
    return {
      componentId,
      name: def?.name ?? componentId,
      maxReplacements: def?.maxReplacementsPerLocation ?? 1,
      countNote: def?.countNote ?? "",
      status: resolution ? resolution.status : "NOT_SUPPLIED",
      rule,
      resolution,
      record,
      problems: ws.observations.filter((o) => o.status === "OPEN" && o.locationId === location.id && o.componentId === componentId),
      carried: ws.carried.find((c) => c.locationId === location.id && c.observation.componentId === componentId) ?? null,
      melClass: (condition) => classify({ mel: ws.mel, componentId, condition, variant: ws.variantId ?? "", seatBlocked }),
      pieceStatus: problemStatus(ws, placed, location.id, componentId) ?? recordStatus,
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

/** The per-location flags, with the ids of the seats that an open deferral blocks. */
export type StateFlags = Map<string, LocationFlags> & { blocked: Set<string> };

/** One pass over the resolution: status per location and component for the 3D scene and the map. */
export function buildStates(ws: Workspace): { scene: Map<string, LocationState>; flags: StateFlags } {
  const scene = new Map<string, LocationState>();
  const flags: StateFlags = Object.assign(new Map<string, LocationFlags>(), { blocked: new Set<string>() });
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
  // Problems override the record-based status of their piece.
  const placed = openPlaced(ws);
  for (const location of ws.layout.locations) {
    for (const componentId of location.componentIds) {
      const status = problemStatus(ws, placed, location.id, componentId);
      if (status) at(location.id).components[componentId] = status;
    }
  }
  const open = placed.map((p) => ({ ...p.observation, locationId: p.locationId }));
  for (const o of open) if (seatIsBlocked(open, o.locationId)) flags.blocked.add(o.locationId);
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
