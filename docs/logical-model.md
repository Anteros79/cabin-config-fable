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
| INVALID_INPUT | Tail or date missing or malformed (including impossible dates) |
| UNKNOWN_TAIL | Tail not in the release |
| UNCONFIGURED | Known tail with no assignment (`NO_ASSIGNMENTS`) or none covering the date (`DATE_GAP`) |
| OVERLAP | More than one released assignment covers the date. None is selected |
| PLANNED | Only a planned assignment, an unreleased variant or a planned or candidate layout revision covers the date |
| SOURCE_INVALID | Configuration source missing, unreleased, not yet effective or expired; or aircraft/variant/layout disagree |
| PARTIAL | Configuration resolved; some components have no single applicable part |
| RESOLVED | Configuration resolved; every component has one applicable part |
| SERVICE_UNAVAILABLE | Reference store cannot be read (HTTP 503) |

A planned assignment beside a released one is reported as an advisory and never used.

## Applicability and specificity

For each location and component, candidate rules are those whose component matches, whose context constraint accepts the assignment, and whose location selector covers the location. A rule is excluded, with the reason kept, when it is unreleased, outside its own dates, or its source is missing, unreleased, not yet effective or expired. Every exclusion is kept on the component whatever its outcome (resolved, ambiguous or no match), with the rule, its part and the source it cites; the inspector, the report, the PDF and the preparation list show them under a resolved component as "Rules not used". Substitute approvals are checked the same way against their own scope, dates and approval source.

**Specificity is logical implication** (`src/domain/specificity.ts`). A rule's match set is every situation it accepts: (variant, layout revision, location, carpet, seam, upholstery). Rule A beats rule B only if A's match set is a strict subset of B's.

- Variant, subtype and hardware are dependent, so those constraints are reduced to the feasible (variant, layout revision) pairs taken from the release. Pairs come from released variants and usable layout revisions only: the variant lists the revision and the revision is neither planned nor candidate (`isUsablePair`). Unreleased data therefore never changes which of two released rules is more specific, nor the conflicts validation reports.
- Location selectors are expanded to exact location ids per layout revision.
- Carpet, seam and upholstery are independent; an unconstrained dimension accepts "unknown", a constrained one does not.
- Exactly one undominated rule → resolved. Several (equal or incomparable) → AMBIGUOUS, no part selected. None eligible → NO_MATCH.
- Numeric priority, selector count and insertion order are not used. Validity dates filter eligibility and are not part of specificity.

## Alternates and kits

Primary and alternate are separate choices on one record. Choosing an alternate replaces the primary for that component. Mandatory children come from the kit definition of the chosen part, multiplied through nested kits; each line keeps its source. The client sends only location, component, selection and replacements; any `lines` or `totals` it sends are refused.

Replacement count: the number of that component replaced at that location in this visit, limited by the component definition. Line quantity = replacements × quantity per replacement; child quantity = replacements × alternate quantity × child quantity.

## Visit snapshot and transactions

At creation the whole context is copied into the visit: assignment, variant, layout revision with every location and its placement, resolved rules with parts, validity, pending changes, eligible and excluded alternates with expanded children, cited sources, unresolved gaps, date rule and geometry version. The snapshot is hashed and can never be updated (trigger). Records and reports are derived only from it.

Backward compatibility: fields added after a snapshot was frozen are absent from it; every reader defaults them; nothing rewrites a stored snapshot. For example, snapshots frozen before report schema 2 have no `excluded` list on resolved or ambiguous components and no `sourceId` on a no-match exclusion; readers treat the list as empty and cite no source for it.

Report schema 2 (`cabin-kit.report/2`) adds `excludedRules` to each work item and `sourceIds` to each gap, and `sources` lists every source the report cites: work items (rule, selection, mandatory children, pending changes), their excluded rules, and gaps (ambiguous candidates and no-match exclusions). A stored `/1` report is immutable and is returned exactly as stored; readers treat its missing fields as empty.

| Operation | Guarantee |
| --- | --- |
| Add / update | One record per visit, location and component. `expectedRecordVersion` mismatch → 409 `STALE_RECORD` |
| Remove | Same version check; no orphan child lines exist because lines live on the record |
| Complete | One transaction: version check, non-empty check, re-derivation of every record from the snapshot, lock, report stored. Repeating it returns the stored report |
| Retry | A repeated idempotency key returns the first outcome, for record writes, completion and linked events; the same key with a different request is refused. Keys are pruned after 30 days when the store opens; events and reports are never pruned |
| After completion | Edits refused by the application and by triggers on records, visit, report and events. Advisories and corrections are appended as linked events |

Writers use `BEGIN IMMEDIATE`, so an edit racing a completion either commits first and is in the report, or is refused afterwards.

## Storage

- `reference.sqlite`: `release`, `release_entity` (one row per entity: type, id, namespace, JSON), `active_release` (single pointer row), `release_event`. Entities of a release that has left "staged" cannot be changed (triggers).
- `visits.sqlite`: `visits`, `visit_records`, `visit_events`, `reports`, `idempotency`.

Reference operations refuse a target that is the visit store (same path, symlink or hard link), that contains visit tables, or that this application does not recognise. Classification is by the tables actually present, not by a marker row.

## Geometry

Declared in each layout revision (`cabin-kit.geometry/1`): metres; right-handed; +X aft along the centreline; +Y up from the floor; +Z toward the left (A/B/C) side when facing forward; origin on the centreline at floor level at the forward edge of the drawn floor. Status: illustrative approximation with uniform row spacing. Pitch claims and photographs do not set coordinates, hardware grouping or cabin height.
