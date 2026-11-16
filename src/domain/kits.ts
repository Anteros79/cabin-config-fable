import type { Finding, KitChild, Part } from "./types.ts";

export interface ExpandedChild {
  partNo: string;
  description: string;
  qty: number;
  unit: string;
  sourceId: string;
}

export class KitError extends Error {}

/**
 * Every mandatory descendant of one unit of `partNo`, with quantities multiplied through nested
 * kits. Lines with the same part, unit and source are merged.
 */
export function expandKit(partNo: string, byParent: Map<string, KitChild[]>, parts: Map<string, Part>): ExpandedChild[] {
  const merged = new Map<string, ExpandedChild>();
  const walk = (parent: string, multiplier: number, trail: string[]) => {
    for (const child of byParent.get(parent) ?? []) {
      if (trail.includes(child.childPartNo)) {
        throw new KitError(`Cyclic kit definition: ${[...trail, child.childPartNo].join(" -> ")}`);
      }
      const qty = multiplier * child.qty;
      const key = `${child.childPartNo}\u0000${child.unit}\u0000${child.sourceId}`;
      const existing = merged.get(key);
      if (existing) existing.qty += qty;
      else {
        merged.set(key, {
          partNo: child.childPartNo,
          description: parts.get(child.childPartNo)?.description ?? "",
          qty,
          unit: child.unit,
          sourceId: child.sourceId,
        });
      }
      walk(child.childPartNo, qty, [...trail, child.childPartNo]);
    }
  };
  walk(partNo, 1, [partNo]);
  return [...merged.values()].sort((a, b) => a.partNo.localeCompare(b.partNo) || a.unit.localeCompare(b.unit));
}

/** Import-time checks: invalid, duplicate, conflicting and cyclic kit definitions. */
export function validateKits(kitChildren: KitChild[], parts: Map<string, Part>, units: string[], sourceIds: Set<string>): Finding[] {
  const findings: Finding[] = [];
  const seen = new Map<string, KitChild>();
  for (const k of kitChildren) {
    const ref = `${k.parentPartNo}>${k.childPartNo}`;
    if (!parts.has(k.parentPartNo))
      findings.push({ severity: "error", code: "KIT_ORPHAN_PARENT", message: `Kit parent ${k.parentPartNo} is not a known part.`, refs: [ref] });
    if (!parts.has(k.childPartNo))
      findings.push({ severity: "error", code: "KIT_ORPHAN_CHILD", message: `Kit child ${k.childPartNo} is not a known part.`, refs: [ref] });
    if (!sourceIds.has(k.sourceId))
      findings.push({ severity: "error", code: "KIT_ORPHAN_SOURCE", message: `Kit line ${ref} cites unknown source ${k.sourceId}.`, refs: [ref] });
    if (k.parentPartNo === k.childPartNo)
      findings.push({ severity: "error", code: "KIT_SELF_REFERENCE", message: `Kit ${k.parentPartNo} lists itself as a child.`, refs: [ref] });
    if (!Number.isInteger(k.qty) || k.qty <= 0)
      findings.push({ severity: "error", code: "KIT_INVALID_QUANTITY", message: `Kit line ${ref} has invalid quantity ${k.qty}.`, refs: [ref] });
    if (!units.includes(k.unit))
      findings.push({ severity: "error", code: "KIT_UNKNOWN_UNIT", message: `Kit line ${ref} uses unknown unit ${k.unit}.`, refs: [ref] });
    const prior = seen.get(ref);
    if (prior) {
      const same = prior.qty === k.qty && prior.unit === k.unit && prior.sourceId === k.sourceId;
      findings.push({
        severity: "error",
        code: same ? "KIT_DUPLICATE" : "KIT_CONFLICT",
        message: same
          ? `Kit line ${ref} is defined more than once.`
          : `Kit line ${ref} has conflicting definitions (${prior.qty} ${prior.unit} vs ${k.qty} ${k.unit}).`,
        refs: [ref],
      });
    } else seen.set(ref, k);
  }
  // cycle detection over the parent -> child graph
  const graph = new Map<string, string[]>();
  for (const k of kitChildren) {
    if (k.parentPartNo === k.childPartNo) continue;
    graph.set(k.parentPartNo, [...(graph.get(k.parentPartNo) ?? []), k.childPartNo]);
  }
  const state = new Map<string, 1 | 2>();
  const reported = new Set<string>();
  const visit = (node: string, trail: string[]) => {
    if (state.get(node) === 2) return;
    if (state.get(node) === 1) {
      const cycle = [...trail.slice(trail.indexOf(node)), node];
      const key = [...cycle].sort().join("|");
      if (!reported.has(key)) {
        reported.add(key);
        findings.push({ severity: "error", code: "KIT_CYCLE", message: `Cyclic kit definition: ${cycle.join(" -> ")}.`, refs: cycle });
      }
      return;
    }
    state.set(node, 1);
    for (const next of graph.get(node) ?? []) visit(next, [...trail, node]);
    state.set(node, 2);
  };
  for (const node of graph.keys()) visit(node, []);
  return findings;
}
