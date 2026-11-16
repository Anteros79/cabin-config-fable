import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test, vi } from "vitest";
import { lookup } from "../../src/domain/resolve.ts";
import { buildSnapshot } from "../../src/domain/visitLogic.ts";
import { importReference } from "../../src/importer/cli.ts";
import { DATA_ORIGINALS, IMAGE_ORIGINALS } from "../../src/importer/originals.ts";
import { PROJECT_ROOT } from "../../src/server/config.ts";
import { ReferenceStore } from "../../src/server/referenceStore.ts";
import { VisitStore } from "../../src/server/visitStore.ts";
import { DEFAULT_PATHS, type VerifyPaths, main as verifyMain } from "../../tools/verify-originals.ts";
import { cleanupTempDirs, stagedFull, tempDir } from "../helpers.ts";

afterAll(cleanupTempDirs);

interface Exit {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runNode(args: string[], env: Record<string, string> = {}): Promise<Exit> {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("CABIN_KIT_")) clean[key] = value;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT, env: { ...clean, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Runs the verify tool in-process against a private set of folders and returns what it printed. */
function verify(paths: VerifyPaths, argv: string[] = []): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = verifyMain(
    argv,
    paths,
    (l) => out.push(l),
    (l) => err.push(l),
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

interface Workspace extends VerifyPaths {
  manifest: { recordedAt: string; files: { path: string; bytes: number; sha256: string }[] };
}

/** Private copies of the vendored data originals and the manifest; the real ones are never touched. */
function workspace(): Workspace {
  const dir = tempDir("cabin-kit-verify-");
  const vendoredRoot = join(dir, "vendored");
  mkdirSync(vendoredRoot);
  for (const name of DATA_ORIGINALS) cpSync(join(DEFAULT_PATHS.vendoredRoot, name), join(vendoredRoot, name));
  const manifest = JSON.parse(readFileSync(DEFAULT_PATHS.manifestPath, "utf8"));
  const manifestPath = join(dir, "originals-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  // No image folder: the images are reported as skipped.
  return { vendoredRoot, sourceRoot: join(dir, "no-such-folder"), manifestPath, manifest };
}

describe("verify-originals", () => {
  test("passes on the vendored data originals and skips the images that are not present", () => {
    const ws = workspace();
    const r = verify(ws);
    expect(r.code).toBe(0);
    expect(r.out).toContain("skipped (not present)");
    expect(r.out).toContain(`${IMAGE_ORIGINALS.length} skipped`);
  });

  test("an image is skipped, not failed, when the source root is the vendored data folder", () => {
    const ws = workspace();
    expect(verify({ ...ws, sourceRoot: ws.vendoredRoot }).code).toBe(0);
  });

  test("fails on an empty manifest", () => {
    const ws = workspace();
    writeFileSync(ws.manifestPath, JSON.stringify({ recordedAt: "x", files: [] }));
    const r = verify(ws);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/lists no files/);
  });

  test("fails when an original is missing from the manifest", () => {
    const ws = workspace();
    const dropped = DATA_ORIGINALS[0] as string;
    writeFileSync(ws.manifestPath, JSON.stringify({ ...ws.manifest, files: ws.manifest.files.filter((f) => f.path !== dropped) }));
    const r = verify(ws);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`NOT IN MANIFEST  ${dropped}`);
  });

  test("fails when a data original is missing on disk, and when one differs", () => {
    const ws = workspace();
    const [first, second] = DATA_ORIGINALS as [string, string];
    writeFileSync(join(ws.vendoredRoot, second), "changed");
    const changed = verify(ws);
    expect(changed.code).toBe(1);
    expect(changed.out).toContain(`CHANGED    vendored`);
    writeFileSync(join(ws.vendoredRoot, second), readFileSync(join(DEFAULT_PATHS.vendoredRoot, second)));
    // Remove the file by pointing the vendored root at a folder without it.
    const partial = join(tempDir("cabin-kit-verify-"), "partial");
    mkdirSync(partial);
    for (const name of DATA_ORIGINALS) if (name !== first) cpSync(join(ws.vendoredRoot, name), join(partial, name));
    const missing = verify({ ...ws, vendoredRoot: partial });
    expect(missing.code).toBe(1);
    expect(missing.out).toContain(`MISSING    vendored`);
  });

  test("a folder that exists but holds none of the originals counts as absent: images skipped, exit 0", () => {
    const ws = workspace();
    const unrelated = join(tempDir("cabin-kit-verify-"), "work");
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, "something-else.txt"), "not an original");
    const r = verify({ ...ws, sourceRoot: unrelated });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${IMAGE_ORIGINALS.length} skipped`);
  });

  test("a source root named explicitly must hold every original, even when it holds none", () => {
    const ws = workspace();
    const named = join(tempDir("cabin-kit-verify-"), "named");
    mkdirSync(named);
    const r = verify({ ...ws, sourceRoot: named, sourceRootExplicit: true });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`MISSING    source    `);
  });

  test("a folder holding some originals must hold all of them: the absent images fail, by name", () => {
    const ws = workspace();
    const some = join(tempDir("cabin-kit-verify-"), "some");
    mkdirSync(some);
    const [present] = IMAGE_ORIGINALS as [string];
    writeFileSync(join(some, present), "an image");
    const r = verify({ ...ws, sourceRoot: some });
    expect(r.code).toBe(1);
    for (const name of IMAGE_ORIGINALS.slice(1)) expect(r.out).toMatch(new RegExp(`MISSING .* ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  });

