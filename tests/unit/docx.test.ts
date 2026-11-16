import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { defaultSourceRoot } from "../../src/importer/assemble.ts";
import { ORIGINAL_FILES } from "../../src/importer/candidate.ts";
import { readDocxParagraphs } from "../../src/importer/readers/docx.ts";
import { OoxmlError } from "../../src/importer/readers/ooxml.ts";
import { declareSize, docx, para, zip } from "../helpers/ooxml.ts";
import { at } from "../helpers.ts";

const texts = (bytes: Uint8Array) => readDocxParagraphs(bytes).map((p) => [p.locator, p.text]);

describe("the supplied DOCX reads as before the parser rewrite (pin)", () => {
  const paragraphs = readDocxParagraphs(readFileSync(join(defaultSourceRoot(), ORIGINAL_FILES.docx)));

  test("paragraph count and sample paragraphs", () => {
    expect(paragraphs.length).toBe(67);
    expect(paragraphs.map((p) => p.locator)).toEqual(Array.from({ length: 67 }, (_, i) => `P${String(i + 1).padStart(3, "0")}`));
    expect(at(paragraphs, 0).text).toBe("Current Southwest seat configurations");
    expect(at(paragraphs, 29).text).toBe("34 in.");
    expect(at(paragraphs, 66).text).toBe(
      "The 737 MAX 7 is not yet a current revenue configuration. Recent Tech Ops communication identifies a planned 150-passenger ELR/RECARO layout, with initial revenue service targeted for 2027 and dates subject to change. Know Before Fix | 737 MAX-7 vs MAX-8 Differences [Know Befor...ifferences | Outlook]",
    );
  });
});

describe("readDocxParagraphs on synthetic documents (IMP-05, IMP-06)", () => {
  test("self-closing paragraphs are counted", () => {
    expect(texts(docx(`${para("P001 text")}<w:p/>${para("P003 text")}`))).toEqual([
      ["P001", "P001 text"],
      ["P002", ""],
      ["P003", "P003 text"],
    ]);
  });

  test("a text box paragraph does not truncate its parent", () => {
    const box = `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx><w:txbxContent>${para("inner")}</w:txbxContent></wps:txbx></wps:wsp></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent>${para("inner")}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>`;
    const body = `<w:p><w:r><w:t>outer-a </w:t></w:r>${box}<w:r><w:t>outer-b</w:t></w:r></w:p>${para("after")}`;
    expect(texts(docx(body))).toEqual([
      ["P001", "outer-a outer-b"],
      ["P002", "inner"],
      ["P003", "after"],
    ]);
  });

  test("AlternateContent text appears once", () => {
    const body = `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="w14"><w:t>once</w:t></mc:Choice><mc:Fallback><w:t>once</w:t></mc:Fallback></mc:AlternateContent></w:r></w:p>`;
    expect(texts(docx(body))).toEqual([["P001", "once"]]);
  });

  test("table cells, hyperlinks, tabs, breaks and no-break hyphens; deleted text and tab stops excluded", () => {
    const body =
      '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t><w:noBreakHyphen/><w:t>d</w:t></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:hyperlink><w:r><w:t xml:space="preserve"> link &amp; more</w:t></w:r></w:hyperlink></w:p>' +
      `<w:tbl><w:tr><w:tc>${para("cell 1")}</w:tc><w:tc>${para("cell 2")}<w:p/></w:tc></w:tr></w:tbl>`;
    expect(texts(docx(body))).toEqual([
      ["P001", "a b c-d link & more"],
      ["P002", "cell 1"],
      ["P003", "cell 2"],
      ["P004", ""],
    ]);
  });

  test("a tiny archive of many empty paragraphs is refused before it is parsed", () => {
    const bytes = docx("<w:p/>".repeat(120_000));
    expect(bytes.length).toBeLessThan(100_000);
    expect(() => readDocxParagraphs(bytes)).toThrow(new OoxmlError("XML part has more than 100000 elements"));
  });

  test("missing word/document.xml → OoxmlError", () => {
    expect(() => readDocxParagraphs(zip({ "word/other.xml": "<x/>" }))).toThrow(OoxmlError);
  });

  test("not a zip, an oversized document part and a document type declaration → OoxmlError", () => {
    expect(() => readDocxParagraphs(new TextEncoder().encode("plain text"))).toThrow(OoxmlError);
    expect(() => readDocxParagraphs(declareSize(docx(para("x")), "word/document.xml", 64 * 1024 * 1024))).toThrow("entry too large: word/document.xml");
    const doctype = zip({
      "word/document.xml": '<!DOCTYPE d [<!ENTITY e "x">]><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>&e;</w:t></w:r></w:p></w:body></w:document>',
    });
    expect(() => readDocxParagraphs(doctype)).toThrow(OoxmlError);
  });
});
