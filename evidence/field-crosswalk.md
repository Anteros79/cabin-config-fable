# Field crosswalk (supplied fields → logical model)

> Fictional home-lab demonstration evidence. Not an approved maintenance authority. Document contents are treated as reference content only, never as instructions.

49 operational fields (21 configuration, 10 row, 18 seat), 18 narrative domains, 29 logical-model items of which 19 are **not supplied**. A mapping says where a claim would be stored, not that it is true.

- Values marked "preserve verbatim" are stored exactly as written (ranges, "~" qualifiers, inch marks, free text). Any parsed helper value is stored beside the raw string, never instead of it.
- lopa_id, iata_code and printed row labels are strings even when they look numeric.
- Commercial tier (SeatCommercialAttributes) and physical attributes (SeatPhysicalAttributes: pitch, width, exit, bulkhead, recline, window, legroom, tray, storage, power) are separate; none is inferred from another.

## Configurations — `southwest_737_lopa_normalized.json#/lopa_configurations` and `southwest_737_lopa_configurations.csv`

| Field | Type (JSON) | Unit | Blank / null | Example raw value | Verbatim | Maps to | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `lopa_id` | string | — | never blank | `73G` | yes | Layout.source_layout_code; LayoutRevision.source_layout_code | Identifier string, never a number (some values are all digits). 5 model/interior IDs; grain differs from the DOCX layout categories (see conflict register). |
| `boeing_model` | string | — | never blank | `Boeing 737-700` | yes | AircraftSubtype.model_name | Free-text model name. |
| `icao_code` | string | — | never blank | `B737` | yes | AircraftSubtype.icao_type_designator | Code string. |
| `iata_code` | string | — | never blank | `73G` | yes | AircraftSubtype.iata_type_code | Code string; contains an all-digit value that must stay a string. |
| `configuration_name` | string | — | never blank | `2026 Cabin Iteration (Retrofitted)` | yes | Layout.name_claim | Label as written, including embedded quotes. |
| `interior_generation` | string | — | never blank | `2026 Cabin Retrofit` | yes | LayoutRevision.interior_generation_label; MaintenanceVariant.label_candidate | Generation label; not a revision identifier or approval. |
| `seat_hardware_model` | string | — | never blank | `Legacy Slimline (Retrofitted)` | yes | SeatHardware.model_label_claim; MaintenanceVariant.label_candidate | Hardware label only: no part numbers, no vendor documents. Naming differs from the DOCX. |
| `est_active_aircraft` | string | aircraft (approximate) | never blank | `~277` | yes | Layout.estimated_fleet_count_claim | Qualified estimate or free text. Not a tail list; does NOT populate Aircraft(tail) or TailAssignment. |
| `total_seats` | integer | seats | never blank | `137` | no | LayoutRevision.declared_total_seats | Declared total; checked against counted SeatLocation records. |
| `extra_legroom_seats` | integer | seats | never blank | `42` | no | LayoutRevision.declared_tier_count[Extra Legroom] | Declared commercial-tier count; checked against SeatCommercialAttributes. |
| `preferred_seats` | integer | seats | never blank | `23` | no | LayoutRevision.declared_tier_count[Preferred] | Declared commercial-tier count. |
| `standard_seats` | integer | seats | never blank | `72` | no | LayoutRevision.declared_tier_count[Standard] | Declared commercial-tier count. |
| `numbered_row_range` | string | printed row labels | never blank | `1-9, 14-27 (skips 10-13)` | yes | RowLabel.declared_label_range_claim | Describes printed labels, not physical row count. |
| `elr_pitch_inches` | string | inches | never blank | `35-36` | yes | SeatPhysicalAttributes.pitch_claim (layout-level, Extra Legroom) | Single value, range, or range with parenthetical "~" qualifier. Keep raw; optional parsed min/max/qualifier stored beside it. |
| `standard_pitch_inches` | string | inches | never blank | `31-33` | yes | SeatPhysicalAttributes.pitch_claim (layout-level, Standard/Preferred) | Range string. |
| `max_seat_width_inches` | number (decimal) | inches | never blank | `17` | yes | SeatPhysicalAttributes.width_claim (layout-level, measurement_kind = "max seat width", kind not defined by source) | Number in JSON, decimal text in CSV. What is measured (cushion, between armrests, shoulder) is not stated. |
| `in_seat_power` | string | — | never blank | `None (legacy) / USB-C on select retrofits` | yes | SeatPhysicalAttributes.power_claim (layout-level) | Alternatives separated by "/" depend on the airframe; not resolvable without tail data. |
| `wifi_system` | string | — | never blank | `Anuvu Ku-band` | yes | (no logical-model target) LayoutRevision.raw_source_attributes | Outside the cabin-appearance model. One value embeds a tail-like token; kept as raw text only. |
| `lavatory_count_fwd` | integer | lavatories | never blank | `1` | no | FloorArea (count only) → LayoutRevision.raw_source_attributes | A count, not a floor map: no position, footprint or module id. |
| `lavatory_count_aft` | integer | lavatories | never blank | `1` | no | FloorArea (count only) → LayoutRevision.raw_source_attributes | A count, not a floor map. |
| `notes` | string | — | never blank | `Single overwing exit at Row 15; Rows 10-13 omitted from numbering; 14A omitted for exit access.` | yes | LayoutRevision.source_notes | Free text. |

