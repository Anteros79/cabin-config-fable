// Field crosswalk: every field of the operational sources and the narrative domains of the
// RTF/DOCX mapped onto the logical model. Mapping decisions are authored here; examples, types,
// blank counts and locators are measured from the originals at build time.
import { F, writeJson, writeText, mdTable, code, DISCLAIMER } from './lib/common.mjs';
import { profileColumns } from './lib/csv.mjs';
import { loadSources } from './lib/sources.mjs';

const VERBATIM = 'raw claim — preserve verbatim';

// [field, logical targets, unit, preserve verbatim?, notes]
const CONFIG_MAP = [
  ['lopa_id', ['Layout.source_layout_code', 'LayoutRevision.source_layout_code'], null, true, 'Identifier string, never a number (some values are all digits). {configCount} model/interior IDs; grain differs from the DOCX layout categories (see conflict register).'],
  ['boeing_model', ['AircraftSubtype.model_name'], null, true, 'Free-text model name.'],
  ['icao_code', ['AircraftSubtype.icao_type_designator'], null, true, 'Code string.'],
  ['iata_code', ['AircraftSubtype.iata_type_code'], null, true, 'Code string; contains an all-digit value that must stay a string.'],
  ['configuration_name', ['Layout.name_claim'], null, true, 'Label as written, including embedded quotes.'],
  ['interior_generation', ['LayoutRevision.interior_generation_label', 'MaintenanceVariant.label_candidate'], null, true, 'Generation label; not a revision identifier or approval.'],
  ['seat_hardware_model', ['SeatHardware.model_label_claim', 'MaintenanceVariant.label_candidate'], null, true, 'Hardware label only: no part numbers, no vendor documents. Naming differs from the DOCX.'],
  ['est_active_aircraft', ['Layout.estimated_fleet_count_claim'], 'aircraft (approximate)', true, 'Qualified estimate or free text. Not a tail list; does NOT populate Aircraft(tail) or TailAssignment.'],
  ['total_seats', ['LayoutRevision.declared_total_seats'], 'seats', false, 'Declared total; checked against counted SeatLocation records.'],
  ['extra_legroom_seats', ['LayoutRevision.declared_tier_count[Extra Legroom]'], 'seats', false, 'Declared commercial-tier count; checked against SeatCommercialAttributes.'],
  ['preferred_seats', ['LayoutRevision.declared_tier_count[Preferred]'], 'seats', false, 'Declared commercial-tier count.'],
  ['standard_seats', ['LayoutRevision.declared_tier_count[Standard]'], 'seats', false, 'Declared commercial-tier count.'],
  ['numbered_row_range', ['RowLabel.declared_label_range_claim'], 'printed row labels', true, 'Describes printed labels, not physical row count.'],
  ['elr_pitch_inches', ['SeatPhysicalAttributes.pitch_claim (layout-level, Extra Legroom)'], 'inches', true, 'Single value, range, or range with parenthetical "~" qualifier. Keep raw; optional parsed min/max/qualifier stored beside it.'],
  ['standard_pitch_inches', ['SeatPhysicalAttributes.pitch_claim (layout-level, Standard/Preferred)'], 'inches', true, 'Range string.'],
  ['max_seat_width_inches', ['SeatPhysicalAttributes.width_claim (layout-level, measurement_kind = "max seat width", kind not defined by source)'], 'inches', true, 'Number in JSON, decimal text in CSV. What is measured (cushion, between armrests, shoulder) is not stated.'],
  ['in_seat_power', ['SeatPhysicalAttributes.power_claim (layout-level)'], null, true, 'Alternatives separated by "/" depend on the airframe; not resolvable without tail data.'],
  ['wifi_system', ['(no logical-model target) LayoutRevision.raw_source_attributes'], null, true, 'Outside the cabin-appearance model. One value embeds a tail-like token; kept as raw text only.'],
  ['lavatory_count_fwd', ['FloorArea (count only) → LayoutRevision.raw_source_attributes'], 'lavatories', false, 'A count, not a floor map: no position, footprint or module id.'],
  ['lavatory_count_aft', ['FloorArea (count only) → LayoutRevision.raw_source_attributes'], 'lavatories', false, 'A count, not a floor map.'],
  ['notes', ['LayoutRevision.source_notes'], null, true, 'Free text.'],
];

