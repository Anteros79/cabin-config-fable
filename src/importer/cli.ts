import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolveStoreConfig } from "../server/config.ts";
import { assertSafeReferenceTarget, inspectStore, ReferenceStore, ReferenceStoreError, resetReferenceStore } from "../server/referenceStore.ts";
import { VisitStore } from "../server/visitStore.ts";
import { buildStagedRelease, defaultSourceRoot } from "./assemble.ts";

/**
 * Reference data CLI. It only ever writes the reference store; the visit store is opened
 * (when it already exists) solely to prove its history is unchanged.
 *
 *   node src/importer/cli.ts import  [--source-root DIR] [--data-dir DIR] [--reference FILE] [--visits FILE] [--label TEXT] [--no-activate]
 *   node src/importer/cli.ts status  [--data-dir DIR] [--reference FILE] [--visits FILE]
 *   node src/importer/cli.ts findings [--release ID]
 *   node src/importer/cli.ts reset --yes [same path options]
 */
function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let arg = rest.shift(); arg !== undefined; arg = rest.shift()) {
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument "${arg}"`);
    const name = arg.slice(2);
    const next = rest[0];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      rest.shift();
    } else flags[name] = true;
  }
  return { command, flags };
}

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
  label?: string;
  activate?: boolean;
  includeCandidate?: boolean;
}): ImportOutcome {
  assertSafeReferenceTarget(options.referencePath, options.visitsPath);
  const before = visitFingerprint(options.visitsPath, options.referencePath);
  const store = ReferenceStore.openOrCreate(options.referencePath, options.visitsPath);
  try {
    const staged = buildStagedRelease({ sourceRoot: options.sourceRoot, label: options.label, includeCandidate: options.includeCandidate });
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

function main(): void {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const stores = resolveStoreConfig({
    dataDir: typeof flags["data-dir"] === "string" ? flags["data-dir"] : undefined,
    referencePath: typeof flags.reference === "string" ? flags.reference : undefined,
    visitsPath: typeof flags.visits === "string" ? flags.visits : undefined,
  });
  const sourceRoot = typeof flags["source-root"] === "string" ? flags["source-root"] : defaultSourceRoot();

  if (command === "import") {
    const outcome = importReference({
      referencePath: stores.referencePath,
      visitsPath: stores.visitsPath,
      sourceRoot,
      label: typeof flags.label === "string" ? flags.label : undefined,
      activate: flags["no-activate"] !== true,
    });
    console.log(`Reference store : ${stores.referencePath}`);
    console.log(`Source root     : ${sourceRoot}`);
    console.log(`Release         : ${outcome.releaseId} (${outcome.status}${outcome.activated ? ", now active" : ", not activated"})`);
    console.log(`Findings        : ${JSON.stringify(outcome.findingCounts)}`);
    console.log(
      `Visit history   : ${outcome.visitsUnchanged === null ? "no visit store present" : outcome.visitsUnchanged ? "unchanged (fingerprint verified)" : "CHANGED - investigate"}`,
    );
    if (outcome.status === "rejected") {
      console.error("The release has blocking findings and was not activated. Run `findings` to see them. The previously active release is untouched.");
      process.exitCode = 2;
    }
    if (outcome.visitsUnchanged === false) process.exitCode = 3;
    return;
  }
  if (command === "status" || command === "findings") {
    assertSafeReferenceTarget(stores.referencePath, stores.visitsPath);
    const ref = inspectStore(stores.referencePath);
    console.log(`Reference store : ${stores.referencePath} [${ref.kind}]`);
    console.log(`Visit store     : ${stores.visitsPath} [${inspectStore(stores.visitsPath).kind}]`);
    if (ref.kind !== "reference") {
      console.log("No reference store yet. Run `npm run reference:import`.");
      return;
    }
    const store = ReferenceStore.open(stores.referencePath, stores.visitsPath, { readOnly: true });
    try {
      const active = store.activeReleaseId();
      if (command === "status") {
        console.log(`Active release  : ${active ?? "none"}`);
        for (const r of store.listReleases()) {
          console.log(`  ${r.id}  ${r.status.padEnd(10)} created ${r.createdAt}  findings ${JSON.stringify(r.findingCounts)}`);
        }
      } else {
        const id = typeof flags.release === "string" ? flags.release : active;
        if (!id) throw new Error("No release to show.");
        console.log(JSON.stringify({ releaseId: id, ...store.findings(id) }, null, 2));
      }
    } finally {
      store.close();
    }
    return;
  }
  if (command === "reset") {
    if (flags.yes !== true) {
      console.error(
        "reset rebuilds the reference store from scratch (release history is discarded; visits are never touched). Stop the server first, then re-run with --yes.",
      );
      process.exitCode = 1;
      return;
    }
    const before = visitFingerprint(stores.visitsPath, stores.referencePath);
    resetReferenceStore(stores.referencePath, stores.visitsPath, (store) => {
      const staged = buildStagedRelease({ sourceRoot });
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
    if (before !== null && before !== after) process.exitCode = 3;
    return;
  }
  console.log("Usage: node src/importer/cli.ts <import|status|findings|reset> [options]. See the header of src/importer/cli.ts.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(`${e instanceof ReferenceStoreError ? `${e.code}: ` : ""}${(e as Error).message}`);
    process.exitCode = 1;
  }
}