## Rows — `southwest_737_lopa_normalized.json#/lopa_rows` and `southwest_737_lopa_rows.xlsx`

| Field | Type (JSON) | Unit | Blank / null | Example raw value | Verbatim | Maps to | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `lopa_id` | string | — | never blank | `73G` | yes | RowLabel.layout_revision_ref | Foreign key to the configuration. Stored as a NUMBER in 30 workbook cells; must be handled as an identifier string. |
| `row_number` | integer | printed row label | never blank | `1` | yes | RowLabel.printed_label | A printed label, not a physical index. RowLabel.physical_order is DERIVED (ascending label over existing rows) and flagged as an assumption. |
| `row_exists` | boolean | — | never blank | `true` | no | RowLabel.exists | false = label skipped in the cabin (no physical row). |
| `active_seat_count` | integer | seats | never blank | `6` | no | (derived check) count of SeatLocation per RowLabel | Redundant with the seat records; used as a consistency check only. |
| `omitted_seat_letters` | string | — | "" ×134 | `A,B,C,D,E,F` | yes | (derived check) absent SeatLocation letters per RowLabel | Comma-separated letters; blank when none. |
| `is_exit_row` | boolean | — | never blank | `false` | no | RowLabel.exit_row_claim → SeatPhysicalAttributes.exit (row-level claim) | Row-level flag; semantics differ between configurations (see conflict register). |
| `is_bulkhead_row` | boolean | — | never blank | `true` | no | RowLabel.bulkhead_row_claim → SeatPhysicalAttributes.bulkhead (row-level claim) | Row-level flag cannot express a bulkhead on one side only; seat-level flags are kept separately. |
| `recline_status` | string | — | never blank | `Standard` | yes | SeatPhysicalAttributes.recline (row-level claim) | Compound enumeration values such as "None/Limited" are raw claims. |
| `recline_restriction_reason` | string | — | "" ×125 | `Row number skipped in cabin layout` | yes | SeatPhysicalAttributes.recline_reason_claim | Free text, includes unverified regulatory attributions. |
| `row_notes` | string | — | "" ×118 | `Dual-sided forward bulkhead; armrest tray tables; no underseat floor stowage` | yes | RowLabel.source_notes | Free text, carries pitch and seat statements with inch marks. |

## Seats — `southwest_737_lopa_normalized.json#/lopa_seats` and `southwest_737_lopa_seats.csv`

