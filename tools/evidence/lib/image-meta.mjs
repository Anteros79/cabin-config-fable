// Byte-level image container and metadata reader (JPEG / PNG / WebP / AVIF).
// Own parsers for EXIF (TIFF), XMP, IPTC-IIM, ICC description and PNG text chunks.
// Only metadata is interpreted; pixel content is not analysed here.
import { inflateSync } from 'node:zlib';
import { parseXml } from './ooxml.mjs';

const latin1 = (b) => Buffer.from(b).toString('latin1');
const ascii4 = (buf, off) => buf.subarray(off, off + 4).toString('latin1');

function decodeBestEffort(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
const stripNul = (s) => s.replace(/\u0000+$/g, '');

// ---- magic bytes ------------------------------------------------------------

export function detectFormat(buf) {
  const hex = buf.subarray(0, 16).toString('hex');
  if (buf.length >= 8 && hex.startsWith('89504e470d0a1a0a')) return { format: 'PNG', mime: 'image/png', magic: hex.slice(0, 16), basis: 'PNG signature 89 50 4E 47 0D 0A 1A 0A' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { format: 'JPEG', mime: 'image/jpeg', magic: hex.slice(0, 8), basis: 'JPEG SOI FF D8 FF' };
  if (buf.length >= 12 && ascii4(buf, 0) === 'RIFF' && ascii4(buf, 8) === 'WEBP') return { format: 'WebP', mime: 'image/webp', magic: hex.slice(0, 24), basis: 'RIFF....WEBP container' };
  if (buf.length >= 12 && ascii4(buf, 4) === 'ftyp') {
    const major = ascii4(buf, 8);
    const size = buf.readUInt32BE(0);
    const compat = [];
    for (let o = 16; o + 4 <= Math.min(size, buf.length); o += 4) compat.push(ascii4(buf, o));
    const isAvif = major === 'avif' || major === 'avis' || compat.includes('avif');
    const isHeic = ['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(major) && !isAvif;
    return {
      format: isAvif ? 'AVIF' : isHeic ? 'HEIF' : `ISO-BMFF (${major})`,
      mime: isAvif ? 'image/avif' : isHeic ? 'image/heif' : 'application/octet-stream',
      magic: hex.slice(0, 24),
      basis: `ISO-BMFF ftyp box, major brand "${major}", compatible brands [${compat.join(', ')}]`,
      major_brand: major,
      compatible_brands: compat,
    };
  }
  if (buf.length >= 6 && (hex.startsWith('474946383761') || hex.startsWith('474946383961'))) return { format: 'GIF', mime: 'image/gif', magic: hex.slice(0, 12), basis: 'GIF87a/GIF89a signature' };
  if (buf.length >= 4 && hex.startsWith('504b0304')) return { format: 'ZIP', mime: 'application/zip', magic: hex.slice(0, 8), basis: 'ZIP local file header PK 03 04' };
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '{\\rtf') return { format: 'RTF', mime: 'application/rtf', magic: hex.slice(0, 10), basis: 'RTF signature {\\rtf' };
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return { format: 'PDF', mime: 'application/pdf', magic: hex.slice(0, 8), basis: '%PDF signature' };
  return { format: 'unknown-binary-or-text', mime: null, magic: hex.slice(0, 16), basis: 'no known binary signature' };
}

// ---- TIFF / EXIF ------------------------------------------------------------

const TAGS_IFD = {
  0x0100: 'ImageWidth', 0x0101: 'ImageLength', 0x0102: 'BitsPerSample', 0x0103: 'Compression', 0x0106: 'PhotometricInterpretation',
  0x010e: 'ImageDescription', 0x010f: 'Make', 0x0110: 'Model', 0x0112: 'Orientation', 0x0115: 'SamplesPerPixel',
  0x011a: 'XResolution', 0x011b: 'YResolution', 0x011c: 'PlanarConfiguration', 0x0128: 'ResolutionUnit', 0x0131: 'Software',
  0x0132: 'DateTime', 0x013b: 'Artist', 0x013c: 'HostComputer', 0x0201: 'JPEGInterchangeFormat', 0x0202: 'JPEGInterchangeFormatLength',
  0x0213: 'YCbCrPositioning', 0x02bc: 'XMLPacket', 0x8298: 'Copyright', 0x83bb: 'IPTC-NAA', 0x8649: 'PhotoshopSettings',
  0x8769: 'ExifIFDPointer', 0x8773: 'ICCProfile', 0x8825: 'GPSInfoIFDPointer', 0x9c9b: 'XPTitle', 0x9c9c: 'XPComment',
  0x9c9d: 'XPAuthor', 0x9c9e: 'XPKeywords', 0x9c9f: 'XPSubject', 0xc4a5: 'PrintIM',
};
const TAGS_EXIF = {
  0x829a: 'ExposureTime', 0x829d: 'FNumber', 0x8822: 'ExposureProgram', 0x8827: 'ISOSpeedRatings', 0x8830: 'SensitivityType',
  0x8832: 'RecommendedExposureIndex', 0x9000: 'ExifVersion', 0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized',
  0x9010: 'OffsetTime', 0x9011: 'OffsetTimeOriginal', 0x9012: 'OffsetTimeDigitized', 0x9101: 'ComponentsConfiguration',
  0x9102: 'CompressedBitsPerPixel', 0x9201: 'ShutterSpeedValue', 0x9202: 'ApertureValue', 0x9203: 'BrightnessValue',
  0x9204: 'ExposureBiasValue', 0x9205: 'MaxApertureValue', 0x9206: 'SubjectDistance', 0x9207: 'MeteringMode', 0x9208: 'LightSource',
  0x9209: 'Flash', 0x920a: 'FocalLength', 0x927c: 'MakerNote', 0x9286: 'UserComment', 0x9290: 'SubSecTime',
  0x9291: 'SubSecTimeOriginal', 0x9292: 'SubSecTimeDigitized', 0xa000: 'FlashpixVersion', 0xa001: 'ColorSpace',
  0xa002: 'PixelXDimension', 0xa003: 'PixelYDimension', 0xa005: 'InteropIFDPointer', 0xa20e: 'FocalPlaneXResolution',
  0xa20f: 'FocalPlaneYResolution', 0xa210: 'FocalPlaneResolutionUnit', 0xa217: 'SensingMethod', 0xa300: 'FileSource',
  0xa301: 'SceneType', 0xa401: 'CustomRendered', 0xa402: 'ExposureMode', 0xa403: 'WhiteBalance', 0xa404: 'DigitalZoomRatio',
  0xa405: 'FocalLengthIn35mmFilm', 0xa406: 'SceneCaptureType', 0xa408: 'Contrast', 0xa409: 'Saturation', 0xa40a: 'Sharpness',
  0xa40c: 'SubjectDistanceRange', 0xa420: 'ImageUniqueID', 0xa430: 'CameraOwnerName', 0xa431: 'BodySerialNumber',
  0xa432: 'LensSpecification', 0xa433: 'LensMake', 0xa434: 'LensModel', 0xa435: 'LensSerialNumber', 0xa460: 'CompositeImage',
};
const TAGS_GPS = {
  0x00: 'GPSVersionID', 0x01: 'GPSLatitudeRef', 0x02: 'GPSLatitude', 0x03: 'GPSLongitudeRef', 0x04: 'GPSLongitude',
  0x05: 'GPSAltitudeRef', 0x06: 'GPSAltitude', 0x07: 'GPSTimeStamp', 0x10: 'GPSImgDirectionRef', 0x11: 'GPSImgDirection',
  0x12: 'GPSMapDatum', 0x1b: 'GPSProcessingMethod', 0x1d: 'GPSDateStamp', 0x1f: 'GPSHPositioningError',
};
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

export function parseTiff(tiff) {
  const out = { byte_order: null, ifd0: {}, exif: {}, gps: {}, interop: {}, ifd1: {}, errors: [] };
  if (tiff.length < 8) { out.errors.push('TIFF block shorter than 8 bytes'); return out; }
  const bo = tiff.subarray(0, 2).toString('latin1');
  if (bo !== 'II' && bo !== 'MM') { out.errors.push(`unexpected byte order mark ${JSON.stringify(bo)}`); return out; }
  const le = bo === 'II';
  out.byte_order = le ? 'little-endian (II)' : 'big-endian (MM)';
  const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const i32 = (o) => (le ? tiff.readInt32LE(o) : tiff.readInt32BE(o));
  const seen = new Set();

  function readIfd(offset, names, target) {
    if (!offset || offset + 2 > tiff.length || seen.has(offset)) return 0;
    seen.add(offset);
    const count = u16(offset);
    for (let k = 0; k < count; k++) {
      const e = offset + 2 + k * 12;
      if (e + 12 > tiff.length) { out.errors.push(`IFD entry at ${e} beyond block`); break; }
      const tag = u16(e);
      const type = u16(e + 2);
      const n = u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 1) * n;
      const valOff = size <= 4 ? e + 8 : u32(e + 8);
      const name = names[tag] ?? TAGS_IFD[tag] ?? `Tag0x${tag.toString(16).padStart(4, '0')}`;
      if (valOff + size > tiff.length) { target[name] = { unreadable: `value offset ${valOff}+${size} beyond block` }; continue; }
      let value;
      const raw = tiff.subarray(valOff, valOff + size);
      if (type === 2) value = stripNul(decodeBestEffort(raw));
      else if (type === 3) value = Array.from({ length: n }, (_, j) => u16(valOff + j * 2));
      else if (type === 4) value = Array.from({ length: n }, (_, j) => u32(valOff + j * 4));
      else if (type === 9) value = Array.from({ length: n }, (_, j) => i32(valOff + j * 4));
      else if (type === 5) value = Array.from({ length: n }, (_, j) => `${u32(valOff + j * 8)}/${u32(valOff + j * 8 + 4)}`);
      else if (type === 10) value = Array.from({ length: n }, (_, j) => `${i32(valOff + j * 8)}/${i32(valOff + j * 8 + 4)}`);
      else if (type === 1 && /^XP/.test(name)) value = stripNul(raw.toString('utf16le'));
      else if (type === 1 || type === 7 || type === 6) {
        if (name === 'ExifVersion' || name === 'FlashpixVersion') value = raw.toString('latin1');
        else if (name === 'UserComment') value = { charset: stripNul(raw.subarray(0, 8).toString('latin1')), text: stripNul(decodeBestEffort(raw.subarray(8))).trim() };
        else if (size <= 16) value = Array.from(raw);
        else value = { binary_bytes: size, omitted: true };
      } else value = { type, count: n, omitted: true };
      if (Array.isArray(value) && value.length === 1) value = value[0];
      target[name] = value;
    }
    const nextOff = offset + 2 + count * 12;
    return nextOff + 4 <= tiff.length ? u32(nextOff) : 0;
  }

  const ifd0 = u32(4);
  const next = readIfd(ifd0, TAGS_IFD, out.ifd0);
  if (typeof out.ifd0.ExifIFDPointer === 'number') readIfd(out.ifd0.ExifIFDPointer, TAGS_EXIF, out.exif);
  if (typeof out.ifd0.GPSInfoIFDPointer === 'number') readIfd(out.ifd0.GPSInfoIFDPointer, TAGS_GPS, out.gps);
  if (typeof out.exif.InteropIFDPointer === 'number') readIfd(out.exif.InteropIFDPointer, { 1: 'InteroperabilityIndex', 2: 'InteroperabilityVersion' }, out.interop);
  if (next) readIfd(next, TAGS_IFD, out.ifd1);
  return out;
}

// ---- XMP -------------------------------------------------------------------

const RDF_WRAPPERS = new Set(['x:xmpmeta', 'rdf:RDF', 'rdf:Description', 'rdf:Seq', 'rdf:Bag', 'rdf:Alt', 'rdf:li', '#text']);

export function parseXmp(xmpText, { maxProps = 300, maxLen = 600 } = {}) {
  const res = { byte_length: Buffer.byteLength(xmpText), toolkit: null, properties: [], truncated: false, parse_error: null };
  const start = xmpText.indexOf('<x:xmpmeta');
  const startRdf = xmpText.indexOf('<rdf:RDF');
  const from = start >= 0 ? start : startRdf;
  const endTag = start >= 0 ? '</x:xmpmeta>' : '</rdf:RDF>';
  const end = xmpText.indexOf(endTag);
  if (from < 0 || end < 0) { res.parse_error = 'no <x:xmpmeta> or <rdf:RDF> element found'; return res; }
  let root;
  try {
    root = parseXml(xmpText.slice(from, end + endTag.length));
  } catch (e) {
    res.parse_error = String(e.message ?? e);
    return res;
  }
  if (!root) { res.parse_error = 'empty XMP packet'; return res; }
  res.toolkit = root.attrs['x:xmptk'] ?? null;
  const push = (path, value) => {
    const v = String(value);
    if (res.properties.length >= maxProps) { res.truncated = true; return; }
    res.properties.push({ path, value: v.length > maxLen ? v.slice(0, maxLen) + `… [${v.length} chars]` : v });
  };
  (function rec(node, path) {
    const here = RDF_WRAPPERS.has(node.tag) ? path : path.concat([node.tag]);
    for (const [k, v] of Object.entries(node.attrs)) {
      if (k.startsWith('xmlns') || k === 'rdf:about' || k === 'x:xmptk' || k === 'rdf:parseType') continue;
      if (k === 'xml:lang') continue;
      push(here.concat([k]).join('/'), v);
    }
    const elementKids = node.children.filter((c) => c.tag !== '#text');
    if (elementKids.length === 0) {
      const t = node.children.map((c) => c.text ?? '').join('');
      if (t.trim() !== '' && node.tag !== 'x:xmpmeta') push(here.join('/') || node.tag, t);
    } else {
      for (const c of elementKids) rec(c, here);
    }
  })(root, []);
  return res;
}

// ---- IPTC IIM ----------------------------------------------------------------

const IPTC_NAMES = {
  '1:0': 'EnvelopeRecordVersion', '1:90': 'CodedCharacterSet', '2:0': 'ApplicationRecordVersion', '2:5': 'ObjectName',
  '2:7': 'EditStatus', '2:10': 'Urgency', '2:12': 'SubjectReference', '2:15': 'Category', '2:20': 'SupplementalCategories',
  '2:25': 'Keywords', '2:40': 'SpecialInstructions', '2:55': 'DateCreated', '2:60': 'TimeCreated', '2:62': 'DigitalCreationDate',
  '2:63': 'DigitalCreationTime', '2:65': 'OriginatingProgram', '2:70': 'ProgramVersion', '2:80': 'By-line', '2:85': 'By-lineTitle',
  '2:90': 'City', '2:92': 'Sub-location', '2:95': 'Province-State', '2:100': 'CountryCode', '2:101': 'Country',
  '2:103': 'OriginalTransmissionReference', '2:105': 'Headline', '2:110': 'Credit', '2:115': 'Source', '2:116': 'CopyrightNotice',
  '2:118': 'Contact', '2:120': 'Caption-Abstract', '2:122': 'Writer-Editor',
};

export function parseIptc(block) {
  const datasets = [];
  let utf8 = false;
  let i = 0;
  while (i + 5 <= block.length) {
    if (block[i] !== 0x1c) { i++; continue; }
    const rec = block[i + 1];
    const ds = block[i + 2];
    let len = block.readUInt16BE(i + 3);
    let dataStart = i + 5;
    if (len & 0x8000) {
      const nlen = len & 0x7fff;
      len = 0;
      for (let k = 0; k < nlen; k++) len = len * 256 + block[dataStart + k];
      dataStart += nlen;
    }
    if (dataStart + len > block.length) break;
    const data = block.subarray(dataStart, dataStart + len);
    const key = `${rec}:${ds}`;
    let value;
    if (key === '1:90') { value = Array.from(data).map((b) => b.toString(16).padStart(2, '0')).join(' '); utf8 = data.toString('latin1') === '\u001b%G'; }
    else if (key === '1:0' || key === '2:0') value = data.length === 2 ? data.readUInt16BE(0) : Array.from(data);
    else value = utf8 ? data.toString('utf8') : decodeBestEffort(data);
    datasets.push({ record: rec, dataset: ds, name: IPTC_NAMES[key] ?? `IIM ${key}`, value });
    i = dataStart + len;
  }
  return { coded_character_set_utf8: utf8, datasets };
}

function parsePhotoshopResources(block) {
  const resources = [];
  let iptc = null;
  let i = 0;
  while (i + 12 <= block.length) {
    const sig = ascii4(block, i);
    if (sig !== '8BIM') break;
    const id = block.readUInt16BE(i + 4);
    const nameLen = block[i + 6];
    let p = i + 7 + nameLen;
    if ((nameLen + 1) % 2 === 1) p++;
    if (p + 4 > block.length) break;
    const size = block.readUInt32BE(p);
    const dataStart = p + 4;
    resources.push({ id: '0x' + id.toString(16).padStart(4, '0'), size });
    if (id === 0x0404) iptc = block.subarray(dataStart, dataStart + size);
    i = dataStart + size + (size % 2);
  }
  return { resources, iptc };
}

// ---- ICC ---------------------------------------------------------------------

function parseIcc(icc) {
  if (!icc || icc.length < 132) return null;
  const out = {
    byte_length: icc.length,
    version: `${icc[8]}.${icc[9] >> 4}.${icc[9] & 0xf}`,
    device_class: ascii4(icc, 12).trim(),
    color_space: ascii4(icc, 16).trim(),
    description: null,
    copyright: null,
  };
  const count = icc.readUInt32BE(128);
  const readTextTag = (off, size) => {
    if (off + 12 > icc.length) return null;
    const type = ascii4(icc, off);
    if (type === 'desc') { const n = icc.readUInt32BE(off + 8); return stripNul(icc.subarray(off + 12, off + 12 + n).toString('latin1')); }
    if (type === 'text') return stripNul(icc.subarray(off + 8, off + size).toString('latin1'));
    if (type === 'mluc') {
      const n = icc.readUInt32BE(off + 8);
      if (n < 1) return null;
      const len = icc.readUInt32BE(off + 20);
      const o = icc.readUInt32BE(off + 24);
      const b = Buffer.from(icc.subarray(off + o, off + o + len));
      return stripNul(b.swap16().toString('utf16le'));
    }
    return null;
  };
  for (let k = 0; k < count && 132 + k * 12 + 12 <= icc.length; k++) {
    const e = 132 + k * 12;
    const sig = ascii4(icc, e);
    const off = icc.readUInt32BE(e + 4);
    const size = icc.readUInt32BE(e + 8);
    if (sig === 'desc') out.description = readTextTag(off, size);
    if (sig === 'cprt') out.copyright = readTextTag(off, size);
  }
  return out;
}

// ---- JPEG ---------------------------------------------------------------------

const SOF_NAMES = { 0xc0: 'baseline DCT (SOF0)', 0xc1: 'extended sequential DCT (SOF1)', 0xc2: 'progressive DCT (SOF2)', 0xc3: 'lossless (SOF3)', 0xc9: 'extended sequential arithmetic (SOF9)', 0xca: 'progressive arithmetic (SOF10)' };

function parseJpeg(buf) {
  const r = { segments: [], comments: [], errors: [] };
  const iccChunks = [];
  const psChunks = [];
  let i = 2;
  const n = buf.length;
  let eoi = -1;
  while (i + 1 < n) {
    if (buf[i] !== 0xff) { r.errors.push(`expected marker at offset ${i}`); break; }
    let m = buf[i + 1];
    while (m === 0xff && i + 2 < n) { i++; m = buf[i + 1]; }
    if (m === 0xd9) { eoi = i; break; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (i + 4 > n) { r.errors.push('truncated segment header'); break; }
    const len = buf.readUInt16BE(i + 2);
    const data = buf.subarray(i + 4, i + 2 + len);
    const name = m >= 0xe0 && m <= 0xef ? `APP${m - 0xe0}` : m === 0xfe ? 'COM' : m === 0xdb ? 'DQT' : m === 0xc4 ? 'DHT' : m === 0xda ? 'SOS' : m === 0xdd ? 'DRI' : SOF_NAMES[m] ? 'SOF' : `0x${m.toString(16)}`;
    const seg = { marker: name, offset: i, length: len };
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      r.sof = {
        process: SOF_NAMES[m] ?? `SOF 0x${m.toString(16)}`,
        progressive: m === 0xc2 || m === 0xca,
        precision_bits: data[0],
        height: data.readUInt16BE(1),
        width: data.readUInt16BE(3),
        components: data[5],
        sampling: Array.from({ length: data[5] }, (_, k) => ({ id: data[6 + k * 3], h: data[7 + k * 3] >> 4, v: data[7 + k * 3] & 0xf })),
      };
    } else if (m === 0xe0 && data.subarray(0, 5).toString('latin1') === 'JFIF\u0000') {
      seg.id = 'JFIF';
      r.jfif = { version: `${data[5]}.${String(data[6]).padStart(2, '0')}`, density_units: ['aspect ratio (no units)', 'dots per inch', 'dots per cm'][data[7]] ?? data[7], x_density: data.readUInt16BE(8), y_density: data.readUInt16BE(10) };
    } else if (m === 0xe1 && data.subarray(0, 6).toString('latin1') === 'Exif\u0000\u0000') {
      seg.id = 'Exif';
      r.exif_tiff = data.subarray(6);
    } else if (m === 0xe1 && data.subarray(0, 29).toString('latin1') === 'http://ns.adobe.com/xap/1.0/\u0000') {
      seg.id = 'XMP';
      r.xmp_text = data.subarray(29).toString('utf8');
    } else if (m === 0xe1 && data.subarray(0, 35).toString('latin1') === 'http://ns.adobe.com/xmp/extension/\u0000') {
      seg.id = 'ExtendedXMP';
      r.extended_xmp = r.extended_xmp ?? { guid: data.subarray(35, 67).toString('latin1'), declared_full_length: data.readUInt32BE(67), chunks: 0, bytes_present: 0 };
      r.extended_xmp.chunks++;
      r.extended_xmp.bytes_present += data.length - 75;
    } else if (m === 0xe2 && data.subarray(0, 12).toString('latin1') === 'ICC_PROFILE\u0000') {
      seg.id = 'ICC_PROFILE';
      iccChunks.push({ seq: data[12], data: data.subarray(14) });
    } else if (m === 0xe2 && data.subarray(0, 4).toString('latin1') === 'MPF\u0000') {
      seg.id = 'MPF (multi-picture format)';
      r.mpf_present = true;
    } else if (m === 0xed && data.subarray(0, 14).toString('latin1') === 'Photoshop 3.0\u0000') {
      seg.id = 'Photoshop 3.0 (8BIM resources)';
      psChunks.push(data.subarray(14));
    } else if (m === 0xee && data.subarray(0, 5).toString('latin1') === 'Adobe') {
      seg.id = 'Adobe';
      r.adobe = { dct_version: data.readUInt16BE(5), color_transform: data[11], color_transform_name: ['unknown/RGB or CMYK', 'YCbCr', 'YCCK'][data[11]] ?? String(data[11]) };
    } else if (m === 0xfe) {
      r.comments.push(decodeBestEffort(data));
    } else if (m >= 0xe0 && m <= 0xef) {
      seg.id = latin1(data.subarray(0, Math.min(16, data.length))).replace(/[^\x20-\x7e].*$/, '');
    }
    r.segments.push(seg);
    i += 2 + len;
    if (m === 0xda) {
      // entropy-coded data: advance to the next real marker
      while (i + 1 < n) {
        if (buf[i] === 0xff && buf[i + 1] !== 0x00 && !(buf[i + 1] >= 0xd0 && buf[i + 1] <= 0xd7) && buf[i + 1] !== 0xff) break;
        i++;
      }
    }
  }
  r.eoi_offset = eoi;
  r.trailing_bytes_after_eoi = eoi >= 0 ? n - (eoi + 2) : null;
  if (iccChunks.length) r.icc = Buffer.concat(iccChunks.sort((a, b) => a.seq - b.seq).map((c) => c.data));
  if (psChunks.length) {
    const ps = parsePhotoshopResources(Buffer.concat(psChunks));
    r.photoshop_resources = ps.resources;
    if (ps.iptc) r.iptc_block = ps.iptc;
  }
  return r;
}

// ---- PNG ---------------------------------------------------------------------

const PNG_COLOR = { 0: 'Grayscale', 2: 'RGB (truecolor)', 3: 'Indexed (palette)', 4: 'Grayscale + alpha', 6: 'RGBA (truecolor + alpha)' };

function parsePng(buf) {
  const r = { chunks: {}, text: [], errors: [] };
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = ascii4(buf, i + 4);
    const data = buf.subarray(i + 8, i + 8 + len);
    r.chunks[type] = (r.chunks[type] ?? 0) + 1;
    if (type === 'IHDR') {
      r.ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bit_depth: data[8], color_type: data[9], color_type_name: PNG_COLOR[data[9]] ?? String(data[9]), interlace: data[12] === 1 ? 'Adam7' : 'none' };
    } else if (type === 'tEXt') {
      const z = data.indexOf(0);
      r.text.push({ chunk: 'tEXt', keyword: data.subarray(0, z).toString('latin1'), value: data.subarray(z + 1).toString('latin1') });
    } else if (type === 'zTXt') {
      const z = data.indexOf(0);
      let value;
      try { value = inflateSync(data.subarray(z + 2)).toString('latin1'); } catch (e) { value = `[inflate failed: ${e.message}]`; }
      r.text.push({ chunk: 'zTXt', keyword: data.subarray(0, z).toString('latin1'), value });
    } else if (type === 'iTXt') {
      const z = data.indexOf(0);
      const keyword = data.subarray(0, z).toString('latin1');
      const compFlag = data[z + 1];
      const z2 = data.indexOf(0, z + 3);
      const z3 = data.indexOf(0, z2 + 1);
      let payload = data.subarray(z3 + 1);
      let value;
      try { value = (compFlag === 1 ? inflateSync(payload) : payload).toString('utf8'); } catch (e) { value = `[inflate failed: ${e.message}]`; }
      r.text.push({ chunk: 'iTXt', keyword, language: data.subarray(z + 3, z2).toString('latin1'), value });
    } else if (type === 'eXIf') {
      r.exif_tiff = data;
    } else if (type === 'pHYs') {
      r.phys = { x_pixels_per_unit: data.readUInt32BE(0), y_pixels_per_unit: data.readUInt32BE(4), unit: data[8] === 1 ? 'metre' : 'unspecified' };
    } else if (type === 'iCCP') {
      const z = data.indexOf(0);
      r.iccp_name = data.subarray(0, z).toString('latin1');
      try { r.icc = inflateSync(data.subarray(z + 2)); } catch { /* keep name only */ }
    } else if (type === 'sRGB') {
      r.srgb_rendering_intent = data[0];
    } else if (type === 'gAMA') {
      r.gamma = data.readUInt32BE(0) / 100000;
    } else if (type === 'tIME') {
      r.time = `${data.readUInt16BE(0)}-${String(data[2]).padStart(2, '0')}-${String(data[3]).padStart(2, '0')}T${String(data[4]).padStart(2, '0')}:${String(data[5]).padStart(2, '0')}:${String(data[6]).padStart(2, '0')}Z`;
    }
    i += 12 + len;
    if (type === 'IEND') break;
  }
  r.trailing_bytes_after_iend = buf.length - i;
  return r;
}

