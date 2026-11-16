# Changelog

## Unreleased

### Baseline

Coverage measured by `npm run coverage` (v8, over `src/domain`, `src/importer` and `src/server`) at the start of the platinum hardening work, 146 tests:

| Metric | Measured |
| --- | --- |
| Lines | 89.48% |
| Branches | 76.37% |
| Statements | 86.66% |
| Functions | 94.71% |

Thresholds are set to lines 85 and branches 75 (measured value rounded down to the nearest 5). Phases 1-3 each raise them towards the final floor: 90 lines / 85 branches for `src/domain`, 85 / 75 for `src/server` and `src/importer`.

### Added

- Vitest projects (`unit`, `integration`, `process`) with per-tier timeouts.
- Coverage with `@vitest/coverage-v8` and thresholds; `npm run coverage`.
- GitHub Actions workflow on Ubuntu and macOS.
- `SECURITY.md`.

### Changed

- Importer (Task 3.5, IMP-05, IMP-06): the XLSX and DOCX readers use `fast-xml-parser` instead of regular expressions, through the shared `src/importer/readers/ooxml.ts`. Only the parts a reader needs are inflated; an entry that declares more than 32 MiB, or wanted entries above 64 MiB in total, are refused before inflation. A sheet row above 1,048,576, a column above 16,384, more than 2,000,000 cells (or a grid that would span more), a date-typed cell, a formula without a cached value, an unknown cell type, a document type declaration, malformed XML and a missing `word/document.xml` are `OoxmlError`s, reported as `SOURCE_UNREADABLE`. A workbook value right of the last header is a `CROSS_FORMAT_MISMATCH` error instead of being dropped. The supplied originals read exactly as before; the content hash is unchanged (`0a22902d…`). The evidence tools open archives through the same capped reader.
- Importer (Task 3.4, IMP-03, IMP-08): the nine data originals are checked against `evidence/originals-manifest.json` on every import. A missing original (or a directory in its place) is `SOURCE_FILE_MISSING`; a size or SHA-256 that differs is `SOURCE_HASH_CHANGED`, an error unless `import --accept-changed` is given (then a warning). Every source is read and reported even when another is missing. The registry JSON is shape-checked before use (`REGISTRY_SHAPE`), text sources must be valid UTF-8 (`SOURCE_ENCODING`), the schema CSV is parsed (`SOURCE_UNREADABLE` when it cannot be), and an unexpected exception becomes `IMPORT_INTERNAL` instead of escaping. `import` checks the source root before it opens or creates any store.
- Every candidate source now carries an honest parse status: `parsed: …`, `not read: file missing`, `not parsed: narrative evidence, hash recorded` (the RTF) or `invalid: …`. Parse statuses are part of the release content, so the content hash of the release staged from the committed fixtures and originals moves (PF-2):
  `6df5118095a4e9416c3e409a62edabb0a10e38bbb17e50a2f4d8615776969400` (`REL-0001-6df51180`) → `0a22902d1f024b39f2c2b9507768ffd060f8deb19637ace96fb8063c5c66da5b` (`REL-0001-0a22902d`). Only the parse statuses of the registry JSON, the two templates, the schema CSV and the RTF differ. Releases already stored keep their recorded hash and still load.
- Fixtures: a part override for an existing but unreleased variant no longer blocks the import; an unknown variant, a variant with no seat spec, or a zone and letter no seat has still do. A fixture file that cannot be read is reported as such, with its path, separately from one that is not valid JSON.
