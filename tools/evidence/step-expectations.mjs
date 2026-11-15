// Expectations named in the brief, each compared against the measured value.
// The "expected" column holds the brief's statement; the "measured" column comes only from script outputs.
import { F, writeJson, writeText, mdTable, code, DISCLAIMER } from './lib/common.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function run(ctx) {
  const { jsonCompare: jc, csv, workbook: wb, rtf, docx, hyperlinks: hl, crossFormat: xf, seatSets: ss, conflicts: cr, inventory: inv, images } = ctx.results;
  const rows = [];
  const exp = (expectation, expected, measured, pass, evidence) => {
    rows.push({
      id: `E${String(rows.length + 1).padStart(2, '0')}`,
      expectation,
      expected_per_brief: expected,
      measured_actual: measured,
      status: pass === null ? 'NOT VERIFIABLE' : pass ? 'CONFIRMED' : 'DIFFERS',
      evidence,
    });
  };
  const set = (id) => ss.seat_sets.find((x) => x.lopa_id === id);
  const tpl = jc.files.find((f) => f.file === F.TEMPLATE_JSON);
  const gem = jc.files.find((f) => f.file === F.GEMINI_JSON);
  const pair = jc.pairwise.find((p) => p.a === F.TEMPLATE_JSON && p.b === F.GEMINI_JSON);
  const galley = images['forward galley flight deck.jpg'];

  // --- inventory ---
  exp('All originals are present: 9 documents/data files and 14 images (23)', '9 + 14 = 23', `${inv.summary.documents} + ${inv.summary.images} = ${inv.summary.found} found; missing: ${inv.summary.missing_expected_files.length}; unexpected extra files: ${inv.summary.unexpected_files_in_source_root.length}`,
    inv.summary.documents === 9 && inv.summary.images === 14 && inv.summary.found === 23, 'inventory.json#/summary');
  const galleyOther = (galley?.named_entity_hits_in_metadata ?? []).filter((h) => !/Southwest/.test(h.name));
  exp('One forward-galley photo carries another airline\'s name in its metadata', 'another airline named in metadata',
    galleyOther.length ? galleyOther.map((h) => `${h.field} = ${JSON.stringify(h.value)}`).join('; ') + `; other fields: ${(galley.key_fields.description ?? []).map((d) => `${d.field} = ${JSON.stringify(d.value)}`).slice(0, 3).join('; ')}` : 'no airline name found in metadata',
    galleyOther.some((h) => /Airlines/.test(h.name)), 'inventory.json (entry "forward galley flight deck.jpg")');

  // --- JSON templates ---
  exp(`"${F.TEMPLATE_JSON}" is 548 bytes`, '548', `${tpl.size_bytes}`, tpl.size_bytes === 548, 'extracts/json-compare.json#/files');
  exp(`"${F.TEMPLATE_JSON}" and "${F.GEMINI_JSON}" are byte-identical`, 'identical', `byte_identical = ${pair.byte_identical}; sizes ${pair.size_a} / ${pair.size_b}; SHA-256 ${tpl.sha256.slice(0, 16)}… / ${gem.sha256.slice(0, 16)}…`, pair.byte_identical === true, 'extracts/json-compare.json#/pairwise');
  exp('Both are invalid JSON (templates)', 'do not parse', `parses: ${tpl.parses_as_json} / ${gem.parses_as_json}; first error at byte ${tpl.strict_validator_error?.offset} (line ${tpl.strict_validator_error?.line}, column ${tpl.strict_validator_error?.column}): ${tpl.strict_validator_error?.message}`, !tpl.parses_as_json && !gem.parses_as_json, 'extracts/json-compare.json#/files');
  exp('Both contain the literal `[ ... ]`', 'present', `${tpl.literal_placeholder_bracket_ellipsis.count} / ${gem.literal_placeholder_bracket_ellipsis.count} occurrences (byte offsets ${tpl.literal_placeholder_bracket_ellipsis.offsets.join(', ')})`, tpl.literal_placeholder_bracket_ellipsis.count > 0 && gem.literal_placeholder_bracket_ellipsis.count > 0, 'extracts/json-compare.json#/files');

  // --- cross-format ---
  exp('Workbook numeric `738` converted to identifier string, roughly 30 times', '≈ 30', `${xf.totals.workbook_numeric_identifier_conversions}`, xf.totals.workbook_numeric_identifier_conversions === 30, 'cross-format-comparison.json#/totals');
  exp('Blanks converted to empty strings, roughly 377 times', '≈ 377', `${xf.totals.workbook_blank_to_empty_string_conversions} (workbook cells absent where the JSON holds "")`, xf.totals.workbook_blank_to_empty_string_conversions === 377, 'cross-format-comparison.json#/totals');
  exp('16,641 shared attribute values agree in total', '16,641 agreeing', `${xf.totals.shared_attribute_values_compared} compared; ${xf.totals.agreeing} agree; ${xf.totals.mismatching} mismatch`, xf.totals.agreeing === 16641 && xf.totals.mismatching === 0, 'cross-format-comparison.json#/totals');
  const otherConv = Object.entries(xf.totals.explicit_conversions).filter(([k]) => !k.startsWith('xlsx_'));
  exp('The only conversions needed are the numeric identifier and the blanks', 'two conversion kinds', `also needed for the CSV side (text is untyped): ${otherConv.map(([k, v]) => `${k} ×${v}`).join('; ')}`, otherConv.length === 0, 'cross-format-comparison.json#/totals/explicit_conversions');

  // --- registry counts ---
  exp('5 configurations', '5', `${ss.totals.configurations}`, ss.totals.configurations === 5, 'candidate-seat-sets.json#/totals');
  exp('147 row records including 4 non-existent labels', '147 incl. 4', `${ss.totals.row_records} row records; ${ss.totals.row_records_row_exists_false} with row_exists=false; ${ss.totals.row_records_row_exists_true} existing`, ss.totals.row_records === 147 && ss.totals.row_records_row_exists_false === 4, 'candidate-seat-sets.json#/totals');
  exp('837 seats', '837', `${ss.totals.seat_records}`, ss.totals.seat_records === 837, 'candidate-seat-sets.json#/totals');

  // --- seat sets ---
  const g = set('73G');
  exp('73G = 137 seats', '137', `${g.total_seat_count}`, g.total_seat_count === 137, 'candidate-seat-sets.json (73G)');
  exp('73G printed labels 1–9 and 14–27', '1–9, 14–27', g.printed_row_labels_existing_ranges, g.printed_row_labels_existing_ranges === '1–9, 14–27', 'candidate-seat-sets.json (73G)');
  exp('73G seats A–F except 14A', 'only 14A omitted', `letters used ${g.seat_letters_used.join('')}; omitted on existing rows: ${g.omitted_seat_codes_on_existing_rows.join(', ') || 'none'}`, same(g.seat_letters_used, ['A', 'B', 'C', 'D', 'E', 'F']) && same(g.omitted_seat_codes_on_existing_rows, ['14A']), 'candidate-seat-sets.json (73G)');
  exp('73G labels 10–13 non-existent', '10, 11, 12, 13', g.printed_row_labels_row_exists_false.join(', '), same(g.printed_row_labels_row_exists_false, ['10', '11', '12', '13']), 'candidate-seat-sets.json (73G)');
  for (const id of ['738', '7M8-1']) {
    const x = set(id);
    exp(`${id} = 175 seats, labels 1–30, A–F except 1A/1B/1C and 15A/15F`, '175; 1–30; omit 1A, 1B, 1C, 15A, 15F', `${x.total_seat_count} seats; labels ${x.printed_row_labels_existing_ranges}; omitted: ${x.omitted_seat_codes_on_existing_rows.join(', ')}`,
      x.total_seat_count === 175 && x.printed_row_labels_existing_ranges === '1–30' && same(x.omitted_seat_codes_on_existing_rows, ['1A', '1B', '1C', '15A', '15F']) && x.printed_row_labels_row_exists_false.length === 0, `candidate-seat-sets.json (${id})`);
  }
  for (const id of ['738-2', '7M8-2']) {
    const x = set(id);
    const r15 = x.rows.find((r) => r.printed_row_label === '15');
    exp(`${id} = 175 seats, omitting 1A/1B/1C and 30A/30F, with 15A/15F present`, '175; omit 1A, 1B, 1C, 30A, 30F; 15A and 15F present', `${x.total_seat_count} seats; labels ${x.printed_row_labels_existing_ranges}; omitted: ${x.omitted_seat_codes_on_existing_rows.join(', ')}; row 15 seats: ${r15.seat_codes.join(' ')}`,
      x.total_seat_count === 175 && same(x.omitted_seat_codes_on_existing_rows, ['1A', '1B', '1C', '30A', '30F']) && r15.seat_codes.includes('15A') && r15.seat_codes.includes('15F'), `candidate-seat-sets.json (${id})`);
  }
  const tierExpectedList = [['73G', [42, 23, 72]], ['738', [46, 45, 84]], ['7M8-1', [46, 45, 84]], ['738-2', [48, 45, 82]], ['7M8-2', [48, 45, 82]]];
  const tierActual = Object.fromEntries(ss.seat_sets.map((x) => [x.lopa_id, [x.tier_totals['Extra Legroom'], x.tier_totals.Preferred, x.tier_totals.Standard]]));
  exp('Tier totals (Extra Legroom / Preferred / Standard) 42/23/72, 46/45/84, 46/45/84, 48/45/82, 48/45/82', tierExpectedList.map(([k, v]) => `${k} ${v.join('/')}`).join('; '), ss.seat_sets.map((x) => `${x.lopa_id} ${tierActual[x.lopa_id].join('/')}`).join('; '),
    same(ss.seat_sets.map((x) => x.lopa_id), tierExpectedList.map(([k]) => k)) && tierExpectedList.every(([k, v]) => same(v, tierActual[k])), 'candidate-seat-sets.json#/seat_sets/*/tier_totals');
  exp('A row exists where the A/B/C block and the D/E/F block have different commercial tiers (e.g. row 6)', 'row 6', ss.seat_sets.map((x) => `${x.lopa_id}: ${x.split_tier_rows.map((r) => `row ${r.printed_row_label} (${r.block_ABC.tiers.join('+')} | ${r.block_DEF.tiers.join('+')})`).join(', ') || 'none'}`).join('; '),
    ss.seat_sets.some((x) => x.split_tier_rows.some((r) => r.printed_row_label === '6')), 'candidate-seat-sets.json#/seat_sets/*/split_tier_rows');

  // --- conflict register expected findings ---
  for (const e of cr.entries.filter((x) => x.brief_expected_finding)) {
    if (/byte-identical invalid templates/.test(e.brief_expected_finding.expectation) || /forward-galley photo/.test(e.brief_expected_finding.expectation)) continue; // already listed above
    const failed = e.verification.checks.filter((c) => !c.pass).map((c) => c.description);
    exp(e.brief_expected_finding.expectation, 'finding present in the document text', `${e.id}: ${e.claims.filter((c) => !c.measured).length} located quotes/values, ${e.verification.checks.filter((c) => c.pass).length}/${e.verification.checks.length} checks pass${failed.length ? ' — failed: ' + failed.join('; ') : ''}`,
      e.brief_expected_finding.status === 'CONFIRMED', `conflict-register.json (${e.id})`);
  }

  // --- provenance / timing wording used in the brief ---
  const jsonTs = xf.embedded_timestamps.json_generated_at_utc;
  const docxTs = docx.metadata.core_properties?.['dcterms:created'];
  const xlsxTs = xf.embedded_timestamps.xlsx_core_created;
  exp('The DOCX is "later" than the populated registry', 'DOCX later', `DOCX core created ${docxTs}; registry generated_at_utc ${jsonTs}; XLSX core created ${xlsxTs}`, docxTs && jsonTs ? Date.parse(docxTs) > Date.parse(jsonTs) && Date.parse(docxTs) > Date.parse(xlsxTs) : null, 'extracts/docx-metadata.json; cross-format-comparison.json#/embedded_timestamps');
  exp('The DOCX is "later" than the RTF and the CSV files', 'DOCX later', `RTF \\info group present: ${rtf.info_metadata.info_group_present}; CSV files carry no internal timestamp — no internal date to compare`, null, 'extracts/rtf-paragraphs.json#/info_metadata');
  exp('The RTF carries `\\info` metadata (named in the brief as an example of metadata to report)', '\\info fields', rtf.info_metadata.info_group_present ? JSON.stringify(rtf.info_metadata.fields) : 'no \\info group in the file; only header control words (rtf version, code page, cocoartf)', rtf.info_metadata.info_group_present, 'extracts/rtf-paragraphs.json#/info_metadata');
  // --- handling rules ---
  const requested = hl.results.filter((r) => r.requested);
  const priv = hl.results.filter((r) => r.access_class === 'private');
  exp('Public-host hyperlinks get one reachability check; private hosts (SharePoint, Office 365, Outlook) are not accessed', 'public checked, private not accessed',
    `${requested.length} public URL(s) checked${hl.network_skipped ? ' (network skipped in this run; earlier results reused where available)' : ''}: ${requested.map((r) => `${r.host} → ${r.check}`).join('; ') || 'none'}; ${priv.length} private target(s) not accessed (${[...new Set(priv.map((r) => r.host))].join(', ')})`,
    priv.every((r) => !r.requested) ? (requested.length > 0 ? true : null) : false, 'extracts/hyperlinks-check.json');
  exp('All originals are unchanged after processing', 'unchanged', `${inv.integrity_check.files_unchanged} of ${inv.integrity_check.files_checked} unchanged (checked ${inv.integrity_check.checked_at})`, inv.integrity_check.all_unchanged, 'inventory.json#/integrity_check');

  // ---- checks requested without a stated expected value -------------------------
  const checks = [];
  const chk = (what, result, evidence) => checks.push({ check: what, result, evidence });
  const mism = inv.summary.extension_content_mismatches;
  chk('Actual format (magic bytes / content) vs file extension', mism.length ? `${mism.length} mismatch(es): ` + mism.map((m) => `${m.file} — ${m.extension} but ${m.actual_format}`).join('; ') : 'all extensions match the detected content', 'inventory.json#/summary/extension_content_mismatches');
  chk('Classification of the generated-code JSON (data / schema / code / prose / envelope)', `${jc.classification[F.GEMINI_JSON].classification} — ${jc.classification[F.GEMINI_JSON].basis}`, 'extracts/json-compare.json#/classification');
  chk('Declared totals in configuration records vs counted seats', ss.seat_sets.map((x) => `${x.lopa_id}: ${x.declared_totals_agree ? 'agree' : 'DIFFER'} (declared ${x.configuration.total_seats}, counted ${x.total_seat_count})`).join('; '), 'candidate-seat-sets.json#/seat_sets/*/declared_vs_counted');
  chk('Row-level active_seat_count / omitted_seat_letters vs seat records', `${ss.seat_sets.reduce((n, x) => n + x.row_level_checks.rows_checked, 0)} row records checked; ${ss.seat_sets.reduce((n, x) => n + x.row_level_checks.mismatches.length, 0)} mismatches`, 'candidate-seat-sets.json#/seat_sets/*/row_level_checks');
  chk('Foreign keys seats → rows → configurations', `all resolve: ${csv.foreign_key_checks.all_foreign_keys_resolve}; seat orphans ${csv.foreign_key_checks.seats_to_rows.orphans.length}; row orphans ${csv.foreign_key_checks.rows_to_configurations.orphans.length}; seats on row_exists=false rows ${csv.foreign_key_checks.seats_to_rows.seats_referencing_row_exists_false.length}`, 'extracts/csv-metadata.json#/foreign_key_checks');
  chk('Duplicate primary keys', Object.entries(csv.files).map(([f, m]) => `${f}: ${m.duplicate_primary_keys.length}`).join('; ') + `; ${F.ROWS_XLSX}: ${csv.foreign_key_checks.rows_to_configurations.duplicate_row_primary_keys.length}`, 'extracts/csv-metadata.json');
  chk('CSV encoding / BOM / line endings', Object.entries(csv.files).map(([f, m]) => `${f}: ${m.encoding}, BOM ${m.bom_present ? 'yes' : 'no'}, ${m.line_ending_style}, final newline ${m.ends_with_newline ? 'yes' : 'no'}`).join('; '), 'extracts/csv-metadata.json');
  chk('Workbook: sheets, hidden sheets, merged cells, formulas, defined names, external links, macros', `${wb.sheet_count} sheet(s) (${wb.sheets_summary.map((x) => `${x.name}: ${x.state}, ${x.dimension}`).join('; ')}); merged ranges ${wb.sheets_summary.reduce((n, x) => n + x.merged_cells.length, 0)}; formulas ${wb.sheets_summary.reduce((n, x) => n + x.formula_cell_count, 0)}; defined names ${wb.defined_names.length}; external links ${wb.external_links.external_link_parts.length}; vbaProject ${wb.macros.vba_project_present}; shared strings ${wb.shared_strings.parsed_unique_count} unique (${wb.shared_strings.declared_count} references declared)`, 'extracts/workbook.json');
  chk('RTF: paragraphs, tables, hyperlinks; secondary textutil cross-check', `${rtf.counts.paragraphs_non_empty} paragraphs, ${rtf.counts.tables} table(s) with ${rtf.counts.table_cells} cells, ${rtf.counts.hyperlinks} hyperlinks; textutil ${rtf.secondary_cross_check.available ? `text identical ignoring whitespace: ${rtf.secondary_cross_check.identical}` : 'not available'}`, 'extracts/rtf-paragraphs.json');
  chk('DOCX: paragraphs, tables, hyperlinks, embedded media', `${docx.paragraphs.counts.body_paragraphs} body paragraphs + ${docx.paragraphs.counts.table_cell_paragraphs} table-cell paragraphs, ${docx.tables.table_count} tables, ${docx.hyperlinks.hyperlink_count} hyperlinks (${docx.hyperlinks.distinct_target_count} distinct targets), embedded media: ${docx.metadata.embedded_media.any_embedded_media}`, 'extracts/docx-*.json');
  chk('Images: all decode; dimensions agree with a second decoder', `${Object.values(images).filter((i) => i.cross_check?.full_decode?.ok).length} of ${Object.keys(images).length} decode fully; dimensions agree for ${Object.values(images).filter((i) => i.cross_check?.dimensions_agree).length}`, 'inventory.json');
  chk('Conflict register', `${cr.summary.entries} entries; ${cr.summary.brief_expected_findings_confirmed} of ${cr.summary.brief_expected_findings} brief-expected findings confirmed; entries with unlocated quotes: ${cr.summary.entries_with_unlocated_quotes.length}`, 'conflict-register.json#/summary');

  const summary = {
    expectations: rows.length,
    confirmed: rows.filter((r) => r.status === 'CONFIRMED').length,
    differs: rows.filter((r) => r.status === 'DIFFERS').length,
    not_verifiable: rows.filter((r) => r.status === 'NOT VERIFIABLE').length,
  };
  const out = { purpose: 'Every expectation named in the brief, checked against measured values.', summary, expectations: rows, checks_without_stated_expectation: checks };
  ctx.written.push(writeJson('expectations-check.json', out));

  const md = [];
  md.push('# Expectations check');
  md.push('');
  md.push(`> ${DISCLAIMER}`);
  md.push('');
  md.push(`${summary.expectations} expectations from the brief: **${summary.confirmed} CONFIRMED**, **${summary.differs} DIFFERS**, **${summary.not_verifiable} NOT VERIFIABLE**. "Expected" restates the brief; "Measured" comes only from the script outputs named in the last column (paths relative to \`evidence/\`).`);
  md.push('');
  md.push(mdTable(['Id', 'Expectation (from the brief)', 'Expected', 'Measured actual', 'Status', 'Evidence'],
    rows.map((r) => [r.id, r.expectation, r.expected_per_brief, r.measured_actual, `**${r.status}**`, code(r.evidence)])));
  md.push('');
  const differs = rows.filter((r) => r.status !== 'CONFIRMED');
  md.push('## Not confirmed');
  md.push('');
  md.push(differs.length ? differs.map((r) => `- **${r.id} ${r.status}** — ${r.expectation}: ${r.measured_actual}`).join('\n') : 'Every expectation was confirmed.');
  md.push('');
  md.push('## Checks requested without a stated expected value');
  md.push('');
  md.push(mdTable(['Check', 'Result', 'Evidence'], checks.map((c) => [c.check, c.result, code(c.evidence)])));
  ctx.written.push(writeText('expectations-check.md', md.join('\n')));
  return out;
}