const ROW_MAP = [
  ['lopa_id', ['RowLabel.layout_revision_ref'], null, true, 'Foreign key to the configuration. Stored as a NUMBER in {numericIdCells} workbook cells; must be handled as an identifier string.'],
  ['row_number', ['RowLabel.printed_label'], 'printed row label', true, 'A printed label, not a physical index. RowLabel.physical_order is DERIVED (ascending label over existing rows) and flagged as an assumption.'],
  ['row_exists', ['RowLabel.exists'], null, false, 'false = label skipped in the cabin (no physical row).'],
  ['active_seat_count', ['(derived check) count of SeatLocation per RowLabel'], 'seats', false, 'Redundant with the seat records; used as a consistency check only.'],
  ['omitted_seat_letters', ['(derived check) absent SeatLocation letters per RowLabel'], null, true, 'Comma-separated letters; blank when none.'],
  ['is_exit_row', ['RowLabel.exit_row_claim → SeatPhysicalAttributes.exit (row-level claim)'], null, false, 'Row-level flag; semantics differ between configurations (see conflict register).'],
  ['is_bulkhead_row', ['RowLabel.bulkhead_row_claim → SeatPhysicalAttributes.bulkhead (row-level claim)'], null, false, 'Row-level flag cannot express a bulkhead on one side only; seat-level flags are kept separately.'],
  ['recline_status', ['SeatPhysicalAttributes.recline (row-level claim)'], null, true, 'Compound enumeration values such as "None/Limited" are raw claims.'],
  ['recline_restriction_reason', ['SeatPhysicalAttributes.recline_reason_claim'], null, true, 'Free text, includes unverified regulatory attributions.'],
  ['row_notes', ['RowLabel.source_notes'], null, true, 'Free text, carries pitch and seat statements with inch marks.'],
];

const SEAT_MAP = [
  ['lopa_id', ['SeatLocation.layout_revision_ref'], null, true, 'Part of seat identity.'],
  ['row_number', ['SeatLocation.printed_row_label'], 'printed row label', true, 'Part of seat identity; printed label, not physical order.'],
  ['seat_letter', ['SeatLocation.letter', 'SeatLocation.side (DERIVED: A/B/C vs D/E/F)', 'SeatLocation.block (DERIVED)'], null, true, 'Part of seat identity. Side/block are not supplied as fields; derived from the letter and flagged as derived.'],
  ['seat_code', ['SeatLocation.display_code (derived check: printed label + letter)'], null, true, 'Redundant with row_number + seat_letter.'],
  ['seat_position_type', ['SeatLocation.position (Window/Middle/Aisle)'], null, false, 'Enumeration.'],
  ['commercial_tier', ['SeatCommercialAttributes.tier'], null, false, 'Commercial product tier only. Must not be used as a proxy for physical spacing.'],
  ['pitch_range_inches', ['SeatPhysicalAttributes.pitch_claim (raw + optional min/max/qualifier)'], 'inches', true, 'Holds ranges and single values; approximate source statements appear here without their "~".'],
  ['effective_width_inches', ['SeatPhysicalAttributes.width_claim (measurement_kind = "effective width", kind not defined by source)'], 'inches', true, 'Mixes seat width with a shoulder-clearance reduction on some seats (see conflict register).'],
  ['recline_status', ['SeatPhysicalAttributes.recline'], null, true, 'Compound enumeration values are raw claims.'],
  ['window_status', ['SeatPhysicalAttributes.window_status'], null, true, 'Compound enumeration values are raw claims; "N/A" for non-window seats.'],
  ['window_notes', ['SeatPhysicalAttributes.window_notes'], null, true, 'Free text.'],
  ['is_exit_seat', ['SeatPhysicalAttributes.exit'], null, false, 'Seat-level flag.'],
  ['is_bulkhead_seat', ['SeatPhysicalAttributes.bulkhead'], null, false, 'Seat-level flag; authoritative granularity for one-sided bulkheads.'],
  ['has_unobstructed_legroom', ['SeatPhysicalAttributes.legroom_unobstructed'], null, false, 'Seat-level flag.'],
  ['tray_table_location', ['SeatPhysicalAttributes.tray'], null, false, 'Enumeration.'],
  ['underseat_storage_allowed', ['SeatPhysicalAttributes.storage'], null, false, 'Seat-level flag.'],
  ['power_type', ['SeatPhysicalAttributes.power_claim'], null, true, 'Same string on every seat of a configuration; alternatives depend on the airframe.'],
  ['special_notes', ['SeatLocation.source_notes'], null, true, 'Free text.'],
];

