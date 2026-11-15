// XLSX extract: sheets, cells with locators, formulas, names, links, macro presence, normalized rows.
import { F, writeJson } from './lib/common.mjs';
import { loadSources } from './lib/sources.mjs';

export function run(ctx) {
  const s = loadSources();
  const x = s.xlsx;
  const wb = s.workbook;
  const sheets = x.sheets.map((sh) => {
    const present = new Set(sh.cells.map((c) => c.ref));
    const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(sh.dimension ?? '');
    let absent = null;
    if (m) {
      const cols = sh.columns_used;
      const rows = Number(m[4]) - Number(m[2]) + 1;
      absent = { grid_cells_in_dimension: rows * cols.length, cells_present: sh.cells.length, cells_absent: rows * cols.length - sh.cells.length, absent_by_column: {} };
      for (const col of cols) {
        let n = 0;
        for (let r = Number(m[2]); r <= Number(m[4]); r++) if (!present.has(`${col}${r}`)) n++;
        absent.absent_by_column[col] = n;
      }
    }
    return { ...sh, absent_cells: absent };
  });

  const out = {
    purpose: 'Workbook read as ZIP + XML only. Formulas, links and macros are detected, never evaluated.',
    file: F.ROWS_XLSX,
    zip_entries: x.zip_entries,
    core_properties: x.core_properties,
    app_properties: x.app_properties,
    file_version: x.file_version,
    authoring_path_recorded_in_workbook: x.authoring_path_recorded_in_workbook,
    calc_properties: x.calc_properties,
    sheet_count: sheets.length,
    sheets_summary: sheets.map((sh) => ({
      name: sh.name, state: sh.state, dimension: sh.dimension, part: sh.part, cell_count: sh.cell_count, merged_cells: sh.merged_cells,
      formula_cell_count: sh.formula_cell_count, hidden_rows: sh.hidden_rows, hidden_columns: sh.hidden_columns, columns_used: sh.columns_used,
      cell_type_counts: sh.cell_type_counts, absent_cells: sh.absent_cells,
    })),
    defined_names: x.defined_names,
    external_links: x.external_links,
    macros: x.macros,
    other_parts: x.other_parts,
    shared_strings: x.shared_strings,
    column_order: wb.header.map((h) => ({ column: h.column, header: h.name })),
    formulas_vs_cached_values: {
      formula_cells: sheets.flatMap((sh) => sh.formulas),
      note: sheets.every((sh) => sh.formula_cell_count === 0) ? 'No <f> elements found: every value is a stored literal, there are no cached formula results.' : 'Formula cells listed with their cached values; nothing was recalculated.',
    },
    numeric_identifier_cells: {
      note: 'lopa_id cells stored as numbers rather than strings (identifier typed as number by the spreadsheet).',
      count: wb.conversions.numeric_cell_to_identifier_string.length,
      locators: wb.conversions.numeric_cell_to_identifier_string,
    },
    normalization: {
      rules: [
        'lopa_id stored as a numeric cell -> identifier string using the exact stored digits',
        'cell absent from the sheet XML -> empty string ""',
        'boolean cells (t="b") -> true/false; shared strings -> their exact text; numeric cells -> numbers',
      ],
      conversion_counts: {
        numeric_cell_to_identifier_string: wb.conversions.numeric_cell_to_identifier_string.length,
        absent_cell_to_empty_string: wb.conversions.absent_cell_to_empty_string.length,
      },
    },
    rows: wb.rows.map((r) => ({ locator: `${wb.sheet_name}!A${r.sheet_row}:${wb.header.at(-1).column}${r.sheet_row}`, sheet_row: r.sheet_row, ...r.normalized, raw: r.raw })),
    sheets,
  };
  ctx.written.push(writeJson('extracts/workbook.json', out));
  return out;
}
