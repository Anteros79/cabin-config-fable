// Cross-format comparison of the populated registry JSON against its CSV/XLSX exports.
// Every conversion needed to line values up is explicit and counted. Nothing is "fixed".
import { F, writeJson, writeText, mdTable, code, DISCLAIMER } from './lib/common.mjs';
import { loadSources } from './lib/sources.mjs';

const NUMERIC_TEXT = /^-?(0|[1-9]\d*)(\.\d+)?$/;

function newTally() {
  return { compared: 0, agree: 0, mismatch: 0, conversions: {}, native: {}, mismatches: [] };
}
const bump = (obj, k) => { obj[k] = (obj[k] ?? 0) + 1; };

function compareCsvValue(jv, cv, t) {
  if (cv === undefined) return { ok: false, why: 'field missing in CSV record' };
  if (typeof jv === 'string') {
    bump(t.native, jv === '' && cv === '' ? 'empty string = empty CSV field (no conversion)' : 'string = CSV text (no conversion)');
    return { ok: jv === cv };
  }
  if (typeof jv === 'number') {
    bump(t.conversions, 'csv_text_to_number');
    if (!NUMERIC_TEXT.test(cv)) return { ok: false, why: 'CSV text is not a plain number' };
    if (String(jv) !== cv) bump(t.conversions, 'csv_number_text_lexically_different_from_json_number (e.g. "17.0" vs 17)');
    return { ok: Number(cv) === jv };
  }
  if (typeof jv === 'boolean') {
    bump(t.conversions, 'csv_text_True/False_to_boolean');
    if (cv !== 'True' && cv !== 'False') return { ok: false, why: 'CSV text is not True/False' };
    return { ok: (cv === 'True') === jv };
  }
  if (jv === null) {
    bump(t.conversions, 'csv_empty_field_to_null');
    return { ok: cv === '' };
  }
  return { ok: false, why: `unsupported JSON value type ${typeof jv}` };
}

function compareXlsxValue(jv, raw, t) {
  if (raw === undefined) return { ok: false, why: 'column missing in workbook' };
  if (raw === null) {
    bump(t.conversions, 'xlsx_absent_cell_to_empty_string');
    return { ok: jv === '' };
  }
  if (raw.value_type === 'number' && typeof jv === 'string') {
    bump(t.conversions, 'xlsx_numeric_cell_to_identifier_string');
    return { ok: String(raw.value) === jv };
  }
  if (raw.value_type === 'number' && typeof jv === 'number') { bump(t.native, 'number = numeric cell (no conversion)'); return { ok: raw.value === jv }; }
  if (raw.value_type === 'boolean' && typeof jv === 'boolean') { bump(t.native, 'boolean = boolean cell (no conversion)'); return { ok: raw.value === jv }; }
  if ((raw.value_type === 'shared-string' || raw.value_type === 'inline-string') && typeof jv === 'string') { bump(t.native, 'string = string cell (no conversion)'); return { ok: raw.value === jv }; }
  return { ok: false, why: `type mismatch: JSON ${typeof jv} vs workbook ${raw.value_type}` };
}

function compareEntity({ name, exportFile, exportFormat, jsonRecords, jsonKeyFields, exportKeyOf, exportRecords, exportFields, valueOf, locJson, locExport, cmp }) {
  const t = newTally();
  const jsonFields = jsonRecords.length ? Object.keys(jsonRecords[0]) : [];
  const allJsonFields = new Set(jsonRecords.flatMap((r) => Object.keys(r)));
  const shared = jsonFields.filter((f) => exportFields.includes(f));
  const exportByKey = new Map();
  for (const r of exportRecords) exportByKey.set(exportKeyOf(r), r);
  const jsonKeys = jsonRecords.map((r) => jsonKeyFields.map((f) => r[f]).join('|'));
  const onlyJson = jsonKeys.filter((k) => !exportByKey.has(k));
  const jsonKeySet = new Set(jsonKeys);
  const onlyExport = [...exportByKey.keys()].filter((k) => !jsonKeySet.has(k));
  const sameOrder = jsonKeys.length === exportRecords.length && jsonKeys.every((k, i) => exportKeyOf(exportRecords[i]) === k);
  jsonRecords.forEach((rec, i) => {
    const key = jsonKeys[i];
    const ex = exportByKey.get(key);
    if (!ex) return;
    for (const f of shared) {
      t.compared++;
      const jv = rec[f];
      const ev = valueOf(ex, f);
      const res = cmp(jv, ev, t);
      if (res.ok) t.agree++;
      else {
        t.mismatch++;
        t.mismatches.push({ entity: name, key, attribute: f, json_value: jv, export_value: ev, reason: res.why ?? 'values differ after the listed conversion', json_locator: locJson(i, f), export_locator: locExport(ex, f) });
      }
    }
  });
  return {
    entity: name,
    json_side: `${F.REGISTRY_JSON}#/${name}`,
    export_side: exportFile,
    export_format: exportFormat,
    json_record_count: jsonRecords.length,
    export_record_count: exportRecords.length,
    keys_only_in_json: onlyJson,
    keys_only_in_export: onlyExport,
    record_order_identical: sameOrder,
    json_attribute_count: jsonFields.length,
    json_records_with_non_uniform_keys: jsonRecords.filter((r) => Object.keys(r).length !== jsonFields.length || Object.keys(r).some((k, j) => k !== jsonFields[j])).length,
    export_attribute_count: exportFields.length,
    shared_attribute_count: shared.length,
    shared_attributes: shared,
    attributes_only_in_json: [...allJsonFields].filter((f) => !exportFields.includes(f)),
    attributes_only_in_export: exportFields.filter((f) => !allJsonFields.has(f)),
    attribute_order_identical: JSON.stringify(jsonFields) === JSON.stringify(exportFields),
    attribute_values_compared: t.compared,
    attribute_values_agreeing: t.agree,
    attribute_values_mismatching: t.mismatch,
    explicit_conversions: t.conversions,
    comparisons_without_conversion: t.native,
    mismatches: t.mismatches,
  };
}

