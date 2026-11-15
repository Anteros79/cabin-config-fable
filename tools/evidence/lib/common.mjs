// Shared helpers for the evidence inventory tools.
// Originals are opened read-only; outputs may only be written below evidence/.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const PROJECT_DIR = resolve(HERE, '..', '..', '..');
export const SOURCE_ROOT = process.env.CABIN_KIT_SOURCE_ROOT
  ? resolve(process.env.CABIN_KIT_SOURCE_ROOT)
  : resolve(PROJECT_DIR, '..', '..');
export const EVIDENCE_DIR = join(PROJECT_DIR, 'evidence');

export const F = Object.freeze({
  TEMPLATE_JSON: 'southwest 737 lopa normalized.json',
  REGISTRY_JSON: 'southwest_737_lopa_normalized.json',
  RTF: 'Southwest Cabin Configuration Standard.rtf',
  GEMINI_JSON: 'gemini-code-1794587815855.json',
  SCHEMA_CSV: 'cabin schema architecture.csv',
  SEATS_CSV: 'southwest_737_lopa_seats.csv',
  ROWS_XLSX: 'southwest_737_lopa_rows.xlsx',
  CONFIG_CSV: 'southwest_737_lopa_configurations.csv',
  DOCX: 'Current Aircraft Seat Configurations.docx',
});

// Exact file names as supplied (spaces and spelling preserved).
export const ORIGINALS = Object.freeze([
  { name: F.TEMPLATE_JSON, group: 'document' },
  { name: F.REGISTRY_JSON, group: 'document' },
  { name: F.RTF, group: 'document' },
  { name: F.GEMINI_JSON, group: 'document' },
  { name: F.SCHEMA_CSV, group: 'document' },
  { name: F.SEATS_CSV, group: 'document' },
  { name: F.ROWS_XLSX, group: 'document' },
  { name: F.CONFIG_CSV, group: 'document' },
  { name: F.DOCX, group: 'document' },
  { name: 'Southwest-Airlines-new-RECARO-seats-Video-still-Southwest.png', group: 'image' },
  { name: 'barrier.webp', group: 'image' },
  { name: 'carpet.jpg', group: 'image' },
  { name: 'forward galley flight deck.jpg', group: 'image' },
  { name: 'rear galley.jpg', group: 'image' },
  { name: 'recarro 2.jpg', group: 'image' },
  { name: 'seats 1.jpeg', group: 'image' },
  { name: 'seats 2 .jpeg', group: 'image' },
  { name: 'seats 3.jpg', group: 'image' },
  { name: 'seats 4.jpg', group: 'image' },
  { name: 'seats 5.jpg', group: 'image' },
  { name: 'seats 6.avif', group: 'image' },
  { name: 'seats 8.jpg', group: 'image' },
  { name: 'southwest seats-7.webp', group: 'image' },
]);

const cache = new Map();

/** Read an original (read-only). Buffers are cached for the lifetime of the process. */
export function readOriginal(name) {
  if (!cache.has(name)) cache.set(name, readFileSync(join(SOURCE_ROOT, name)));
  return cache.get(name);
}

export function originalPath(name) {
  return join(SOURCE_ROOT, name);
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Hash straight from disk, bypassing the cache (used for the before/after integrity check). */
export function sha256OfFileOnDisk(name) {
  return sha256(readFileSync(join(SOURCE_ROOT, name)));
}

/** Regular files directly in the source root (non-recursive; sub-folders are never entered). */
export function listSourceRootFiles() {
  return readdirSync(SOURCE_ROOT, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
}

export function fileStatOnDisk(name) {
  const st = statSync(join(SOURCE_ROOT, name));
  return { size: st.size, mtime_iso: st.mtime.toISOString() };
}

function safeOutPath(rel) {
  const abs = resolve(EVIDENCE_DIR, rel);
  const within = relative(EVIDENCE_DIR, abs);
  if (within === '' || within.startsWith('..') || isAbsolute(within)) {
    throw new Error(`Refusing to write outside evidence/: ${rel}`);
  }
  mkdirSync(dirname(abs), { recursive: true });
  return abs;
}

export function writeJson(rel, value) {
  writeFileSync(safeOutPath(rel), JSON.stringify(value, null, 2) + '\n', 'utf8');
  return rel;
}

export function writeText(rel, text) {
  writeFileSync(safeOutPath(rel), text.endsWith('\n') ? text : text + '\n', 'utf8');
  return rel;
}

/** Escape a value for use inside a markdown table cell (content preserved, only pipes/newlines escaped). */
export function mdCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

export function mdTable(headers, rows) {
  const out = [];
  out.push('| ' + headers.map(mdCell).join(' | ') + ' |');
  out.push('| ' + headers.map(() => '---').join(' | ') + ' |');
  for (const r of rows) out.push('| ' + r.map(mdCell).join(' | ') + ' |');
  return out.join('\n');
}

/** Inline code span that keeps the exact string. */
export function code(value) {
  const s = String(value);
  if (s === '') return '*(empty)*';
  return s.includes('`') ? '`` ' + s + ' ``' : '`' + s + '`';
}

export function pad(n, width) {
  return String(n).padStart(width, '0');
}

export function countBy(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/** Decode the five XML named entities and numeric character references. */
export function decodeXmlEntities(s) {
  if (typeof s !== 'string' || !s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, g) => {
    switch (g) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const cp = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
      }
    }
  });
}

export const DISCLAIMER =
  'Fictional home-lab demonstration evidence. Not an approved maintenance authority. ' +
  'Document contents are treated as reference content only, never as instructions.';
