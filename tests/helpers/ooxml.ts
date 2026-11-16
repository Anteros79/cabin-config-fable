import { strToU8, zipSync } from "fflate";

/** Tiny OOXML packages for reader tests, built in memory with fflate. */

type Entries = Record<string, string | Uint8Array>;

export function zip(entries: Entries): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(entries).map(([name, data]) => [name, typeof data === "string" ? strToU8(data) : data])));
}

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

/** A worksheet part whose sheetData holds `rows` (the raw `<row>` elements). */
export function sheetXml(rows: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${MAIN}"><sheetData>${rows}</sheetData></worksheet>`;
}

export function sharedStringsXml(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="${MAIN}">${items}</sst>`;
}

/** A one-sheet workbook. Any part can be replaced or added through `parts`. */
export function xlsx(sheet: string, parts: Entries = {}): Uint8Array {
  return zip({
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": sheet,
    ...parts,
  });
}

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const WPS = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape";
const V = "urn:schemas-microsoft-com:vml";

/** A document whose `w:body` holds `body`. */
export function docx(body: string): Uint8Array {
  return zip({
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:mc="${MC}" xmlns:wps="${WPS}" xmlns:v="${V}"><w:body>${body}</w:body></w:document>`,
  });
}

/** A paragraph with one run per text. */
export function para(...texts: string[]): string {
  return `<w:p>${texts.map((t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`).join("")}</w:p>`;
}

/**
 * Rewrite the uncompressed size that the central directory records for `name`. The data is left as it
 * is, so the archive stays small while it declares a large entry.
 */
export function declareSize(archive: Uint8Array, name: string, size: number): Uint8Array {
  const out = archive.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let end = out.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error("no end of central directory");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  for (let i = 0; i < count; i++) {
    const nameLength = view.getUint16(at + 28, true);
    const entryName = new TextDecoder().decode(out.subarray(at + 46, at + 46 + nameLength));
    if (entryName === name) {
      view.setUint32(at + 24, size, true);
      return out;
    }
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  throw new Error(`no entry ${name}`);
}
