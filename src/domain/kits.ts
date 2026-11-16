import { MAX_DERIVED_QTY, MAX_KIT_DEPTH } from "./limits.ts";
import { compareCodePoints } from "./order.ts";
import type { Finding, KitChild, Part } from "./types.ts";

export interface ExpandedChild {
  partNo: string;
  description: string;
  qty: number;
  unit: string;
  sourceId: string;
}

export type KitErrorCode = "KIT_CYCLE" | "KIT_TOO_DEEP" | "KIT_QTY_OVERFLOW";

export class KitError extends Error {
  readonly code: KitErrorCode;
  /** The part whose kit the problem was found in; kits containing it fail with the same error. */
  readonly partNo: string;
  constructor(code: KitErrorCode, partNo: string, message: string) {
    super(message);
    this.code = code;
    this.partNo = partNo;
  }
}

/**
 * Units that count whole items. A kit line multiplies the kit below its child, which only makes sense
 * when the line counts items; any other vocabulary unit on such a line is warned about.
 */
export const COUNT_UNITS: ReadonlySet<string> = new Set(["EA", "KIT", "PANEL"]);

export interface KitIndex {
  /**
   * Every mandatory descendant of `multiplier` units of `partNo`, with quantities multiplied through
   * nested kits. Lines with the same part, unit and source are merged; output is ordered by part
   * number, unit, then source id. Throws `KitError` when the kit below `partNo` is cyclic, nested
   * deeper than `MAX_KIT_DEPTH`, or has a quantity that is not a safe integer or exceeds `MAX_DERIVED_QTY`.
   */
  expand(partNo: string, multiplier: number): ExpandedChild[];
  /**
   * Every kit line at any depth below `partNo`, each once, parent lines before the lines below them.
   * Never throws: a cyclic kit is walked once round. Uses the same parent -> child lines as `expand`.
   */
  descendantLines(partNo: string): KitChild[];
}

type Expansion = { ok: true; height: number; children: readonly ExpandedChild[] } | { ok: false; error: KitError };

const order = (a: ExpandedChild, b: ExpandedChild) =>
  compareCodePoints(a.partNo, b.partNo) || compareCodePoints(a.unit, b.unit) || compareCodePoints(a.sourceId, b.sourceId);

const qtyOk = (qty: number) => Number.isSafeInteger(qty) && qty <= MAX_DERIVED_QTY;

/**
 * A closed cycle of part numbers (first equals last) rotated to start at its smallest part number
 * (`compareCodePoints`). Where a walk enters a cycle depends on which part is expanded first; the
 * canonical form does not, so a release always reports and freezes the same `KIT_CYCLE` text.
 */
export function canonicalCycle(cycle: readonly string[]): string[] {
  const open = cycle.slice(0, -1);
  const smallest = open.reduce<string | null>((min, partNo) => (min === null || compareCodePoints(partNo, min) < 0 ? partNo : min), null);
  if (smallest === null) return [...cycle];
  const start = open.indexOf(smallest);
  return [...open.slice(start), ...open.slice(0, start), smallest];
}

/**
 * Index the kit structure of a release. Each parent's lines are ordered by child part number, unit,
 * then source id, so results never depend on the order of `kitChildren`. Each part's expansion at
 * multiplier 1 is computed once, on first use, depth-first with an explicit stack and an in-progress
 * set for cycle detection, and kept (failures too, as the `KitError` to rethrow). Shared sub-kits
 * are therefore expanded once, and the total cost is linear in the kit lines and the size of the
 * expansions. A part whose kit fails throws from `expand` only; building the index never throws, so
 * one broken kit cannot stop a lookup.
 */
