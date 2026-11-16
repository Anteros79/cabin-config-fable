# Operations

All commands run from `implementation/cabin-kit/`. Node 24 or later is required (the project uses the built-in `node:sqlite` module and runs TypeScript directly).

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
| `CABIN_KIT_LOG_LEVEL` | `info` | One of `silent`, `error`, `warn`, `info`, `debug` |

The server, the import commands and the tests all read these through `src/server/config.ts`, so an import and a start with the same environment always use the same files. An empty or blank value means the variable is unset. Relative paths are resolved against the working directory.

The server checks every setting before it opens any store. An unusable value (a port that is not a number, an unknown log level, an allowed host with a path or port in it, a non-loopback host without `CABIN_KIT_ALLOW_REMOTE=1`) stops it with a message on stderr and exit code 2.

`SIGINT` or `SIGTERM` closes the server and both stores, then exits 0. If closing takes longer than 5 seconds, or a second signal arrives while it is closing, the process exits 1.

The server has no login. It listens on the loopback address by default and refuses cross-origin writes. Do not expose it on a network as it stands.

## Reference data

| Command | Effect |
| --- | --- |
| `npm run reference:import` | Stage a release from the fixtures and the supplied originals, validate it, and make it active if there are no errors. Unchanged data stages nothing: it prints `Reference data unchanged: release <id> is already active.` and exits 0. A repeat of the last rejected run reports that release again. A clean import whose content hash equals the active release is skipped even if its non-blocking findings (warnings, conflicts, info) would now differ; the active release keeps its recorded findings |
| `npm run reference:status` | Show the active release and entity counts |
| `npm run reference:findings` | List validation findings for the active release |
| `npm run reference:reset` | Rebuild the reference store from scratch |

Every command checks its options strictly: an unknown or misspelled option, a stray argument, or a path option with no value stops the command before it touches any store. Options: `--data-dir`, `--reference-db`, `--visits-db` (path options; `--name value` and `--name=value` both work), `--source-root`, `--fixtures`, `--label`, `--no-activate`, `--no-candidate`, `--accept-changed` (import and reset), `--release` (findings) and `--yes` (reset). Run `node src/importer/cli.ts help` for the list.

| Exit code | Meaning |
| --- | --- |
| 0 | Done |
| 1 | The command failed, or `reset` was run without `--yes` |
| 2 | The import produced a release with blocking findings. They are printed (at most 20) and the previous release stays active |
| 3 | Visit history changed during the command. Investigate before using the stores |
| 64 | Usage error: unknown command, no command, unknown option or missing value. One line names the problem, then the usage text, on stderr |

`reference:findings` shows the newest release when it was rejected, otherwise the active one; `-- --release <id>` shows any release. `sample:seed` and `originals:verify` also reject unknown options (exit 64).

Every import checks the nine data originals against `evidence/originals-manifest.json`. A missing original stops the release (`SOURCE_FILE_MISSING`); a changed one (`SOURCE_HASH_CHANGED`) does too, unless `--accept-changed` is given, which stages it with a warning. A source root that is not a directory fails the command (exit 1) before any store is opened or created.

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

Restore: stop the server, replace `data/visits.sqlite` with the backup (remove any `-wal`/`-shm` files), start the server. A visit store does not need the reference store it was created with; reports for existing visits are produced from the visit's own snapshot.

The reference store can always be rebuilt with `npm run reference:import`, provided the originals and `fixtures/fixture-data.json` are unchanged. `npm run originals:verify` checks the originals against the recorded SHA-256 values.

## What cannot be undone

- Completing a visit locks it. There is no reopen.
- Visits cannot be deleted through the application; database triggers also forbid it.
- Stored reports and events cannot be changed.

## Checks

```
npm run verify           # typecheck, vitest, build + E2E, comparison sheets, originals check
npm run test             # vitest only
npm run test:e2e         # browser run; builds dist/web-e2e with test hooks first; needs Google Chrome installed
npm run build:e2e        # the client with window.__cabinKit test hooks, in dist/web-e2e (never ship this build)
```

The E2E run starts its own server on a spare port with temporary stores. It does not touch `./data`. It rewrites the files under `verification/`.

## Problems

| Symptom | Likely cause |
| --- | --- |
| Every lookup returns "service unavailable" | No active reference release. Run `npm run reference:import` |
| `409 STALE_RECORD` on save | Another session changed the same record. The page says the save was not made and reloads the saved state; re-enter the change if it still applies |
| Blank page at `/` | The client is not built. Run `npm run build` |
| 3D view shows a notice and a seat map | WebGL is unavailable. The map and list provide the same functions |
| `Port <n> is in use. Set CABIN_KIT_PORT.` (exit 1) | Another program listens on that port. Set `CABIN_KIT_PORT` |
| Start stops with a `CABIN_KIT_…` message (exit 2) | A setting is unusable; the message names it and the accepted values |
