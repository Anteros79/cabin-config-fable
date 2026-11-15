// OOXML packages are read strictly as ZIP + XML. Nothing is executed:
// formulas are reported as text, macros/external links are only detected by presence.
import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { decodeXmlEntities } from './common.mjs';

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  ignoreDeclaration: true,
});

export function openZip(buf) {
  const files = unzipSync(new Uint8Array(buf));
  const entries = Object.keys(files).map((name) => ({ name, size: files[name].length }));
  return {
    entries,
    has: (name) => Object.prototype.hasOwnProperty.call(files, name),
    text: (name) => (Object.prototype.hasOwnProperty.call(files, name) ? strFromU8(files[name]) : null),
    names: () => Object.keys(files),
  };
}

// ---- tiny ordered-XML tree helpers ----------------------------------------
// Node shape: { tag, attrs, children: Node[], text?: string }

function convert(list) {
  const out = [];
  for (const item of list) {
    const attrsRaw = item[':@'] ?? {};
    for (const key of Object.keys(item)) {
      if (key === ':@') continue;
      if (key === '#text') {
        out.push({ tag: '#text', attrs: {}, children: [], text: decodeXmlEntities(String(item[key])) });
      } else {
        const attrs = {};
        for (const [k, v] of Object.entries(attrsRaw)) attrs[k] = decodeXmlEntities(String(v));
        out.push({ tag: key, attrs, children: convert(Array.isArray(item[key]) ? item[key] : []) });
      }
    }
  }
  return out;
}

export function parseXml(xml) {
  if (xml === null || xml === undefined) return null;
  const nodes = convert(parser.parse(xml));
  return nodes.find((n) => n.tag !== '#text') ?? null;
}

export const kids = (node, tag) => (node ? node.children.filter((c) => c.tag === tag) : []);
export const kid = (node, tag) => (node ? node.children.find((c) => c.tag === tag) ?? null : null);
export function textOf(node) {
  if (!node) return '';
  if (node.tag === '#text') return node.text;
  return node.children.map(textOf).join('');
}
export function walk(node, fn) {
  if (!node) return;
  fn(node);
  for (const c of node.children) walk(c, fn);
}
export function findAll(node, tag) {
  const out = [];
  walk(node, (n) => { if (n.tag === tag) out.push(n); });
  return out;
}

export function parseRels(xml) {
  const root = parseXml(xml);
  return kids(root, 'Relationship').map((r) => ({
    id: r.attrs.Id,
    type: r.attrs.Type,
    type_short: (r.attrs.Type ?? '').split('/').pop(),
    target: r.attrs.Target,
    target_mode: r.attrs.TargetMode ?? 'Internal',
  }));
}

export function parseCoreProps(xml) {
  const root = parseXml(xml);
  if (!root) return null;
  const out = {};
  for (const c of root.children) if (c.tag !== '#text') out[c.tag] = textOf(c);
  return out;
}

export function parseAppProps(xml) {
  const root = parseXml(xml);
  if (!root) return null;
  const out = {};
  for (const c of root.children) {
    if (c.tag === '#text') continue;
    const hasElementChildren = c.children.some((x) => x.tag !== '#text');
    out[c.tag] = hasElementChildren ? findAll(c, 'vt:lpstr').map(textOf).concat(findAll(c, 'vt:i4').map(textOf)) : textOf(c);
  }
  return out;
}

export function parseContentTypes(xml) {
  const root = parseXml(xml);
  return {
    defaults: kids(root, 'Default').map((d) => ({ extension: d.attrs.Extension, content_type: d.attrs.ContentType })),
    overrides: kids(root, 'Override').map((d) => ({ part: d.attrs.PartName, content_type: d.attrs.ContentType })),
  };
}

// ---- XLSX ------------------------------------------------------------------

function colLetters(ref) {
  return ref.replace(/[0-9$]/g, '');
}
function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

const BUILTIN_NUMFMT = { 0: 'General', 1: '0', 2: '0.00', 9: '0%', 14: 'mm-dd-yy', 49: '@' };