export function run(ctx) {
  const s = loadSources();
  const reg = s.registry;

  const configs = compareEntity({
    name: 'lopa_configurations', exportFile: F.CONFIG_CSV, exportFormat: 'CSV',
    jsonRecords: reg.lopa_configurations, jsonKeyFields: ['lopa_id'],
    exportRecords: s.configCsv.rows, exportFields: s.configCsv.header,
    exportKeyOf: (r) => r.values.lopa_id,
    valueOf: (r, f) => r.values[f],
    locJson: (i, f) => s.loc.json('lopa_configurations', i, f),
    locExport: (r, f) => s.loc.csv(F.CONFIG_CSV, r.line, s.configCsv.header, f),
    cmp: compareCsvValue,
  });
  const rows = compareEntity({
    name: 'lopa_rows', exportFile: F.ROWS_XLSX, exportFormat: 'XLSX',
    jsonRecords: reg.lopa_rows, jsonKeyFields: ['lopa_id', 'row_number'],
    exportRecords: s.workbook.rows, exportFields: s.workbook.header.map((h) => h.name),
    exportKeyOf: (r) => `${r.normalized.lopa_id}|${r.normalized.row_number}`,
    valueOf: (r, f) => r.raw[f],
    locJson: (i, f) => s.loc.json('lopa_rows', i, f),
    locExport: (r, f) => s.loc.xlsx(r.locators[f]),
    cmp: compareXlsxValue,
  });
  const seats = compareEntity({
    name: 'lopa_seats', exportFile: F.SEATS_CSV, exportFormat: 'CSV',
    jsonRecords: reg.lopa_seats, jsonKeyFields: ['lopa_id', 'row_number', 'seat_letter'],
    exportRecords: s.seatsCsv.rows, exportFields: s.seatsCsv.header,
    exportKeyOf: (r) => `${r.values.lopa_id}|${r.values.row_number}|${r.values.seat_letter}`,
    valueOf: (r, f) => r.values[f],
    locJson: (i, f) => s.loc.json('lopa_seats', i, f),
    locExport: (r, f) => s.loc.csv(F.SEATS_CSV, r.line, s.seatsCsv.header, f),
    cmp: compareCsvValue,
  });
  const entities = [configs, rows, seats];

  const totalConv = {};
  for (const e of entities) for (const [k, v] of Object.entries(e.explicit_conversions)) totalConv[k] = (totalConv[k] ?? 0) + v;
  const totals = {
    shared_attribute_values_compared: entities.reduce((n, e) => n + e.attribute_values_compared, 0),
    agreeing: entities.reduce((n, e) => n + e.attribute_values_agreeing, 0),
    mismatching: entities.reduce((n, e) => n + e.attribute_values_mismatching, 0),
    explicit_conversions: totalConv,
    workbook_numeric_identifier_conversions: totalConv.xlsx_numeric_cell_to_identifier_string ?? 0,
    workbook_blank_to_empty_string_conversions: totalConv.xlsx_absent_cell_to_empty_string ?? 0,
  };

  const meta = reg.schema_metadata;
  const declaredVsActual = ['lopa_configurations', 'lopa_rows', 'lopa_seats'].map((k) => ({
    entity: k,
    json_schema_metadata_record_count: meta?.entities?.[k]?.record_count ?? null,
    json_actual_records: reg[k].length,
    export_actual_records: entities.find((e) => e.entity === k).export_record_count,
    schema_architecture_csv_row_count_raw: s.schemaCsv.rows.find((r) => r.values['Entity / Table'] === k)?.values['Row Count'] ?? null,
  }));

  const statement =
    'These four files are exports of one registry (same schema name, same records, same strings). Their agreement shows the exports are ' +
    'internally consistent; it is NOT independent verification of any seat, row or configuration fact. A value repeated in four formats is still one claim.';

  const out = {
    purpose: 'Compare the populated JSON registry with its CSV/XLSX exports, attribute by attribute.',
    independence_statement: statement,
    json_file: F.REGISTRY_JSON,
    embedded_timestamps: {
      json_generated_at_utc: meta?.generated_at_utc ?? null,
      xlsx_core_created: s.xlsx.core_properties?.['dcterms:created'] ?? null,
      xlsx_core_modified: s.xlsx.core_properties?.['dcterms:modified'] ?? null,
      note: 'CSV files carry no internal timestamp. Timestamps describe file generation, not validation or approval.',
    },
    totals,
    declared_vs_actual_record_counts: declaredVsActual,
    entities,
    substantive_mismatches: entities.flatMap((e) => e.mismatches),
  };
  ctx.written.push(writeJson('cross-format-comparison.json', out));

  const md = [];
  md.push('# Cross-format comparison (registry JSON vs CSV/XLSX exports)');
  md.push('');
  md.push(`> ${DISCLAIMER}`);
  md.push('');
  md.push(`**${statement}**`);
  md.push('');
  md.push(mdTable(
    ['Entity', 'JSON records', 'Export', 'Export records', 'Shared attributes', 'Values compared', 'Agree', 'Mismatch', 'Same record order'],
    entities.map((e) => [code(e.entity), e.json_record_count, code(e.export_side), e.export_record_count, e.shared_attribute_count, e.attribute_values_compared, e.attribute_values_agreeing, e.attribute_values_mismatching, e.record_order_identical ? 'yes' : 'no']),
  ));
  md.push('');
  md.push(`**Total shared attribute values compared: ${totals.shared_attribute_values_compared}; agreeing: ${totals.agreeing}; mismatching: ${totals.mismatching}.**`);
  md.push('');
  md.push('## Explicit conversions applied (counted per value)');
  md.push('');
  md.push(mdTable(['Conversion', ...entities.map((e) => e.entity), 'Total'],
    Object.keys(totalConv).map((k) => [k, ...entities.map((e) => e.explicit_conversions[k] ?? 0), totalConv[k]])));
  md.push('');
  md.push('Comparisons that needed no conversion:');
  md.push('');
  const nativeKeys = [...new Set(entities.flatMap((e) => Object.keys(e.comparisons_without_conversion)))];
  md.push(mdTable(['Kind', ...entities.map((e) => e.entity)], nativeKeys.map((k) => [k, ...entities.map((e) => e.comparisons_without_conversion[k] ?? 0)])));
  md.push('');
  md.push('## Record counts: declared vs actual');
  md.push('');
  md.push(mdTable(['Entity', 'JSON `schema_metadata.record_count`', 'JSON actual', 'Export actual', '`cabin schema architecture.csv` Row Count (raw)'],
    declaredVsActual.map((d) => [code(d.entity), d.json_schema_metadata_record_count, d.json_actual_records, d.export_actual_records, code(d.schema_architecture_csv_row_count_raw)])));
  md.push('');
  md.push('## Substantive mismatches');
  md.push('');
  if (out.substantive_mismatches.length === 0) md.push('None. Every shared attribute value agrees once the conversions above are applied.');
  else md.push(mdTable(['Entity', 'Key', 'Attribute', 'JSON value', 'Export value', 'JSON locator', 'Export locator'],
    out.substantive_mismatches.map((m) => [m.entity, m.key, m.attribute, code(JSON.stringify(m.json_value)), code(JSON.stringify(m.export_value)), m.json_locator, m.export_locator])));
  md.push('');
  md.push('## Key and attribute coverage');
  md.push('');
  md.push(mdTable(['Entity', 'Keys only in JSON', 'Keys only in export', 'Attributes only in JSON', 'Attributes only in export', 'Same attribute order'],
    entities.map((e) => [code(e.entity), e.keys_only_in_json.length, e.keys_only_in_export.length, e.attributes_only_in_json.join(', ') || 'none', e.attributes_only_in_export.join(', ') || 'none', e.attribute_order_identical ? 'yes' : 'no'])));
  md.push('');
  md.push(`Embedded timestamps: JSON \`generated_at_utc\` = ${code(out.embedded_timestamps.json_generated_at_utc)}; XLSX core created = ${code(out.embedded_timestamps.xlsx_core_created)}. ${out.embedded_timestamps.note}`);
  md.push('');
  md.push('Full detail: `cross-format-comparison.json`.');
  ctx.written.push(writeText('cross-format-comparison.md', md.join('\n')));
  return out;
}
