import { compareCodePoints } from "./order.ts";
import type { CabinLocation, CarriedObservation, Condition, MelClass, MelEntry, Observation } from "./types.ts";

const RANK: Record<MelClass["class"], number> = { COSMETIC: 0, MEL: 1, NO_GO: 2 };

/** The entry for a problem on this variant: an entry naming the variant wins over the base entry. */
export function melEntryFor(mel: MelEntry[], componentId: string, condition: Condition, variant: string): MelEntry | null {
  const matches = mel.filter((e) => e.componentId === componentId && e.condition === condition);
  return matches.find((e) => e.constraint?.variant?.includes(variant)) ?? matches.find((e) => e.constraint?.variant === undefined) ?? null;
}

/** The class of a problem. It can be raised by the technician, never lowered. */
export function classify(args: {
  mel: MelEntry[];
  componentId: string;
  condition: Condition;
  variant: string;
  seatBlocked: boolean;
  raisedTo?: "MEL" | "NO_GO";
}): MelClass {
  const entry = melEntryFor(args.mel, args.componentId, args.condition, args.variant);
  const base: MelClass = entry === null ? { class: "COSMETIC" } : args.seatBlocked && entry.whenSeatBlocked ? entry.whenSeatBlocked : entry.result;
  if (args.raisedTo === undefined || RANK[args.raisedTo] <= RANK[base.class]) return base;
  if (args.raisedTo === "NO_GO") return { class: "NO_GO", reason: "Raised by the technician" };
  return { class: "MEL", item: "TECH-RAISED", category: "C", intervalDays: 10, conditions: "Raised by the technician" };
}

export function allowedOutcomes(cls: MelClass): ("NOTED" | "DEFERRED" | "MUST_FIX")[] {
  if (cls.class === "COSMETIC") return ["NOTED", "DEFERRED"];
  if (cls.class === "MEL") return ["DEFERRED", "MUST_FIX"];
  return ["MUST_FIX"];
}

/** Due date of an MEL deferral: the deferral date plus the interval, in UTC calendar days. */
export function dueDateFor(cls: MelClass, deferredOn: string): string | null {
  if (cls.class !== "MEL") return null;
  const [y, m, d] = deferredOn.split("-").map(Number);
  const t = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  t.setUTCDate(t.getUTCDate() + cls.intervalDays);
  return t.toISOString().slice(0, 10);
}

/** Overdue only after the due date: still allowed on the due date itself. */
export function isOverdue(dueDate: string | null, onDate: string): boolean {
  return dueDate !== null && onDate > dueDate;
}

function isOpenDeferral(o: Observation): boolean {
  return o.status === "OPEN" && o.outcome === "DEFERRED";
}

/** An open MEL deferral past its due date counts as NO_GO. */
export function effectiveClass(o: Observation, onDate: string): MelClass {
  if (o.melClass.class === "MEL" && isOpenDeferral(o) && isOverdue(o.dueDate, onDate)) {
    return { class: "NO_GO", reason: `MEL deferral expired on ${o.dueDate}` };
  }
  return o.melClass;
}

/**
 * The class of an OPEN observation now (R16): re-classified against `mel` with the seat-blocked state of `others` (the
 * tail's other open observations, each at the location it sits at on this layout), never below the class it was
 * stored with (a class is only raised), then NO_GO when its MEL deferral is past due on `onDate`.
 * The server's completion gate, the web model and the report all judge with this.
 */
export function currentClass(o: Observation, ctx: { mel: MelEntry[]; variant: string; others: Observation[]; onDate: string }): MelClass {
  const now = classify({
    mel: ctx.mel,
    componentId: o.componentId,
    condition: o.condition,
    variant: ctx.variant,
    seatBlocked: seatIsBlocked(ctx.others, o.locationId),
    ...(o.raisedTo !== undefined ? { raisedTo: o.raisedTo } : {}),
  });
  const melClass = RANK[now.class] > RANK[o.melClass.class] ? now : o.melClass;
  return effectiveClass({ ...o, melClass }, ctx.onDate);
}

/** A problem that must be fixed before flight: marked so, or no-go now. A noted problem never is. */
export function isMustFixNow(o: Observation, cls: MelClass): boolean {
  return o.outcome !== "NOTED" && (o.outcome === "MUST_FIX" || cls.class === "NO_GO");
}

export function seatIsBlocked(openObservations: Observation[], seatLocationId: string): boolean {
  return openObservations.some((o) => o.locationId === seatLocationId && isOpenDeferral(o) && o.blocksSeat);
}

const BIN_ROWS = /\(rows (\d+)-(\d+)[,)]/;

/** The row span a bin label states, e.g. "Overhead bin L-04 (rows 10-12, 6 bags)". Null when it states none. */
export function binRowsFromLabel(label: string): { from: number; to: number } | null {
  const m = BIN_ROWS.exec(label);
  if (!m) return null;
  return { from: Number(m[1]), to: Number(m[2]) };
}

function binSideOf(locationId: string): "L" | "R" | null {
  const m = /^BIN:([LR])-/.exec(locationId);
  return m ? (m[1] as "L" | "R") : null;
}

/** Where each open observation sits on a (possibly different) layout. ORPHANED ones come last. */
export function mapCarried(open: Observation[], locations: CabinLocation[], onDate: string): CarriedObservation[] {
  const order = new Map(locations.map((l, i) => [l.id, i]));
  const byId = new Map(locations.map((l) => [l.id, l]));
  const placed = open.map((observation): CarriedObservation => {
    const overdue = isOpenDeferral(observation) && isOverdue(observation.dueDate, onDate);
    const same = byId.get(observation.locationId);
    if (same?.componentIds.includes(observation.componentId)) {
      return { observation, placement: "SAME", locationId: same.id, overdue };
    }
    const side = binSideOf(observation.locationId);
    const rows = binRowsFromLabel(observation.locationLabel);
    if (side !== null && rows !== null) {
      const target = locations.find(
        (l) =>
          l.kind === "BIN" &&
          l.bin?.side === side &&
          l.bin.rowFrom <= rows.from &&
          rows.from <= l.bin.rowTo &&
          l.componentIds.includes(observation.componentId),
      );
      if (target) return { observation, placement: "MAPPED", locationId: target.id, overdue };
    }
    return { observation, placement: "ORPHANED", locationId: null, overdue };
  });
  const rank = (c: CarriedObservation) => (c.locationId === null ? Number.MAX_SAFE_INTEGER : (order.get(c.locationId) ?? Number.MAX_SAFE_INTEGER - 1));
  return placed.sort((a, b) => rank(a) - rank(b) || compareCodePoints(a.observation.id, b.observation.id));
}
