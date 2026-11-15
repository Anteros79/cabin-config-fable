# Expectations check

> Fictional home-lab demonstration evidence. Not an approved maintenance authority. Document contents are treated as reference content only, never as instructions.

37 expectations from the brief: **34 CONFIRMED**, **2 DIFFERS**, **1 NOT VERIFIABLE**. "Expected" restates the brief; "Measured" comes only from the script outputs named in the last column (paths relative to `evidence/`).

| Id | Expectation (from the brief) | Expected | Measured actual | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| E01 | All originals are present: 9 documents/data files and 14 images (23) | 9 + 14 = 23 | 9 + 14 = 23 found; missing: 0; unexpected extra files: 0 | **CONFIRMED** | `inventory.json#/summary` |
| E02 | One forward-galley photo carries another airline's name in its metadata | another airline named in metadata | IPTC:2:25 Keywords = "American Airlines"; XMP:dc:subject = "American Airlines"; other fields: EXIF.IFD0:ImageDescription = "at LAX in Los Angeles, Thursday, August 27, 2015. Photo by Brandon Wade"; IPTC:2:5 ObjectName = "AA LAX Thursday"; IPTC:2:120 Caption-Abstract = "at LAX in Los Angeles, Thursday, August 27, 2015. Photo by Brandon Wade" | **CONFIRMED** | `inventory.json (entry "forward galley flight deck.jpg")` |
| E03 | "southwest 737 lopa normalized.json" is 548 bytes | 548 | 548 | **CONFIRMED** | `extracts/json-compare.json#/files` |
| E04 | "southwest 737 lopa normalized.json" and "gemini-code-1794587815855.json" are byte-identical | identical | byte_identical = true; sizes 548 / 548; SHA-256 881e1c40b1d259ec… / 881e1c40b1d259ec… | **CONFIRMED** | `extracts/json-compare.json#/pairwise` |
| E05 | Both are invalid JSON (templates) | do not parse | parses: false / false; first error at byte 492 (line 12, column 28): unexpected token ".", expected a JSON value | **CONFIRMED** | `extracts/json-compare.json#/files` |
| E06 | Both contain the literal `[ ... ]` | present | 3 / 3 occurrences (byte offsets 490, 514, 539) | **CONFIRMED** | `extracts/json-compare.json#/files` |
| E07 | Workbook numeric `738` converted to identifier string, roughly 30 times | ≈ 30 | 30 | **CONFIRMED** | `cross-format-comparison.json#/totals` |
| E08 | Blanks converted to empty strings, roughly 377 times | ≈ 377 | 377 (workbook cells absent where the JSON holds "") | **CONFIRMED** | `cross-format-comparison.json#/totals` |
| E09 | 16,641 shared attribute values agree in total | 16,641 agreeing | 16641 compared; 16641 agree; 0 mismatch | **CONFIRMED** | `cross-format-comparison.json#/totals` |
| E10 | The only conversions needed are the numeric identifier and the blanks | two conversion kinds | also needed for the CSV side (text is untyped): csv_text_to_number ×1709; csv_number_text_lexically_different_from_json_number (e.g. "17.0" vs 17) ×132; csv_text_True/False_to_boolean ×3348 | **DIFFERS** | `cross-format-comparison.json#/totals/explicit_conversions` |
| E11 | 5 configurations | 5 | 5 | **CONFIRMED** | `candidate-seat-sets.json#/totals` |
| E12 | 147 row records including 4 non-existent labels | 147 incl. 4 | 147 row records; 4 with row_exists=false; 143 existing | **CONFIRMED** | `candidate-seat-sets.json#/totals` |
| E13 | 837 seats | 837 | 837 | **CONFIRMED** | `candidate-seat-sets.json#/totals` |
| E14 | 73G = 137 seats | 137 | 137 | **CONFIRMED** | `candidate-seat-sets.json (73G)` |
| E15 | 73G printed labels 1–9 and 14–27 | 1–9, 14–27 | 1–9, 14–27 | **CONFIRMED** | `candidate-seat-sets.json (73G)` |
| E16 | 73G seats A–F except 14A | only 14A omitted | letters used ABCDEF; omitted on existing rows: 14A | **CONFIRMED** | `candidate-seat-sets.json (73G)` |
| E17 | 73G labels 10–13 non-existent | 10, 11, 12, 13 | 10, 11, 12, 13 | **CONFIRMED** | `candidate-seat-sets.json (73G)` |
| E18 | 738 = 175 seats, labels 1–30, A–F except 1A/1B/1C and 15A/15F | 175; 1–30; omit 1A, 1B, 1C, 15A, 15F | 175 seats; labels 1–30; omitted: 1A, 1B, 1C, 15A, 15F | **CONFIRMED** | `candidate-seat-sets.json (738)` |
| E19 | 7M8-1 = 175 seats, labels 1–30, A–F except 1A/1B/1C and 15A/15F | 175; 1–30; omit 1A, 1B, 1C, 15A, 15F | 175 seats; labels 1–30; omitted: 1A, 1B, 1C, 15A, 15F | **CONFIRMED** | `candidate-seat-sets.json (7M8-1)` |
| E20 | 738-2 = 175 seats, omitting 1A/1B/1C and 30A/30F, with 15A/15F present | 175; omit 1A, 1B, 1C, 30A, 30F; 15A and 15F present | 175 seats; labels 1–30; omitted: 1A, 1B, 1C, 30A, 30F; row 15 seats: 15A 15B 15C 15D 15E 15F | **CONFIRMED** | `candidate-seat-sets.json (738-2)` |
| E21 | 7M8-2 = 175 seats, omitting 1A/1B/1C and 30A/30F, with 15A/15F present | 175; omit 1A, 1B, 1C, 30A, 30F; 15A and 15F present | 175 seats; labels 1–30; omitted: 1A, 1B, 1C, 30A, 30F; row 15 seats: 15A 15B 15C 15D 15E 15F | **CONFIRMED** | `candidate-seat-sets.json (7M8-2)` |
| E22 | Tier totals (Extra Legroom / Preferred / Standard) 42/23/72, 46/45/84, 46/45/84, 48/45/82, 48/45/82 | 73G 42/23/72; 738 46/45/84; 7M8-1 46/45/84; 738-2 48/45/82; 7M8-2 48/45/82 | 73G 42/23/72; 738 46/45/84; 7M8-1 46/45/84; 738-2 48/45/82; 7M8-2 48/45/82 | **CONFIRMED** | `candidate-seat-sets.json#/seat_sets/*/tier_totals` |
| E23 | A row exists where the A/B/C block and the D/E/F block have different commercial tiers (e.g. row 6) | row 6 | 73G: none; 738: row 6 (Extra Legroom \| Preferred); 7M8-1: row 6 (Extra Legroom \| Preferred); 738-2: row 6 (Extra Legroom \| Preferred); 7M8-2: row 6 (Extra Legroom \| Preferred) | **CONFIRMED** | `candidate-seat-sets.json#/seat_sets/*/split_tier_rows` |
| E24 | The later DOCX describes four physical-layout categories, including an upgraded 138-seat 737-700 that is absent from the 5-record registry; the DOCX does not supply a complete 138-seat seat set. | finding present in the document text | C01: 10 located quotes/values, 5/5 checks pass | **CONFIRMED** | `conflict-register.json (C01)` |
| E25 | The DOCX says that in the 138-seat layout seats 7D/7E/7F/15B/15C have physical Extra Legroom spacing but are commercially Preferred; must not be applied to the 137-seat 73G. | finding present in the document text | C02: 14 located quotes/values, 3/3 checks pass | **CONFIRMED** | `conflict-register.json (C02)` |
| E26 | DOCX 34-inch larger-aircraft Extra Legroom pitch vs the registry's Elevate "33-37 (Row 14 ~37")" claim. | finding present in the document text | C03: 7 located quotes/values, 2/2 checks pass | **CONFIRMED** | `conflict-register.json (C03)` |
| E27 | RTF contradicting its own split Row 6 pitch. | finding present in the document text | C04: 13 located quotes/values, 1/1 checks pass | **CONFIRMED** | `conflict-register.json (C04)` |
| E28 | Row bulkhead flags with partial-side ambiguity (row-level flag vs seat-level flags when only one side is behind a bulkhead). | finding present in the document text | C05: 12 located quotes/values, 2/2 checks pass | **CONFIRMED** | `conflict-register.json (C05)` |
| E29 | Approximate pitches turned into falsely exact strings. | finding present in the document text | C06: 9 located quotes/values, 2/2 checks pass | **CONFIRMED** | `conflict-register.json (C06)` |
| E30 | Shoulder clearance vs seat width conflated in the width field(s). | finding present in the document text | C07: 12 located quotes/values, 2/2 checks pass | **CONFIRMED** | `conflict-register.json (C07)` |
| E31 | Temporary-layout rear-row wording that does not identify a specific seat to remove. | finding present in the document text | C08: 13 located quotes/values, 2/2 checks pass | **CONFIRMED** | `conflict-register.json (C08)` |
| E32 | No approved dated tail assignment, parts/applicability/substitute catalog, exact floor/bin map, coordinate frame, exact cabin height, or image-to-layout mapping is supplied; generated timestamps and titles do not fill those gaps. | finding present in the document text | C09: 8 located quotes/values, 8/8 checks pass | **CONFIRMED** | `conflict-register.json (C09)` |
| E33 | The DOCX is "later" than the populated registry | DOCX later | DOCX core created 2026-11-13T17:37:00Z; registry generated_at_utc 2026-11-13T16:29:49Z; XLSX core created 2026-11-13T16:32:23Z | **CONFIRMED** | `extracts/docx-metadata.json; cross-format-comparison.json#/embedded_timestamps` |
| E34 | The DOCX is "later" than the RTF and the CSV files | DOCX later | RTF \info group present: false; CSV files carry no internal timestamp — no internal date to compare | **NOT VERIFIABLE** | `extracts/rtf-paragraphs.json#/info_metadata` |
| E35 | The RTF carries `\info` metadata (named in the brief as an example of metadata to report) | \info fields | no \info group in the file; only header control words (rtf version, code page, cocoartf) | **DIFFERS** | `extracts/rtf-paragraphs.json#/info_metadata` |
| E36 | Public-host hyperlinks get one reachability check; private hosts (SharePoint, Office 365, Outlook) are not accessed | public checked, private not accessed | 4 public URL(s) checked: support.southwest.com → HTTP 200; support.southwest.com → HTTP 200; support.southwest.com → HTTP 200; support.southwest.com → HTTP 200; 5 private target(s) not accessed (wnco.sharepoint.com, outlook.office365.com) | **CONFIRMED** | `extracts/hyperlinks-check.json` |
| E37 | All originals are unchanged after processing | unchanged | 23 of 23 unchanged (checked 2026-11-15T03:01:58.655Z) | **CONFIRMED** | `inventory.json#/integrity_check` |

