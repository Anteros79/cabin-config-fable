# Logical model

Types are in `src/domain/types.ts`. Everything is plain data so it can be frozen into a visit and a report.

## Namespaces

| Namespace | Contents | Can be used for a visit |
| --- | --- | --- |
| `fixture` | Fictional tails, variants, layouts, parts, rules, approvals, documents | Yes (demonstration only) |
| `candidate` | The supplied five-configuration registry as layouts; DOCX layout categories | No: unassigned, explore only |
| `accepted` | Approved airline data | Empty. Validation rejects any tail, assignment, rule, substitute or "approved" source outside `fixture` |

Fixture shortcuts (zones, exit rows, floor areas, bin modules) never enter candidate layouts, and candidate attributes never feed fixture rules.

## Entities

| Entity | Key | Notes |
| --- | --- | --- |
| SourceArtifact | id | Revision, owner, authority (`fictional-fixture` / `supplied-unverified`), released flag, inclusive effective/expiry dates; for files: path, SHA-256, size, read status |
| ReferenceRelease | id | Immutable set of all entities below, content hash, findings, status staged → validated/rejected → active → superseded |
| AircraftSubtype | id | |
| Aircraft | tail | Fixture only |
| MaintenanceVariant | id | Subtype, seat hardware, released flag, list of permitted layout revisions |
| Layout / LayoutRevision | layout id + revision | Immutable. Rows, locations, seat-set status, floor/bin map status, geometry declaration, source |
| RowLabel | printed label | `exists`, physical order (null for skipped labels). Printed label and physical order are separate |
| CabinLocation | layout revision + location id (`SEAT:3A`, `FLOOR:FWD`, `BIN:L-01`) | Composite identity; a seat code alone is never an identity |
| Seat attributes | per seat | Commercial tier; pitch claim (raw, min, max, unit, approximate); width claim (measurement kind); exit; bulkhead; maintenance zone; hardware group. Each independent of the others |
| TailAssignment | id | Tail, variant, layout revision, carpet, seam, upholstery, inclusive dates, source, released/planned |
| ComponentDef | id | Location kind, replacement limit per location |
| Part | part number | |
| ApplicabilityRule | id | Component, part, quantity and unit per replacement, context constraint, location selector, released flag, inclusive dates, source |
| SubstituteApproval | id | Component, primary part it may replace, alternate part, quantity, own constraint, own location scope, own dates, approval source |
| KitChild | parent part > child part | Quantity, unit, source. Nested kits allowed; cycles rejected |
| PendingChange | id | Advisory attached to a rule. Grants nothing |
| LayoutCategory | id | A layout described in narrative evidence, with claims, locators and an inferred or absent crosswalk |
| VisualProfile | id | Unassigned, illustrative image family |
| Visit | id, number | Tail, date, technician, status, version, frozen snapshot and its hash |
| VisitRecord | visit + location + component | Selection (primary or alternate), replacements, note, derived part lines, version |
| Report | visit | Stored at completion; new reports use schema `cabin-kit.report/2`, stored `cabin-kit.report/1` reports are served unchanged |
| VisitEvent | visit + sequence | Created, record added/updated/removed, completed, linked advisory or correction |

One layout serves several variants (fixture `FX-L-S176-800@1` serves V04–V08); a variant may list several layout revisions.

## Lookup

`lookup(release, tail, date)` in `src/domain/resolve.ts`. Dates are calendar dates; **effective-from and effective-to/expiry are both inclusive**.

