export interface CsvTable {
  hasBom: boolean;
  headers: string[];
  /** Raw string cells; nothing is coerced so leading zeros and printed labels survive. */
  rows: string[][];
  records: Record<string, string>[];
}

/**
 * Strict RFC 4180 reader. Values are kept as the exact strings in the file.
 * Throws an Error naming the 1-based line for: a character other than a comma, CR, LF or the end of input
 * after a closing quote; a quote inside an unquoted field; a quoted field left open at the end of input;
 * an empty or repeated header name; a data row whose cell count differs from the header's.
 */
export function parseCsv(text: string): CsvTable {
  const hasBom = text.charCodeAt(0) === 0xfeff;
  const src = hasBom ? text.slice(1) : text;
  const rows: string[][] = [];
  const rowLines: number[] = [];
  let row: string[] = [];
  let cell = "";
  /** Inside a quoted field. */
  let quoted = false;
  /** Just past a closing quote: only a delimiter or the end of input may follow. */
  let closed = false;
  let i = 0;
  let any = false;
  let line = 1;
  let rowLine = 1;
  let quoteLine = 1;
  const fail = (at: number, message: string): never => {
    throw new Error(`CSV line ${at}: ${message}`);
  };
  const endRow = () => {
    if (any || cell.length > 0 || row.length > 0) {
      row.push(cell);
      rows.push(row);
      rowLines.push(rowLine);
    }
    row = [];
    cell = "";
    any = false;
    closed = false;
  };
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
        closed = true;
        i += 1;
        continue;
      }
      if (ch === "\n" || (ch === "\r" && src[i + 1] !== "\n")) line += 1;
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      any = true;
      closed = false;
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      endRow();
      line += 1;
      rowLine = line;
      i += 1;
      continue;
    }
    if (closed) fail(line, `unexpected ${JSON.stringify(ch)} after a closing quote`);
    if (ch === '"') {
      if (cell.length > 0) fail(line, "quote inside an unquoted field");
      quoted = true;
      quoteLine = line;
      any = true;
      i += 1;
      continue;
    }
    cell += ch;
    any = true;
    i += 1;
  }
  if (quoted) fail(quoteLine, "the input ends inside a quoted field");
  endRow();

  const headers = rows.shift() ?? [];
  const headerLine = rowLines.shift() ?? 1;
  const seen = new Set<string>();
  headers.forEach((h, c) => {
    if (h === "") fail(headerLine, `header ${c + 1} is empty`);
    if (seen.has(h)) fail(headerLine, `header ${JSON.stringify(h)} occurs more than once`);
    seen.add(h);
  });
  const records = rows.map((r, index) => {
    if (r.length !== headers.length) fail(rowLines[index] ?? 0, `row has ${r.length} cells, expected ${headers.length}`);
    // r.length === headers.length (checked above), so every cell is present.
    return Object.fromEntries(headers.map((h, c) => [h, r[c] ?? ""]));
  });
  return { hasBom, headers, rows, records };
}
