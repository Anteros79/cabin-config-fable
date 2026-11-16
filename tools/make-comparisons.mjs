// Builds side-by-side comparison sheets: a supplied original (left) and an actual render of this
// build (right). Output: verification/comparisons/*.jpg. Originals are only read.
//   node tools/make-comparisons.mjs [--stamp]
// The sheets are rendered into a temporary folder next to the output and swapped in only when every sheet rendered;
// a failed run leaves the previous output untouched. index.json carries `generatedAt` only with --stamp, so a plain
// run on unchanged inputs writes the same bytes.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { parseCliArgs, UsageError } from "../src/importer/args.ts";
import { resolveImageRoot } from "../src/importer/originals.ts";

let stamp;
try {
  stamp = parseCliArgs(process.argv.slice(2), { stamp: { type: "boolean" } }).stamp === true;
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error(`${e.message}\nUsage: node tools/make-comparisons.mjs [--stamp]`);
  process.exit(64);
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolveImageRoot();
const captures = join(projectRoot, "verification", "captures");
const out = join(projectRoot, "verification", "comparisons");
const staging = `${out}.tmp-${process.pid}`;
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

const PAIRS = [
  {
    id: "01-seat-front-band-neutral",
    original: "recarro 2.jpg",
    capture: "seat-front_photo-navy-band_neutral.png",
    topic: "Seat front, banded navy family, daylight / neutral light",
  },
  {
    id: "02-seat-front-band-blue",
    original: "seats 1.jpeg",
    capture: "seat-front_photo-navy-band_blue.png",
    topic: "Seat front and arms, banded navy family, blue cabin light",
  },
  {
    id: "03-seat-front-plain-blue",
    original: "seats 5.jpg",
    capture: "seat-front_photo-navy-plain_blue.png",
    topic: "Seat front, navy family without band, blue cabin light",
  },
  {
    id: "04-seat-front-concept",
    original: "Southwest-Airlines-new-RECARO-seats-Video-still-Southwest.png",
    capture: "seat-front_concept-gray_neutral.png",
    topic: "Seat front, concept/render gray treatment",
  },
  {
    id: "05-seat-front-concept-wide",
    original: "seats 8.jpg",
    capture: "seat-front_concept-gray_neutral.png",
    topic: "Seats and arms, concept/render gray treatment",
  },
  {
    id: "06-seat-rear-neutral",
    original: "southwest seats-7.webp",
    capture: "seat-rear_photo-navy-band_neutral.png",
    topic: "Seat rear shells and aisle carpet",
  },
  { id: "07-seat-rear-blue", original: "seats 3.jpg", capture: "seat-rear_photo-navy-band_blue.png", topic: "Seat rear furniture close-up, blue cabin light" },
  { id: "08-carpet", original: "carpet.jpg", capture: "carpet_photo-navy-band_neutral.png", topic: "Carpet pattern and aisle borders from above" },
  {
    id: "09-bins-blue",
    original: "seats 4.jpg",
    capture: "bin-detail_photo-navy-band_blue.png",
    topic: "Overhead bins, underside and seat profile, blue cabin light",
  },
  {
    id: "10-cabin-aisle-neutral",
    original: "seats 2 .jpeg",
    capture: "full-cabin-aisle_photo-navy-band_neutral.png",
    topic: "Cabin looking aft along the aisle",
  },
  {
    id: "11-cabin-aisle-blue",
    original: "southwest seats-7.webp",
    capture: "full-cabin-aisle_photo-navy-band_blue.png",
    topic: "Cabin and bins, blue cabin light (original looks forward at seat backs)",
  },
  {
    id: "12-headrest-plain-neutral",
    original: "seats 6.avif",
    capture: "seat-front_photo-navy-plain_neutral.png",
    topic: "Headrests, navy family without band",
  },
];

const W = 760;
const H = 500;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const label = (text, width) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="34"><rect width="100%" height="100%" fill="#141a2e"/><text x="10" y="22" font-family="Helvetica, Arial, sans-serif" font-size="15" fill="#ffffff">${esc(text)}</text></svg>`,
  );

const index = [];
try {
  for (const pair of PAIRS) {
    const left = await sharp(readFileSync(join(sourceRoot, pair.original)))
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize(W, H, { fit: "contain", background: "#20232e" })
      .toBuffer();
    const right = await sharp(readFileSync(join(captures, pair.capture)))
      .flatten({ background: "#ffffff" })
      .resize(W, H, { fit: "contain", background: "#20232e" })
      .toBuffer();
    const file = `${pair.id}.jpg`;
    await sharp({ create: { width: W * 2 + 12, height: H + 34 + 34, channels: 3, background: "#ffffff" } })
      .composite([
        { input: label(pair.topic, W * 2 + 12), left: 0, top: 0 },
        { input: label(`Supplied original: ${pair.original}`, W), left: 0, top: 34 },
        { input: label(`This build: ${pair.capture}`, W), left: W + 12, top: 34 },
        { input: left, left: 0, top: 68 },
        { input: right, left: W + 12, top: 68 },
      ])
      .jpeg({ quality: 88 })
      .toFile(join(staging, file));
    index.push({ file, ...pair });
  }
  writeFileSync(
    join(staging, "index.json"),
    JSON.stringify(
      {
        note: "Left: supplied original (read only, resized for the sheet). Right: actual render of this build.",
        ...(stamp ? { generatedAt: new Date().toISOString() } : {}),
        sheets: index,
      },
      null,
      2,
    ) + "\n",
  );
  // Every sheet rendered: swap the folder in.
  const previous = `${out}.old-${process.pid}`;
  rmSync(previous, { recursive: true, force: true });
  try {
    renameSync(out, previous);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  renameSync(staging, out);
  rmSync(previous, { recursive: true, force: true });
} catch (e) {
  rmSync(staging, { recursive: true, force: true });
  throw e;
}
console.log(`${index.length} comparison sheets written to ${out}`);
