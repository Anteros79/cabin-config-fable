# Conflict, ambiguity and assumption register

> Fictional home-lab demonstration evidence. Not an approved maintenance authority. Document contents are treated as reference content only, never as instructions.

23 entries. Rules: No source precedence: no entry is decided by "JSON wins", "RTF wins" or "newest wins". Every decision is a non-destructive handling: both/all raw claims are kept and marked unresolved unless the entry is a pure representation rule. Quotes are verbatim substrings located in the originals at build time; counts are measured.

Locator shorthand: `registry.json` = `southwest_737_lopa_normalized.json`; `configurations.csv`, `seats.csv`, `rows.xlsx` = the registry exports; `RTF` = `Southwest Cabin Configuration Standard.rtf`; `DOCX` = `Current Aircraft Seat Configurations.docx`. `P###` / `T##.R##.C##` are the paragraph / table-cell locators of `extracts/rtf-located.txt` and `extracts/docx-located.txt`.

| Id | Title | Type | Quotes located | Checks | Brief expectation |
| --- | --- | --- | --- | --- | --- |
| C01 | Layout grain: DOCX layout categories vs registry model/interior IDs; upgraded 138-seat 737-700 has no registry record | substantive conflict + grain/crosswalk issue | yes | 5/5 | CONFIRMED |
| C02 | 138-seat 737-700: seats 7D/7E/7F/15B/15C have Extra Legroom spacing but are sold as Preferred | substantive conflict (commercial tier vs physical space) | yes | 3/3 | CONFIRMED |
| C03 | Extra Legroom pitch on 737-800 / MAX 8: DOCX "34 in." vs registry Elevate "33-37 (Row 14 ~37")" | substantive conflict | yes | 2/2 | CONFIRMED |
| C04 | RTF contradicts its own split Row 6 pitch | substantive conflict (internal to one document) | yes | 1/1 | CONFIRMED |
| C05 | Row-level bulkhead flag is ambiguous when only one side is behind a bulkhead | ambiguity | yes | 2/2 | CONFIRMED |
| C06 | Approximate pitch statements appear as exact strings in per-seat fields | representation difference with loss of a qualifier (substantive risk of false precision) | yes | 2/2 | CONFIRMED |
| C07 | Shoulder clearance and seat width are conflated in the width fields | substantive conflict (different measurement kinds in one field) | yes | 2/2 | CONFIRMED |
| C08 | DOCX temporary-layout wording about the rear row does not identify a seat | ambiguity | yes | 2/2 | CONFIRMED |
| C09 | Not supplied: dated tail assignments, parts / applicability / substitute catalogue, floor or bin map, coordinate frame, cabin height, image-to-layout mapping | gap (not supplied) | yes | 8/8 | CONFIRMED |
| C10 | Row count wording: row records vs printed labels vs physical rows | representation difference | yes | 1/1 | — (additional finding) |
| C11 | Exit-row flag semantics differ between configurations and from the DOCX description | ambiguity | yes | 1/1 | — (additional finding) |
| C12 | Seat width differs between configurations with the same hardware label and from the DOCX ranges | substantive conflict (unexplained) + representation difference | yes | 1/1 | — (additional finding) |
| C13 | Estimated fleet counts are qualified free text and cannot be reconciled with the DOCX fleet numbers | ambiguity | yes | 1/1 | — (additional finding) |
| C14 | Seat hardware and interior names differ between sources | ambiguity (naming / crosswalk) | yes | 1/1 | — (additional finding) |
| C15 | In-seat power claims are airframe-dependent alternatives copied to every seat | ambiguity | yes | 1/1 | — (additional finding) |
| C16 | Compound enumeration values and unverified regulatory attributions | ambiguity | yes | 1/1 | — (additional finding) |
| C17 | Workbook stores one identifier as a number and blanks as absent cells | representation difference | yes | 1/1 | — (additional finding) |
| C18 | Two byte-identical JSON-named files are invalid templates, one named almost like the populated registry | representation difference (artifact role) | yes | 4/4 | CONFIRMED |
| C19 | DOCX wording of the extra pitch ("up to five" / "approximately three" vs "five" / "three") | ambiguity (minor, internal to one document) | yes | 1/1 | — (additional finding) |
| C20 | Cited sources cannot be verified from the supplied files | assumption | yes | 1/1 | — (additional finding) |
| C21 | Reference images: third-party metadata, another airline named, no link to any layout | ambiguity (provenance) + gap (not supplied) | yes | 2/2 | CONFIRMED |
| C22 | Crosswalk assumption: DOCX categories ↔ registry records | assumption | yes | 1/1 | — (additional finding) |
| C23 | A planned aircraft type is mentioned as not current | assumption (scope) | yes | 1/1 | — (additional finding) |

## C01 — Layout grain: DOCX layout categories vs registry model/interior IDs; upgraded 138-seat 737-700 has no registry record

**Type:** substantive conflict + grain/crosswalk issue  
**Scope:** Layout / LayoutRevision identity for all aircraft; specifically the 737-700.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| DOCX | DOCX#P002 | `four active seating layouts` |
| DOCX | DOCX#T01.R02.C01 | `737-700, 137-seat LOPA` — capacity cell: 137 |
| DOCX | DOCX#T01.R03.C01 | `737-700, upgraded 138-seat LOPA` — capacity cell: 138 |
| DOCX | DOCX#T01.R04.C01 | `737-800 / MAX 8, temporary LOPA` — capacity cell: 175 |
| DOCX | DOCX#T01.R05.C01 | `737-800 / MAX 8, final LOPA` — capacity cell: 175 |
| DOCX | DOCX#T01.R03.C03 | `Single cabin, 3-3 seating; exit row changed from two seats to three on the affected side` |
| DOCX | DOCX#P005 | `The 137-seat and 138-seat 737-700 layouts are both in circulation while 170 selected -700s are upgraded.` |
| RTF | RTF#P001 | `5 active Southwest Airlines cabin configurations (LOPAs)` |
| measured | registry.json#/lopa_configurations/*/lopa_id | registry lopa_id values: `73G, 738, 7M8-1, 738-2, 7M8-2` |
| measured | registry.json#/lopa_configurations/*/total_seats | registry total_seats values: `137, 175, 175, 175, 175` |
| measured | whole-file text search | occurrences of the token "138" as a whole number in registry JSON text / RTF text: `0 / 0` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/0/total_seats; configurations.csv:L2:I(total_seats) | lopa_configurations[73G].total_seats: `137` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/0/configuration_name; configurations.csv:L2:E(configuration_name) | lopa_configurations[73G].configuration_name: `2026 Cabin Iteration (Retrofitted)` |

- **Why:** The DOCX layout table has 4 category rows (two 737-700 categories by capacity, two shared 737-800/MAX 8 categories by programme stage); the registry has 5 records keyed by model + interior (73G, 738, 7M8-1, 738-2, 7M8-2). This is partly a grain difference (representation of the same fleet at different granularity) and partly substantive: the DOCX category with capacity 138 has no registry record (registry totals: 137, 175), and the DOCX gives no seat-by-seat list for it — only an arrangement sentence and the seats named in C02.
- **Impact:** No candidate seat set exists for a 138-seat 737-700. A visit on such an aircraft cannot be served by any supplied seat map; silently using 73G would show a wrong seat count.
- **Decision (non-destructive):** Keep every registry lopa_id as its own candidate LayoutRevision. Record the DOCX categories as separate layout-category claims. Link the two through an explicit crosswalk table whose rows are marked "assumed, unverified" (see C22). Create the 138-seat category as a placeholder Layout with status "no seat set supplied" that cannot be selected for seat-level work. Never synthesise a 138-seat set by adding a seat to 73G. Unresolved.
- **Evidence still needed:** An approved LOPA / seat list for the 138-seat 737-700, and an authoritative mapping between layout categories and model/interior identifiers.
- **Checks:** ✔ DOCX layout table has four category rows; ✔ a DOCX category row has capacity 138; ✔ registry has five configuration records; ✔ no registry configuration declares 138 seats; ✔ DOCX names at most a handful of seat codes for the 138-seat layout (no full seat list)
- **Brief expectation:** CONFIRMED — The later DOCX describes four physical-layout categories, including an upgraded 138-seat 737-700 that is absent from the 5-record registry; the DOCX does not supply a complete 138-seat seat set.

## C02 — 138-seat 737-700: seats 7D/7E/7F/15B/15C have Extra Legroom spacing but are sold as Preferred

