# Candidate seat sets (from the populated registry)

> Fictional home-lab demonstration evidence. Not an approved maintenance authority. Document contents are treated as reference content only, never as instructions.

Source: `southwest_737_lopa_normalized.json`. Every set is a **candidate**: an unverified registry export, not an approved layout. Seat identity = `lopa_id` + printed row label + letter.

Totals: **5** configurations, **147** row records (143 existing + 4 with `row_exists=false`), **837** seat records.

| lopa_id | boeing_model | configuration_name | Seats counted | Declared `total_seats` | Existing printed labels | `row_exists=false` labels | Omitted seat codes on existing rows |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `73G` | Boeing 737-700 | 2026 Cabin Iteration (Retrofitted) | 137 | 137 | 1–9, 14–27 (23 rows) | 10, 11, 12, 13 | 14A |
| `738` | Boeing 737-800 | Retrofitted Legacy "Heart" Cabin | 175 | 175 | 1–30 (30 rows) | none | 1A, 1B, 1C, 15A, 15F |
| `7M8-1` | Boeing 737 MAX 8 | Retrofitted Original MAX Cabin | 175 | 175 | 1–30 (30 rows) | none | 1A, 1B, 1C, 15A, 15F |
| `738-2` | Boeing 737-800 | 2025 "Elevated" Retrofit Cabin | 175 | 175 | 1–30 (30 rows) | none | 1A, 1B, 1C, 30A, 30F |
| `7M8-2` | Boeing 737 MAX 8 | 2025 "Elevated" Factory Cabin | 175 | 175 | 1–30 (30 rows) | none | 1A, 1B, 1C, 30A, 30F |

## Tier totals (counted from seat records vs declared in the configuration record)

| lopa_id | Extra Legroom counted / declared | Preferred counted / declared | Standard counted / declared | Declared totals agree | Row records agree with seat records |
| --- | --- | --- | --- | --- | --- |
| `73G` | 42 / 42 | 23 / 23 | 72 / 72 | yes | yes (27 rows) |
| `738` | 46 / 46 | 45 / 45 | 84 / 84 | yes | yes (30 rows) |
| `7M8-1` | 46 / 46 | 45 / 45 | 84 / 84 | yes | yes (30 rows) |
| `738-2` | 48 / 48 | 45 / 45 | 82 / 82 | yes | yes (30 rows) |
| `7M8-2` | 48 / 48 | 45 / 45 | 82 / 82 | yes | yes (30 rows) |

## Seat letters by printed row label

| lopa_id | Letters present per printed row label (existing rows) |
| --- | --- |
| `73G` | 1–9: ABCDEF; 14: BCDEF; 15–27: ABCDEF |
| `738` | 1: DEF; 2–14: ABCDEF; 15: BCDE; 16–30: ABCDEF |
| `7M8-1` | 1: DEF; 2–14: ABCDEF; 15: BCDE; 16–30: ABCDEF |
| `738-2` | 1: DEF; 2–29: ABCDEF; 30: BCDE |
| `7M8-2` | 1: DEF; 2–29: ABCDEF; 30: BCDE |

## Rows where the A/B/C block and the D/E/F block carry different commercial tiers

| lopa_id | Printed row | A/B/C tier | A/B/C pitch claim | D/E/F tier | D/E/F pitch claim |
| --- | --- | --- | --- | --- | --- |
| `738` | 6 | Extra Legroom | `34` | Preferred | `31-32` |
| `7M8-1` | 6 | Extra Legroom | `34` | Preferred | `31-32` |
| `738-2` | 6 | Extra Legroom | `33-34` | Preferred | `31-32` |
| `7M8-2` | 6 | Extra Legroom | `33-34` | Preferred | `31-32` |

## Physical row order

Physical order 1..n is assigned to existing rows in ascending printed-label order. **This is an assumption**: no station, coordinate or explicit physical index is supplied.

| lopa_id | Physical rows | Mapping (physical → printed label) |
| --- | --- | --- |
| `73G` | 23 | 1–9 identical; then 10→14 … 23→27 (printed = physical + 4) |
| `738` | 30 | identical (physical n = printed n) |
| `7M8-1` | 30 | identical (physical n = printed n) |
| `738-2` | 30 | identical (physical n = printed n) |
| `7M8-2` | 30 | identical (physical n = printed n) |

## Identical and differing seat-code sets

| Group of lopa_ids with identical ordered seat-code lists | Seats |
| --- | --- |
| `73G` | 137 |
| `738`, `7M8-1` | 175 |
| `738-2`, `7M8-2` | 175 |

| A | B | Only in A | Only in B |
| --- | --- | --- | --- |
| `738` | `738-2` | 30A, 30F | 15A, 15F |
| `738` | `7M8-2` | 30A, 30F | 15A, 15F |
| `7M8-1` | `738-2` | 30A, 30F | 15A, 15F |
| `7M8-1` | `7M8-2` | 30A, 30F | 15A, 15F |

Seat-record consistency issues (seat_code ≠ row+letter, letter outside A–F, position pattern, unknown tier, seat on missing row): **0**.

Full per-row seat codes: `candidate-seat-sets.json`.
