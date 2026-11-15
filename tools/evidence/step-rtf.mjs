// RTF extract: located paragraphs and table cells, header metadata, hyperlinks.
import { execFileSync } from 'node:child_process';
import { F, readOriginal, originalPath, writeJson, writeText } from './lib/common.mjs';
import { loadSources } from './lib/sources.mjs';

function textutilCrossCheck(ownText) {
  // Secondary cross-check only: macOS textutil converts to plain text on stdout; the original is not modified.
  try {
    const out = execFileSync('/usr/bin/textutil', ['-convert', 'txt', '-stdout', originalPath(F.RTF)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const squash = (t) => t.replace(/\s+/gu, '');
    const a = squash(ownText);
    const b = squash(out);
    let diff = null;
    if (a !== b) {
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      diff = { first_difference_at_non_whitespace_char: i, own: a.slice(Math.max(0, i - 20), i + 20), textutil: b.slice(Math.max(0, i - 20), i + 20) };
    }
    return {
      tool: '/usr/bin/textutil -convert txt -stdout',
      available: true,
      comparison: 'all text with whitespace removed (layout differs: textutil prints each table cell on its own line)',
      own_non_whitespace_chars: a.length,
      textutil_non_whitespace_chars: b.length,
      identical: a === b,
      difference: diff,
    };
  } catch (e) {
    return { tool: '/usr/bin/textutil', available: false, error: String(e.message ?? e).split('\n')[0] };
  }
}

export function run(ctx) {
  const s = loadSources();
  const r = s.rtf;
  const raw = readOriginal(F.RTF);
  const rawLatin = raw.toString('latin1');

  const lines = [];
  lines.push(`# Located text extract of "${F.RTF}"`);
  lines.push('# Locators: P### = body paragraph (document order, empty paragraphs not numbered); T##.R##.C## = table cell.');
  lines.push('# Text is verbatim (cp1252 escapes and \\u escapes decoded); leading spaces and list markers preserved.');
  lines.push('');
  const pById = new Map(r.paragraphs.map((p) => [p.locator, p]));
  const tById = new Map(r.tables.map((t) => [t.locator, t]));
  for (const item of r.sequence) {
    if (item.kind === 'paragraph') {
      const p = pById.get(item.locator);
      lines.push(`[${p.locator}]${p.inferred_heading_level ? ` {heading-like L${p.inferred_heading_level}}` : ''} ${p.text}`);
    } else {
      const t = tById.get(item.locator);
      lines.push(`[${t.locator}] table: ${t.row_count} rows x ${t.column_counts.join('/')} columns`);
      for (const row of t.rows) for (const c of row.cells) lines.push(`[${c.locator}] ${c.text}`);
    }
  }

  const ownText = r.sequence.map((item) => (item.kind === 'paragraph'
    ? pById.get(item.locator).text
    : tById.get(item.locator).rows.flatMap((row) => row.cells.map((c) => c.text)).join('\n'))).join('\n');
  const escapes = {};
  for (const m of rawLatin.matchAll(/\\'([0-9a-fA-F]{2})/g)) escapes[m[1].toLowerCase()] = (escapes[m[1].toLowerCase()] ?? 0) + 1;
  const unicodeEscapes = {};
  for (const m of rawLatin.matchAll(/\\u(-?\d+)/g)) unicodeEscapes[m[1]] = (unicodeEscapes[m[1]] ?? 0) + 1;

  const out = {
    purpose: 'RTF read with an own tokenizer; no fields or objects are executed.',
    file: F.RTF,
    signature: r.signature,
    header: r.header,
    generator_hint: r.header.cocoartf !== null ? `Apple Cocoa text system (\\cocoartf${r.header.cocoartf})` : null,
    info_metadata: {
      info_group_present: r.info_group_present,
      fields: r.info,
      note: r.info_group_present ? 'Fields from the \\info group.' : 'The file has no \\info group: no title, author, creation or revision time is stored inside the RTF.',
    },
    fonts: r.fonts,
    escapes: {
      code_page: r.code_page_used,
      hex_escapes: Object.entries(escapes).map(([hex, count]) => ({ escape: `\\'${hex}`, count, decoded: new TextDecoder('windows-1252').decode(Uint8Array.of(parseInt(hex, 16))) })),
      unicode_escapes: Object.entries(unicodeEscapes).map(([cp, count]) => ({ escape: `\\u${cp}`, count, decoded: String.fromCharCode(Number(cp) < 0 ? Number(cp) + 65536 : Number(cp)) })),
    },
    counts: {
      paragraphs_non_empty: r.paragraphs.length,
      paragraphs_empty_not_numbered: r.empty_paragraph_count,
      heading_like_paragraphs: r.paragraphs.filter((p) => p.inferred_heading_level).length,
      list_item_paragraphs: r.paragraphs.filter((p) => p.list_marker).length,
      tables: r.tables.length,
      table_rows: r.tables.reduce((n, t) => n + t.row_count, 0),
      table_cells: r.tables.reduce((n, t) => n + t.rows.reduce((m, row) => m + row.cells.length, 0), 0),
      hyperlinks: r.hyperlinks.length,
      tokens: r.token_count,
    },
    heading_inference: r.heading_inference,
    body_font_size_half_points: r.body_font_size_half_points,
    hyperlinks: r.hyperlinks,
    raw_scan_for_links: {
      HYPERLINK_keyword_occurrences: (rawLatin.match(/HYPERLINK/g) ?? []).length,
      http_occurrences: (rawLatin.match(/https?:\/\//g) ?? []).length,
      field_groups: (rawLatin.match(/\\field\b/g) ?? []).length,
      embedded_objects_or_pictures: (rawLatin.match(/\\(object|pict)\b/g) ?? []).length,
    },
    secondary_cross_check: textutilCrossCheck(ownText),
    sequence: r.sequence,
    paragraphs: r.paragraphs,
    tables: r.tables,
  };
  ctx.written.push(writeJson('extracts/rtf-paragraphs.json', out));
  ctx.written.push(writeText('extracts/rtf-located.txt', lines.join('\n')));
  return out;
}
