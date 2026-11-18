import { describe, expect, it } from "vitest";
import { buildReport } from "../../src/domain/report.ts";
import { contextOf, lookup } from "../../src/domain/resolve.ts";
import { buildIndex, matchesContext } from "../../src/domain/specificity.ts";
import type { ComponentResolution, LookupResult, ReferenceRelease, ReleaseContent } from "../../src/domain/types.ts";
import { fixtureContent, snapshotFor, visitWith } from "../helpers.ts";

// Property checks as plain loops over a seeded PRNG: no new dependency, the same cases on every run.
const ITERATIONS = 200;
const DATE = "2026-11-12";
/** One released tail per fixture variant V01-V10, each resolving on DATE. */
const TAILS = ["N010TL", "N020TL", "N030TL", "N040TL", "N050TL", "N060TL", "N070TL", "N080TL", "N090TL", "N101TL"];

/** mulberry32: a small, fast, seedable 32-bit PRNG. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[int(items.length)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  };
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = int(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  return { next, int, pick, shuffle };
}

/** A release over `content` without hashing it: these checks never store the release. */
const releaseOf = (content: ReleaseContent): ReferenceRelease => ({ ...content, id: "PROP-REL", contentHash: "prop", activatedAt: null });

const sortedComponents = (result: LookupResult): ComponentResolution[] =>
  [...(result.resolution?.components ?? [])].sort((a, b) =>
    a.locationId === b.locationId ? (a.componentId < b.componentId ? -1 : 1) : a.locationId < b.locationId ? -1 : 1,
  );

/** A copy of an id-keyed record with its keys in code-point order, so insertion order cannot show in its JSON. */
const byKey = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const key = (c: { locationId: string; componentId: string }) => `${c.locationId}\u0000${c.componentId}`;

describe("property: unreleased data is inert", () => {
  it(`copying any rule as unreleased changes no outcome and is listed as excluded (${ITERATIONS} cases)`, () => {
    const random = prng(0x2_8001);
    const content = fixtureContent();
    const base = releaseOf(content);
    const baseIndex = buildIndex(base);
    const baseline = new Map(TAILS.map((tail) => [tail, lookup(base, tail, DATE, baseIndex)] as const));
    for (let i = 0; i < ITERATIONS; i += 1) {
      const original = random.pick(content.rules);
      // a tail whose configuration the rule's context accepts, when there is one
      const relevant = TAILS.filter((tail) => {
        const context = baseline.get(tail)?.context;
        return context !== undefined && matchesContext(original.constraint, contextOf(context));
      });
      const tail = random.pick(relevant.length > 0 ? relevant : TAILS);
      const copyId = `${original.id}-UNRELEASED-${i}`;
      const changed = releaseOf({ ...content, rules: [...content.rules, { ...original, id: copyId, released: false }] });
      const before = baseline.get(tail)!;
      const after = lookup(changed, tail, DATE);
      expect(after.state).toBe(before.state);
      const context = before.context!;
      const pairKey = `${context.variant.id}|${context.layoutRevision.id}`;
      const covered = matchesContext(original.constraint, contextOf(context)) ? baseIndex.ruleMatch.get(original.id)?.pairs.get(pairKey) : undefined;
      // every component is compared, and the differences are asserted once: an expect per component costs more than the lookup
      const afterByKey = new Map(after.resolution!.components.map((c) => [key(c), c]));
      const differences: string[] = [];
      for (const c of before.resolution!.components) {
        const now = afterByKey.get(key(c));
        if (!now) {
          differences.push(`${key(c)}: missing after the copy`);
          continue;
        }
        if (now.status !== c.status) differences.push(`${key(c)}: status ${c.status} -> ${now.status}`);
        const ruleBefore = c.status === "RESOLVED" ? c.ruleId : null;
        const ruleAfter = now.status === "RESOLVED" ? now.ruleId : null;
        if (ruleAfter !== ruleBefore) differences.push(`${key(c)}: rule ${ruleBefore} -> ${ruleAfter}`);
        const wasCandidate = c.componentId === original.componentId && (covered?.has(c.locationId) ?? false);
        const listed = (now.excluded ?? []).some((e) => e.ruleId === copyId);
        if (listed !== wasCandidate) differences.push(`${key(c)}: copy listed as excluded ${listed}, expected ${wasCandidate}`);
      }
      expect(differences).toEqual([]);
    }
  });
});

