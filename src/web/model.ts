import { classify, currentClass as currentObservationClass, isMustFixNow, isOverdue, seatIsBlocked } from "../domain/observations.ts";
import { aggregateStatus, type LocationStatus } from "../domain/status.ts";
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
  Report,
  ReportPieceOutcome,
  Resolution,
  SourceArtifact,
  VisitRecord,
} from "../domain/types.ts";
import type { LocationState } from "./scene/CabinScene.ts";

export type { LocationStatus } from "../domain/status.ts";
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

/** The "Blocked" mark of a seat that an open deferral blocks: a bar across the disc, in the same 24 × 24 box. */
export const BLOCKED_GLYPH_PATH = "M7 12h10";

/** The problem statuses: a badge shows their words as well as their glyph, and a button's accessible name carries them. */
const PROBLEM_STATUSES: readonly LocationStatus[] = ["mustFix", "deferred", "carried", "noted"];
/** The words a problem status adds to a name ("Must fix"), or "" for any other status. */
export const problemStatusText = (status: LocationStatus | undefined): string =>
  status && PROBLEM_STATUSES.includes(status) ? STATUS_ENCODING[status].label : "";

export { aggregateStatus } from "../domain/status.ts";

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
  /**
   * A completed visit is frozen (R44): its piece statuses and blocked seats are those of its stored report, never the
   * tail's live problems, and `observations` holds the report's copies. Absent where the workspace is live.
   */
  frozen?: FrozenOutcomes;
}

/** What a completed visit shows, from its stored report. Empty for a /1 or /2 report, which has no outcomes: records only. */
export interface FrozenOutcomes {
  pieceOutcomes: readonly ReportPieceOutcome[];
  blockedSeats: readonly string[];
}

/** No outcomes and no blocked seats: a completed visit whose report has not loaded yet, or a /1 or /2 report. */
export const RECORDS_ONLY: FrozenOutcomes = { pieceOutcomes: [], blockedSeats: [] };

/**
 * A completed visit's frozen view from its stored report: the piece outcomes, the blocked seats, and this visit's own
 * problems as the report recorded them (its open lists, then those closed in it). A report without outcomes gives none.
 */
export function frozenFromReport(report: Report): { frozen: FrozenOutcomes; observations: Observation[] } {
  const ob = report.observations;
  const own = ob ? [...ob.deferred, ...ob.mustFix.filter((o) => o.openedInVisitId === report.visit.id), ...ob.noted, ...ob.closed] : [];
  return {
    frozen: { pieceOutcomes: report.pieceOutcomes ?? [], blockedSeats: report.blockedSeats ?? [] },
    observations: own,
  };
}

/** The highest status the frozen outcomes give a piece, or null when they name it not at all. */
function frozenStatus(frozen: FrozenOutcomes, locationId: string, componentId: string): LocationStatus | null {
  const here = frozen.pieceOutcomes.filter((o) => o.locationId === locationId && o.componentId === componentId).map((o) => o.status);
  return here.length === 0 ? null : aggregateStatus(here);
}

interface PlacedProblem {
  observation: Observation;
  locationId: string;
  carried: boolean;
}
interface OpenProblems {
  placed: PlacedProblem[];
  /** the same observations with `locationId` set to where they sit on this layout, for the display's seat-block check */
  open: Observation[];
  /** every open observation on the tail at its STORED location id, orphans included: the class is judged here, as the server does (R35) */
  stored: Observation[];
}

/**
 * The observations that are open now, this visit's and carried, each with the location it sits at on this layout. An id
 * appears once; this visit's copy wins. A frozen workspace has none: its statuses come from its report.
 */
function openPlaced(ws: Workspace): OpenProblems {
  if (ws.frozen) return { placed: [], open: [], stored: [] };
  const own = ws.observations
    .filter((o) => o.status === "OPEN")
    .map((observation): PlacedProblem => ({ observation, locationId: observation.locationId, carried: false }));
  const seen = new Set(own.map((p) => p.observation.id));
  const carried = ws.carried.flatMap((c): PlacedProblem[] =>
    c.locationId === null || seen.has(c.observation.id) ? [] : [{ observation: c.observation, locationId: c.locationId, carried: true }],
  );
  const placed = [...own, ...carried];
  const orphaned = ws.carried.filter((c) => c.locationId === null && !seen.has(c.observation.id)).map((c) => c.observation);
  return { placed, open: placed.map((p) => ({ ...p.observation, locationId: p.locationId })), stored: [...placed.map((p) => p.observation), ...orphaned] };
}

