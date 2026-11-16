import { strFromU8, unzipSync } from "fflate";

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

export interface DocxParagraph {
  locator: string;
  text: string;
}

/** Paragraph text of a DOCX in document order (table cells included). Zip + XML text only. */
export function readDocxParagraphs(bytes: Uint8Array): DocxParagraph[] {
  const zip = unzipSync(bytes);
  const xml = zip["word/document.xml"] ? strFromU8(zip["word/document.xml"]) : "";
  const out: DocxParagraph[] = [];
  let n = 0;
  for (const p of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    n += 1;
    const text = [...p[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:noBreakHyphen\/>/g)]
      .map((m) => (m[0].startsWith("<w:t") && m[1] !== undefined ? decodeXml(m[1]) : m[0] === "<w:noBreakHyphen/>" ? "-" : " "))
      .join("");
    out.push({ locator: `P${String(n).padStart(3, "0")}`, text });
  }
  return out;
}

/** Normalise typographic hyphens and whitespace so quotes can be located reliably. */
export function normaliseForQuote(text: string): string {
  return text
    .replace(/[\u2010\u2011\u2012\u2013\u2014]/g, "-")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
