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
