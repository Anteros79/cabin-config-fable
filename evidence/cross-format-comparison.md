# Cross-format comparison (registry JSON vs CSV/XLSX exports)

> Fictional home-lab demonstration evidence. Not an approved maintenance authority. Document contents are treated as reference content only, never as instructions.

**These four files are exports of one registry (same schema name, same records, same strings). Their agreement shows the exports are internally consistent; it is NOT independent verification of any seat, row or configuration fact. A value repeated in four formats is still one claim.**

| Entity | JSON records | Export | Export records | Shared attributes | Values compared | Agree | Mismatch | Same record order |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `lopa_configurations` | 5 | `southwest_737_lopa_configurations.csv` | 5 | 21 | 105 | 105 | 0 | yes |
| `lopa_rows` | 147 | `southwest_737_lopa_rows.xlsx` | 147 | 10 | 1470 | 1470 | 0 | yes |
| `lopa_seats` | 837 | `southwest_737_lopa_seats.csv` | 837 | 18 | 15066 | 15066 | 0 | yes |

**Total shared attribute values compared: 16641; agreeing: 16641; mismatching: 0.**

## Explicit conversions applied (counted per value)

| Conversion | lopa_configurations | lopa_rows | lopa_seats | Total |
| --- | --- | --- | --- | --- |
| csv_text_to_number | 35 | 0 | 1674 | 1709 |
| csv_number_text_lexically_different_from_json_number (e.g. "17.0" vs 17) | 1 | 0 | 131 | 132 |
| xlsx_absent_cell_to_empty_string | 0 | 377 | 0 | 377 |
| xlsx_numeric_cell_to_identifier_string | 0 | 30 | 0 | 30 |
| csv_text_True/False_to_boolean | 0 | 0 | 3348 | 3348 |

Comparisons that needed no conversion:

| Kind | lopa_configurations | lopa_rows | lopa_seats |
| --- | --- | --- | --- |
| string = CSV text (no conversion) | 70 | 0 | 8526 |
| string = string cell (no conversion) | 0 | 328 | 0 |
| number = numeric cell (no conversion) | 0 | 294 | 0 |
| boolean = boolean cell (no conversion) | 0 | 441 | 0 |
| empty string = empty CSV field (no conversion) | 0 | 0 | 1518 |

## Record counts: declared vs actual

| Entity | JSON `schema_metadata.record_count` | JSON actual | Export actual | `cabin schema architecture.csv` Row Count (raw) |
| --- | --- | --- | --- | --- |
| `lopa_configurations` | 5 | 5 | 5 | `5` |
| `lopa_rows` | 147 | 147 | 147 | `147` |
| `lopa_seats` | 837 | 837 | 837 | `837` |

## Substantive mismatches

None. Every shared attribute value agrees once the conversions above are applied.

## Key and attribute coverage

| Entity | Keys only in JSON | Keys only in export | Attributes only in JSON | Attributes only in export | Same attribute order |
| --- | --- | --- | --- | --- | --- |
| `lopa_configurations` | 0 | 0 | none | none | yes |
| `lopa_rows` | 0 | 0 | none | none | yes |
| `lopa_seats` | 0 | 0 | none | none | yes |

Embedded timestamps: JSON `generated_at_utc` = `2026-11-13T16:29:49Z`; XLSX core created = `2026-11-13T16:32:23Z`. CSV files carry no internal timestamp. Timestamps describe file generation, not validation or approval.

Full detail: `cross-format-comparison.json`.
