# Test fixtures

## visits-5d6679d.sqlite

A visit store written by the original application commit `5d6679d` (plus the Task 0.1 vendored originals, which do not change the output). It is the backward-compatibility fixture: every later phase must still open, list, report and complete visits from it. Treat it as immutable; never regenerate it from newer code.

Contents (all fictional):

- Visit #1, COMPLETED, tail N100TL, with a stored report.
- Visit #2, DRAFT, tail N200TL, with 2 records.

Reference release the snapshots were built from: `REL-0001-6df51180`.

Captured with:

```bash
D=$(mktemp -d) && CABIN_KIT_DATA_DIR="$D" node src/importer/cli.ts import && CABIN_KIT_DATA_DIR="$D" node tools/seed-sample-visits.ts && node -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]+"/visits.sqlite");d.exec("PRAGMA wal_checkpoint(TRUNCATE)");d.prepare("VACUUM INTO ?").run("tests/fixtures/visits-5d6679d.sqlite")' "$D"
```

The file is a single self-contained database (no WAL or shm sidecar).