| State | When |
| --- | --- |
| INVALID_INPUT | Tail or date missing or malformed (including impossible dates). An absent or blank date is `DATE_MISSING`; any other non-string date (a number, a `Date`, an array) is `DATE_INVALID` |
| UNKNOWN_TAIL | Tail not in the release |
| UNCONFIGURED | Known tail with no assignment (`NO_ASSIGNMENTS`) or none covering the date (`DATE_GAP`) |
| OVERLAP | More than one released assignment covers the date. None is selected |
| PLANNED | Only a planned assignment, an unreleased variant or a planned or candidate layout revision covers the date |
| SOURCE_INVALID | The source of the assignment (`CONFIGURATION_SOURCE_INVALID`), the variant (`VARIANT_SOURCE_INVALID`) or the layout revision (`LAYOUT_SOURCE_INVALID`) is missing, unreleased, not yet effective or expired; or aircraft/variant/layout disagree, or a released assignment's variant or layout revision is missing (`INCONSISTENT_CONFIGURATION`) |
| PARTIAL | Configuration resolved; some components have no single applicable part |
| RESOLVED | Configuration resolved; every component has one applicable part |
| SERVICE_UNAVAILABLE | Reference store cannot be read (HTTP 503) |

A planned assignment beside a released one is reported as an advisory and never used. Each entry of `assignmentsConsidered` carries `effectiveStatus` (`released` or `planned`, how lookup treated it) and `reason` (why that differs from the stated status, or which referenced data is missing; otherwise null). The overlap message names every overlapping assignment.

## Applicability and specificity

For each location and component, candidate rules are those whose component matches, whose context constraint accepts the assignment, and whose location selector covers the location. A rule is excluded, with the reason kept, when it is unreleased, outside its own dates, or its source is missing, unreleased, not yet effective or expired. Every exclusion is kept on the component whatever its outcome (resolved, ambiguous or no match), with the rule, its part and the source it cites; the inspector, the report, the PDF and the preparation list show them under a resolved component as "Rules not used". Substitute approvals are checked the same way against their own scope, dates and approval source. A rule is also excluded (`KIT_SOURCE_INVALID`, naming the child part and source) when any mandatory kit child of its primary part, at any depth, cites a source that fails the same check, and (`KIT_INVALID`) when the kit below its primary part cannot be expanded: it is cyclic, nested deeper than `MAX_KIT_DEPTH`, or an expanded quantity exceeds `MAX_DERIVED_QTY`. These kit reasons are listed beside any other reason the rule has. An alternate whose kit has such a problem moves to the excluded alternates with the same reasons. Lookup therefore never fails on kit data; it returns `RESOLVED` or `PARTIAL`. Validation warns (`KIT_SOURCE_UNRELEASED`) about a kit child citing an unreleased source. A `KIT_SOURCE_INVALID` reason carries the kit child's `sourceId`, and the report cites it. When every exclusion on a no-match component is a kit reason, the message says the rule's kit data is unusable and names why, not that the rule is not valid on the date. A substitute is attached to a frozen rule only when the locations it covers meet that rule's locations.

Printed rows are numbers only when the label is one to three digits (`parsePrintedRow`); a seat on any other label never matches a row range. An absent (or null) `rowFrom` or `rowTo` is no bound on that side. Seat letters outside A-F have no geometry: `lateralCentre`, `sideOf` and `seatPlacement` throw `RangeError`, validation reports `SEAT_LETTER_UNKNOWN`, and a seat whose `side` disagrees with its letter is `SEAT_SIDE_MISMATCH`.

**Specificity is logical implication** (`src/domain/specificity.ts`). A rule's match set is every situation it accepts: (variant, layout revision, location, carpet, seam, upholstery). Rule A beats rule B only if A's match set is a strict subset of B's.