| Field | Type (JSON) | Unit | Blank / null | Example raw value | Verbatim | Maps to | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `lopa_id` | string | — | never blank | `73G` | yes | SeatLocation.layout_revision_ref | Part of seat identity. |
| `row_number` | integer | printed row label | never blank | `1` | yes | SeatLocation.printed_row_label | Part of seat identity; printed label, not physical order. |
| `seat_letter` | string | — | never blank | `A` | yes | SeatLocation.letter; SeatLocation.side (DERIVED: A/B/C vs D/E/F); SeatLocation.block (DERIVED) | Part of seat identity. Side/block are not supplied as fields; derived from the letter and flagged as derived. |
| `seat_code` | string | — | never blank | `1A` | yes | SeatLocation.display_code (derived check: printed label + letter) | Redundant with row_number + seat_letter. |
| `seat_position_type` | string | — | never blank | `Window` | no | SeatLocation.position (Window/Middle/Aisle) | Enumeration. |
| `commercial_tier` | string | — | never blank | `Extra Legroom` | no | SeatCommercialAttributes.tier | Commercial product tier only. Must not be used as a proxy for physical spacing. |
| `pitch_range_inches` | string | inches | never blank | `35-36` | yes | SeatPhysicalAttributes.pitch_claim (raw + optional min/max/qualifier) | Holds ranges and single values; approximate source statements appear here without their "~". |
| `effective_width_inches` | number (decimal) | inches | never blank | `15.5` | yes | SeatPhysicalAttributes.width_claim (measurement_kind = "effective width", kind not defined by source) | Mixes seat width with a shoulder-clearance reduction on some seats (see conflict register). |
| `recline_status` | string | — | never blank | `Standard` | yes | SeatPhysicalAttributes.recline | Compound enumeration values are raw claims. |
| `window_status` | string | — | never blank | `Standard` | yes | SeatPhysicalAttributes.window_status | Compound enumeration values are raw claims; "N/A" for non-window seats. |
| `window_notes` | string | — | "" ×785 | `Window frame positioned slightly behind seatback` | yes | SeatPhysicalAttributes.window_notes | Free text. |
| `is_exit_seat` | boolean | — | never blank | `false` | no | SeatPhysicalAttributes.exit | Seat-level flag. |
| `is_bulkhead_seat` | boolean | — | never blank | `true` | no | SeatPhysicalAttributes.bulkhead | Seat-level flag; authoritative granularity for one-sided bulkheads. |
| `has_unobstructed_legroom` | boolean | — | never blank | `false` | no | SeatPhysicalAttributes.legroom_unobstructed | Seat-level flag. |
| `tray_table_location` | string | — | never blank | `Armrest` | no | SeatPhysicalAttributes.tray | Enumeration. |
| `underseat_storage_allowed` | boolean | — | never blank | `false` | no | SeatPhysicalAttributes.storage | Seat-level flag. |
| `power_type` | string | — | never blank | `None / Select USB-C` | yes | SeatPhysicalAttributes.power_claim | Same string on every seat of a configuration; alternatives depend on the airframe. |
| `special_notes` | string | — | "" ×733 | `Bulkhead seat; armrest-stowed tray table; no floor stowage` | yes | SeatLocation.source_notes | Free text. |

## Descriptive summary — `cabin schema architecture.csv`

Columns: `Entity / Table`, `Primary Key`, `Foreign Keys`, `Row Count`, `Grain & Purpose`. Maps to SourceArtifact descriptive metadata only; it contains no operational records.

## Narrative domains (RTF and DOCX)

