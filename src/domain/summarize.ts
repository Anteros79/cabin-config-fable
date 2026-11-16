import { compareCodePoints } from "./order.ts";
import { parsePrintedRow } from "./specificity.ts";
import type { CabinLocation } from "./types.ts";

function ranges(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const n of sorted) {
    const last = runs.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs.map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`)).join(", ");
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
      const row = parsePrintedRow(l.seat!.printedRow);
      if (row === null) {
        odd.push(l.seat!.code);
        continue;
      }
      const rows = byLetter.get(l.seat!.letter);
      if (rows) rows.push(row);
      else byLetter.set(l.seat!.letter, [row]);
    }
    // merge letters that share the same row set
    const bySet = new Map<string, string[]>();
    for (const [letter, rows] of [...byLetter.entries()].sort(([a], [b]) => compareCodePoints(a, b))) {
      const key = ranges(rows);
      const letters = bySet.get(key);
      if (letters) letters.push(letter);
      else bySet.set(key, [letter]);
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
