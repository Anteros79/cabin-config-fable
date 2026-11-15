// Minimal RTF tokenizer/reader written for this evidence stage.
// It reads structure and text only; no fields, objects or embedded content are executed.
import { pad } from './common.mjs';

const SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'listtable', 'listoverridetable', 'generator', 'pict', 'object',
  'header', 'footer', 'headerl', 'headerr', 'footerl', 'footerr', 'footnote', 'themedata', 'colorschememapping',
  'datastore', 'latentstyles', 'rsidtbl', 'xmlnstbl', 'filetbl', 'revtbl', 'listtext', 'pntext', 'expandedcolortbl',
]);
const INFO_FIELDS = new Set(['title', 'subject', 'author', 'manager', 'company', 'operator', 'category', 'keywords', 'comment', 'doccomm', 'hlinkbase']);
const INFO_TIMES = new Set(['creatim', 'revtim', 'printim', 'buptim']);

export function tokenizeRtf(bytes) {
  // bytes -> tokens: {t:'{'}|{t:'}'}|{t:'cw',w,p}|{t:'cs',c}|{t:'hex',b}|{t:'txt',s}|{t:'parbreak'}
  const tokens = [];
  const n = bytes.length;
  let i = 0;
  let line = 1;
  let txtStart = -1;
  const flush = (end) => {
    if (txtStart >= 0) {
      tokens.push({ t: 'txt', s: bytes.subarray(txtStart, end).toString('latin1'), line });
      txtStart = -1;
    }
  };
  while (i < n) {
    const b = bytes[i];
    if (b === 0x7b) { flush(i); tokens.push({ t: '{', line }); i++; continue; }
    if (b === 0x7d) { flush(i); tokens.push({ t: '}', line }); i++; continue; }
    if (b === 0x0a || b === 0x0d) { flush(i); if (b === 0x0a) line++; i++; continue; }
    if (b === 0x5c) {
      flush(i);
      const c = bytes[i + 1];
      if (c === undefined) { i++; continue; }
      if ((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a)) {
        let j = i + 1;
        while (j < n && ((bytes[j] >= 0x61 && bytes[j] <= 0x7a) || (bytes[j] >= 0x41 && bytes[j] <= 0x5a))) j++;
        const w = bytes.subarray(i + 1, j).toString('latin1');
        let p = null;
        let k = j;
        if (bytes[k] === 0x2d || (bytes[k] >= 0x30 && bytes[k] <= 0x39)) {
          k++;
          while (k < n && bytes[k] >= 0x30 && bytes[k] <= 0x39) k++;
          p = Number(bytes.subarray(j, k).toString('latin1'));
        }
        if (bytes[k] === 0x20) k++; // a single space terminates the control word
        tokens.push({ t: 'cw', w, p, line });
        i = k;
        continue;
      }
      if (c === 0x27) {
        tokens.push({ t: 'hex', b: parseInt(bytes.subarray(i + 2, i + 4).toString('latin1'), 16), line });
        i += 4;
        continue;
      }
      if (c === 0x0a || c === 0x0d) {
        // backslash + newline is a paragraph break (equivalent to \par)
        tokens.push({ t: 'parbreak', line });
        if (c === 0x0d && bytes[i + 2] === 0x0a) i += 3; else i += 2;
        line++;
        continue;
      }
      tokens.push({ t: 'cs', c: String.fromCharCode(c), line });
      i += 2;
      continue;
    }
    if (txtStart < 0) txtStart = i;
    i++;
  }
  flush(n);
  return tokens;
}