- Variant, subtype and hardware are dependent, so those constraints are reduced to the feasible (variant, layout revision) pairs taken from the release. Pairs come from released variants and usable layout revisions only: the variant lists the revision and the revision is neither planned nor candidate (`isUsablePair`). Unreleased data therefore never changes which of two released rules is more specific, nor the conflicts validation reports.
- Location selectors are expanded to exact location ids per layout revision.
- Carpet, seam and upholstery are independent; an unconstrained dimension accepts "unknown", a constrained one does not.
- A rule that reaches only unreleased configurations (an unreleased variant, a planned or candidate layout revision) has an empty match set: no lookup can use it, and validation warns (`RULE_UNRELEASED_ONLY`; for an approval, `SUBSTITUTE_UNRELEASED_ONLY`). Whether a rule or approval refers to something real (`UNREACHABLE_RULE`, `UNREACHABLE_SUBSTITUTE`, namespaces) is still checked against every pair a variant lists, released or not, so staged data validates. Lookup tells a released configuration from a planned one by status alone (`isReleasedPair`), so a released assignment pairing a variant with a revision it does not list stays `INCONSISTENT_CONFIGURATION`, never `PLANNED`.
- Exactly one undominated rule → resolved. Several (equal or incomparable) → AMBIGUOUS, no part selected. None eligible → NO_MATCH.
- Numeric priority, selector count and insertion order are not used. Validity dates filter eligibility and are not part of specificity.

**The exclusion rule.** A candidate rule is excluded, never silently dropped, when any of these holds on the check date; every reason that holds is listed, in this order: `NOT_RELEASED`, `RULE_NOT_YET_EFFECTIVE`, `RULE_EXPIRED`, then the source reasons (`SOURCE_MISSING`, `SOURCE_NOT_RELEASED`, `SOURCE_NOT_YET_EFFECTIVE`, `SOURCE_EXPIRED`), then the kit reasons (`KIT_SOURCE_INVALID` per kit line whose source fails, `KIT_INVALID`). Substitute approvals use the same rule with `APPROVAL_NOT_YET_EFFECTIVE` and `APPROVAL_EXPIRED`. An excluded rule grants nothing, and its exclusion is kept on the component (`excluded`) whatever the outcome. A copy of any rule marked unreleased therefore changes no component's status or selected rule; it only appears in `excluded` wherever the original was a candidate.

**Order independence.** Lookup results do not depend on the order of rules, approvals, kit lines or locations in the release: each component's candidate rules are taken in rule-id order (so `excluded`, ambiguous `candidates` and `dominatedRuleIds` are in id order), a frozen rule's alternates and excluded alternates are in approval-id order, and each kit's lines are walked in child part number, unit, then source order. A cyclic kit is reported (`KIT_CYCLE`, and in a `KIT_INVALID` reason) starting at the cycle's smallest part number by `compareCodePoints`, so the same release always reports and freezes the same text whichever part was expanded first. Only the order of `components` in a resolution follows the layout's location order.

**Indexing.** `buildIndex` derives everything lookup and validation need once per release: entity maps, each layout revision's locations by component (`locationsByComponent`), approvals by component and primary part (`substitutesByKey`), rules by component, match sets (each selector's value lists turned into sets once per rule), memoised kit expansion and dominance. Frozen releases (as the reference store loads them) are cached; anything else is indexed afresh. `validateRelease(content, index)` and `lookup(release, tail, date, index)` accept an index already built so a caller can share one; an index of different content is refused. Grouping is linear (get-or-create, then push).

## Findings

Validation (`validateRelease`) returns findings with a severity: `error` blocks activation; `conflict` is recorded and the release activates, because lookup refuses the affected cases instead of guessing; `warning` and `info` are advisory. Codes added in Phase 2 of the hardening plan:

