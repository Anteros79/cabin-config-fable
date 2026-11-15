import type {
  CabinLocation,
  ComponentDef,
  ComponentResolution,
  FrozenRule,
  LayoutRevision,
  Resolution,
  SourceArtifact,
  VisitRecord,
} from "../domain/types.ts";
import type { LocationState } from "./scene/CabinScene.ts";

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
      flags.set(id, { recorded: 0, unresolved: 0, resolved: 0 });
    }
    return s;
  };
  if (ws.resolution) {
    for (const c of ws.resolution.components) {
      const s = at(c.locationId);
      const f = flags.get(c.locationId)!;
      if (c.status === "RESOLVED") f.resolved += 1;
      else {
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
  return parts.join(", ");
}
