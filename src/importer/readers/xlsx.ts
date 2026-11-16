import { strFromU8, unzipSync } from "fflate";

export type XlsxCellValue = string | number | boolean | null;

export interface XlsxCell {
  ref: string;
  type: string;
  value: XlsxCellValue;
  hasFormula: boolean;
}

export interface XlsxSheet {
  name: string;
  state: string;
  dimension: string | null;
  mergedCells: string[];
  cells: XlsxCell[];
  /** rows[r][c] by zero-based position; absent cells are null. */
  rows: XlsxCellValue[][];
}

export interface XlsxWorkbook {
  entries: string[];
  hasMacros: boolean;
  hasExternalLinks: boolean;
  sheets: XlsxSheet[];
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function attr(tag: string, name: string): string | null {
  const value = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  return value === undefined ? null : decodeXml(value);
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Minimal read-only XLSX reader: zip + XML text only. Formulas are never evaluated (only the
 * cached value is read, and the presence of a formula is reported); macros and external links
 * are detected but never opened.
 */
export function readXlsx(bytes: Uint8Array): XlsxWorkbook {
  const zip = unzipSync(bytes);
  const entries = Object.keys(zip).sort();
  const text = (name: string) => (zip[name] ? strFromU8(zip[name]) : "");
  const shared: string[] = [];
  const sst = text("xl/sharedStrings.xml");
  for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const [, si = ""] = m;
    const parts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(([, t = ""]) => decodeXml(t));
    shared.push(parts.join(""));
  }
  const rels = new Map<string, string>();
  for (const m of text("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\s[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) rels.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const sheets: XlsxSheet[] = [];
  for (const m of text("xl/workbook.xml").matchAll(/<sheet\s[^>]*>/g)) {
    const name = attr(m[0], "name") ?? "";
    const state = attr(m[0], "state") ?? "visible";
    const rid = attr(m[0], "r:id") ?? "";
    const xml = text(rels.get(rid) ?? "");
    const dimension = /<dimension\s[^>]*ref="([^"]*)"/.exec(xml)?.[1] ?? null;
    const mergedCells = [...xml.matchAll(/<mergeCell\s[^>]*ref="([^"]*)"/g)].map(([, ref = ""]) => ref);
    const cells: XlsxCell[] = [];
    const rows: XlsxCellValue[][] = [];
    for (const rowMatch of xml.matchAll(/<row\s[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowIndex = Number(attr(rowMatch[0], "r") ?? rows.length + 1) - 1;
      rows[rowIndex] ??= [];
      const row: XlsxCellValue[] = rows[rowIndex];
      for (const c of (rowMatch[1] ?? "").matchAll(/<c\s[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(c[0].slice(0, c[0].indexOf(">") + 1), "r") ?? "";
        const type = attr(c[0].slice(0, c[0].indexOf(">") + 1), "t") ?? "n";
        const inner = c[1] ?? "";
        const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        const inline = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(([, t = ""]) => decodeXml(t)).join("");
        let value: XlsxCellValue = null;
        if (type === "s") value = raw === undefined ? null : (shared[Number(raw)] ?? null);
        else if (type === "b") value = raw === "1";
        else if (type === "inlineStr") value = inline;
        else if (type === "str" || type === "e") value = raw === undefined ? null : decodeXml(raw);
        else value = raw === undefined ? null : Number(raw);
        cells.push({ ref, type, value, hasFormula: /<f[\s>/]/.test(inner) });
        row[columnIndex(ref)] = value;
      }
    }
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] ?? [];
      for (let c = 0; c < row.length; c++) if (row[c] === undefined) row[c] = null;
      rows[r] = row;
    }
    sheets.push({ name, state, dimension, mergedCells, cells, rows });
  }
  return {
    entries,
    hasMacros: entries.some((e) => /vbaProject/i.test(e)),
    hasExternalLinks: entries.some((e) => /externalLink/i.test(e)),
    sheets,
  };
}
