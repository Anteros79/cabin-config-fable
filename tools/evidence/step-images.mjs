// Image container + embedded-metadata extraction for the 14 reference images.
// Own byte parsers are primary; sharp is used only as a cross-check and to confirm the file decodes.
import sharp from 'sharp';
import { ORIGINALS, readOriginal } from './lib/common.mjs';
import { describeImage } from './lib/image-meta.mjs';

async function sharpCheck(buf) {
  const res = { library: `sharp ${sharp.versions?.sharp ?? ''} / libvips ${sharp.versions?.vips ?? ''}`.trim() };
  try {
    const m = await sharp(buf, { failOn: 'error' }).metadata();
    res.metadata = {
      format: m.format, width: m.width, height: m.height, space: m.space, channels: m.channels, depth: m.depth,
      has_alpha: m.hasAlpha, orientation: m.orientation ?? null, density: m.density ?? null, is_progressive: m.isProgressive ?? null,
      chroma_subsampling: m.chromaSubsampling ?? null, compression: m.compression ?? null,
      exif_bytes: m.exif?.length ?? 0, xmp_bytes: m.xmp?.length ?? 0, iptc_bytes: m.iptc?.length ?? 0, icc_bytes: m.icc?.length ?? 0,
    };
  } catch (e) {
    res.metadata_error = String(e.message ?? e);
  }
  try {
    const st = await sharp(buf, { failOn: 'error' }).stats();
    res.full_decode = { ok: true, channels_decoded: st.channels.length, is_opaque: st.isOpaque };
  } catch (e) {
    res.full_decode = { ok: false, error: String(e.message ?? e) };
  }
  return res;
}

const GPS_COORDINATE_TAGS = ['GPSLatitude', 'GPSLongitude', 'GPSAltitude', 'GPSTimeStamp', 'GPSImgDirection', 'GPSHPositioningError'];

export async function run() {
  const includeGps = process.env.CABIN_KIT_INCLUDE_GPS === '1';
  const out = {};
  for (const o of ORIGINALS.filter((x) => x.group === 'image')) {
    let buf;
    try { buf = readOriginal(o.name); } catch (e) { out[o.name] = { read_error: String(e.message ?? e) }; continue; }
    const own = describeImage(buf);
    if (own.gps_data_present && !includeGps) {
      // Precise location values are withheld from the evidence output by default; presence and tag names are kept.
      const redacted = [];
      for (const tag of GPS_COORDINATE_TAGS) {
        if (tag in own.exif.gps) { own.exif.gps[tag] = '[withheld: value present in the file]'; redacted.push(tag); }
      }
      own.gps_values_withheld = { tags: redacted, reason: 'precise location data is not needed for this evidence stage; set CABIN_KIT_INCLUDE_GPS=1 to include the values' };
      own.text_metadata_strings = own.text_metadata_strings.filter((t) => !(t.source === 'EXIF.GPS' && GPS_COORDINATE_TAGS.includes(t.field)));
    }
    const sc = await sharpCheck(buf);
    own.cross_check = {
      ...sc,
      dimensions_agree: sc.metadata ? sc.metadata.width === own.pixel_width && sc.metadata.height === own.pixel_height : null,
    };
    out[o.name] = own;
  }
  return out;
}