export function parseXlsx(buf) {
  const zip = openZip(buf);
  const names = zip.names();
  const contentTypes = parseContentTypes(zip.text('[Content_Types].xml'));
  const wbXml = zip.text('xl/workbook.xml');
  const wb = parseXml(wbXml);
  const wbRels = parseRels(zip.text('xl/_rels/workbook.xml.rels'));

  // shared strings (rich text runs concatenated, phonetic runs ignored)
  const sst = parseXml(zip.text('xl/sharedStrings.xml'));
  const sharedStrings = kids(sst, 'si').map((si) => {
    const parts = [];
    for (const c of si.children) {
      if (c.tag === 't') parts.push(textOf(c));
      else if (c.tag === 'r') parts.push(kids(c, 't').map(textOf).join(''));
    }
    return parts.join('');
  });

  // styles: cellXfs -> numFmtId
  const styles = parseXml(zip.text('xl/styles.xml'));
  const customFmts = {};
  for (const nf of findAll(kid(styles, 'numFmts'), 'numFmt')) customFmts[nf.attrs.numFmtId] = nf.attrs.formatCode;
  const cellXfs = kids(kid(styles, 'cellXfs'), 'xf').map((xf) => xf.attrs.numFmtId ?? '0');
  const fmtOf = (s) => {
    const id = cellXfs[Number(s ?? 0)] ?? '0';
    return { num_fmt_id: Number(id), format_code: customFmts[id] ?? BUILTIN_NUMFMT[id] ?? `builtin:${id}` };
  };

  const sheetsNode = kid(wb, 'sheets');
  const sheets = kids(sheetsNode, 'sheet').map((s, order) => {
    const rel = wbRels.find((r) => r.id === s.attrs['r:id']);
    const part = rel ? 'xl/' + rel.target.replace(/^\/?xl\//, '').replace(/^\//, '') : null;
    const ws = parseXml(zip.text(part));
    const sheetData = kid(ws, 'sheetData');
    const cells = [];
    const rowMeta = [];
    for (const row of kids(sheetData, 'row')) {
      rowMeta.push({ r: Number(row.attrs.r), hidden: row.attrs.hidden === '1', spans: row.attrs.spans ?? null });
      for (const c of kids(row, 'c')) {
        const ref = c.attrs.r;
        const t = c.attrs.t ?? 'n';
        const vNode = kid(c, 'v');
        const fNode = kid(c, 'f');
        const isNode = kid(c, 'is');
        const rawV = vNode ? textOf(vNode) : null;
        let value = null;
        let valueType;
        if (t === 's') { value = sharedStrings[Number(rawV)]; valueType = 'shared-string'; }
        else if (t === 'inlineStr') { value = isNode ? findAll(isNode, 't').map(textOf).join('') : ''; valueType = 'inline-string'; }
        else if (t === 'str') { value = rawV; valueType = 'formula-string'; }
        else if (t === 'b') { value = rawV === '1'; valueType = 'boolean'; }
        else if (t === 'e') { value = rawV; valueType = 'error'; }
        else if (t === 'd') { value = rawV; valueType = 'iso-date'; }
        else { value = rawV === null ? null : Number(rawV); valueType = rawV === null ? 'empty-styled' : 'number'; }
        const cell = {
          locator: `${s.attrs.name}!${ref}`,
          ref,
          column: colLetters(ref),
          row: Number(ref.replace(/[A-Z$]/g, '')),
          raw_type: t,
          value_type: valueType,
          raw_v: rawV,
          value,
          style_index: c.attrs.s === undefined ? null : Number(c.attrs.s),
          number_format: fmtOf(c.attrs.s),
        };
        if (t === 's') cell.shared_string_index = Number(rawV);
        if (fNode) {
          cell.formula = textOf(fNode);
          cell.formula_attrs = fNode.attrs;
          cell.cached_value = rawV;
        }
        cells.push(cell);
      }
    }
    const merges = kids(kid(ws, 'mergeCells'), 'mergeCell').map((m) => m.attrs.ref);
    const cols = kids(kid(ws, 'cols'), 'col').map((c) => ({ min: Number(c.attrs.min), max: Number(c.attrs.max), hidden: c.attrs.hidden === '1', width: c.attrs.width ?? null }));
    const dim = kid(ws, 'dimension');
    const usedCols = [...new Set(cells.map((c) => c.column))].sort((a, b) => colIndex(a) - colIndex(b));
    return {
      order,
      name: s.attrs.name,
      sheet_id: s.attrs.sheetId,
      rel_id: s.attrs['r:id'],
      part,
      state: s.attrs.state ?? 'visible',
      dimension: dim ? dim.attrs.ref : null,
      row_element_count: rowMeta.length,
      hidden_rows: rowMeta.filter((r) => r.hidden).map((r) => r.r),
      hidden_columns: cols.filter((c) => c.hidden),
      column_definitions: cols,
      columns_used: usedCols,
      merged_cells: merges,
      cell_count: cells.length,
      formula_cell_count: cells.filter((c) => c.formula !== undefined).length,
      formulas: cells.filter((c) => c.formula !== undefined).map((c) => ({ locator: c.locator, formula: c.formula, cached_value: c.cached_value })),
      cell_type_counts: cells.reduce((m, c) => { m[c.value_type] = (m[c.value_type] ?? 0) + 1; return m; }, {}),
      data_validations: findAll(ws, 'dataValidation').length,
      conditional_formats: findAll(ws, 'conditionalFormatting').length,
      hyperlinks: findAll(ws, 'hyperlink').length,
      has_legacy_drawing_or_comments: findAll(ws, 'legacyDrawing').length > 0,
      table_parts: findAll(ws, 'tablePart').length,
      auto_filter: kid(ws, 'autoFilter') ? kid(ws, 'autoFilter').attrs.ref : null,
      sheet_protection: kid(ws, 'sheetProtection') !== null,
      cells,
    };
  });

  const definedNames = kids(kid(wb, 'definedNames'), 'definedName').map((d) => ({ name: d.attrs.name, hidden: d.attrs.hidden === '1', local_sheet_id: d.attrs.localSheetId ?? null, refers_to: textOf(d) }));
  const externalRefs = kids(kid(wb, 'externalReferences'), 'externalReference').map((e) => e.attrs['r:id']);
  const calcPr = kid(wb, 'calcPr');
  const absPath = findAll(wb, 'x15ac:absPath')[0];
  const fileVersion = kid(wb, 'fileVersion');

  return {
    zip_entries: zip.entries,
    content_types: contentTypes,
    core_properties: parseCoreProps(zip.text('docProps/core.xml')),
    app_properties: parseAppProps(zip.text('docProps/app.xml')),
    custom_properties_part: zip.has('docProps/custom.xml'),
    file_version: fileVersion ? fileVersion.attrs : null,
    authoring_path_recorded_in_workbook: absPath ? absPath.attrs.url : null,
    calc_properties: calcPr ? calcPr.attrs : null,
    workbook_relationships: wbRels,
    defined_names: definedNames,
    external_links: {
      external_reference_ids: externalRefs,
      external_link_parts: names.filter((n) => n.startsWith('xl/externalLinks/')),
      external_relationships: wbRels.filter((r) => r.target_mode === 'External'),
      connections_part: zip.has('xl/connections.xml'),
      query_tables: names.filter((n) => n.startsWith('xl/queryTables/')),
    },
    macros: {
      vba_project_present: names.some((n) => /vbaProject\.bin$/i.test(n)),
      macro_enabled_content_type: [...contentTypes.overrides, ...contentTypes.defaults].some((o) => /macroEnabled|vbaProject/i.test(o.content_type)),
      macrosheets: names.filter((n) => n.startsWith('xl/macrosheets/')),
      activex_or_embeddings: names.filter((n) => /^xl\/(activeX|embeddings|ctrlProps)\//.test(n)),
    },
    other_parts: {
      drawings: names.filter((n) => n.startsWith('xl/drawings/')),
      media: names.filter((n) => n.startsWith('xl/media/')),
      comments: names.filter((n) => /^xl\/comments/.test(n)),
      pivot: names.filter((n) => n.startsWith('xl/pivot')),
      custom_xml: names.filter((n) => n.startsWith('customXml/')),
    },
    shared_strings: {
      declared_count: sst ? Number(sst.attrs.count ?? NaN) : null,
      declared_unique_count: sst ? Number(sst.attrs.uniqueCount ?? NaN) : null,
      parsed_unique_count: sharedStrings.length,
      values: sharedStrings,
    },
    sheets,
  };
}
