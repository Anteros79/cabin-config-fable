import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveStoreConfig } from "../server/config.ts";
import { assertSafeReferenceTarget, inspectStore, ReferenceStore, ReferenceStoreError, resetReferenceStore } from "../server/referenceStore.ts";
import { VisitStore } from "../server/visitStore.ts";
import { type OptionSpec, parseCliArgs, UsageError } from "./args.ts";
import { buildStagedRelease, defaultSourceRoot } from "./assemble.ts";
import { assertSourceRoot } from "./originals.ts";

/**
 * Reference data CLI. It only ever writes the reference store; the visit store is opened
 * (when it already exists) solely to prove its history is unchanged.
 *
 *   node src/importer/cli.ts import   [--data-dir DIR] [--reference-db FILE] [--visits-db FILE] [--source-root DIR] [--fixtures FILE]
 *                                     [--label TEXT] [--no-activate] [--no-candidate] [--accept-changed]
 *   node src/importer/cli.ts status   [--data-dir DIR] [--reference-db FILE] [--visits-db FILE]
 *   node src/importer/cli.ts findings [--release ID] [same path options as status]
 *   node src/importer/cli.ts reset --yes [same options as import]
 *   node src/importer/cli.ts help
 *
 * `--reference` and `--visits` remain accepted as the older names of `--reference-db` and `--visits-db`.
 * Exit codes: 0 done, 1 failed, 2 release rejected, 3 visit history changed, 64 usage error.
 */
const STORE_OPTIONS = {
  "data-dir": { type: "string" },
  "reference-db": { type: "string" },
  "visits-db": { type: "string" },
  reference: { type: "string" },
  visits: { type: "string" },
} as const;

const IMPORT_OPTIONS = {
  ...STORE_OPTIONS,
  "source-root": { type: "string" },
  fixtures: { type: "string" },
  label: { type: "string" },
  "no-activate": { type: "boolean" },
  "no-candidate": { type: "boolean" },
  "accept-changed": { type: "boolean" },
} as const;

const COMMANDS = {
  import: IMPORT_OPTIONS,
  status: STORE_OPTIONS,
  findings: { ...STORE_OPTIONS, release: { type: "string" } },
  reset: { ...IMPORT_OPTIONS, yes: { type: "boolean" } },
  help: {},
} as const satisfies Record<string, Record<string, OptionSpec>>;

type Command = keyof typeof COMMANDS;

const USAGE = `Usage: node src/importer/cli.ts <import|status|findings|reset|help> [options]
  import   [--data-dir DIR] [--reference-db FILE] [--visits-db FILE] [--source-root DIR] [--fixtures FILE]
           [--label TEXT] [--no-activate] [--no-candidate] [--accept-changed]
  status   [--data-dir DIR] [--reference-db FILE] [--visits-db FILE]
  findings [--release ID] [--data-dir DIR] [--reference-db FILE] [--visits-db FILE]
  reset    --yes [same options as import]
  help
Exit codes: 0 done, 1 failed, 2 release rejected, 3 visit history changed, 64 usage error.`;

const isCommand = (name: string): name is Command => Object.hasOwn(COMMANDS, name);

function visitFingerprint(visitsPath: string, referencePath: string): string | null {
  if (!existsSync(visitsPath) || inspectStore(visitsPath).kind !== "visits") return null;
  const store = VisitStore.open(visitsPath, referencePath);
  try {
    return store.fingerprint();
  } finally {
    store.close();
  }
}

export interface ImportOutcome {
  releaseId: string;
  status: "validated" | "rejected";
  activated: boolean;
  findingCounts: Record<string, number>;
  visitsUnchanged: boolean | null;
}

/** Stage, validate and (if clean) activate a new release. Shared by the CLI, the server and tests. */
export function importReference(options: {
  referencePath: string;
  visitsPath: string;
  sourceRoot?: string;
  fixturePath?: string;
  label?: string;
  activate?: boolean;
  includeCandidate?: boolean;
  acceptChanged?: boolean;
}): ImportOutcome {
  const includeCandidate = options.includeCandidate ?? true;
  const sourceRoot = options.sourceRoot ?? defaultSourceRoot();
  // Before any store is opened or created: a wrong source root must leave the data directory untouched.
  if (includeCandidate) assertSourceRoot(sourceRoot);
  assertSafeReferenceTarget(options.referencePath, options.visitsPath);
  const before = visitFingerprint(options.visitsPath, options.referencePath);
  const store = ReferenceStore.openOrCreate(options.referencePath, options.visitsPath);
  try {
    const staged = buildStagedRelease({
      sourceRoot,
      fixturePath: options.fixturePath,
      label: options.label,
      includeCandidate,
      acceptChanged: options.acceptChanged,
    });
    const { id, status } = store.stage(staged.content, staged.findings, staged.stats);
    const activate = (options.activate ?? true) && status === "validated";
    if (activate) store.activate(id);
    const findingCounts: Record<string, number> = {};
    for (const f of staged.findings) findingCounts[f.severity] = (findingCounts[f.severity] ?? 0) + 1;
    const after = visitFingerprint(options.visitsPath, options.referencePath);
    return { releaseId: id, status, activated: activate, findingCounts, visitsUnchanged: before === null ? null : before === after };
  } finally {
    store.close();
  }
}

const MAX_PRINTED_ERRORS = 20;