| Code | Severity | Meaning |
| --- | --- | --- |
| `SCHEMA_INVALID` | error | Content fails the strict structural schema (unknown or misspelt key, wrong type, bad enum, date or quantity bound). When any is found only these are returned, at most 50 listed and the rest summarised |
| `CONSTRAINT_VALUE_UNKNOWN` | error | A rule or approval constrains a variant, layout revision, subtype, hardware, carpet, seam or upholstery that does not exist |
| `SELECTOR_ID_UNKNOWN` | error | A location selector names a location id that is not a location of that kind in any layout revision the constraint can reach |
| `SELECTOR_VALUE_UNMATCHED` | error | A selector zone, letter, side, floor area type or row range matches no location of that kind it can reach |
| `ROW_RANGE_INVALID` | error | A selector gives only one row bound, or a first row after the last |
| `CANDIDATE_HAS_FIXTURE_DATA` | error | A candidate layout revision contains fixture floor or bin locations or fixture maintenance zones |
| `ASSIGNMENT_INCONSISTENT` | conflict | A released configuration whose aircraft, variant and layout revision disagree (subtype, unlisted revision, incomplete seat set); its lookups are refused |
| `RULES_INCOMPARABLE` | conflict | Two released rules for one component overlap in scope and validity but neither is more specific, and no third rule more specific than both covers their overlap for the whole shared validity with a source valid throughout; the affected components are reported as ambiguous |
| `SUBSTITUTE_UNREACHABLE` | warning | An approval covers no location where a rule selects its primary part, so it can never be offered |
| `RULE_UNRELEASED_ONLY` | warning | A rule reaches only unreleased configurations; no lookup can use it until they are released |
| `SUBSTITUTE_UNRELEASED_ONLY` | warning | The same for a substitute approval |
| `KIT_SOURCE_UNRELEASED` | warning | A kit line cites an unreleased source; no lookup can select its parent part or any kit containing it |
| `KIT_TOO_DEEP` | error | A kit nests deeper than `MAX_KIT_DEPTH` levels (reported once, not once per kit above it) |
| `KIT_QTY_OVERFLOW` | error | An expanded kit quantity is not a safe integer or exceeds `MAX_DERIVED_QTY` |
| `KIT_UNIT_UNDER_NON_COUNT` | warning | A kit line whose child is itself a kit uses a unit that does not count items, yet multiplies the kit below it |
| `KIT_CYCLE` | error | A cyclic kit definition, named from its smallest part number (existing code; its text is now canonical) |
| `SEAT_LETTER_UNKNOWN` | error | A seat letter outside A-F, which the geometry frame cannot place |
| `SEAT_SIDE_MISMATCH` | error | A seat whose `side` disagrees with the side its letter is on |

Not findings, but codes added in the same phase:

| Code | Kind | Meaning |
| --- | --- | --- |
| `KIT_SOURCE_INVALID` | exclusion reason | A kit child of the rule's or alternate's part, at any depth, cites a source that is not valid on the check date; carries that `sourceId` |
| `KIT_INVALID` | exclusion reason | The kit below the part cannot be expanded (cycle, too deep, quantity too large) |
| `VARIANT_SOURCE_INVALID`, `LAYOUT_SOURCE_INVALID` | lookup reason (`SOURCE_INVALID`) | The variant's or layout revision's source is not valid on the check date |
| `QUANTITY_TOO_LARGE` | record refusal (HTTP 422) | A computed line quantity is not a safe integer or exceeds `MAX_DERIVED_QTY` |
| `RELEASE_MISMATCH` | error response (HTTP 500) | A visit snapshot was asked to freeze a lookup result taken from a different reference release than the one given |
| `SNAPSHOT_INCONSISTENT` | error response (HTTP 500) | A record or gap refers to a location absent from the frozen layout, or a location has an unknown kind |

Codes that existed before Phase 2, for completeness (all from `validateRelease` or `validateKits`):

