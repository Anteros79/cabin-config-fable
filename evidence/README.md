# Evidence

Everything here was produced from the original bytes of the 23 supplied files in the development folder (`../../` from this project). The originals were only read. The earlier analysis folder beside the baseline was not used as a source.

Regenerate with `npm run evidence:build` and `npm run images:previews`. Check that the originals are unchanged with `npm run originals:verify`.

| File | Contents |
| --- | --- |
| `originals-manifest.json` | Path, size and SHA-256 of each of the 23 originals |
| `inventory.md` / `.json` | Per-file format (from content, not extension), structure, metadata, and for images pixel size and embedded fields |
| `extracts/` | Located text from the DOCX and RTF (paragraph and table positions), workbook cells, CSV metadata, DOCX hyperlinks, JSON comparison |
| `cross-format-comparison.md` / `.json` | Field-by-field agreement of the registry across JSON, CSV and XLSX |
| `candidate-seat-sets.md` / `.json` | Seat sets per configuration: counts, skipped rows, missing seats, tier totals |
| `field-crosswalk.md` / `.json` | How fields in each source map to the logical model |
| `conflict-register.md` / `.json` | C01–C23: conflicts, ambiguities and assumptions, each with source locations |
| `expectations-check.md` / `.json` | Statements in the request checked against the files, with what was and was not confirmed |
| `image-previews/` | Downscaled copies of the 14 images for review. Derivatives, not evidence |

The scripts are in `tools/evidence/`. The inventory, extracts, comparison, seat sets, crosswalk, register and expectations check were written by a delegated agent run during this build; I reviewed the outputs and the importer re-reads the originals independently (`src/importer/candidate.ts`), with tests asserting the same counts (`tests/unit/import.test.ts`).

Headline figures:

- Populated registry: 5 configurations, 147 row records, 837 seats; 16,641 shared attribute values agree across the three formats.
- Seat counts: 137, 175, 175, 175, 175.
- Two JSON-named files are 548-byte, byte-identical, invalid templates.
- The DOCX describes four active layout categories, one of which (138-seat 737-700) has no seat set in any file.