// ---- WebP --------------------------------------------------------------------

function parseWebp(buf) {
  const r = { chunks: [], riff_declared_size: buf.readUInt32LE(4), errors: [] };
  let i = 12;
  while (i + 8 <= buf.length) {
    const cc = ascii4(buf, i);
    const size = buf.readUInt32LE(i + 4);
    const data = buf.subarray(i + 8, i + 8 + size);
    r.chunks.push({ fourcc: cc, size });
    if (cc === 'VP8X') {
      const flags = data[0];
      r.vp8x = {
        has_icc: !!(flags & 0x20), has_alpha: !!(flags & 0x10), has_exif: !!(flags & 0x08), has_xmp: !!(flags & 0x04), has_animation: !!(flags & 0x02),
        canvas_width: 1 + data.readUIntLE(4, 3), canvas_height: 1 + data.readUIntLE(7, 3),
      };
    } else if (cc === 'VP8 ') {
      if (data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a) {
        r.vp8 = { codec: 'VP8 lossy (YUV 4:2:0)', width: data.readUInt16LE(6) & 0x3fff, height: data.readUInt16LE(8) & 0x3fff };
      } else r.errors.push('VP8 start code not found');
    } else if (cc === 'VP8L') {
      const bits = data.readUInt32LE(1);
      r.vp8l = { codec: 'VP8L lossless (ARGB)', width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff), alpha_hint: !!((bits >> 28) & 1) };
    } else if (cc === 'ICCP') r.icc = data;
    else if (cc === 'EXIF') r.exif_tiff = data.subarray(0, 6).toString('latin1') === 'Exif\u0000\u0000' ? data.subarray(6) : data;
    else if (cc === 'XMP ') r.xmp_text = data.toString('utf8');
    i += 8 + size + (size % 2);
  }
  return r;
}

