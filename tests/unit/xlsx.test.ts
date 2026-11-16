import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { defaultSourceRoot } from "../../src/importer/assemble.ts";
import { ORIGINAL_FILES } from "../../src/importer/candidate.ts";
import { OoxmlError } from "../../src/importer/readers/ooxml.ts";
import { readXlsx } from "../../src/importer/readers/xlsx.ts";
import { declareSize, sharedStringsXml, sheetXml, xlsx, zip } from "../helpers/ooxml.ts";
import { at } from "../helpers.ts";

const firstSheet = (bytes: Uint8Array) => at(readXlsx(bytes).sheets, 0);

describe("the supplied rows workbook reads as before the parser rewrite (pin)", () => {
  const book = readXlsx(readFileSync(join(defaultSourceRoot(), ORIGINAL_FILES.rowsXlsx)));
  const sheet = at(book.sheets, 0);

  test("workbook shape", () => {
    expect(book.sheets.map((s) => [s.name, s.state, s.dimension])).toEqual([["southwest_737_lopa_rows", "visible", "A1:J148"]]);
    expect(book.entries).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/app.xml",
      "docProps/core.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/sharedStrings.xml",
      "xl/styles.xml",
      "xl/theme/theme1.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    expect([book.hasMacros, book.hasExternalLinks]).toEqual([false, false]);
    expect(sheet.mergedCells).toEqual([]);
    expect(sheet.rows.length).toBe(148);
    expect(Math.max(...sheet.rows.map((r) => r.length))).toBe(10);
    expect(sheet.cells.length).toBe(1103);
    expect(sheet.cells.some((c) => c.hasFormula)).toBe(false);
  });

  test("first, second and last rows", () => {
    expect(sheet.rows[0]).toEqual([
      "lopa_id",
      "row_number",
      "row_exists",
      "active_seat_count",
      "omitted_seat_letters",
      "is_exit_row",
      "is_bulkhead_row",
      "recline_status",
      "recline_restriction_reason",
      "row_notes",
    ]);
    expect(sheet.rows[1]).toEqual([
      "73G",
      1,
      true,
      6,
      null,
      false,
      true,
      "Standard",
      null,
      "Dual-sided forward bulkhead; armrest tray tables; no underseat floor stowage",
    ]);
    expect(sheet.rows.at(-1)).toEqual([
      "7M8-2",
      30,
      true,
      4,
      "A,F",
      false,
      false,
      "None/Limited",
      "Aft lavatory bulkhead wall",
      "4-seat aft row (30B-30E); 2 window-side positions omitted adjacent to enlarged aft lavatory/galley",
    ]);
  });
});