| Id | Source | Domain | Locator(s) | Maps to | Notes |
| --- | --- | --- | --- | --- | --- |
| N-RTF-01 | RTF | Configuration summary table (variant, interior generation, totals, tier counts with row ranges, omitted positions) | T01.R01.C01 | Layout; LayoutRevision.declared_total_seats; LayoutRevision.declared_tier_count; RowLabel | Tier cells mix a count with a row/seat range in one string. |
| N-RTF-02 | RTF | Row numbering rule (labels aligned so overwing exits fall in a fixed label band; skipped labels) | P001 | RowLabel.printed_label; RowLabel.physical_order (derived) | Basis for separating printed label from physical order. |
| N-RTF-03 | RTF | Row-by-row tier map with pitch statements | P004, P020 | SeatCommercialAttributes.tier; SeatPhysicalAttributes.pitch_claim | Pitch written with inch marks, ranges and "~". |
| N-RTF-04 | RTF | Bulkhead, tray-table and floor-stowage statements | P005 | SeatPhysicalAttributes.bulkhead; SeatPhysicalAttributes.tray; SeatPhysicalAttributes.storage | Side-specific wording (port/starboard). |
| N-RTF-05 | RTF | Window restrictions (missing, limited, misaligned, set-back) | P012, P033, P049 | SeatPhysicalAttributes.window_status; SeatPhysicalAttributes.window_notes | Includes a shoulder-width statement for a windowless seat. |
| N-RTF-06 | RTF | Recline restrictions with stated reasons | P015, P037, P053 | SeatPhysicalAttributes.recline; SeatPhysicalAttributes.recline_reason_claim | Regulatory attributions are unverified claims. |
| N-RTF-07 | RTF | Structural deltas between two interior generations (exit-row seats, pitch, last row) | P044 | LayoutRevision (difference between revisions); SeatLocation; SeatPhysicalAttributes.pitch_claim | Approximate pitch values. |
| N-RTF-08 | RTF | Unobstructed-legroom statements (no seat directly ahead) | P009 | SeatPhysicalAttributes.legroom_unobstructed |  |
| N-DOCX-01 | DOCX | "As of" date and count of active layouts | P002 | SourceArtifact.as_of_claim; Layout (category grain) | A date written in the text; not a validation release. |
| N-DOCX-02 | DOCX | Layout category table (capacity, arrangement, Extra Legroom pitch, Standard/Preferred pitch, seat width) | T01.R01.C01 | Layout (category grain); LayoutRevision.declared_total_seats; SeatPhysicalAttributes.pitch_claim; SeatPhysicalAttributes.width_claim (range, kind = "seat width") | Category grain differs from the registry lopa_id grain; arrangement text names no seats. |
| N-DOCX-03 | DOCX | Measurement definition for pitch and "published ranges" attribution | P003 | SeatPhysicalAttributes.pitch_claim (definition); SourceArtifact (cited source, unverified) | Defines pitch; does not define width. |
| N-DOCX-04 | DOCX | Fleet standardisation narrative (upgrade programme, seat products, power, fleet numbers) | P005 | MaintenanceVariant.label_candidate; SeatHardware.model_label_claim; SeatPhysicalAttributes.power_claim; Layout.estimated_fleet_count_claim | No tail numbers; cannot populate TailAssignment. |
| N-DOCX-05 | DOCX | Temporary vs final layout difference for the larger aircraft | P006 | LayoutRevision (difference between revisions); SeatLocation (unspecified seats) | Seats are described by area, not by seat code. |
| N-DOCX-06 | DOCX | Customer-facing seat tier table (location, physical dimensions, included experience) | T02.R01.C01 | SeatCommercialAttributes.tier (definition); SeatPhysicalAttributes.pitch_claim | Service inclusions have no logical-model target. |
| N-DOCX-07 | DOCX | Seats with Extra Legroom spacing but sold as Preferred (commercial vs physical mismatch) on one layout | P012 | SeatCommercialAttributes.tier; SeatPhysicalAttributes.pitch_claim | Applies only to the layout the DOCX names; that layout has no seat set in the registry. |
| N-DOCX-08 | DOCX | Fare and loyalty access rules | P013 | (no logical-model target) | Commercial policy; outside cabin-appearance scope. Kept as source text only. |
| N-DOCX-09 | DOCX | Aircraft type stated as not currently included (planned layout) | P021 | (no logical-model target; out of scope) | Planned, date subject to change; no registry record. |
| N-DOCX-10 | DOCX | Hyperlink citations (public help pages and private intranet/mail items) | P003, P010, P019 | SourceArtifact.cited_reference (unverified) | Private targets were not accessed; public targets only checked for reachability. |

## Logical model coverage

