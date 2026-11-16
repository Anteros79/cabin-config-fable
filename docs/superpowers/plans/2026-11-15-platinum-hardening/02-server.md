# Phase 1: Server

Read [`00-index.md`](00-index.md) first. Requires Phase 0.

Outcome: the loopback API cannot be driven by a foreign web page, rejects malformed input with 4xx, logs what it does, sends small responses, and its stores verify and migrate themselves.

New HTTP tests go in `tests/integration/api.test.ts` unless a task names another file. Use `makeApp` from `tests/helpers.ts` and Fastify `inject`. `inject` sends `Host: localhost:80` by default.

---

### Task 1.1: Host allow-list and stricter origin check

Closes SRV-01.

**Files:**
- Create: `src/server/http/hostGuard.ts`
- Modify: `src/server/config.ts`, `src/server/app.ts` (the `onRequest` hook), `SECURITY.md`, `docs/operations.md`
- Test: `tests/unit/hostGuard.test.ts`, `tests/integration/api.test.ts`

**Interfaces:**
- Consumes: `ServerConfig`.
- Produces:
  - `ServerConfig.allowedHosts: string[]` from `CABIN_KIT_ALLOWED_HOSTS` (comma-separated host names, lower-cased, trimmed; default `[]`).
  - `export function allowedHostnames(config: Pick<ServerConfig, "host" | "allowedHosts">): Set<string>` → always `localhost`, `127.0.0.1`, `::1`, plus `config.host` and `config.allowedHosts`.
  - `export function hostnameOf(hostHeader: string | undefined): string | null` → lower-cased host without port; handles `[::1]:4310`; `null` when missing or unparseable.
  - `export function isWriteAllowed(headers: { origin?: string; host?: string; "sec-fetch-site"?: string }): boolean`.
- Rules: every request (all methods) whose `hostnameOf(Host)` is not in the set → 403 `HOST_NOT_ALLOWED`. Non-GET/HEAD requests additionally: `Origin` present and (`"null"`, unparseable, or `new URL(origin).host !== Host`) → 403 `CROSS_ORIGIN_WRITE`; `Sec-Fetch-Site` present and not `same-origin` or `none` → 403 `CROSS_ORIGIN_WRITE`. No `Origin` and no `Sec-Fetch-Site` (curl) → allowed.

- [ ] **Step 1: Write the failing tests.**

```ts
// hostGuard.test.ts
test.each([
  ["localhost:80", "localhost"], ["127.0.0.1:4310", "127.0.0.1"], ["[::1]:4310", "::1"],
  ["EVIL.example:4310", "evil.example"], [undefined, null], ["", null], ["a b", null],
])("hostnameOf(%s) = %s", (input, expected) => expect(hostnameOf(input)).toBe(expected));

// api.test.ts
test("a rebinding host is refused on reads and writes", async () => {
  const get = await app.inject({ method: "GET", url: "/api/health", headers: { host: "evil.example:4310" } });
  expect(get.statusCode).toBe(403);
  expect(get.json().error.code).toBe("HOST_NOT_ALLOWED");
  const post = await app.inject({ method: "POST", url: "/api/visits", headers: { host: "evil.example:4310", origin: "http://evil.example:4310" }, payload: { tail: "N100TL", checkDate: "2026-11-12" } });
  expect(post.statusCode).toBe(403);
  expect(visits.counts().visits).toBe(0);
});
test.each([
  [{ origin: "null" }, 403], [{ origin: "http://localhost:81" }, 403], [{ origin: "notaurl" }, 403],
  [{ "sec-fetch-site": "cross-site" }, 403], [{ "sec-fetch-site": "same-site" }, 403],
  [{ origin: "http://localhost:80", "sec-fetch-site": "same-origin" }, 201], [{}, 201],
])("write with %j → %i", async (headers, status) => { /* POST /api/visits N100TL 2026-11-12 */ });
test("the origin rule covers every write route", async () => { /* PUT records, POST remove, complete, events with origin http://x.test → 403 each */ });
test("a host named in CABIN_KIT_ALLOWED_HOSTS is accepted", async () => { /* makeApp({ allowedHosts: ["kit.internal"] }), Host kit.internal → 200 */ });
```

