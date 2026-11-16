# Cabin Kit Platinum Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all 82 audit findings and raise Cabin Kit to production grade: reproducible from a clean clone, strict about its inputs, safe on loopback, correct under concurrency, accessible, and visually credible in 3D.

**Architecture:** No rewrite. The existing layering (pure domain, importer, two SQLite stores, Fastify API, React client, three.js scene) stays. The work adds a schema layer in front of validation, a guarded HTTP edge, a small data layer in the client, a scene that updates incrementally, and a test pipeline that runs in CI without touching tracked files.

**Tech Stack:** Node 24 (type stripping, `node:sqlite`), TypeScript 7, Fastify 5, zod 4, React 19, Vite 8, three.js 0.187, vitest 5, `@playwright/test`, Biome.

**Spec:** [`docs/audit-2026-11-15.md`](../../../audit-2026-11-15.md) (finding ids `SRV-`, `DOM-`, `IMP-`, `WEB-`, `TST-`). Domain rules: [`docs/logical-model.md`](../../../logical-model.md).

## Phases

Each phase is a separate file, leaves the repository green, and can ship alone. Do them in order: later phases use interfaces from earlier ones.

| # | File | Scope | Tasks | Findings closed |
| --- | --- | --- | --- | --- |
| 0 | [`01-foundation.md`](01-foundation.md) | Clean-clone reproducibility, dependencies, lint, strict types, CI | 0.1 – 0.7 | TST-01, TST-10, DOM-11, SRV-13 |
| 1 | [`02-server.md`](02-server.md) | HTTP edge, stores, PDF | 1.1 – 1.10 | SRV-01 – SRV-15 |
| 2 | [`03-domain.md`](03-domain.md) | Schema, validation, resolver, kits, report | 2.1 – 2.8 | DOM-01 – DOM-22 |
| 3 | [`04-importer.md`](04-importer.md) | CLI, fixtures, cross-format, readers, tools | 3.1 – 3.8 | IMP-01 – IMP-14 |
| 4 | [`05-web-correctness.md`](05-web-correctness.md) | Data layer, routing, forms, accessibility, scene lifecycle | 4.1 – 4.8 | WEB-01 – WEB-19 |
| 5 | [`06-visual-quality.md`](06-visual-quality.md) | Geometry budget, materials, lighting, motion, app shell | 5.1 – 5.8 | WEB-20, WEB-21 |
| 6 | [`07-verification.md`](07-verification.md) | Playwright migration, evidence pipeline, race tests, docs | 6.1 – 6.6 | TST-02 – TST-09 |

55 tasks. Each task is one commit with its own tests. After Phase 0, Phases 1 and 2 can be worked in parallel worktrees: they overlap only in `src/server/pdf.ts` (Tasks 1.10 and 2.3; land 1.10 first). Phase 3 needs Phase 2. Phases 4, 5 and 6 are sequential.

## Global Constraints

- Node `>=24.0.0`. No native modules that need a compiler. No new runtime dependency except `@fastify/compress`; dev dependencies named in the tasks only.
- All application data stays fictional. Never add real tails, part numbers or approvals. The `accepted` namespace stays empty.
- Never write outside `implementation/cabin-kit/`. The 23 originals in `../../` are read-only; verify with `npm run originals:verify` after any phase that touches the importer or tools.
- Never touch `./data` from a test or a tool other than `sample:seed`. Tests use temp stores from `tests/helpers.ts`.
- Visit stores written by commit `5d6679d` must still open, list, report and complete after every phase. Snapshot and report readers accept the old shapes (Task 2.3 defines how).
- Stored snapshots, reports and events are immutable. No task may add an `UPDATE` or `DELETE` path for them.
- Every write remains one `BEGIN IMMEDIATE` transaction.
- Error envelope is `{ "error": { "code": string, "message": string, "details": unknown | null } }` on every non-2xx API answer.
- All ordering of strings in domain, importer and server code uses `compareCodePoints` (Task 0.6). `localeCompare` is banned outside `src/web` by a lint rule.
- TDD: write the failing test, see it fail for the stated reason, implement, see it pass. One commit per task, message `type(scope): summary (FINDING-IDS)`.
- A task is done when `npm run check` passes (defined in Task 0.4: `biome ci . && tsc -b && vitest run`). From Phase 6 on, also `npm run test:e2e`.
- Line numbers quoted from the audit are as of `5d6679d`. Locate by symbol name.
- UI copy: plain sentences, no exclamation marks, British spelling as in the existing strings ("colour", "centre").

## Decisions already made

These were open questions in the audit. They are settled here so no task has to stop and ask. Each is reversible; the owner may overrule before execution starts.

