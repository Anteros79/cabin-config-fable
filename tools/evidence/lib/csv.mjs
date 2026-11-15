// RFC 4180 style CSV reader that keeps every field as the exact source string
// and records byte-level facts (BOM, encoding, delimiter, quoting, line endings).

const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'];

export function decodeText(buf) {
  let bom = null;
  let offset = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    bom = 'UTF-8 (EF BB BF)';
    offset = 3;
  } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    bom = 'UTF-16LE (FF FE)';
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    bom = 'UTF-16BE (FE FF)';
  }
  const body = buf.subarray(offset);
  let nonAscii = 0;
  for (const b of body) if (b > 0x7f) nonAscii++;
  let text;
  let encoding;
  let validUtf8 = true;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    encoding = nonAscii === 0 ? 'US-ASCII (valid UTF-8 subset)' : 'UTF-8';
  } catch {
    validUtf8 = false;
    text = new TextDecoder('windows-1252').decode(body);
    encoding = 'not valid UTF-8; decoded as windows-1252';
  }
  return { text, bom, bom_present: bom !== null, encoding, valid_utf8: validUtf8, non_ascii_byte_count: nonAscii };
}

function detectDelimiter(text) {
  // Count candidate delimiters outside quotes on the first physical record.
  const counts = Object.fromEntries(CANDIDATE_DELIMITERS.map((d) => [d, 0]));
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQ && text[i + 1] === '"') { i++; continue; }
      inQ = !inQ;
    } else if (!inQ) {
      if (ch === '\n' || ch === '\r') break;
      if (ch in counts) counts[ch]++;
    }
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return { delimiter: best[1] > 0 ? best[0] : ',', header_line_counts: counts };
}

export function parseCsv(buf) {
  const dec = decodeText(buf);
  const { text } = dec;
  const { delimiter, header_line_counts } = detectDelimiter(text);

  const records = [];
  const lineEndings = { CRLF: 0, LF: 0, CR: 0, inside_quoted_fields: 0 };
  let fields = [];
  let field = '';
  let quoted = false;
  let inQ = false;
  let line = 1;
  let recordStartLine = 1;
  let quotedFieldCount = 0;
  let escapedQuoteCount = 0;
  let strayQuoteCount = 0;
  let fieldStarted = false;

  const pushField = () => {
    fields.push({ value: field, quoted });
    if (quoted) quotedFieldCount++;
    field = '';
    quoted = false;
    fieldStarted = false;
  };
  const pushRecord = () => {
    pushField();
    records.push({ line: recordStartLine, fields });
    fields = [];
  };

  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; escapedQuoteCount++; i += 2; continue; }
        inQ = false; i++; continue;
      }
      if (ch === '\r' && text[i + 1] === '\n') { field += '\r\n'; lineEndings.inside_quoted_fields++; line++; i += 2; continue; }
      if (ch === '\n' || ch === '\r') { lineEndings.inside_quoted_fields++; line++; }
      field += ch; i++; continue;
    }
    if (ch === '"') {
      if (!fieldStarted && field === '') { inQ = true; quoted = true; fieldStarted = true; }
      else { field += ch; strayQuoteCount++; }
      i++; continue;
    }
    if (ch === delimiter) { pushField(); i++; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') { lineEndings.CRLF++; i += 2; }
      else if (ch === '\n') { lineEndings.LF++; i++; }
      else { lineEndings.CR++; i++; }
      pushRecord();
      line++;
      recordStartLine = line;
      continue;
    }
    field += ch; fieldStarted = true; i++;
  }
  const endsWithNewline = n > 0 && (text[n - 1] === '\n' || text[n - 1] === '\r');
  if (!endsWithNewline && (field !== '' || fields.length > 0 || quoted)) pushRecord();

  const header = records.length ? records[0].fields.map((f) => f.value) : [];
  const headerQuoted = records.length ? records[0].fields.map((f) => f.quoted) : [];
  const dataRecords = records.slice(1);
  const ragged = dataRecords
    .filter((r) => r.fields.length !== header.length)
    .map((r) => ({ line: r.line, field_count: r.fields.length }));

  const rows = dataRecords.map((r) => {
    const obj = {};
    header.forEach((h, idx) => { obj[h] = r.fields[idx] ? r.fields[idx].value : undefined; });
    return { line: r.line, values: obj, quoted: r.fields.map((f) => f.quoted) };
  });

  const usedEndings = ['CRLF', 'LF', 'CR'].filter((k) => lineEndings[k] > 0);
  return {
    ...dec,
    delimiter,
    delimiter_name: { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' }[delimiter],
    delimiter_counts_on_header_line: header_line_counts,
    quote_char: '"',
    quoted_field_count: quotedFieldCount,
    escaped_quote_count: escapedQuoteCount,
    stray_quote_count: strayQuoteCount,
    unterminated_quote: inQ,
    line_endings: lineEndings,
    line_ending_style: usedEndings.length === 1 ? usedEndings[0] : usedEndings.length === 0 ? 'none' : 'mixed: ' + usedEndings.join('+'),
    ends_with_newline: endsWithNewline,
    header,
    header_quoted: headerQuoted,
    record_count_including_header: records.length,
    row_count: rows.length,
    ragged_rows: ragged,
    rows,
  };
}