describe("property: lookup does not depend on input order", () => {
  it(`shuffling rules, substitutes, kit lines and locations gives the same result (${ITERATIONS} cases)`, () => {
    const random = prng(0x2_8002);
    const content = fixtureContent();
    const base = releaseOf(content);
    const baseIndex = buildIndex(base);
    const normalise = (result: LookupResult) => ({
      ...result,
      context: result.context && {
        ...result.context,
        layoutRevision: { ...result.context.layoutRevision, locations: [...result.context.layoutRevision.locations].sort((a, b) => (a.id < b.id ? -1 : 1)) },
      },
      resolution: result.resolution && {
        ...result.resolution,
        components: sortedComponents(result),
        rules: byKey(result.resolution.rules),
        sources: byKey(result.resolution.sources),
        componentDefs: byKey(result.resolution.componentDefs),
      },
    });
    // Compared as JSON once the id-keyed records are in key order (every other object is built in code, so its key order is
    // fixed): a deep toEqual of a whole lookup per case costs more than the lookup itself.
    const baseline = new Map(TAILS.map((tail) => [tail, JSON.stringify(normalise(lookup(base, tail, DATE, baseIndex)))] as const));
    for (let i = 0; i < ITERATIONS; i += 1) {
      const shuffled = releaseOf({
        ...content,
        rules: random.shuffle(content.rules),
        substitutes: random.shuffle(content.substitutes),
        kitChildren: random.shuffle(content.kitChildren),
        layoutRevisions: content.layoutRevisions.map((r) => ({ ...r, locations: random.shuffle(r.locations) })),
      });
      const tail = random.pick(TAILS);
      expect(JSON.stringify(normalise(lookup(shuffled, tail, DATE)))).toBe(baseline.get(tail));
    }
  });
});

describe("property: report totals add up", () => {
  it(`every total is the sum of its locations and the totals sum to the record lines (${ITERATIONS} cases)`, () => {
    const random = prng(0x2_8003);
    const snap = snapshotFor(releaseOf(fixtureContent()), "N100TL", DATE);
    const resolved = snap.resolution.components.filter((c) => c.status === "RESOLVED");
    for (let i = 0; i < ITERATIONS; i += 1) {
      const chosen = random.shuffle(resolved).slice(0, 1 + random.int(40));
      const inputs = chosen.map((c) => {
        const rule = snap.resolution.rules[c.ruleId]!;
        const max = snap.resolution.componentDefs[c.componentId]?.maxReplacementsPerLocation ?? 1;
        const alternates = rule.substitutes.filter((s) => s.locationIds === null || s.locationIds.includes(c.locationId));
        const alternate = alternates.length > 0 && random.next() < 0.5 ? random.pick(alternates) : null;
        return {
          locationId: c.locationId,
          componentId: c.componentId,
          selection: alternate ? "ALTERNATE" : "PRIMARY",
          substituteId: alternate?.id ?? null,
          quantity: 1 + random.int(max),
          note: "",
        };
      });
      const visit = visitWith(snap, inputs);
      const report = buildReport(visit, "DRAFT_PREVIEW", "2026-11-12T12:02:00.000Z");
      for (const total of report.totals) expect(total.quantity).toBe(total.locations.reduce((n, l) => n + l.quantity, 0));
      const lineSum = visit.records.reduce((n, r) => n + r.lines.reduce((m, l) => m + l.qty, 0), 0);
      expect(report.totals.reduce((n, t) => n + t.quantity, 0)).toBe(lineSum);
    }
  });
});