- [ ] **Step 2: Run.** Expected: FAIL (`HOST_NOT_ALLOWED` never returned; 201 for the rebinding write).
- [ ] **Step 3: Implement** the module and replace the body of the `onRequest` hook with the two rules.
- [ ] **Step 4: Run** `npm run check`. Expected: PASS. The existing cross-origin test must still pass unchanged.
- [ ] **Step 5: Document** the rules in `SECURITY.md` and the new variable in `docs/operations.md`.
- [ ] **Step 6: Commit** `fix(server): Host allow-list, stricter Origin and Sec-Fetch-Site checks (SRV-01)`.

---

### Task 1.2: Security headers, cache policy, compression

Closes SRV-04 and the transport half of SRV-05.

**Files:**
- Create: `src/server/http/headers.ts`
- Modify: `src/server/app.ts`, `package.json` (add `@fastify/compress`)

**Interfaces:**
- Produces `export const CONTENT_SECURITY_POLICY: string` =
  `default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
- Produces `export function applyHeaders(request: FastifyRequest, reply: FastifyReply): void` setting on every response: the CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, `Cross-Origin-Opener-Policy: same-origin`, `X-Frame-Options: DENY`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`. `Cache-Control`: `public, max-age=31536000, immutable` when the URL path starts with `/assets/`; otherwise `no-store`.

- [ ] **Step 1: Write the failing tests.** Use a temp `webRoot` containing `index.html` and `assets/app-abc123.js` (extend `makeApp` in `tests/helpers.ts` with a `webRoot` option).

```ts
test("every response carries the security header set", async () => {
  for (const url of ["/api/health", "/", "/assets/app-abc123.js", "/api/nope"]) {
    const r = await app.inject({ url });
    expect(r.headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  }
});
test("hashed assets are immutable, everything else is no-store", async () => {
  expect((await app.inject({ url: "/assets/app-abc123.js" })).headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect((await app.inject({ url: "/" })).headers["cache-control"]).toBe("no-store");
  expect((await app.inject({ url: "/api/health" })).headers["cache-control"]).toBe("no-store");
});
test("large JSON is compressed when the client accepts it", async () => {
  const r = await app.inject({ url: "/api/lookup?tail=N100TL&date=2026-11-12", headers: { "accept-encoding": "br, gzip" } });
  expect(["br", "gzip"]).toContain(r.headers["content-encoding"]);
  expect(r.rawPayload.length).toBeLessThan(30_000);
});
test("static serving: built index, traversal refused", async () => {
  expect((await app.inject({ url: "/" })).body).toContain("<!doctype html>");
  expect((await app.inject({ url: "/..%2f..%2fpackage.json" })).statusCode).toBe(404);
  expect((await app.inject({ url: "/assets/../../package.json" })).statusCode).toBe(404);
});
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `npm install @fastify/compress`; register it with `{ threshold: 1024, encodings: ["br", "gzip"] }` before the routes. `fastifyStatic` keeps `cacheControl: false` so `applyHeaders` owns the header.
- [ ] **Step 4: Check the built client against the CSP.** Run `npm run build && npm start` with a temp data dir, open `http://127.0.0.1:4310` in a browser, complete the README walk-through (N100TL, 3A, record, complete, report, PDF link), and confirm the console shows no CSP violation. If React inline `style` props are blocked, the `style-src-attr` directive is wrong; fix the policy, not the client.
- [ ] **Step 5: Run** `npm run check`. **Commit** `feat(server): CSP and security headers, immutable asset caching, compression (SRV-04, SRV-05)`.

---

### Task 1.3: Validate query strings and path parameters

Closes SRV-02.

**Files:**
- Create: `src/server/http/schemas.ts`
- Modify: `src/server/app.ts` (routes `/api/visits`, `/api/lookup`, `/api/preparation`, every `/api/visits/:id…`, `/api/layouts/:id`)

