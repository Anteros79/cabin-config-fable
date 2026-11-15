// Loads and parses every operational/narrative source once, and exposes locator helpers.
import { F, readOriginal } from './common.mjs';
import { parseCsv } from './csv.mjs';
import { parseXlsx } from './ooxml.mjs';
import { parseDocx } from './docx.mjs';
import { parseRtf } from './rtf.mjs';

let cached = null;

export function colLetter(index0) {
  let n = index0 + 1;
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Workbook rows with the explicit conversions needed to line them up with the other exports. */
export function normalizeWorkbook(xlsx) {
  const sheet = xlsx.sheets[0];
  const byRow = new Map();
  for (const c of sheet.cells) {
    if (!byRow.has(c.row)) byRow.set(c.row, new Map());
    byRow.get(c.row).set(c.column, c);
  }
  const rowNumbers = [...byRow.keys()].sort((a, b) => a - b);
  const headerRow = rowNumbers[0];
  const headerCells = [...byRow.get(headerRow).values()].sort((a, b) => a.ref.length - b.ref.length || a.ref.localeCompare(b.ref));
  const header = headerCells.map((c) => ({ column: c.column, name: String(c.value) }));
  const conversions = { numeric_cell_to_identifier_string: [], absent_cell_to_empty_string: [] };
  const rows = [];
  for (const r of rowNumbers.slice(1)) {
    const cells = byRow.get(r);
    const raw = {};
    const normalized = {};
    const locators = {};
    for (const h of header) {
      const c = cells.get(h.column);
      const loc = `${sheet.name}!${h.column}${r}`;
      locators[h.name] = loc;
      if (!c || c.value === null) {
        raw[h.name] = null;
        normalized[h.name] = '';
        conversions.absent_cell_to_empty_string.push(loc);
      } else {
        raw[h.name] = { raw_type: c.raw_type, value_type: c.value_type, value: c.value };
        if (h.name === 'lopa_id' && c.value_type === 'number') {
          normalized[h.name] = String(c.raw_v);
          conversions.numeric_cell_to_identifier_string.push(loc);
        } else normalized[h.name] = c.value;
      }
    }
    rows.push({ sheet_row: r, locators, raw, normalized });
  }
  return { sheet_name: sheet.name, header_row: headerRow, header, rows, conversions };
}

export function loadSources() {
  if (cached) return cached;
  const registryBytes = readOriginal(F.REGISTRY_JSON);
  const registryText = new TextDecoder('utf-8', { fatal: true }).decode(registryBytes);
  const registry = JSON.parse(registryText);
  const configCsv = parseCsv(readOriginal(F.CONFIG_CSV));
  const seatsCsv = parseCsv(readOriginal(F.SEATS_CSV));
  const schemaCsv = parseCsv(readOriginal(F.SCHEMA_CSV));
  const xlsx = parseXlsx(readOriginal(F.ROWS_XLSX));
  const workbook = normalizeWorkbook(xlsx);
  const rtf = parseRtf(readOriginal(F.RTF));
  const docx = parseDocx(readOriginal(F.DOCX));

  const cfgIndex = new Map(registry.lopa_configurations.map((c, i) => [c.lopa_id, i]));
  const rowIndex = new Map(registry.lopa_rows.map((r, i) => [`${r.lopa_id}|${r.row_number}`, i]));
  const seatIndex = new Map(registry.lopa_seats.map((s, i) => [`${s.lopa_id}|${s.row_number}|${s.seat_letter}`, i]));
  const cfgCsvIndex = new Map(configCsv.rows.map((r) => [r.values.lopa_id, r]));
  const seatCsvIndex = new Map(seatsCsv.rows.map((r) => [`${r.values.lopa_id}|${r.values.row_number}|${r.values.seat_letter}`, r]));
  const wbIndex = new Map(workbook.rows.map((r) => [`${r.normalized.lopa_id}|${r.normalized.row_number}`, r]));

  const loc = {
    json: (entity, index, field) => `${F.REGISTRY_JSON}#/${entity}/${index}${field ? '/' + field : ''}`,
    csv: (file, line, header, field) => `${file}:L${line}${field ? ':' + colLetter(header.indexOf(field)) + '(' + field + ')' : ''}`,
    xlsx: (cellLocator) => `${F.ROWS_XLSX}#${cellLocator}`,
    rtf: (l) => `${F.RTF}#${l}`,
    docx: (l) => `${F.DOCX}#${l}`,
  };

  /** Locators for one registry value in every export that carries it. */
  const locate = {
    config(lopaId, field) {
      const i = cfgIndex.get(lopaId);
      const csvRow = cfgCsvIndex.get(lopaId);
      return {
        value: registry.lopa_configurations[i][field],
        csv_raw: csvRow ? csvRow.values[field] : undefined,
        locators: [loc.json('lopa_configurations', i, field), csvRow ? loc.csv(F.CONFIG_CSV, csvRow.line, configCsv.header, field) : null].filter(Boolean),
      };
    },
    row(lopaId, rowNumber, field) {
      const i = rowIndex.get(`${lopaId}|${rowNumber}`);
      const wb = wbIndex.get(`${lopaId}|${rowNumber}`);
      return {
        value: registry.lopa_rows[i][field],
        xlsx_raw: wb ? wb.raw[field] : undefined,
        locators: [loc.json('lopa_rows', i, field), wb ? loc.xlsx(wb.locators[field]) : null].filter(Boolean),
      };
    },
    seat(lopaId, rowNumber, letter, field) {
      const i = seatIndex.get(`${lopaId}|${rowNumber}|${letter}`);
      const csvRow = seatCsvIndex.get(`${lopaId}|${rowNumber}|${letter}`);
      return {
        value: registry.lopa_seats[i][field],
        csv_raw: csvRow ? csvRow.values[field] : undefined,
        locators: [loc.json('lopa_seats', i, field), csvRow ? loc.csv(F.SEATS_CSV, csvRow.line, seatsCsv.header, field) : null].filter(Boolean),
      };
    },
  };

  // text units of the narrative documents for located-quote search
  const rtfUnits = [
    ...rtf.paragraphs.map((p) => ({ locator: p.locator, text: p.text })),
    ...rtf.tables.flatMap((t) => t.rows.flatMap((r) => r.cells.map((c) => ({ locator: c.locator, text: c.text })))),
  ];
  const docxUnits = [
    ...docx.paragraphs.filter((p) => p.context === 'body').map((p) => ({ locator: p.locator, text: p.text })),
    ...docx.tables.flatMap((t) => t.rows.flatMap((r) => r.cells.map((c) => ({ locator: c.locator, text: c.text })))),
  ];

  cached = {
    registryBytes, registryText, registry, configCsv, seatsCsv, schemaCsv, xlsx, workbook, rtf, docx,
    cfgIndex, rowIndex, seatIndex, cfgCsvIndex, seatCsvIndex, wbIndex, loc, locate, rtfUnits, docxUnits,
  };
  return cached;
}
