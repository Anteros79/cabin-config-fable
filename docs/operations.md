# Operations

All commands run from the project folder (`implementation/cabin-kit/`, or the root of a clone). Node 24 or later is required (the project uses the built-in `node:sqlite` module and runs TypeScript directly).

## First start

```
npm run setup            # npm ci, build the web client, import reference data, seed two sample visits
npm start                # http://127.0.0.1:4310
```

`setup` ends with `npm run sample:seed`, which adds two sample visits (one completed, one draft) to the visit store. To start with an empty visit store, run the first three steps by hand instead: `npm ci && npm run build && npm run reference:import`.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `CABIN_KIT_DATA_DIR` | `./data` | Folder for both stores |
| `CABIN_KIT_REFERENCE_DB` | `<data>/reference.sqlite` | Reference store file |
| `CABIN_KIT_VISITS_DB` | `<data>/visits.sqlite` | Visit store file |
| `CABIN_KIT_HOST` | `127.0.0.1` | Listen address. Anything other than `127.0.0.1`, `::1` or `localhost` is refused unless `CABIN_KIT_ALLOW_REMOTE=1` |
| `CABIN_KIT_ALLOW_REMOTE` | unset | `1` accepts a non-loopback `CABIN_KIT_HOST`. The server has no authentication; only set it on a network you trust |
| `CABIN_KIT_PORT` | `4310` | Listen port, a whole number from 0 to 65535 |
| `CABIN_KIT_ALLOWED_HOSTS` | unset | Comma-separated extra host names accepted in the `Host` header, besides `localhost`, `127.0.0.1`, `::1` and `CABIN_KIT_HOST`. Empty or blank means none. Requests with any other `Host` get 403 `HOST_NOT_ALLOWED` |
| `CABIN_KIT_WEB_ROOT` | `dist/web` | Directory of the built client the server serves. Must exist. The E2E run points it at `dist/web-e2e` |
| `CABIN_KIT_TEST_FAULTS` | unset | `1` enables the fault-injection route used by the E2E run. Never set it in normal use |
| `CABIN_KIT_LOG_LEVEL` | `info` | One of `silent`, `error`, `warn`, `info`, `debug` (see Logs) |
| `CABIN_KIT_SOURCE_ROOT` | see below | Folder holding the supplied originals |

Source root: the data originals are read from `CABIN_KIT_SOURCE_ROOT` when set, else from the vendored `fixtures/originals/`, else from `../../`. The 14 images are read from `CABIN_KIT_SOURCE_ROOT` when set, else from `../../`; only `comparisons` and `originals:verify` need them.

The server, the import commands and the tests read the store and server settings through `src/server/config.ts`, and the source root through `src/importer/originals.ts` (`resolveSourceRoot`, `resolveImageRoot`), so an import and a start with the same environment always use the same files. An empty or blank value means the variable is unset. Relative paths are resolved against the working directory.

The server checks every setting before it opens any store. An unusable value (a port that is not a number, an unknown log level, an allowed host with a path or port in it, a non-loopback host without `CABIN_KIT_ALLOW_REMOTE=1`) stops it with a message on stderr and exit code 2.

`SIGINT` or `SIGTERM` closes the server and both stores, then exits 0. If closing takes longer than 5 seconds, or a second signal arrives while it is closing, the process exits 1. An unhandled rejection or uncaught exception is logged at `fatal` and exits 1.

| Server exit code | Meaning |
| --- | --- |
| 0 | Stopped by `SIGINT` or `SIGTERM` |
| 1 | Could not start or stop: port in use, a store that cannot be opened (see Upgrading and store errors), a shutdown that timed out or was interrupted, or an unexpected fault |
| 2 | A setting is unusable; the message on stderr names it and the accepted values |

## Logs and request ids

