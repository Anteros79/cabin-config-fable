import { XMLParser, XMLValidator } from "fast-xml-parser";
import { unzipSync } from "fflate";

/**
 * Shared ZIP and XML plumbing for the OOXML readers. Every limit is checked before the work it
 * guards: an entry's declared size before it is inflated, a sheet's extent before it is allocated.
 * Nothing in a package is executed and no DTD or external entity is ever processed.
 */
export const OOXML_LIMITS = {
  entryBytes: 32 * 1024 * 1024,
  /** Inflated size of one XML part (`.xml`, `.rels`); the parse tree, not the bytes, is what costs memory. */
  xmlEntryBytes: 8 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  /** Element starts in one XML part, counted before it is parsed. */
  maxXmlElements: 250_000,
  rows: 1_048_576,
  columns: 16_384,
  cells: 2_000_000,
};

const isXmlPart = (name: string) => /\.(xml|rels)$/i.test(name);

/** A package or part that cannot be read safely or does not have the expected structure. */
export class OoxmlError extends Error {
  override name = "OoxmlError";
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Inflate the entries `wanted` accepts; every other entry is skipped without being inflated. An entry
 * whose declared size is above `OOXML_LIMITS.xmlEntryBytes` (XML parts) or `entryBytes` (others), or that takes the wanted total above
 * `totalBytes` (by default `OOXML_LIMITS.totalBytes`), is refused before it is inflated.
 */
export function readZipEntries(bytes: Uint8Array, wanted: (name: string) => boolean, totalBytes = OOXML_LIMITS.totalBytes): Map<string, Uint8Array> {
  if (bytes.length < 22) throw new OoxmlError("not a zip archive: too short");
  const declared = new Map<string, number>();
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: ({ name, originalSize }) => {
        if (!wanted(name)) return false;
        if (originalSize > (isXmlPart(name) ? OOXML_LIMITS.xmlEntryBytes : OOXML_LIMITS.entryBytes)) throw new OoxmlError(`entry too large: ${name}`);
        total += originalSize;
        if (total > totalBytes) throw new OoxmlError(`entry too large: ${name} (wanted entries exceed ${totalBytes} bytes in total)`);
        declared.set(name, originalSize);
        return true;
      },
    });
  } catch (e) {
    if (e instanceof OoxmlError) throw e;
    throw new OoxmlError(`not a readable zip archive: ${messageOf(e)}`);
  }
  const out = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(files)) {
    if (data.length !== declared.get(name)) throw new OoxmlError(`entry size does not match the archive directory: ${name}`);
    out.set(name, data);
  }
  return out;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  processEntities: false,
  removeNSPrefix: true,
  preserveOrder: true,
  trimValues: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  cdataPropName: "#cdata",
  // deeper nesting is refused by the parser, which also bounds the recursion in `convert`
  maxNestedTags: 100,
});

/**
 * Parse one XML part into fast-xml-parser's ordered form. Entities are left as written (no DTD is
 * processed); a part with a document type declaration, more than `maxXmlElements` element starts
 * (counted before parsing) or that is not well-formed is refused.
 */
export function parseXml(text: string): unknown {
  if (/<!DOCTYPE/i.test(text)) throw new OoxmlError("document type declarations are not allowed in OOXML parts");
  // count element starts (`<` not followed by `/`, `?` or `!`) before any tree is built
  let starts = 0;
  for (let at = text.indexOf("<"); at !== -1; at = text.indexOf("<", at + 1)) {
    const next = text.charCodeAt(at + 1);
    if (next !== 0x2f && next !== 0x3f && next !== 0x21 && ++starts > OOXML_LIMITS.maxXmlElements)
      throw new OoxmlError(`XML part has more than ${OOXML_LIMITS.maxXmlElements} elements`);
  }
  const valid = XMLValidator.validate(text);
  if (valid !== true) throw new OoxmlError(`not well-formed XML: ${valid.err.msg} (line ${valid.err.line})`);
  try {
    return parser.parse(text);
  } catch (e) {
    throw new OoxmlError(`not well-formed XML: ${messageOf(e)}`);
  }
}

/** An element with its namespace prefixes removed; text children are already entity-decoded. */
export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
export type XmlNode = XmlElement | string;

const ENTITY = /&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|amp|quot|apos));/g;
const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Decode the predefined XML entities and character references in one pass; anything else stays as written. */
export function decodeXmlEntities(text: string): string {
  return text.replace(ENTITY, (whole, dec: string | undefined, hex: string | undefined, named: string | undefined) => {
    if (named !== undefined) return NAMED[named] ?? whole;
    const code = dec !== undefined ? Number(dec) : Number.parseInt(hex ?? "", 16);
    if (!(code <= 0x10ffff)) throw new OoxmlError(`invalid character reference: ${whole}`);
    return String.fromCodePoint(code);
  });
}

type Ordered = Record<string, unknown>;

function convert(items: unknown): XmlNode[] {
  const out: XmlNode[] = [];
  for (const item of Array.isArray(items) ? (items as Ordered[]) : []) {
    for (const [key, value] of Object.entries(item)) {
      if (key === ":@") continue;
      if (key === "#text") out.push(decodeXmlEntities(String(value)));
      else if (key === "#cdata") {
        // CDATA is literal text: no entity decoding
        for (const part of Array.isArray(value) ? (value as Ordered[]) : []) out.push(String(part["#text"] ?? ""));
      } else {
        const rawAttrs = (item[":@"] ?? {}) as Record<string, unknown>;
        const attrs: Record<string, string> = {};
        for (const [name, v] of Object.entries(rawAttrs)) attrs[name] = decodeXmlEntities(String(v));
        out.push({ name: key, attrs, children: convert(value) });
      }
    }
  }
  return out;
}

/** Parse `text` and return its root element (namespace prefixes removed, text decoded). */
export function parseXmlRoot(text: string): XmlElement {
  const root = convert(parseXml(text)).find((n): n is XmlElement => typeof n !== "string");
  if (root === undefined) throw new OoxmlError("XML part has no root element");
  return root;
}

/** Child elements of `el`, optionally only those named `name`. */
export function elements(el: XmlElement | undefined, name?: string): XmlElement[] {
  if (el === undefined) return [];
  return el.children.filter((c): c is XmlElement => typeof c !== "string" && (name === undefined || c.name === name));
}

export function element(el: XmlElement | undefined, name: string): XmlElement | undefined {
  return elements(el, name)[0];
}

/** The text directly inside `el` (not inside its child elements). */
export function ownText(el: XmlElement | undefined): string {
  return el === undefined ? "" : el.children.filter((c): c is string => typeof c === "string").join("");
}
