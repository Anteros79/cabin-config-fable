# Missing evidence

The application runs on fictional fixtures because the supplied files do not contain what real use needs. This page lists what is missing, what the build does in its absence, and what would be needed to close each gap. Detail and exact source locations are in [`evidence/conflict-register.md`](../evidence/conflict-register.md) (items C01–C23).

Nothing here was filled in from general knowledge or from the baseline.

## Not supplied at all

| Missing | Effect now | Needed |
| --- | --- | --- |
| Dated tail-to-configuration assignments | Every tail in the system is fictional (`N…TL`). No real tail can be looked up | An authoritative assignment list with tail, configuration, effective start and end, and source |
| Parts catalogue: part numbers, descriptions, units | All part numbers are fictional (`FAKE-…`) | A controlled catalogue with revision and effective dates |
| Applicability rules (which part fits which location under which conditions) | Fictional rules exercise the resolver only | Rules with their governing document and dates |
| Alternates and substitutes, kit contents | One fictional substitute kit with children | Substitution approvals with validity periods and mandatory child parts |
| Floor and carpet panel map | Three illustrative zones plus a whole-cabin scope | Panel ids, extents and seam positions per layout |
| Overhead bin map | Illustrative bins by side and index | Bin ids and positions per layout |
| Coordinate frame and station data | Model uses its own frame (metres, +X aft, +Y up, +Z port) with an illustrative 0.81 m pitch | Station/butt-line data or a drawing |
| Cabin height and cross-section | Illustrative. The context layer's shell (ceiling 2.45 m on the centreline, chosen to clear the drawn bins, a sidewall arc of 1.9 m radius, a recessed window per row pitch) is drawn from illustrative constants and places no location | Drawing |
| Link from any image to a layout, tail or date | All three visual profiles are `unassigned-illustrative` | A statement of which appearance applies to which configuration |
| Seat set for the 138-seat 737-700 described in the DOCX | The DOCX category is listed as "seat set not supplied" and no candidate layout is created for it. A separate fictional 138-seat fixture exists for regression tests only | A seat list for that layout |
| Who may accept reference data, and how | The `accepted` namespace is empty and validation rejects anything claiming it | A named approval process |

## Supplied but unresolved

| Item | Conflict | Handling |
| --- | --- | --- |
| C01 | DOCX describes layouts by category; the registry by model/interior. They do not line up one-to-one | Both recorded; crosswalk marked as an assumption (C22) |
| C02 | Seats 7D/7E/7F/15B/15C: extra-legroom spacing but sold as Preferred | Recorded on the DOCX layout category; not applied to any supplied seat set (a test asserts this for the 137-seat candidate) |
| C03 | Extra-legroom pitch 34 in. (DOCX) against 33–37 in. (registry) | Both values shown with sources; none chosen |
| C04 | RTF contradicts itself on the split row 6 pitch | Recorded |
| C05 | Row-level bulkhead flag is false where only one side is behind a bulkhead | Seat-level values used for display; finding raised |
| C06, C07 | Approximate pitch stored as exact text; shoulder clearance mixed with seat width | Held as claims with the source text and a note that the measurement kind is not established; not used for geometry |
| C12 | Seat width differs between configurations with the same hardware label | Recorded |
| C15 | In-seat power described as alternatives copied to every seat | Not turned into a per-seat claim |
| C18 | Two JSON-named files (548 bytes, byte-identical) are invalid templates | Excluded from import with a finding |
| C20 | DOCX links and cited sources were not checked against the live web | Recorded as unverified |
| C21 | One image's metadata names another airline | Used as context only |

## Candidate data in the application

The populated registry (5 configurations, 837 seats, agreeing across JSON, CSV and XLSX) is loaded into the `candidate` namespace. It can be browsed under Layouts, with every finding attached. It cannot be used to open a visit, has no tails, parts, floor or bin maps, and is labelled candidate and unverified in the Layouts and Reference views.

## Not verified by this build

- Agreement of the registry with any real aircraft.
- Any regulatory statement in the documents.
- Behaviour with a real screen reader, on devices other than the one named in `verification/PROVENANCE.json`, or in browsers other than Chromium (on WebKit the Enter fix 74cf243 and the screenshotter's CSP message are accounted for; the keyboard walk-through still fails because WebKit's plain Tab skips buttons and links; Firefox could not be started).

See [`verification/README.md`](../verification/README.md) for the full list.
