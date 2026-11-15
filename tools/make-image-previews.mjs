// Creates faithful working previews of the supplied images.
// - evidence/image-previews/full/: lossless PNG decodes of the AVIF/WebP originals at native size.
// - evidence/image-previews/view/: downscaled JPEG copies of all 14 images for quick inspection.
// These are review-generated derivatives, not additional evidence. Originals are only read.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const sourceRoot = resolve(process.env.CABIN_KIT_SOURCE_ROOT ?? join(projectRoot, "..", ".."));
const outFull = join(projectRoot, "evidence", "image-previews", "full");
const outView = join(projectRoot, "evidence", "image-previews", "view");
mkdirSync(outFull, { recursive: true });
mkdirSync(outView, { recursive: true });

const images = [
  "Southwest-Airlines-new-RECARO-seats-Video-still-Southwest.png",
  "barrier.webp",
  "carpet.jpg",
  "forward galley flight deck.jpg",
  "rear galley.jpg",
  "recarro 2.jpg",
  "seats 1.jpeg",
  "seats 2 .jpeg",
  "seats 3.jpg",
  "seats 4.jpg",
  "seats 5.jpg",
  "seats 6.avif",
  "seats 8.jpg",
  "southwest seats-7.webp",
];

const manifest = [];
for (const name of images) {
  const bytes = readFileSync(join(sourceRoot, name));
  const meta = await sharp(bytes).metadata();
  const entry = {
    original: name,
    originalSha256: createHash("sha256").update(bytes).digest("hex"),
    format: meta.format,
    width: meta.width,
    height: meta.height,
    previews: [],
  };
  const base = name.replace(/\.[^.]+$/, "");
  if (meta.format === "heif" || meta.format === "avif" || meta.format === "webp") {
    const file = join("full", `${base}.png`);
    await sharp(bytes).png({ compressionLevel: 9 }).toFile(join(projectRoot, "evidence", "image-previews", file));
    entry.previews.push({ file, kind: "lossless decode at native size" });
  }
  const view = join("view", `${base}.jpg`);
  await sharp(bytes)
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize({ width: 1400, height: 1400, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 86 })
    .toFile(join(projectRoot, "evidence", "image-previews", view));
  entry.previews.push({ file: view, kind: "downscaled inspection copy (max 1400 px)" });
  manifest.push(entry);
}
writeFileSync(
  join(projectRoot, "evidence", "image-previews", "manifest.json"),
  JSON.stringify(
    {
      note: "Review-generated previews. Not independent evidence; every preview derives from the named original.",
      generatedAt: new Date().toISOString(),
      images: manifest,
    },
    null,
    2,
  ) + "\n",
);
console.log(`previews written for ${manifest.length} images`);