export function buildKitIndex(kitChildren: readonly KitChild[], parts: ReadonlyMap<string, Part>): KitIndex {
  const byParent = new Map<string, KitChild[]>();
  for (const line of kitChildren) {
    const list = byParent.get(line.parentPartNo);
    if (list) list.push(line);
    else byParent.set(line.parentPartNo, [line]);
  }
  // each parent's lines in a fixed order, so walks (and any cycle they meet) do not depend on input order
  for (const lines of byParent.values()) {
    lines.sort((a, b) => compareCodePoints(a.childPartNo, b.childPartNo) || compareCodePoints(a.unit, b.unit) || compareCodePoints(a.sourceId, b.sourceId));
  }
  const done = new Map<string, Expansion>();

  const finish = (partNo: string): Expansion => {
    const lines = byParent.get(partNo) ?? [];
    const merged = new Map<string, ExpandedChild>();
    let height = 0;
    const add = (partNo: string, unit: string, sourceId: string, qty: number) => {
      const key = `${partNo}\u0000${unit}\u0000${sourceId}`;
      const existing = merged.get(key);
      if (existing) existing.qty += qty;
      else merged.set(key, { partNo, description: parts.get(partNo)?.description ?? "", qty, unit, sourceId });
    };
    for (const line of lines) {
      const below = done.get(line.childPartNo);
      if (!below?.ok) throw new Error(`kit expansion of ${line.childPartNo} is not finished`); // unreachable: children finish first
      height = Math.max(height, below.height + 1);
      add(line.childPartNo, line.unit, line.sourceId, line.qty);
      for (const grandchild of below.children) add(grandchild.partNo, grandchild.unit, grandchild.sourceId, line.qty * grandchild.qty);
    }
    if (height > MAX_KIT_DEPTH) {
      return { ok: false, error: new KitError("KIT_TOO_DEEP", partNo, `Kit ${partNo} nests ${height} levels deep; at most ${MAX_KIT_DEPTH} are allowed.`) };
    }
    const children = [...merged.values()].sort(order);
    const overflow = children.find((c) => !qtyOk(c.qty));
    if (overflow) {
      return {
        ok: false,
        error: new KitError(
          "KIT_QTY_OVERFLOW",
          partNo,
          `Kit ${partNo} needs ${overflow.qty} ${overflow.unit} of ${overflow.partNo}; at most ${MAX_DERIVED_QTY} is allowed.`,
        ),
      };
    }
    return { ok: true, height, children };
  };

  const compute = (root: string): Expansion => {
    const known = done.get(root);
    if (known) return known;
    const stack: { partNo: string; next: number }[] = [{ partNo: root, next: 0 }];
    const inProgress = new Set<string>([root]);
    let finished: Expansion | undefined;
    for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
      const lines = byParent.get(frame.partNo) ?? [];
      let failure: KitError | undefined;
      let descended = false;
      for (let line = lines[frame.next]; line !== undefined; line = lines[frame.next]) {
        if (!Number.isSafeInteger(line.qty)) {
          failure = new KitError(
            "KIT_QTY_OVERFLOW",
            frame.partNo,
            `Kit line ${line.parentPartNo}>${line.childPartNo} has quantity ${line.qty}, which is not a safe whole number.`,
          );
          break;
        }
        const child = done.get(line.childPartNo);
        if (child) {
          if (!child.ok) {
            failure = child.error; // a kit containing a broken kit is broken for the same reason
            break;
          }
          frame.next += 1;
          continue;
        }
        if (inProgress.has(line.childPartNo)) {
          const from = stack.findIndex((f) => f.partNo === line.childPartNo);
          const cycle = canonicalCycle([...stack.slice(from).map((f) => f.partNo), line.childPartNo]);
          const [first = line.childPartNo] = cycle;
          failure = new KitError("KIT_CYCLE", first, `Cyclic kit definition: ${cycle.join(" -> ")}`);
          break;
        }
        inProgress.add(line.childPartNo);
        stack.push({ partNo: line.childPartNo, next: 0 });
        descended = true;
        break;
      }
      if (descended) continue;
      // every child is finished (or one failed): finish this part
      stack.pop();
      inProgress.delete(frame.partNo);
      finished = failure ? { ok: false, error: failure } : finish(frame.partNo);
      done.set(frame.partNo, finished);
    }
    if (!finished) throw new Error(`kit expansion of ${root} did not finish`); // unreachable: the root is popped last
    return finished;
  };

  return {
    expand(partNo, multiplier) {
      const expansion = compute(partNo);
      if (!expansion.ok) throw expansion.error;
      return expansion.children.map((c) => {
        const qty = c.qty * multiplier;
        if (!qtyOk(qty)) {
          throw new KitError(
            "KIT_QTY_OVERFLOW",
            partNo,
            `${multiplier} of kit ${partNo} need ${qty} ${c.unit} of ${c.partNo}; at most ${MAX_DERIVED_QTY} is allowed.`,
          );
        }
        return { ...c, qty };
      });
    },
    descendantLines(partNo) {
      const out: KitChild[] = [];
      const walked = new Set<string>([partNo]);
      const stack: { lines: KitChild[]; next: number }[] = [{ lines: byParent.get(partNo) ?? [], next: 0 }];
      for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
        const line = frame.lines[frame.next];
        if (line === undefined) {
          stack.pop();
          continue;
        }
        frame.next += 1;
        out.push(line);
        if (!walked.has(line.childPartNo)) {
          walked.add(line.childPartNo);
          stack.push({ lines: byParent.get(line.childPartNo) ?? [], next: 0 });
        }
      }
      return out;
    },
  };
}