// ---- value classification (never changes the stored value) -----------------

export function classifyValue(v) {
  if (v === undefined || v === null) return 'absent';
  if (v === '') return 'blank';
  if (/^\s+$/.test(v)) return 'whitespace';
  if (/^(True|False)$/.test(v)) return 'boolean(True/False)';
  if (/^(true|false|TRUE|FALSE)$/.test(v)) return 'boolean(other case)';
  if (/^-?(0|[1-9]\d*)$/.test(v)) return 'integer';
  if (/^-?0\d+$/.test(v)) return 'leading-zero digits';
  if (/^-?(0|[1-9]\d*)\.\d+$/.test(v)) return 'decimal';
  return 'string';
}

const LABEL_PATTERNS = [
  { name: 'tilde qualifier (~)', re: /~/ },
  { name: 'digit-hyphen-digit (range or hyphenated identifier)', re: /\d\s*[-\u2013]\s*\d/ },
  { name: 'plus qualifier (n+)', re: /\d\+/ },
  { name: 'inch mark (")', re: /\d"/ },
  { name: 'parenthetical qualifier', re: /\(.*\)/ },
];

export function profileColumns(header, rows) {
  return header.map((name, idx) => {
    const values = rows.map((r) => r.values[name]);
    const classes = {};
    for (const v of values) {
      const c = classifyValue(v);
      classes[c] = (classes[c] ?? 0) + 1;
    }
    const nonBlank = Object.keys(classes).filter((c) => c !== 'blank' && c !== 'absent');
    let inferred;
    if (nonBlank.length === 0) inferred = 'empty';
    else if (nonBlank.length === 1) inferred = nonBlank[0];
    else if (nonBlank.every((c) => c === 'integer' || c === 'decimal')) inferred = 'decimal';
    else inferred = 'string (mixed lexical forms: ' + nonBlank.sort().join(', ') + ')';

    const distinct = new Map();
    for (const v of values) distinct.set(v, (distinct.get(v) ?? 0) + 1);

    const numericLooking = [...distinct.entries()].filter(([v]) => ['integer', 'decimal', 'leading-zero digits'].includes(classifyValue(v)));
    const mixed = inferred.startsWith('string (mixed');
    const preserve = [];
    if (mixed) {
      for (const [v, c] of numericLooking) preserve.push({ value: v, count: c, reason: 'numeric-looking value in a column that also holds non-numeric labels' });
    }
    for (const [v, c] of distinct) {
      if (classifyValue(v) === 'leading-zero digits') preserve.push({ value: v, count: c, reason: 'leading zero' });
      if (classifyValue(v) === 'string') {
        const hits = LABEL_PATTERNS.filter((p) => p.re.test(v)).map((p) => p.name);
        if (hits.length && /\d/.test(v) && v.length <= 40) preserve.push({ value: v, count: c, reason: 'label-like: ' + hits.join(', ') });
      }
      if (v !== undefined && v !== '' && v !== v.trim()) preserve.push({ value: v, count: c, reason: 'leading/trailing whitespace' });
    }
    const lossyDecimals = [...distinct.entries()]
      .filter(([v]) => classifyValue(v) === 'decimal' && String(Number(v)) !== v)
      .map(([v, c]) => ({ value: v, count: c, numeric_round_trip: String(Number(v)) }));

    const firstNonBlank = values.find((v) => v !== '' && v !== undefined);
    return {
      index: idx,
      name,
      inferred_type: inferred,
      lexical_class_counts: classes,
      blank_count: classes.blank ?? 0,
      absent_count: classes.absent ?? 0,
      distinct_count: distinct.size,
      example_raw_value: firstNonBlank ?? '',
      max_length: values.reduce((m, v) => Math.max(m, (v ?? '').length), 0),
      preserve_as_string: preserve,
      decimals_changed_by_numeric_round_trip: lossyDecimals,
      distinct_values: distinct.size <= 12 ? [...distinct.entries()].map(([value, count]) => ({ value, count })) : undefined,
    };
  });
}

export function duplicateKeys(rows, keyFields) {
  const seen = new Map();
  for (const r of rows) {
    const k = JSON.stringify(keyFields.map((f) => r.values[f]));
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(r.line);
  }
  return [...seen.entries()].filter(([, lines]) => lines.length > 1).map(([key, lines]) => ({ key: JSON.parse(key), lines }));
}