The server writes one JSON line per event to stdout (Fastify's logger). At `info` (the default) every request gets an "incoming request" and a "request completed" line with its method, URL, status and time. Each request has a random id (a UUID) that appears as `reqId` in its log lines and in the `X-Request-Id` response header. An incoming `X-Request-Id` is ignored. `warn` logs only reference-store outages and worse; `error` only failures; `debug` adds detail; `silent` logs nothing.

Expected refusals (a validation error, a stale record) are logged at `info` with their code. A storage fault is answered 503 `STORAGE_UNAVAILABLE` ("Nothing was saved"); an unexpected error is answered 500 `INTERNAL_ERROR` with a fixed message. Both answers carry `details.requestId`, and the full error with its stack is in the log under that id: search the log for the id the person reports.

The server has no login. It listens on the loopback address by default and refuses cross-origin writes. Do not expose it on a network as it stands.

## Reference data

| Command | Effect |
| --- | --- |
| `npm run reference:import` | Stage a release from the fixtures and the supplied originals, validate it, and make it active if there are no errors. Unchanged data stages nothing: it prints `Reference data unchanged: release <id> is already active.` and exits 0. A repeat of the last rejected run reports that release again. A clean import whose content hash equals the active release is skipped even if its non-blocking findings (warnings, conflicts, info) would now differ; the active release keeps its recorded findings |
| `npm run reference:status` | Show the active release and entity counts |
| `npm run reference:findings` | List validation findings for the active release |
| `npm run reference:reset` | Rebuild the reference store from scratch |

Every command checks its options strictly: an unknown or misspelled option, a stray argument, or a path option with no value stops the command before it touches any store. Options: `--data-dir`, `--reference-db`, `--visits-db` (path options; `--name value` and `--name=value` both work; the older names `--reference` and `--visits` are still accepted, and when both `--reference` and `--reference-db` are given, `--reference-db` wins), `--source-root`, `--fixtures`, `--label`, `--no-activate`, `--no-candidate`, `--accept-changed` (import and reset), `--release` (findings) and `--yes` (reset). Run `node src/importer/cli.ts help` for the list.

| Exit code | Meaning |
| --- | --- |
| 0 | Done |
| 1 | The command failed, or `reset` was run without `--yes` |
| 2 | The import produced a release with blocking findings. They are printed (at most 20) and the previous release stays active |
| 3 | Visit history changed during the command. Investigate before using the stores |
| 64 | Usage error: unknown command, no command, unknown option or missing value. One line names the problem, then the usage text, on stderr |

`reference:findings` shows the newest release when it was rejected, otherwise the active one; `-- --release <id>` shows any release. `sample:seed` and `originals:verify` also reject unknown options (exit 64).

Every import checks the nine data originals against `evidence/originals-manifest.json`. A missing original stops the release (`SOURCE_FILE_MISSING`); a changed one (`SOURCE_HASH_CHANGED`) does too, unless `--accept-changed` is given, which stages it with a warning. A source root that is not a directory fails the command (exit 1) before any store is opened or created, except with `--no-candidate`: then the originals are not read and the source root is not checked.

Releases are immutable once active. An import that fails validation leaves the previous release active. Existing visits are unaffected by any import or reset because each visit carries its own frozen copy of the configuration it was opened against.

### Reset safety

`reference:reset` and `reference:import` refuse to run when the target:

- is the same file as the visit store, including through a symlink or hard link;
- contains visit tables;
- exists but is not a Cabin Kit reference store (classified by its tables, not by a marker).

The reset builds a new file beside the old one and renames it into place, so a failure part-way leaves the old store intact. Stop the server before a reset; a running server keeps the old file open until it restarts.

## Backup and restore

The visit store is the only file that holds work that cannot be regenerated.

Back up, with the server running or stopped:

```
npm run visits:backup                        # writes backups/visits-<YYYYMMDD-HHMMSS>Z.sqlite (UTC)
npm run visits:backup -- --out /path/to/visits-copy.sqlite
```

The command takes a consistent copy with SQLite `VACUUM INTO`, opens the copy read-only, runs `PRAGMA quick_check`, and prints the path, the size in bytes and the number of visits. It refuses to overwrite an existing file. It reads the store named by `CABIN_KIT_VISITS_DB` / `CABIN_KIT_DATA_DIR` and never writes to the store or its write-ahead log: the store is opened read-only, without migration or pruning. If the store is in write-ahead-log mode and its `-shm` file is missing (no server has it open), the store and any `-wal` file are first copied to a private temporary folder and the backup is taken from there. The `backups/` folder is git-ignored.

Fallback, with the server stopped:

```
cp data/visits.sqlite  /path/to/backup/visits-YYYY-MM-DD.sqlite
```

The store uses SQLite write-ahead logging. If `visits.sqlite-wal` or `visits.sqlite-shm` exist beside it after the server has stopped, copy all three files together.

| `visits:backup` exit code | Meaning |
| --- | --- |
| 0 | Backup written and checked |
| 1 | Nothing usable was written: the destination already exists, the store could not be read, or the copy failed its check (a failed copy is deleted) |
| 2 | Bad arguments (an unknown option or `--out` without a value) |

Restore: stop the server, replace `data/visits.sqlite` with the backup (remove any `-wal`/`-shm` files), start the server. A visit store does not need the reference store it was created with; reports for existing visits are produced from the visit's own snapshot.

The reference store can always be rebuilt with `npm run reference:import`, provided the originals and `fixtures/fixture-data.json` are unchanged. `npm run originals:verify` checks the originals against the recorded SHA-256 values: the vendored data originals always, and the source root (`CABIN_KIT_SOURCE_ROOT`, else `../../`) when it was named or holds at least one original. A source root that is checked must hold all 23 originals; each missing one is named and the exit code is 1. One exception: `CABIN_KIT_SOURCE_ROOT` set to `fixtures/originals` itself checks the nine data originals there and skips the images, since that folder never holds them. Where no original is in `../../` (a clone outside the development folder, CI), the command prints `source root <absolute path> holds no originals; images and source copies not checked (set CABIN_KIT_SOURCE_ROOT to require them)`, reports the 14 images `skipped (not present)` and exits 0.

## Upgrading and store errors

On start the server opens the visit store and brings it to the newest schema. Migrations are forward-only and run in one transaction: they may add tables, columns, indexes and triggers, and never rewrite stored snapshots, reports or events. A store written by 1.x (schema version 1) opens, lists, reports and completes under 2.0.0; it is migrated to version 2 (an index on retry keys) on first open. Take a backup before upgrading (`npm run visits:backup`): there is no downgrade, and a store a newer version has migrated is refused by an older one. Retry keys older than 30 days are pruned when the store opens.

Reference stores need no migration. Releases imported before 2.0.0 keep their recorded content hash and still load; the first import under 2.0.0 stages and activates one new release even from unchanged files, because the content hash of the same data changed in 2.0.0 (see `CHANGELOG.md`). Existing visits keep their own snapshots and are unaffected.

| Error | Where | What it means | What to do |
| --- | --- | --- | --- |
| `VISIT_SCHEMA_NEWER` | server start, `visits:backup` | The visit store was written or migrated by a newer Cabin Kit. It is refused untouched (the version is read through a read-only connection first) | Run the newer version, or restore a backup taken before the upgrade |
| `VISIT_SCHEMA_MISMATCH` | server start | The store's schema version is missing or unreadable: not a Cabin Kit visit store, or a damaged one | Check `CABIN_KIT_VISITS_DB` points at the right file; otherwise restore a backup |
| `VISIT_STORE_CORRUPT` | server start, `visits:backup` | SQLite reports the file damaged (`PRAGMA quick_check` failed, or SQLite corruption while opening). Nothing is written to it | Stop the server, keep the damaged file for investigation, restore the latest backup |
| `SNAPSHOT_CORRUPT` | one visit (HTTP 500) | The visit's frozen configuration no longer matches the SHA-256 recorded when the visit was created; the visit is not shown or used. Other visits are unaffected | Restore the store from a backup taken before the change; the visit's snapshot cannot be rebuilt from the reference data |
| `REPORT_CORRUPT` | one completed visit (HTTP 500) | The stored report no longer matches its recorded hash | As for `SNAPSHOT_CORRUPT` |
| `RELEASE_CORRUPT` | lookups (HTTP 503 `REFERENCE_UNAVAILABLE`) | The active reference release no longer matches its content hash | Rebuild the reference store: `npm run reference:reset -- --yes` (server stopped). Visits are unaffected |

## What cannot be undone

- Completing a visit locks it. There is no reopen.
- Visits cannot be deleted through the application; database triggers also forbid it.
- Stored reports and events cannot be changed.

## Checks

```
npm run verify           # check (lint, format, typecheck, vitest), build, browser tests, originals check
npm run verify:clean     # verify, then fail if the working tree changed (CI runs the same check)
npm run test             # vitest only
npm run test:e2e         # Playwright; builds dist/web-e2e with test hooks first; needs `npx playwright install chromium`
npm run build:e2e        # the client with window.__cabinKit test hooks, in dist/web-e2e (never ship this build)
```

The browser tests start their own servers on spare ports with temporary stores. They do not touch `./data`, and nothing a check or test writes is tracked: results stay in the ignored `test-results/` and `playwright-report/` folders, and in CI.

## Evidence

Evidence (renders, comparison sheets, sample visits and reports, performance) is captured on purpose, never by a test run:

```
npm run evidence:capture                     # writes verification/out/ (git-ignored)
npm run evidence:capture -- --assert-perf    # also fails under 30 fps or over 250 ms per pick
npm run evidence:capture -- --promote        # capture, then copy the curated subset into verification/
npm run evidence:capture -- --promote-only   # copy what the last capture left in verification/out/ (--force if made at another commit)
```

The capture uses its own server on the e2e build with temporary stores, and the bundled Chromium. The comparison sheets need the 14 image originals (`CABIN_KIT_SOURCE_ROOT`, else `../../`); without them they are skipped and nothing can be promoted. Promotion replaces `verification/captures/`, `comparisons/` and `samples/` wholesale, and `performance.json` and `PROVENANCE.json`, through a staging folder. It needs the tree clean outside `verification/`, so `PROVENANCE.json` names the exact commit the renders were built from. Look at every promoted image, update the judgments in `verification/README.md`, then commit by hand.

## Problems

| Symptom | Likely cause |
| --- | --- |
| Every lookup returns "service unavailable" | No active reference release. Run `npm run reference:import` |
| `409 STALE_RECORD` on save | Another session changed the same record. The page says the save was not made and reloads the saved state; re-enter the change if it still applies |
| Blank page at `/` | The client is not built. Run `npm run build` |
| 3D view shows a notice and a seat map | WebGL is unavailable. The map and list provide the same functions |
| `Port <n> is in use. Set CABIN_KIT_PORT.` (exit 1) | Another program listens on that port. Set `CABIN_KIT_PORT` |
| Start stops with a `CABIN_KIT_…` message (exit 2) | A setting is unusable; the message names it and the accepted values |
| Start stops with "written by a newer version of Cabin Kit" (exit 1) | `VISIT_SCHEMA_NEWER`: see Upgrading and store errors |
| An answer says "The request failed unexpectedly" | A server fault. Find `details.requestId` in the server log |
