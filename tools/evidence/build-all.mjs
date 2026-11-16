#!/usr/bin/env node
// Regenerates every machine-generated evidence output from the original files.
//   node tools/evidence/build-all.mjs [--online] [step ...]
// With step names, only those steps run; a step that needs the result of another one fails fast, naming it.
// Source root: ../../ relative to the working project, or env CABIN_KIT_SOURCE_ROOT.
// Network access is off unless --online is passed (then the public-hyperlink reachability check runs).
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SOURCE_ROOT, EVIDENCE_DIR, ORIGINALS, sha256OfFileOnDisk } from './lib/common.mjs';

/** Each step names the steps whose results it reads (`needs`); dependencies run first, in this order. */
export const STEPS = [
  { name: 'jsonCompare', path: './step-json-compare.mjs', needs: [] },
  { name: 'csv', path: './step-csv-metadata.mjs', needs: [] },
  { name: 'workbook', path: './step-workbook.mjs', needs: [] },
  { name: 'rtf', path: './step-rtf.mjs', needs: [] },
  { name: 'docx', path: './step-docx.mjs', needs: [] },
  { name: 'hyperlinks', path: './step-hyperlinks.mjs', needs: ['docx', 'rtf'] },
  { name: 'crossFormat', path: './step-cross-format.mjs', needs: [] },
  { name: 'seatSets', path: './step-seat-sets.mjs', needs: [] },
  { name: 'crosswalk', path: './step-crosswalk.mjs', needs: [] },
  { name: 'images', path: './step-images.mjs', needs: [] },
  { name: 'conflicts', path: './step-conflicts.mjs', needs: ['jsonCompare', 'crossFormat', 'crosswalk', 'hyperlinks', 'docx'] },
  { name: 'inventory', path: './step-inventory.mjs', needs: ['jsonCompare', 'csv', 'workbook', 'rtf', 'docx', 'crossFormat', 'images'] },
  {
    name: 'expectations',
    path: './step-expectations.mjs',
    needs: ['jsonCompare', 'csv', 'workbook', 'rtf', 'docx', 'hyperlinks', 'crossFormat', 'seatSets', 'conflicts', 'inventory', 'images'],
  },
];

/** The steps to run for a request: all of them when `requested` is empty. Throws an Error naming an unknown or an omitted step. */
export function planSteps(requested) {
  const known = new Set(STEPS.map((s) => s.name));
  const unknown = requested.filter((n) => !known.has(n));
  if (unknown.length) throw new Error(`unknown step(s): ${unknown.join(', ')}. Steps: ${[...known].join(', ')}`);
  if (requested.length === 0) return STEPS;
  const chosen = new Set(requested);
  const plan = STEPS.filter((s) => chosen.has(s.name));
  for (const step of plan) {
    const omitted = step.needs.filter((n) => !chosen.has(n));
    if (omitted.length) throw new Error(`step "${step.name}" needs the result of "${omitted.join('", "')}"; add ${omitted.length === 1 ? 'it' : 'them'} to the requested steps (or run without step names).`);
  }
  return plan;
}

async function main() {
  let parsed;
  let plan;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: { online: { type: 'boolean' } }, strict: true, allowPositionals: true });
    plan = planSteps(parsed.positionals);
  } catch (e) {
    console.error(`${e.message}\nUsage: node tools/evidence/build-all.mjs [--online] [step ...]`);
    process.exitCode = 64;
    return;
  }
  console.log(`network     : ${parsed.values.online ? 'on (--online)' : 'off'}`);
  console.log(`source root : ${SOURCE_ROOT}`);
  console.log(`evidence dir: ${EVIDENCE_DIR}`);

  // hash every original straight from disk before anything is parsed
  const hashesBefore = {};
  const missing = [];
  for (const o of ORIGINALS) {
    try { hashesBefore[o.name] = sha256OfFileOnDisk(o.name); } catch (e) { missing.push(o.name); hashesBefore[o.name] = null; }
  }
  if (missing.length) console.warn(`WARNING: ${missing.length} expected original(s) not readable: ${missing.join(', ')}`);

  const ctx = { results: {}, written: [], hashesBefore, startedAt: new Date().toISOString(), warnings: [], online: parsed.values.online === true };
  for (const { name, path } of plan) {
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

const isEntryPoint = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