// Narrative domains: [document, id, domain, anchor quote to locate, logical targets, preserve, notes]
const NARRATIVE = [
  ['rtf', 'N-RTF-01', 'Configuration summary table (variant, interior generation, totals, tier counts with row ranges, omitted positions)', 'LOPA / Variant', ['Layout', 'LayoutRevision.declared_total_seats', 'LayoutRevision.declared_tier_count', 'RowLabel'], true, 'Tier cells mix a count with a row/seat range in one string.'],
  ['rtf', 'N-RTF-02', 'Row numbering rule (labels aligned so overwing exits fall in a fixed label band; skipped labels)', 'row numbering is standardized', ['RowLabel.printed_label', 'RowLabel.physical_order (derived)'], true, 'Basis for separating printed label from physical order.'],
  ['rtf', 'N-RTF-03', 'Row-by-row tier map with pitch statements', 'Row-by-Row Tier Map', ['SeatCommercialAttributes.tier', 'SeatPhysicalAttributes.pitch_claim'], true, 'Pitch written with inch marks, ranges and "~".'],
  ['rtf', 'N-RTF-04', 'Bulkhead, tray-table and floor-stowage statements', 'armrest-stowed tray tables', ['SeatPhysicalAttributes.bulkhead', 'SeatPhysicalAttributes.tray', 'SeatPhysicalAttributes.storage'], true, 'Side-specific wording (port/starboard).'],
  ['rtf', 'N-RTF-05', 'Window restrictions (missing, limited, misaligned, set-back)', 'Missing / Obstructed Windows:', ['SeatPhysicalAttributes.window_status', 'SeatPhysicalAttributes.window_notes'], true, 'Includes a shoulder-width statement for a windowless seat.'],
  ['rtf', 'N-RTF-06', 'Recline restrictions with stated reasons', 'Non-Reclining / Limited-Recline Rows:', ['SeatPhysicalAttributes.recline', 'SeatPhysicalAttributes.recline_reason_claim'], true, 'Regulatory attributions are unverified claims.'],
  ['rtf', 'N-RTF-07', 'Structural deltas between two interior generations (exit-row seats, pitch, last row)', 'Structural Deltas vs. the "Heart" Layout', ['LayoutRevision (difference between revisions)', 'SeatLocation', 'SeatPhysicalAttributes.pitch_claim'], true, 'Approximate pitch values.'],
  ['rtf', 'N-RTF-08', 'Unobstructed-legroom statements (no seat directly ahead)', 'unobstructed legroom', ['SeatPhysicalAttributes.legroom_unobstructed'], true, ''],
  ['docx', 'N-DOCX-01', '"As of" date and count of active layouts', 'four active seating layouts', ['SourceArtifact.as_of_claim', 'Layout (category grain)'], true, 'A date written in the text; not a validation release.'],
  ['docx', 'N-DOCX-02', 'Layout category table (capacity, arrangement, Extra Legroom pitch, Standard/Preferred pitch, seat width)', 'Aircraft / active layout', ['Layout (category grain)', 'LayoutRevision.declared_total_seats', 'SeatPhysicalAttributes.pitch_claim', 'SeatPhysicalAttributes.width_claim (range, kind = "seat width")'], true, 'Category grain differs from the registry lopa_id grain; arrangement text names no seats.'],
  ['docx', 'N-DOCX-03', 'Measurement definition for pitch and "published ranges" attribution', 'Pitch is the distance from a point on one seat', ['SeatPhysicalAttributes.pitch_claim (definition)', 'SourceArtifact (cited source, unverified)'], true, 'Defines pitch; does not define width.'],
  ['docx', 'N-DOCX-04', 'Fleet standardisation narrative (upgrade programme, seat products, power, fleet numbers)', '170 selected -700s are upgraded', ['MaintenanceVariant.label_candidate', 'SeatHardware.model_label_claim', 'SeatPhysicalAttributes.power_claim', 'Layout.estimated_fleet_count_claim'], true, 'No tail numbers; cannot populate TailAssignment.'],
  ['docx', 'N-DOCX-05', 'Temporary vs final layout difference for the larger aircraft', 'temporary and final LOPAs both retain 175 total seats', ['LayoutRevision (difference between revisions)', 'SeatLocation (unspecified seats)'], true, 'Seats are described by area, not by seat code.'],
  ['docx', 'N-DOCX-06', 'Customer-facing seat tier table (location, physical dimensions, included experience)', 'Seat tier', ['SeatCommercialAttributes.tier (definition)', 'SeatPhysicalAttributes.pitch_claim'], true, 'Service inclusions have no logical-model target.'],
  ['docx', 'N-DOCX-07', 'Seats with Extra Legroom spacing but sold as Preferred (commercial vs physical mismatch) on one layout', 'physically have Extra Legroom spacing but are sold as Preferred', ['SeatCommercialAttributes.tier', 'SeatPhysicalAttributes.pitch_claim'], true, 'Applies only to the layout the DOCX names; that layout has no seat set in the registry.'],
  ['docx', 'N-DOCX-08', 'Fare and loyalty access rules', 'Premium access by fare and loyalty tier', ['(no logical-model target)'], true, 'Commercial policy; outside cabin-appearance scope. Kept as source text only.'],
  ['docx', 'N-DOCX-09', 'Aircraft type stated as not currently included (planned layout)', 'is not yet a current revenue configuration', ['(no logical-model target; out of scope)'], true, 'Planned, date subject to change; no registry record.'],
  ['docx', 'N-DOCX-10', 'Hyperlink citations (public help pages and private intranet/mail items)', '[support.so...thwest.com]', ['SourceArtifact.cited_reference (unverified)'], true, 'Private targets were not accessed; public targets only checked for reachability.'],
];

