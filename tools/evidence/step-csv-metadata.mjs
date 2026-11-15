// CSV byte-level metadata, column profiles, key and foreign-key checks.
import { F, writeJson } from './lib/common.mjs';
import { profileColumns, duplicateKeys } from './lib/csv.mjs';
import { loadSources } from './lib/sources.mjs';

function summarise(file, csv, primaryKey) {
  return {
    file,
    encoding: csv.encoding,
    valid_utf8: csv.valid_utf8,
    non_ascii_byte_count: csv.non_ascii_byte_count,
    bom_present: csv.bom_present,
    bom: csv.bom,
    delimiter: csv.delimiter,
    delimiter_name: csv.delimiter_name,
    delimiter_counts_on_header_line: csv.delimiter_counts_on_header_line,
    quote_usage: {
      quote_char: csv.quote_char,
      quoted_field_count: csv.quoted_field_count,
      escaped_quote_pairs: csv.escaped_quote_count,
      stray_quotes: csv.stray_quote_count,
      unterminated_quote: csv.unterminated_quote,
      header_fields_quoted: csv.header_quoted.filter(Boolean).length,
      quoted_fields: csv.rows.flatMap((r) => r.quoted.map((q, i) => (q ? { line: r.line, column: csv.header[i], value: r.values[csv.header[i]] } : null)).filter(Boolean)).slice(0, 60),
    },
    line_endings: csv.line_endings,
    line_ending_style: csv.line_ending_style,
    ends_with_newline: csv.ends_with_newline,
    headers: csv.header,
    header_count: csv.header.length,
    row_count: csv.row_count,
    ragged_rows: csv.ragged_rows,
    primary_key: primaryKey,
    duplicate_primary_keys: duplicateKeys(csv.rows, primaryKey),
    columns: profileColumns(csv.header, csv.rows),
  };
}

export function run(ctx) {
  const s = loadSources();
  const schema = summarise(F.SCHEMA_CSV, s.schemaCsv, ['Entity / Table']);
  const configs = summarise(F.CONFIG_CSV, s.configCsv, ['lopa_id']);
  const seats = summarise(F.SEATS_CSV, s.seatsCsv, ['lopa_id', 'row_number', 'seat_letter']);

  // foreign keys: seats -> rows (workbook) -> configurations
  const cfgIds = new Set(s.configCsv.rows.map((r) => r.values.lopa_id));
  const wbKeys = new Map(s.workbook.rows.map((r) => [`${r.normalized.lopa_id}|${r.normalized.row_number}`, r]));
  const wbDuplicates = (() => {
    const seen = new Map();
    for (const r of s.workbook.rows) {
      const k = `${r.normalized.lopa_id}|${r.normalized.row_number}`;
      seen.set(k, (seen.get(k) ?? []).concat([r.sheet_row]));
    }
    return [...seen.entries()].filter(([, v]) => v.length > 1).map(([key, sheet_rows]) => ({ key, sheet_rows }));
  })();

  const seatsMissingRow = [];
  const seatsOnNonExistentRow = [];
  const seatsMissingConfig = [];
  for (const r of s.seatsCsv.rows) {
    const key = `${r.values.lopa_id}|${r.values.row_number}`;
    const wb = wbKeys.get(key);
    if (!wb) seatsMissingRow.push({ line: r.line, key });
    else if (wb.normalized.row_exists !== true) seatsOnNonExistentRow.push({ line: r.line, key });
    if (!cfgIds.has(r.values.lopa_id)) seatsMissingConfig.push({ line: r.line, lopa_id: r.values.lopa_id });
  }
  const rowsMissingConfig = s.workbook.rows.filter((r) => !cfgIds.has(r.normalized.lopa_id)).map((r) => ({ sheet_row: r.sheet_row, lopa_id: r.normalized.lopa_id }));
  const seatRowKeys = new Set(s.seatsCsv.rows.map((r) => `${r.values.lopa_id}|${r.values.row_number}`));
  const existingRowsWithoutSeats = s.workbook.rows.filter((r) => r.normalized.row_exists === true && !seatRowKeys.has(`${r.normalized.lopa_id}|${r.normalized.row_number}`)).map((r) => ({ sheet_row: r.sheet_row, key: `${r.normalized.lopa_id}|${r.normalized.row_number}` }));
  const configsWithoutRows = [...cfgIds].filter((id) => !s.workbook.rows.some((r) => r.normalized.lopa_id === id));
  const rawNumericIdsInWorkbook = s.workbook.conversions.numeric_cell_to_identifier_string.length;

  const out = {
    purpose: 'Byte-level CSV facts. Every field value is kept as the exact source string; inferred types are descriptive only.',
    files: { [F.SCHEMA_CSV]: schema, [F.CONFIG_CSV]: configs, [F.SEATS_CSV]: seats },
    foreign_key_checks: {
      note: `Rows live in ${F.ROWS_XLSX}; its lopa_id cells typed as numbers (${rawNumericIdsInWorkbook} cells) are compared as identifier strings. That conversion is explicit and counted in cross-format-comparison.json.`,
      seats_to_rows: {
        relation: `${F.SEATS_CSV}(lopa_id,row_number) -> ${F.ROWS_XLSX}(lopa_id,row_number)`,
        seat_records_checked: s.seatsCsv.rows.length,
        orphans: seatsMissingRow,
        seats_referencing_row_exists_false: seatsOnNonExistentRow,
        distinct_row_keys_referenced: seatRowKeys.size,
      },
      seats_to_configurations: { relation: `${F.SEATS_CSV}(lopa_id) -> ${F.CONFIG_CSV}(lopa_id)`, orphans: seatsMissingConfig },
      rows_to_configurations: {
        relation: `${F.ROWS_XLSX}(lopa_id) -> ${F.CONFIG_CSV}(lopa_id)`,
        row_records_checked: s.workbook.rows.length,
        orphans: rowsMissingConfig,
        duplicate_row_primary_keys: wbDuplicates,
      },
      reverse_coverage: {
        existing_rows_without_any_seat: existingRowsWithoutSeats,
        configurations_without_rows: configsWithoutRows,
      },
      all_foreign_keys_resolve: seatsMissingRow.length === 0 && seatsMissingConfig.length === 0 && rowsMissingConfig.length === 0,
    },
    schema_architecture_csv_declared_counts: s.schemaCsv.rows.map((r) => ({
      line: r.line,
      entity: r.values['Entity / Table'],
      primary_key: r.values['Primary Key'],
      foreign_keys_raw: r.values['Foreign Keys'],
      declared_row_count_raw: r.values['Row Count'],
    })),
  };
  ctx.written.push(writeJson('extracts/csv-metadata.json', out));
  return out;
}
