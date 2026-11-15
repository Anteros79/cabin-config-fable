import type { CabinLocation } from "./types.ts";

function ranges(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const out: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const n = sorted[i];
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    out.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = n;
    prev = n;
  }
  return out.join(", ");
}

/** Compact human description of a location set, e.g. "Seat A rows 1-5 (5 locations)". */
export function summarizeLocations(locations: CabinLocation[]): string {
  if (locations.length === 0) return "No locations";
  const parts: string[] = [];
  const seats = locations.filter((l) => l.seat);
  if (seats.length > 0) {
    const byLetter = new Map<string, number[]>();
    const odd: string[] = [];
    for (const l of seats) {
      const row = Number(l.seat!.printedRow);
      if (!Number.isFinite(row)) {
        odd.push(l.seat!.code);
        continue;
      }
      byLetter.set(l.seat!.letter, [...(byLetter.get(l.seat!.letter) ?? []), row]);
    }
    // merge letters that share the same row set
    const bySet = new Map<string, string[]>();
    for (const [letter, rows] of [...byLetter.entries()].sort()) {
      const key = ranges(rows);
      bySet.set(key, [...(bySet.get(key) ?? []), letter]);
    }
    for (const [rowText, letters] of bySet) {
      parts.push(`Seat${letters.length > 1 ? "s" : ""} ${letters.join("/")} row${rowText.includes("-") || rowText.includes(",") ? "s" : ""} ${rowText}`);
    }
    if (odd.length) parts.push(odd.join(", "));
  }
  const others = locations.filter((l) => !l.seat);
  if (others.length > 0) {
    const labels = others.map((l) => l.label);
    parts.push(labels.length <= 6 ? labels.join(", ") : `${labels.slice(0, 5).join(", ")} +${labels.length - 5} more`);
  }
  return `${parts.join("; ")} (${locations.length} location${locations.length === 1 ? "" : "s"})`;
}
