#!/usr/bin/env node
// Regenerates every machine-generated evidence output from the original files.
//   node tools/evidence/build-all.mjs
// Source root: ../../ relative to the working project, or env CABIN_KIT_SOURCE_ROOT.
// Set CABIN_KIT_SKIP_NETWORK=1 to skip the public-hyperlink reachability check.
import { SOURCE_ROOT, EVIDENCE_DIR, ORIGINALS, sha256OfFileOnDisk } from './lib/common.mjs';

const STEPS = [
  ['jsonCompare', './step-json-compare.mjs'],
  ['csv', './step-csv-metadata.mjs'],
  ['workbook', './step-workbook.mjs'],
  ['rtf', './step-rtf.mjs'],
  ['docx', './step-docx.mjs'],
  ['hyperlinks', './step-hyperlinks.mjs'],
  ['crossFormat', './step-cross-format.mjs'],
  ['seatSets', './step-seat-sets.mjs'],
  ['crosswalk', './step-crosswalk.mjs'],
  ['images', './step-images.mjs'],
  ['conflicts', './step-conflicts.mjs'],
  ['inventory', './step-inventory.mjs'],
  ['expectations', './step-expectations.mjs'],
];

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  console.log(`source root : ${SOURCE_ROOT}`);
  console.log(`evidence dir: ${EVIDENCE_DIR}`);

  // hash every original straight from disk before anything is parsed
  const hashesBefore = {};
  const missing = [];
  for (const o of ORIGINALS) {
    try { hashesBefore[o.name] = sha256OfFileOnDisk(o.name); } catch (e) { missing.push(o.name); hashesBefore[o.name] = null; }
  }
  if (missing.length) console.warn(`WARNING: ${missing.length} expected original(s) not readable: ${missing.join(', ')}`);

  const ctx = { results: {}, written: [], hashesBefore, startedAt: new Date().toISOString(), warnings: [] };
  for (const [name, path] of STEPS) {
    if (only.length && !only.includes(name)) continue;
    const mod = await import(path);
    const t0 = Date.now();
    ctx.results[name] = await mod.run(ctx);
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  }
  console.log(`\nwrote ${ctx.written.length} files under evidence/:`);
  for (const f of ctx.written) console.log(`  evidence/${f}`);
  if (ctx.warnings.length) {
    console.log('\nwarnings:');
    for (const w of ctx.warnings) console.log(`  ! ${w}`);
  }
  // last action: re-hash every original once more, after every output has been written
  const changed = ORIGINALS.filter((o) => {
    try { return sha256OfFileOnDisk(o.name) !== hashesBefore[o.name]; } catch { return true; }
  }).map((o) => o.name);
  console.log(`\nfinal integrity re-hash at ${new Date().toISOString()}: ${ORIGINALS.length - changed.length} of ${ORIGINALS.length} originals unchanged`);
  if (changed.length) ctx.failed = `originals changed or unreadable: ${changed.join(', ')}`;

  if (ctx.failed) {
    console.error(`\nFAILED: ${ctx.failed}`);
    process.exitCode = 1;
  } else {
    console.log('build-all: OK');
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