describe("readXlsx on synthetic workbooks (IMP-05, IMP-06)", () => {
  test("a sparse row index beyond the sheet limit is refused quickly", () => {
    const bytes = xlsx(sheetXml('<row r="50000000"><c r="A50000000"><v>1</v></c></row>'));
    const started = performance.now();
    expect(() => readXlsx(bytes)).toThrow(OoxmlError);
    expect(performance.now() - started).toBeLessThan(100);
  });

  test("a column beyond the sheet limit is refused", () => {
    expect(() => readXlsx(xlsx(sheetXml('<row r="1"><c r="XFE1"><v>1</v></c></row>')))).toThrow(/column/);
  });

  test("a few cells spread over a grid larger than the cell limit are refused before the grid is filled", () => {
    const rows = Array.from({ length: 200 }, (_, i) => `<row r="${i + 1}"><c r="XFD${i + 1}"><v>1</v></c></row>`).join("");
    const started = performance.now();
    expect(() => readXlsx(xlsx(sheetXml(rows)))).toThrow(/spans more than 2000000 cells/);
    // generous bound: refusing must not wait for a 3-million-slot grid to be filled
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("a tiny archive of many empty rows is refused before it is parsed", () => {
    const bytes = xlsx(sheetXml("<row/>".repeat(300_000)));
    expect(bytes.length).toBeLessThan(100_000);
    expect(() => readXlsx(bytes)).toThrow(new OoxmlError("XML part has more than 250000 elements"));
  });

  test("an XML part above 8 MiB is refused before inflation", () => {
    const bytes = declareSize(xlsx(sheetXml("")), "xl/worksheets/sheet1.xml", 8 * 1024 * 1024 + 1);
    expect(() => readXlsx(bytes)).toThrow(new OoxmlError("entry too large: xl/worksheets/sheet1.xml"));
  });

  test("XML nested deeper than 100 elements is refused", () => {
    const deep = `<worksheet><sheetData>${"<x>".repeat(300)}${"</x>".repeat(300)}</sheetData></worksheet>`;
    expect(() => readXlsx(xlsx(deep))).toThrow(new OoxmlError("not well-formed XML: Maximum nested tags exceeded"));
  });

  test("an oversized unrelated entry is never inflated", () => {
    // junk.bin declares 40 MiB but holds 16 bytes: inflating it would fail the size check, so reading proves it was skipped
    const bytes = declareSize(xlsx(sheetXml('<row r="1"><c r="A1"><v>7</v></c></row>'), { "junk.bin": new Uint8Array(16) }), "junk.bin", 40 * 1024 * 1024);
    const book = readXlsx(bytes);
    expect(at(book.sheets, 0).rows).toEqual([[7]]);
    expect(book.entries).toContain("junk.bin");
  });

  test("an oversized wanted entry is refused", () => {
    const bytes = declareSize(xlsx(sheetXml('<row r="1"><c r="A1"><v>7</v></c></row>')), "xl/worksheets/sheet1.xml", 100 * 1024 * 1024);
    expect(() => readXlsx(bytes)).toThrow(new OoxmlError("entry too large: xl/worksheets/sheet1.xml"));
  });

  test("wanted entries above the archive total are refused", () => {
    // nine sheet parts, each at the XML part cap, together above the total cap
    const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const ids = Array.from({ length: 9 }, (_, i) => i + 1);
    let bytes = zip({
      "xl/workbook.xml": `<workbook xmlns="${main}" xmlns:r="${rel}"><sheets>${ids.map((i) => `<sheet name="S${i}" sheetId="${i}" r:id="rId${i}"/>`).join("")}</sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${ids.map((i) => `<Relationship Id="rId${i}" Type="${rel}/worksheet" Target="worksheets/s${i}.xml"/>`).join("")}</Relationships>`,
      ...Object.fromEntries(ids.map((i) => [`xl/worksheets/s${i}.xml`, sheetXml("")])),
    });
    for (const i of ids) bytes = declareSize(bytes, `xl/worksheets/s${i}.xml`, 8 * 1024 * 1024);
    expect(() => readXlsx(bytes)).toThrow(/^entry too large: xl\/worksheets\/s8\.xml \(wanted entries exceed/);
  });

  test("rows and cells without r take the next position", () => {
    const sheet = firstSheet(xlsx(sheetXml("<row><c><v>1</v></c><c><v>2</v></c><c><v>3</v></c></row>")));
    expect(sheet.rows).toEqual([[1, 2, 3]]);
    expect(sheet.cells.map((c) => c.ref)).toEqual(["A1", "B1", "C1"]);
  });

  test("a row without r follows the previous row; a cell without r follows the previous cell", () => {
    const sheet = firstSheet(xlsx(sheetXml('<row r="2"><c r="B2"><v>1</v></c><c><v>2</v></c></row><row><c><v>3</v></c></row>')));
    expect(sheet.rows).toEqual([[], [null, 1, 2], [3]]);
  });

  test("<si/> keeps later shared-string indexes aligned", () => {
    const strings = sharedStringsXml("<si><t>zero</t></si><si/><si><t>two</t></si>");
    const sheet = firstSheet(
      xlsx(sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'), {
        "xl/sharedStrings.xml": strings,
      }),
    );
    expect(sheet.rows).toEqual([["zero", "", "two"]]);
  });

  test("rich text joins runs; phonetic text is ignored", () => {
    const strings = sharedStringsXml(
      '<si><r><rPr><b/></rPr><t>Ext</t></r><r><t xml:space="preserve">ra </t></r><r><t>legroom</t></r><rPh sb="0" eb="1"><t>PHONETIC</t></rPh><phoneticPr fontId="1"/></si>',
    );
    const sheet = firstSheet(xlsx(sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c></row>'), { "xl/sharedStrings.xml": strings }));
    expect(sheet.rows).toEqual([["Extra legroom"]]);
  });

  test("inline strings, entities and _xHHHH_ escapes are decoded", () => {
    const strings = sharedStringsXml("<si><t>Tab_x0009_here _x005F_x0041_ A &amp; B</t></si>");
    const sheet = firstSheet(
      xlsx(sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><r><t>in</t></r><r><t>line &#8211;</t></r></is></c></row>'), {
        "xl/sharedStrings.xml": strings,
      }),
    );
    expect(sheet.rows).toEqual([["Tab\there _x0041_ A & B", "inline –"]]);
  });

  test("prefixed elements and relative relationship targets are read", () => {
    const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const bytes = zip({
      "xl/workbook.xml": `<x:workbook xmlns:x="${main}" xmlns:r="${rel}"><x:sheets><x:sheet name="Rows &amp; seats" sheetId="1" r:id="rId7"/></x:sheets></x:workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="${rel}/worksheet" Target="./parts/../sheets/data.xml"/></Relationships>`,
      "xl/sheets/data.xml": `<x:worksheet xmlns:x="${main}"><x:dimension ref="A1:B1"/><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>a</x:t></x:is></x:c><x:c r="B1"><x:v>2</x:v></x:c></x:row></x:sheetData><x:mergeCells count="1"><x:mergeCell ref="A1:B1"/></x:mergeCells></x:worksheet>`,
    });
    const sheet = firstSheet(bytes);
    expect([sheet.name, sheet.dimension, sheet.mergedCells, sheet.rows]).toEqual(["Rows & seats", "A1:B1", ["A1:B1"], [["a", 2]]]);
  });

  test("an absolute relationship target is read from the package root", () => {
    const bytes = xlsx(sheetXml(""), {
      "xl/_rels/workbook.xml.rels":
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="/other/s.xml"/></Relationships>',
      "other/s.xml": sheetXml('<row r="1"><c r="A1"><v>5</v></c></row>'),
    });
    expect(firstSheet(bytes).rows).toEqual([[5]]);
  });

  test("lowercase and absolute cell references resolve", () => {
    const sheet = firstSheet(xlsx(sheetXml('<row r="1"><c r="b1"><v>1</v></c><c r="$D$1"><v>2</v></c></row>')));
    expect(sheet.rows).toEqual([[null, 1, null, 2]]);
  });

  test("a cell reference outside its row is refused", () => {
    expect(() => readXlsx(xlsx(sheetXml('<row r="1"><c r="A2"><v>1</v></c></row>')))).toThrow(OoxmlError);
  });

  test("a date-typed cell is refused with its reference", () => {
    expect(() => readXlsx(xlsx(sheetXml('<row r="3"><c r="C3" t="d"><v>2026-01-01</v></c></row>')))).toThrow(new OoxmlError("unsupported cell type d at C3"));
  });

  test("an unknown cell type is refused with its reference", () => {
    expect(() => readXlsx(xlsx(sheetXml('<row r="1"><c r="A1" t="q"><v>1</v></c></row>')))).toThrow(/unsupported cell type q at A1/);
  });

  test("a formula without a cached value is refused; one with a cached value is read", () => {
    expect(() => readXlsx(xlsx(sheetXml('<row r="1"><c r="A1"><f>1+1</f></c></row>')))).toThrow(/unsupported cell type n at A1/);
    const sheet = firstSheet(xlsx(sheetXml('<row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row>')));
    expect([sheet.rows, sheet.cells.map((c) => c.hasFormula)]).toEqual([[[2]], [true]]);
  });

  test("not a zip → OoxmlError", () => {
    expect(() => readXlsx(new TextEncoder().encode("lopa_id,row_number\n73G,1\n"))).toThrow(OoxmlError);
    expect(() => readXlsx(new Uint8Array(0))).toThrow(OoxmlError);
  });

  test("malformed XML and document type declarations are refused", () => {
    expect(() => readXlsx(xlsx("<worksheet><sheetData><row></sheetData>"))).toThrow(OoxmlError);
    const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><worksheet><sheetData><row r="1"><c r="A1" t="str"><v>&lol2;</v></c></row></sheetData></worksheet>`;
    expect(() => readXlsx(xlsx(laughs))).toThrow(OoxmlError);
  });
});