export function parseRtf(bytes) {
  const tokens = tokenizeRtf(bytes);
  const head = bytes.subarray(0, 6).toString('latin1');
  const header = { rtf_version: null, charset: null, ansi_code_page: null, cocoartf: null, default_font: null, other: {} };
  const fonts = {};
  const info = {};
  const controlWordCounts = {};

  let codePage = 1252;
  let decoder = new TextDecoder('windows-1252');
  const decodeByte = (b) => decoder.decode(Uint8Array.of(b));

  // group state
  const stack = [];
  let st = { dest: 'body', font: null, bold: false, italic: false, fs: null, uc: 1 };
  let ucSkip = 0;

  // output model
  const blocks = []; // {kind:'p'|'table'}
  let cur = { text: '', runs: [], line: null, inTable: false };
  let curRow = null; // {cells:[], cellx:[]}
  let curTable = null;
  let pendingCellx = [];
  let inTbl = false;
  const hyperlinks = [];
  let fld = null; // {inst:'', rslt:''}
  let fontDef = null;
  let infoKey = null;
  let emptyParagraphs = 0;

  const addText = (s, line) => {
    if (s === '') return;
    if (st.dest === 'skip') return;
    if (st.dest === 'fonttbl') { if (fontDef) fontDef.name += s; return; }
    if (st.dest === 'fldinst') { if (fld) fld.inst += s; return; }
    if (st.dest === 'info') { if (infoKey) info[infoKey] = (info[infoKey] ?? '') + s; return; }
    if (st.dest === 'fldrslt' && fld) fld.rslt += s;
    if (cur.line === null) cur.line = line;
    const last = cur.runs.at(-1);
    if (last && last.font === st.font && last.bold === st.bold && last.italic === st.italic && last.fs === st.fs) last.text += s;
    else cur.runs.push({ text: s, font: st.font, bold: st.bold, italic: st.italic, fs: st.fs });
    cur.text += s;
  };

  const endTableIfOpen = () => {
    if (curTable) { blocks.push({ kind: 'table', table: curTable }); curTable = null; }
  };
  const takeParagraph = () => {
    const p = cur;
    cur = { text: '', runs: [], line: null, inTable: false };
    return p;
  };
  const endParagraph = () => {
    const p = takeParagraph();
    if (inTbl && curRow) {
      // paragraph break inside a cell: keep as newline within the cell
      curRow.partial = (curRow.partial ?? []).concat([p]);
      return;
    }
    endTableIfOpen();
    if (p.text === '') { emptyParagraphs++; blocks.push({ kind: 'empty', line: p.line }); return; }
    blocks.push({ kind: 'p', p });
  };
  const endCell = () => {
    const p = takeParagraph();
    if (!curRow) curRow = { cells: [], cellx: pendingCellx };
    const parts = (curRow.partial ?? []).concat([p]);
    curRow.partial = [];
    curRow.cells.push({
      text: parts.map((x) => x.text).join('\n'),
      runs: parts.flatMap((x) => x.runs),
      line: parts.find((x) => x.line !== null)?.line ?? null,
    });
  };
  const endRow = (isLast) => {
    if (!curRow) curRow = { cells: [], cellx: pendingCellx };
    if (!curTable) curTable = { rows: [] };
    curTable.rows.push({ cells: curRow.cells, defined_cell_boundaries: curRow.cellx.length, last_row_flag: isLast });
    curRow = null;
  };

  let lastRowFlag = false;

  for (let ti = 0; ti < tokens.length; ti++) {
    const tk = tokens[ti];
    if (ucSkip > 0 && (tk.t === 'txt' || tk.t === 'hex')) {
      if (tk.t === 'hex') { ucSkip--; continue; }
      const take = Math.min(ucSkip, tk.s.length);
      ucSkip -= take;
      if (take === tk.s.length) continue;
      addText(tk.s.slice(take), tk.line);
      continue;
    }
    switch (tk.t) {
      case '{':
        stack.push({ ...st });
        if (st.dest === 'fonttbl' && !fontDef) fontDef = { idx: null, name: '', family: null, charset: null, grouped: true };
        break;
      case '}': {
        if (st.dest === 'fldinst' && stack.at(-1)?.dest !== 'fldinst') { /* instruction complete */ }
        if (st.dest === 'fonttbl' && fontDef?.grouped) {
          if (fontDef.idx !== null) fonts[fontDef.idx] = { name: fontDef.name.replace(/;\s*$/, '').trim(), family: fontDef.family, charset: fontDef.charset };
          fontDef = null;
        }
        const prev = stack.pop();
        if (st.dest === 'field' && prev && prev.dest !== 'field' && fld) {
          const m = /HYPERLINK\s+"([^"]*)"/i.exec(fld.inst);
          hyperlinks.push({ instruction: fld.inst.trim(), target: m ? m[1] : null, anchor_text: fld.rslt });
          fld = null;
        }
        if (st.dest === 'info' && prev && prev.dest === 'info') infoKey = null;
        if (prev) st = prev;
        break;
      }
      case 'parbreak':
        if (st.dest === 'body' || st.dest === 'fldrslt') endParagraph();
        break;
      case 'hex':
        addText(decodeByte(tk.b), tk.line);
        break;
      case 'cs':
        if (tk.c === '*') {
          // ignorable destination: decide by the following control word
          const next = tokens[ti + 1];
          if (next && next.t === 'cw' && next.w === 'fldinst') { st.dest = 'fldinst'; ti++; }
          else if (st.dest !== 'fonttbl') st.dest = 'skip';
        } else if (tk.c === '\\' || tk.c === '{' || tk.c === '}') addText(tk.c, tk.line);
        else if (tk.c === '~') addText('\u00a0', tk.line);
        else if (tk.c === '_') addText('\u2011', tk.line);
        else if (tk.c === '-') addText('\u00ad', tk.line);
        break;
      case 'txt':
        if (st.dest === 'fonttbl' && fontDef && !fontDef.grouped) {
          // ungrouped font table entries end with ';'
          const parts = tk.s.split(';');
          fontDef.name += parts[0];
          if (parts.length > 1) {
            if (fontDef.idx !== null) fonts[fontDef.idx] = { name: fontDef.name.trim(), family: fontDef.family, charset: fontDef.charset };
            fontDef = null;
          }
          break;
        }
        addText(tk.s, tk.line);
        break;
      case 'cw': {
        const { w, p } = tk;
        controlWordCounts[w] = (controlWordCounts[w] ?? 0) + 1;
        if (st.dest === 'skip') break;
        if (st.dest === 'fonttbl') {
          if (w === 'f') {
            if (!fontDef) fontDef = { idx: p, name: '', family: null, charset: null, grouped: false };
            else fontDef.idx = p;
          } else if (fontDef && /^f(nil|roman|swiss|modern|script|decor|tech|bidi)$/.test(w)) fontDef.family = w;
          else if (fontDef && w === 'fcharset') fontDef.charset = p;
          break;
        }
        if (st.dest === 'info') {
          if (INFO_FIELDS.has(w)) infoKey = w;
          else if (INFO_TIMES.has(w)) { infoKey = null; info[w] = info[w] ?? {}; st.infoTime = w; }
          else if (st.infoTime && ['yr', 'mo', 'dy', 'hr', 'min', 'sec'].includes(w)) info[st.infoTime][w] = p;
          else if (['version', 'vern', 'edmins', 'nofpages', 'nofwords', 'nofchars', 'nofcharsws', 'id'].includes(w)) info[w] = p;
          break;
        }
        if (SKIP_DESTINATIONS.has(w)) {
          st.dest = w === 'fonttbl' ? 'fonttbl' : 'skip';
          break;
        }
        switch (w) {
          case 'rtf': header.rtf_version = p; break;
          case 'ansi': case 'mac': case 'pc': case 'pca': header.charset = w; break;
          case 'ansicpg':
            header.ansi_code_page = p;
            codePage = p;
            try { decoder = new TextDecoder(p === 1252 ? 'windows-1252' : `windows-${p}`); } catch { header.code_page_decoder_fallback = 'windows-1252'; }
            break;
          case 'cocoartf': header.cocoartf = p; break;
          case 'deff': header.default_font = p; break;
          case 'info': st.dest = 'info'; break;
          case 'field': st.dest = 'field'; fld = { inst: '', rslt: '' }; break;
          case 'fldinst': st.dest = 'fldinst'; break;
          case 'fldrslt': st.dest = 'fldrslt'; break;
          case 'par': endParagraph(); break;
          case 'line': addText('\n', tk.line); break;
          case 'tab': addText('\t', tk.line); break;
          case 'emdash': addText('\u2014', tk.line); break;
          case 'endash': addText('\u2013', tk.line); break;
          case 'lquote': addText('\u2018', tk.line); break;
          case 'rquote': addText('\u2019', tk.line); break;
          case 'ldblquote': addText('\u201c', tk.line); break;
          case 'rdblquote': addText('\u201d', tk.line); break;
          case 'bullet': addText('\u2022', tk.line); break;
          case 'u': {
            const cp = p < 0 ? p + 65536 : p;
            addText(String.fromCharCode(cp), tk.line);
            ucSkip = st.uc;
            break;
          }
          case 'uc': st.uc = p ?? 1; break;
          case 'f': st.font = p; break;
          case 'fs': st.fs = p; break;
          case 'b': st.bold = p !== 0; break;
          case 'i': st.italic = p !== 0; break;
          case 'plain': st.bold = false; st.italic = false; break;
          case 'pard': inTbl = false; break;
          case 'intbl': inTbl = true; break;
          case 'trowd': pendingCellx = []; curRow = { cells: [], cellx: pendingCellx }; lastRowFlag = false; break;
          case 'cellx': pendingCellx.push(p); break;
          case 'lastrow': lastRowFlag = true; break;
          case 'cell': endCell(); break;
          case 'row': endRow(lastRowFlag); break;
          default:
            if (['margl', 'margr', 'margt', 'margb', 'paperw', 'paperh', 'vieww', 'viewh', 'viewkind', 'cocoatextscaling', 'cocoaplatform'].includes(w)) header.other[w] = p;
            break;
        }
        break;
      }
      default:
        break;
    }
  }
  // trailing content without a final paragraph break
  if (cur.text !== '') { endTableIfOpen(); blocks.push({ kind: 'p', p: cur }); }
  endTableIfOpen();

  // ---- assign locators ------------------------------------------------------
  const paragraphs = [];
  const tables = [];
  const sequence = [];
  let pi = 0;
  let ti = 0;
  const fontName = (idx) => (idx === null || idx === undefined ? null : fonts[idx]?.name ?? null);
  const isMono = (idx) => /mono|courier|menlo/i.test(fontName(idx) ?? '');
  const mapRuns = (runs) => runs.map((r) => ({ text: r.text, bold: r.bold, italic: r.italic, font_index: r.font, font_name: fontName(r.font), monospace: isMono(r.font), font_size_half_points: r.fs }));
  for (const b of blocks) {
    if (b.kind === 'p') {
      pi++;
      const runs = mapRuns(b.p.runs);
      const visible = runs.filter((r) => r.text.trim() !== '');
      const maxFs = visible.reduce((m, r) => Math.max(m, r.font_size_half_points ?? 0), 0);
      const para = {
        locator: `P${pad(pi, 3)}`,
        source_line: b.p.line,
        text: b.p.text,
        all_bold: visible.length > 0 && visible.every((r) => r.bold || r.monospace) && visible.some((r) => r.bold),
        max_font_size_half_points: maxFs || null,
        runs,
      };
      paragraphs.push(para);
      sequence.push({ kind: 'paragraph', locator: para.locator });
    } else if (b.kind === 'table') {
      ti++;
      const tLoc = `T${pad(ti, 2)}`;
      const rows = b.table.rows.map((r, ri) => ({
        locator: `${tLoc}.R${pad(ri + 1, 2)}`,
        defined_cell_boundaries: r.defined_cell_boundaries,
        last_row_flag: r.last_row_flag,
        cells: r.cells.map((c, ci) => {
          const runs = mapRuns(c.runs);
          return {
            locator: `${tLoc}.R${pad(ri + 1, 2)}.C${pad(ci + 1, 2)}`,
            source_line: c.line,
            text: c.text,
            all_bold: runs.length > 0 && runs.every((x) => x.bold),
            runs,
          };
        }),
      }));
      const table = {
        locator: tLoc,
        preceding_paragraph_locator: paragraphs.at(-1)?.locator ?? null,
        row_count: rows.length,
        column_counts: [...new Set(rows.map((r) => r.cells.length))],
        first_row_all_bold: rows.length > 0 && rows[0].cells.every((c) => c.all_bold),
        rows,
      };
      tables.push(table);
      sequence.push({ kind: 'table', locator: tLoc });
    }
  }

  // heading inference from typography only (body size = most common paragraph size)
  const sizeCounts = {};
  for (const p of paragraphs) if (p.max_font_size_half_points) sizeCounts[p.max_font_size_half_points] = (sizeCounts[p.max_font_size_half_points] ?? 0) + 1;
  const bodySize = Number(Object.entries(sizeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0);
  const headingSizes = [...new Set(paragraphs.filter((p) => p.all_bold && p.max_font_size_half_points > bodySize).map((p) => p.max_font_size_half_points))].sort((a, b) => b - a);
  const stackH = [];
  for (const p of paragraphs) {
    const lvl = p.all_bold && p.max_font_size_half_points > bodySize ? headingSizes.indexOf(p.max_font_size_half_points) + 1 : null;
    p.inferred_heading_level = lvl;
    if (lvl) {
      while (stackH.length && stackH.at(-1).level >= lvl) stackH.pop();
      stackH.push({ level: lvl, text: p.text });
    }
    p.section_path = stackH.map((h) => h.text);
    const m = /^(\s*)(\u26ac|\u2022|\d+\.)\s+/.exec(p.text);
    p.list_marker = m ? { marker: m[2], leading_spaces: m[1].length } : null;
  }

  return {
    signature: head,
    header,
    body_font_size_half_points: bodySize || null,
    heading_inference: 'typographic only: paragraph entirely bold with a font size larger than the most common body size',
    fonts,
    info_group_present: tokens.some((t) => t.t === 'cw' && t.w === 'info'),
    info,
    control_word_counts: controlWordCounts,
    hyperlinks,
    empty_paragraph_count: emptyParagraphs,
    paragraphs,
    tables,
    sequence,
    token_count: tokens.length,
    code_page_used: codePage,
  };
}
