// DOCX reader: ZIP + XML only. Produces located paragraphs, tables, hyperlinks and metadata.
import { openZip, parseXml, parseRels, parseCoreProps, parseAppProps, parseContentTypes, kids, kid, textOf, findAll } from './ooxml.mjs';
import { pad } from './common.mjs';

function styleCatalog(stylesXml) {
  const root = parseXml(stylesXml);
  const map = new Map();
  for (const st of kids(root, 'w:style')) {
    const id = st.attrs['w:styleId'];
    const name = kid(st, 'w:name')?.attrs['w:val'] ?? null;
    const basedOn = kid(st, 'w:basedOn')?.attrs['w:val'] ?? null;
    const outline = kid(kid(st, 'w:pPr'), 'w:outlineLvl')?.attrs['w:val'];
    map.set(id, { id, type: st.attrs['w:type'], name, based_on: basedOn, outline_level: outline === undefined ? null : Number(outline) });
  }
  return map;
}

function headingLevel(styles, styleId) {
  let cur = styleId ? styles.get(styleId) : null;
  for (let guard = 0; cur && guard < 10; guard++) {
    if (cur.outline_level !== null && cur.outline_level < 9) return cur.outline_level + 1;
    const m = /^heading (\d)$/i.exec(cur.name ?? '');
    if (m) return Number(m[1]);
    cur = cur.based_on ? styles.get(cur.based_on) : null;
  }
  return null;
}

function numberingCatalog(xml) {
  const root = parseXml(xml);
  const abstract = new Map();
  for (const a of kids(root, 'w:abstractNum')) {
    const lvls = {};
    for (const l of kids(a, 'w:lvl')) {
      lvls[l.attrs['w:ilvl']] = { num_fmt: kid(l, 'w:numFmt')?.attrs['w:val'] ?? null, lvl_text: kid(l, 'w:lvlText')?.attrs['w:val'] ?? null };
    }
    abstract.set(a.attrs['w:abstractNumId'], lvls);
  }
  const nums = new Map();
  for (const n of kids(root, 'w:num')) nums.set(n.attrs['w:numId'], kid(n, 'w:abstractNumId')?.attrs['w:val']);
  return (numId, ilvl) => abstract.get(nums.get(numId))?.[ilvl] ?? null;
}

