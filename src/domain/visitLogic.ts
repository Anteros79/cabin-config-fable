import type { FrozenRule, LookupResult, PartLine, RecordInput, ReferenceRelease, VisitSnapshot } from "./types.ts";
import { DATE_RULE } from "./types.ts";

export class DomainError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(code: string, message: string, status = 422, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Freeze everything needed to reproduce a visit. The snapshot is self-contained data, not
 * pointers to live reference records, so later reference releases cannot change it.
 */
export function buildSnapshot(release: ReferenceRelease, result: LookupResult, capturedAt: string): VisitSnapshot {
  if (result.referenceReleaseId !== release.id) {
    throw new DomainError("RELEASE_MISMATCH", "The lookup result does not belong to this reference release.", 500);
  }
  if ((result.state !== "RESOLVED" && result.state !== "PARTIAL") || !result.context || !result.resolution) {
    throw new DomainError("CONFIGURATION_NOT_RESOLVED", `A visit needs an unambiguous valid configuration. ${result.message}`, 422, {
      state: result.state,
      reasonCode: result.reasonCode,
    });
  }
  return structuredClone({
    schema: "cabin-kit.snapshot/1" as const,
    capturedAt,
    referenceReleaseId: release.id,
    referenceContentHash: release.contentHash,
    tail: result.tail,
    checkDate: result.checkDate,
    lookupState: result.state,
    context: result.context,
    resolution: result.resolution,
    dateRule: DATE_RULE,
    geometryVersion: result.context.layoutRevision.geometry.version,
  });
}

const RECORD_FIELDS = new Set(["locationId", "componentId", "selection", "substituteId", "quantity", "note", "ruleId", "partNo", "unit"]);

export interface DerivedRecord extends RecordInput {
  ruleId: string;
  primaryPartNo: string;
  locationLabel: string;
  componentName: string;
  lines: PartLine[];
}

/**
 * Authoritative validation of one replacement record against the frozen snapshot.
 * Part lines, quantities, units and mandatory children are always derived here;
 * anything the client claims about them is either checked or refused.
 */
export function deriveRecord(snapshot: VisitSnapshot, raw: unknown): DerivedRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DomainError("INVALID_RECORD", "The replacement record must be an object.");
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!RECORD_FIELDS.has(key)) {
      throw new DomainError("UNSUPPORTED_FIELD", `Field "${key}" is not accepted. Part lines and totals are derived by the server.`);
    }
  }
  const { locationId, componentId, selection, quantity } = input;
  const substituteId = input.substituteId ?? null;
  const note = input.note ?? "";
  if (typeof locationId !== "string" || locationId.length === 0 || locationId.length > 80)
    throw new DomainError("INVALID_LOCATION", "A location id is required.");
  if (typeof componentId !== "string" || componentId.length === 0 || componentId.length > 80)
    throw new DomainError("INVALID_COMPONENT", "A component id is required.");
  if (selection !== "PRIMARY" && selection !== "ALTERNATE") throw new DomainError("INVALID_SELECTION", "Selection must be PRIMARY or ALTERNATE.");
  if (typeof quantity !== "number" || !Number.isInteger(quantity)) throw new DomainError("INVALID_QUANTITY", "Quantity must be a whole number.");
  if (typeof note !== "string" || note.length > 1000) throw new DomainError("INVALID_NOTE", "The note must be text of at most 1000 characters.");
  if (substituteId !== null && typeof substituteId !== "string") throw new DomainError("INVALID_SUBSTITUTE", "The alternate id must be text.");

  const location = snapshot.context.layoutRevision.locations.find((l) => l.id === locationId);
  if (!location) throw new DomainError("UNKNOWN_LOCATION", `Location ${locationId} is not part of this visit's frozen layout.`);
  if (!location.componentIds.includes(componentId)) {
    throw new DomainError("INCOMPATIBLE_COMPONENT", `Component ${componentId} cannot be replaced at ${location.label}.`);
  }
  const resolution = snapshot.resolution.components.find((c) => c.locationId === locationId && c.componentId === componentId);
  if (!resolution || resolution.status !== "RESOLVED") {
    throw new DomainError(
      "UNRESOLVED_COMPONENT",
      `No applicable part is resolved for ${componentId} at ${location.label}; unresolved components cannot be recorded.`,
      422,
      resolution,
    );
  }
  const rule: FrozenRule | undefined = snapshot.resolution.rules[resolution.ruleId];
  if (!rule) throw new DomainError("SNAPSHOT_INCONSISTENT", "The frozen snapshot is missing the resolved rule.", 500);
  const def = snapshot.resolution.componentDefs[componentId];
  const max = def?.maxReplacementsPerLocation ?? 1;
  if (quantity < 1 || quantity > max) {
    throw new DomainError("INVALID_QUANTITY", `Replacements for ${def?.name ?? componentId} at one location must be between 1 and ${max}.`);
  }
  if (input.ruleId !== undefined && input.ruleId !== rule.id) {
    throw new DomainError("RULE_NOT_APPLICABLE", "The submitted rule does not apply to this location and component in this visit.");
  }

  const lines: PartLine[] = [];
  let selectedPartNo = rule.partNo;
  let selectedUnit = rule.unit;
  if (selection === "PRIMARY") {
    if (substituteId !== null) throw new DomainError("INVALID_SUBSTITUTE", "A primary selection cannot name an alternate.");
    lines.push({
      partNo: rule.partNo,
      description: rule.partDescription,
      qty: quantity * rule.qtyPerReplacement,
      unit: rule.unit,
      role: "PRIMARY",
      parentPartNo: null,
      sourceId: rule.sourceId,
    });
    for (const child of rule.children) {
      lines.push({
        partNo: child.partNo,
        description: child.description,
        qty: quantity * rule.qtyPerReplacement * child.qty,
        unit: child.unit,
        role: "MANDATORY_CHILD",
        parentPartNo: rule.partNo,
        sourceId: child.sourceId,
      });
    }
  } else {
    if (substituteId === null) throw new DomainError("INVALID_SUBSTITUTE", "An alternate selection must name the approved alternate.");
    const sub = rule.substitutes.find((s) => s.id === substituteId);
    if (!sub || (sub.locationIds !== null && !sub.locationIds.includes(locationId))) {
      throw new DomainError("SUBSTITUTE_NOT_APPROVED", "That alternate is not approved for this component, location and check date in this visit.");
    }
    selectedPartNo = sub.altPartNo;
    selectedUnit = sub.unit;
    lines.push({
      partNo: sub.altPartNo,
      description: sub.altDescription,
      qty: quantity * sub.qtyPerReplacement,
      unit: sub.unit,
      role: "ALTERNATE",
      parentPartNo: null,
      sourceId: sub.sourceId,
    });
    for (const child of sub.children) {
      lines.push({
        partNo: child.partNo,
        description: child.description,
        qty: quantity * sub.qtyPerReplacement * child.qty,
        unit: child.unit,
        role: "MANDATORY_CHILD",
        parentPartNo: sub.altPartNo,
        sourceId: child.sourceId,
      });
    }
  }
  if (input.partNo !== undefined && input.partNo !== selectedPartNo) {
    throw new DomainError("PART_MISMATCH", "The submitted part number is not the part resolved for this selection.");
  }
  if (input.unit !== undefined && input.unit !== selectedUnit) {
    throw new DomainError("UNIT_MISMATCH", "The submitted unit is not the unit resolved for this selection.");
  }
  return {
    locationId,
    componentId,
    selection,
    substituteId,
    quantity,
    note: note.trim(),
    ruleId: rule.id,
    primaryPartNo: rule.partNo,
    locationLabel: location.label,
    componentName: def?.name ?? componentId,
    lines,
  };
}
