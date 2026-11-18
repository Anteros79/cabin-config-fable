import { classify, effectiveClass, isOverdue, seatIsBlocked } from "../domain/observations.ts";
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
export type StatusGlyph = "tick" | "question" | "alternate" | "alert" | "pause" | "forward" | "note" | "none";

/**
 * How each status is shown, so the 3D badges, the map and the legends cannot disagree (WEB-21). Status never rests on
 * colour alone: every status but "none" has its own glyph, drawn in a disc of its colour token. "none" shows nothing.
 */
export const STATUS_ENCODING: Record<LocationStatus, { glyph: StatusGlyph; token: string; label: string }> = {
  mustFix: { glyph: "alert", token: "--status-mustfix", label: "Must fix" },
  deferred: { glyph: "pause", token: "--status-deferred", label: "Deferred" },
  carried: { glyph: "forward", token: "--status-carried", label: "Carried" },
  noted: { glyph: "note", token: "--status-noted", label: "Noted" },
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
  alert: "M12 6.2v7.4M12 17.6v.1",
  pause: "M9.4 7v10M14.6 7v10",
  forward: "M6.5 12h10.5M13 8l4 4-4 4",
  note: "M7 8.5h10M7 12.5h10M7 16.5h6",
};

/** The problem statuses: a badge shows their words as well as their glyph, and a button's accessible name carries them. */
const PROBLEM_STATUSES: readonly LocationStatus[] = ["mustFix", "deferred", "carried", "noted"];
/** The words a problem status adds to a name ("Must fix"), or "" for any other status. */
export const problemStatusText = (status: LocationStatus | undefined): string =>
  status && PROBLEM_STATUSES.includes(status) ? STATUS_ENCODING[status].label : "";

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

interface PlacedProblem {
  observation: Observation;
  locationId: string;
  carried: boolean;
}
interface OpenProblems {
  placed: PlacedProblem[];
  /** the same observations with `locationId` set to where they sit on this layout, for the seat-block check */
  open: Observation[];
}

/** The observations that are open now, this visit's and carried, each with the location it sits at on this layout. An id appears once; this visit's copy wins. */
function openPlaced(ws: Workspace): OpenProblems {
  const own = ws.observations
    .filter((o) => o.status === "OPEN")
    .map((observation): PlacedProblem => ({ observation, locationId: observation.locationId, carried: false }));
  const seen = new Set(own.map((p) => p.observation.id));
  const carried = ws.carried.flatMap((c): PlacedProblem[] =>
    c.locationId === null || seen.has(c.observation.id) ? [] : [{ observation: c.observation, locationId: c.locationId, carried: true }],
  );
  const placed = [...own, ...carried];
  return { placed, open: placed.map((p) => ({ ...p.observation, locationId: p.locationId })) };
}

const CLASS_RANK: Record<MelClass["class"], number> = { COSMETIC: 0, MEL: 1, NO_GO: 2 };

/** The class of a problem now: re-classified against the MEL with the seat-blocked state of the other open problems, never below its stored class, NO_GO once an MEL deferral is overdue. Mirrors the server. */
function currentClass(ws: Workspace, open: Observation[], o: Observation): MelClass {
  // `open` carries each problem at the location it is placed at on this layout, so the seat-block is judged there.
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

/** A problem that must be fixed before flight: marked so, or no-go now. A noted problem never is. Mirrors the server's completion gate. */
const isMustFix = (ws: Workspace, open: Observation[], o: Observation): boolean =>
  o.outcome !== "NOTED" && (o.outcome === "MUST_FIX" || currentClass(ws, open, o).class === "NO_GO");

/**
 * Every open problem on the tail that must be fixed before flight: this visit's and carried ones, including those no
 * longer at their position (`locationId` null) and MEL deferrals past due. Completing with any needs "Aircraft held".
 */
export function openMustFix(ws: Workspace): { observation: Observation; locationId: string | null; overdue: boolean }[] {
  const { placed, open } = openPlaced(ws);
  const orphaned = ws.carried.filter((c) => c.locationId === null && !placed.some((p) => p.observation.id === c.observation.id));
  return [
    ...placed.map((p) => ({ observation: p.observation, locationId: p.locationId })),
    ...orphaned.map((c) => ({ observation: c.observation, locationId: null })),
  ]
    .filter((p) => isMustFix(ws, open, p.observation))
    .map((p) => ({ ...p, overdue: p.observation.outcome === "DEFERRED" && isOverdue(p.observation.dueDate, ws.checkDate) }));
}

/** The status a piece's open problems give it, or null when it has none. */
function problemStatus(ws: Workspace, problems: OpenProblems, locationId: string, componentId: string): LocationStatus | null {
  const { placed, open } = problems;
  const here = placed.filter((p) => p.locationId === locationId && p.observation.componentId === componentId);
  if (here.length === 0) return null;
  if (here.some((p) => isMustFix(ws, open, p.observation))) return "mustFix";
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
  /** the class a problem with this condition (and the technician's raise, if any) would have on this piece now, given the seat-blocked state */
  melClass: (condition: Condition, raisedTo?: "MEL" | "NO_GO") => MelClass;
  /** what the piece shows: its problems first, then the record-based status */
  pieceStatus: LocationStatus;
}

export function componentsAt(ws: Workspace, location: CabinLocation): ComponentView[] {
  const problems = openPlaced(ws);
  const seatBlocked = seatIsBlocked(problems.open, location.id);
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
      carried:
        (problems.placed.some((p) => p.carried && p.locationId === location.id && p.observation.componentId === componentId)
          ? ws.carried.find((c) => c.locationId === location.id && c.observation.componentId === componentId)
          : undefined) ?? null,
      melClass: (condition, raisedTo) =>
        classify({ mel: ws.mel, componentId, condition, variant: ws.variantId ?? "", seatBlocked, ...(raisedTo !== undefined ? { raisedTo } : {}) }),
      pieceStatus: problemStatus(ws, problems, location.id, componentId) ?? recordStatus,
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
  const problems = openPlaced(ws);
  for (const location of ws.layout.locations) {
    for (const componentId of location.componentIds) {
      const status = problemStatus(ws, problems, location.id, componentId);
      if (status) at(location.id).components[componentId] = status;
    }
  }
  const { open } = problems;
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
  const problem = problemStatusText(flags?.status);
  if (problem) parts.push(problem);
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