| Logical entity | Status | Supplied by | Notes |
| --- | --- | --- | --- |
| SourceArtifact | supplied (measured here) | File identity, format, size, SHA-256, internal metadata — produced by this evidence stage (inventory.json). | Provenance beyond the bytes (who issued, whether approved) is not supplied. |
| ValidationRelease | **not supplied** | No approval, sign-off, effectivity or release record in any source. | schema_version and generated_at_utc are generation metadata; the DOCX "As of" date and document titles are text. None is a validation release. |
| AircraftSubtype | supplied (candidate) | boeing_model, icao_code, iata_code (configurations). | 3 distinct model names across 5 configuration records. |
| Aircraft(tail) | **not supplied** | No tail list. | Only tail-like tokens inside free text (see absence checks); they are not aircraft records. |
| Layout | partial | lopa_id, configuration_name (registry: 5 IDs); DOCX layout category table (4 data rows). | Grain conflict between sources; see conflict register. |
| LayoutRevision | partial | interior_generation, declared totals, notes. | No revision identifier, date, drawing or approval reference. |
| RowLabel | supplied (candidate) | row_number (printed label), row_exists. | physical_order is derived by assumption; no station or coordinate. |
| SeatLocation | supplied (candidate) | lopa_id + row_number + seat_letter; seat_position_type. | side and block are derived from the letter, not supplied. |
| SeatCommercialAttributes | supplied (candidate) | commercial_tier. | Kept separate from physical attributes. |
| SeatPhysicalAttributes | supplied (candidate raw claims) | pitch_range_inches, effective_width_inches, is_exit_seat, is_bulkhead_seat, recline_status, window_status/notes, has_unobstructed_legroom, tray_table_location, underseat_storage_allowed, power_type. | Pitch and width are unverified claims with undefined measurement kind for width. |
| MaintenanceVariant | partial | interior_generation / seat_hardware_model labels; DOCX seat product names. | Labels only; naming differs between sources; no variant definition. |
| SeatHardware | partial | seat_hardware_model label. | No part numbers, drawings, vendor data or per-seat hardware assignment. |
| MaterialProfile | **not supplied** | No carpet, seam, upholstery or visual-profile data in any text or table. | Reference images exist but carry no mapping to a layout, tail or material specification. |
| TailAssignment | **not supplied** | No dated tail-to-layout assignment. | Estimated fleet counts are not assignments. |
| FloorArea | **not supplied** | Only lavatory counts and narrative mentions of galleys/lavatories. | No floor map, footprint, position or area identifiers. |
| BinModule | **not supplied** | No overhead-bin data. |  |
| Component | **not supplied** | No component catalogue. |  |
| Part | **not supplied** | No part numbers or part catalogue. |  |
| ApplicabilityRule | **not supplied** | No applicability or effectivity rules. | Free-text hints such as "select retrofits" are not rules. |
| SubstituteApproval | **not supplied** | No substitute or alternate approvals. |  |
| KitChild | **not supplied** | No kit structure. |  |
| Visit | **not supplied** | Application runtime entity; no source counterpart. |  |
| Snapshot | **not supplied** | Application runtime entity; no source counterpart. |  |
| ReplacementRecord | **not supplied** | Application runtime entity; no source counterpart. |  |
| Report | **not supplied** | Application runtime entity; no source counterpart. |  |
| AuditEvent | **not supplied** | Application runtime entity; no source counterpart. |  |
| Coordinate frame / seat coordinates | **not supplied** | No coordinates, stations or datum. |  |
| Cabin height / cross-section dimensions | **not supplied** | No cabin height or cross-section data. |  |
| Image-to-layout mapping | **not supplied** | Images carry no layout, tail, row or seat reference in their metadata. |  |

## Absence checks (keyword mentions across registry, schema CSV, RTF, DOCX)

| Topic | Registry JSON | Schema CSV | RTF | DOCX | Example hit |
| --- | --- | --- | --- | --- | --- |
| tail registration token (N-number) | 1 | 0 | 0 | 0 | registry#/lopa_configurations/2/wifi_system: “N8849Q” |
| part number / manual reference | 0 | 0 | 0 | 0 | — |
| carpet | 0 | 0 | 0 | 0 | — |
| seam | 0 | 0 | 0 | 0 | — |
| upholstery / leather / fabric / dress cover | 0 | 0 | 0 | 0 | — |
| colour | 0 | 0 | 0 | 0 | — |
| overhead bin | 0 | 0 | 0 | 0 | — |
| floor | 35 | 0 | 2 | 0 | registry#/lopa_rows/0/row_notes: “floor” |
| coordinate / station / datum | 0 | 0 | 0 | 0 | — |
| height / ceiling | 0 | 0 | 0 | 0 | — |
| applicability / effectivity | 0 | 0 | 0 | 0 | — |
| substitute / alternate / interchangeable | 0 | 0 | 0 | 0 | — |
| approval / approved / authorised | 0 | 0 | 0 | 0 | — |
| metric length unit | 0 | 0 | 0 | 0 | — |

Counts are text units (field values, paragraphs, cells) that mention the topic. A mention is not a supplied data set.

Full detail: `field-crosswalk.json`.
