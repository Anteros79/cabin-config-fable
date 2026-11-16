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
| `CABIN_KIT_HOST` | `127.0.0.1` | Listen address |
| `CABIN_KIT_PORT` | `4310` | Listen port |
| `CABIN_KIT_ALLOWED_HOSTS` | unset | Comma-separated extra host names accepted in the `Host` header, besides `localhost`, `127.0.0.1`, `::1` and `CABIN_KIT_HOST`. Empty or blank means none. Requests with any other `Host` get 403 `HOST_NOT_ALLOWED` |
| `CABIN_KIT_TEST_FAULTS` | unset | `1` enables the fault-injection route used by the E2E run. Never set it in normal use |

The server, the import commands and the tests all read these through `src/server/config.ts`, so an import and a start with the same environment always use the same files.

The server has no login. It listens on the loopback address by default and refuses cross-origin writes. Do not expose it on a network as it stands.

## Reference data

| Command | Effect |
| --- | --- |
| `npm run reference:import` | Stage a release from the fixtures and the supplied originals, validate it, and make it active if there are no errors |
| `npm run reference:status` | Show the active release and entity counts |
| `npm run reference:findings` | List validation findings for the active release |
| `npm run reference:reset` | Rebuild the reference store from scratch |

Releases are immutable once active. An import that fails validation leaves the previous release active. Existing visits are unaffected by any import or reset because each visit carries its own frozen copy of the configuration it was opened against.

### Reset safety

`reference:reset` and `reference:import` refuse to run when the target:

- is the same file as the visit store, including through a symlink or hard link;
- contains visit tables;
- exists but is not a Cabin Kit reference store (classified by its tables, not by a marker).

The reset builds a new file beside the old one and renames it into place, so a failure part-way leaves the old store intact. Stop the server before a reset; a running server keeps the old file open until it restarts.

## Backup and restore

The visit store is the only file that holds work that cannot be regenerated.

Back up, with the server stopped:

```
cp data/visits.sqlite  /path/to/backup/visits-YYYY-MM-DD.sqlite
```

The store uses SQLite write-ahead logging. If `visits.sqlite-wal` or `visits.sqlite-shm` exist beside it after the server has stopped, copy all three files together.

A consistent copy can also be taken while the store is open, from code, with `VisitStore.backupTo(path)` (SQLite `VACUUM INTO`). There is no command-line wrapper or HTTP route for it.

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
npm run test:e2e         # browser run; needs Google Chrome installed
```

The E2E run starts its own server on a spare port with temporary stores. It does not touch `./data`. It rewrites the files under `verification/`.

## Problems

| Symptom | Likely cause |
| --- | --- |
| Every lookup returns "service unavailable" | No active reference release. Run `npm run reference:import` |
| `409 STALE_RECORD` on save | Another session changed the same record. The page says the save was not made and reloads the saved state; re-enter the change if it still applies |
| Blank page at `/` | The client is not built. Run `npm run build` |
| 3D view shows a notice and a seat map | WebGL is unavailable. The map and list provide the same functions |
| `EADDRINUSE` | Port in use. Set `CABIN_KIT_PORT` |