  test("--write refuses when a file is missing, and refuses to overwrite without --force", () => {
    const ws = workspace();
    const target = join(tempDir("cabin-kit-verify-"), "evidence", "originals-manifest.json");
    const incomplete = verify({ ...ws, sourceRoot: ws.vendoredRoot, manifestPath: target }, ["--write"]);
    expect(incomplete.code).toBe(1);
    expect(incomplete.err).toMatch(/missing from/);
    expect(existsSync(target)).toBe(false);

    // A complete source folder: data and images (the content is irrelevant to the check).
    const complete = join(tempDir("cabin-kit-verify-"), "all");
    mkdirSync(complete);
    for (const name of [...DATA_ORIGINALS, ...IMAGE_ORIGINALS]) writeFileSync(join(complete, name), `bytes of ${name}`);
    const paths = { ...ws, sourceRoot: complete, manifestPath: target };
    const written = verify(paths, ["--write"]);
    expect(written.code).toBe(0);
    const text = readFileSync(target, "utf8");
    expect(JSON.parse(text).files).toHaveLength(DATA_ORIGINALS.length + IMAGE_ORIGINALS.length);

    const again = verify(paths, ["--write"]);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/--force/);
    expect(readFileSync(target, "utf8")).toBe(text);
    expect(verify(paths, ["--write", "--force"]).code).toBe(0);
  });

  test("--write refuses when the source folder is absent", () => {
    const ws = workspace();
    expect(verify({ ...ws, manifestPath: join(tempDir("cabin-kit-verify-"), "m.json") }, ["--write"]).code).toBe(1);
  });

  test("an unknown option exits 64; importing the module runs nothing", () => {
    const ws = workspace();
    expect(verify(ws, ["--nope"]).code).toBe(64);
    expect(verify(ws, ["--force"]).code).toBe(64);
  });