export function parseDocx(buf) {
  const zip = openZip(buf);
  const names = zip.names();
  const doc = parseXml(zip.text('word/document.xml'));
  const rels = parseRels(zip.text('word/_rels/document.xml.rels'));
  const relById = new Map(rels.map((r) => [r.id, r]));
  const styles = styleCatalog(zip.text('word/styles.xml'));
  const numLookup = zip.has('word/numbering.xml') ? numberingCatalog(zip.text('word/numbering.xml')) : () => null;

  const paragraphs = [];
  const tables = [];
  const hyperlinks = [];
  const stats = { deleted_runs: 0, inserted_runs: 0, field_instructions: [], drawings: 0, pictures: 0, objects: 0, comments_refs: 0, footnote_refs: 0, sdt_blocks: 0 };

  function readRuns(node, state) {
    // state: { text, runs, linkStack }
    for (const c of node.children) {
      switch (c.tag) {
        case 'w:r': {
          const rPr = kid(c, 'w:rPr');
          const fmt = {
            bold: !!kid(rPr, 'w:b') && kid(rPr, 'w:b').attrs['w:val'] !== '0',
            italic: !!kid(rPr, 'w:i') && kid(rPr, 'w:i').attrs['w:val'] !== '0',
            run_style: kid(rPr, 'w:rStyle')?.attrs['w:val'] ?? null,
          };
          let t = '';
          for (const x of c.children) {
            if (x.tag === 'w:t') t += textOf(x);
            else if (x.tag === 'w:tab') t += '\t';
            else if (x.tag === 'w:br' || x.tag === 'w:cr') t += '\n';
            else if (x.tag === 'w:noBreakHyphen') t += '\u2011';
            else if (x.tag === 'w:softHyphen') t += '\u00ad';
            else if (x.tag === 'w:sym') t += `[sym ${x.attrs['w:font'] ?? ''}:${x.attrs['w:char'] ?? ''}]`;
            else if (x.tag === 'w:instrText') stats.field_instructions.push(textOf(x));
            else if (x.tag === 'w:delText') stats.deleted_runs++;
            else if (x.tag === 'w:drawing') stats.drawings++;
            else if (x.tag === 'w:pict') stats.pictures++;
            else if (x.tag === 'w:object') stats.objects++;
            else if (x.tag === 'w:commentReference') stats.comments_refs++;
            else if (x.tag === 'w:footnoteReference' || x.tag === 'w:endnoteReference') stats.footnote_refs++;
          }
          if (t !== '') {
            state.runs.push({ text: t, ...fmt, hyperlink_rel_id: state.link ? state.link.rel_id : null });
            if (state.link) state.link.anchor_text += t;
            state.text += t;
          }
          break;
        }
        case 'w:hyperlink': {
          const relId = c.attrs['r:id'] ?? null;
          const rel = relId ? relById.get(relId) : null;
          const link = {
            rel_id: relId,
            anchor: c.attrs['w:anchor'] ?? null,
            target: rel ? rel.target : null,
            target_mode: rel ? rel.target_mode : null,
            anchor_text: '',
            char_offset_in_paragraph: state.text.length,
          };
          const prev = state.link;
          state.link = link;
          readRuns(c, state);
          state.link = prev;
          state.links.push(link);
          break;
        }
        case 'w:ins':
          stats.inserted_runs++;
          readRuns(c, state);
          break;
        case 'w:del':
          stats.deleted_runs++;
          break;
        case 'w:smartTag':
        case 'w:sdt':
        case 'w:sdtContent':
        case 'w:fldSimple':
          if (c.tag === 'w:fldSimple') stats.field_instructions.push(c.attrs['w:instr'] ?? '');
          readRuns(c, state);
          break;
        default:
          break;
      }
    }
  }

  function readParagraph(p, locator, context) {
    const pPr = kid(p, 'w:pPr');
    const styleId = kid(pPr, 'w:pStyle')?.attrs['w:val'] ?? null;
    const numPr = kid(pPr, 'w:numPr');
    const numId = kid(numPr, 'w:numId')?.attrs['w:val'] ?? null;
    const ilvl = kid(numPr, 'w:ilvl')?.attrs['w:val'] ?? null;
    const state = { text: '', runs: [], links: [], link: null };
    readRuns(p, state);
    const style = styleId ? styles.get(styleId) : null;
    const para = {
      locator,
      context,
      para_id: p.attrs['w14:paraId'] ?? null,
      style_id: styleId,
      style_name: style ? style.name : null,
      heading_level: headingLevel(styles, styleId),
      list: numId === null ? null : { num_id: numId, level: Number(ilvl ?? 0), ...(numLookup(numId, ilvl ?? '0') ?? {}) },
      text: state.text,
      runs: state.runs,
      hyperlink_count: state.links.length,
    };
    for (const l of state.links) hyperlinks.push({ ...l, paragraph_locator: locator });
    return para;
  }

  function readTable(tbl, tIndex) {
    const tLoc = `T${pad(tIndex, 2)}`;
    const table = {
      locator: tLoc,
      style: kid(kid(tbl, 'w:tblPr'), 'w:tblStyle')?.attrs['w:val'] ?? null,
      grid_columns: kids(kid(tbl, 'w:tblGrid'), 'w:gridCol').length,
      first_row_is_header_style: kid(kid(tbl, 'w:tblPr'), 'w:tblLook')?.attrs['w:firstRow'] === '1',
      preceding_paragraph_locator: paragraphs.filter((p) => p.context === 'body').at(-1)?.locator ?? null,
      rows: [],
    };
    let r = 0;
    for (const tr of kids(tbl, 'w:tr')) {
      r++;
      const row = { locator: `${tLoc}.R${pad(r, 2)}`, is_header: !!kid(kid(tr, 'w:trPr'), 'w:tblHeader') || (r === 1 && table.first_row_is_header_style), cells: [] };
      let c = 0;
      for (const tc of kids(tr, 'w:tc')) {
        c++;
        const cLoc = `${row.locator}.C${pad(c, 2)}`;
        const tcPr = kid(tc, 'w:tcPr');
        const cellParas = kids(tc, 'w:p').map((p, i) => readParagraph(p, `${cLoc}.P${i + 1}`, 'table-cell'));
        for (const cp of cellParas) paragraphs.push(cp);
        row.cells.push({
          locator: cLoc,
          grid_span: Number(kid(tcPr, 'w:gridSpan')?.attrs['w:val'] ?? 1),
          v_merge: kid(tcPr, 'w:vMerge') ? kid(tcPr, 'w:vMerge').attrs['w:val'] ?? 'continue' : null,
          nested_tables: kids(tc, 'w:tbl').length,
          text: cellParas.map((p) => p.text).join('\n'),
          paragraph_locators: cellParas.map((p) => p.locator),
        });
      }
      table.rows.push(row);
    }
    table.row_count = table.rows.length;
    table.column_counts = [...new Set(table.rows.map((x) => x.cells.length))];
    return table;
  }

  const body = kid(doc, 'w:body');
  let pIndex = 0;
  let tIndex = 0;
  let sectPr = null;
  (function readBlocks(container) {
    for (const blk of container.children) {
      if (blk.tag === 'w:p') {
        pIndex++;
        paragraphs.push(readParagraph(blk, `P${pad(pIndex, 3)}`, 'body'));
      } else if (blk.tag === 'w:tbl') {
        tIndex++;
        tables.push(readTable(blk, tIndex));
      } else if (blk.tag === 'w:sdt') {
        stats.sdt_blocks++;
        const content = kid(blk, 'w:sdtContent');
        if (content) readBlocks(content);
      } else if (blk.tag === 'w:sectPr') {
        sectPr = blk;
      }
    }
  })(body);

  // section heading path for body paragraphs
  const headingStack = [];
  for (const p of paragraphs.filter((x) => x.context === 'body')) {
    if (p.heading_level) {
      while (headingStack.length && headingStack.at(-1).level >= p.heading_level) headingStack.pop();
      headingStack.push({ level: p.heading_level, text: p.text });
    }
    p.section_path = headingStack.map((h) => h.text);
  }

  const settings = parseXml(zip.text('word/settings.xml'));
  const labelInfo = parseXml(zip.text('docMetadata/LabelInfo.xml'));
  const pgSz = kid(sectPr, 'w:pgSz');
  const hyperlinkRels = rels.filter((r) => r.type_short === 'hyperlink');
  const usedRelIds = new Set(hyperlinks.map((h) => h.rel_id));

  return {
    zip_entries: zip.entries,
    content_types: parseContentTypes(zip.text('[Content_Types].xml')),
    core_properties: parseCoreProps(zip.text('docProps/core.xml')),
    app_properties: parseAppProps(zip.text('docProps/app.xml')),
    custom_properties_part: zip.has('docProps/custom.xml'),
    sensitivity_labels: labelInfo
      ? findAll(labelInfo, 'clbl:label').map((l) => ({ ...l.attrs }))
      : [],
    settings: settings
      ? {
          w14_doc_id: findAll(settings, 'w14:docId')[0]?.attrs['w14:val'] ?? null,
          w15_doc_id: findAll(settings, 'w15:docId')[0]?.attrs['w15:val'] ?? null,
          rsid_root: findAll(settings, 'w:rsidRoot')[0]?.attrs['w:val'] ?? null,
          rsids: findAll(settings, 'w:rsid').map((r) => r.attrs['w:val']),
          track_revisions: findAll(settings, 'w:trackRevisions').length > 0,
          document_protection: findAll(settings, 'w:documentProtection').length > 0,
          theme_font_lang: findAll(settings, 'w:themeFontLang')[0]?.attrs['w:val'] ?? null,
        }
      : null,
    page: pgSz ? { width_twips: Number(pgSz.attrs['w:w']), height_twips: Number(pgSz.attrs['w:h']) } : null,
    relationships: rels,
    hyperlink_relationship_count: hyperlinkRels.length,
    unused_hyperlink_relationships: hyperlinkRels.filter((r) => !usedRelIds.has(r.id)).map((r) => r.id),
    embedded_media: {
      media_parts: names.filter((n) => n.startsWith('word/media/')),
      embedding_parts: names.filter((n) => n.startsWith('word/embeddings/')),
      image_relationships: rels.filter((r) => r.type_short === 'image').length,
      drawing_elements: stats.drawings,
      vml_pict_elements: stats.pictures,
      ole_object_elements: stats.objects,
    },
    macros: {
      vba_project_present: names.some((n) => /vbaProject\.bin$/i.test(n)),
      macro_enabled_content_type: zip.text('[Content_Types].xml').includes('macroEnabled'),
    },
    other_parts: {
      comments: names.filter((n) => /^word\/comments/.test(n)),
      footnotes_endnotes: names.filter((n) => /^word\/(footnotes|endnotes)\.xml$/.test(n)),
      headers_footers: names.filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n)),
      custom_xml: names.filter((n) => n.startsWith('customXml/')),
    },
    tracked_changes: { inserted: stats.inserted_runs, deleted: stats.deleted_runs },
    field_instructions: stats.field_instructions,
    paragraphs,
    tables,
    hyperlinks,
  };
}