**Interfaces:**
- Produces:
  - `export const ListVisitsQuery = z.object({ status: z.enum(["DRAFT","COMPLETED"]).optional(), q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).max(1_000_000).default(0) }).strict()`
  - `export const LookupQuery = z.object({ tail: z.string().max(40).optional(), date: z.string().max(40).optional(), format: z.enum(["csv"]).optional() }).strict()`
  - `export const VisitIdParam = z.string().uuid()`
  - `export function parseOr400<T>(schema: z.ZodType<T>, value: unknown, code: string): T` → throws `DomainError(code, <first issue as "path: message">, 400, { issues })`.
- Codes: `INVALID_QUERY` for query strings. A visit id that is not a UUID → `DomainError("VISIT_NOT_FOUND", "Visit not found.", 404)` (same answer as an unknown id). Keep the existing `INVALID_STATUS` code for a bad `status` so the client mapping does not change: check `status` first, as today.
- Body validation keeps its existing codes and hand-written checks; do not convert it in this task.

- [ ] **Step 1: Write the failing tests.**

```ts
test.each(["limit=abc", "limit=0", "limit=201", "limit=1.5", "offset=-1", "offset=x", "bogus=1", "q=" + "a".repeat(101)])(
  "GET /api/visits?%s → 400 INVALID_QUERY", async (qs) => {
    const r = await app.inject({ url: `/api/visits?${qs}` });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("INVALID_QUERY");
  });
test("GET /api/visits?status=BOGUS → 400 INVALID_STATUS", ...);
test("GET /api/visits defaults to limit 50 offset 0", async () => { expect((await app.inject({ url: "/api/visits" })).json()).toMatchObject({ limit: 50, offset: 0 }); });
test("repeated tail parameter is INVALID_QUERY, not a crash", async () => { expect((await app.inject({ url: "/api/lookup?tail=a&tail=b&date=2026-11-12" })).statusCode).toBe(400); });
test.each(["/api/visits/not-a-uuid", "/api/visits/not-a-uuid/report", "/api/visits/..%2Fhealth"])("%s → 404 VISIT_NOT_FOUND", ...);
test("GET /api/layouts/nope → 404 LAYOUT_NOT_FOUND", ...);
```

- [ ] **Step 2: Run.** Expected: FAIL; `limit=abc` gives 503.
- [ ] **Step 3: Implement.** In `VisitStore.listVisits`, also throw `DomainError("INVALID_QUERY", ..., 400)` if `limit` or `offset` is not a finite integer, so the store is safe without the HTTP layer.
- [ ] **Step 4: Run** `npm run check`. **Commit** `fix(server): validate query strings and ids (SRV-02)`.

---

### Task 1.4: Honest error handling and request logging

Closes SRV-03.

**Files:**
- Create: `src/server/http/errors.ts`
- Modify: `src/server/app.ts`, `src/server/visitStore.ts` (`write`, `read`), `src/server/config.ts`, `tests/helpers.ts`

**Interfaces:**
- Produces:
  - `export class StorageError extends Error { constructor(message: string, options?: { cause?: unknown }) }` in `visitStore.ts`. `write()` and `read()` wrap any error that is not a `DomainError` and whose `code` starts with `ERR_SQLITE` (or matches the existing `isBusy`) in `StorageError`. The fault-injection path throws `StorageError("Simulated visit store failure")`.
  - `ServerConfig.logLevel: "silent" | "error" | "warn" | "info" | "debug"` from `CABIN_KIT_LOG_LEVEL`, default `info`; `makeApp` in tests passes `silent`.
  - `export function installErrorHandler(app: FastifyInstance): void` with this mapping:

| Error | Status | Code | Logged at |
| --- | --- | --- | --- |
| `DomainError` | its `status` | its `code` | `info` (4xx), `error` (5xx) |
| `ReferenceStoreError` | 503 | `REFERENCE_UNAVAILABLE` | `warn` |
| `StorageError` | 503 | `STORAGE_UNAVAILABLE`, message "The store could not complete the request. Nothing was saved." | `error` |
| Fastify error with `statusCode` 400–499 | that status | `BAD_REQUEST` | `info` |
| anything else | 500 | `INTERNAL_ERROR`, message "The request failed unexpectedly." | `error` with stack |

  The envelope `details` is `{ requestId }` for 500 and 503 and never contains `error.message` of an unexpected error.
- Fastify is created with `{ logger: { level: config.logLevel }, genReqId: () => randomUUID(), requestIdHeader: false, bodyLimit: 256 * 1024 }` and an `onSend` hook sets `X-Request-Id`.

- [ ] **Step 1: Write the failing tests.**

```ts
test("an unexpected exception is 500 INTERNAL_ERROR and does not leak its message", async () => {
  // makeApp exposes handle.app; register a throwing route before ready():
  app.get("/api/__boom", async () => { throw new TypeError("secret detail"); });
  const r = await app.inject({ url: "/api/__boom" });
  expect(r.statusCode).toBe(500);
  expect(r.json().error.code).toBe("INTERNAL_ERROR");
  expect(r.body).not.toContain("secret detail");
  expect(r.json().error.details.requestId).toBe(r.headers["x-request-id"]);
});
test("a storage fault is still 503 STORAGE_UNAVAILABLE", ...);   // the existing fault test, now also asserting no cause text
test("malformed JSON keeps the error envelope", async () => { /* 400, error.code BAD_REQUEST, details null */ });
test("body over 256 KB → 413 with the envelope", ...);
test("array or scalar JSON body → 400 INVALID_BODY", ...);
test("idempotencyKey of length 7, 101, or non-string → 400 INVALID_IDEMPOTENCY_KEY", ...);
```

- [ ] **Step 2: Run.** Expected: FAIL (`/api/__boom` returns 503 with the message in `details.cause`).
- [ ] **Step 3: Implement.** Remove the inline `setErrorHandler` from `app.ts`.
- [ ] **Step 4: Check the client mapping.** `grep -n "STORAGE_UNAVAILABLE\|INTERNAL_ERROR\|details.cause" src/web tests/e2e`. Anything that reads `details.cause` must stop. The client treats 500 like 503 for display until Task 4.1 refines it.
- [ ] **Step 5: Run** `npm run check`. **Commit** `fix(server): separate internal errors from storage faults, add request logging (SRV-03)`.

---

### Task 1.5: Mutation responses without the snapshot

Closes SRV-05. Decision D5.

**Files:**
- Modify: `src/domain/types.ts`, `src/server/visitStore.ts`, `src/server/app.ts`, `src/web/api.ts`, `src/web/views/CheckView.tsx`, `src/web/views/ReportView.tsx`, `tests/process/worker.ts` if it reads `visit.snapshot` from a mutation result

**Interfaces:**
- Produces:
  - `export type VisitState = Omit<Visit, "snapshot">` in `types.ts`.
  - `VisitMutationResult = { visit: VisitState; replayed: boolean }`; `CompletionResult.visit: VisitState`; `addLinkedEvent(...)` returns `VisitState`.
  - `VisitStore.createVisit` and `VisitStore.getVisit` still return the full `Visit`.
  - Private `loadVisitState(id): VisitState` selects every `visits` column except `snapshot_json`. Private `loadSnapshot(id): VisitSnapshot`. `upsertRecord` and `completeVisit` call `loadSnapshot` once.
- Wire contract: `POST /api/visits` and `GET /api/visits/:id` return `{ visit: Visit, … }`. `PUT …/records`, `POST …/records/remove`, `POST …/complete`, `POST …/events` return `{ visit: VisitState, … }`.
- Client: `api.ts` types follow. `CheckView` and `ReportView` merge with `setVisit((current) => current && { ...res.visit, snapshot: current.snapshot })`.

- [ ] **Step 1: Write the failing tests** in `api.test.ts`:

```ts
test("mutation responses omit the snapshot and stay small", async () => {
  const created = (await post("/api/visits", { tail: "N100TL", checkDate: "2026-11-12" })).json();
  expect(created.visit.snapshot).toBeDefined();
  const put = await put(`/api/visits/${created.visit.id}/records`, { record: cushionAt("SEAT:3A") });
  expect("snapshot" in put.json().visit).toBe(false);
  expect(put.rawPayload.length).toBeLessThan(8_000);
  expect(put.json().visit.records).toHaveLength(1);
  expect(put.json().visit.snapshotSha256).toBe(created.visit.snapshotSha256);
});
```

  Reuse the record helper the file already has for a valid cushion record; `cushionAt` is a placeholder for it.
- [ ] **Step 2: Run.** Expected: FAIL (`snapshot` present, payload about 154 KB).
- [ ] **Step 3: Implement** store, routes, then the client. `npm run typecheck` finds every client site.
- [ ] **Step 4: Run** `npm run check && npm run build`. Then run the existing E2E once by hand (`node tests/e2e/run.ts`) and confirm 62 of 62; discard its changes to `verification/` with `git checkout -- verification`.
- [ ] **Step 5: Commit** `perf(api): return visit state without the snapshot on writes (SRV-05)`.

---

### Task 1.6: Idempotent linked events, key retention

Closes SRV-06, SRV-07. Decision D4.

**Files:**
- Modify: `src/server/visitStore.ts`, `src/server/app.ts`, `docs/logical-model.md`

**Interfaces:**
- `addLinkedEvent(visitId, type, note, author, options: MutationOptions): { visit: VisitState; replayed: boolean }`. Scope `event:${visitId}`; request hash over `{ op: "event", visitId, type, note, author }` after trimming.
- Validation order: trim `note` and `author` first; `note` 1–2000 characters after trim; `author` longer than 80 → 422 `INVALID_EVENT` (no truncation).
- Route `POST /api/visits/:id/events` accepts only `type`, `note`, `author`, `idempotencyKey`; any other key → 422 `UNSUPPORTED_FIELD`. Replay → 200; first write → 201.
- `completeVisit` stores its key under scope `complete:${visitId}` and returns `replayed: true` only when that key is found again. `alreadyCompleted` is unchanged.
- `export const IDEMPOTENCY_RETENTION_DAYS = 30`. `VisitStore.pruneIdempotency(before: string): number` deletes rows with `created_at < before` in one write transaction and returns the count. `VisitStore.open` calls it once with now minus 30 days.

- [ ] **Step 1: Write the failing tests** (`tests/integration/visitStore.test.ts` and `api.test.ts`):