/** The class of a problem now, judged as the server's completion gate does. `stored` carries each problem at its stored location id. */
function currentClass(ws: Workspace, stored: Observation[], o: Observation): MelClass {
  return currentObservationClass(o, { mel: ws.mel, variant: ws.variantId ?? "", open: stored, onDate: ws.checkDate });
}

/** A problem that must be fixed before flight: marked so, or no-go now. A noted problem never is. Mirrors the server's completion gate. */
const isMustFix = (ws: Workspace, stored: Observation[], o: Observation): boolean => isMustFixNow(o, currentClass(ws, stored, o));

/**
 * Every open problem on the tail that must be fixed before flight: this visit's and carried ones, including those no
 * longer at their position (`locationId` null) and MEL deferrals past due. Completing with any needs "Aircraft held".
 */
export function openMustFix(ws: Workspace): { observation: Observation; locationId: string | null; overdue: boolean }[] {
  const { placed, stored } = openPlaced(ws);
  const orphaned = ws.carried.filter((c) => c.locationId === null && !placed.some((p) => p.observation.id === c.observation.id));
  return [
    ...placed.map((p) => ({ observation: p.observation, locationId: p.locationId })),
    ...orphaned.map((c) => ({ observation: c.observation, locationId: null })),
  ]
    .filter((p) => isMustFix(ws, stored, p.observation))
    .map((p) => ({ ...p, overdue: p.observation.outcome === "DEFERRED" && isOverdue(p.observation.dueDate, ws.checkDate) }));
}

/**
 * This visit's open problems for the work list (R41), in the order they were written down, each with the status word
 * the map gives its piece: Must fix (marked so, or no-go now), Deferred, Carried (one opened in an earlier check and
 * changed in this one) or Noted.
 */
export function workListProblems(ws: Workspace): { observation: Observation; status: LocationStatus }[] {
  const { frozen } = ws;
  if (frozen) {
    // the report's own open problems, each with the status its piece has in the report
    const byOutcome = (o: Observation): LocationStatus => (o.outcome === "MUST_FIX" ? "mustFix" : o.outcome === "NOTED" ? "noted" : "deferred");
    return ws.observations
      .filter((o) => o.status === "OPEN")
      .map((o) => {
        const piece = frozenStatus(frozen, o.locationId, o.componentId);
        return { observation: o, status: piece && problemStatusText(piece) ? piece : byOutcome(o) };
      });
  }
  const { placed, stored } = openPlaced(ws);
  const carried = new Set(ws.carried.map((c) => c.observation.id));
  return placed
    .filter((p) => !p.carried)
    .map(({ observation: o }) => ({
      observation: o,
      status: isMustFix(ws, stored, o) ? "mustFix" : o.outcome === "NOTED" ? "noted" : carried.has(o.id) ? "carried" : "deferred",
    }));
}

/** The status a piece's open problems give it, or null when it has none. */
function problemStatus(ws: Workspace, problems: OpenProblems, locationId: string, componentId: string): LocationStatus | null {
  if (ws.frozen) {
    const status = frozenStatus(ws.frozen, locationId, componentId);
    return status && problemStatusText(status) ? status : null;
  }
  const { placed, stored } = problems;
  const here = placed.filter((p) => p.locationId === locationId && p.observation.componentId === componentId);
  if (here.length === 0) return null;
  if (here.some((p) => isMustFix(ws, stored, p.observation))) return "mustFix";
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
  const seatBlocked = ws.frozen ? ws.frozen.blockedSeats.includes(location.id) : seatIsBlocked(problems.open, location.id);
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
  for (const id of ws.frozen?.blockedSeats ?? []) flags.blocked.add(id);
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
