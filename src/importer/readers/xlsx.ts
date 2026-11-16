import { posix } from "node:path";
import { strFromU8 } from "fflate";
import { compareCodePoints } from "../../domain/order.ts";
import { element, elements, OOXML_LIMITS, OoxmlError, ownText, parseXmlRoot, readZipEntries, type XmlElement } from "./ooxml.ts";

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

const WORKBOOK = "xl/workbook.xml";
const WORKBOOK_RELS = "xl/_rels/workbook.xml.rels";
const SHARED_STRINGS = "xl/sharedStrings.xml";

/** Column letters for a one-based column number: 1 → A, 27 → AA. */
export function columnName(column: number): string {
  let name = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

const CELL_REF = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)$/;

/** Decode the `_xHHHH_` escapes SpreadsheetML uses for characters XML cannot carry (`_x005F_` is a literal underscore). */
function decodeEscapes(text: string): string {
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** Text of a string item (`<si>` or `<is>`): a plain `<t>`, or every run's `<t>` joined; phonetic runs are ignored. */
function stringItem(item: XmlElement): string {
  let text = "";
  for (const child of elements(item)) {
    if (child.name === "t") text += ownText(child);
    else if (child.name === "r") text += elements(child, "t").map(ownText).join("");
  }
  return decodeEscapes(text);
}

function cellValue(cell: XmlElement, type: string, ref: string, shared: readonly string[]): XlsxCellValue {
  const v = element(cell, "v");
  const raw = v === undefined ? undefined : ownText(v);
  if (element(cell, "f") !== undefined && raw === undefined) throw new OoxmlError(`unsupported cell type ${type} at ${ref}: formula without a cached value`);
  switch (type) {
    case "s": {
      if (raw === undefined) return null;
      const index = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
      const value = shared[index];
      if (value === undefined) throw new OoxmlError(`shared string index "${raw}" out of range at ${ref}`);
      return value;
    }
    case "b":
      if (raw === undefined) return null;
      if (raw !== "0" && raw !== "1") throw new OoxmlError(`invalid boolean "${raw}" at ${ref}`);
      return raw === "1";
    case "inlineStr": {
      const is = element(cell, "is");
      return is === undefined ? "" : stringItem(is);
    }
    case "str":
      return raw === undefined ? null : decodeEscapes(raw);
    case "e":
      return raw === undefined ? null : raw;
    case "n": {
      if (raw === undefined) return null;
      const value = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(value)) throw new OoxmlError(`invalid number "${raw}" at ${ref}`);
      return value;
    }
    default:
      throw new OoxmlError(`unsupported cell type ${type} at ${ref}`);
  }
}

function readSheet(name: string, state: string, root: XmlElement, shared: readonly string[]): XlsxSheet {
  const cells: XlsxCell[] = [];
  const rows: XlsxCellValue[][] = [];
  let rowNumber = 0;
  for (const row of elements(element(root, "sheetData"), "row")) {
    const r = row.attrs.r;
    if (r === undefined) rowNumber += 1;
    else if (/^[1-9][0-9]*$/.test(r)) rowNumber = Number(r);
    else throw new OoxmlError(`invalid row number "${r}" in sheet "${name}"`);
    if (rowNumber > OOXML_LIMITS.rows) throw new OoxmlError(`row ${rowNumber} in sheet "${name}" is beyond the limit of ${OOXML_LIMITS.rows} rows`);
    rows[rowNumber - 1] ??= [];
    const values = rows[rowNumber - 1] ?? [];
    let column = 0;
    for (const cell of elements(row, "c")) {
      let ref: string;
      if (cell.attrs.r === undefined) {
        column += 1;
        ref = `${columnName(column)}${rowNumber}`;
      } else {
        ref = cell.attrs.r;
        const match = CELL_REF.exec(ref);
        if (match === null) throw new OoxmlError(`invalid cell reference "${ref}" in sheet "${name}"`);
        if (Number(match[2]) !== rowNumber) throw new OoxmlError(`cell ${ref} is not in row ${rowNumber} of sheet "${name}"`);
        column = columnNumber(match[1] ?? "");
      }
      if (column > OOXML_LIMITS.columns) throw new OoxmlError(`cell ${ref} in sheet "${name}" is beyond the limit of ${OOXML_LIMITS.columns} columns`);
      if (cells.length >= OOXML_LIMITS.cells) throw new OoxmlError(`sheet "${name}" has more than ${OOXML_LIMITS.cells} cells`);
      const type = cell.attrs.t ?? "n";
      const value = cellValue(cell, type, ref, shared);
      cells.push({ ref, type, value, hasFormula: element(cell, "f") !== undefined });
      values[column - 1] = value;
    }
  }
  // Rows are filled out to a dense grid; refuse a sparse sheet whose grid would hold more slots than the cell limit.
  let slots = 0;
  for (let r = 0; r < rows.length; r++) slots += rows[r]?.length ?? 0;
  if (slots > OOXML_LIMITS.cells) throw new OoxmlError(`sheet "${name}" spans more than ${OOXML_LIMITS.cells} cells`);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] ?? [];
    for (let c = 0; c < row.length; c++) if (row[c] === undefined) row[c] = null;
    rows[r] = row;
  }
  const mergedCells = elements(element(root, "mergeCells"), "mergeCell").flatMap((m) => (m.attrs.ref === undefined ? [] : [m.attrs.ref]));
  return { name, state, dimension: element(root, "dimension")?.attrs.ref ?? null, mergedCells, cells, rows };
}