```ts
test("a repeated event key appends once", () => {
  const a = store.addLinkedEvent(id, "ADVISORY", "Check seam", "JM", { idempotencyKey: "evt-key-0001" });
  const b = store.addLinkedEvent(id, "ADVISORY", "Check seam", "JM", { idempotencyKey: "evt-key-0001" });
  expect(a.replayed).toBe(false); expect(b.replayed).toBe(true);
  expect(b.visit.events.filter((e) => e.type === "ADVISORY")).toHaveLength(1);
});
test("the same event key with a different note is refused", () => { /* 422 IDEMPOTENCY_KEY_REUSED */ });
test("note is trimmed before the length check; author over 80 is refused", () => { /* "  x  " accepted as "x"; " ".repeat(5) refused; 81-char author → INVALID_EVENT */ });
test("pruneIdempotency removes only rows older than the cutoff", () => { /* two keys with options.now 40 and 5 days ago; prune → 1; the recent key still replays */ });
test("completion replayed flag reflects a real key match", () => { /* complete with key k → replayed false; again with k → true; again with no key → alreadyCompleted true, replayed false */ });
test("POST events: 201 then 200 on replay; bad type → 422; unknown field → 422", ...);
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Update the "Retry" row in `docs/logical-model.md` to include events and the 30-day retention.
- [ ] **Step 4: Run** `npm run check`. **Commit** `fix(visits): idempotent linked events, prune old retry keys (SRV-06, SRV-07)`.

---

### Task 1.7: Store migrations and integrity checks

Closes SRV-09, SRV-10. Review Focus 1.

**Files:**
- Create: `src/server/migrations.ts`
- Modify: `src/server/visitStore.ts`, `src/server/referenceStore.ts`
- Test: `tests/integration/visitStoreCompat.test.ts`, `tests/integration/referenceStore.test.ts`

**Interfaces:**
- Produces:
  - `export interface Migration { to: number; description: string; sql: string }`
  - `export const VISIT_MIGRATIONS: Migration[]` — first entry `{ to: 2, description: "index retry keys by age", sql: "CREATE INDEX IF NOT EXISTS idempotency_created ON idempotency(created_at);" }`.
  - `export function migrate(db: DatabaseSync, current: number, migrations: Migration[]): number` — applies every migration with `to > current` in ascending order inside one `BEGIN IMMEDIATE`, updates `meta.schema_version`, returns the new version.
  - `VISIT_SCHEMA_VERSION` becomes `"2"`. A fresh store runs `SCHEMA` then all migrations. A store with a version greater than the newest known → `DomainError("VISIT_SCHEMA_NEWER", "This visit store was written by a newer version of Cabin Kit.", 500)`. A non-numeric version → `VISIT_SCHEMA_MISMATCH` as today.
  - `VisitStore.open` runs `PRAGMA quick_check` and throws `DomainError("VISIT_STORE_CORRUPT", …, 500)` unless the single row is `ok`.
  - `loadSnapshot` recomputes `sha256Hex(snapshot_json)`; mismatch → `DomainError("SNAPSHOT_CORRUPT", "The stored configuration for this visit does not match its recorded hash.", 500, { visitId })`. `getReport` does the same for `report_json` against `basis_sha256` → `REPORT_CORRUPT`.
  - `ReferenceStore.loadRelease` recomputes `contentHash` of the reassembled content before caching; mismatch → `ReferenceStoreError("RELEASE_CORRUPT", …)`. The cached release is deep-frozen (`deepFreeze<T>(value: T): T` in `src/domain/canonical.ts`).

- [ ] **Step 1: Write the failing tests.**

```ts
// visitStoreCompat.test.ts — copies tests/fixtures/visits-5d6679d.sqlite into a temp dir first
test("opens a store written by 5d6679d and migrates it", () => {
  const store = VisitStore.open(copy, referencePath);
  expect(store.counts()).toMatchObject({ visits: 2, drafts: 1, completed: 1 });
  expect(metaVersion(copy)).toBe("2");
});
test("a stored /1 report is served byte-identical", () => {
  const before = rawReportJson(fixture, completedId);
  expect(canonicalJson(store.getReport(completedId).report)).toBe(before);
});
test("the old draft can still be edited and completed", () => { /* upsert a record, complete, report.reportKind FINAL */ });
test("a newer schema version is refused without modification", () => { /* set meta schema_version 99, open throws VISIT_SCHEMA_NEWER, file bytes unchanged */ });
test("a tampered snapshot is detected", () => { /* DROP TRIGGER visits_snapshot_immutable; UPDATE snapshot_json; getVisit throws SNAPSHOT_CORRUPT */ });
// referenceStore.test.ts
test("a tampered release entity is detected on load", () => { /* drop the frozen trigger, edit one data_json, new store instance loadActive throws RELEASE_CORRUPT */ });
test("the cached release cannot be mutated", () => { expect(() => { store.loadActive().rules.length = 0; }).toThrow(TypeError); });
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** If freezing breaks an existing test that mutates a loaded release, change that test to `structuredClone` first; do not weaken the freeze.
- [ ] **Step 4: Run** `npm run check`. **Commit** `feat(stores): migrations, hash verification on read, frozen release cache (SRV-09, SRV-10)`.

---

### Task 1.8: Configuration validation, clean shutdown, backup command

Closes SRV-08, SRV-11.