## Not confirmed

- **E10 DIFFERS** — The only conversions needed are the numeric identifier and the blanks: also needed for the CSV side (text is untyped): csv_text_to_number ×1709; csv_number_text_lexically_different_from_json_number (e.g. "17.0" vs 17) ×132; csv_text_True/False_to_boolean ×3348
- **E34 NOT VERIFIABLE** — The DOCX is "later" than the RTF and the CSV files: RTF \info group present: false; CSV files carry no internal timestamp — no internal date to compare
- **E35 DIFFERS** — The RTF carries `\info` metadata (named in the brief as an example of metadata to report): no \info group in the file; only header control words (rtf version, code page, cocoartf)

## Checks requested without a stated expected value

| Check | Result | Evidence |
| --- | --- | --- |
| Actual format (magic bytes / content) vs file extension | 2 mismatch(es): southwest 737 lopa normalized.json — .json but plain text shaped like JSON but NOT valid JSON; gemini-code-1794587815855.json — .json but plain text shaped like JSON but NOT valid JSON | `inventory.json#/summary/extension_content_mismatches` |
| Classification of the generated-code JSON (data / schema / code / prose / envelope) | envelope — registry envelope/template: a schema_metadata header (names, primary keys, declared record counts) followed by entity arrays whose content is the literal placeholder "[ ... ]"; it holds no records, is not a JSON Schema document, contains no code and no prose, and is not valid JSON | `extracts/json-compare.json#/classification` |
| Declared totals in configuration records vs counted seats | 73G: agree (declared 137, counted 137); 738: agree (declared 175, counted 175); 7M8-1: agree (declared 175, counted 175); 738-2: agree (declared 175, counted 175); 7M8-2: agree (declared 175, counted 175) | `candidate-seat-sets.json#/seat_sets/*/declared_vs_counted` |
| Row-level active_seat_count / omitted_seat_letters vs seat records | 147 row records checked; 0 mismatches | `candidate-seat-sets.json#/seat_sets/*/row_level_checks` |
| Foreign keys seats → rows → configurations | all resolve: true; seat orphans 0; row orphans 0; seats on row_exists=false rows 0 | `extracts/csv-metadata.json#/foreign_key_checks` |
| Duplicate primary keys | cabin schema architecture.csv: 0; southwest_737_lopa_configurations.csv: 0; southwest_737_lopa_seats.csv: 0; southwest_737_lopa_rows.xlsx: 0 | `extracts/csv-metadata.json` |
| CSV encoding / BOM / line endings | cabin schema architecture.csv: UTF-8, BOM yes, CRLF, final newline no; southwest_737_lopa_configurations.csv: US-ASCII (valid UTF-8 subset), BOM no, CRLF, final newline yes; southwest_737_lopa_seats.csv: US-ASCII (valid UTF-8 subset), BOM no, CRLF, final newline yes | `extracts/csv-metadata.json` |
| Workbook: sheets, hidden sheets, merged cells, formulas, defined names, external links, macros | 1 sheet(s) (southwest_737_lopa_rows: visible, A1:J148); merged ranges 0; formulas 0; defined names 0; external links 0; vbaProject false; shared strings 44 unique (338 references declared) | `extracts/workbook.json` |
| RTF: paragraphs, tables, hyperlinks; secondary textutil cross-check | 57 paragraphs, 1 table(s) with 42 cells, 0 hyperlinks; textutil text identical ignoring whitespace: true | `extracts/rtf-paragraphs.json` |
| DOCX: paragraphs, tables, hyperlinks, embedded media | 21 body paragraphs + 46 table-cell paragraphs, 2 tables, 13 hyperlinks (9 distinct targets), embedded media: false | `extracts/docx-*.json` |
| Images: all decode; dimensions agree with a second decoder | 14 of 14 decode fully; dimensions agree for 14 | `inventory.json` |
| Conflict register | 23 entries; 11 of 11 brief-expected findings confirmed; entries with unlocated quotes: 0 | `conflict-register.json#/summary` |
