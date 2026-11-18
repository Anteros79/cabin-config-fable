/**
 * The work status of a piece or a location. The union is in rank order, highest first: a must-fix problem, an
 * unresolved component, a deferral opened in this visit, a deferral carried from an earlier one, a noted problem,
 * a recorded replacement, an eligible alternate part, nothing. The web model and the report share it.
 */
export type LocationStatus = "mustFix" | "unresolved" | "deferred" | "carried" | "noted" | "recorded" | "alternate" | "none";

export const STATUS_RANK: Readonly<Record<LocationStatus, number>> = {
  none: 0,
  alternate: 1,
  recorded: 2,
  noted: 3,
  carried: 4,
  deferred: 5,
  unresolved: 6,
  mustFix: 7,
};

/** The higher-ranked of two statuses. */
export function higherStatus(a: LocationStatus, b: LocationStatus): LocationStatus {
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
}

/** The status a whole location shows: the highest-ranked of its pieces. */
export function aggregateStatus(statuses: Iterable<LocationStatus>): LocationStatus {
  let out: LocationStatus = "none";
  for (const s of statuses) out = higherStatus(out, s);
  return out;
}
