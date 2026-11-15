// Conflict / ambiguity / assumption register.
// Entry text is authored here; every quoted claim is located in the originals at build time
// (a quote that is not found verbatim fails the build), and every count is measured.
// Decisions are non-destructive: claims are kept, never overruled by source precedence.
import { F, writeJson, writeText, mdTable, code, DISCLAIMER } from './lib/common.mjs';
import { loadSources } from './lib/sources.mjs';

const TYPE = {
  SUB: 'substantive conflict',
  AMB: 'ambiguity',
  REP: 'representation difference',
  GAP: 'gap (not supplied)',
  ASM: 'assumption',
};

export function run(ctx) {
  const s = loadSources();
  const reg = s.registry;
  const problems = [];

  // ---- claim builders -------------------------------------------------------
  const text = (kind, find, opts = {}) => {
    const units = kind === 'rtf' ? s.rtfUnits : s.docxUnits;
    const file = kind === 'rtf' ? F.RTF : F.DOCX;
    const hits = units.filter((u) => (opts.exact ? u.text === find : u.text.includes(find)));
    if (hits.length === 0) problems.push(`quote not found in ${file}: ${find}`);
    return { source_file: file, locators: hits.slice(0, 8).map((h) => `${file}#${h.locator}`), quote: find, found: hits.length > 0, occurrences: hits.length, ...(opts.note ? { note: opts.note } : {}) };
  };
  const rtf = (find, opts) => text('rtf', find, opts);
  const docx = (find, opts) => text('docx', find, opts);
  const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  const cfg = (id, field, note) => {
    const r = s.locate.config(id, field);
    return { source_file: `${F.REGISTRY_JSON} + ${F.CONFIG_CSV}`, locators: r.locators, quote: r.csv_raw ?? show(r.value), json_value: r.value, found: r.value !== undefined, subject: `lopa_configurations[${id}].${field}`, ...(note ? { note } : {}) };
  };
  const row = (id, n, field, note) => {
    const r = s.locate.row(id, n, field);
    return { source_file: `${F.REGISTRY_JSON} + ${F.ROWS_XLSX}`, locators: r.locators, quote: show(r.value), json_value: r.value, xlsx_raw: r.xlsx_raw === null ? '(absent cell)' : r.xlsx_raw?.value, found: r.value !== undefined, subject: `lopa_rows[${id}, row ${n}].${field}`, ...(note ? { note } : {}) };
  };
  const seat = (id, n, l, field, note) => {
    const r = s.locate.seat(id, n, l, field);
    return { source_file: `${F.REGISTRY_JSON} + ${F.SEATS_CSV}`, locators: r.locators, quote: r.csv_raw ?? show(r.value), json_value: r.value, found: r.value !== undefined, subject: `lopa_seats[${id}, ${n}${l}].${field}`, ...(note ? { note } : {}) };
  };
  const measured = (description, value, basis) => ({ source_file: '(measured by tools/evidence)', locators: [basis], quote: show(value), found: true, measured: true, subject: description });
  const check = (description, pass) => ({ description, pass: !!pass });

  // ---- measurements reused below ----------------------------------------------
  const ids = reg.lopa_configurations.map((c) => c.lopa_id);
  const seatsOf = (id) => reg.lopa_seats.filter((x) => x.lopa_id === id);
  const rowsOf = (id) => reg.lopa_rows.filter((x) => x.lopa_id === id);
  const dist = (items, f) => { const m = {}; for (const it of items) { const k = String(it[f]); m[k] = (m[k] ?? 0) + 1; } return m; };
  const perLopa = (fn) => Object.fromEntries(ids.map((id) => [id, fn(id)]));
  const registryText = s.registryText;
  const countIn = (hay, re) => (hay.match(re) ?? []).length;
  const rtfAll = s.rtfUnits.map((u) => u.text).join('\n');
  const docxAll = s.docxUnits.map((u) => u.text).join('\n');
  const docxLayoutRows = (s.docx.tables[0]?.rows ?? []).slice(1);
  const jc = ctx.results.jsonCompare;
  const xf = ctx.results.crossFormat;
  const cw = ctx.results.crosswalk;
  const hl = ctx.results.hyperlinks;
  const images = ctx.results.images ?? {};
  const absence = Object.fromEntries(cw.absence_checks.checks.map((a) => [a.topic, a.total_matching_text_units]));
  const totals = reg.lopa_configurations.map((c) => c.total_seats);
  const bulkheadPartial = perLopa((id) => rowsOf(id).filter((r) => r.row_exists).map((r) => {
    const ss = seatsOf(id).filter((x) => x.row_number === r.row_number);
    const b = ss.filter((x) => x.is_bulkhead_seat).length;
    return { row: r.row_number, row_flag: r.is_bulkhead_row, bulkhead_seats: b, seats: ss.length };
  }).filter((x) => x.row_flag || x.bulkhead_seats > 0));
  const exitRows = perLopa((id) => rowsOf(id).filter((r) => r.is_exit_row).map((r) => r.row_number));
  const widthDist = perLopa((id) => dist(seatsOf(id), 'effective_width_inches'));
  const pitchDist = perLopa((id) => dist(seatsOf(id), 'pitch_range_inches'));
  const powerDist = perLopa((id) => Object.keys(dist(seatsOf(id), 'power_type')));
  const singleValuePitch = reg.lopa_seats.filter((x) => /^\d+(\.\d+)?$/.test(x.pitch_range_inches)).length;
  const numericIdCells = s.workbook.conversions.numeric_cell_to_identifier_string;
  const absentCells = s.workbook.conversions.absent_cell_to_empty_string;
  const tpl = jc.files.find((f) => f.file === F.TEMPLATE_JSON);
  const gem = jc.files.find((f) => f.file === F.GEMINI_JSON);
  const tplPair = jc.pairwise.find((p) => p.a === F.TEMPLATE_JSON && p.b === F.GEMINI_JSON);
  const galley = images['forward galley flight deck.jpg'];
  const png = images['Southwest-Airlines-new-RECARO-seats-Video-still-Southwest.png'];
  const carpet = images['carpet.jpg'];
  const imageNames = Object.keys(images);
  const imagesNoText = imageNames.filter((n) => (images[n].text_metadata_strings ?? []).filter((t) => t.source !== 'ICC').length === 0);
  const imagesWithLayoutRef = imageNames.filter((n) => (images[n].text_metadata_strings ?? []).some((t) => t.source !== 'ICC' && /\b(73G|738|7M8|LOPA|row\s*\d+|seat\s*\d+[A-F])\b/i.test(t.value)));
  const galleyHits = galley?.named_entity_hits_in_metadata ?? [];
  const imgField = (img, source, fieldRe) => (img?.text_metadata_strings ?? []).filter((t) => t.source.startsWith(source) && fieldRe.test(t.field));
  const imgClaim = (file, t) => ({ source_file: file, locators: [`${file}#${t.source}:${t.field}`], quote: t.value, found: true, subject: 'embedded image metadata' });
  const elevate = ids.filter((id) => /-2$/.test(id));
  const heart = ids.filter((id) => id === '738' || id === '7M8-1');
  const row2b = bulkheadPartial[heart[0]]?.find((x) => x.row === 2);

  // ---- entries -----------------------------------------------------------------
  const entries = [];
  const add = (e) => entries.push(e);

  add({
    title: 'Layout grain: DOCX layout categories vs registry model/interior IDs; upgraded 138-seat 737-700 has no registry record',
    type: `${TYPE.SUB} + grain/crosswalk issue`,
    claims: [
      docx('four active seating layouts'),
      ...docxLayoutRows.map((r) => docx(r.cells[0].text, { exact: true, note: `capacity cell: ${r.cells[1].text}` })),
      docx('Single cabin, 3-3 seating; exit row changed from two seats to three on the affected side'),
      docx('The 137-seat and 138-seat 737-700 layouts are both in circulation while 170 selected -700s are upgraded.'),
      rtf('5 active Southwest Airlines cabin configurations (LOPAs)'),
      measured('registry lopa_id values', ids.join(', '), `${F.REGISTRY_JSON}#/lopa_configurations/*/lopa_id`),
      measured('registry total_seats values', totals.join(', '), `${F.REGISTRY_JSON}#/lopa_configurations/*/total_seats`),
      measured('occurrences of the token "138" as a whole number in registry JSON text / RTF text', `${countIn(registryText, /\b138\b/g)} / ${countIn(rtfAll, /\b138\b/g)}`, 'whole-file text search'),
      cfg('73G', 'total_seats'),
      cfg('73G', 'configuration_name'),
    ],
    claim_scope: 'Layout / LayoutRevision identity for all aircraft; specifically the 737-700.',
    why: `The DOCX layout table has ${docxLayoutRows.length} category rows (two 737-700 categories by capacity, two shared 737-800/MAX 8 categories by programme stage); the registry has ${ids.length} records keyed by model + interior (${ids.join(', ')}). This is partly a grain difference (representation of the same fleet at different granularity) and partly substantive: the DOCX category with capacity 138 has no registry record (registry totals: ${[...new Set(totals)].join(', ')}), and the DOCX gives no seat-by-seat list for it — only an arrangement sentence and the seats named in C02.`,
    impact: 'No candidate seat set exists for a 138-seat 737-700. A visit on such an aircraft cannot be served by any supplied seat map; silently using 73G would show a wrong seat count.',
    decision: 'Keep every registry lopa_id as its own candidate LayoutRevision. Record the DOCX categories as separate layout-category claims. Link the two through an explicit crosswalk table whose rows are marked "assumed, unverified" (see C22). Create the 138-seat category as a placeholder Layout with status "no seat set supplied" that cannot be selected for seat-level work. Never synthesise a 138-seat set by adding a seat to 73G. Unresolved.',
    evidence_needed: 'An approved LOPA / seat list for the 138-seat 737-700, and an authoritative mapping between layout categories and model/interior identifiers.',
    expected_finding: 'The later DOCX describes four physical-layout categories, including an upgraded 138-seat 737-700 that is absent from the 5-record registry; the DOCX does not supply a complete 138-seat seat set.',
    checks: [
      check('DOCX layout table has four category rows', docxLayoutRows.length === 4),
      check('a DOCX category row has capacity 138', docxLayoutRows.some((r) => r.cells[1].text === '138')),
      check('registry has five configuration records', ids.length === 5),
      check('no registry configuration declares 138 seats', !totals.includes(138)),
      check('DOCX names at most a handful of seat codes for the 138-seat layout (no full seat list)', (docxAll.match(/\b\d{1,2}[A-F]\b/g) ?? []).length < 20),
    ],
    extra: { docx_seat_codes_mentioned_anywhere: [...new Set(docxAll.match(/\b\d{1,2}[A-F]\b/g) ?? [])] },
  });

  const c02seats = [[7, 'D'], [7, 'E'], [7, 'F'], [15, 'B'], [15, 'C']];
  add({
    title: '138-seat 737-700: seats 7D/7E/7F/15B/15C have Extra Legroom spacing but are sold as Preferred',
    type: `${TYPE.SUB} (commercial tier vs physical space)`,
    claims: [
      docx('On the upgraded 138-seat -700 layout, seats 7D, 7E, 7F, 15B and 15C physically have Extra Legroom spacing but are sold as Preferred, not Extra Legroom.'),
      docx('the physical pitch and commercial product designation do not match', { note: 'Document content recorded as a claim; it is not treated as an instruction.' }),
      docx('Same pitch and width range as Standard for the aircraft type', { note: 'General DOCX statement about Preferred, to which the 138-seat seats are an exception.' }),
      docx('Preferred is a location upgrade, not a dimensional upgrade.'),
      ...c02seats.flatMap(([n, l]) => [seat('73G', n, l, 'commercial_tier', 'registry 73G (137 seats) — a different layout'), seat('73G', n, l, 'pitch_range_inches', 'registry 73G (137 seats) — a different layout')]),
    ],
    claim_scope: 'Only the layout the DOCX calls "upgraded 138-seat -700". Not the 137-seat 73G registry record.',
    why: `Substantive: for ${c02seats.length} named seats the commercial tier (Preferred) and the physical spacing (Extra Legroom) differ, and the DOCX's own general description of Preferred ("Same pitch and width range as Standard") does not hold for them. In the registry's 73G record the same seat codes read: ${c02seats.map(([n, l]) => `${n}${l} = ${s.locate.seat('73G', n, l, 'commercial_tier').value} / ${s.locate.seat('73G', n, l, 'pitch_range_inches').value}`).join('; ')} — so the DOCX statement cannot be transferred to 73G without contradicting it.`,
    impact: 'If tier were used as a proxy for pitch (or the reverse), appearance checks and seat-map colouring would be wrong for these seats.',
    decision: 'Store commercial tier (SeatCommercialAttributes) and physical pitch claim (SeatPhysicalAttributes) as independent attributes; never derive one from the other. Attach the DOCX statement as a raw claim scoped to the 138-seat placeholder layout only. Leave every 73G seat record exactly as supplied. Unresolved.',
    evidence_needed: 'Seat list for the 138-seat layout with per-seat pitch and commercial tier.',
    expected_finding: 'The DOCX says that in the 138-seat layout seats 7D/7E/7F/15B/15C have physical Extra Legroom spacing but are commercially Preferred; must not be applied to the 137-seat 73G.',
    checks: [
      check('registry 73G declares 137 seats (not 138)', s.locate.config('73G', 'total_seats').value === 137),
      check('registry 73G seats 7D/7E/7F are Preferred with a non-Extra-Legroom pitch claim', [[7, 'D'], [7, 'E'], [7, 'F']].every(([n, l]) => s.locate.seat('73G', n, l, 'commercial_tier').value === 'Preferred' && s.locate.seat('73G', n, l, 'pitch_range_inches').value === s.locate.config('73G', 'standard_pitch_inches').value)),
      check('registry 73G seats 15B/15C are Extra Legroom (differs from the DOCX 138-seat claim)', [[15, 'B'], [15, 'C']].every(([n, l]) => s.locate.seat('73G', n, l, 'commercial_tier').value === 'Extra Legroom')),
    ],
  });

  add({
    title: 'Extra Legroom pitch on 737-800 / MAX 8: DOCX "34 in." vs registry Elevate "33-37 (Row 14 ~37")"',
    type: TYPE.SUB,
    claims: [
      docx('34 in.', { exact: true, note: 'Extra Legroom pitch cells of both the temporary and the final 737-800 / MAX 8 rows.' }),
      docx('737-800/MAX 8: 34-inch pitch, approximately three inches more than standard'),
      ...ids.filter((id) => id !== '73G').map((id) => cfg(id, 'elr_pitch_inches')),
      rtf('receives the deepest legroom on the aircraft at ~37" pitch, while Rows 1–6, 15, and 16 measure ~33"–34".'),
      ...elevate.map((id) => measured(`per-seat pitch_range_inches distribution, ${id}`, pitchDist[id], `${F.REGISTRY_JSON}#/lopa_seats (lopa_id=${id})`)),
    ],
    claim_scope: 'Extra Legroom seats on 737-800 / MAX 8; DOCX "temporary" and "final" categories vs registry records ' + ids.filter((id) => id !== '73G').join(', ') + '.',
    why: 'Substantive: the DOCX gives a single 34-inch value for both larger-aircraft categories, while the registry (and the RTF) give the Elevate records a 33–37 band with Row 14 at about 37 inches. The two cannot both be exact. Which registry records correspond to the DOCX "final" category is itself an assumption (C22).',
    impact: 'Any pitch shown or used for an Extra Legroom seat on the newer interior depends on which source is read.',
    decision: 'Keep all three as separate raw pitch claims, each with its source, scope (layout-level vs per-seat) and qualifier. Show "sources differ — unverified" wherever they are displayed together. No numeric pitch is used in application logic. Unresolved.',
    evidence_needed: 'LOPA drawing or seat-track data giving pitch per row for each layout.',
    expected_finding: 'DOCX 34-inch larger-aircraft Extra Legroom pitch vs the registry\'s Elevate "33-37 (Row 14 ~37")" claim.',
    checks: [
      check('both DOCX larger-aircraft rows carry exactly "34 in."', docxLayoutRows.filter((r) => /737-800/.test(r.cells[0].text)).every((r) => r.cells[3].text === '34 in.')),
      check('registry Elevate records carry exactly 33-37 (Row 14 ~37")', elevate.length === 2 && elevate.every((id) => s.locate.config(id, 'elr_pitch_inches').value === '33-37 (Row 14 ~37")')),
    ],
  });

  add({
    title: 'RTF contradicts its own split Row 6 pitch',
    type: `${TYPE.SUB} (internal to one document)`,
    claims: [
      rtf('Row 6 (Split Row — 3 ELR / 3 Preferred):'),
      rtf('6A, 6B, 6C (Extra Legroom): Pitched at 34".'),
      rtf('6D, 6E, 6F (Preferred): Pitched at 31"–32".'),
      rtf('48 (1D–6C, 14–16)', { note: 'Elevate summary rows: Extra Legroom ends at 6C.' }),
      rtf('45 (6D–13F)', { note: 'Preferred starts at 6D in every larger-aircraft summary row.' }),
      rtf('identical Row 1–13 and Row 17–29 boundaries'),
      rtf('Rows 1–6, 15, and 16 measure ~33"–34".'),
      ...elevate.flatMap((id) => [row(id, 6, 'row_notes'), seat(id, 6, 'A', 'pitch_range_inches'), seat(id, 6, 'D', 'pitch_range_inches')]),
    ],
    claim_scope: 'Row 6 on the 737-800 / MAX 8 layouts, especially the Elevate records.',
    why: 'The RTF defines Row 6 as split (A–C Extra Legroom, D–F Preferred at 31"–32"), says the Elevate cabins keep identical Row 1–13 boundaries, and keeps Preferred starting at 6D in its summary table — yet its Elevate section states that "Rows 1–6 … measure ~33"–34"" without excluding 6D–6F. Read literally the last sentence contradicts the split; read loosely it is imprecise wording. Either way a row-level pitch statement is unsafe.',
    impact: 'A row-level pitch for Row 6 would be wrong for half the row.',
    decision: 'Pitch is stored per seat as a raw claim; no row-level pitch value is stored or inferred. The RTF sentence is kept as a raw narrative claim flagged "internally inconsistent with the split-row statements". Rows whose A/B/C and D/E/F blocks differ are flagged in the seat sets. Unresolved.',
    evidence_needed: 'Pitch per seat block for Row 6 from a LOPA drawing.',
    expected_finding: 'RTF contradicting its own split Row 6 pitch.',
    checks: [
      check('registry per-seat pitch for 6A and 6D differs on every larger-aircraft record', ids.filter((id) => id !== '73G').every((id) => s.locate.seat(id, 6, 'A', 'pitch_range_inches').value !== s.locate.seat(id, 6, 'D', 'pitch_range_inches').value)),
    ],
  });

  add({
    title: 'Row-level bulkhead flag is ambiguous when only one side is behind a bulkhead',
    type: TYPE.AMB,
    claims: [
      row('738', 1, 'is_bulkhead_row'), row('738', 1, 'row_notes'), row('738', 1, 'omitted_seat_letters'),
      row('738', 2, 'is_bulkhead_row'), row('738', 2, 'row_notes'),
      seat('738', 2, 'A', 'is_bulkhead_seat'), seat('738', 2, 'D', 'is_bulkhead_seat'),
      row('73G', 1, 'is_bulkhead_row'), row('73G', 1, 'row_notes'),
      rtf('Starboard-only bulkhead (1D, 1E, 1F)'),
      rtf('2A, 2B, 2C sit directly behind the port-side bulkhead wall'),
      rtf('is a dual-sided bulkhead'),
      measured('rows with a bulkhead row flag or any bulkhead seat, per lopa_id (row, row_flag, bulkhead_seats / seats)', bulkheadPartial, `${F.REGISTRY_JSON}#/lopa_rows + #/lopa_seats`),
    ],
    claim_scope: 'Rows 1 and 2 of every 737-800 / MAX 8 record; Row 1 of 73G for contrast.',
    why: `On the larger aircraft the row flag is true for Row 1, where only D/E/F exist, and false for Row 2, where ${row2b?.bulkhead_seats} of ${row2b?.seats} seats (A/B/C) are flagged as bulkhead seats. A single row boolean cannot say which side is behind a bulkhead, and it disagrees with the seat flags for Row 2.`,
    impact: 'Deriving bulkhead treatment (tray table, stowage, appearance items) from the row flag would miss 2A–2C and could over-apply to seats that are not behind a bulkhead.',
    decision: 'Seat-level is_bulkhead_seat is stored per seat; the row-level flag is stored as a separate raw row claim. The application never derives a seat\'s bulkhead status from the row flag and shows both when they differ. Unresolved (neither flag is verified).',
    evidence_needed: 'LOPA showing monument and bulkhead positions per side.',
    expected_finding: 'Row bulkhead flags with partial-side ambiguity (row-level flag vs seat-level flags when only one side is behind a bulkhead).',
    checks: [
      check('some existing row has is_bulkhead_row=false while some of its seats have is_bulkhead_seat=true', Object.values(bulkheadPartial).some((list) => list.some((x) => !x.row_flag && x.bulkhead_seats > 0))),
      check('some row has bulkhead seats on only part of the row', Object.values(bulkheadPartial).some((list) => list.some((x) => x.bulkhead_seats > 0 && x.bulkhead_seats < x.seats))),
    ],
  });

  add({
    title: 'Approximate pitch statements appear as exact strings in per-seat fields',
    type: `${TYPE.REP} with loss of a qualifier (substantive risk of false precision)`,
    claims: [
      rtf('Row 14 Pitch Increase (~37"):'),
      rtf('offer standard ~34" ELR pitch'),
      rtf('Rows 1–6, 15, and 16 measure ~33"–34".'),
      ...elevate.slice(0, 1).flatMap((id) => [
        cfg(id, 'elr_pitch_inches'), row(id, 14, 'row_notes'), seat(id, 14, 'A', 'pitch_range_inches'), seat(id, 14, 'A', 'special_notes'),
        seat(id, 16, 'A', 'pitch_range_inches'), seat(id, 2, 'A', 'pitch_range_inches'),
      ]),
      measured('seat records whose pitch_range_inches is a single number (no range, no "~")', singleValuePitch, `${F.REGISTRY_JSON}#/lopa_seats/*/pitch_range_inches`),
      measured('seat records with pitch_range_inches exactly "37"', reg.lopa_seats.filter((x) => x.pitch_range_inches === '37').length, `${F.REGISTRY_JSON}#/lopa_seats/*/pitch_range_inches`),
      measured('seat records whose pitch_range_inches contains "~"', reg.lopa_seats.filter((x) => x.pitch_range_inches.includes('~')).length, `${F.REGISTRY_JSON}#/lopa_seats/*/pitch_range_inches`),
    ],
    claim_scope: 'Per-seat pitch_range_inches on the Elevate records; the field in general.',
    why: 'The narrative, the configuration record and the row/seat notes all qualify these values with "~" (about 37, about 33–34, about 34). The per-seat field holds the bare strings "37" and "33-34". The qualifier is lost in the per-seat representation, and a field named "range" holds single numbers.',
    impact: 'An exact-looking pitch could be mistaken for a measured dimension or compared numerically.',
    decision: 'Store the per-seat string verbatim plus a flag "approximate in sibling claims" where the configuration, row note, seat note or narrative marks the same value with "~". Display with that flag; never present as a measurement; never compute with it. Unresolved.',
    evidence_needed: 'Measured or drawing-based pitch with stated tolerance.',
    expected_finding: 'Approximate pitches turned into falsely exact strings.',
    checks: [
      check('per-seat field holds "37" with no "~" while the same seat\'s special_notes says ~37"', elevate.every((id) => s.locate.seat(id, 14, 'A', 'pitch_range_inches').value === '37' && s.locate.seat(id, 14, 'A', 'special_notes').value.includes('~37"'))),
      check('no per-seat pitch string carries a "~"', reg.lopa_seats.every((x) => !x.pitch_range_inches.includes('~'))),
    ],
  });

  add({
    title: 'Shoulder clearance and seat width are conflated in the width fields',
    type: `${TYPE.SUB} (different measurement kinds in one field)`,
    claims: [
      ...heart.slice(0, 1).flatMap((id) => [seat(id, 10, 'A', 'effective_width_inches'), seat(id, 10, 'A', 'window_notes'), cfg(id, 'max_seat_width_inches'), seat(id, 10, 'B', 'effective_width_inches'), seat(id, 1, 'D', 'effective_width_inches', 'bulkhead seat')]),
      rtf('also reduces shoulder width by ~2" due to the missing window reveal'),
      ...elevate.slice(0, 1).flatMap((id) => [seat(id, 10, 'A', 'effective_width_inches'), seat(id, 10, 'A', 'window_notes')]),
      rtf('10A: Remains completely windowless due to fuselage structural ducting.'),
      docx('Seat width', { exact: true }),
      docx('15.5-17.8 in.', { exact: true }),
      docx('it is not a wider seat'),
      measured('effective_width_inches distribution per lopa_id', widthDist, `${F.REGISTRY_JSON}#/lopa_seats/*/effective_width_inches`),
      measured('difference between max_seat_width_inches and 10A effective_width_inches on ' + heart.join(' / '), heart.map((id) => Number((s.locate.config(id, 'max_seat_width_inches').value - s.locate.seat(id, 10, 'A', 'effective_width_inches').value).toFixed(2))).join(' / '), 'computed from the two located values'),
    ],
    claim_scope: 'Seat 10A on the non-Elevate larger-aircraft records; the meaning of max_seat_width_inches / effective_width_inches / DOCX "Seat width" generally.',
    why: 'On the non-Elevate records the registry lowers 10A\'s "effective width" by the approximate shoulder-clearance loss the RTF describes at the windowless sidewall, turning "~2 inches narrower shoulder clearance" into an exact seat-width number. Shoulder clearance at the wall and seat width are different measurements. The same windowless seat on the Elevate records keeps the full width value. No source defines what "seat width", "max seat width" or "effective width" measures.',
    impact: 'Width could be shown as a seat dimension when it is partly a sidewall-clearance statement; the two interiors are treated inconsistently for the same seat.',
    decision: 'Store each width value as a raw claim with measurement_kind = "unspecified by source" and the source field name. Keep the shoulder-clearance statement as its own sidewall/window note. Do not recompute or "correct" 10A. Flag 10A on all four larger-aircraft records. Unresolved.',
    evidence_needed: 'Seat supplier dimensional data and a definition of the width measurement used.',
    expected_finding: 'Shoulder clearance vs seat width conflated in the width field(s).',
    checks: [
      check('10A effective width is lower than the neighbouring seat on the non-Elevate records and its note cites shoulder clearance', heart.every((id) => s.locate.seat(id, 10, 'A', 'effective_width_inches').value < s.locate.seat(id, 10, 'B', 'effective_width_inches').value && /shoulder clearance/.test(s.locate.seat(id, 10, 'A', 'window_notes').value))),
      check('10A keeps the full width on the Elevate records', elevate.every((id) => s.locate.seat(id, 10, 'A', 'effective_width_inches').value === s.locate.seat(id, 10, 'B', 'effective_width_inches').value)),
    ],
  });

  add({
    title: 'DOCX temporary-layout wording about the rear row does not identify a seat',
    type: TYPE.AMB,
    claims: [
      docx('737-800 / MAX 8, temporary LOPA', { exact: true }),
      docx('Single cabin, 3-3 seating; reduced seating at part of the exit-row and rear-row areas'),
      docx('Single cabin, 3-3 seating; three seats on both sides of the exit row and two seats on both sides of the last row'),
      docx('The final layout adds one Extra Legroom seat on each side of the exit row, while the last row becomes two seats per side, keeping the overall capacity unchanged.'),
      ...heart.slice(0, 1).flatMap((id) => [row(id, 15, 'omitted_seat_letters'), row(id, 30, 'active_seat_count'), row(id, 30, 'omitted_seat_letters'), cfg(id, 'total_seats')]),
      ...elevate.slice(0, 1).flatMap((id) => [row(id, 30, 'omitted_seat_letters'), row(id, 30, 'row_notes')]),
      rtf('Full 3-3 layout (A–F) across all 14 rows'),
      rtf('1A, 1B, 1C, 2 seats in Row 30'),
      rtf('Row 30 drops two window-side positions to become a 4-seat rear row'),
    ],
    claim_scope: 'Last row (and exit row) of the 737-800 / MAX 8 "temporary" category; registry records ' + heart.join(', ') + ' if the C22 crosswalk assumption holds.',
    why: `The DOCX says the temporary layout has "reduced seating at part of the exit-row and rear-row areas" but names no seat. The registry's non-Elevate records show a reduced exit row and a full ${s.locate.row(heart[0], 30, 'active_seat_count').value}-seat last row at the same declared total. The DOCX also describes the final last row only as "two seats on both sides" without letters, while the RTF summary says "2 seats in Row 30" and only its narrative and the registry say which positions are absent.`,
    impact: 'There is no basis for removing any particular rear-row seat from a temporary-layout seat map.',
    decision: 'Do not add or remove any rear-row seat in any candidate seat set. Keep the DOCX sentence as a raw layout-level claim. Mark the last row of the linked candidate sets "DOCX claims reduced rear-row seating; seat not identified; unresolved" and surface that as a warning. Unresolved.',
    evidence_needed: 'LOPA for the temporary layout showing the last row.',
    expected_finding: 'Temporary-layout rear-row wording that does not identify a specific seat to remove.',
    checks: [
      check('the DOCX temporary-layout arrangement cell contains no seat code', !/\b\d{1,2}[A-F]\b/.test(docxLayoutRows.find((r) => /temporary/.test(r.cells[0].text))?.cells[2].text ?? 'X1A')),
      check('registry non-Elevate last row has six seats and no omitted letters', heart.every((id) => s.locate.row(id, 30, 'active_seat_count').value === 6 && s.locate.row(id, 30, 'omitted_seat_letters').value === '')),
    ],
  });

  add({
    title: 'Not supplied: dated tail assignments, parts / applicability / substitute catalogue, floor or bin map, coordinate frame, cabin height, image-to-layout mapping',
    type: TYPE.GAP,
    claims: [
      measured('keyword mentions across registry, schema CSV, RTF and DOCX (text units)', absence, 'evidence/field-crosswalk.json#/absence_checks'),
      cfg('7M8-1', 'wifi_system', 'the only tail-like token in any source; it sits inside free text'),
      cfg('738', 'lavatory_count_aft', 'a count, not a floor map'),
      measured('registry schema_metadata.schema_version / generated_at_utc', `${reg.schema_metadata?.schema_version} / ${reg.schema_metadata?.generated_at_utc}`, `${F.REGISTRY_JSON}#/schema_metadata`),
      measured('DOCX core properties title / creator / created', `${s.docx.core_properties?.['dc:title']} / ${s.docx.core_properties?.['dc:creator']} / ${s.docx.core_properties?.['dcterms:created']}`, `${F.DOCX}#docProps/core.xml`),
      docx('As of November 13, 2026'),
      measured('RTF \\info group present', s.rtf.info_group_present, `${F.RTF} (header)`),
      measured('images whose embedded metadata mentions a layout id, LOPA, row or seat', imagesWithLayoutRef.length, 'evidence/inventory.json (image metadata)'),
      ...ids.map((id) => cfg(id, 'est_active_aircraft', 'an estimate, not a tail list')),
    ],
    claim_scope: 'Aircraft(tail), TailAssignment, Part, Component, ApplicabilityRule, SubstituteApproval, KitChild, FloorArea, BinModule, MaterialProfile, coordinates, cabin height, image mapping, ValidationRelease.',
    why: `None of these data sets exists in the supplied files. Mentions that look related are free text: ${absence['tail registration token (N-number)']} text unit(s) with a tail-like token inside a Wi-Fi description, qualified fleet-size estimates, lavatory counts, and "floor stowage" notes. The registry version string and generation timestamp, the DOCX "As of" date and the generic document title are metadata about files, not approvals, and do not fill any of these gaps.`,
    impact: 'The application cannot truthfully resolve a tail to a layout, list parts or kits for a seat, place anything on a floor/bin map, draw to scale, or tie a photo to a layout from the supplied evidence.',
    decision: 'Mark each of these entities "not supplied" in the model. Anything the application needs for them must come from clearly labelled demo fixtures kept apart from source-derived claims, and every screen/report using them states that. Timestamps, versions and titles are stored only as SourceArtifact metadata and are never promoted to a ValidationRelease. Unresolved.',
    evidence_needed: 'Approved dated tail-to-layout assignments; parts/kit catalogue with applicability and substitute approvals; floor and bin maps; a coordinate frame with stations; cabin cross-section dimensions; a catalogued image set with layout references; an actual validation/approval record.',
    expected_finding: 'No approved dated tail assignment, parts/applicability/substitute catalog, exact floor/bin map, coordinate frame, exact cabin height, or image-to-layout mapping is supplied; generated timestamps and titles do not fill those gaps.',
    checks: [
      check('no part-number / manual reference mentions', absence['part number / manual reference'] === 0),
      check('no substitute / alternate mentions', absence['substitute / alternate / interchangeable'] === 0),
      check('no coordinate / station / datum mentions', absence['coordinate / station / datum'] === 0),
      check('no height / ceiling mentions', absence['height / ceiling'] === 0),
      check('no overhead-bin mentions', absence['overhead bin'] === 0),
      check('no approval / authorisation mentions', absence['approval / approved / authorised'] === 0),
      check('at most one text unit contains a tail-like token, and no tail list exists', absence['tail registration token (N-number)'] <= 1),
      check('no image metadata references a layout, row or seat', imagesWithLayoutRef.length === 0),
    ],
  });

  add({
    title: 'Row count wording: row records vs printed labels vs physical rows',
    type: TYPE.REP,
    claims: [
      measured('registry schema_metadata lopa_rows.record_count', reg.schema_metadata?.entities?.lopa_rows?.record_count, `${F.REGISTRY_JSON}#/schema_metadata/entities/lopa_rows/record_count`),
      measured('schema CSV "Row Count" for lopa_rows (raw)', s.schemaCsv.rows.find((r) => r.values['Entity / Table'] === 'lopa_rows')?.values['Row Count'], `${F.SCHEMA_CSV}:L${s.schemaCsv.rows.find((r) => r.values['Entity / Table'] === 'lopa_rows')?.line}:Row Count`),
      measured('row records with row_exists=true / row_exists=false', `${reg.lopa_rows.filter((r) => r.row_exists).length} / ${reg.lopa_rows.filter((r) => !r.row_exists).length}`, `${F.REGISTRY_JSON}#/lopa_rows/*/row_exists`),
      measured('73G: row records / existing rows / highest printed label', `${rowsOf('73G').length} / ${rowsOf('73G').filter((r) => r.row_exists).length} / ${Math.max(...rowsOf('73G').map((r) => r.row_number))}`, `${F.REGISTRY_JSON}#/lopa_rows (lopa_id=73G)`),
      cfg('73G', 'numbered_row_range'),
      row('73G', 10, 'row_exists'), row('73G', 10, 'recline_status'), row('73G', 10, 'omitted_seat_letters'),
      rtf('skips Rows 10–13 entirely'),
      rtf('Rows 10–13 (Non-Existent — 0 seats):'),
    ],
    claim_scope: 'RowLabel for every layout; 73G in particular.',
    why: 'The "row count" in the registry metadata and the schema summary counts row records, including placeholder records for printed labels that do not exist in the cabin. On 73G the highest printed label is larger than the number of physical rows. This is a representation matter, but counting or ordering rows by label would be wrong.',
    impact: 'Row counts, "row n of m" displays and forward/aft ordering go wrong if printed labels are treated as physical indices.',
    decision: 'RowLabel stores printed_label (string), exists (boolean) and a separately derived physical_order. Non-existent labels are kept as records with exists=false and are never rendered as rows. Every count states whether it counts records, printed labels or physical rows. The physical order itself remains an assumption (ascending label).',
    evidence_needed: 'Drawing confirming physical row order and the skipped labels.',
    expected_finding: null,
    checks: [check('row records exceed existing rows', reg.lopa_rows.length > reg.lopa_rows.filter((r) => r.row_exists).length)],
  });

  add({
    title: 'Exit-row flag semantics differ between configurations and from the DOCX description',
    type: TYPE.AMB,
    claims: [
      rtf('overwing emergency exits fall in the Row 14–16 band'),
      rtf('Twin-overwing exit zone pitched at 34"'),
      measured('rows with is_exit_row=true per lopa_id', exitRows, `${F.REGISTRY_JSON}#/lopa_rows/*/is_exit_row`),
      row('738', 14, 'recline_restriction_reason'), row('738', 15, 'recline_restriction_reason'),
      row('738', 16, 'is_exit_row'), row('738', 16, 'row_notes'), seat('738', 16, 'B', 'special_notes'),
      row('73G', 14, 'is_exit_row'), row('73G', 14, 'row_notes'), row('73G', 14, 'active_seat_count'),
      row('73G', 15, 'is_exit_row'), row('73G', 15, 'active_seat_count'),
      docx('Single cabin, 3-3 seating; one double-seat exit-row section'),
    ],
    claim_scope: 'is_exit_row / is_exit_seat on every record; the 137-seat 737-700 exit area.',
    why: `On the larger aircraft ${exitRows[heart[0]].length} rows (${exitRows[heart[0]].join(', ')}) are flagged as exit rows although the text describes twin overwing exits and calls one of them a row that "reclines normally" in an "exit zone". On 73G the ${s.locate.row('73G', 14, 'active_seat_count').value}-seat row whose missing seat is explained by exit access is not flagged, and the flagged exit row has ${s.locate.row('73G', 15, 'active_seat_count').value} seats — while the DOCX describes the 137-seat aircraft as having "one double-seat exit-row section". "Exit row" therefore means different things (next to a hatch, inside an exit zone, subject to seating criteria) and the sources do not say which.`,
    impact: 'Exit-related appearance items or placards could be assigned to the wrong rows; the flags must not be read as a regulatory determination.',
    decision: 'Store is_exit_row and is_exit_seat as separate raw claims labelled "exit-zone claim (source)". Keep the DOCX arrangement sentence as a raw claim on the 137-seat category, flagged as not matching the registry row flags. No regulatory meaning is attached. Unresolved.',
    evidence_needed: 'LOPA showing exit locations per side and the rows adjacent to them.',
    expected_finding: null,
    checks: [check('73G row with an omitted seat (14) is not flagged as exit row while row 15 is', s.locate.row('73G', 14, 'is_exit_row').value === false && s.locate.row('73G', 15, 'is_exit_row').value === true)],
  });

  add({
    title: 'Seat width differs between configurations with the same hardware label and from the DOCX ranges',
    type: `${TYPE.SUB} (unexplained) + ${TYPE.REP}`,
    claims: [
      ...ids.map((id) => cfg(id, 'max_seat_width_inches')),
      ...elevate.map((id) => cfg(id, 'seat_hardware_model')),
      docx('15.5-17.0 in.', { exact: true }),
      docx('15.5-17.8 in.', { exact: true }),
      measured('numeric values whose CSV text differs lexically from the JSON number (e.g. "17.0" vs 17)', xf.totals.explicit_conversions['csv_number_text_lexically_different_from_json_number (e.g. "17.0" vs 17)'] ?? 0, 'evidence/cross-format-comparison.json#/totals/explicit_conversions'),
    ],
    claim_scope: 'max_seat_width_inches (layout level) and effective_width_inches (seat level); DOCX "Seat width" ranges.',
    why: `${elevate.length} registry records share the hardware label ${code(s.locate.config(elevate[0], 'seat_hardware_model').value)} but declare different maximum widths (${elevate.map((id) => `${id}: ${s.locate.config(id, 'max_seat_width_inches').csv_raw}`).join(', ')}); the DOCX gives one range for both larger-aircraft categories. Separately, the same number is written with a trailing zero in CSV and without in JSON — a pure representation difference.`,
    impact: 'A width shown for a seat depends on the record chosen; numeric round-tripping silently changes the written form.',
    decision: 'Store widths as raw claims per source and level with measurement_kind "unspecified by source". Keep the CSV decimal text beside the JSON number. No normalisation across records. Unresolved.',
    evidence_needed: 'Seat supplier data per hardware model and installation.',
    expected_finding: null,
    checks: [check('the two Elevate records declare different max_seat_width_inches', elevate.length === 2 && s.locate.config(elevate[0], 'max_seat_width_inches').value !== s.locate.config(elevate[1], 'max_seat_width_inches').value)],
  });

  add({
    title: 'Estimated fleet counts are qualified free text and cannot be reconciled with the DOCX fleet numbers',
    type: TYPE.AMB,
    claims: [
      ...ids.map((id) => cfg(id, 'est_active_aircraft')),
      docx('170 selected -700s are upgraded'),
      docx('Southwest expects the remaining non-upgraded aircraft to be retired, sold or otherwise removed from the fleet.'),
    ],
    claim_scope: 'Layout.estimated_fleet_count_claim; anything resembling fleet size per layout.',
    why: 'The registry values are approximations ("~"), open-ended ("+ (expanding)") or not numbers at all. The DOCX gives a different kind of number (aircraft selected for an upgrade to a layout the registry does not contain). Neither is a list of aircraft.',
    impact: 'No fleet size, percentage or tail population can be computed.',
    decision: 'Keep each string verbatim as an estimate claim; never parse it into a number; never create Aircraft or TailAssignment records from it. Unresolved.',
    evidence_needed: 'A dated fleet list with tail numbers and installed layout.',
    expected_finding: null,
    checks: [check('no est_active_aircraft value is a plain number', ids.every((id) => !/^\d+$/.test(s.locate.config(id, 'est_active_aircraft').value)))],
  });

  add({
    title: 'Seat hardware and interior names differ between sources',
    type: `${TYPE.AMB} (naming / crosswalk)`,
    claims: [
      docx('The 138-seat version replaces Innovator seats with Meridian seats, adds in-seat power and converts the affected exit-row position to a triple-seat arrangement.'),
      docx('Existing aircraft can have Innovator, Collins Meridian or RECARO R2 seating, depending on the aircraft and retrofit status.'),
      rtf('2025 "Elevate" Factory', { exact: true }),
      ...ids.map((id) => cfg(id, 'seat_hardware_model')),
      ...elevate.map((id) => cfg(id, 'configuration_name')),
      ...ids.map((id) => cfg(id, 'interior_generation')),
      measured('occurrences of "Innovator" / "Meridian" in registry JSON text and in RTF text', `registry ${countIn(registryText, /Innovator/g)} / ${countIn(registryText, /Meridian/g)}; RTF ${countIn(rtfAll, /Innovator/g)} / ${countIn(rtfAll, /Meridian/g)}`, 'whole-file text search'),
      measured('occurrences of "Elevated" vs "Elevate" (not followed by d) in registry configuration records', `${countIn(JSON.stringify(reg.lopa_configurations), /Elevated/g)} vs ${countIn(JSON.stringify(reg.lopa_configurations), /Elevate(?!d)/g)}`, `${F.REGISTRY_JSON}#/lopa_configurations`),
    ],
    claim_scope: 'MaintenanceVariant and SeatHardware labels.',
    why: 'The DOCX names seat products that never appear in the registry or the RTF, while the registry uses other labels. Within the registry the same interior is written two ways in different fields, and the 737-700 record is described as both "Legacy" hardware and a "Retrofit" generation while the DOCX associates the 137-seat layout with aircraft that are not upgraded. No source maps one naming scheme to the other.',
    impact: 'Hardware-dependent appearance rules cannot be keyed reliably; synonyms might be merged wrongly.',
    decision: 'Store every label verbatim with its source. No synonym merging. Any MaintenanceVariant / SeatHardware crosswalk is an explicit table with status "assumed, unverified". Unresolved.',
    evidence_needed: 'Authoritative seat model per layout (and per tail), with part numbers.',
    expected_finding: null,
    checks: [check('DOCX seat product names "Innovator" and "Meridian" do not occur in the registry', countIn(registryText, /Innovator|Meridian/g) === 0)],
  });

  add({
    title: 'In-seat power claims are airframe-dependent alternatives copied to every seat',
    type: TYPE.AMB,
    claims: [
      ...ids.flatMap((id) => {
        const first = seatsOf(id)[0];
        return [cfg(id, 'in_seat_power'), seat(id, first.row_number, first.seat_letter, 'power_type')];
      }),
      docx('adds in-seat power'),
      measured('distinct power_type values per lopa_id', powerDist, `${F.REGISTRY_JSON}#/lopa_seats/*/power_type`),
    ],
    claim_scope: 'SeatPhysicalAttributes.power at layout and seat level.',
    why: 'Configuration-level and seat-level strings word the same claim differently, several state alternatives that depend on the individual airframe ("select retrofits", "newer frames", "most airframes"), and each configuration repeats one string on all of its seats. The DOCX ties in-seat power to the upgraded layout that has no registry record.',
    impact: 'Whether a given seat on a given aircraft has power cannot be stated.',
    decision: 'Keep both strings verbatim at their own level. Power is shown as "source claim, airframe-dependent"; it is never asserted for a specific aircraft without tail-level evidence. Unresolved.',
    evidence_needed: 'Per-tail modification status.',
    expected_finding: null,
    checks: [check('each configuration uses exactly one power_type string for all of its seats', Object.values(powerDist).every((v) => v.length === 1))],
  });

  add({
    title: 'Compound enumeration values and unverified regulatory attributions',
    type: TYPE.AMB,
    claims: [
      measured('distinct recline_status values (rows)', dist(reg.lopa_rows, 'recline_status'), `${F.REGISTRY_JSON}#/lopa_rows/*/recline_status`),
      measured('distinct window_status values (seats)', dist(reg.lopa_seats, 'window_status'), `${F.REGISTRY_JSON}#/lopa_seats/*/window_status`),
      measured('schema CSV wording for window_status', (/window_status \([^)]*\)/.exec(s.schemaCsv.rows.map((r) => r.values['Grain & Purpose']).join(' ')) ?? [''])[0], `${F.SCHEMA_CSV}:L${s.schemaCsv.rows.at(-1)?.line}:Grain & Purpose`),
      rtf('Limited or zero recline against the twin aft lavatory bulkheads.'),
      rtf('Zero / severely restricted recline (center overwing exit row).'),
      row('738', 15, 'recline_status'),
      rtf('Locked / zero recline per FAA regulations'),
      row('73G', 14, 'recline_restriction_reason'),
      rtf("Flagged in Southwest's official seat-selection disclosure"),
    ],
    claim_scope: 'recline_status, window_status and their reason/notes fields.',
    why: 'Values such as "None/Limited", "None/Restricted", "Limited/Missing" and "Misaligned/Set-Back" state alternatives rather than one condition. The schema summary lists window statuses as one slash-separated string that can be read as separate values, while the data uses compound values. Reasons citing regulation or an "official disclosure" are attributions with no reference supplied.',
    impact: 'Filtering or rule logic on these values would need an interpretation the sources do not give.',
    decision: 'Store the enumeration strings exactly as supplied (no splitting, no mapping to a stricter enum). Show reason text as "source note". No rule is derived from a regulatory attribution. Unresolved.',
    evidence_needed: 'Definitions of each status; the cited disclosure or regulatory basis.',
    expected_finding: null,
    checks: [check('at least one status value contains a "/" alternative', Object.keys(dist(reg.lopa_seats, 'window_status')).concat(Object.keys(dist(reg.lopa_rows, 'recline_status'))).some((v) => v.includes('/') && v !== 'N/A'))],
  });

  add({
    title: 'Workbook stores one identifier as a number and blanks as absent cells',
    type: TYPE.REP,
    claims: [
      measured('lopa_id cells stored as numbers in the workbook', numericIdCells.length, `${F.ROWS_XLSX}#${numericIdCells[0] ?? ''} … ${numericIdCells.at(-1) ?? ''}`),
      measured('first such cell: raw value / type', `${s.xlsx.sheets[0].cells.find((c) => c.locator === numericIdCells[0])?.raw_v} / ${s.xlsx.sheets[0].cells.find((c) => c.locator === numericIdCells[0])?.value_type}`, `${F.ROWS_XLSX}#${numericIdCells[0] ?? ''}`),
      cfg('738', 'lopa_id'),
      measured('cells absent from the sheet XML where the JSON holds an empty string', absentCells.length, 'evidence/extracts/workbook.json#/normalization'),
      measured('workbook application / recorded authoring path', `${s.xlsx.app_properties?.Application} / ${s.xlsx.authoring_path_recorded_in_workbook}`, `${F.ROWS_XLSX}#docProps/app.xml, xl/workbook.xml`),
    ],
    claim_scope: 'southwest_737_lopa_rows.xlsx only.',
    why: 'Pure representation: the spreadsheet typed the all-digit identifier as a number and omits empty cells. After two explicit conversions every value agrees with the JSON (see cross-format comparison).',
    impact: 'A naive import would produce a numeric key that fails to join to the string key in the other files, and nulls instead of empty strings.',
    decision: 'Import treats lopa_id as a string and records the numeric-to-string conversion per cell; absent cells become "" with the conversion recorded. No other coercion is applied anywhere. Resolved as a representation rule (the underlying claims stay unverified).',
    evidence_needed: 'None for the representation; the claims themselves still need independent verification.',
    expected_finding: null,
    checks: [check('conversions leave zero mismatches against the JSON', xf.totals.mismatching === 0)],
  });

  add({
    title: 'Two byte-identical JSON-named files are invalid templates, one named almost like the populated registry',
    type: `${TYPE.REP} (artifact role)`,
    claims: [
      measured(`${F.TEMPLATE_JSON}: size / sha256 / parses`, `${tpl.size_bytes} / ${tpl.sha256} / ${tpl.parses_as_json}`, `${F.TEMPLATE_JSON} (whole file)`),
      measured(`${F.GEMINI_JSON}: size / sha256 / parses`, `${gem.size_bytes} / ${gem.sha256} / ${gem.parses_as_json}`, `${F.GEMINI_JSON} (whole file)`),
      measured('byte-identical', tplPair.byte_identical, 'evidence/extracts/json-compare.json#/pairwise'),
      measured('first syntax error (offset, line:column, found)', `${tpl.strict_validator_error?.offset}, ${tpl.strict_validator_error?.line}:${tpl.strict_validator_error?.column}, ${JSON.stringify(tpl.strict_validator_error?.found)}`, `${F.TEMPLATE_JSON}@byte ${tpl.strict_validator_error?.offset}`),
      measured('literal "[ ... ]" placeholders', tpl.literal_placeholder_bracket_ellipsis.count, `${F.TEMPLATE_JSON}@bytes ${tpl.literal_placeholder_bracket_ellipsis.offsets.join(', ')}`),
    ],
    claim_scope: 'SourceArtifact roles for the three JSON-named files.',
    why: 'The space-named file and the generated-code file are the same bytes: an envelope with a metadata header and elided arrays. It is not valid JSON and holds no records. Its name differs from the populated registry only by spaces vs underscores, so file-name based selection is unsafe.',
    impact: 'Importing by name could pick the template; "repairing" it would invent content.',
    decision: 'Both are inventoried as invalid template artifacts, excluded from import and never repaired. The populated registry is recognised by content (valid JSON with populated arrays and its SHA-256), not by file name.',
    evidence_needed: 'None.',
    expected_finding: 'The 548-byte space-named JSON and gemini JSON are byte-identical invalid templates containing literal "[ ... ]".',
    checks: [
      check('both files are 548 bytes', tpl.size_bytes === 548 && gem.size_bytes === 548),
      check('byte-identical', tplPair.byte_identical === true),
      check('neither parses as JSON', !tpl.parses_as_json && !gem.parses_as_json),
      check('contains the literal "[ ... ]"', tpl.literal_placeholder_bracket_ellipsis.count > 0),
    ],
  });

  add({
    title: 'DOCX wording of the extra pitch ("up to five" / "approximately three" vs "five" / "three")',
    type: `${TYPE.AMB} (minor, internal to one document)`,
    claims: [
      docx('737-700: 35-36-inch pitch, up to five inches more than standard. 737-800/MAX 8: 34-inch pitch, approximately three inches more than standard'),
      docx('five inches on the 737-700 and three inches on the 737-800/MAX 8'),
      docx('35-36 in.', { exact: true }),
      docx('31-33 in.', { exact: true }),
      docx('31-32 in.', { exact: true }),
    ],
    claim_scope: 'Any derived "extra legroom inches" figure.',
    why: 'The table qualifies the extra pitch ("up to", "approximately"); the following paragraph states it without qualifiers. With the document\'s own ranges the difference is a span, not one number.',
    impact: 'A single "extra inches" figure would overstate precision.',
    decision: 'No derived "extra inches" attribute is created. Both sentences are kept as raw claims.',
    evidence_needed: 'None beyond the pitch evidence in C03.',
    expected_finding: null,
    checks: [check('both wordings are present', true)],
  });

  add({
    title: 'Cited sources cannot be verified from the supplied files',
    type: TYPE.ASM,
    claims: [
      docx('The measurements above are Southwest’s published ranges.'),
      docx('Recent Tech Ops communication identifies a planned'),
      measured('DOCX hyperlinks: total / distinct targets / private (not accessed) / public requested', `${ctx.results.docx.hyperlinks.hyperlink_count} / ${hl.summary.distinct_targets} / ${hl.summary.private_not_accessed} / ${hl.summary.public_requested}`, 'evidence/extracts/docx-hyperlinks.json, evidence/extracts/hyperlinks-check.json'),
      measured('public link reachability (final HTTP status per URL)', hl.summary.status_codes.length ? hl.summary.status_codes.map((x) => `${x.final_status_code ?? 'no response'}`).join(', ') : 'not checked in this run', 'evidence/extracts/hyperlinks-check.json#/summary/status_codes'),
      measured('DOCX sensitivity-label references', s.docx.sensitivity_labels.length, `${F.DOCX}#docMetadata/LabelInfo.xml`),
      measured('RTF hyperlinks', s.rtf.hyperlinks.length, `${F.RTF}`),
    ],
    claim_scope: 'Every DOCX statement that rests on a cited page or message; all RTF statements (which cite nothing).',
    why: 'The DOCX attributes its figures to published ranges and to intranet pages and a mail item. The private targets were deliberately not accessed, and a status code from a public page says nothing about what the page states or whether it is current. The RTF contains no citations at all.',
    impact: 'No narrative claim can be treated as verified.',
    decision: 'Store each hyperlink as a cited reference with its access class and reachability note. No claim is promoted to "verified" on the strength of a link. All narrative claims remain "unverified source claim".',
    evidence_needed: 'Copies of the cited pages/messages supplied through an approved channel, or the underlying controlled documents.',
    expected_finding: null,
    checks: [check('no private host was requested', hl.results.every((r) => r.access_class !== 'private' || r.requested === false))],
  });

  add({
    title: 'Reference images: third-party metadata, another airline named, no link to any layout',
    type: `${TYPE.AMB} (provenance) + ${TYPE.GAP}`,
    claims: [
      ...galleyHits.map((h) => ({ source_file: 'forward galley flight deck.jpg', locators: [`forward galley flight deck.jpg#${h.field}`], quote: h.value, found: true, subject: 'embedded image metadata' })),
      ...imgField(galley, 'IPTC', /ObjectName|Caption-Abstract|CopyrightNotice/).map((t) => imgClaim('forward galley flight deck.jpg', t)),
      ...imgField(galley, 'EXIF.IFD0', /^(DateTime|Copyright)$/).map((t) => imgClaim('forward galley flight deck.jpg', t)),
      ...imgField(png, 'EXIF.Exif', /UserComment/).map((t) => imgClaim('Southwest-Airlines-new-RECARO-seats-Video-still-Southwest.png', t)),
      measured('PNG: encoded size vs size declared in its XMP', png ? `${png.pixel_width}x${png.pixel_height} vs ${(png.metadata_declared_dimensions ?? []).filter((d) => d.source.startsWith('XMP')).map((d) => `${d.width}x${d.height}`).join(', ') || 'none'}` : 'n/a', 'Southwest-Airlines-new-RECARO-seats-Video-still-Southwest.png#IHDR / XMP'),
      ...imgField(carpet, 'EXIF.IFD0', /^(Make|Model|DateTime)$/).map((t) => imgClaim('carpet.jpg', t)),
      measured('carpet.jpg GPS data present in EXIF', carpet?.gps_data_present ?? null, 'carpet.jpg#EXIF.GPS'),
      measured('images with no descriptive text metadata at all (ICC profile text excluded)', `${imagesNoText.length} of ${imageNames.length}`, 'evidence/inventory.json'),
      measured('images whose metadata mentions a layout id, LOPA, row or seat', imagesWithLayoutRef.length, 'evidence/inventory.json'),
    ],
    claim_scope: 'All supplied images as possible MaterialProfile / visual references.',
    why: `The forward-galley photograph's embedded keywords name another airline, its capture date is ${galley?.exif?.exif?.DateTimeOriginal ?? 'not stated'}, and it carries a photographer credit and copyright; one image declares itself a screenshot whose stated source size differs from the file; ${imagesNoText.length} of ${imageNames.length} images carry no descriptive metadata. File names are the only hint of subject, and no image is tied to a layout, tail, row, seat or material specification.`,
    impact: 'Using an image as the expected appearance for a Southwest layout would be unsupported; licence terms are unknown.',
    decision: 'Images are stored as unverified reference media with their extracted metadata. None is bound to a Layout, tail or MaterialProfile. The forward-galley image is flagged "metadata names another airline" and is not offered as a Southwest visual reference unless a user links it explicitly with a recorded reason. Credit/copyright metadata is preserved and shown; use is limited to the local demo. Unresolved.',
    evidence_needed: 'A catalogued, licensed image set with layout/tail/date for each image.',
    expected_finding: 'One forward-galley photo is expected to carry another airline\'s name in its metadata.',
    checks: [
      check('forward-galley photo metadata contains an airline name other than Southwest', galleyHits.some((h) => /Airlines/.test(h.name) && !/Southwest/.test(h.name))),
      check('forward-galley photo metadata does not mention Southwest', !(galley?.text_metadata_strings ?? []).some((t) => /Southwest/i.test(t.value))),
    ],
  });

  const finalRow = docxLayoutRows.find((r) => /final/.test(r.cells[0].text));
  add({
    title: 'Crosswalk assumption: DOCX categories ↔ registry records',
    type: TYPE.ASM,
    claims: [
      docx(finalRow?.cells[2].text ?? 'Single cabin, 3-3 seating; three seats on both sides of the exit row and two seats on both sides of the last row'),
      ...elevate.slice(0, 1).flatMap((id) => [row(id, 15, 'active_seat_count'), row(id, 30, 'active_seat_count'), row(id, 30, 'omitted_seat_letters')]),
      docx('Single cabin, 3-3 seating; reduced seating at part of the exit-row and rear-row areas'),
      ...heart.slice(0, 1).flatMap((id) => [row(id, 15, 'active_seat_count'), row(id, 30, 'active_seat_count')]),
      docx('737-700, 137-seat LOPA', { exact: true }),
      cfg('73G', 'total_seats'), cfg('73G', 'interior_generation'),
      docx('New deliveries use the RECARO interior; selected -800s and -700s are also being converted as part of the standardization program.'),
    ],
    claim_scope: 'The link between DOCX categories (137-seat, 138-seat, temporary, final) and registry lopa_ids.',
    why: `No source states the mapping. The working assumption is: "final" ≈ ${elevate.join(' + ')} (exit row and last-row seat counts match the DOCX sentence), "temporary" ≈ ${heart.join(' + ')} (exit row matches, rear row does not — C08), "137-seat" ≈ 73G (capacity matches; exit-area description and upgrade status do not obviously match — C11, C14), "138-seat" ≈ no record (C01).`,
    impact: 'Every DOCX claim attached to a registry record through this mapping inherits the assumption.',
    decision: 'The mapping is stored as an explicit crosswalk table with status "assumed, unverified" and the reasons for and against each row. DOCX claims are stored against the DOCX category first and only shown on a registry record through the crosswalk, labelled as such. It can be changed without touching either source\'s claims.',
    evidence_needed: 'An authoritative statement of which model/interior records make up each layout category.',
    expected_finding: null,
    checks: [check('registry Elevate rows 15 and 30 have six and four seats', elevate.every((id) => s.locate.row(id, 15, 'active_seat_count').value === 6 && s.locate.row(id, 30, 'active_seat_count').value === 4))],
  });

  add({
    title: 'A planned aircraft type is mentioned as not current',
    type: `${TYPE.ASM} (scope)`,
    claims: [
      docx('The 737 MAX 7 is not yet a current revenue configuration.'),
      docx('150-passenger'),
      docx('dates subject to change'),
      measured('occurrences of "MAX 7" / "MAX-7" in registry JSON text and RTF text', `${countIn(registryText, /MAX[ -]7\b/g)} / ${countIn(rtfAll, /MAX[ -]7\b/g)}`, 'whole-file text search'),
    ],
    claim_scope: 'Scope of layouts the application offers.',
    why: 'The DOCX itself places this type outside the current configurations and gives only a planned capacity; no registry record or seat data exists.',
    impact: 'None if kept out of scope; a made-up layout would be invention.',
    decision: 'No Layout is created. The paragraph is retained as an out-of-scope source note.',
    evidence_needed: 'A released layout, if and when the type enters service.',
    expected_finding: null,
    checks: [check('the registry does not mention the type', countIn(registryText, /MAX[ -]7\b/g) === 0)],
  });

  // ---- finalise -------------------------------------------------------------------
  const final = entries.map((e, i) => {
    const id = `C${String(i + 1).padStart(2, '0')}`;
    const quotesOk = e.claims.every((c) => c.found);
    const checksOk = e.checks.every((c) => c.pass);
    if (/\bwins\b|takes precedence|is authoritative/i.test(e.decision)) problems.push(`${id}: decision uses precedence wording`);
    return {
      id,
      title: e.title,
      type: e.type,
      claims: e.claims,
      claim_scope: e.claim_scope,
      why_conflict_or_ambiguity: e.why,
      impact_on_application: e.impact,
      decision_for_software: e.decision,
      decision_is_non_destructive: true,
      evidence_still_needed: e.evidence_needed,
      verification: {
        all_quotes_located_verbatim: quotesOk,
        checks: e.checks,
        all_checks_pass: checksOk,
      },
      brief_expected_finding: e.expected_finding
        ? { expectation: e.expected_finding, status: quotesOk && checksOk ? 'CONFIRMED' : 'DIFFERS' }
        : null,
      ...(e.extra ? { extra: e.extra } : {}),
    };
  });
  // fix cross-references written with their final ids
  if (problems.length) ctx.failed = `conflict register: ${problems.join(' | ')}`;

  const out = {
    purpose: 'Register of conflicts, ambiguities, representation differences, gaps and assumptions found in the supplied evidence.',
    rules: [
      'No source precedence: no entry is decided by "JSON wins", "RTF wins" or "newest wins".',
      'Every decision is a non-destructive handling: both/all raw claims are kept and marked unresolved unless the entry is a pure representation rule.',
      'Quotes are verbatim substrings located in the originals at build time; counts are measured.',
    ],
    summary: {
      entries: final.length,
      by_type: final.reduce((m, e) => { m[e.type] = (m[e.type] ?? 0) + 1; return m; }, {}),
      brief_expected_findings: final.filter((e) => e.brief_expected_finding).length,
      brief_expected_findings_confirmed: final.filter((e) => e.brief_expected_finding?.status === 'CONFIRMED').length,
      entries_with_unlocated_quotes: final.filter((e) => !e.verification.all_quotes_located_verbatim).map((e) => e.id),
      entries_with_failed_checks: final.filter((e) => !e.verification.all_checks_pass).map((e) => e.id),
      build_problems: problems,
    },
    entries: final,
  };
  ctx.written.push(writeJson('conflict-register.json', out));

  const md = [];
  const shortLoc = (l) => l
    .replace(`${F.REGISTRY_JSON}#`, 'registry.json#')
    .replace(`${F.CONFIG_CSV}:`, 'configurations.csv:')
    .replace(`${F.SEATS_CSV}:`, 'seats.csv:')
    .replace(`${F.ROWS_XLSX}#`, 'rows.xlsx#')
    .replace(`${F.RTF}#`, 'RTF#')
    .replace(`${F.DOCX}#`, 'DOCX#');
  const shortQuote = (q) => (q.length > 230 ? q.slice(0, 230) + '…' : q);
  md.push('# Conflict, ambiguity and assumption register');
  md.push('');
  md.push(`> ${DISCLAIMER}`);
  md.push('');
  md.push(`${final.length} entries. Rules: ${out.rules.join(' ')}`);
  md.push('');
  md.push(`Locator shorthand: \`registry.json\` = \`${F.REGISTRY_JSON}\`; \`configurations.csv\`, \`seats.csv\`, \`rows.xlsx\` = the registry exports; \`RTF\` = \`${F.RTF}\`; \`DOCX\` = \`${F.DOCX}\`. \`P###\` / \`T##.R##.C##\` are the paragraph / table-cell locators of \`extracts/rtf-located.txt\` and \`extracts/docx-located.txt\`.`);
  md.push('');
  md.push(mdTable(['Id', 'Title', 'Type', 'Quotes located', 'Checks', 'Brief expectation'],
    final.map((e) => [e.id, e.title, e.type, e.verification.all_quotes_located_verbatim ? 'yes' : 'NO', `${e.verification.checks.filter((c) => c.pass).length}/${e.verification.checks.length}`, e.brief_expected_finding ? e.brief_expected_finding.status : '— (additional finding)'])));
  for (const e of final) {
    md.push('');
    md.push(`## ${e.id} — ${e.title}`);
    md.push('');
    md.push(`**Type:** ${e.type}  `);
    md.push(`**Scope:** ${e.claim_scope}`);
    md.push('');
    const MAX_ROWS = 14;
    const srcLabel = (c) => {
      if (c.measured) return 'measured';
      if (c.source_file === F.DOCX) return 'DOCX';
      if (c.source_file === F.RTF) return 'RTF';
      if (c.source_file.startsWith(F.REGISTRY_JSON)) return c.source_file.endsWith(F.CONFIG_CSV) ? 'registry JSON + configurations CSV' : c.source_file.endsWith(F.SEATS_CSV) ? 'registry JSON + seats CSV' : 'registry JSON + rows XLSX';
      return c.source_file;
    };
    md.push(mdTable(['Source', 'Locator', 'Claim (verbatim quote or measured value)'],
      e.claims.slice(0, MAX_ROWS).map((c) => [
        srcLabel(c),
        c.locators.slice(0, 4).map(shortLoc).join('; ') + (c.locators.length > 4 ? ` (+${c.locators.length - 4})` : ''),
        (c.subject && (c.measured || c.json_value !== undefined) ? `${c.subject}: ` : '') + code(shortQuote(c.quote)) + (c.note ? ` — ${c.note}` : ''),
      ])));
    if (e.claims.length > MAX_ROWS) {
      md.push('');
      md.push(`(+${e.claims.length - MAX_ROWS} further located claims for this entry in \`conflict-register.json\`.)`);
    }
    md.push('');
    md.push(`- **Why:** ${e.why_conflict_or_ambiguity}`);
    md.push(`- **Impact:** ${e.impact_on_application}`);
    md.push(`- **Decision (non-destructive):** ${e.decision_for_software}`);
    md.push(`- **Evidence still needed:** ${e.evidence_still_needed}`);
    md.push(`- **Checks:** ${e.verification.checks.map((c) => `${c.pass ? '✔' : '✘'} ${c.description}`).join('; ')}`);
    if (e.brief_expected_finding) md.push(`- **Brief expectation:** ${e.brief_expected_finding.status} — ${e.brief_expected_finding.expectation}`);
  }
  md.push('');
  md.push('Full detail (all locators, raw values): `conflict-register.json`.');
  ctx.written.push(writeText('conflict-register.md', md.join('\n')));
  return out;
}