// Logical model coverage. status: supplied (candidate) | partial | derived | not supplied
const MODEL = [
  ['SourceArtifact', 'supplied (measured here)', 'File identity, format, size, SHA-256, internal metadata — produced by this evidence stage (inventory.json).', 'Provenance beyond the bytes (who issued, whether approved) is not supplied.'],
  ['ValidationRelease', 'not supplied', 'No approval, sign-off, effectivity or release record in any source.', 'schema_version and generated_at_utc are generation metadata; the DOCX "As of" date and document titles are text. None is a validation release.'],
  ['AircraftSubtype', 'supplied (candidate)', 'boeing_model, icao_code, iata_code (configurations).', '{distinctModels} distinct model names across {configCount} configuration records.'],
  ['Aircraft(tail)', 'not supplied', 'No tail list.', 'Only tail-like tokens inside free text (see absence checks); they are not aircraft records.'],
  ['Layout', 'partial', 'lopa_id, configuration_name (registry: {configCount} IDs); DOCX layout category table ({docxLayoutRows} data rows).', 'Grain conflict between sources; see conflict register.'],
  ['LayoutRevision', 'partial', 'interior_generation, declared totals, notes.', 'No revision identifier, date, drawing or approval reference.'],
  ['RowLabel', 'supplied (candidate)', 'row_number (printed label), row_exists.', 'physical_order is derived by assumption; no station or coordinate.'],
  ['SeatLocation', 'supplied (candidate)', 'lopa_id + row_number + seat_letter; seat_position_type.', 'side and block are derived from the letter, not supplied.'],
  ['SeatCommercialAttributes', 'supplied (candidate)', 'commercial_tier.', 'Kept separate from physical attributes.'],
  ['SeatPhysicalAttributes', 'supplied (candidate raw claims)', 'pitch_range_inches, effective_width_inches, is_exit_seat, is_bulkhead_seat, recline_status, window_status/notes, has_unobstructed_legroom, tray_table_location, underseat_storage_allowed, power_type.', 'Pitch and width are unverified claims with undefined measurement kind for width.'],
  ['MaintenanceVariant', 'partial', 'interior_generation / seat_hardware_model labels; DOCX seat product names.', 'Labels only; naming differs between sources; no variant definition.'],
  ['SeatHardware', 'partial', 'seat_hardware_model label.', 'No part numbers, drawings, vendor data or per-seat hardware assignment.'],
  ['MaterialProfile', 'not supplied', 'No carpet, seam, upholstery or visual-profile data in any text or table.', 'Reference images exist but carry no mapping to a layout, tail or material specification.'],
  ['TailAssignment', 'not supplied', 'No dated tail-to-layout assignment.', 'Estimated fleet counts are not assignments.'],
  ['FloorArea', 'not supplied', 'Only lavatory counts and narrative mentions of galleys/lavatories.', 'No floor map, footprint, position or area identifiers.'],
  ['BinModule', 'not supplied', 'No overhead-bin data.', ''],
  ['Component', 'not supplied', 'No component catalogue.', ''],
  ['Part', 'not supplied', 'No part numbers or part catalogue.', ''],
  ['ApplicabilityRule', 'not supplied', 'No applicability or effectivity rules.', 'Free-text hints such as "select retrofits" are not rules.'],
  ['SubstituteApproval', 'not supplied', 'No substitute or alternate approvals.', ''],
  ['KitChild', 'not supplied', 'No kit structure.', ''],
  ['Visit', 'not supplied', 'Application runtime entity; no source counterpart.', ''],
  ['Snapshot', 'not supplied', 'Application runtime entity; no source counterpart.', ''],
  ['ReplacementRecord', 'not supplied', 'Application runtime entity; no source counterpart.', ''],
  ['Report', 'not supplied', 'Application runtime entity; no source counterpart.', ''],
  ['AuditEvent', 'not supplied', 'Application runtime entity; no source counterpart.', ''],
  ['Coordinate frame / seat coordinates', 'not supplied', 'No coordinates, stations or datum.', ''],
  ['Cabin height / cross-section dimensions', 'not supplied', 'No cabin height or cross-section data.', ''],
  ['Image-to-layout mapping', 'not supplied', 'Images carry no layout, tail, row or seat reference in their metadata.', ''],
];