**Files:**
- Modify: `src/server/config.ts`, `src/server/main.ts`, `package.json`, `.gitignore` (add `backups/`), `docs/operations.md`
- Create: `tools/backup-visits.ts`
- Test: `tests/unit/config.test.ts`, `tests/process/main.test.ts`

**Interfaces:**
- `export class ConfigError extends Error {}`.
- `resolveServerConfig` throws `ConfigError`:
  - port not an integer in 0–65535 → `CABIN_KIT_PORT must be a whole number from 0 to 65535 (got "abc").`
  - host not in `{127.0.0.1, ::1, localhost}` and `CABIN_KIT_ALLOW_REMOTE !== "1"` → `CABIN_KIT_HOST "<host>" is not a loopback address. This server has no authentication. Set CABIN_KIT_ALLOW_REMOTE=1 to accept the risk.`
  - unknown `CABIN_KIT_LOG_LEVEL`.
- `main.ts`: `ConfigError` → message on stderr, exit code 2. `EADDRINUSE` → `Port <n> is in use. Set CABIN_KIT_PORT.`, exit 1. Shutdown runs once (a second signal while closing forces `process.exit(1)`), with a 5 s timer that forces exit 1. `unhandledRejection` and `uncaughtException` log at `fatal` and exit 1.
- `tools/backup-visits.ts`: `npm run visits:backup -- [--out <file>]`. Default `backups/visits-<YYYYMMDD-HHMMSS>Z.sqlite`. Opens the visit store, calls `backupTo`, then opens the copy read-only, runs `PRAGMA quick_check`, prints path, byte size and visit count. Refuses to overwrite. Uses `parseCliArgs` from Task 3.1 if that task is done; otherwise `node:util` `parseArgs` with `strict: true`.

- [ ] **Step 1: Write the failing tests.**

```ts
// config.test.ts
test.each(["abc", "-1", "65536", "80.5", ""])("port %s is rejected", (p) => expect(() => resolveServerConfig({}, { CABIN_KIT_PORT: p })).toThrow(ConfigError));
test("a non-loopback host needs CABIN_KIT_ALLOW_REMOTE=1", () => {
  expect(() => resolveServerConfig({}, { CABIN_KIT_HOST: "0.0.0.0" })).toThrow(/no authentication/);
  expect(resolveServerConfig({}, { CABIN_KIT_HOST: "0.0.0.0", CABIN_KIT_ALLOW_REMOTE: "1" }).host).toBe("0.0.0.0");
});
test("relative store paths resolve against the working directory; TEST_FAULTS only on '1'", ...);
// main.test.ts — spawns `node src/server/main.ts` with a temp data dir and CABIN_KIT_PORT=0
test("first start imports, second start does not re-import", ...);            // release count stays 1
test("SIGTERM exits 0 within 5 s", ...);
test("an occupied port exits 1 with a clear message", ...);
test("a bad port exits 2 before touching any store", ...);                    // data dir stays empty
test("visits:backup writes a verifiable copy and refuses to overwrite", ...);
```

  The spawn tests wait for the line `listening on` on stdout, never for a fixed delay.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Replace the "Backup and restore" section of `docs/operations.md` with the command; keep the manual copy as the fallback.
- [ ] **Step 4: Run** `npm run check`. **Commit** `feat(server): validated config, single-shot shutdown, visits:backup (SRV-08, SRV-11)`.

---

### Task 1.9: CSV cell safety and reference-store tidy-up

Closes SRV-12, SRV-15.

**Files:**
- Modify: `src/server/app.ts` (`csvCell`), `src/server/referenceStore.ts`

**Interfaces:**
- `csvCell(value: unknown): string` — for `typeof value === "string"` whose first character is one of `=`, `+`, `-`, `@`, TAB, CR: prefix a single quote `'` before quoting rules apply. Numbers are written unchanged. Export it for the test.
- `ReferenceStore.loadActive` reads the pointer and the release inside one `BEGIN … COMMIT`. A private `rollbackQuietly()` replaces the three bare `this.db.exec("ROLLBACK")` calls in `create`, `stage`, `activate`, `loadRelease`.

