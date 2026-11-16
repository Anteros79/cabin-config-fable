// DOCX extract: located paragraphs, tables, hyperlinks, metadata.
import { F, writeJson, writeText } from './lib/common.mjs';
import { loadSources } from './lib/sources.mjs';

const PRIVATE_HOST = /(sharepoint\.com|office365\.com|outlook\.|office\.com|onedrive|live\.com|microsoftonline|teams\.microsoft|\.local$|\.internal$|\.corp$|^localhost$|\.localhost$|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^127\.|^169\.254\.|^0\.0\.0\.0$)/i;

/** A bare IP address: IPv4 dotted quad, or IPv6 in brackets. Covers loopback (127/8, ::1), link-local (169.254/16, fe80::/10), unique-local (fc00::/7) and 0.0.0.0, and refuses every other address too. */
const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

export function classifyUrl(target) {
  let url;
  try { url = new URL(target); } catch { return { host: null, scheme: null, access_class: 'unparseable', reason: 'not a valid absolute URL' }; }
  const host = url.hostname;
  if (!/^https?:$/.test(url.protocol)) return { host, scheme: url.protocol, access_class: 'not-http', reason: 'non-HTTP scheme' };
  if (PRIVATE_HOST.test(host) || IP_LITERAL.test(host)) return { host, scheme: url.protocol, access_class: 'private', reason: 'tenant/authenticated host, internal network or bare IP address (SharePoint, Outlook/Office 365, loopback, link-local, private range)' };
  return { host, scheme: url.protocol, access_class: 'public', reason: 'public web host with no tenant/authentication marker' };
}

