// Byte-wise and (where possible) semantic comparison of the three JSON-named originals.
import { F, readOriginal, sha256, writeJson } from './lib/common.mjs';
import { validateJson } from './lib/json-check.mjs';

const FILES = [F.TEMPLATE_JSON, F.GEMINI_JSON, F.REGISTRY_JSON];

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? null : n;
}

function describe(name) {
  const buf = readOriginal(name);
  let text = null;
  let utf8Valid = true;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { utf8Valid = false; text = buf.toString('latin1'); }
  const strict = validateJson(text);
  let nativeError = null;
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { nativeError = String(e.message); }
  const placeholderOffsets = [];
  for (let i = text.indexOf('[ ... ]'); i >= 0; i = text.indexOf('[ ... ]', i + 1)) placeholderOffsets.push(i);
  const ellipsisOffsets = [];
  for (let i = text.indexOf('...'); i >= 0; i = text.indexOf('...', i + 1)) ellipsisOffsets.push(i);
  const lines = text.split('\n');
  return {
    buf, text, parsed,
    report: {
      file: name,
      size_bytes: buf.length,
      sha256: sha256(buf),
      valid_utf8: utf8Valid,
      non_ascii_bytes: buf.reduce((c, b) => c + (b > 0x7f ? 1 : 0), 0),
      bom_present: buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf,
      line_count: lines.length,
      line_ending: text.includes('\r\n') ? 'CRLF' : 'LF',
      ends_with_newline: text.endsWith('\n'),
      parses_as_json: strict.valid && nativeError === null,
      strict_validator_error: strict.error,
      native_json_parse_error: nativeError,
      literal_placeholder_bracket_ellipsis: { pattern: '[ ... ]', count: placeholderOffsets.length, offsets: placeholderOffsets },
      literal_ellipsis: { pattern: '...', count: ellipsisOffsets.length, offsets: ellipsisOffsets },
      placeholder_lines: lines.map((l, i) => ({ line: i + 1, text: l })).filter((l) => l.text.includes('[ ... ]')),
      top_level_keys_if_parsed: parsed && typeof parsed === 'object' ? Object.keys(parsed) : null,
    },
  };
}

function classify(d) {
  const t = d.text;
  const flags = {
    looks_like_json_object_envelope: /^\s*\{[\s\S]*\}\s*$/.test(t),
    has_schema_metadata_key: t.includes('"schema_metadata"'),
    names_entity_arrays: ['lopa_configurations', 'lopa_rows', 'lopa_seats'].filter((k) => new RegExp(`"${k}"\\s*:\\s*\\[`).test(t)),
    entity_arrays_are_elided_placeholders: d.report.literal_placeholder_bracket_ellipsis.count,
    contains_any_data_record: d.parsed ? ['lopa_configurations', 'lopa_rows', 'lopa_seats'].some((k) => Array.isArray(d.parsed[k]) && d.parsed[k].length > 0) : false,
    json_schema_keywords_present: /"\$schema"|"\$ref"|"properties"\s*:|"required"\s*:|"type"\s*:\s*"(object|array|string|number|integer|boolean)"/.test(t),
    code_tokens_present: /\b(function|import|export|const|let|var|def|class|return|SELECT|CREATE TABLE)\b|=>|;\s*$/m.test(t),
    prose_sentences_present: /[A-Za-z]{3,}\s+[a-z]{2,}\s+[a-z]{2,}\s+[a-z]{2,}[.!?](\s|$)/.test(t),
    markdown_fence_present: t.includes('```'),
  };
  let classification;
  let basis;
  if (d.report.parses_as_json && flags.contains_any_data_record) {
    classification = 'data';
    basis = 'valid JSON carrying populated record arrays';
  } else if (!d.report.parses_as_json && flags.has_schema_metadata_key && flags.entity_arrays_are_elided_placeholders > 0 && !flags.json_schema_keywords_present && !flags.code_tokens_present) {
    classification = 'envelope';
    basis = 'registry envelope/template: a schema_metadata header (names, primary keys, declared record counts) followed by entity arrays whose content is the literal placeholder "[ ... ]"; it holds no records, is not a JSON Schema document, contains no code and no prose, and is not valid JSON';
  } else if (flags.json_schema_keywords_present) {
    classification = 'schema';
    basis = 'JSON Schema keywords present';
  } else if (flags.code_tokens_present) {
    classification = 'code';
    basis = 'programming-language tokens present';
  } else if (flags.prose_sentences_present) {
    classification = 'prose';
    basis = 'sentence-like text present';
  } else {
    classification = 'undetermined';
    basis = 'no rule matched';
  }
  return { classification, classification_options: ['data', 'schema', 'code', 'prose', 'envelope'], basis, flags };
}

export function run(ctx) {
  const d = Object.fromEntries(FILES.map((f) => [f, describe(f)]));
  const pairs = [];
  for (let i = 0; i < FILES.length; i++) {
    for (let j = i + 1; j < FILES.length; j++) {
      const a = d[FILES[i]];
      const b = d[FILES[j]];
      const diff = firstDifference(a.buf, b.buf);
      pairs.push({
        a: FILES[i],
        b: FILES[j],
        size_a: a.buf.length,
        size_b: b.buf.length,
        sha256_equal: a.report.sha256 === b.report.sha256,
        byte_identical: diff === null,
        first_differing_byte_offset: diff,
        semantic_comparison: a.report.parses_as_json && b.report.parses_as_json
          ? { performed: true, deep_equal: JSON.stringify(a.parsed) === JSON.stringify(b.parsed) }
          : { performed: false, reason: 'at least one side is not valid JSON; no repair is attempted' },
      });
    }
  }

  // Text-level observation only (regex over raw text, no parsing/repair of the invalid templates).
  const declared = (text) => Object.fromEntries(
    [...text.matchAll(/"(lopa_[a-z]+)"\s*:\s*\{[^{}]*?"record_count"\s*:\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]),
  );
  const reg = d[F.REGISTRY_JSON];
  const actualCounts = reg.parsed
    ? Object.fromEntries(['lopa_configurations', 'lopa_rows', 'lopa_seats'].map((k) => [k, Array.isArray(reg.parsed[k]) ? reg.parsed[k].length : null]))
    : null;
  const keyOnlyIn = (text) => ['generated_at_utc', 'foreign_keys', 'schema_name', 'schema_version', 'normalization_form'].filter((k) => text.includes(`"${k}"`));

  const out = {
    purpose: 'Byte-wise comparison of the JSON-named originals. Invalid files are reported as-is and never repaired.',
    files: FILES.map((f) => d[f].report),
    pairwise: pairs,
    classification: Object.fromEntries(FILES.map((f) => [f, classify(d[f])])),
    textual_observations_without_repair: {
      note: 'Regex over raw text; not a semantic parse of the invalid templates.',
      declared_record_counts_in_text: Object.fromEntries(FILES.map((f) => [f, declared(d[f].text)])),
      actual_array_lengths_in_populated_registry: actualCounts,
      metadata_keys_present_in_text: Object.fromEntries(FILES.map((f) => [f, keyOnlyIn(d[f].text)])),
    },
    populated_registry_schema_metadata: reg.parsed ? reg.parsed.schema_metadata : null,
  };
  ctx.written.push(writeJson('extracts/json-compare.json', out));
  return out;
}
