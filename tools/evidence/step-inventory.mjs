// Inventory of all originals: identity, actual format, parse status, internal metadata,
// counts and a content-established role. Ends with a fresh re-hash of every original from disk.
import { extname } from 'node:path';
import {
  F, ORIGINALS, SOURCE_ROOT, readOriginal, sha256, sha256OfFileOnDisk, fileStatOnDisk, listSourceRootFiles,
  writeJson, writeText, mdTable, code, DISCLAIMER,
} from './lib/common.mjs';
import { detectFormat } from './lib/image-meta.mjs';
import { decodeText } from './lib/csv.mjs';
import { loadSources } from './lib/sources.mjs';

const EXT_EXPECT = {
  '.json': ['JSON'], '.csv': ['CSV'], '.rtf': ['RTF'], '.xlsx': ['XLSX'], '.docx': ['DOCX'],
  '.png': ['PNG'], '.jpg': ['JPEG'], '.jpeg': ['JPEG'], '.webp': ['WebP'], '.avif': ['AVIF'],
};

function fmtBytes(n) {
  return n.toLocaleString('en-US');
}

export function run(ctx) {
  const s = loadSources();
  const jc = ctx.results.jsonCompare;
  const csvMeta = ctx.results.csv;
  const wb = ctx.results.workbook;
  const rtf = ctx.results.rtf;
  const docx = ctx.results.docx;
  const xf = ctx.results.crossFormat;
  const images = ctx.results.images;
  const entries = [];

  const textMeta = (text) => Object.fromEntries([...text.matchAll(/"(schema_name|schema_version|normalization_form|generated_at_utc)"\s*:\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));

  for (const o of ORIGINALS) {
    const e = { relative_path: o.name, group: o.group, extension: extname(o.name).toLowerCase() };
    let buf;
    try {
      buf = readOriginal(o.name);
      e.read_status = 'ok';
    } catch (err) {
      e.read_status = 'failed';
      e.read_error = String(err.message ?? err);
      e.parse_status = 'not attempted';
      entries.push(e);
      continue;
    }
    e.size_bytes = buf.length;
    e.sha256 = sha256(buf);
    e.sha256_before_processing = ctx.hashesBefore[o.name];
    e.filesystem_modified_time = fileStatOnDisk(o.name).mtime_iso;
    e.filesystem_modified_time_note = 'file-system attribute, not stored inside the file';
    const det = detectFormat(buf);
    e.magic_bytes_hex = buf.subarray(0, 16).toString('hex');
    e.magic_detection = det.basis;

    try {
      if (o.group === 'image') {
        const im = images[o.name];
        e.actual_format = im.detected.format;
        e.actual_format_family = im.detected.format;
        e.mime_type = im.detected.mime;
        e.parse_status = im.parse_status === 'ok' && im.cross_check?.full_decode?.ok ? 'ok' : im.parse_status === 'ok' ? 'container parsed; full decode failed' : 'failed';
        e.parse_error = im.parse_error ?? (im.cross_check?.full_decode?.ok === false ? im.cross_check.full_decode.error : null);
        e.pixel_width = im.pixel_width;
        e.pixel_height = im.pixel_height;
        e.color = im.color;
        e.image_structure = im.structure;
        e.internal_metadata = {
          exif: im.exif,
          xmp: im.xmp,
          iptc: im.iptc,
          icc_profile: im.icc_profile,
          png_text_chunks: im.png_text_chunks ?? null,
          metadata_declared_dimensions: im.metadata_declared_dimensions,
          gps_data_present: im.gps_data_present,
          gps_values_withheld: im.gps_values_withheld ?? null,
        };
        e.embedded_text_metadata = im.text_metadata_strings;
        e.key_fields = im.key_fields;
        e.named_entity_hits_in_metadata = im.named_entity_hits_in_metadata;
        e.raw_byte_name_scan = im.raw_byte_name_scan;
        e.decoder_cross_check = im.cross_check;
        e.counts = { embedded_text_metadata_strings: im.text_metadata_strings.length, descriptive_strings_excluding_icc: im.text_metadata_strings.filter((t) => t.source !== 'ICC').length };

        const cam = [im.exif?.ifd0?.Make, im.exif?.ifd0?.Model].filter(Boolean).join(' ');
        const shot = im.exif?.exif?.DateTimeOriginal ?? im.exif?.ifd0?.DateTime ?? null;
        const isScreenshot = im.text_metadata_strings.some((t) => /UserComment/.test(t.field) && /screenshot/i.test(t.value));
        const otherAirline = im.named_entity_hits_in_metadata.filter((h) => /Airlines|Delta|United|Alaska|JetBlue|Spirit|Frontier/.test(h.name) && !/Southwest/.test(h.name));
        const descriptive = e.counts.descriptive_strings_excluding_icc;
        let role;
        const basis = [];
        if (isScreenshot) { role = 'screenshot / video still (per embedded UserComment "Screenshot"); reference image, subject not established from bytes'; basis.push('EXIF/XMP UserComment'); }
        else if (cam) { role = `camera photograph (per EXIF: ${cam}${shot ? ', ' + shot : ''}); reference image`; basis.push('EXIF Make/Model/DateTime'); }
        else if (descriptive === 0) { role = 'raster image with no descriptive embedded metadata; reference image whose subject is not established from the bytes'; basis.push('no EXIF/XMP/IPTC/text chunks'); }
        else { role = 'raster image with minimal technical metadata only; reference image whose subject is not established from the bytes'; basis.push('technical EXIF only'); }
        if (otherAirline.length) { role += `; embedded metadata names ${[...new Set(otherAirline.map((h) => h.name))].join(', ')} (not Southwest)`; basis.push('IPTC/XMP keywords'); }
        role += '; no link to any layout, tail, row or seat in the metadata';
        e.content_established_role = role;
        e.role_basis = basis;
        e.filename_hint = { text: o.name.replace(/\.[^.]+$/, ''), note: 'A file name is a label chosen by whoever saved the file; it is not evidence of what the image shows.' };
        e.pixel_content_reviewed = false;
      } else if (e.extension === '.json') {
        const rep = jc.files.find((f) => f.file === o.name);
        const cls = jc.classification[o.name];
        const dec = decodeText(buf);
        e.actual_format = rep.parses_as_json ? 'JSON (valid; UTF-8 text)' : 'plain text shaped like JSON but NOT valid JSON';
        e.actual_format_family = rep.parses_as_json ? 'JSON' : 'TEXT (invalid JSON)';
        e.text_encoding = dec.encoding;
        e.bom_present = dec.bom_present;
        e.parse_status = rep.parses_as_json ? 'ok' : 'failed';
        e.parse_error = rep.parses_as_json ? null : `${rep.strict_validator_error.message} at byte offset ${rep.strict_validator_error.offset} (line ${rep.strict_validator_error.line}, column ${rep.strict_validator_error.column}); native parser: ${rep.native_json_parse_error}`;
        e.classification = cls.classification;
        if (rep.parses_as_json) {
          const reg = s.registry;
          e.internal_metadata = { schema_metadata: reg.schema_metadata };
          e.counts = { top_level_keys: Object.keys(reg).length, lopa_configurations: reg.lopa_configurations.length, lopa_rows: reg.lopa_rows.length, lopa_seats: reg.lopa_seats.length };
          e.content_established_role = 'populated registry (configurations, rows, seats) — candidate data, unverified; the CSV/XLSX files are exports of the same records';
          e.role_basis = ['valid JSON', 'populated record arrays whose lengths equal the declared record counts', `all ${xf.totals.shared_attribute_values_compared} shared attribute values agree with the exports`];
        } else {
          const twins = jc.pairwise.filter((p) => p.byte_identical && (p.a === o.name || p.b === o.name)).map((p) => (p.a === o.name ? p.b : p.a));
          e.internal_metadata = { text_level_only: textMeta(dec.text), note: 'Extracted by pattern from the raw text because the file does not parse; nothing was repaired.' };
          e.counts = { lines: rep.line_count, placeholder_arrays: rep.literal_placeholder_bracket_ellipsis.count, records: 0 };
          e.content_established_role = `invalid JSON template (registry envelope with a metadata header and ${rep.literal_placeholder_bracket_ellipsis.count} elided "[ ... ]" arrays); holds no records${twins.length ? `; byte-identical to "${twins.join('", "')}"` : ''}`;
          e.role_basis = [cls.basis];
          e.byte_identical_to = twins;
        }
      } else if (e.extension === '.csv') {
        const m = csvMeta.files[o.name];
        e.actual_format = `CSV text (${m.delimiter_name}-delimited, ${m.encoding}${m.bom_present ? ' with BOM' : ', no BOM'}, ${m.line_ending_style} line endings)`;
        e.actual_format_family = 'CSV';
        e.text_encoding = m.encoding;
        e.bom_present = m.bom_present;
        e.parse_status = m.ragged_rows.length === 0 && !m.quote_usage.unterminated_quote ? 'ok' : 'parsed with irregularities';
        e.parse_error = m.ragged_rows.length ? `${m.ragged_rows.length} record(s) with a different field count` : null;
        e.internal_metadata = { note: 'CSV carries no internal revision or generation metadata.', headers: m.headers };
        e.counts = { data_rows: m.row_count, columns: m.header_count, quoted_fields: m.quote_usage.quoted_field_count };
        if (o.name === F.SCHEMA_CSV) {
          e.content_established_role = 'descriptive architecture summary (one line per registry entity: keys, declared row count, prose description) — not operational records';
          e.role_basis = [`${m.row_count} data rows naming entities, not cabin data`, 'free-text "Grain & Purpose" column', 'contains typesetting markup in the Foreign Keys column'];
        } else if (o.name === F.CONFIG_CSV) {
          const ent = xf.entities.find((x) => x.entity === 'lopa_configurations');
          e.content_established_role = 'export of the registry lopa_configurations entity (operational candidate records, unverified)';
          e.role_basis = [`${ent.attribute_values_agreeing} of ${ent.attribute_values_compared} shared attribute values agree with the registry JSON`];
        } else if (o.name === F.SEATS_CSV) {
          const ent = xf.entities.find((x) => x.entity === 'lopa_seats');
          e.content_established_role = 'export of the registry lopa_seats entity (operational candidate records, unverified)';
          e.role_basis = [`${ent.attribute_values_agreeing} of ${ent.attribute_values_compared} shared attribute values agree with the registry JSON`];
        }
      } else if (e.extension === '.xlsx') {
        const ct = s.xlsx.content_types.overrides.find((x) => /spreadsheetml\.sheet\.main/.test(x.content_type));
        e.actual_format = ct ? 'OOXML SpreadsheetML workbook (ZIP package, .xlsx, no macros)' : 'ZIP package (not recognised as SpreadsheetML)';
        e.actual_format_family = ct ? 'XLSX' : 'ZIP';
        e.parse_status = 'ok';
        e.parse_error = null;
        e.internal_metadata = { core_properties: wb.core_properties, app_properties: wb.app_properties, file_version: wb.file_version, authoring_path_recorded_in_workbook: wb.authoring_path_recorded_in_workbook };
        e.counts = {
          zip_entries: wb.zip_entries.length, sheets: wb.sheet_count, data_rows: wb.rows.length, columns: wb.column_order.length,
          cells_present: wb.sheets_summary[0].cell_count, formulas: wb.sheets_summary.reduce((n, x) => n + x.formula_cell_count, 0),
          merged_ranges: wb.sheets_summary.reduce((n, x) => n + x.merged_cells.length, 0), defined_names: wb.defined_names.length,
          external_links: wb.external_links.external_link_parts.length + wb.external_links.external_reference_ids.length,
          shared_strings_unique: wb.shared_strings.parsed_unique_count,
        };
        e.safety = { macros_present: wb.macros.vba_project_present || wb.macros.macro_enabled_content_type, external_connections: wb.external_links.connections_part, formulas_evaluated: false };
        const ent = xf.entities.find((x) => x.entity === 'lopa_rows');
        e.content_established_role = 'export of the registry lopa_rows entity (operational candidate records, unverified); identifier typed as number in some cells';
        e.role_basis = [`${ent.attribute_values_agreeing} of ${ent.attribute_values_compared} shared attribute values agree with the registry JSON after the listed conversions`];
      } else if (e.extension === '.docx') {
        const ct = s.docx.content_types.overrides.find((x) => /wordprocessingml\.document\.main/.test(x.content_type));
        e.actual_format = ct ? 'OOXML WordprocessingML document (ZIP package, .docx, no macros)' : 'ZIP package (not recognised as WordprocessingML)';
        e.actual_format_family = ct ? 'DOCX' : 'ZIP';
        e.parse_status = 'ok';
        e.parse_error = null;
        e.internal_metadata = { core_properties: docx.metadata.core_properties, app_properties: docx.metadata.app_properties, sensitivity_labels: docx.metadata.sensitivity_labels, settings: docx.metadata.settings };
        e.counts = {
          zip_entries: docx.metadata.zip_entries.length, body_paragraphs: docx.paragraphs.counts.body_paragraphs, table_cell_paragraphs: docx.paragraphs.counts.table_cell_paragraphs,
          headings: docx.paragraphs.counts.headings, list_items: docx.paragraphs.counts.list_items, tables: docx.tables.table_count,
          table_rows: docx.tables.tables.reduce((n, t) => n + t.row_count, 0), hyperlinks: docx.hyperlinks.hyperlink_count, distinct_hyperlink_targets: docx.hyperlinks.distinct_target_count,
          embedded_media_parts: docx.metadata.embedded_media.media_parts.length,
        };
        e.safety = { macros_present: docx.metadata.macros.vba_project_present || docx.metadata.macros.macro_enabled_content_type, embedded_media: docx.metadata.embedded_media.any_embedded_media, tracked_changes: docx.metadata.tracked_changes };
        e.content_established_role = 'narrative summary of current seat configurations (layout-category table, tier table, prose with citations to public and private pages) — unverified claims; layout grain differs from the registry';
        e.role_basis = ['headings and tables describe layout categories, not seat records', `${docx.hyperlinks.hyperlink_count} hyperlinks as citations`, 'no seat-by-seat data'];
      } else if (e.extension === '.rtf') {
        e.actual_format = `Rich Text Format (RTF ${rtf.header.rtf_version}, ${rtf.header.charset}, code page ${rtf.header.ansi_code_page}${rtf.generator_hint ? ', ' + rtf.generator_hint : ''})`;
        e.actual_format_family = 'RTF';
        e.parse_status = 'ok';
        e.parse_error = null;
        e.internal_metadata = { header: rtf.header, info_group_present: rtf.info_metadata.info_group_present, info_fields: rtf.info_metadata.fields, note: rtf.info_metadata.note, fonts: rtf.fonts };
        e.counts = { ...rtf.counts };
        e.secondary_cross_check = rtf.secondary_cross_check;
        e.content_established_role = 'narrative standard (configuration summary table plus row-by-row tier, window and recline narrative per interior) — unverified claims; carries no author, date or revision metadata';
        e.role_basis = ['one summary table and narrative paragraphs', 'no \\info group', 'no hyperlinks or citations'];
      } else {
        e.actual_format = det.format;
        e.actual_format_family = det.format;
        e.parse_status = 'not attempted (unrecognised type)';
      }
    } catch (err) {
      e.parse_status = 'failed';
      e.parse_error = String(err.message ?? err);
    }
    e.extension_matches_content = (EXT_EXPECT[e.extension] ?? []).includes(e.actual_format_family);
    entries.push(e);
  }

  // files in the source root that are not in the expected list
  const present = listSourceRootFiles();
  const expectedNames = new Set(ORIGINALS.map((o) => o.name));
  const unexpected = present.filter((n) => !expectedNames.has(n));
  const missing = ORIGINALS.map((o) => o.name).filter((n) => !present.includes(n));

  // final integrity check: re-hash every original straight from disk
  const checkedAt = new Date().toISOString();
  const integrity = ORIGINALS.map((o) => {
    let after = null;
    let size = null;
    try { after = sha256OfFileOnDisk(o.name); size = fileStatOnDisk(o.name).size; } catch { after = null; }
    const before = ctx.hashesBefore[o.name];
    return { relative_path: o.name, sha256_before_processing: before, sha256_after_processing: after, size_bytes_after: size, unchanged: before !== null && before === after };
  });
  const integritySummary = {
    checked_at: checkedAt,
    build_started_at: ctx.startedAt,
    files_checked: integrity.length,
    files_unchanged: integrity.filter((i) => i.unchanged).length,
    all_unchanged: integrity.every((i) => i.unchanged),
    method: 'SHA-256 of each original read fresh from disk before any parsing and again after all extraction steps',
  };
  if (!integritySummary.all_unchanged) ctx.failed = 'one or more originals changed during processing';

  const out = {
    purpose: 'Inventory of the supplied originals. Formats come from magic bytes / content, not from file extensions.',
    disclaimer: DISCLAIMER,
    source_root: SOURCE_ROOT,
    generated_at: checkedAt,
    summary: {
      expected_originals: ORIGINALS.length,
      found: entries.filter((e) => e.read_status === 'ok').length,
      documents: entries.filter((e) => e.group === 'document').length,
      images: entries.filter((e) => e.group === 'image').length,
      parse_ok: entries.filter((e) => e.parse_status === 'ok').length,
      parse_failed: entries.filter((e) => e.parse_status === 'failed').map((e) => e.relative_path),
      extension_content_mismatches: entries.filter((e) => e.extension_matches_content === false).map((e) => ({ file: e.relative_path, extension: e.extension, actual_format: e.actual_format })),
      missing_expected_files: missing,
      unexpected_files_in_source_root: unexpected,
      formats: entries.reduce((m, e) => { m[e.actual_format_family] = (m[e.actual_format_family] ?? 0) + 1; return m; }, {}),
    },
    integrity_check: { ...integritySummary, files: integrity },
    entries,
  };
  ctx.written.push(writeJson('inventory.json', out));

  // ---- markdown -----------------------------------------------------------------
  const md = [];
  const docs = entries.filter((e) => e.group === 'document');
  const imgs = entries.filter((e) => e.group === 'image');
  md.push('# Evidence inventory');
  md.push('');
  md.push(`> ${DISCLAIMER}`);
  md.push('');
  md.push(`${out.summary.found} of ${out.summary.expected_originals} expected originals found (${out.summary.documents} documents/data files, ${out.summary.images} images). Formats were determined from magic bytes and content. Parse OK: ${out.summary.parse_ok}; parse failed: ${out.summary.parse_failed.length}${out.summary.parse_failed.length ? ' (' + out.summary.parse_failed.map(code).join(', ') + ')' : ''}. Unexpected extra files in the source root: ${unexpected.length ? unexpected.map(code).join(', ') : 'none'}. Missing: ${missing.length ? missing.map(code).join(', ') : 'none'}.`);
  md.push('');
  md.push('## Documents and data files');
  md.push('');
  const metaSummary = (e) => {
    const m = e.internal_metadata ?? {};
    if (m.schema_metadata) return `schema_name ${code(m.schema_metadata.schema_name)}, schema_version ${code(m.schema_metadata.schema_version)}, normalization_form ${code(m.schema_metadata.normalization_form)}, generated_at_utc ${code(m.schema_metadata.generated_at_utc)}`;
    if (m.text_level_only) return Object.entries(m.text_level_only).map(([k, v]) => `${k} ${code(v)}`).join(', ') + ' (text-level; no generated_at_utc)';
    if (m.core_properties) {
      const c = m.core_properties;
      const a = m.app_properties ?? {};
      const parts = [];
      if (c['dc:title'] !== undefined) parts.push(`title ${code(c['dc:title'])}`);
      if (c['dc:creator'] !== undefined) parts.push(`creator ${code(c['dc:creator'])}`);
      if (c['cp:lastModifiedBy'] !== undefined) parts.push(`lastModifiedBy ${code(c['cp:lastModifiedBy'])}`);
      if (c['cp:revision'] !== undefined) parts.push(`revision ${code(c['cp:revision'])}`);
      parts.push(`created ${code(c['dcterms:created'])}`, `modified ${code(c['dcterms:modified'])}`);
      if (a.Application) parts.push(`application ${code(a.Application)} ${a.AppVersion ?? ''}`.trim());
      if (m.sensitivity_labels?.length) parts.push(`${m.sensitivity_labels.length} sensitivity-label reference`);
      if (m.authoring_path_recorded_in_workbook) parts.push(`authoring path ${code(m.authoring_path_recorded_in_workbook)}`);
      return parts.join(', ');
    }
    if (m.header) return `RTF header only (${code('\\rtf' + m.header.rtf_version)}, ${code('\\ansicpg' + m.header.ansi_code_page)}, ${code('\\cocoartf' + m.header.cocoartf)}); ${m.info_group_present ? '\\info present' : 'no \\info group (no title/author/dates)'}`;
    return m.note ?? '—';
  };
  const countSummary = (e) => Object.entries(e.counts ?? {}).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join('; ');
  md.push(mdTable(['#', 'File', 'Actual format (from bytes)', 'Size (bytes)', 'Parse', 'Counts', 'Internal source / revision metadata', 'Content-established role'],
    docs.map((e, i) => [i + 1, code(e.relative_path), e.actual_format, fmtBytes(e.size_bytes), e.parse_status === 'ok' ? 'ok' : `**${e.parse_status}** — ${e.parse_error}`, countSummary(e), metaSummary(e), e.content_established_role])));
  md.push('');
  md.push('## Images');
  md.push('');
  const imgMeta = (e) => {
    const m = e.internal_metadata;
    const parts = [];
    parts.push(m.exif.present ? `EXIF ${m.exif.byte_length} B` : 'no EXIF');
    parts.push(m.xmp.present ? `XMP ${m.xmp.byte_length} B` : 'no XMP');
    parts.push(m.iptc.present ? `IPTC ${m.iptc.byte_length} B` : 'no IPTC');
    parts.push(m.icc_profile ? `ICC ${code(m.icc_profile.description ?? '?')}` : 'no ICC');
    if (m.gps_data_present) parts.push(m.gps_values_withheld ? 'GPS tags present (coordinate values withheld from output)' : 'GPS tags present');
    return parts.join('; ');
  };
  md.push(mdTable(['#', 'File', 'Actual format', 'Size (bytes)', 'Pixels', 'Colour mode', 'Decode', 'Embedded metadata', 'Content-established role'],
    imgs.map((e, i) => [i + 1, code(e.relative_path), `${e.actual_format}${e.image_structure?.process ? ' — ' + e.image_structure.process : ''}${e.extension_matches_content ? '' : ' (extension mismatch)'}`, fmtBytes(e.size_bytes), `${e.pixel_width} × ${e.pixel_height}`, `${e.color.mode}, ${e.color.channels} ch, ${e.color.bits_per_channel}-bit${e.color.has_alpha === true ? ', alpha' : ''}`, e.parse_status, imgMeta(e), e.content_established_role])));
  md.push('');
  md.push('Pixel content was not interpreted at this stage; file names are recorded only as hints.');
  md.push('');
  md.push('### Embedded text metadata (creator / copyright / description / software / dates)');
  md.push('');
  const kfRows = [];
  for (const e of imgs) {
    const k = e.key_fields;
    const uniq = (list) => [...new Set(list.map((x) => x.value))];
    const row = [
      code(e.relative_path),
      uniq(k.creator).join('; ') || '—',
      uniq(k.copyright).join('; ') || '—',
      uniq([...k.description, ...k.keywords_and_subjects]).join('; ') || '—',
      uniq(k.location).join('; ') || '—',
      uniq([...k.software, ...k.camera]).join('; ') || '—',
      uniq(k.dates).slice(0, 6).join('; ') || '—',
    ];
    if (row.slice(1).some((c) => c !== '—')) kfRows.push(row);
  }
  md.push(mdTable(['File', 'Creator / credit', 'Copyright / rights', 'Description / title / keywords', 'Location', 'Software / camera', 'Dates'], kfRows));
  md.push('');
  const noText = imgs.filter((e) => e.counts.descriptive_strings_excluding_icc === 0).map((e) => code(e.relative_path));
  md.push(`Images with no descriptive embedded text at all (ICC profile text aside): ${noText.length ? noText.join(', ') : 'none'}.`);
  md.push('');
  const hits = imgs.flatMap((e) => e.named_entity_hits_in_metadata.map((h) => [code(e.relative_path), h.name, h.field, code(h.value)]));
  md.push('### Airline / manufacturer names found in image metadata');
  md.push('');
  md.push(hits.length ? mdTable(['File', 'Name matched', 'Metadata field', 'Value (verbatim)'], hits) : 'None found.');
  md.push('');
  const dimMismatch = imgs.flatMap((e) => (e.internal_metadata.metadata_declared_dimensions ?? []).filter((d) => !d.matches_encoded_image).map((d) => [code(e.relative_path), `${e.pixel_width} × ${e.pixel_height}`, d.source, `${d.width} × ${d.height}`]));
  if (dimMismatch.length) {
    md.push('### Dimensions declared in metadata that differ from the encoded image');
    md.push('');
    md.push(mdTable(['File', 'Encoded pixels', 'Metadata source', 'Declared'], dimMismatch));
    md.push('');
  }
  md.push('## SHA-256 and integrity check');
  md.push('');
  md.push(`Checked at **${integritySummary.checked_at}** (build started ${integritySummary.build_started_at}). Method: ${integritySummary.method}. Result: **${integritySummary.files_unchanged} of ${integritySummary.files_checked} originals unchanged**${integritySummary.all_unchanged ? '.' : ' — DIFFERENCES FOUND.'}`);
  md.push('');
  md.push(mdTable(['File', 'Size (bytes)', 'SHA-256 (after processing)', 'Same as before processing'],
    integrity.map((i) => [code(i.relative_path), i.size_bytes_after === null ? '—' : fmtBytes(i.size_bytes_after), i.sha256_after_processing ?? 'unreadable', i.unchanged ? 'yes' : '**NO**'])));
  md.push('');
  md.push('Full detail (all metadata tags, structure, cross-checks): `inventory.json`.');
  ctx.written.push(writeText('inventory.md', md.join('\n')));
  return out;
}