**Type:** substantive conflict (commercial tier vs physical space)  
**Scope:** Only the layout the DOCX calls "upgraded 138-seat -700". Not the 137-seat 73G registry record.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| DOCX | DOCX#P012 | `On the upgraded 138-seat -700 layout, seats 7D, 7E, 7F, 15B and 15C physically have Extra Legroom spacing but are sold as Preferred, not Extra Legroom.` |
| DOCX | DOCX#P012 | `the physical pitch and commercial product designation do not match` — Document content recorded as a claim; it is not treated as an instruction. |
| DOCX | DOCX#T02.R03.C03 | `Same pitch and width range as Standard for the aircraft type` — General DOCX statement about Preferred, to which the 138-seat seats are an exception. |
| DOCX | DOCX#P010 | `Preferred is a location upgrade, not a dimensional upgrade.` |
| registry JSON + seats CSV | registry.json#/lopa_seats/39/commercial_tier; seats.csv:L41:F(commercial_tier) | lopa_seats[73G, 7D].commercial_tier: `Preferred` — registry 73G (137 seats) — a different layout |
| registry JSON + seats CSV | registry.json#/lopa_seats/39/pitch_range_inches; seats.csv:L41:G(pitch_range_inches) | lopa_seats[73G, 7D].pitch_range_inches: `31-33` — registry 73G (137 seats) — a different layout |
| registry JSON + seats CSV | registry.json#/lopa_seats/40/commercial_tier; seats.csv:L42:F(commercial_tier) | lopa_seats[73G, 7E].commercial_tier: `Preferred` — registry 73G (137 seats) — a different layout |
| registry JSON + seats CSV | registry.json#/lopa_seats/40/pitch_range_inches; seats.csv:L42:G(pitch_range_inches) | lopa_seats[73G, 7E].pitch_range_inches: `31-33` — registry 73G (137 seats) — a different layout |
| registry JSON + seats CSV | registry.json#/lopa_seats/41/commercial_tier; seats.csv:L43:F(commercial_tier) | lopa_seats[73G, 7F].commercial_tier: `Preferred` — registry 73G (137 seats) — a different layout |
| registry JSON + seats CSV | registry.json#/lopa_seats/41/pitch_range_inches; seats.csv:L43:G(pitch_range_inches) | lopa_seats[73G, 7F].pitch_range_inches: `31-33` — registry 73G (137 seats) — a different layout |
| registry JSON + seats CSV | registry.json#/lopa_seats/60/commercial_tier; seats.csv:L62:F(commercial_tier) | lopa_seats[73G, 15B].commercial_tier: `Extra Legroom` — registry 73G (137 seats) — a different layout |
| registry JSON + seats CSV | registry.json#/lopa_seats/60/pitch_range_inches; seats.csv:L62:G(pitch_range_inches) | lopa_seats[73G, 15B].pitch_range_inches: `35-36` — registry 73G (137 seats) — a different layout |
| registry JSON + seats CSV | registry.json#/lopa_seats/61/commercial_tier; seats.csv:L63:F(commercial_tier) | lopa_seats[73G, 15C].commercial_tier: `Extra Legroom` — registry 73G (137 seats) — a different layout |
| registry JSON + seats CSV | registry.json#/lopa_seats/61/pitch_range_inches; seats.csv:L63:G(pitch_range_inches) | lopa_seats[73G, 15C].pitch_range_inches: `35-36` — registry 73G (137 seats) — a different layout |

- **Why:** Substantive: for 5 named seats the commercial tier (Preferred) and the physical spacing (Extra Legroom) differ, and the DOCX's own general description of Preferred ("Same pitch and width range as Standard") does not hold for them. In the registry's 73G record the same seat codes read: 7D = Preferred / 31-33; 7E = Preferred / 31-33; 7F = Preferred / 31-33; 15B = Extra Legroom / 35-36; 15C = Extra Legroom / 35-36 — so the DOCX statement cannot be transferred to 73G without contradicting it.
- **Impact:** If tier were used as a proxy for pitch (or the reverse), appearance checks and seat-map colouring would be wrong for these seats.
- **Decision (non-destructive):** Store commercial tier (SeatCommercialAttributes) and physical pitch claim (SeatPhysicalAttributes) as independent attributes; never derive one from the other. Attach the DOCX statement as a raw claim scoped to the 138-seat placeholder layout only. Leave every 73G seat record exactly as supplied. Unresolved.
- **Evidence still needed:** Seat list for the 138-seat layout with per-seat pitch and commercial tier.
- **Checks:** ✔ registry 73G declares 137 seats (not 138); ✔ registry 73G seats 7D/7E/7F are Preferred with a non-Extra-Legroom pitch claim; ✔ registry 73G seats 15B/15C are Extra Legroom (differs from the DOCX 138-seat claim)
- **Brief expectation:** CONFIRMED — The DOCX says that in the 138-seat layout seats 7D/7E/7F/15B/15C have physical Extra Legroom spacing but are commercially Preferred; must not be applied to the 137-seat 73G.

## C03 — Extra Legroom pitch on 737-800 / MAX 8: DOCX "34 in." vs registry Elevate "33-37 (Row 14 ~37")"

**Type:** substantive conflict  
**Scope:** Extra Legroom seats on 737-800 / MAX 8; DOCX "temporary" and "final" categories vs registry records 738, 7M8-1, 738-2, 7M8-2.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| DOCX | DOCX#T01.R04.C04; DOCX#T01.R05.C04 | `34 in.` — Extra Legroom pitch cells of both the temporary and the final 737-800 / MAX 8 rows. |
| DOCX | DOCX#T02.R02.C03 | `737-800/MAX 8: 34-inch pitch, approximately three inches more than standard` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/1/elr_pitch_inches; configurations.csv:L3:N(elr_pitch_inches) | lopa_configurations[738].elr_pitch_inches: `34` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/2/elr_pitch_inches; configurations.csv:L4:N(elr_pitch_inches) | lopa_configurations[7M8-1].elr_pitch_inches: `34` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/3/elr_pitch_inches; configurations.csv:L5:N(elr_pitch_inches) | lopa_configurations[738-2].elr_pitch_inches: `33-37 (Row 14 ~37")` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/4/elr_pitch_inches; configurations.csv:L6:N(elr_pitch_inches) | lopa_configurations[7M8-2].elr_pitch_inches: `33-37 (Row 14 ~37")` |
| RTF | RTF#P046 | `receives the deepest legroom on the aircraft at ~37" pitch, while Rows 1–6, 15, and 16 measure ~33"–34".` |
| measured | registry.json#/lopa_seats (lopa_id=738-2) | per-seat pitch_range_inches distribution, 738-2: `{"37":6,"33-34":42,"31-32":127}` |
| measured | registry.json#/lopa_seats (lopa_id=7M8-2) | per-seat pitch_range_inches distribution, 7M8-2: `{"37":6,"33-34":42,"31-32":127}` |