  test("importing the module runs nothing: no output, no exit code, no files", () => {
    const written: string[] = [];
    const before = process.exitCode;
    const spy = vi.spyOn(console, "log").mockImplementation((line) => void written.push(String(line)));
    try {
      expect(typeof verifyMain).toBe("function");
      expect(written).toEqual([]);
      expect(process.exitCode).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });

  test("the real manifest verifies from the command line", async () => {
    const r = await runNode(["tools/verify-originals.ts"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\d+\/\d+ checks unchanged/);
  });
});

/** Fake bytes for every original, and a manifest of them: the hashes are all the tool compares. */
function fakeOriginals(): { bytes: Map<string, string>; manifest: string } {
  const bytes = new Map([...DATA_ORIGINALS, ...IMAGE_ORIGINALS].map((name) => [name, `fake bytes of ${name}`]));
  const files = [...bytes].map(([path, text]) => ({ path, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") }));
  return { bytes, manifest: JSON.stringify({ recordedAt: "2026-11-15T00:00:00.000Z", files }) };
}

/**
 * A copy of the tool at <tmp>/work/checkout/project, as a clone sits on a CI runner, so that the tool's own `../..`
 * (the default image and source root) is <tmp>/work, a folder that exists and holds only what `outer` puts there.
 */
function toolCopyUnder(outer: (work: string, bytes: Map<string, string>) => void): string {
  const work = join(tempDir("cabin-kit-verify-clone-"), "work");
  const project = join(work, "checkout", "project");
  for (const dir of ["tools", join("src", "importer"), join("fixtures", "originals"), "evidence"]) mkdirSync(join(project, dir), { recursive: true });
  for (const file of [join("tools", "verify-originals.ts"), join("src", "importer", "args.ts"), join("src", "importer", "originals.ts")])
    cpSync(join(PROJECT_ROOT, file), join(project, file));
  writeFileSync(join(project, "package.json"), JSON.stringify({ type: "module" }));
  const { bytes, manifest } = fakeOriginals();
  for (const name of DATA_ORIGINALS) writeFileSync(join(project, "fixtures", "originals", name), bytes.get(name) as string);
  writeFileSync(join(project, "evidence", "originals-manifest.json"), manifest);
  writeFileSync(join(work, "unrelated.txt"), "a runner's work folder holds other things");
  outer(work, bytes);
  return join(project, "tools", "verify-originals.ts");
}

describe("verify-originals from a clone outside the development folder (Task 6.6 ruling)", () => {
  test("all originals in ../..: every copy is verified, nothing skipped", async () => {
    const tool = toolCopyUnder((work, bytes) => {
      for (const [name, text] of bytes) writeFileSync(join(work, name), text);
    });
    const r = await runNode([tool]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${2 * DATA_ORIGINALS.length + IMAGE_ORIGINALS.length}/${2 * DATA_ORIGINALS.length + IMAGE_ORIGINALS.length} checks unchanged`);
    expect(r.stdout).toContain(" 0 skipped");
  });

  test("none in ../.. (it exists, as /home/runner/work does): the images are skipped and it passes", async () => {
    const tool = toolCopyUnder(() => {});
    const r = await runNode([tool]);
    expect(r.code).toBe(0);
    const work = join(tool, "..", "..", "..", "..");
    expect(r.stdout).toContain(
      `source root ${realpathSync(work)} holds no originals; images and source copies not checked (set CABIN_KIT_SOURCE_ROOT to require them)`,
    );
    expect(r.stdout).toContain(`${DATA_ORIGINALS.length}/${DATA_ORIGINALS.length} checks unchanged`);
    expect(r.stdout).toContain(`${IMAGE_ORIGINALS.length} skipped (not present)`);
  });

  test("some in ../..: it fails and names every missing file", async () => {
    const [kept] = IMAGE_ORIGINALS as [string];
    const tool = toolCopyUnder((work, bytes) => writeFileSync(join(work, kept), bytes.get(kept) as string));
    const r = await runNode([tool]);
    expect(r.code).toBe(1);
    const missing = r.stdout.split("\n").filter((line) => line.startsWith("MISSING"));
    for (const name of [...DATA_ORIGINALS, ...IMAGE_ORIGINALS.slice(1)])
      expect(
        missing.some((line) => line.endsWith(`  ${name}`)),
        name,
      ).toBe(true);
    expect(missing.some((line) => line.endsWith(`  ${kept}`))).toBe(false);
  });

  test("CABIN_KIT_SOURCE_ROOT naming a folder without the originals fails", async () => {
    const empty = tempDir("cabin-kit-verify-empty-");
    const tool = toolCopyUnder(() => {});
    const r = await runNode([tool], { CABIN_KIT_SOURCE_ROOT: empty });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^MISSING +source/m);
  });
});

describe("seed-sample-visits", () => {
  const seed = (dataDir: string, env: Record<string, string> = {}) => runNode(["tools/seed-sample-visits.ts", "--data-dir", dataDir], env);

  test("seeding twice adds nothing; the completed sample has the six README totals", async () => {
    const dir = tempDir("cabin-kit-seed-");
    const first = await seed(dir);
    expect(first.code).toBe(0);
    const totals = /Completed sample visit #1: (.*)/.exec(first.stdout)?.[1]?.split(", ");
    expect(totals).toHaveLength(6);
    expect(first.stdout).toContain("Draft sample visit #2 left open with 2 records.");

    const second = await seed(dir);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("already has visits");
    const store = VisitStore.open(join(dir, "visits.sqlite"), join(dir, "reference.sqlite"));
    try {
      expect(store.counts()).toMatchObject({ visits: 2, drafts: 1, completed: 1 });
    } finally {
      store.close();
    }
  });

  test("seeding against a rejected import exits non-zero with one line, no stack trace", async () => {
    const dir = tempDir("cabin-kit-seed-");
    const emptyRoot = tempDir("cabin-kit-seed-root-");
    const r = await seed(dir, { CABIN_KIT_SOURCE_ROOT: emptyRoot });
    expect(r.code).toBe(1);
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(r.stderr).toMatch(/rejected/);
    expect(r.stderr).not.toMatch(/\n\s+at /);
    expect(existsSync(join(dir, "visits.sqlite"))).toBe(false);
  });

  test("a store with exactly one sample visit from a failed run is reported, not called 'already has visits'", async () => {
    const dir = tempDir("cabin-kit-seed-");
    const referencePath = join(dir, "reference.sqlite");
    const visitsPath = join(dir, "visits.sqlite");
    // Simulate a run that stopped after the first visit: the store holds the completed sample and nothing else.
    expect(importReference({ referencePath, visitsPath }).status).toBe("validated");
    const reference = ReferenceStore.open(referencePath, visitsPath, { readOnly: true });
    const release = reference.loadActive();
    reference.close();
    const store = VisitStore.open(visitsPath, referencePath);
    try {
      store.createVisit(buildSnapshot(release, lookup(release, "N100TL", "2026-11-12"), new Date().toISOString()), "Sample Technician (fictional)");
    } finally {
      store.close();
    }
    const r = await seed(dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/incomplete sample/);
    expect(r.stdout).not.toMatch(/already has visits/);
  });

  test("a completed sample and a draft with fewer than 2 records is also reported as incomplete", async () => {
    const dir = tempDir("cabin-kit-seed-");
    const referencePath = join(dir, "reference.sqlite");
    const visitsPath = join(dir, "visits.sqlite");
    expect(importReference({ referencePath, visitsPath }).status).toBe("validated");
    const reference = ReferenceStore.open(referencePath, visitsPath, { readOnly: true });
    const release = reference.loadActive();
    reference.close();
    const store = VisitStore.open(visitsPath, referencePath);
    try {
      const now = new Date().toISOString();
      store.createVisit(buildSnapshot(release, lookup(release, "N100TL", "2026-11-12"), now), "Sample Technician (fictional)");
      const draft = store.createVisit(buildSnapshot(release, lookup(release, "N200TL", "2026-07-01"), now), "Sample Technician (fictional)").visit;
      store.upsertRecord(draft.id, { locationId: "SEAT:12C", componentId: "BACKREST", selection: "PRIMARY", substituteId: null, quantity: 1, note: "" }, 0);
    } finally {
      store.close();
    }
    const r = await seed(dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/incomplete sample/);
    expect(r.stderr).toContain(visitsPath);
  });

  test("a bad option exits 64", async () => {
    const r = await runNode(["tools/seed-sample-visits.ts", "--nope"]);
    expect(r.code).toBe(64);
  });
});

describe("evidence:build", () => {
  const build = (...args: string[]) => runNode(["tools/evidence/build-all.mjs", ...args]);

  test("a subset that omits a dependency names the missing step and stops before writing", async () => {
    const r = await build("hyperlinks");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/step "hyperlinks" needs the result of "docx", "rtf"/);
    expect(r.stdout).not.toContain("source root");
  });

  test("an unknown step or option is a usage error", async () => {
    expect((await build("nope")).code).toBe(64);
    expect((await build("--nope")).code).toBe(64);
  });

  test("every step's ctx.results reads are in its needs", () => {
    const dir = join(PROJECT_ROOT, "tools", "evidence");
    const stepsSource = readFileSync(join(dir, "build-all.mjs"), "utf8");
    const rows = [...stepsSource.matchAll(/name: '(\w+)',\s*path: '\.\/(step-[\w-]+\.mjs)',\s*needs: \[([^\]]*)\]/g)];
    expect(rows).toHaveLength(13);
    for (const [, name, file, needsText] of rows) {
      const source = readFileSync(join(dir, file as string), "utf8");
      const reads = new Set<string>([...source.matchAll(/ctx\.results\.(\w+)/g)].map((m) => m[1] as string));
      for (const m of source.matchAll(/const \{([^}]+)\}\s*=\s*ctx\.results/g))
        for (const part of (m[1] as string).split(",")) reads.add((part.split(":")[0] as string).trim());
      const needs = new Set([...(needsText as string).matchAll(/'(\w+)'/g)].map((m) => m[1]));
      for (const read of reads) expect(needs.has(read), `${name} reads ctx.results.${read} but does not list it in needs`).toBe(true);
    }
  });

  test("every declared dependency is itself a step that runs earlier", async () => {
    const mod = await import(pathToFileURL(join(PROJECT_ROOT, "tools", "evidence", "build-all.mjs")).href);
    const seen = new Set<string>();
    for (const step of mod.STEPS as { name: string; needs: string[] }[]) {
      for (const need of step.needs) expect(seen.has(need), `${step.name} needs ${need}, which must run first`).toBe(true);
      seen.add(step.name);
    }
    expect(mod.planSteps([])).toBe(mod.STEPS);
    expect(() => mod.planSteps(["docx", "rtf", "hyperlinks"])).not.toThrow();
  });

  test.each([
    "127.0.0.1",
    "127.9.9.9",
    "169.254.1.1",
    "0.0.0.0",
    "[::1]",
    "[fe80::1]",
    "[fc00::1]",
    "10.0.0.5",
    "192.168.1.1",
    "172.16.0.1",
    "8.8.8.8",
    "localhost",
    "app.localhost",
  ])("link check refuses private host %s", async (host) => {
    const mod = await import(pathToFileURL(join(PROJECT_ROOT, "tools", "evidence", "step-docx.mjs")).href);
    expect(mod.classifyUrl(`http://${host}/path`).access_class).not.toBe("public");
  });

  test("a named public host is still public", async () => {
    const mod = await import(pathToFileURL(join(PROJECT_ROOT, "tools", "evidence", "step-docx.mjs")).href);
    expect(mod.classifyUrl("https://www.example.com/x").access_class).toBe("public");
  });
});

describe("candidate seats", () => {
  test("candidate seats have no component ids", () => {
    const seats = stagedFull()
      .content.layoutRevisions.filter((r) => r.namespace === "candidate")
      .flatMap((r) => r.locations.filter((l) => l.kind === "SEAT"));
    expect(seats.length).toBeGreaterThan(0);
    for (const seat of seats) expect(seat.componentIds).toEqual([]);
  });
});

describe("make-image-previews names", () => {
  test("every preview in the manifest keeps its source extension in the name", () => {
    const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, "evidence", "image-previews", "manifest.json"), "utf8")) as {
      images: { original: string; previews: { file: string }[] }[];
    };
    for (const image of manifest.images) {
      for (const preview of image.previews) {
        expect(preview.file.split("/")[1]?.startsWith(`${image.original}.`)).toBe(true);
        expect(existsSync(join(PROJECT_ROOT, "evidence", "image-previews", preview.file))).toBe(true);
      }
    }
  });
});