// ---- AVIF / ISO-BMFF ------------------------------------------------------------

function boxes(buf, start, end) {
  const out = [];
  let i = start;
  while (i + 8 <= end) {
    let size = buf.readUInt32BE(i);
    const type = ascii4(buf, i + 4);
    let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(i + 8)); hdr = 16; }
    else if (size === 0) size = end - i;
    if (size < hdr || i + size > end) break;
    out.push({ type, start: i, data_start: i + hdr, end: i + size, size });
    i += size;
  }
  return out;
}

function parseAvif(buf) {
  const r = { top_level_boxes: [], items: [], properties: [], errors: [] };
  const top = boxes(buf, 0, buf.length);
  r.top_level_boxes = top.map((b) => ({ type: b.type, size: b.size }));
  const meta = top.find((b) => b.type === 'meta');
  if (!meta) { r.errors.push('no meta box'); return r; }
  const mkids = boxes(buf, meta.data_start + 4, meta.end);
  const find = (list, t) => list.find((b) => b.type === t);
  const readN = (off, nbytes) => { let v = 0; for (let k = 0; k < nbytes; k++) v = v * 256 + buf[off + k]; return v; };

  const pitm = find(mkids, 'pitm');
  if (pitm) { const v = buf[pitm.data_start]; r.primary_item_id = v === 0 ? buf.readUInt16BE(pitm.data_start + 4) : buf.readUInt32BE(pitm.data_start + 4); }

  const iinf = find(mkids, 'iinf');
  if (iinf) {
    const v = buf[iinf.data_start];
    const first = iinf.data_start + 4 + (v === 0 ? 2 : 4);
    for (const infe of boxes(buf, first, iinf.end).filter((b) => b.type === 'infe')) {
      const iv = buf[infe.data_start];
      let o = infe.data_start + 4;
      if (iv >= 2) {
        const id = iv === 2 ? buf.readUInt16BE(o) : buf.readUInt32BE(o);
        o += iv === 2 ? 2 : 4;
        o += 2;
        const itemType = ascii4(buf, o);
        o += 4;
        const z = buf.indexOf(0, o);
        const name = buf.subarray(o, z).toString('latin1');
        let contentType = null;
        if (itemType === 'mime') { const z2 = buf.indexOf(0, z + 1); contentType = buf.subarray(z + 1, z2).toString('latin1'); }
        r.items.push({ id, type: itemType, name, content_type: contentType });
      }
    }
  }

  const iloc = find(mkids, 'iloc');
  const locations = new Map();
  if (iloc) {
    const v = buf[iloc.data_start];
    let o = iloc.data_start + 4;
    const offsetSize = buf[o] >> 4;
    const lengthSize = buf[o] & 0xf;
    const baseOffsetSize = buf[o + 1] >> 4;
    const indexSize = v === 1 || v === 2 ? buf[o + 1] & 0xf : 0;
    o += 2;
    const count = v < 2 ? buf.readUInt16BE(o) : buf.readUInt32BE(o);
    o += v < 2 ? 2 : 4;
    for (let k = 0; k < count && o < iloc.end; k++) {
      const id = v < 2 ? buf.readUInt16BE(o) : buf.readUInt32BE(o);
      o += v < 2 ? 2 : 4;
      let method = 0;
      if (v === 1 || v === 2) { method = buf.readUInt16BE(o) & 0xf; o += 2; }
      o += 2;
      const base = readN(o, baseOffsetSize);
      o += baseOffsetSize;
      const extentCount = buf.readUInt16BE(o);
      o += 2;
      const extents = [];
      for (let e = 0; e < extentCount; e++) {
        o += indexSize;
        const eo = readN(o, offsetSize);
        o += offsetSize;
        const el = readN(o, lengthSize);
        o += lengthSize;
        extents.push({ offset: base + eo, length: el });
      }
      locations.set(id, { method, extents });
    }
  }
  const idat = find(mkids, 'idat');
  const itemBytes = (id) => {
    const loc = locations.get(id);
    if (!loc) return null;
    const parts = loc.extents.map((e) => {
      const base = loc.method === 1 && idat ? idat.data_start : 0;
      return buf.subarray(base + e.offset, base + e.offset + e.length);
    });
    return Buffer.concat(parts);
  };

  const iprp = find(mkids, 'iprp');
  const ipcoList = [];
  if (iprp) {
    const pk = boxes(buf, iprp.data_start, iprp.end);
    const ipco = find(pk, 'ipco');
    if (ipco) {
      for (const p of boxes(buf, ipco.data_start, ipco.end)) {
        const d = p.data_start;
        const prop = { type: p.type };
        if (p.type === 'ispe') { prop.width = buf.readUInt32BE(d + 4); prop.height = buf.readUInt32BE(d + 8); }
        else if (p.type === 'pixi') { const ch = buf[d + 4]; prop.channels = ch; prop.bits_per_channel = Array.from(buf.subarray(d + 5, d + 5 + ch)); }
        else if (p.type === 'colr') {
          prop.colour_type = ascii4(buf, d);
          if (prop.colour_type === 'nclx') { prop.colour_primaries = buf.readUInt16BE(d + 4); prop.transfer_characteristics = buf.readUInt16BE(d + 6); prop.matrix_coefficients = buf.readUInt16BE(d + 8); prop.full_range = !!(buf[d + 10] & 0x80); }
          else if (prop.colour_type === 'prof' || prop.colour_type === 'rICC') prop.icc = buf.subarray(d + 4, p.end);
        } else if (p.type === 'av1C') {
          const b1 = buf[d + 1];
          const b2 = buf[d + 2];
          prop.seq_profile = b1 >> 5;
          prop.seq_level_idx_0 = b1 & 0x1f;
          prop.high_bitdepth = !!(b2 & 0x40);
          prop.twelve_bit = !!(b2 & 0x20);
          prop.monochrome = !!(b2 & 0x10);
          prop.chroma_subsampling_x = (b2 >> 3) & 1;
          prop.chroma_subsampling_y = (b2 >> 2) & 1;
        } else if (p.type === 'irot') prop.rotation_ccw_degrees = (buf[d] & 3) * 90;
        ipcoList.push(prop);
      }
    }
    const ipma = find(pk, 'ipma');
    if (ipma) {
      const v = buf[ipma.data_start];
      const flags = buf.readUIntBE(ipma.data_start + 1, 3);
      let o = ipma.data_start + 4;
      const count = buf.readUInt32BE(o);
      o += 4;
      r.associations = {};
      for (let k = 0; k < count && o < ipma.end; k++) {
        const id = v < 1 ? buf.readUInt16BE(o) : buf.readUInt32BE(o);
        o += v < 1 ? 2 : 4;
        const ac = buf[o++];
        const idxs = [];
        for (let a = 0; a < ac; a++) {
          if (flags & 1) { idxs.push(buf.readUInt16BE(o) & 0x7fff); o += 2; }
          else { idxs.push(buf[o] & 0x7f); o += 1; }
        }
        r.associations[id] = idxs;
      }
    }
  }
  r.properties = ipcoList.map((p) => { const { icc, ...rest } = p; return icc ? { ...rest, icc_bytes: icc.length } : rest; });
  const primaryProps = (r.associations?.[r.primary_item_id] ?? []).map((ix) => ipcoList[ix - 1]).filter(Boolean);
  const pick = (t) => primaryProps.find((p) => p.type === t) ?? ipcoList.find((p) => p.type === t) ?? null;
  r.primary = { ispe: pick('ispe'), pixi: pick('pixi'), colr: pick('colr'), av1C: pick('av1C') };
  const iccProp = primaryProps.find((p) => p.icc) ?? ipcoList.find((p) => p.icc);
  if (iccProp) r.icc = iccProp.icc;

  const exifItem = r.items.find((it) => it.type === 'Exif');
  if (exifItem) {
    const b = itemBytes(exifItem.id);
    if (b && b.length > 4) {
      const off = b.readUInt32BE(0);
      r.exif_tiff = b.subarray(4 + off);
    }
  }
  const xmpItem = r.items.find((it) => it.type === 'mime' && /rdf\+xml/.test(it.content_type ?? ''));
  if (xmpItem) { const b = itemBytes(xmpItem.id); if (b) r.xmp_text = b.toString('utf8'); }
  return r;
}