| # | Decision | Reason |
| --- | --- | --- |
| D1 | Copy the 9 data and document originals (not the 14 images) into `fixtures/originals/`, byte-identical, and resolve the source root as: `CABIN_KIT_SOURCE_ROOT` (if non-empty) → `fixtures/originals/` → `../../`. | TST-01. A clean clone and CI must work. About 750 KB. The images are needed only by the comparison tool, which stays local. |
| D2 | Feasible (variant, layout revision) pairs are built from released variants and non-planned revisions only. | DOM-03. Unreleased data must not change an outcome for a released tail. |
| D3 | An invalid source on the variant or the layout revision gives `SOURCE_INVALID`. An invalid source on a kit child excludes the part that needs it, with the reason kept. | DOM-04. Same rule as for rules and substitutes. |
| D4 | Linked events stay allowed on drafts and completed visits, and gain an idempotency key. | SRV-06. Tightening to completed-only would break existing use; the duplicate is the defect. |
| D5 | Mutation responses return the visit without its snapshot (`VisitState`). The client keeps the snapshot from the initial `GET`. | SRV-05, and it removes the cause of WEB-01. |
| D6 | New reports use schema `cabin-kit.report/2`; stored `/1` reports are served unchanged. | DOM-01, DOM-16 add fields. Stored reports are immutable. |
| D7 | E2E moves to `@playwright/test`. Evidence capture (renders, samples, performance) becomes a separate command that writes to a git-ignored folder; curated evidence is committed by hand. | TST-02 – TST-05. |
| D8 | Lint and format with Biome. | One tool, no plugin tree, fast. |

## Review Focus

Inputs and conditions the audit implies and that are most likely to hurt a person using the software. Each has a test in the task named.

1. **A visit store created before this work is opened by the new build.** Expected: it opens, old snapshots without `excluded` render, old `/1` reports are served byte-identical, completion still works. Test in Task 1.7 (`opens a store written by 5d6679d`) with a committed binary fixture.
2. **Two tabs editing one visit while one loses its connection mid-save.** Expected: the tab with the unknown outcome can retry safely with the same key; the other tab's save is neither lost nor overwritten by a late response. Tests in Task 4.2.
3. **A reference import where one export was edited by hand** (renamed column, renamed id, dropped column). Expected: `CROSS_FORMAT_MISMATCH`, release rejected, previous release still active. Tests in Task 3.3.
4. **A keyboard-only technician completes a whole visit**, including Skip to content, selecting a seat, reaching the parts form, the completion dialog and its cancel. Expected: focus is never lost to `<body>` and the route never changes by accident. Tests in Tasks 4.3 and 4.6, and the keyboard spec in Task 6.1.
5. **A phone in portrait with the URL bar collapsing and a pinch gesture ending.** Expected: the camera does not reset, no seat is selected by the gesture, the page still scrolls. Tests in Task 4.7 and the mobile project in Task 6.1.

## File structure after the plan

New files only; existing files keep their place.

```
.github/workflows/ci.yml
biome.json  .editorconfig  .nvmrc  .npmrc  SECURITY.md  CHANGELOG.md
tsconfig.base.json  tsconfig.node.json  tsconfig.web.json   (tsconfig.json becomes a solution file)
fixtures/originals/                      9 vendored originals + README.md
src/domain/order.ts                      compareCodePoints
src/domain/canonical.ts                  canonicalJson, sha256Hex
src/domain/schema.ts                     zod schemas for ReleaseContent; structuralFindings
src/domain/limits.ts                     MAX_QTY and other numeric caps
src/importer/args.ts                     strict CLI argument parsing
src/importer/fixtureSchema.ts            zod schema for fixture-data.json
src/importer/originals.ts                the one list of originals; resolveSourceRoot
src/importer/readers/ooxml.ts            shared zip + XML helpers with size caps
src/server/http/hostGuard.ts             Host allow-list
src/server/http/headers.ts               security and cache headers
src/server/http/schemas.ts               zod request schemas
src/server/http/errors.ts                error handler
src/server/migrations.ts                 visit-store migrations
tools/backup-visits.ts
tools/capture-evidence.ts
tools/check-budgets.ts  budgets.json
src/web/hooks/useResource.ts             fetch with abort and stale guard
src/web/hooks/useMutations.ts            per-target write queue
src/web/routes.ts                        parseRoute, formatRoute
src/web/components/ConfirmDialog.tsx  Toasts.tsx  Skeleton.tsx
src/web/format.ts                        human-readable dates and state labels
src/web/styles/                          tokens.css, base.css, one file per view
src/web/scene/materials.ts  environment.ts  cameraRig.ts  outline.ts  pickGesture.ts
tests/web/                               jsdom component and hook tests
tests/fixtures/visits-5d6679d.sqlite     backward-compatibility fixture
e2e/                                     @playwright/test specs and fixtures
playwright.config.ts
```
