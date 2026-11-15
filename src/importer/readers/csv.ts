export interface CsvTable {
  hasBom: boolean;
  headers: string[];
  /** Raw string cells; nothing is coerced so leading zeros and printed labels survive. */
  rows: string[][];
  records: Record<string, string>[];
}

/** RFC 4180 reader. Values are kept as the exact strings in the file. */
export function parseCsv(text: string): CsvTable {
  const hasBom = text.charCodeAt(0) === 0xfeff;
  const src = hasBom ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  let any = false;
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      any = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      any = true;
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      if (any || cell.length > 0 || row.length > 0) {
        row.push(cell);
        rows.push(row);
      }
      row = [];
      cell = "";
      any = false;
      i += 1;
      continue;
    }
    cell += ch;
    any = true;
    i += 1;
  }
  if (quoted) throw new Error("CSV ends inside a quoted field");
  if (any || cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  const headers = rows.shift() ?? [];
  const records = rows.map((r, index) => {
    if (r.length !== headers.length) throw new Error(`CSV data row ${index + 2} has ${r.length} cells, expected ${headers.length}`);
    return Object.fromEntries(headers.map((h, c) => [h, r[c]]));
  });
  return { hasBom, headers, rows, records };
}