// ---- public: full image description -------------------------------------------

const AIRLINE_NAMES = [
  'Southwest', 'American Airlines', 'American Eagle', 'Delta', 'United', 'Alaska', 'JetBlue', 'Spirit', 'Frontier', 'Hawaiian',
  'Allegiant', 'Sun Country', 'Air Canada', 'WestJet', 'Lufthansa', 'British Airways', 'Ryanair', 'easyJet', 'Emirates', 'Qantas',
  'Recaro', 'Collins', 'Boeing', 'Airbus',
];

function flattenStrings(prefix, obj, out) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (typeof v === 'string') { if (v.trim() !== '') out.push({ source: prefix, field: k, value: v }); }
    else if (v && typeof v === 'object' && typeof v.text === 'string' && v.text !== '') out.push({ source: prefix, field: k, value: v.text });
  }
}

export function describeImage(buf) {
  const det = detectFormat(buf);
  const out = { detected: det, parse_status: 'ok', parse_error: null };
  let exifTiff = null;
  let xmpText = null;
  let icc = null;
  let iptcBlock = null;
  try {
    if (det.format === 'JPEG') {
      const j = parseJpeg(buf);
      if (!j.sof) throw new Error('no SOF segment found');
      out.pixel_width = j.sof.width;
      out.pixel_height = j.sof.height;
      const comps = j.sof.components;
      const mode = comps === 1 ? 'Grayscale' : comps === 3 ? (j.adobe && j.adobe.color_transform === 0 ? 'RGB (no colour transform)' : 'YCbCr (decodes to RGB)') : comps === 4 ? (j.adobe && j.adobe.color_transform === 2 ? 'YCCK (CMYK)' : 'CMYK') : `${comps} components`;
      const s = j.sof.sampling;
      const sub = comps === 3 ? (s[0].h === 2 && s[0].v === 2 ? '4:2:0' : s[0].h === 2 && s[0].v === 1 ? '4:2:2' : s[0].h === 1 && s[0].v === 1 ? '4:4:4' : `${s[0].h}x${s[0].v}`) : null;
      out.color = { mode, channels: comps, bits_per_channel: j.sof.precision_bits, has_alpha: false, chroma_subsampling: sub };
      out.structure = {
        process: j.sof.process,
        progressive: j.sof.progressive,
        jfif: j.jfif ?? null,
        adobe_app14: j.adobe ?? null,
        segment_summary: j.segments.reduce((m, sg) => { const k = sg.id ? `${sg.marker}:${sg.id}` : sg.marker; m[k] = (m[k] ?? 0) + 1; return m; }, {}),
        comments: j.comments,
        extended_xmp: j.extended_xmp ?? null,
        mpf_present: !!j.mpf_present,
        photoshop_resource_ids: j.photoshop_resources ?? [],
        eoi_offset: j.eoi_offset,
        trailing_bytes_after_eoi: j.trailing_bytes_after_eoi,
        errors: j.errors,
      };
      exifTiff = j.exif_tiff ?? null;
      xmpText = j.xmp_text ?? null;
      icc = j.icc ?? null;
      iptcBlock = j.iptc_block ?? null;
    } else if (det.format === 'PNG') {
      const p = parsePng(buf);
      if (!p.ihdr) throw new Error('no IHDR chunk');
      out.pixel_width = p.ihdr.width;
      out.pixel_height = p.ihdr.height;
      const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[p.ihdr.color_type];
      out.color = { mode: p.ihdr.color_type_name, channels: ch, bits_per_channel: p.ihdr.bit_depth, has_alpha: p.ihdr.color_type === 4 || p.ihdr.color_type === 6 || !!p.chunks.tRNS };
      out.structure = { chunk_counts: p.chunks, interlace: p.ihdr.interlace, physical_pixel_dimensions: p.phys ?? null, iccp_profile_name: p.iccp_name ?? null, srgb_chunk: p.srgb_rendering_intent ?? null, gamma: p.gamma ?? null, time_chunk: p.time ?? null, trailing_bytes_after_iend: p.trailing_bytes_after_iend };
      out.png_text_chunks = p.text.map((t) => ({ chunk: t.chunk, keyword: t.keyword, value: t.keyword === 'XML:com.adobe.xmp' ? `[XMP packet, ${t.value.length} chars — see xmp]` : t.value }));
      exifTiff = p.exif_tiff ?? null;
      xmpText = p.text.find((t) => t.keyword === 'XML:com.adobe.xmp')?.value ?? null;
      icc = p.icc ?? null;
    } else if (det.format === 'WebP') {
      const w = parseWebp(buf);
      const dims = w.vp8x ? { w: w.vp8x.canvas_width, h: w.vp8x.canvas_height } : w.vp8 ? { w: w.vp8.width, h: w.vp8.height } : w.vp8l ? { w: w.vp8l.width, h: w.vp8l.height } : null;
      if (!dims) throw new Error('no VP8X/VP8/VP8L chunk with dimensions');
      out.pixel_width = dims.w;
      out.pixel_height = dims.h;
      const alpha = !!(w.vp8x?.has_alpha || w.vp8l?.alpha_hint || w.chunks.some((c) => c.fourcc === 'ALPH'));
      out.color = { mode: w.vp8 ? (alpha ? 'YUV 4:2:0 + alpha (decodes to RGBA)' : 'YUV 4:2:0 (decodes to RGB)') : 'ARGB lossless', channels: alpha ? 4 : 3, bits_per_channel: 8, has_alpha: alpha };
      out.structure = { riff_declared_size: w.riff_declared_size, chunks: w.chunks, vp8x: w.vp8x ?? null, bitstream: w.vp8 ?? w.vp8l ?? null, errors: w.errors };
      exifTiff = w.exif_tiff ?? null;
      xmpText = w.xmp_text ?? null;
      icc = w.icc ?? null;
    } else if (det.format === 'AVIF' || det.format === 'HEIF') {
      const a = parseAvif(buf);
      if (!a.primary?.ispe) throw new Error('no ispe property found: ' + a.errors.join('; '));
      out.pixel_width = a.primary.ispe.width;
      out.pixel_height = a.primary.ispe.height;
      const ch = a.primary.pixi?.channels ?? (a.primary.av1C?.monochrome ? 1 : 3);
      const bits = a.primary.pixi?.bits_per_channel?.[0] ?? (a.primary.av1C ? (a.primary.av1C.high_bitdepth ? (a.primary.av1C.twelve_bit ? 12 : 10) : 8) : null);
      const hasAlpha = a.items.some((it) => it.type === 'av01') && a.items.filter((it) => it.type === 'av01').length > 1 ? 'possible (multiple av01 items; auxiliary type not decoded here)' : false;
      const av = a.primary.av1C;
      out.color = {
        mode: ch === 1 ? 'Monochrome' : 'YUV (decodes to RGB)',
        channels: ch,
        bits_per_channel: bits,
        has_alpha: hasAlpha,
        chroma_subsampling: av ? (av.monochrome ? '4:0:0' : av.chroma_subsampling_x && av.chroma_subsampling_y ? '4:2:0' : av.chroma_subsampling_x ? '4:2:2' : '4:4:4') : null,
        nclx: a.primary.colr && a.primary.colr.colour_type === 'nclx' ? { colour_primaries: a.primary.colr.colour_primaries, transfer_characteristics: a.primary.colr.transfer_characteristics, matrix_coefficients: a.primary.colr.matrix_coefficients, full_range: a.primary.colr.full_range } : null,
      };
      out.structure = { major_brand: det.major_brand, compatible_brands: det.compatible_brands, top_level_boxes: a.top_level_boxes, primary_item_id: a.primary_item_id ?? null, items: a.items, properties: a.properties, errors: a.errors };
      exifTiff = a.exif_tiff ?? null;
      xmpText = a.xmp_text ?? null;
      icc = a.icc ?? null;
    } else {
      throw new Error(`unsupported or unrecognised image container: ${det.format}`);
    }
  } catch (e) {
    out.parse_status = 'failed';
    out.parse_error = String(e.message ?? e);
  }

  out.exif = exifTiff ? { present: true, byte_length: exifTiff.length, ...parseTiff(Buffer.from(exifTiff)) } : { present: false };
  out.xmp = xmpText ? { present: true, ...parseXmp(xmpText) } : { present: false };
  out.iptc = iptcBlock ? { present: true, byte_length: iptcBlock.length, ...parseIptc(Buffer.from(iptcBlock)) } : { present: false };
  out.icc_profile = icc ? parseIcc(Buffer.from(icc)) : null;

  // flat list of every text metadata string found
  const strings = [];
  if (out.exif.present) {
    flattenStrings('EXIF.IFD0', out.exif.ifd0, strings);
    flattenStrings('EXIF.Exif', out.exif.exif, strings);
    flattenStrings('EXIF.GPS', out.exif.gps, strings);
    flattenStrings('EXIF.IFD1', out.exif.ifd1, strings);
  }
  if (out.iptc.present) for (const d of out.iptc.datasets) if (typeof d.value === 'string' && d.value.trim() !== '' && d.name !== 'CodedCharacterSet') strings.push({ source: 'IPTC', field: `${d.record}:${d.dataset} ${d.name}`, value: d.value });
  if (out.xmp.present) for (const p of out.xmp.properties) strings.push({ source: 'XMP', field: p.path, value: p.value });
  for (const t of out.png_text_chunks ?? []) if (t.keyword !== 'XML:com.adobe.xmp') strings.push({ source: `PNG.${t.chunk}`, field: t.keyword, value: t.value });
  for (const c of out.structure?.comments ?? []) strings.push({ source: 'JPEG.COM', field: 'comment', value: c });
  if (out.icc_profile?.description) strings.push({ source: 'ICC', field: 'profile description', value: out.icc_profile.description });
  if (out.icc_profile?.copyright) strings.push({ source: 'ICC', field: 'profile copyright', value: out.icc_profile.copyright });
  out.text_metadata_strings = strings;

  // key descriptive fields (only what the bytes carry)
  // match on the leaf property name (namespace prefix and path removed)
  const leaf = (field) => field.split(/[/ ]/).pop().replace(/^[^:]+:/, '');
  const pickAll = (re) => strings.filter((s) => s.source !== 'ICC' && re.test(leaf(s.field))).map((s) => ({ field: `${s.source}:${s.field}`, value: s.value }));
  out.key_fields = {
    creator: pickAll(/^(Artist|By-line|creator|Credit|AuthorsPosition|By-lineTitle|CaptionWriter|Writer-Editor|CameraOwnerName|XPAuthor)$/i),
    copyright: pickAll(/^(Copyright|CopyrightNotice|rights|UsageTerms|WebStatement|Marked)$/i),
    description: pickAll(/^(ImageDescription|Caption-Abstract|description|Headline|ObjectName|title|UserComment|XPTitle|XPComment|XPSubject)$/i),
    keywords_and_subjects: pickAll(/^(Keywords|subject|Category|SupplementalCategories)$/i),
    location: pickAll(/^(City|Province-State|State|Country|CountryCode|Sub-location|Location)$/i),
    source_and_instructions: pickAll(/^(Source|SpecialInstructions|Instructions|OriginalTransmissionReference|TransmissionReference)$/i),
    software: pickAll(/^(Software|CreatorTool|OriginatingProgram|ProgramVersion|HostComputer)$/i),
    camera: pickAll(/^(Make|Model|LensModel|LensMake|Lens)$/i),
    dates: pickAll(/^(DateTime|DateTimeOriginal|DateTimeDigitized|OffsetTime|OffsetTimeOriginal|OffsetTimeDigitized|DateCreated|TimeCreated|DigitalCreationDate|DigitalCreationTime|CreateDate|ModifyDate|MetadataDate|GPSDateStamp)$/i),
  };
  // dimensions declared inside metadata vs. the dimensions of the encoded image
  const declared = [];
  if (out.exif.present && out.exif.exif?.PixelXDimension) declared.push({ source: 'EXIF PixelXDimension/PixelYDimension', width: out.exif.exif.PixelXDimension, height: out.exif.exif.PixelYDimension });
  if (out.exif.present && out.exif.ifd0?.ImageWidth) declared.push({ source: 'EXIF IFD0 ImageWidth/ImageLength', width: out.exif.ifd0.ImageWidth, height: out.exif.ifd0.ImageLength });
  if (out.xmp.present) {
    const x = out.xmp.properties.find((p) => p.path === 'exif:PixelXDimension');
    const y = out.xmp.properties.find((p) => p.path === 'exif:PixelYDimension');
    if (x && y) declared.push({ source: 'XMP exif:PixelXDimension/PixelYDimension', width: Number(x.value), height: Number(y.value) });
  }
  out.metadata_declared_dimensions = declared.map((d) => ({ ...d, matches_encoded_image: d.width === out.pixel_width && d.height === out.pixel_height }));
  out.gps_data_present = out.exif.present && Object.keys(out.exif.gps ?? {}).length > 0;

  // airline / manufacturer names appearing in metadata strings (ICC excluded)
  const hits = [];
  for (const s of strings) {
    if (s.source === 'ICC') continue;
    for (const name of AIRLINE_NAMES) {
      if (new RegExp(`\\b${name}\\b`, 'i').test(s.value)) hits.push({ name, field: `${s.source}:${s.field}`, value: s.value.length > 300 ? s.value.slice(0, 300) + '…' : s.value });
    }
  }
  out.named_entity_hits_in_metadata = hits;
  // raw byte scan (latin1) of the header region for the same names, to catch anything outside parsed fields
  const scanLimit = Math.min(buf.length, 256 * 1024);
  const rawText = buf.subarray(0, scanLimit).toString('latin1');
  out.raw_byte_name_scan = {
    scanned_bytes: scanLimit,
    hits: AIRLINE_NAMES.map((name) => {
      const offsets = [];
      const re = new RegExp(name.replace(/ /g, '[ _-]?'), 'gi');
      let m;
      while ((m = re.exec(rawText)) && offsets.length < 20) offsets.push(m.index);
      return { name, count: offsets.length, first_offsets: offsets.slice(0, 5) };
    }).filter((h) => h.count > 0),
  };
  return out;
}