/** The `error` findings of a stored release, one line each (at most 20), for a rejected import. */
function printBlockingFindings(stores: { referencePath: string; visitsPath: string }, releaseId: string): void {
  const store = ReferenceStore.open(stores.referencePath, stores.visitsPath, { readOnly: true });
  try {
    const errors = store.findings(releaseId).findings.filter((f) => f.severity === "error");
    for (const f of errors.slice(0, MAX_PRINTED_ERRORS)) console.error(`  error  ${f.code}  ${f.message}`);
    if (errors.length > MAX_PRINTED_ERRORS)
      console.error(`  ... and ${errors.length - MAX_PRINTED_ERRORS} more; run \`findings --release ${releaseId}\` for all of them.`);
  } finally {
    store.close();
  }
}

/** Runs one command and returns its exit code. Throws UsageError for a command line that cannot be used. */
function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === undefined) throw new UsageError("No command given");
  if (!isCommand(command)) throw new UsageError(`Unknown command "${command}"`);
  const flags: { [name: string]: string | boolean | undefined } = parseCliArgs(rest, COMMANDS[command]);
  if (command === "help") {
    console.log(USAGE);
    return 0;
  }
  const text = (name: string): string | undefined => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);
  const stores = resolveStoreConfig({
    dataDir: text("data-dir"),
    referencePath: text("reference-db") ?? text("reference"),
    visitsPath: text("visits-db") ?? text("visits"),
  });
  const sourceRoot = text("source-root") ?? defaultSourceRoot();
  const fixturePath = text("fixtures");
  const includeCandidate = flags["no-candidate"] !== true;
  const acceptChanged = flags["accept-changed"] === true;
  let exitCode = 0;

  if (command === "import") {
    const outcome = importReference({
      referencePath: stores.referencePath,
      visitsPath: stores.visitsPath,
      sourceRoot,
      fixturePath,
      label: text("label"),
      activate: flags["no-activate"] !== true,
      includeCandidate,
      acceptChanged,
    });
    console.log(`Reference store : ${stores.referencePath}`);
    console.log(`Source root     : ${sourceRoot}`);
    console.log(`Release         : ${outcome.releaseId} (${outcome.status}${outcome.activated ? ", now active" : ", not activated"})`);
    console.log(`Findings        : ${JSON.stringify(outcome.findingCounts)}`);
    console.log(
      `Visit history   : ${outcome.visitsUnchanged === null ? "no visit store present" : outcome.visitsUnchanged ? "unchanged (fingerprint verified)" : "CHANGED - investigate"}`,
    );
    if (outcome.status === "rejected") {
      console.error("The release has blocking findings and was not activated. The previously active release is untouched.");
      printBlockingFindings(stores, outcome.releaseId);
      exitCode = 2;
    }
    if (outcome.visitsUnchanged === false) exitCode = 3;
    return exitCode;
  }
  if (command === "status" || command === "findings") {
    assertSafeReferenceTarget(stores.referencePath, stores.visitsPath);
    const ref = inspectStore(stores.referencePath);
    console.log(`Reference store : ${stores.referencePath} [${ref.kind}]`);
    console.log(`Visit store     : ${stores.visitsPath} [${inspectStore(stores.visitsPath).kind}]`);
    if (ref.kind !== "reference") {
      console.log("No reference store yet. Run `npm run reference:import`.");
      return 0;
    }
    const store = ReferenceStore.open(stores.referencePath, stores.visitsPath, { readOnly: true });
    try {
      const active = store.activeReleaseId();
      const releases = store.listReleases();
      if (command === "status") {
        console.log(`Active release  : ${active ?? "none"}`);
        for (const r of releases) {
          console.log(`  ${r.id}  ${r.status.padEnd(10)} created ${r.createdAt}  findings ${JSON.stringify(r.findingCounts)}`);
        }
      } else {
        // Without --release: the newest release when it was rejected (that is what the user just tried), else the active one.
        const newest = releases[0];
        const id = text("release") ?? (newest?.status === "rejected" ? newest.id : (active ?? newest?.id));
        if (!id) throw new Error("No release to show.");
        console.log(JSON.stringify({ releaseId: id, ...store.findings(id) }, null, 2));
      }
    } finally {
      store.close();
    }
    return 0;
  }
  // reset
  if (flags.yes !== true) {
    console.error(
      "reset rebuilds the reference store from scratch (release history is discarded; visits are never touched). Stop the server first, then re-run with --yes.",
    );
    return 1;
  }
  if (includeCandidate) assertSourceRoot(sourceRoot);
  const before = visitFingerprint(stores.visitsPath, stores.referencePath);
  resetReferenceStore(stores.referencePath, stores.visitsPath, (store) => {
    const staged = buildStagedRelease({ sourceRoot, fixturePath, label: text("label"), includeCandidate, acceptChanged });
    const { id, status } = store.stage(staged.content, staged.findings, staged.stats);
    if (status !== "validated")
      throw new ReferenceStoreError("RELEASE_REJECTED", "The rebuilt release has blocking findings; the existing reference store was left in place.");
    store.activate(id);
  });
  const after = visitFingerprint(stores.visitsPath, stores.referencePath);
  console.log(`Reference store rebuilt: ${stores.referencePath}`);
  console.log(
    `Visit history   : ${before === null ? "no visit store present" : before === after ? "unchanged (fingerprint verified)" : "CHANGED - investigate"}`,
  );
  return before !== null && before !== after ? 3 : 0;
}

/** True when this file is the process entry point, also when it was started through a symlinked path. */
function isEntryPoint(): boolean {
  if (import.meta.main !== undefined) return import.meta.main;
  return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
}

if (isEntryPoint()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n${USAGE}`);
      process.exitCode = 64;
    } else {
      console.error(`${e instanceof ReferenceStoreError ? `${e.code}: ` : ""}${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
}