/** Package path of a workbook relationship target: relative to `xl/`, or absolute from the package root. */
function resolveTarget(target: string): string {
  const path = target.startsWith("/") ? posix.normalize(target.slice(1)) : posix.normalize(posix.join("xl", target));
  if (path.startsWith("../") || path === "..") throw new OoxmlError(`relationship target "${target}" is outside the package`);
  return path;
}

/**
 * Read-only XLSX reader on a real XML parser. Only the workbook, its relationships, the shared strings
 * and the sheet parts the relationships name are inflated, each under the OOXML_LIMITS caps. Formulas
 * are never evaluated (the cached value is read and the formula's presence reported); macros and
 * external links are detected by part name but never opened.
 */
export function readXlsx(bytes: Uint8Array): XlsxWorkbook {
  const names: string[] = [];
  const parts = readZipEntries(bytes, (name) => {
    names.push(name);
    return name === WORKBOOK || name === WORKBOOK_RELS || name === SHARED_STRINGS;
  });
  const workbookXml = parts.get(WORKBOOK);
  if (workbookXml === undefined) throw new OoxmlError(`missing ${WORKBOOK}`);
  const workbook = parseXmlRoot(strFromU8(workbookXml));

  const rels = new Map<string, string>();
  const relsXml = parts.get(WORKBOOK_RELS);
  if (relsXml !== undefined)
    for (const rel of elements(parseXmlRoot(strFromU8(relsXml)), "Relationship")) {
      const { Id: id, Target: target, TargetMode: mode } = rel.attrs;
      if (id !== undefined && target !== undefined && mode !== "External") rels.set(id, resolveTarget(target));
    }

  const sharedXml = parts.get(SHARED_STRINGS);
  const shared = sharedXml === undefined ? [] : elements(parseXmlRoot(strFromU8(sharedXml)), "si").map(stringItem);

  const sheetEntries = elements(element(workbook, "sheets"), "sheet").map((sheet) => {
    const name = sheet.attrs.name ?? "";
    // `r:id` with its namespace prefix removed
    const rid = sheet.attrs.id ?? "";
    const part = rels.get(rid);
    if (part === undefined) throw new OoxmlError(`sheet "${name}" has no worksheet relationship "${rid}"`);
    return { name, state: sheet.attrs.state ?? "visible", part };
  });
  const wantedParts = new Set(sheetEntries.map((s) => s.part));
  let used = 0;
  for (const data of parts.values()) used += data.length;
  const sheetParts = readZipEntries(bytes, (name) => wantedParts.has(name), OOXML_LIMITS.totalBytes - used);
  const sheets = sheetEntries.map(({ name, state, part }) => {
    const xml = sheetParts.get(part);
    if (xml === undefined) throw new OoxmlError(`sheet "${name}" part ${part} is missing`);
    return readSheet(name, state, parseXmlRoot(strFromU8(xml)), shared);
  });

  const entries = [...names].sort(compareCodePoints);
  return {
    entries,
    hasMacros: entries.some((e) => /vbaProject/i.test(e)),
    hasExternalLinks: entries.some((e) => /externalLink/i.test(e)),
    sheets,
  };
}