export function run(ctx) {
  const s = loadSources();
  const d = s.docx;
  const body = d.paragraphs.filter((p) => p.context === 'body');
  const cellParas = d.paragraphs.filter((p) => p.context === 'table-cell');

  // located text, in document order (tables placed after the paragraph that precedes them)
  const lines = [];
  lines.push(`# Located text extract of "${F.DOCX}"`);
  lines.push('# Locators: P### = body paragraph (document order); T##.R##.C## = table cell. Text is verbatim; hyperlinks are listed in docx-hyperlinks.json.');
  lines.push('');
  const tablesAfter = new Map();
  for (const t of d.tables) tablesAfter.set(t.preceding_paragraph_locator, (tablesAfter.get(t.preceding_paragraph_locator) ?? []).concat([t]));
  const renderTable = (t) => {
    lines.push(`[${t.locator}] table: ${t.row_count} rows x ${t.column_counts.join('/')} columns (style ${t.style})`);
    for (const row of t.rows) for (const c of row.cells) lines.push(`[${c.locator}]${row.is_header ? ' {header}' : ''} ${c.text}`);
  };
  for (const t of tablesAfter.get(null) ?? []) renderTable(t);
  for (const p of body) {
    const tag = p.heading_level ? ` {Heading ${p.heading_level}}` : p.list ? ` {list ${p.list.num_fmt ?? ''} L${p.list.level}}` : '';
    lines.push(`[${p.locator}]${tag} ${p.text}`);
    for (const t of tablesAfter.get(p.locator) ?? []) renderTable(t);
  }

  const hyperlinks = d.hyperlinks.map((h, i) => ({
    locator: `H${String(i + 1).padStart(2, '0')}`,
    paragraph_locator: h.paragraph_locator,
    anchor_text: h.anchor_text,
    target_url: h.target,
    target_mode: h.target_mode,
    relationship_id: h.rel_id,
    internal_anchor: h.anchor,
    char_offset_in_paragraph: h.char_offset_in_paragraph,
    ...classifyUrl(h.target ?? ''),
    preceding_text: (() => {
      const p = d.paragraphs.find((x) => x.locator === h.paragraph_locator);
      return p ? p.text.slice(Math.max(0, h.char_offset_in_paragraph - 70), h.char_offset_in_paragraph) : null;
    })(),
  }));
  const distinctTargets = [...new Set(hyperlinks.map((h) => h.target_url))].map((t) => ({
    target_url: t,
    ...classifyUrl(t ?? ''),
    occurrences: hyperlinks.filter((h) => h.target_url === t).map((h) => h.locator),
  }));

  const paragraphsOut = {
    purpose: 'DOCX read as ZIP + XML only.',
    file: F.DOCX,
    counts: {
      body_paragraphs: body.length,
      table_cell_paragraphs: cellParas.length,
      all_w_p_elements: d.paragraphs.length,
      empty_body_paragraphs: body.filter((p) => p.text === '').length,
      headings: body.filter((p) => p.heading_level).length,
      list_items: body.filter((p) => p.list).length,
      tables: d.tables.length,
      hyperlinks: d.hyperlinks.length,
    },
    headings: body.filter((p) => p.heading_level).map((p) => ({ locator: p.locator, level: p.heading_level, style: p.style_id, text: p.text })),
    paragraphs: d.paragraphs,
  };
  const tablesOut = {
    file: F.DOCX,
    table_count: d.tables.length,
    tables: d.tables.map((t) => ({
      ...t,
      header: t.rows[0] ? t.rows[0].cells.map((c) => c.text) : [],
      merged_cells: t.rows.flatMap((r) => r.cells.filter((c) => c.grid_span > 1 || c.v_merge).map((c) => c.locator)),
    })),
  };
  const hyperlinksOut = {
    file: F.DOCX,
    hyperlink_count: hyperlinks.length,
    distinct_target_count: distinctTargets.length,
    hyperlink_relationships_in_package: d.hyperlink_relationship_count,
    unused_hyperlink_relationships: d.unused_hyperlink_relationships,
    field_code_hyperlinks: d.field_instructions.filter((f) => /HYPERLINK/i.test(f)),
    by_access_class: hyperlinks.reduce((m, h) => { m[h.access_class] = (m[h.access_class] ?? 0) + 1; return m; }, {}),
    distinct_targets: distinctTargets,
    hyperlinks,
  };
  const metadataOut = {
    file: F.DOCX,
    core_properties: d.core_properties,
    app_properties: d.app_properties,
    custom_properties_part: d.custom_properties_part,
    sensitivity_labels: d.sensitivity_labels,
    sensitivity_label_note: d.sensitivity_labels.length ? 'docMetadata/LabelInfo.xml carries a Microsoft Purview sensitivity-label reference (GUIDs only; the label name is not stored in the file).' : null,
    settings: d.settings,
    page: d.page,
    declared_vs_counted: {
      app_xml_declared: { Pages: d.app_properties?.Pages, Words: d.app_properties?.Words, Characters: d.app_properties?.Characters, Paragraphs: d.app_properties?.Paragraphs, Lines: d.app_properties?.Lines },
      counted_here: {
        body_paragraphs: body.length,
        table_cell_paragraphs: cellParas.length,
        words_whitespace_split: d.paragraphs.reduce((n, p) => n + (p.text.trim() === '' ? 0 : p.text.trim().split(/\s+/u).length), 0),
        characters_excluding_whitespace: d.paragraphs.reduce((n, p) => n + p.text.replace(/\s/gu, '').length, 0),
      },
      note: 'Word’s own statistics are application-computed and are recorded as declared values only.',
    },
    embedded_media: { ...d.embedded_media, any_embedded_media: d.embedded_media.media_parts.length + d.embedded_media.embedding_parts.length + d.embedded_media.drawing_elements + d.embedded_media.vml_pict_elements + d.embedded_media.ole_object_elements > 0 },
    macros: d.macros,
    tracked_changes: d.tracked_changes,
    other_parts: d.other_parts,
    content_types: d.content_types,
    zip_entries: d.zip_entries,
    relationships: d.relationships,
  };

  ctx.written.push(writeJson('extracts/docx-paragraphs.json', paragraphsOut));
  ctx.written.push(writeText('extracts/docx-located.txt', lines.join('\n')));
  ctx.written.push(writeJson('extracts/docx-tables.json', tablesOut));
  ctx.written.push(writeJson('extracts/docx-hyperlinks.json', hyperlinksOut));
  ctx.written.push(writeJson('extracts/docx-metadata.json', metadataOut));
  return { paragraphs: paragraphsOut, tables: tablesOut, hyperlinks: hyperlinksOut, metadata: metadataOut };
}