/**
 * Every mandatory descendant of one unit of `partNo`; see `KitIndex.expand`. Builds a throwaway index,
 * so callers that expand more than once should hold a `KitIndex` (a `ReleaseIndex` does).
 */
export function expandKit(partNo: string, byParent: Map<string, KitChild[]>, parts: Map<string, Part>): ExpandedChild[] {
  return buildKitIndex([...byParent.values()].flat(), parts).expand(partNo, 1);
}

/** Import-time checks: invalid, duplicate, conflicting, cyclic, too deep and overflowing kit definitions. */
export function validateKits(
  kitChildren: KitChild[],
  parts: Map<string, Part>,
  units: string[],
  sourceIds: Set<string>,
  kits: KitIndex = buildKitIndex(kitChildren, parts),
): Finding[] {
  const findings: Finding[] = [];
  const seen = new Map<string, KitChild>();
  const parents = new Set(kitChildren.map((k) => k.parentPartNo));
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
    if (!units.includes(k.unit))
      findings.push({ severity: "error", code: "KIT_UNKNOWN_UNIT", message: `Kit line ${ref} uses unknown unit ${k.unit}.`, refs: [ref] });
    else if (parents.has(k.childPartNo) && !COUNT_UNITS.has(k.unit))
      findings.push({
        severity: "warning",
        code: "KIT_UNIT_UNDER_NON_COUNT",
        message: `Kit line ${ref} is in ${k.unit}, which is not a count unit, but ${k.childPartNo} is itself a kit whose children are multiplied by it.`,
        refs: [ref],
      });
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
    const next = graph.get(k.parentPartNo);
    if (next) next.push(k.childPartNo);
    else graph.set(k.parentPartNo, [k.childPartNo]);
  }
  const state = new Map<string, 1 | 2>();
  const reported = new Set<string>();
  const visit = (node: string, trail: string[]) => {
    if (state.get(node) === 2) return;
    if (state.get(node) === 1) {
      const cycle = canonicalCycle([...trail.slice(trail.indexOf(node)), node]);
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
  // depth and quantity bounds, from the same expansion lookup uses; a failure shared by several kits is reported once
  const failures = new Set<KitError>();
  for (const parent of parents) {
    try {
      kits.expand(parent, 1);
    } catch (e) {
      if (!(e instanceof KitError) || e.code === "KIT_CYCLE" || failures.has(e)) continue; // cycles are reported above
      failures.add(e);
      findings.push({ severity: "error", code: e.code, message: e.message, refs: [e.partNo] });
    }
  }
  return findings;
}