| Code | Severity | Meaning |
| --- | --- | --- |
| `DUPLICATE_KEY` | error | Two entities of one type share a key, or a layout revision repeats a printed row label |
| `ORPHAN` | error | A reference to an entity or source that does not exist (subtype, variant, layout revision, part, component, approval source and so on) |
| `NAMESPACE` | error | Data outside the namespace it may live in: a tail, assignment, rule or approval outside `fixture`, or a candidate revision not marked candidate |
| `UNSUPPORTED_AUTHORITY` | error | A source claims approved authority; none was supplied |
| `UNSUPPORTED_FIELD` | error | A candidate layout revision claims a floor or bin map that was not supplied |
| `INVALID_INTERVAL` | error | An end date before its start date |
| `VOCABULARY` | error | An assignment uses a carpet, seam or upholstery value that is not in the vocabulary |
| `UNKNOWN_UNIT` | error | A rule or approval uses a unit that is not in the vocabulary |
| `COMPONENT_KIND` | error | A component on, or selected for, a location of the wrong kind |
| `ROW_ORDER` | error | Rows without a unique physical order, or a skipped row label with one |
| `SEAT_INVALID`, `SEAT_IDENTITY`, `SEAT_ROW` | error | A seat location without seat attributes, with an inconsistent row, letter and code, or on a row the layout does not have |
| `SEAT_TOTAL`, `TIER_TOTAL` | error | The declared seat count, or a tier count, differs from the seats present |
| `SEAT_SET_STATUS` | error | A revision marked "seat set not supplied" contains seats |
| `RANGE_INVALID` | error | A seat's pitch range is inverted |
| `CROSSWALK` | error | A layout category without a supplied seat set is crosswalked to a layout |
| `UNREACHABLE_RULE`, `UNREACHABLE_SUBSTITUTE` | error | A rule or approval can match no location in any configuration |
| `SUBSTITUTE_INVALID` | error | An approval substitutes a part for itself |
| `KIT_ORPHAN_PARENT`, `KIT_ORPHAN_CHILD`, `KIT_ORPHAN_SOURCE` | error | A kit line naming an unknown parent part, child part or source |
| `KIT_SELF_REFERENCE` | error | A kit that lists itself as a child |
| `KIT_UNKNOWN_UNIT` | error | A kit line with a unit that is not in the vocabulary |
| `ASSIGNMENT_OVERLAP` | conflict | One tail has overlapping released assignments; lookups inside the overlap are refused |
| `EQUAL_RULES` | conflict | Two rules with identical scope and overlapping validity; the affected components are ambiguous |
| `SUBSTITUTE_UNUSED` | warning | An approval stands in for a part that no rule for its component selects |

The importer adds its own findings about the supplied files (`SOURCE_FILE_MISSING`, `SOURCE_HASH_CHANGED`, `SOURCE_UNREADABLE`, `SOURCE_ENCODING`, `REGISTRY_SHAPE`, `CROSS_FORMAT_MISMATCH`, `CROSS_FORMAT_INCOMPLETE`, `PITCH_UNPARSED`, `WIDTH_UNPARSED`, `FIXTURE_INVALID`, `IMPORT_INTERNAL` and others); `npm run reference:findings` prints them with their messages.

## Numeric limits

Defined in `src/domain/limits.ts` and enforced by the schema, kit expansion and record derivation.

| Limit | Value | Applies to |
| --- | --- | --- |
| `MAX_QTY` | 10,000 | Any quantity in reference data (rule, approval and kit-line quantities); quantities are whole numbers of at least 1 |
| `MAX_REPLACEMENTS_PER_LOCATION` | 1,000 | A component's declared replacement limit per location |
| `MAX_DERIVED_QTY` | 1,000,000 | Any computed quantity: an expanded kit line, and a record's line quantity |
| `MAX_KIT_DEPTH` | 8 | Kit nesting levels below a part |

## Alternates and kits

Primary and alternate are separate choices on one record. Choosing an alternate replaces the primary for that component. Mandatory children come from the kit definition of the chosen part, multiplied through nested kits; lines with the same part, unit and source are merged, and the same child in two units stays on two lines, ordered by part number, unit, then source. Each line keeps its source. A record whose computed line quantity is not a safe integer or exceeds `MAX_DERIVED_QTY` is refused (`QUANTITY_TOO_LARGE`). Validation reports kits nested too deep (`KIT_TOO_DEEP`), expanded quantities that are too large (`KIT_QTY_OVERFLOW`), and warns (`KIT_UNIT_UNDER_NON_COUNT`) when a kit line whose child is itself a kit uses a unit that does not count items. The client sends only location, component, selection and replacements; any `lines` or `totals` it sends are refused.

