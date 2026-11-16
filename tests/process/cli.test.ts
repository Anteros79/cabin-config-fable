import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { defaultSourceRoot } from "../../src/importer/assemble.ts";
import { DATA_ORIGINALS, ORIGINAL_FILES } from "../../src/importer/originals.ts";
import { PROJECT_ROOT } from "../../src/server/config.ts";
import { ReferenceStore } from "../../src/server/referenceStore.ts";
import { cleanupTempDirs, tempDir } from "../helpers.ts";

afterAll(cleanupTempDirs);

const CLI = join(PROJECT_ROOT, "src", "importer", "cli.ts");

/** The parent environment without any CABIN_KIT_* variable, so a child never sees ./data or a developer's settings. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("CABIN_KIT_")) env[key] = value;
  return { ...env, ...extra };
}

interface Exit {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(cliPath: string, args: string[], dataDir: string): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env: cleanEnv({ CABIN_KIT_DATA_DIR: dataDir }), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A temp data dir that already holds an imported reference store. */
async function importedStore(): Promise<{ dataDir: string; referencePath: string; run: (args: string[]) => Promise<Exit> }> {
  const dataDir = tempDir("cabin-kit-cli-");
  const run = (args: string[]) => runCli(CLI, args, dataDir);
  const first = await run(["import"]);
  expect(first.code).toBe(0);
  return { dataDir, referencePath: join(dataDir, "reference.sqlite"), run };
}

describe("importer CLI", () => {
  test("reset --yes with a mistyped path option exits 64 and rebuilds nothing", async () => {
    const { referencePath, run } = await importedStore();
    const otherDir = join(tempDir("cabin-kit-cli-other-"), "other");
    const before = sha256File(referencePath);
    const r = await run(["reset", "--yes", "--data-dirr", otherDir]);
    expect(r.code).toBe(64);
    expect(r.stderr).toContain("Unknown option");
    expect(r.stderr).toContain("Usage:");
    expect(sha256File(referencePath)).toBe(before);
    expect(existsSync(otherDir)).toBe(false);
  });

  test("reset --yes --data-dir=<other> rebuilds <other>, not the default", async () => {
    const { referencePath, run } = await importedStore();
    const otherDir = join(tempDir("cabin-kit-cli-other-"), "other");
    mkdirSync(otherDir);
    const before = sha256File(referencePath);
    const r = await run(["reset", "--yes", `--data-dir=${otherDir}`]);
    expect(r.code).toBe(0);
    expect(existsSync(join(otherDir, "reference.sqlite"))).toBe(true);
    expect(sha256File(referencePath)).toBe(before);
  });

  test("import --no-activte exits 64 and stages nothing", async () => {
    const dataDir = tempDir("cabin-kit-cli-");
    const r = await runCli(CLI, ["import", "--no-activte"], dataDir);
    expect(r.code).toBe(64);
    expect(existsSync(join(dataDir, "reference.sqlite"))).toBe(false);
  });

  test("a string option without a value exits 64", async () => {
    const dataDir = tempDir("cabin-kit-cli-");
    const r = await runCli(CLI, ["reset", "--data-dir", "--yes"], dataDir);
    expect(r.code).toBe(64);
    expect(r.stderr).toContain("--data-dir needs a value");
  });

  test("unknown command and no command exit 64; help exits 0", async () => {
    const dataDir = tempDir("cabin-kit-cli-");
    const unknown = await runCli(CLI, ["frobnicate"], dataDir);
    expect(unknown.code).toBe(64);
    expect(unknown.stderr).toContain('Unknown command "frobnicate"');
    const none = await runCli(CLI, [], dataDir);
    expect(none.code).toBe(64);
    expect(none.stderr).toContain("Usage:");
    const help = await runCli(CLI, ["help"], dataDir);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage:");
    const helpWithOption = await runCli(CLI, ["help", "--yes"], dataDir);
    expect(helpWithOption.code).toBe(64);
  });

  test("an option that belongs to another command exits 64", async () => {
    const { run } = await importedStore();
    const r = await run(["status", "--yes"]);
    expect(r.code).toBe(64);
  });

  test("reset without --yes leaves the file byte-identical and exits 1", async () => {
    const { referencePath, run } = await importedStore();
    const before = sha256File(referencePath);
    const r = await run(["reset"]);
    expect(r.code).toBe(1);
    expect(sha256File(referencePath)).toBe(before);
  });

  test("the CLI works when invoked through a symlinked project path", async () => {
    const linkDir = tempDir("cabin-kit-link-");
    const link = join(linkDir, "project");
    symlinkSync(PROJECT_ROOT, link, "dir");
    const { dataDir } = await importedStore();
    const r = await runCli(join(link, "src", "importer", "cli.ts"), ["status"], dataDir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Active release");
  });

  test("a rejected import exits 2 and prints the blocking findings", async () => {
    const dataDir = tempDir("cabin-kit-cli-");
    const fixtures = JSON.parse(readFileSync(join(PROJECT_ROOT, "fixtures", "fixture-data.json"), "utf8"));
    const bad = join(tempDir("cabin-kit-cli-fx-"), "fixture-data.json");
    fixtures.extraRules[0].partNo = "NO-SUCH-PART";
    writeFileSync(bad, JSON.stringify(fixtures));
    const r = await runCli(CLI, ["import", "--fixtures", bad], dataDir);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/error\s+\S+/);
    expect(r.stderr).not.toContain("Run `findings`");
    // findings with no --release shows the newest release, which is the rejected one.
    const shown = await runCli(CLI, ["findings"], dataDir);
    expect(shown.code).toBe(0);
    const store = ReferenceStore.open(join(dataDir, "reference.sqlite"), join(dataDir, "visits.sqlite"), { readOnly: true });
    const newest = store.listReleases()[0]?.id;
    store.close();
    expect(shown.stdout).toContain(String(newest));
  });

  test("a changed original is rejected (exit 2); --accept-changed stages it with a warning (exit 0)", async () => {
    const root = tempDir("cabin-kit-cli-src-");
    for (const file of DATA_ORIGINALS) cpSync(join(defaultSourceRoot(), file), join(root, file));
    writeFileSync(join(root, ORIGINAL_FILES.rtf), "");
    const rejected = await runCli(CLI, ["import", "--source-root", root], tempDir("cabin-kit-cli-"));
    expect(rejected.code).toBe(2);
    expect(rejected.stderr).toContain("SOURCE_HASH_CHANGED");
    const accepted = await runCli(CLI, ["import", "--source-root", root, "--accept-changed"], tempDir("cabin-kit-cli-"));
    expect(accepted.code).toBe(0);
    expect(accepted.stdout).toMatch(/validated, now active/);
    expect(accepted.stdout).toMatch(/"warning":1/);
  });

  test("a non-existent --source-root exits 1 and creates no store file", async () => {
    const dataDir = tempDir("cabin-kit-cli-");
    const r = await runCli(CLI, ["import", "--source-root", join(dataDir, "no-such-root")], dataDir);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Source root is not a directory/);
    expect(readdirSync(dataDir)).toEqual([]);
  });
});
