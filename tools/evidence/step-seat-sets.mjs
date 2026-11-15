// Candidate seat sets per lopa_id, derived only from the populated registry records.
// "Candidate" = an unverified registry export; nothing here is an approved layout.
import { F, sha256, writeJson, writeText, mdTable, code, DISCLAIMER } from './lib/common.mjs';
import { loadSources } from './lib/sources.mjs';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const LEFT = ['A', 'B', 'C'];
const RIGHT = ['D', 'E', 'F'];
const TIERS = ['Extra Legroom', 'Preferred', 'Standard'];

function ranges(nums) {
  const out = [];
  let start = null;
  let prev = null;
  for (const n of nums) {
    if (start === null) { start = n; prev = n; continue; }
    if (n === prev + 1) { prev = n; continue; }
    out.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = n; prev = n;
  }
  if (start !== null) out.push(start === prev ? `${start}` : `${start}–${prev}`);
  return out.join(', ');
}

export function run(ctx) {
  const s = loadSources();
  const reg = s.registry;
  const sets = reg.lopa_configurations.map((cfg, cfgIdx) => {
    const id = cfg.lopa_id;
    const rowRecs = reg.lopa_rows.map((r, i) => ({ r, i })).filter((x) => x.r.lopa_id === id);
    const seatRecs = reg.lopa_seats.map((x, i) => ({ s: x, i })).filter((x) => x.s.lopa_id === id);
    const rowsAscending = rowRecs.every((x, k) => k === 0 || x.r.row_number > rowRecs[k - 1].r.row_number);
    const existing = rowRecs.filter((x) => x.r.row_exists === true);
    const nonExisting = rowRecs.filter((x) => x.r.row_exists !== true);
    const physical = new Map(existing.map((x, k) => [x.r.row_number, k + 1]));

    const seatsByRow = new Map();
    for (const x of seatRecs) {
      if (!seatsByRow.has(x.s.row_number)) seatsByRow.set(x.s.row_number, []);
      seatsByRow.get(x.s.row_number).push(x);
    }
    const seatIssues = [];
    for (const x of seatRecs) {
      if (x.s.seat_code !== `${x.s.row_number}${x.s.seat_letter}`) seatIssues.push({ issue: 'seat_code is not row_number + seat_letter', locator: s.loc.json('lopa_seats', x.i, 'seat_code'), value: x.s.seat_code });
      if (!LETTERS.includes(x.s.seat_letter)) seatIssues.push({ issue: 'seat letter outside A–F', locator: s.loc.json('lopa_seats', x.i, 'seat_letter'), value: x.s.seat_letter });
      const expectedPos = { A: 'Window', F: 'Window', B: 'Middle', E: 'Middle', C: 'Aisle', D: 'Aisle' }[x.s.seat_letter];
      if (expectedPos && x.s.seat_position_type !== expectedPos) seatIssues.push({ issue: 'seat_position_type does not follow the A/F window, B/E middle, C/D aisle pattern', locator: s.loc.json('lopa_seats', x.i, 'seat_position_type'), value: x.s.seat_position_type });
      if (!rowRecs.some((r) => r.r.row_number === x.s.row_number)) seatIssues.push({ issue: 'seat on a row label with no row record', locator: s.loc.json('lopa_seats', x.i), value: x.s.seat_code });
      if (!TIERS.includes(x.s.commercial_tier)) seatIssues.push({ issue: 'unexpected commercial tier value', locator: s.loc.json('lopa_seats', x.i, 'commercial_tier'), value: x.s.commercial_tier });
    }

    const rowLevelMismatches = [];
    const rows = rowRecs.map(({ r, i }) => {
      const seats = seatsByRow.get(r.row_number) ?? [];
      const letters = seats.map((x) => x.s.seat_letter);
      const computedOmitted = r.row_exists === true ? LETTERS.filter((l) => !letters.includes(l)) : LETTERS.slice();
      const declaredOmitted = r.omitted_seat_letters === '' ? [] : String(r.omitted_seat_letters).split(',');
      const countOk = r.active_seat_count === seats.length;
      const omittedOk = JSON.stringify(computedOmitted) === JSON.stringify(declaredOmitted);
      if (!countOk) rowLevelMismatches.push({ row_label: String(r.row_number), check: 'active_seat_count', row_value: r.active_seat_count, counted_seat_records: seats.length, locator: s.loc.json('lopa_rows', i, 'active_seat_count') });
      if (!omittedOk) rowLevelMismatches.push({ row_label: String(r.row_number), check: 'omitted_seat_letters', row_value: r.omitted_seat_letters, computed_from_seat_records: computedOmitted.join(','), locator: s.loc.json('lopa_rows', i, 'omitted_seat_letters') });
      if (r.row_exists !== true && seats.length > 0) rowLevelMismatches.push({ row_label: String(r.row_number), check: 'row_exists=false but seat records present', counted_seat_records: seats.length, locator: s.loc.json('lopa_rows', i, 'row_exists') });
      const tierOf = (block) => [...new Set(seats.filter((x) => block.includes(x.s.seat_letter)).map((x) => x.s.commercial_tier))];
      const pitchOf = (block) => [...new Set(seats.filter((x) => block.includes(x.s.seat_letter)).map((x) => x.s.pitch_range_inches))];
      const leftTiers = tierOf(LEFT);
      const rightTiers = tierOf(RIGHT);
      const split = leftTiers.length > 0 && rightTiers.length > 0 && JSON.stringify(leftTiers.slice().sort()) !== JSON.stringify(rightTiers.slice().sort());
      return {
        printed_row_label: String(r.row_number),
        row_number_source_value: r.row_number,
        row_exists: r.row_exists,
        physical_row_order: physical.get(r.row_number) ?? null,
        seat_codes: seats.map((x) => x.s.seat_code),
        seat_letters_present: letters,
        seat_count: seats.length,
        omitted_seat_letters_computed: computedOmitted,
        omitted_seat_codes_computed: r.row_exists === true ? computedOmitted.map((l) => `${r.row_number}${l}`) : [],
        row_record: { active_seat_count: r.active_seat_count, omitted_seat_letters: r.omitted_seat_letters, locator: s.loc.json('lopa_rows', i) },
        row_record_agrees_with_seat_records: countOk && omittedOk,
        block_ABC: { tiers: leftTiers, pitch_claims: pitchOf(LEFT) },
        block_DEF: { tiers: rightTiers, pitch_claims: pitchOf(RIGHT) },
        mixed_tier_within_one_block: leftTiers.length > 1 || rightTiers.length > 1,
        left_right_tier_split: split,
        tiers_in_row: [...new Set(seats.map((x) => x.s.commercial_tier))],
      };
    });

    const tierCounts = Object.fromEntries(TIERS.map((t) => [t, seatRecs.filter((x) => x.s.commercial_tier === t).length]));
    const otherTiers = seatRecs.filter((x) => !TIERS.includes(x.s.commercial_tier)).length;
    const orderedSeatCodes = seatRecs.map((x) => x.s.seat_code);
    const declared = { total_seats: cfg.total_seats, extra_legroom_seats: cfg.extra_legroom_seats, preferred_seats: cfg.preferred_seats, standard_seats: cfg.standard_seats };
    const counted = { total_seats: seatRecs.length, extra_legroom_seats: tierCounts['Extra Legroom'], preferred_seats: tierCounts.Preferred, standard_seats: tierCounts.Standard };
    const declaredChecks = Object.keys(declared).map((k) => ({ field: k, declared: declared[k], counted: counted[k], agrees: declared[k] === counted[k], locator: s.loc.json('lopa_configurations', cfgIdx, k) }));

    // compact description of letters per row range
    const groups = [];
    for (const r of rows.filter((x) => x.row_exists === true)) {
      const sig = r.seat_letters_present.join('');
      const last = groups.at(-1);
      if (last && last.sig === sig && Number(r.printed_row_label) === last.end + 1) last.end = Number(r.printed_row_label);
      else groups.push({ sig, start: Number(r.printed_row_label), end: Number(r.printed_row_label) });
    }

    return {
      lopa_id: id,
      status: 'candidate — unverified registry export; not an approved layout',
      configuration: cfg,
      configuration_locator: s.loc.json('lopa_configurations', cfgIdx),
      row_records: rowRecs.length,
      row_records_in_ascending_label_order: rowsAscending,
      printed_row_labels_existing: existing.map((x) => String(x.r.row_number)),
      printed_row_labels_existing_ranges: ranges(existing.map((x) => x.r.row_number)),
      printed_row_labels_row_exists_false: nonExisting.map((x) => String(x.r.row_number)),
      existing_row_count: existing.length,
      physical_row_order: existing.map((x, k) => ({ physical_order: k + 1, printed_row_label: String(x.r.row_number) })),
      physical_order_basis: 'ASSUMPTION: existing rows taken in ascending printed-label order = forward to aft. No station, coordinate or explicit physical index is supplied.',
      seat_letters_used: [...new Set(seatRecs.map((x) => x.s.seat_letter))].sort(),
      letters_by_row_range: groups.map((g) => ({ rows: g.start === g.end ? `${g.start}` : `${g.start}–${g.end}`, letters: g.sig })),
      omitted_seat_codes_on_existing_rows: rows.flatMap((r) => r.omitted_seat_codes_computed),
      total_seat_count: seatRecs.length,
      tier_totals: tierCounts,
      seats_with_other_tier_values: otherTiers,
      declared_vs_counted: declaredChecks,
      declared_totals_agree: declaredChecks.every((c) => c.agrees),
      declared_tier_sum_equals_declared_total: cfg.extra_legroom_seats + cfg.preferred_seats + cfg.standard_seats === cfg.total_seats,
      row_level_checks: { rows_checked: rows.length, mismatches: rowLevelMismatches, all_agree: rowLevelMismatches.length === 0 },
      seat_record_issues: seatIssues,
      split_tier_rows: rows.filter((r) => r.left_right_tier_split).map((r) => ({ printed_row_label: r.printed_row_label, block_ABC: r.block_ABC, block_DEF: r.block_DEF })),
      rows_with_mixed_tier_inside_one_block: rows.filter((r) => r.mixed_tier_within_one_block).map((r) => r.printed_row_label),
      ordered_seat_codes: orderedSeatCodes,
      seat_set_sha256: sha256(Buffer.from(orderedSeatCodes.join(','), 'utf8')),
      rows,
    };
  });

  const groupsBySignature = {};
  for (const st of sets) (groupsBySignature[st.seat_set_sha256] ??= []).push(st.lopa_id);
  const pairwise = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = new Set(sets[i].ordered_seat_codes);
      const b = new Set(sets[j].ordered_seat_codes);
      pairwise.push({
        a: sets[i].lopa_id, b: sets[j].lopa_id,
        identical_seat_code_set: sets[i].seat_set_sha256 === sets[j].seat_set_sha256,
        only_in_a: [...a].filter((x) => !b.has(x)),
        only_in_b: [...b].filter((x) => !a.has(x)),
      });
    }
  }

  const out = {
    purpose: 'Candidate seat sets per lopa_id from the populated registry. Identity of a seat = lopa_id + printed row label + letter.',
    source: F.REGISTRY_JSON,
    note: 'The CSV/XLSX exports carry the same records (see cross-format-comparison.json); that agreement is not independent verification.',
    totals: {
      configurations: sets.length,
      row_records: reg.lopa_rows.length,
      row_records_row_exists_false: reg.lopa_rows.filter((r) => r.row_exists !== true).length,
      row_records_row_exists_true: reg.lopa_rows.filter((r) => r.row_exists === true).length,
      seat_records: reg.lopa_seats.length,
      seat_records_sum_of_sets: sets.reduce((n, x) => n + x.total_seat_count, 0),
    },
    identical_seat_code_sets: Object.values(groupsBySignature),
    pairwise_seat_code_differences: pairwise,
    seat_sets: sets,
  };
  ctx.written.push(writeJson('candidate-seat-sets.json', out));

  const md = [];
  md.push('# Candidate seat sets (from the populated registry)');
  md.push('');
  md.push(`> ${DISCLAIMER}`);
  md.push('');
  md.push(`Source: \`${F.REGISTRY_JSON}\`. Every set is a **candidate**: an unverified registry export, not an approved layout. Seat identity = \`lopa_id\` + printed row label + letter.`);
  md.push('');
  md.push(`Totals: **${out.totals.configurations}** configurations, **${out.totals.row_records}** row records (${out.totals.row_records_row_exists_true} existing + ${out.totals.row_records_row_exists_false} with \`row_exists=false\`), **${out.totals.seat_records}** seat records.`);
  md.push('');
  md.push(mdTable(
    ['lopa_id', 'boeing_model', 'configuration_name', 'Seats counted', 'Declared `total_seats`', 'Existing printed labels', '`row_exists=false` labels', 'Omitted seat codes on existing rows'],
    sets.map((x) => [code(x.lopa_id), x.configuration.boeing_model, x.configuration.configuration_name, x.total_seat_count, x.configuration.total_seats, `${x.printed_row_labels_existing_ranges} (${x.existing_row_count} rows)`, x.printed_row_labels_row_exists_false.join(', ') || 'none', x.omitted_seat_codes_on_existing_rows.join(', ') || 'none']),
  ));
  md.push('');
  md.push('## Tier totals (counted from seat records vs declared in the configuration record)');
  md.push('');
  md.push(mdTable(
    ['lopa_id', 'Extra Legroom counted / declared', 'Preferred counted / declared', 'Standard counted / declared', 'Declared totals agree', 'Row records agree with seat records'],
    sets.map((x) => [code(x.lopa_id), `${x.tier_totals['Extra Legroom']} / ${x.configuration.extra_legroom_seats}`, `${x.tier_totals.Preferred} / ${x.configuration.preferred_seats}`, `${x.tier_totals.Standard} / ${x.configuration.standard_seats}`, x.declared_totals_agree ? 'yes' : 'NO', x.row_level_checks.all_agree ? `yes (${x.row_level_checks.rows_checked} rows)` : `NO (${x.row_level_checks.mismatches.length} mismatches)`]),
  ));
  md.push('');
  md.push('## Seat letters by printed row label');
  md.push('');
  md.push(mdTable(['lopa_id', 'Letters present per printed row label (existing rows)'],
    sets.map((x) => [code(x.lopa_id), x.letters_by_row_range.map((g) => `${g.rows}: ${g.letters}`).join('; ')])));
  md.push('');
  md.push('## Rows where the A/B/C block and the D/E/F block carry different commercial tiers');
  md.push('');
  const splitRows = sets.flatMap((x) => x.split_tier_rows.map((r) => [code(x.lopa_id), r.printed_row_label, r.block_ABC.tiers.join(' + '), r.block_ABC.pitch_claims.map(code).join(', '), r.block_DEF.tiers.join(' + '), r.block_DEF.pitch_claims.map(code).join(', ')]));
  md.push(splitRows.length ? mdTable(['lopa_id', 'Printed row', 'A/B/C tier', 'A/B/C pitch claim', 'D/E/F tier', 'D/E/F pitch claim'], splitRows) : 'None found.');
  md.push('');
  md.push('## Physical row order');
  md.push('');
  md.push('Physical order 1..n is assigned to existing rows in ascending printed-label order. **This is an assumption**: no station, coordinate or explicit physical index is supplied.');
  md.push('');
  md.push(mdTable(['lopa_id', 'Physical rows', 'Mapping (physical → printed label)'],
    sets.map((x) => {
      const diff = x.physical_row_order.filter((p) => String(p.physical_order) !== p.printed_row_label);
      const text = diff.length === 0 ? 'identical (physical n = printed n)' : `1–${x.physical_row_order.length - diff.length} identical; then ${diff[0].physical_order}→${diff[0].printed_row_label} … ${diff.at(-1).physical_order}→${diff.at(-1).printed_row_label} (printed = physical + ${Number(diff[0].printed_row_label) - diff[0].physical_order})`;
      return [code(x.lopa_id), x.physical_row_order.length, text];
    })));
  md.push('');
  md.push('## Identical and differing seat-code sets');
  md.push('');
  md.push(mdTable(['Group of lopa_ids with identical ordered seat-code lists', 'Seats'], out.identical_seat_code_sets.map((g) => [g.map(code).join(', '), sets.find((x) => x.lopa_id === g[0]).total_seat_count])));
  md.push('');
  md.push(mdTable(['A', 'B', 'Only in A', 'Only in B'],
    pairwise.filter((p) => !p.identical_seat_code_set && p.only_in_a.length + p.only_in_b.length <= 12).map((p) => [code(p.a), code(p.b), p.only_in_a.join(', ') || '—', p.only_in_b.join(', ') || '—'])));
  md.push('');
  const issues = sets.reduce((n, x) => n + x.seat_record_issues.length, 0);
  md.push(`Seat-record consistency issues (seat_code ≠ row+letter, letter outside A–F, position pattern, unknown tier, seat on missing row): **${issues}**.`);
  md.push('');
  md.push('Full per-row seat codes: `candidate-seat-sets.json`.');
  ctx.written.push(writeText('candidate-seat-sets.md', md.join('\n')));
  return out;
}
