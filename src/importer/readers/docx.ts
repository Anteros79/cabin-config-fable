import { strFromU8 } from "fflate";
import { element, elements, OoxmlError, ownText, parseXmlRoot, readZipEntries, type XmlElement } from "./ooxml.ts";

export interface DocxParagraph {
  locator: string;
  text: string;
}

const DOCUMENT = "word/document.xml";

/** The read branch of an `mc:AlternateContent`: its first `mc:Choice`, never the fallback. */
const choiceOf = (alternate: XmlElement) => element(alternate, "Choice");

/** Append the text of every paragraph under a block container (body, table, cell, content control, text box) in document order. */
function readBlocks(container: XmlElement, out: string[]): void {
  for (const child of elements(container)) {
    if (child.name === "p") readParagraph(child, out);
    else if (child.name === "AlternateContent") {
      const choice = choiceOf(child);
      if (choice !== undefined) readBlocks(choice, out);
    } else readBlocks(child, out);
  }
}

/** Append one paragraph's text, then the paragraphs of any text box it contains, each as its own paragraph. */
function readParagraph(paragraph: XmlElement, out: string[]): void {
  const at = out.length;
  out.push("");
  const textBoxes: XmlElement[] = [];
  let text = "";
  const walk = (el: XmlElement): void => {
    for (const child of elements(el)) {
      switch (child.name) {
        case "t":
          text += ownText(child);
          break;
        case "tab":
        case "br":
          text += " ";
          break;
        case "noBreakHyphen":
          text += "-";
          break;
        // properties (tab stops live in pPr) and deleted text carry no paragraph text
        case "pPr":
        case "rPr":
        case "delText":
          break;
        case "txbxContent":
          textBoxes.push(child);
          break;
        case "AlternateContent": {
          const choice = choiceOf(child);
          if (choice !== undefined) walk(choice);
          break;
        }
        default:
          walk(child);
      }
    }
  };
  walk(paragraph);
  out[at] = text;
  for (const box of textBoxes) readBlocks(box, out);
}

/**
 * Paragraph text of a DOCX in document order: every `w:p` under the body or a table cell counts once
 * (self-closing ones included); text-box paragraphs follow the paragraph that holds them. Only
 * `word/document.xml` is inflated, under the OOXML_LIMITS caps.
 */
export function readDocxParagraphs(bytes: Uint8Array): DocxParagraph[] {
  const xml = readZipEntries(bytes, (name) => name === DOCUMENT).get(DOCUMENT);
  if (xml === undefined) throw new OoxmlError(`missing ${DOCUMENT}`);
  const body = element(parseXmlRoot(strFromU8(xml)), "body");
  if (body === undefined) throw new OoxmlError(`${DOCUMENT} has no body`);
  const texts: string[] = [];
  readBlocks(body, texts);
  return texts.map((text, i) => ({ locator: `P${String(i + 1).padStart(3, "0")}`, text }));
}

/** Normalise typographic hyphens and whitespace so quotes can be located reliably. */
export function normaliseForQuote(text: string): string {
  return text
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