- [ ] **Step 1: Write the failing tests.**

```ts
test.each([["=1+1", "'=1+1"], ["+1", "'+1"], ["-cmd", "'-cmd"], ["@x", "'@x"], ["\tx", "'\tx"], ["plain", "plain"], ['a"b', '"a""b"'], ["=a,b", "\"'=a,b\""]])("csvCell(%j) = %j", (i, o) => expect(csvCell(i)).toBe(o));
test("numbers are never prefixed", () => { expect(csvCell(-1)).toBe("-1"); });
test("preparation CSV has the attachment filename and neutralised cells", async () => { /* visit prep ?format=csv: content-disposition contains cabin-kit-preparation-N100TL-2026-11-12.csv; no line has a field starting with = + @ */ });
test("stage keeps the original error when rollback also fails", ...);
```

- [ ] **Step 2: Run, implement, run** `npm run check`. **Commit** `fix(server): neutralise spreadsheet formulas in CSV, tidy reference transactions (SRV-12, SRV-15)`.

---

### Task 1.10: PDF robustness and accessibility

Closes SRV-14.

**Files:**
- Modify: `src/server/pdf.ts`
- Test: `tests/integration/pdf.test.ts` (move the existing PDF tests out of `api.test.ts` into it)

**Interfaces:**
- `renderReportPdf` signature unchanged.
- Document options add `lang: "en-GB"`, `displayTitle: true`, `tagged: true`, `pdfVersion: "1.7"`. Before writing code, read the "Accessibility" section of the installed pdfkit guide (`node_modules/pdfkit/README.md` links it) for `doc.struct`, `doc.addStructure` and `doc.markContent`: headings are tagged `H1`/`H2`, paragraphs `P`, each table `Table` with `TR`, `TH`, `TD`; page header and footer are marked as `Artifact`.
- Notice box height is `heightOfString(notice, { width: width - 12 }) + 12`, not 34.
- Long notes: a work-item note longer than 160 characters is not printed in the table cell. The cell shows `See note N`, and a section "Notes" after the work table prints `N. <location> / <component>: <note>` with `para`, which paginates. Linked-event notes follow the same rule with their own numbering prefix `E`.
- Any table row whose computed height exceeds the usable page height throws `Error("pdf: row taller than a page in <table name>")` so a regression is loud.

- [ ] **Step 1: Write the failing tests** (extract text with `pdfjs-dist` as the existing tests do):

```ts
test("a 2000-character note is printed in full in the Notes section", async () => { /* text contains the first and last 40 characters of the note, and "See note 1" */ });
test("linked events and the basis hash are printed", ...);
test("characters outside WinAnsi are replaced, never dropped silently", async () => { /* note "漢字 → ok" → text contains "?? -> ok" */ });
test("the document declares its language and title", async () => { /* raw bytes contain /Lang (en-GB) and /MarkInfo << /Marked true >> ; metadata Title starts with "Cabin Kit report" */ });
test("rendering the same stored report twice gives identical bytes", async () => { expect(Buffer.compare(a, b)).toBe(0); });
test("CreationDate equals report.generatedAt", ...);
```

  If the byte-identity test fails because pdfkit derives the file ID from the current time, pass a fixed `info.CreationDate`/`ModDate` (already done) and check whether the installed version exposes an `id` option; if it does not, compare the two buffers after removing the `/ID [...]` entry and say so in the test name.
- [ ] **Step 2: Run, implement, run** `npm run check`.
- [ ] **Step 3: Look at the result.** Render `verification/samples/sample-completed-report.json` to a temp PDF and open it in Preview. Check: no clipped notice box, table headers repeat on page 2, footer page numbers correct. This is a manual check; record that it was done in the commit body.
- [ ] **Step 4: Raise the coverage thresholds** for `src/server` in `vitest.config.ts` to the new measured value rounded down to 5. **Commit** `feat(pdf): tagged PDF with language, long notes section, deterministic output (SRV-14)`.