const ABSENCE_PATTERNS = [
  ['tail registration token (N-number)', /\bN\d{1,5}[A-Z]{0,2}\b/],
  ['part number / manual reference', /\b(part\s*(number|no\.?)|P\/N|IPC|CMM|AMM|SRM)\b/i],
  ['carpet', /carpet/i],
  ['seam', /\bseams?\b/i],
  ['upholstery / leather / fabric / dress cover', /upholster|leather|fabric|dress cover/i],
  ['colour', /\bcolou?rs?\b/i],
  ['overhead bin', /\bbins?\b/i],
  ['floor', /\bfloor\b/i],
  ['coordinate / station / datum', /coordinate|\bstation\b|\bSTA\b|\bdatum\b/i],
  ['height / ceiling', /\bheight\b|\bceiling\b/i],
  ['applicability / effectivity', /applicab|effectivit/i],
  ['substitute / alternate / interchangeable', /substitut|\balternate\b|interchangeab/i],
  ['approval / approved / authorised', /\bapprov|\bauthori[sz]/i],
  ['metric length unit', /\b\d+(\.\d+)?\s?(mm|cm)\b/i],
];

function jsonTypeOf(v) {
  if (v === null) return 'null';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

export function run(ctx) {
  const s = loadSources();
  const reg = s.registry;
  const measured = {
    configCount: reg.lopa_configurations.length,
    numericIdCells: s.workbook.conversions.numeric_cell_to_identifier_string.length,
    distinctModels: new Set(reg.lopa_configurations.map((c) => c.boeing_model)).size,
    docxLayoutRows: Math.max(0, (s.docx.tables[0]?.rows.length ?? 1) - 1),
  };
  const fill = (text) => String(text).replace(/\{(\w+)\}/g, (m, k) => (k in measured ? String(measured[k]) : m));
  const csvProfiles = {
    lopa_configurations: Object.fromEntries(profileColumns(s.configCsv.header, s.configCsv.rows).map((c) => [c.name, c])),
    lopa_seats: Object.fromEntries(profileColumns(s.seatsCsv.header, s.seatsCsv.rows).map((c) => [c.name, c])),
  };
  const firstRaw = {
    lopa_configurations: (f) => s.configCsv.rows.find((r) => r.values[f] !== '')?.values[f],
    lopa_seats: (f) => s.seatsCsv.rows.find((r) => r.values[f] !== '')?.values[f],
    lopa_rows: (f) => { const r = s.workbook.rows.find((x) => x.raw[f] !== null); return r ? r.raw[f].value : undefined; },
  };
  const xlsxTypes = (f) => {
    const m = {};
    for (const r of s.workbook.rows) { const k = r.raw[f] === null ? 'absent cell' : `${r.raw[f].value_type} cell`; m[k] = (m[k] ?? 0) + 1; }
    return m;
  };

  function fieldRows(entity, exportFile, map) {
    const recs = reg[entity];
    return map.map(([field, targets, unit, preserve, notes]) => {
      const vals = recs.map((r) => r[field]);
      const types = {};
      for (const v of vals) { const t = jsonTypeOf(v); types[t] = (types[t] ?? 0) + 1; }
      const firstIdx = vals.findIndex((v) => v !== '' && v !== null && v !== undefined);
      const distinct = new Set(vals.map((v) => JSON.stringify(v)));
      const exportRepr = entity === 'lopa_rows' ? xlsxTypes(field) : csvProfiles[entity][field]?.lexical_class_counts ?? null;
      const blankJson = vals.filter((v) => v === '').length;
      const nullJson = vals.filter((v) => v === null).length;
      return {
        entity,
        field,
        present_in_registry_json: vals.some((v) => v !== undefined),
        sources: [`${F.REGISTRY_JSON}#/${entity}/*/${field}`, `${exportFile} (column ${field})`],
        json_value_types: types,
        export_representation: exportRepr,
        logical_type: (() => {
          const t = Object.keys(types).filter((k) => k !== 'null');
          if (t.includes('number') && t.includes('integer')) return 'number (decimal)';
          return t.join(' | ') || 'null';
        })(),
        unit,
        null_convention: {
          json_empty_string_count: blankJson,
          json_null_count: nullJson,
          export_blank_count: entity === 'lopa_rows' ? (exportRepr['absent cell'] ?? 0) : (csvProfiles[entity][field]?.blank_count ?? null),
          description: blankJson + nullJson === 0
            ? 'always populated in the supplied records'
            : `blank = "" in JSON (${blankJson}), ${entity === 'lopa_rows' ? 'absent cell in XLSX' : 'empty field in CSV'}; JSON null never used`,
        },
        distinct_value_count: distinct.size,
        example_raw_value: { json: firstIdx >= 0 ? vals[firstIdx] : '', export: firstRaw[entity](field) ?? '', locator: firstIdx >= 0 ? s.loc.json(entity, firstIdx, field) : null },
        raw_claim_preserve_verbatim: preserve,
        handling: preserve ? VERBATIM : 'typed value; source text also retained',
        maps_to: targets,
        notes: fill(notes),
      };
    });
  }

  const operational = [
    ...fieldRows('lopa_configurations', F.CONFIG_CSV, CONFIG_MAP),
    ...fieldRows('lopa_rows', F.ROWS_XLSX, ROW_MAP),
    ...fieldRows('lopa_seats', F.SEATS_CSV, SEAT_MAP),
  ];

  // completeness: every source field must be mapped, and every mapped field must exist
  const unmapped = [];
  for (const [entity, map] of [['lopa_configurations', CONFIG_MAP], ['lopa_rows', ROW_MAP], ['lopa_seats', SEAT_MAP]]) {
    const mapped = new Set(map.map((m) => m[0]));
    const actual = new Set(reg[entity].flatMap((r) => Object.keys(r)));
    for (const f of actual) if (!mapped.has(f)) unmapped.push({ entity, field: f, problem: 'source field has no crosswalk entry' });
    for (const f of mapped) if (!actual.has(f)) unmapped.push({ entity, field: f, problem: 'crosswalk entry has no source field' });
  }
  if (unmapped.length) ctx.failed = `field crosswalk incomplete: ${JSON.stringify(unmapped)}`;

  // descriptive architecture CSV columns
  const schemaFields = s.schemaCsv.header.map((h) => ({
    entity: 'schema architecture summary',
    field: h,
    sources: [`${F.SCHEMA_CSV} (column ${h})`],
    example_raw_value: s.schemaCsv.rows[0]?.values[h] ?? '',
    raw_claim_preserve_verbatim: true,
    maps_to: ['SourceArtifact (descriptive metadata about the registry); not operational data'],
    notes: 'Describes entities, keys and row counts in prose; contains no operational records.',
  }));

  const units = { rtf: s.rtfUnits, docx: s.docxUnits };
  const fileOf = { rtf: F.RTF, docx: F.DOCX };
  const narrative = NARRATIVE.map(([doc, id, domain, anchor, targets, preserve, notes]) => {
    const hits = units[doc].filter((u) => u.text.includes(anchor));
    if (hits.length === 0) ctx.failed = `narrative anchor not found in ${doc}: ${anchor}`;
    return {
      id,
      source: fileOf[doc],
      domain,
      anchor_quote: anchor,
      locators: hits.map((h) => `${fileOf[doc]}#${h.locator}`),
      example_raw_value: hits[0] ? hits[0].text : null,
      raw_claim_preserve_verbatim: preserve,
      maps_to: targets,
      notes,
    };
  });

  // absence checks over all text-bearing sources
  const corpora = [
    { source: F.REGISTRY_JSON, units: ['lopa_configurations', 'lopa_rows', 'lopa_seats'].flatMap((e) => reg[e].flatMap((rec, i) => Object.entries(rec).filter(([, v]) => typeof v === 'string').map(([k, v]) => ({ locator: `#/${e}/${i}/${k}`, text: v })))) },
    { source: F.SCHEMA_CSV, units: s.schemaCsv.rows.flatMap((r) => Object.entries(r.values).map(([k, v]) => ({ locator: `:L${r.line}:${k}`, text: v }))) },
    { source: F.RTF, units: s.rtfUnits.map((u) => ({ locator: `#${u.locator}`, text: u.text })) },
    { source: F.DOCX, units: s.docxUnits.map((u) => ({ locator: `#${u.locator}`, text: u.text })) },
  ];
  const absenceChecks = ABSENCE_PATTERNS.map(([label, re]) => {
    const perSource = corpora.map((c) => {
      const hits = c.units.filter((u) => re.test(u.text));
      const distinctTexts = [...new Set(hits.map((h) => h.text))];
      return {
        source: c.source,
        matching_text_units: hits.length,
        distinct_matching_texts: distinctTexts.length,
        examples: distinctTexts.slice(0, 3).map((t) => ({ locator: c.source + hits.find((h) => h.text === t).locator, text: t.length > 220 ? t.slice(0, 220) + '…' : t, matched: (re.exec(t) ?? [''])[0] })),
      };
    });
    return { topic: label, pattern: String(re), total_matching_text_units: perSource.reduce((n, p) => n + p.matching_text_units, 0), per_source: perSource };
  });

  const model = MODEL.map(([entity, status, supplied_by, notes]) => ({ logical_entity: entity, status, supplied_by: fill(supplied_by), notes: fill(notes) }));
  const out = {
    purpose: 'Crosswalk from supplied fields and narrative domains to the logical model. A mapping is a proposal for where a claim is stored, not a statement that the claim is true.',
    conventions: {
      raw_claim: 'Values marked "preserve verbatim" are stored exactly as written (ranges, "~" qualifiers, inch marks, free text). Any parsed helper value is stored beside the raw string, never instead of it.',
      identifiers: 'lopa_id, iata_code and printed row labels are strings even when they look numeric.',
      separation: 'Commercial tier (SeatCommercialAttributes) and physical attributes (SeatPhysicalAttributes: pitch, width, exit, bulkhead, recline, window, legroom, tray, storage, power) are separate; none is inferred from another.',
    },
    summary: {
      operational_fields: operational.length,
      by_entity: { lopa_configurations: CONFIG_MAP.length, lopa_rows: ROW_MAP.length, lopa_seats: SEAT_MAP.length },
      preserve_verbatim_fields: operational.filter((o) => o.raw_claim_preserve_verbatim).length,
      narrative_domains: narrative.length,
      logical_entities: model.length,
      logical_entities_not_supplied: model.filter((m) => m.status === 'not supplied').length,
      crosswalk_completeness_problems: unmapped,
    },
    operational_fields: operational,
    schema_architecture_fields: schemaFields,
    narrative_domains: narrative,
    logical_model_coverage: model,
    absence_checks: {
      note: 'Keyword searches over every text value of the registry, the schema CSV, the RTF and the DOCX. A hit is a mention, not a supplied data set; zero hits supports "not supplied".',
      checks: absenceChecks,
    },
  };
  ctx.written.push(writeJson('field-crosswalk.json', out));

  const md = [];
  md.push('# Field crosswalk (supplied fields → logical model)');
  md.push('');
  md.push(`> ${DISCLAIMER}`);
  md.push('');
  md.push(`${out.summary.operational_fields} operational fields (${CONFIG_MAP.length} configuration, ${ROW_MAP.length} row, ${SEAT_MAP.length} seat), ${out.summary.narrative_domains} narrative domains, ${out.summary.logical_entities} logical-model items of which ${out.summary.logical_entities_not_supplied} are **not supplied**. A mapping says where a claim would be stored, not that it is true.`);
  md.push('');
  md.push(`- ${out.conventions.raw_claim}`);
  md.push(`- ${out.conventions.identifiers}`);
  md.push(`- ${out.conventions.separation}`);
  for (const [entity, title, exportFile] of [['lopa_configurations', 'Configurations', F.CONFIG_CSV], ['lopa_rows', 'Rows', F.ROWS_XLSX], ['lopa_seats', 'Seats', F.SEATS_CSV]]) {
    md.push('');
    md.push(`## ${title} — \`${F.REGISTRY_JSON}#/${entity}\` and \`${exportFile}\``);
    md.push('');
    md.push(mdTable(['Field', 'Type (JSON)', 'Unit', 'Blank / null', 'Example raw value', 'Verbatim', 'Maps to', 'Notes'],
      operational.filter((o) => o.entity === entity).map((o) => [
        code(o.field), o.logical_type, o.unit ?? '—',
        o.null_convention.json_empty_string_count + o.null_convention.json_null_count === 0 ? 'never blank' : `"" ×${o.null_convention.json_empty_string_count}`,
        code(typeof o.example_raw_value.json === 'string' ? o.example_raw_value.json : JSON.stringify(o.example_raw_value.json)),
        o.raw_claim_preserve_verbatim ? 'yes' : 'no', o.maps_to.join('; '), o.notes,
      ])));
  }
  md.push('');
  md.push(`## Descriptive summary — \`${F.SCHEMA_CSV}\``);
  md.push('');
  md.push(`Columns: ${schemaFields.map((f) => code(f.field)).join(', ')}. Maps to SourceArtifact descriptive metadata only; it contains no operational records.`);
  md.push('');
  md.push('## Narrative domains (RTF and DOCX)');
  md.push('');
  md.push(mdTable(['Id', 'Source', 'Domain', 'Locator(s)', 'Maps to', 'Notes'],
    narrative.map((n) => [n.id, n.source === F.RTF ? 'RTF' : 'DOCX', n.domain, n.locators.map((l) => l.split('#')[1]).join(', '), n.maps_to.join('; '), n.notes])));
  md.push('');
  md.push('## Logical model coverage');
  md.push('');
  md.push(mdTable(['Logical entity', 'Status', 'Supplied by', 'Notes'], model.map((m) => [m.logical_entity, m.status === 'not supplied' ? '**not supplied**' : m.status, m.supplied_by, m.notes])));
  md.push('');
  md.push('## Absence checks (keyword mentions across registry, schema CSV, RTF, DOCX)');
  md.push('');
  md.push(mdTable(['Topic', 'Registry JSON', 'Schema CSV', 'RTF', 'DOCX', 'Example hit'],
    absenceChecks.map((a) => {
      const ex = a.per_source.flatMap((p) => p.examples)[0];
      return [a.topic, ...a.per_source.map((p) => p.matching_text_units), ex ? `${ex.locator.replace(F.REGISTRY_JSON, 'registry').replace(F.RTF, 'RTF').replace(F.DOCX, 'DOCX').replace(F.SCHEMA_CSV, 'schema CSV')}: “${ex.matched}”` : '—'];
    })));
  md.push('');
  md.push('Counts are text units (field values, paragraphs, cells) that mention the topic. A mention is not a supplied data set.');
  md.push('');
  md.push('Full detail: `field-crosswalk.json`.');
  ctx.written.push(writeText('field-crosswalk.md', md.join('\n')));
  return out;
}