- **Why:** Substantive: the DOCX gives a single 34-inch value for both larger-aircraft categories, while the registry (and the RTF) give the Elevate records a 33–37 band with Row 14 at about 37 inches. The two cannot both be exact. Which registry records correspond to the DOCX "final" category is itself an assumption (C22).
- **Impact:** Any pitch shown or used for an Extra Legroom seat on the newer interior depends on which source is read.
- **Decision (non-destructive):** Keep all three as separate raw pitch claims, each with its source, scope (layout-level vs per-seat) and qualifier. Show "sources differ — unverified" wherever they are displayed together. No numeric pitch is used in application logic. Unresolved.
- **Evidence still needed:** LOPA drawing or seat-track data giving pitch per row for each layout.
- **Checks:** ✔ both DOCX larger-aircraft rows carry exactly "34 in."; ✔ registry Elevate records carry exactly 33-37 (Row 14 ~37")
- **Brief expectation:** CONFIRMED — DOCX 34-inch larger-aircraft Extra Legroom pitch vs the registry's Elevate "33-37 (Row 14 ~37")" claim.

## C04 — RTF contradicts its own split Row 6 pitch

**Type:** substantive conflict (internal to one document)  
**Scope:** Row 6 on the 737-800 / MAX 8 layouts, especially the Elevate records.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| RTF | RTF#P023 | `Row 6 (Split Row — 3 ELR / 3 Preferred):` |
| RTF | RTF#P024 | `6A, 6B, 6C (Extra Legroom): Pitched at 34".` |
| RTF | RTF#P025 | `6D, 6E, 6F (Preferred): Pitched at 31"–32".` |
| RTF | RTF#T01.R05.C04; RTF#T01.R06.C04 | `48 (1D–6C, 14–16)` — Elevate summary rows: Extra Legroom ends at 6C. |
| RTF | RTF#T01.R03.C05; RTF#T01.R04.C05; RTF#T01.R05.C05; RTF#T01.R06.C05 | `45 (6D–13F)` — Preferred starts at 6D in every larger-aircraft summary row. |
| RTF | RTF#P043 | `identical Row 1–13 and Row 17–29 boundaries` |
| RTF | RTF#P046 | `Rows 1–6, 15, and 16 measure ~33"–34".` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/92/row_notes; rows.xlsx#southwest_737_lopa_rows!J94 | lopa_rows[738-2, row 6].row_notes: `Split tier row: 6A-6C Extra Legroom (33-34"), 6D-6F Preferred (31-32")` |
| registry JSON + seats CSV | registry.json#/lopa_seats/514/pitch_range_inches; seats.csv:L516:G(pitch_range_inches) | lopa_seats[738-2, 6A].pitch_range_inches: `33-34` |
| registry JSON + seats CSV | registry.json#/lopa_seats/517/pitch_range_inches; seats.csv:L519:G(pitch_range_inches) | lopa_seats[738-2, 6D].pitch_range_inches: `31-32` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/122/row_notes; rows.xlsx#southwest_737_lopa_rows!J124 | lopa_rows[7M8-2, row 6].row_notes: `Split tier row: 6A-6C Extra Legroom (33-34"), 6D-6F Preferred (31-32")` |
| registry JSON + seats CSV | registry.json#/lopa_seats/689/pitch_range_inches; seats.csv:L691:G(pitch_range_inches) | lopa_seats[7M8-2, 6A].pitch_range_inches: `33-34` |
| registry JSON + seats CSV | registry.json#/lopa_seats/692/pitch_range_inches; seats.csv:L694:G(pitch_range_inches) | lopa_seats[7M8-2, 6D].pitch_range_inches: `31-32` |

- **Why:** The RTF defines Row 6 as split (A–C Extra Legroom, D–F Preferred at 31"–32"), says the Elevate cabins keep identical Row 1–13 boundaries, and keeps Preferred starting at 6D in its summary table — yet its Elevate section states that "Rows 1–6 … measure ~33"–34"" without excluding 6D–6F. Read literally the last sentence contradicts the split; read loosely it is imprecise wording. Either way a row-level pitch statement is unsafe.
- **Impact:** A row-level pitch for Row 6 would be wrong for half the row.
- **Decision (non-destructive):** Pitch is stored per seat as a raw claim; no row-level pitch value is stored or inferred. The RTF sentence is kept as a raw narrative claim flagged "internally inconsistent with the split-row statements". Rows whose A/B/C and D/E/F blocks differ are flagged in the seat sets. Unresolved.
- **Evidence still needed:** Pitch per seat block for Row 6 from a LOPA drawing.
- **Checks:** ✔ registry per-seat pitch for 6A and 6D differs on every larger-aircraft record
- **Brief expectation:** CONFIRMED — RTF contradicting its own split Row 6 pitch.

## C05 — Row-level bulkhead flag is ambiguous when only one side is behind a bulkhead

**Type:** ambiguity  
**Scope:** Rows 1 and 2 of every 737-800 / MAX 8 record; Row 1 of 73G for contrast.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| registry JSON + rows XLSX | registry.json#/lopa_rows/27/is_bulkhead_row; rows.xlsx#southwest_737_lopa_rows!G29 | lopa_rows[738, row 1].is_bulkhead_row: `true` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/27/row_notes; rows.xlsx#southwest_737_lopa_rows!J29 | lopa_rows[738, row 1].row_notes: `Starboard-only bulkhead (1D-1F); 1A-1C omitted for forward lavatory/galley` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/27/omitted_seat_letters; rows.xlsx#southwest_737_lopa_rows!E29 | lopa_rows[738, row 1].omitted_seat_letters: `A,B,C` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/28/is_bulkhead_row; rows.xlsx#southwest_737_lopa_rows!G30 | lopa_rows[738, row 2].is_bulkhead_row: `false` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/28/row_notes; rows.xlsx#southwest_737_lopa_rows!J30 | lopa_rows[738, row 2].row_notes: `2A-2C sit directly behind port-side bulkhead wall (armrest tray tables, no floor stowage)` |
| registry JSON + seats CSV | registry.json#/lopa_seats/140/is_bulkhead_seat; seats.csv:L142:M(is_bulkhead_seat) | lopa_seats[738, 2A].is_bulkhead_seat: `True` |
| registry JSON + seats CSV | registry.json#/lopa_seats/143/is_bulkhead_seat; seats.csv:L145:M(is_bulkhead_seat) | lopa_seats[738, 2D].is_bulkhead_seat: `False` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/0/is_bulkhead_row; rows.xlsx#southwest_737_lopa_rows!G2 | lopa_rows[73G, row 1].is_bulkhead_row: `true` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/0/row_notes; rows.xlsx#southwest_737_lopa_rows!J2 | lopa_rows[73G, row 1].row_notes: `Dual-sided forward bulkhead; armrest tray tables; no underseat floor stowage` |
| RTF | RTF#P021 | `Starboard-only bulkhead (1D, 1E, 1F)` |
| RTF | RTF#P022 | `2A, 2B, 2C sit directly behind the port-side bulkhead wall` |
| RTF | RTF#P005 | `is a dual-sided bulkhead` |
| measured | registry.json#/lopa_rows + #/lopa_seats | rows with a bulkhead row flag or any bulkhead seat, per lopa_id (row, row_flag, bulkhead_seats / seats): `{"738":[{"row":1,"row_flag":true,"bulkhead_seats":3,"seats":3},{"row":2,"row_flag":false,"bulkhead_seats":3,"seats":6}],"73G":[{"row":1,"row_flag":true,"bulkhead_seats":6,"seats":6}],"7M8-1":[{"row":1,"row_flag":true,"bulkhead_sea…` |

- **Why:** On the larger aircraft the row flag is true for Row 1, where only D/E/F exist, and false for Row 2, where 3 of 6 seats (A/B/C) are flagged as bulkhead seats. A single row boolean cannot say which side is behind a bulkhead, and it disagrees with the seat flags for Row 2.
- **Impact:** Deriving bulkhead treatment (tray table, stowage, appearance items) from the row flag would miss 2A–2C and could over-apply to seats that are not behind a bulkhead.
- **Decision (non-destructive):** Seat-level is_bulkhead_seat is stored per seat; the row-level flag is stored as a separate raw row claim. The application never derives a seat's bulkhead status from the row flag and shows both when they differ. Unresolved (neither flag is verified).
- **Evidence still needed:** LOPA showing monument and bulkhead positions per side.
- **Checks:** ✔ some existing row has is_bulkhead_row=false while some of its seats have is_bulkhead_seat=true; ✔ some row has bulkhead seats on only part of the row
- **Brief expectation:** CONFIRMED — Row bulkhead flags with partial-side ambiguity (row-level flag vs seat-level flags when only one side is behind a bulkhead).

## C06 — Approximate pitch statements appear as exact strings in per-seat fields

**Type:** representation difference with loss of a qualifier (substantive risk of false precision)  
**Scope:** Per-seat pitch_range_inches on the Elevate records; the field in general.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| RTF | RTF#P046 | `Row 14 Pitch Increase (~37"):` |
| RTF | RTF#P045 | `offer standard ~34" ELR pitch` |
| RTF | RTF#P046 | `Rows 1–6, 15, and 16 measure ~33"–34".` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/3/elr_pitch_inches; configurations.csv:L5:N(elr_pitch_inches) | lopa_configurations[738-2].elr_pitch_inches: `33-37 (Row 14 ~37")` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/100/row_notes; rows.xlsx#southwest_737_lopa_rows!J102 | lopa_rows[738-2, row 14].row_notes: `Deepest legroom row on aircraft (~37" pitch)` |
| registry JSON + seats CSV | registry.json#/lopa_seats/562/pitch_range_inches; seats.csv:L564:G(pitch_range_inches) | lopa_seats[738-2, 14A].pitch_range_inches: `37` |
| registry JSON + seats CSV | registry.json#/lopa_seats/562/special_notes; seats.csv:L564:R(special_notes) | lopa_seats[738-2, 14A].special_notes: `Maximum cabin pitch (~37"); Overwing exit zone; FAA exit seating criteria apply` |
| registry JSON + seats CSV | registry.json#/lopa_seats/574/pitch_range_inches; seats.csv:L576:G(pitch_range_inches) | lopa_seats[738-2, 16A].pitch_range_inches: `33-34` |
| registry JSON + seats CSV | registry.json#/lopa_seats/490/pitch_range_inches; seats.csv:L492:G(pitch_range_inches) | lopa_seats[738-2, 2A].pitch_range_inches: `33-34` |
| measured | registry.json#/lopa_seats/*/pitch_range_inches | seat records whose pitch_range_inches is a single number (no range, no "~"): `104` |
| measured | registry.json#/lopa_seats/*/pitch_range_inches | seat records with pitch_range_inches exactly "37": `12` |
| measured | registry.json#/lopa_seats/*/pitch_range_inches | seat records whose pitch_range_inches contains "~": `0` |

- **Why:** The narrative, the configuration record and the row/seat notes all qualify these values with "~" (about 37, about 33–34, about 34). The per-seat field holds the bare strings "37" and "33-34". The qualifier is lost in the per-seat representation, and a field named "range" holds single numbers.
- **Impact:** An exact-looking pitch could be mistaken for a measured dimension or compared numerically.
- **Decision (non-destructive):** Store the per-seat string verbatim plus a flag "approximate in sibling claims" where the configuration, row note, seat note or narrative marks the same value with "~". Display with that flag; never present as a measurement; never compute with it. Unresolved.
- **Evidence still needed:** Measured or drawing-based pitch with stated tolerance.
- **Checks:** ✔ per-seat field holds "37" with no "~" while the same seat's special_notes says ~37"; ✔ no per-seat pitch string carries a "~"
- **Brief expectation:** CONFIRMED — Approximate pitches turned into falsely exact strings.

## C07 — Shoulder clearance and seat width are conflated in the width fields

**Type:** substantive conflict (different measurement kinds in one field)  
**Scope:** Seat 10A on the non-Elevate larger-aircraft records; the meaning of max_seat_width_inches / effective_width_inches / DOCX "Seat width" generally.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| registry JSON + seats CSV | registry.json#/lopa_seats/188/effective_width_inches; seats.csv:L190:H(effective_width_inches) | lopa_seats[738, 10A].effective_width_inches: `15.8` |
| registry JSON + seats CSV | registry.json#/lopa_seats/188/window_notes; seats.csv:L190:K(window_notes) | lopa_seats[738, 10A].window_notes: `Completely windowless blank wall covering environmental control ducting (~2" narrower shoulder clearance)` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/1/max_seat_width_inches; configurations.csv:L3:P(max_seat_width_inches) | lopa_configurations[738].max_seat_width_inches: `17.8` |
| registry JSON + seats CSV | registry.json#/lopa_seats/189/effective_width_inches; seats.csv:L191:H(effective_width_inches) | lopa_seats[738, 10B].effective_width_inches: `17.8` |
| registry JSON + seats CSV | registry.json#/lopa_seats/137/effective_width_inches; seats.csv:L139:H(effective_width_inches) | lopa_seats[738, 1D].effective_width_inches: `15.5` — bulkhead seat |
| RTF | RTF#P034 | `also reduces shoulder width by ~2" due to the missing window reveal` |
| registry JSON + seats CSV | registry.json#/lopa_seats/538/effective_width_inches; seats.csv:L540:H(effective_width_inches) | lopa_seats[738-2, 10A].effective_width_inches: `17.8` |
| registry JSON + seats CSV | registry.json#/lopa_seats/538/window_notes; seats.csv:L540:K(window_notes) | lopa_seats[738-2, 10A].window_notes: `Completely windowless blank wall covering environmental control ducting` |
| RTF | RTF#P050 | `10A: Remains completely windowless due to fuselage structural ducting.` |
| DOCX | DOCX#T01.R01.C06 | `Seat width` |
| DOCX | DOCX#T01.R04.C06; DOCX#T01.R05.C06 | `15.5-17.8 in.` |
| DOCX | DOCX#T02.R03.C04 | `it is not a wider seat` |
| measured | registry.json#/lopa_seats/*/effective_width_inches | effective_width_inches distribution per lopa_id: `{"738":{"15.5":6,"17.8":168,"15.8":1},"73G":{"17":131,"15.5":6},"7M8-1":{"15.5":6,"17.8":168,"15.8":1},"738-2":{"15.5":6,"17.8":169},"7M8-2":{"15.5":6,"17.3":169}}` |
| measured | computed from the two located values | difference between max_seat_width_inches and 10A effective_width_inches on 738 / 7M8-1: `2 / 2` |

- **Why:** On the non-Elevate records the registry lowers 10A's "effective width" by the approximate shoulder-clearance loss the RTF describes at the windowless sidewall, turning "~2 inches narrower shoulder clearance" into an exact seat-width number. Shoulder clearance at the wall and seat width are different measurements. The same windowless seat on the Elevate records keeps the full width value. No source defines what "seat width", "max seat width" or "effective width" measures.
- **Impact:** Width could be shown as a seat dimension when it is partly a sidewall-clearance statement; the two interiors are treated inconsistently for the same seat.
- **Decision (non-destructive):** Store each width value as a raw claim with measurement_kind = "unspecified by source" and the source field name. Keep the shoulder-clearance statement as its own sidewall/window note. Do not recompute or "correct" 10A. Flag 10A on all four larger-aircraft records. Unresolved.
- **Evidence still needed:** Seat supplier dimensional data and a definition of the width measurement used.
- **Checks:** ✔ 10A effective width is lower than the neighbouring seat on the non-Elevate records and its note cites shoulder clearance; ✔ 10A keeps the full width on the Elevate records
- **Brief expectation:** CONFIRMED — Shoulder clearance vs seat width conflated in the width field(s).

## C08 — DOCX temporary-layout wording about the rear row does not identify a seat

**Type:** ambiguity  
**Scope:** Last row (and exit row) of the 737-800 / MAX 8 "temporary" category; registry records 738, 7M8-1 if the C22 crosswalk assumption holds.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| DOCX | DOCX#T01.R04.C01 | `737-800 / MAX 8, temporary LOPA` |
| DOCX | DOCX#T01.R04.C03 | `Single cabin, 3-3 seating; reduced seating at part of the exit-row and rear-row areas` |
| DOCX | DOCX#T01.R05.C03 | `Single cabin, 3-3 seating; three seats on both sides of the exit row and two seats on both sides of the last row` |
| DOCX | DOCX#P006 | `The final layout adds one Extra Legroom seat on each side of the exit row, while the last row becomes two seats per side, keeping the overall capacity unchanged.` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/41/omitted_seat_letters; rows.xlsx#southwest_737_lopa_rows!E43 | lopa_rows[738, row 15].omitted_seat_letters: `A,F` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/56/active_seat_count; rows.xlsx#southwest_737_lopa_rows!D58 | lopa_rows[738, row 30].active_seat_count: `6` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/56/omitted_seat_letters; rows.xlsx#southwest_737_lopa_rows!E58 | lopa_rows[738, row 30].omitted_seat_letters: *(empty)* |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/1/total_seats; configurations.csv:L3:I(total_seats) | lopa_configurations[738].total_seats: `175` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/116/omitted_seat_letters; rows.xlsx#southwest_737_lopa_rows!E118 | lopa_rows[738-2, row 30].omitted_seat_letters: `A,F` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/116/row_notes; rows.xlsx#southwest_737_lopa_rows!J118 | lopa_rows[738-2, row 30].row_notes: `4-seat aft row (30B-30E); 2 window-side positions omitted adjacent to enlarged aft lavatory/galley` |
| RTF | RTF#P031 | `Full 3-3 layout (A–F) across all 14 rows` |
| RTF | RTF#T01.R05.C07; RTF#T01.R06.C07 | `1A, 1B, 1C, 2 seats in Row 30` |
| RTF | RTF#P047 | `Row 30 drops two window-side positions to become a 4-seat rear row` |

- **Why:** The DOCX says the temporary layout has "reduced seating at part of the exit-row and rear-row areas" but names no seat. The registry's non-Elevate records show a reduced exit row and a full 6-seat last row at the same declared total. The DOCX also describes the final last row only as "two seats on both sides" without letters, while the RTF summary says "2 seats in Row 30" and only its narrative and the registry say which positions are absent.
- **Impact:** There is no basis for removing any particular rear-row seat from a temporary-layout seat map.
- **Decision (non-destructive):** Do not add or remove any rear-row seat in any candidate seat set. Keep the DOCX sentence as a raw layout-level claim. Mark the last row of the linked candidate sets "DOCX claims reduced rear-row seating; seat not identified; unresolved" and surface that as a warning. Unresolved.
- **Evidence still needed:** LOPA for the temporary layout showing the last row.
- **Checks:** ✔ the DOCX temporary-layout arrangement cell contains no seat code; ✔ registry non-Elevate last row has six seats and no omitted letters
- **Brief expectation:** CONFIRMED — Temporary-layout rear-row wording that does not identify a specific seat to remove.

## C09 — Not supplied: dated tail assignments, parts / applicability / substitute catalogue, floor or bin map, coordinate frame, cabin height, image-to-layout mapping

**Type:** gap (not supplied)  
**Scope:** Aircraft(tail), TailAssignment, Part, Component, ApplicabilityRule, SubstituteApproval, KitChild, FloorArea, BinModule, MaterialProfile, coordinates, cabin height, image mapping, ValidationRelease.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| measured | evidence/field-crosswalk.json#/absence_checks | keyword mentions across registry, schema CSV, RTF and DOCX (text units): `{"tail registration token (N-number)":1,"part number / manual reference":0,"carpet":0,"seam":0,"upholstery / leather / fabric / dress cover":0,"colour":0,"overhead bin":0,"floor":37,"coordinate / station / datum":0,"height / ceili…` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/2/wifi_system; configurations.csv:L4:R(wifi_system) | lopa_configurations[7M8-1].wifi_system: `Anuvu Ku-band / Viasat Ka-band (N8849Q+)` — the only tail-like token in any source; it sits inside free text |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/1/lavatory_count_aft; configurations.csv:L3:T(lavatory_count_aft) | lopa_configurations[738].lavatory_count_aft: `2` — a count, not a floor map |
| measured | registry.json#/schema_metadata | registry schema_metadata.schema_version / generated_at_utc: `2026.1 / 2026-11-13T16:29:49Z` |
| measured | DOCX#docProps/core.xml | DOCX core properties title / creator / created: `Document / Un-named / 2026-11-13T17:37:00Z` |
| DOCX | DOCX#P002 | `As of November 13, 2026` |
| measured | Southwest Cabin Configuration Standard.rtf (header) | RTF \info group present: `false` |
| measured | evidence/inventory.json (image metadata) | images whose embedded metadata mentions a layout id, LOPA, row or seat: `0` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/0/est_active_aircraft; configurations.csv:L2:H(est_active_aircraft) | lopa_configurations[73G].est_active_aircraft: `~277` — an estimate, not a tail list |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/1/est_active_aircraft; configurations.csv:L3:H(est_active_aircraft) | lopa_configurations[738].est_active_aircraft: `~204` — an estimate, not a tail list |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/2/est_active_aircraft; configurations.csv:L4:H(est_active_aircraft) | lopa_configurations[7M8-1].est_active_aircraft: `~315` — an estimate, not a tail list |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/3/est_active_aircraft; configurations.csv:L5:H(est_active_aircraft) | lopa_configurations[738-2].est_active_aircraft: `~46+ (expanding)` — an estimate, not a tail list |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/4/est_active_aircraft; configurations.csv:L6:H(est_active_aircraft) | lopa_configurations[7M8-2].est_active_aircraft: `New deliveries (Oct 2025+)` — an estimate, not a tail list |

- **Why:** None of these data sets exists in the supplied files. Mentions that look related are free text: 1 text unit(s) with a tail-like token inside a Wi-Fi description, qualified fleet-size estimates, lavatory counts, and "floor stowage" notes. The registry version string and generation timestamp, the DOCX "As of" date and the generic document title are metadata about files, not approvals, and do not fill any of these gaps.
- **Impact:** The application cannot truthfully resolve a tail to a layout, list parts or kits for a seat, place anything on a floor/bin map, draw to scale, or tie a photo to a layout from the supplied evidence.
- **Decision (non-destructive):** Mark each of these entities "not supplied" in the model. Anything the application needs for them must come from clearly labelled demo fixtures kept apart from source-derived claims, and every screen/report using them states that. Timestamps, versions and titles are stored only as SourceArtifact metadata and are never promoted to a ValidationRelease. Unresolved.
- **Evidence still needed:** Approved dated tail-to-layout assignments; parts/kit catalogue with applicability and substitute approvals; floor and bin maps; a coordinate frame with stations; cabin cross-section dimensions; a catalogued image set with layout references; an actual validation/approval record.
- **Checks:** ✔ no part-number / manual reference mentions; ✔ no substitute / alternate mentions; ✔ no coordinate / station / datum mentions; ✔ no height / ceiling mentions; ✔ no overhead-bin mentions; ✔ no approval / authorisation mentions; ✔ at most one text unit contains a tail-like token, and no tail list exists; ✔ no image metadata references a layout, row or seat
- **Brief expectation:** CONFIRMED — No approved dated tail assignment, parts/applicability/substitute catalog, exact floor/bin map, coordinate frame, exact cabin height, or image-to-layout mapping is supplied; generated timestamps and titles do not fill those gaps.

## C10 — Row count wording: row records vs printed labels vs physical rows

**Type:** representation difference  
**Scope:** RowLabel for every layout; 73G in particular.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| measured | registry.json#/schema_metadata/entities/lopa_rows/record_count | registry schema_metadata lopa_rows.record_count: `147` |
| measured | cabin schema architecture.csv:L3:Row Count | schema CSV "Row Count" for lopa_rows (raw): `147` |
| measured | registry.json#/lopa_rows/*/row_exists | row records with row_exists=true / row_exists=false: `143 / 4` |
| measured | registry.json#/lopa_rows (lopa_id=73G) | 73G: row records / existing rows / highest printed label: `27 / 23 / 27` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/0/numbered_row_range; configurations.csv:L2:M(numbered_row_range) | lopa_configurations[73G].numbered_row_range: `1-9, 14-27 (skips 10-13)` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/9/row_exists; rows.xlsx#southwest_737_lopa_rows!C11 | lopa_rows[73G, row 10].row_exists: `false` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/9/recline_status; rows.xlsx#southwest_737_lopa_rows!H11 | lopa_rows[73G, row 10].recline_status: `N/A` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/9/omitted_seat_letters; rows.xlsx#southwest_737_lopa_rows!E11 | lopa_rows[73G, row 10].omitted_seat_letters: `A,B,C,D,E,F` |
| RTF | RTF#P003 | `skips Rows 10–13 entirely` |
| RTF | RTF#P007 | `Rows 10–13 (Non-Existent — 0 seats):` |

- **Why:** The "row count" in the registry metadata and the schema summary counts row records, including placeholder records for printed labels that do not exist in the cabin. On 73G the highest printed label is larger than the number of physical rows. This is a representation matter, but counting or ordering rows by label would be wrong.
- **Impact:** Row counts, "row n of m" displays and forward/aft ordering go wrong if printed labels are treated as physical indices.
- **Decision (non-destructive):** RowLabel stores printed_label (string), exists (boolean) and a separately derived physical_order. Non-existent labels are kept as records with exists=false and are never rendered as rows. Every count states whether it counts records, printed labels or physical rows. The physical order itself remains an assumption (ascending label).
- **Evidence still needed:** Drawing confirming physical row order and the skipped labels.
- **Checks:** ✔ row records exceed existing rows

## C11 — Exit-row flag semantics differ between configurations and from the DOCX description

**Type:** ambiguity  
**Scope:** is_exit_row / is_exit_seat on every record; the 137-seat 737-700 exit area.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| RTF | RTF#P001 | `overwing emergency exits fall in the Row 14–16 band` |
| RTF | RTF#P027 | `Twin-overwing exit zone pitched at 34"` |
| measured | registry.json#/lopa_rows/*/is_exit_row | rows with is_exit_row=true per lopa_id: `{"738":[14,15,16],"73G":[15],"7M8-1":[14,15,16],"738-2":[14,15,16],"7M8-2":[14,15,16]}` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/40/recline_restriction_reason; rows.xlsx#southwest_737_lopa_rows!I42 | lopa_rows[738, row 14].recline_restriction_reason: `FAA regulation: forward overwing exit row immediately ahead of exit Row 15` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/41/recline_restriction_reason; rows.xlsx#southwest_737_lopa_rows!I43 | lopa_rows[738, row 15].recline_restriction_reason: `FAA regulation: center overwing exit row` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/42/is_exit_row; rows.xlsx#southwest_737_lopa_rows!F44 | lopa_rows[738, row 16].is_exit_row: `true` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/42/row_notes; rows.xlsx#southwest_737_lopa_rows!J44 | lopa_rows[738, row 16].row_notes: `16A and 16F have unobstructed legroom (no seat directly ahead); Row 16 reclines normally` |
| registry JSON + seats CSV | registry.json#/lopa_seats/223/special_notes; seats.csv:L225:R(special_notes) | lopa_seats[738, 16B].special_notes: `Overwing exit zone; FAA exit seating criteria apply` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/13/is_exit_row; rows.xlsx#southwest_737_lopa_rows!F15 | lopa_rows[73G, row 14].is_exit_row: `false` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/13/row_notes; rows.xlsx#southwest_737_lopa_rows!J15 | lopa_rows[73G, row 14].row_notes: `14A omitted to preserve clear access to port-side overwing exit hatch` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/13/active_seat_count; rows.xlsx#southwest_737_lopa_rows!D15 | lopa_rows[73G, row 14].active_seat_count: `5` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/14/is_exit_row; rows.xlsx#southwest_737_lopa_rows!F16 | lopa_rows[73G, row 15].is_exit_row: `true` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/14/active_seat_count; rows.xlsx#southwest_737_lopa_rows!D16 | lopa_rows[73G, row 15].active_seat_count: `6` |
| DOCX | DOCX#T01.R02.C03 | `Single cabin, 3-3 seating; one double-seat exit-row section` |

- **Why:** On the larger aircraft 3 rows (14, 15, 16) are flagged as exit rows although the text describes twin overwing exits and calls one of them a row that "reclines normally" in an "exit zone". On 73G the 5-seat row whose missing seat is explained by exit access is not flagged, and the flagged exit row has 6 seats — while the DOCX describes the 137-seat aircraft as having "one double-seat exit-row section". "Exit row" therefore means different things (next to a hatch, inside an exit zone, subject to seating criteria) and the sources do not say which.
- **Impact:** Exit-related appearance items or placards could be assigned to the wrong rows; the flags must not be read as a regulatory determination.
- **Decision (non-destructive):** Store is_exit_row and is_exit_seat as separate raw claims labelled "exit-zone claim (source)". Keep the DOCX arrangement sentence as a raw claim on the 137-seat category, flagged as not matching the registry row flags. No regulatory meaning is attached. Unresolved.
- **Evidence still needed:** LOPA showing exit locations per side and the rows adjacent to them.
- **Checks:** ✔ 73G row with an omitted seat (14) is not flagged as exit row while row 15 is

## C12 — Seat width differs between configurations with the same hardware label and from the DOCX ranges

**Type:** substantive conflict (unexplained) + representation difference  
**Scope:** max_seat_width_inches (layout level) and effective_width_inches (seat level); DOCX "Seat width" ranges.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/0/max_seat_width_inches; configurations.csv:L2:P(max_seat_width_inches) | lopa_configurations[73G].max_seat_width_inches: `17.0` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/1/max_seat_width_inches; configurations.csv:L3:P(max_seat_width_inches) | lopa_configurations[738].max_seat_width_inches: `17.8` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/2/max_seat_width_inches; configurations.csv:L4:P(max_seat_width_inches) | lopa_configurations[7M8-1].max_seat_width_inches: `17.8` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/3/max_seat_width_inches; configurations.csv:L5:P(max_seat_width_inches) | lopa_configurations[738-2].max_seat_width_inches: `17.8` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/4/max_seat_width_inches; configurations.csv:L6:P(max_seat_width_inches) | lopa_configurations[7M8-2].max_seat_width_inches: `17.3` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/3/seat_hardware_model; configurations.csv:L5:G(seat_hardware_model) | lopa_configurations[738-2].seat_hardware_model: `RECARO R2` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/4/seat_hardware_model; configurations.csv:L6:G(seat_hardware_model) | lopa_configurations[7M8-2].seat_hardware_model: `RECARO R2` |
| DOCX | DOCX#T01.R02.C06; DOCX#T01.R03.C06 | `15.5-17.0 in.` |
| DOCX | DOCX#T01.R04.C06; DOCX#T01.R05.C06 | `15.5-17.8 in.` |
| measured | evidence/cross-format-comparison.json#/totals/explicit_conversions | numeric values whose CSV text differs lexically from the JSON number (e.g. "17.0" vs 17): `132` |

- **Why:** 2 registry records share the hardware label `RECARO R2` but declare different maximum widths (738-2: 17.8, 7M8-2: 17.3); the DOCX gives one range for both larger-aircraft categories. Separately, the same number is written with a trailing zero in CSV and without in JSON — a pure representation difference.
- **Impact:** A width shown for a seat depends on the record chosen; numeric round-tripping silently changes the written form.
- **Decision (non-destructive):** Store widths as raw claims per source and level with measurement_kind "unspecified by source". Keep the CSV decimal text beside the JSON number. No normalisation across records. Unresolved.
- **Evidence still needed:** Seat supplier data per hardware model and installation.
- **Checks:** ✔ the two Elevate records declare different max_seat_width_inches

## C13 — Estimated fleet counts are qualified free text and cannot be reconciled with the DOCX fleet numbers

**Type:** ambiguity  
**Scope:** Layout.estimated_fleet_count_claim; anything resembling fleet size per layout.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/0/est_active_aircraft; configurations.csv:L2:H(est_active_aircraft) | lopa_configurations[73G].est_active_aircraft: `~277` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/1/est_active_aircraft; configurations.csv:L3:H(est_active_aircraft) | lopa_configurations[738].est_active_aircraft: `~204` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/2/est_active_aircraft; configurations.csv:L4:H(est_active_aircraft) | lopa_configurations[7M8-1].est_active_aircraft: `~315` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/3/est_active_aircraft; configurations.csv:L5:H(est_active_aircraft) | lopa_configurations[738-2].est_active_aircraft: `~46+ (expanding)` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/4/est_active_aircraft; configurations.csv:L6:H(est_active_aircraft) | lopa_configurations[7M8-2].est_active_aircraft: `New deliveries (Oct 2025+)` |
| DOCX | DOCX#P005 | `170 selected -700s are upgraded` |
| DOCX | DOCX#P005 | `Southwest expects the remaining non-upgraded aircraft to be retired, sold or otherwise removed from the fleet.` |

- **Why:** The registry values are approximations ("~"), open-ended ("+ (expanding)") or not numbers at all. The DOCX gives a different kind of number (aircraft selected for an upgrade to a layout the registry does not contain). Neither is a list of aircraft.
- **Impact:** No fleet size, percentage or tail population can be computed.
- **Decision (non-destructive):** Keep each string verbatim as an estimate claim; never parse it into a number; never create Aircraft or TailAssignment records from it. Unresolved.
- **Evidence still needed:** A dated fleet list with tail numbers and installed layout.
- **Checks:** ✔ no est_active_aircraft value is a plain number

## C14 — Seat hardware and interior names differ between sources

**Type:** ambiguity (naming / crosswalk)  
**Scope:** MaintenanceVariant and SeatHardware labels.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| DOCX | DOCX#P005 | `The 138-seat version replaces Innovator seats with Meridian seats, adds in-seat power and converts the affected exit-row position to a triple-seat arrangement.` |
| DOCX | DOCX#P007 | `Existing aircraft can have Innovator, Collins Meridian or RECARO R2 seating, depending on the aircraft and retrofit status.` |
| RTF | RTF#T01.R06.C02 | `2025 "Elevate" Factory` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/0/seat_hardware_model; configurations.csv:L2:G(seat_hardware_model) | lopa_configurations[73G].seat_hardware_model: `Legacy Slimline (Retrofitted)` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/1/seat_hardware_model; configurations.csv:L3:G(seat_hardware_model) | lopa_configurations[738].seat_hardware_model: `Collins / BE Aerospace Heart Slimline` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/2/seat_hardware_model; configurations.csv:L4:G(seat_hardware_model) | lopa_configurations[7M8-1].seat_hardware_model: `Pre-Oct 2025 Boeing Sky Interior Slimline` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/3/seat_hardware_model; configurations.csv:L5:G(seat_hardware_model) | lopa_configurations[738-2].seat_hardware_model: `RECARO R2` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/4/seat_hardware_model; configurations.csv:L6:G(seat_hardware_model) | lopa_configurations[7M8-2].seat_hardware_model: `RECARO R2` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/3/configuration_name; configurations.csv:L5:E(configuration_name) | lopa_configurations[738-2].configuration_name: `2025 "Elevated" Retrofit Cabin` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/4/configuration_name; configurations.csv:L6:E(configuration_name) | lopa_configurations[7M8-2].configuration_name: `2025 "Elevated" Factory Cabin` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/0/interior_generation; configurations.csv:L2:F(interior_generation) | lopa_configurations[73G].interior_generation: `2026 Cabin Retrofit` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/1/interior_generation; configurations.csv:L3:F(interior_generation) | lopa_configurations[738].interior_generation: `Legacy "Heart" Cabin` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/2/interior_generation; configurations.csv:L4:F(interior_generation) | lopa_configurations[7M8-1].interior_generation: `Pre-Oct 2025 Sky/Heart` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/3/interior_generation; configurations.csv:L5:F(interior_generation) | lopa_configurations[738-2].interior_generation: `2025 "Elevate" (RECARO R2)` |

(+3 further located claims for this entry in `conflict-register.json`.)

- **Why:** The DOCX names seat products that never appear in the registry or the RTF, while the registry uses other labels. Within the registry the same interior is written two ways in different fields, and the 737-700 record is described as both "Legacy" hardware and a "Retrofit" generation while the DOCX associates the 137-seat layout with aircraft that are not upgraded. No source maps one naming scheme to the other.
- **Impact:** Hardware-dependent appearance rules cannot be keyed reliably; synonyms might be merged wrongly.
- **Decision (non-destructive):** Store every label verbatim with its source. No synonym merging. Any MaintenanceVariant / SeatHardware crosswalk is an explicit table with status "assumed, unverified". Unresolved.
- **Evidence still needed:** Authoritative seat model per layout (and per tail), with part numbers.
- **Checks:** ✔ DOCX seat product names "Innovator" and "Meridian" do not occur in the registry

## C15 — In-seat power claims are airframe-dependent alternatives copied to every seat

**Type:** ambiguity  
**Scope:** SeatPhysicalAttributes.power at layout and seat level.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/0/in_seat_power; configurations.csv:L2:Q(in_seat_power) | lopa_configurations[73G].in_seat_power: `None (legacy) / USB-C on select retrofits` |
| registry JSON + seats CSV | registry.json#/lopa_seats/0/power_type; seats.csv:L2:Q(power_type) | lopa_seats[73G, 1A].power_type: `None / Select USB-C` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/1/in_seat_power; configurations.csv:L3:Q(in_seat_power) | lopa_configurations[738].in_seat_power: `None (most airframes)` |
| registry JSON + seats CSV | registry.json#/lopa_seats/137/power_type; seats.csv:L139:Q(power_type) | lopa_seats[738, 1D].power_type: `None (most airframes)` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/2/in_seat_power; configurations.csv:L4:Q(in_seat_power) | lopa_configurations[7M8-1].in_seat_power: `None (early deliveries) / USB on newer frames` |
| registry JSON + seats CSV | registry.json#/lopa_seats/312/power_type; seats.csv:L314:Q(power_type) | lopa_seats[7M8-1, 1D].power_type: `None (early deliveries) / USB on newer frames` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/3/in_seat_power; configurations.csv:L5:Q(in_seat_power) | lopa_configurations[738-2].in_seat_power: `USB-A & USB-C at every seat` |
| registry JSON + seats CSV | registry.json#/lopa_seats/487/power_type; seats.csv:L489:Q(power_type) | lopa_seats[738-2, 1D].power_type: `USB-A & USB-C` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/4/in_seat_power; configurations.csv:L6:Q(in_seat_power) | lopa_configurations[7M8-2].in_seat_power: `USB-A & USB-C at every seat` |
| registry JSON + seats CSV | registry.json#/lopa_seats/662/power_type; seats.csv:L664:Q(power_type) | lopa_seats[7M8-2, 1D].power_type: `USB-A & USB-C` |
| DOCX | DOCX#P005 | `adds in-seat power` |
| measured | registry.json#/lopa_seats/*/power_type | distinct power_type values per lopa_id: `{"738":["None (most airframes)"],"73G":["None / Select USB-C"],"7M8-1":["None (early deliveries) / USB on newer frames"],"738-2":["USB-A & USB-C"],"7M8-2":["USB-A & USB-C"]}` |

- **Why:** Configuration-level and seat-level strings word the same claim differently, several state alternatives that depend on the individual airframe ("select retrofits", "newer frames", "most airframes"), and each configuration repeats one string on all of its seats. The DOCX ties in-seat power to the upgraded layout that has no registry record.
- **Impact:** Whether a given seat on a given aircraft has power cannot be stated.
- **Decision (non-destructive):** Keep both strings verbatim at their own level. Power is shown as "source claim, airframe-dependent"; it is never asserted for a specific aircraft without tail-level evidence. Unresolved.
- **Evidence still needed:** Per-tail modification status.
- **Checks:** ✔ each configuration uses exactly one power_type string for all of its seats

## C16 — Compound enumeration values and unverified regulatory attributions

**Type:** ambiguity  
**Scope:** recline_status, window_status and their reason/notes fields.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| measured | registry.json#/lopa_rows/*/recline_status | distinct recline_status values (rows): `{"Standard":125,"N/A":4,"None":7,"None/Limited":5,"None/Restricted":6}` |
| measured | registry.json#/lopa_seats/*/window_status | distinct window_status values (seats): `{"Standard":221,"N/A":564,"Misaligned/Set-Back":38,"Limited/Missing":2,"Missing":4,"Limited/Obstructed":8}` |
| measured | cabin schema architecture.csv:L4:Grain & Purpose | schema CSV wording for window_status: `window_status (Standard/Missing/Limited/Obstructed/Misaligned/Set-Back/N/A)` |
| RTF | RTF#P041 | `Limited or zero recline against the twin aft lavatory bulkheads.` |
| RTF | RTF#P040 | `Zero / severely restricted recline (center overwing exit row).` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/41/recline_status; rows.xlsx#southwest_737_lopa_rows!H43 | lopa_rows[738, row 15].recline_status: `None/Restricted` |
| RTF | RTF#P016 | `Locked / zero recline per FAA regulations` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/13/recline_restriction_reason; rows.xlsx#southwest_737_lopa_rows!I15 | lopa_rows[73G, row 14].recline_restriction_reason: `FAA regulation: immediately forward of overwing exit Row 15` |
| RTF | RTF#P013 | `Flagged in Southwest's official seat-selection disclosure` |

- **Why:** Values such as "None/Limited", "None/Restricted", "Limited/Missing" and "Misaligned/Set-Back" state alternatives rather than one condition. The schema summary lists window statuses as one slash-separated string that can be read as separate values, while the data uses compound values. Reasons citing regulation or an "official disclosure" are attributions with no reference supplied.
- **Impact:** Filtering or rule logic on these values would need an interpretation the sources do not give.
- **Decision (non-destructive):** Store the enumeration strings exactly as supplied (no splitting, no mapping to a stricter enum). Show reason text as "source note". No rule is derived from a regulatory attribution. Unresolved.
- **Evidence still needed:** Definitions of each status; the cited disclosure or regulatory basis.
- **Checks:** ✔ at least one status value contains a "/" alternative

## C17 — Workbook stores one identifier as a number and blanks as absent cells

**Type:** representation difference  
**Scope:** southwest_737_lopa_rows.xlsx only.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| measured | rows.xlsx#southwest_737_lopa_rows!A29 … southwest_737_lopa_rows!A58 | lopa_id cells stored as numbers in the workbook: `30` |
| measured | rows.xlsx#southwest_737_lopa_rows!A29 | first such cell: raw value / type: `738 / number` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/1/lopa_id; configurations.csv:L3:A(lopa_id) | lopa_configurations[738].lopa_id: `738` |
| measured | evidence/extracts/workbook.json#/normalization | cells absent from the sheet XML where the JSON holds an empty string: `377` |
| measured | rows.xlsx#docProps/app.xml, xl/workbook.xml | workbook application / recorded authoring path: `Microsoft Macintosh Excel / /Users/joe/Downloads/` |

- **Why:** Pure representation: the spreadsheet typed the all-digit identifier as a number and omits empty cells. After two explicit conversions every value agrees with the JSON (see cross-format comparison).
- **Impact:** A naive import would produce a numeric key that fails to join to the string key in the other files, and nulls instead of empty strings.
- **Decision (non-destructive):** Import treats lopa_id as a string and records the numeric-to-string conversion per cell; absent cells become "" with the conversion recorded. No other coercion is applied anywhere. Resolved as a representation rule (the underlying claims stay unverified).
- **Evidence still needed:** None for the representation; the claims themselves still need independent verification.
- **Checks:** ✔ conversions leave zero mismatches against the JSON

## C18 — Two byte-identical JSON-named files are invalid templates, one named almost like the populated registry

**Type:** representation difference (artifact role)  
**Scope:** SourceArtifact roles for the three JSON-named files.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| measured | southwest 737 lopa normalized.json (whole file) | southwest 737 lopa normalized.json: size / sha256 / parses: `548 / 881e1c40b1d259ec1f568354d542d478ce532e8fd07ccc4addf7dc6d8ac1852d / false` |
| measured | gemini-code-1794587815855.json (whole file) | gemini-code-1794587815855.json: size / sha256 / parses: `548 / 881e1c40b1d259ec1f568354d542d478ce532e8fd07ccc4addf7dc6d8ac1852d / false` |
| measured | evidence/extracts/json-compare.json#/pairwise | byte-identical: `true` |
| measured | southwest 737 lopa normalized.json@byte 492 | first syntax error (offset, line:column, found): `492, 12:28, "."` |
| measured | southwest 737 lopa normalized.json@bytes 490, 514, 539 | literal "[ ... ]" placeholders: `3` |

- **Why:** The space-named file and the generated-code file are the same bytes: an envelope with a metadata header and elided arrays. It is not valid JSON and holds no records. Its name differs from the populated registry only by spaces vs underscores, so file-name based selection is unsafe.
- **Impact:** Importing by name could pick the template; "repairing" it would invent content.
- **Decision (non-destructive):** Both are inventoried as invalid template artifacts, excluded from import and never repaired. The populated registry is recognised by content (valid JSON with populated arrays and its SHA-256), not by file name.
- **Evidence still needed:** None.
- **Checks:** ✔ both files are 548 bytes; ✔ byte-identical; ✔ neither parses as JSON; ✔ contains the literal "[ ... ]"
- **Brief expectation:** CONFIRMED — The 548-byte space-named JSON and gemini JSON are byte-identical invalid templates containing literal "[ ... ]".

## C19 — DOCX wording of the extra pitch ("up to five" / "approximately three" vs "five" / "three")

**Type:** ambiguity (minor, internal to one document)  
**Scope:** Any derived "extra legroom inches" figure.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| DOCX | DOCX#T02.R02.C03 | `737-700: 35-36-inch pitch, up to five inches more than standard. 737-800/MAX 8: 34-inch pitch, approximately three inches more than standard` |
| DOCX | DOCX#P010 | `five inches on the 737-700 and three inches on the 737-800/MAX 8` |
| DOCX | DOCX#T01.R02.C04; DOCX#T01.R03.C04 | `35-36 in.` |
| DOCX | DOCX#T01.R02.C05; DOCX#T01.R03.C05 | `31-33 in.` |
| DOCX | DOCX#T01.R04.C05; DOCX#T01.R05.C05 | `31-32 in.` |

- **Why:** The table qualifies the extra pitch ("up to", "approximately"); the following paragraph states it without qualifiers. With the document's own ranges the difference is a span, not one number.
- **Impact:** A single "extra inches" figure would overstate precision.
- **Decision (non-destructive):** No derived "extra inches" attribute is created. Both sentences are kept as raw claims.
- **Evidence still needed:** None beyond the pitch evidence in C03.
- **Checks:** ✔ both wordings are present

## C20 — Cited sources cannot be verified from the supplied files

**Type:** assumption  
**Scope:** Every DOCX statement that rests on a cited page or message; all RTF statements (which cite nothing).

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| DOCX | DOCX#P003 | `The measurements above are Southwest’s published ranges.` |
| DOCX | DOCX#P021 | `Recent Tech Ops communication identifies a planned` |
| measured | evidence/extracts/docx-hyperlinks.json, evidence/extracts/hyperlinks-check.json | DOCX hyperlinks: total / distinct targets / private (not accessed) / public requested: `13 / 9 / 5 / 4` |
| measured | evidence/extracts/hyperlinks-check.json#/summary/status_codes | public link reachability (final HTTP status per URL): `200, 200, 200, 200` |
| measured | DOCX#docMetadata/LabelInfo.xml | DOCX sensitivity-label references: `1` |
| measured | Southwest Cabin Configuration Standard.rtf | RTF hyperlinks: `0` |

- **Why:** The DOCX attributes its figures to published ranges and to intranet pages and a mail item. The private targets were deliberately not accessed, and a status code from a public page says nothing about what the page states or whether it is current. The RTF contains no citations at all.
- **Impact:** No narrative claim can be treated as verified.
- **Decision (non-destructive):** Store each hyperlink as a cited reference with its access class and reachability note. No claim is promoted to "verified" on the strength of a link. All narrative claims remain "unverified source claim".
- **Evidence still needed:** Copies of the cited pages/messages supplied through an approved channel, or the underlying controlled documents.
- **Checks:** ✔ no private host was requested

## C21 — Reference images: third-party metadata, another airline named, no link to any layout

**Type:** ambiguity (provenance) + gap (not supplied)  
**Scope:** All supplied images as possible MaterialProfile / visual references.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| forward galley flight deck.jpg | forward galley flight deck.jpg#IPTC:2:25 Keywords | `American Airlines` |
| forward galley flight deck.jpg | forward galley flight deck.jpg#XMP:dc:subject | `American Airlines` |
| forward galley flight deck.jpg | forward galley flight deck.jpg#IPTC:2:5 ObjectName | `AA LAX Thursday` |
| forward galley flight deck.jpg | forward galley flight deck.jpg#IPTC:2:116 CopyrightNotice | `Brandon Wade` |
| forward galley flight deck.jpg | forward galley flight deck.jpg#IPTC:2:120 Caption-Abstract | `at LAX in Los Angeles, Thursday, August 27, 2015. Photo by Brandon Wade` |
| forward galley flight deck.jpg | forward galley flight deck.jpg#EXIF.IFD0:DateTime | `2015:09:17 14:43:06` |
| forward galley flight deck.jpg | forward galley flight deck.jpg#EXIF.IFD0:Copyright | `Brandon Wade` |
| Southwest-Airlines-new-RECARO-seats-Video-still-Southwest.png | Southwest-Airlines-new-RECARO-seats-Video-still-Southwest.png#EXIF.Exif:UserComment | `Screenshot` |
| measured | Southwest-Airlines-new-RECARO-seats-Video-still-Southwest.png#IHDR / XMP | PNG: encoded size vs size declared in its XMP: `970x521 vs 1920x1200` |
| carpet.jpg | carpet.jpg#EXIF.IFD0:Make | `Google` |
| carpet.jpg | carpet.jpg#EXIF.IFD0:Model | `Pixel 6a` |
| carpet.jpg | carpet.jpg#EXIF.IFD0:DateTime | `2024:09:26 15:37:12` |
| measured | carpet.jpg#EXIF.GPS | carpet.jpg GPS data present in EXIF: `true` |
| measured | evidence/inventory.json | images with no descriptive text metadata at all (ICC profile text excluded): `9 of 14` |

(+1 further located claims for this entry in `conflict-register.json`.)

- **Why:** The forward-galley photograph's embedded keywords name another airline, its capture date is 2015:08:27 15:57:30, and it carries a photographer credit and copyright; one image declares itself a screenshot whose stated source size differs from the file; 9 of 14 images carry no descriptive metadata. File names are the only hint of subject, and no image is tied to a layout, tail, row, seat or material specification.
- **Impact:** Using an image as the expected appearance for a Southwest layout would be unsupported; licence terms are unknown.
- **Decision (non-destructive):** Images are stored as unverified reference media with their extracted metadata. None is bound to a Layout, tail or MaterialProfile. The forward-galley image is flagged "metadata names another airline" and is not offered as a Southwest visual reference unless a user links it explicitly with a recorded reason. Credit/copyright metadata is preserved and shown; use is limited to the local demo. Unresolved.
- **Evidence still needed:** A catalogued, licensed image set with layout/tail/date for each image.
- **Checks:** ✔ forward-galley photo metadata contains an airline name other than Southwest; ✔ forward-galley photo metadata does not mention Southwest
- **Brief expectation:** CONFIRMED — One forward-galley photo is expected to carry another airline's name in its metadata.

## C22 — Crosswalk assumption: DOCX categories ↔ registry records

**Type:** assumption  
**Scope:** The link between DOCX categories (137-seat, 138-seat, temporary, final) and registry lopa_ids.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| DOCX | DOCX#T01.R05.C03 | `Single cabin, 3-3 seating; three seats on both sides of the exit row and two seats on both sides of the last row` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/101/active_seat_count; rows.xlsx#southwest_737_lopa_rows!D103 | lopa_rows[738-2, row 15].active_seat_count: `6` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/116/active_seat_count; rows.xlsx#southwest_737_lopa_rows!D118 | lopa_rows[738-2, row 30].active_seat_count: `4` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/116/omitted_seat_letters; rows.xlsx#southwest_737_lopa_rows!E118 | lopa_rows[738-2, row 30].omitted_seat_letters: `A,F` |
| DOCX | DOCX#T01.R04.C03 | `Single cabin, 3-3 seating; reduced seating at part of the exit-row and rear-row areas` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/41/active_seat_count; rows.xlsx#southwest_737_lopa_rows!D43 | lopa_rows[738, row 15].active_seat_count: `4` |
| registry JSON + rows XLSX | registry.json#/lopa_rows/56/active_seat_count; rows.xlsx#southwest_737_lopa_rows!D58 | lopa_rows[738, row 30].active_seat_count: `6` |
| DOCX | DOCX#T01.R02.C01 | `737-700, 137-seat LOPA` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/0/total_seats; configurations.csv:L2:I(total_seats) | lopa_configurations[73G].total_seats: `137` |
| registry JSON + configurations CSV | registry.json#/lopa_configurations/0/interior_generation; configurations.csv:L2:F(interior_generation) | lopa_configurations[73G].interior_generation: `2026 Cabin Retrofit` |
| DOCX | DOCX#P007 | `New deliveries use the RECARO interior; selected -800s and -700s are also being converted as part of the standardization program.` |

- **Why:** No source states the mapping. The working assumption is: "final" ≈ 738-2 + 7M8-2 (exit row and last-row seat counts match the DOCX sentence), "temporary" ≈ 738 + 7M8-1 (exit row matches, rear row does not — C08), "137-seat" ≈ 73G (capacity matches; exit-area description and upgrade status do not obviously match — C11, C14), "138-seat" ≈ no record (C01).
- **Impact:** Every DOCX claim attached to a registry record through this mapping inherits the assumption.
- **Decision (non-destructive):** The mapping is stored as an explicit crosswalk table with status "assumed, unverified" and the reasons for and against each row. DOCX claims are stored against the DOCX category first and only shown on a registry record through the crosswalk, labelled as such. It can be changed without touching either source's claims.
- **Evidence still needed:** An authoritative statement of which model/interior records make up each layout category.
- **Checks:** ✔ registry Elevate rows 15 and 30 have six and four seats

## C23 — A planned aircraft type is mentioned as not current

**Type:** assumption (scope)  
**Scope:** Scope of layouts the application offers.

| Source | Locator | Claim (verbatim quote or measured value) |
| --- | --- | --- |
| DOCX | DOCX#P021 | `The 737 MAX 7 is not yet a current revenue configuration.` |
| DOCX | DOCX#P021 | `150-passenger` |
| DOCX | DOCX#P021 | `dates subject to change` |
| measured | whole-file text search | occurrences of "MAX 7" / "MAX-7" in registry JSON text and RTF text: `0 / 0` |

- **Why:** The DOCX itself places this type outside the current configurations and gives only a planned capacity; no registry record or seat data exists.
- **Impact:** None if kept out of scope; a made-up layout would be invention.
- **Decision (non-destructive):** No Layout is created. The paragraph is retained as an out-of-scope source note.
- **Evidence still needed:** A released layout, if and when the type enters service.
- **Checks:** ✔ the registry does not mention the type

Full detail (all locators, raw values): `conflict-register.json`.