Replacement count: the number of that component replaced at that location in this visit, limited by the component definition. Line quantity = replacements × quantity per replacement; child quantity = replacements × alternate quantity × child quantity.

## Visit snapshot and transactions

At creation the whole context is copied into the visit: assignment, variant, layout revision with every location and its placement, resolved rules with parts, validity, pending changes, eligible and excluded alternates with expanded children, cited sources, unresolved gaps, date rule and geometry version. The snapshot is hashed and can never be updated (trigger). Records and reports are derived only from it.

Backward compatibility: fields added after a snapshot was frozen are absent from it; every reader defaults them; nothing rewrites a stored snapshot. For example, snapshots frozen before report schema 2 have no `excluded` list on resolved or ambiguous components and no `sourceId` on a no-match exclusion; readers treat the list as empty and cite no source for it.

Report schema 2 (`cabin-kit.report/2`) adds `excludedRules` to each work item and `sourceIds` to each gap, and `sources` lists every source the report cites: work items (rule, selection, mandatory children, pending changes), their excluded rules, and gaps (ambiguous candidates and no-match exclusions). A stored `/1` report is immutable and is returned exactly as stored; readers treat its missing fields as empty. Work items are ordered by physical position: seats by physical row then letter, then floor areas by first row, then bins by module, each tie broken by location id; gap location ids follow the same order. Bins on both sides share module numbers, so they interleave left and right: `BIN:L-01`, `BIN:R-01`, `BIN:L-02`, `BIN:R-02` and so on. A record whose location is absent from the snapshot, or a location of unknown kind, is refused as `SNAPSHOT_INCONSISTENT` (HTTP 500), never placed silently. The preparation overview's `counts.parts` is the number of distinct primary part numbers.

| Operation | Guarantee |
| --- | --- |
| Add / update | One record per visit, location and component. `expectedRecordVersion` mismatch → 409 `STALE_RECORD` |
| Remove | Same version check; no orphan child lines exist because lines live on the record |
| Complete | One transaction: version check, non-empty check, re-derivation of every record from the snapshot, lock, report stored. Repeating it returns the stored report |
| Retry | A repeated idempotency key returns the first outcome, for record writes, completion and linked events; the same key with a different request is refused. Keys are pruned after 30 days when the store opens; events and reports are never pruned |
| After completion | Edits refused by the application and by triggers on records, visit, report and events. Advisories and corrections are appended as linked events |
| Linked events | `ADVISORY` or `CORRECTION_NOTE`, with a note of 1-2,000 characters and an optional author of at most 80 (both trimmed first; nothing is truncated). Accepted on drafts and on completed visits (decision D4 of the hardening plan), appended only, and idempotent by key like the other writes |

Writers use `BEGIN IMMEDIATE`, so an edit racing a completion either commits first and is in the report, or is refused afterwards.

## Storage

- `reference.sqlite`: `release`, `release_entity` (one row per entity: type, id, namespace, JSON), `active_release` (single pointer row), `release_event`. Entities of a release that has left "staged" cannot be changed (triggers).
- `visits.sqlite`: `visits`, `visit_records`, `visit_events`, `reports`, `idempotency`.

Reference operations refuse a target that is the visit store (same path, symlink or hard link), that contains visit tables, or that this application does not recognise. Classification is by the tables actually present, not by a marker row.

## Geometry

Declared in each layout revision (`cabin-kit.geometry/1`): metres; right-handed; +X aft along the centreline; +Y up from the floor; +Z toward the left (A/B/C) side when facing forward; origin on the centreline at floor level at the forward edge of the drawn floor. Status: illustrative approximation with uniform row spacing. Pitch claims and photographs do not set coordinates, hardware grouping or cabin height.
