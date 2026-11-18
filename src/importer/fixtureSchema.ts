// Strict schema for fixtures/fixture-data.json (IMP-04). Every object is strict, so an unknown or
// misspelt key is an error instead of being silently ignored. Cross-references between parts of the
// file (override keys, omitted seats, exit and ELR rows, seat-spec names) are checked by `fixtureReferenceIssues` in
// fixtures.ts, which knows how the builder expands the data.
import { z } from "zod";
import { isIsoDate } from "../domain/dates.ts";
import { MAX_QTY } from "../domain/limits.ts";
import {
  ComponentDefSchema,
  ContextConstraintSchema,
  LocationSelectorSchema,
  MelEntrySchema,
  PendingChangeSchema,
  VocabularySchema,
} from "../domain/schema.ts";

const isoDate = z.string().refine(isIsoDate, "Not a real calendar date written as YYYY-MM-DD.");
const quantity = z.number().int().min(1).max(MAX_QTY);
const row = z.number().int().min(1);

const SeatSpecSchema = z
  .object({
    rows: row,
    omit: z.array(z.string()),
    exitRows: z.array(row),
    elrRows: z.array(row),
    /** Bin module lengths in rows, forward to aft, per side; each list sums to `rows` (checked by `fixtureReferenceIssues`). */
    binModules: z
      .object({
        note: z.string(),
        L: z.array(z.number().int().min(1)).min(1),
        R: z.array(z.number().int().min(1)).min(1),
      })
      .strict(),
  })
  .strict();

export const FixtureDataSchema = z
  .object({
    note: z.string(),
    vocabulary: VocabularySchema,
    sources: z.array(
      z
        .object({
          id: z.string(),
          kind: z.string(),
          revision: z.string(),
          title: z.string(),
          effectiveFrom: isoDate.nullable(),
          expiresOn: isoDate.nullable(),
          released: z.boolean(),
        })
        .strict(),
    ),
    subtypes: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
    seatSpecs: z.record(z.string(), SeatSpecSchema),
    variants: z.array(
      z
        .object({
          id: z.string(),
          subtype: z.string(),
          hardware: z.string().nullable(),
          elr: z.string().nullable(),
          layoutNote: z.string().nullable(),
          power: z.boolean().nullable(),
          cabinHeight: z.string().nullable(),
          statusNote: z.string(),
          seatSpec: z.string().nullable(),
          /** Bin type of the variant's cabin; null only for a variant with no seat spec. */
          binType: z.enum(["CLASSIC", "PIVOT", "LARGE_PIVOT"]).nullable(),
          released: z.boolean(),
        })
        .strict(),
    ),
    aircraft: z.array(z.object({ tail: z.string(), subtype: z.string(), note: z.string() }).strict()),
    assignments: z.array(
      z
        .object({
          tail: z.string(),
          variant: z.string(),
          carpet: z.string().nullable(),
          seam: z.string().nullable(),
          from: isoDate,
          to: isoDate.nullable(),
          source: z.string(),
          status: z.literal("planned").optional(),
        })
        .strict(),
    ),
    components: z.array(ComponentDefSchema),
    seatRuleSource: z.string(),
    carpetRuleSource: z.string(),
    ruleEffectiveFrom: isoDate,
    partOverrides: z.record(z.string(), z.string()),
    variantOmissions: z.record(
      z.string(),
      z
        .object({
          noBinRules: z.boolean().optional(),
          backrestExitSource: z.string().optional(),
          aftPanelUnreleased: z.boolean().optional(),
        })
        .strict(),
    ),
    extraParts: z.array(z.object({ partNo: z.string(), description: z.string() }).strict()),
    extraRules: z.array(
      z
        .object({
          id: z.string(),
          componentId: z.string(),
          partNo: z.string(),
          qtyPerReplacement: quantity,
          unit: z.string(),
          constraint: ContextConstraintSchema,
          locations: LocationSelectorSchema,
          effectiveFrom: isoDate,
          effectiveTo: isoDate.nullable().optional(),
          source: z.string(),
          released: z.boolean(),
          note: z.string().optional(),
        })
        .strict(),
    ),
    pendingChanges: z.array(PendingChangeSchema),
    substitutes: z.array(
      z
        .object({
          id: z.string(),
          componentId: z.string(),
          primaryPartNo: z.string(),
          altPartNo: z.string(),
          qtyPerReplacement: quantity,
          unit: z.string(),
          constraint: ContextConstraintSchema,
          locations: LocationSelectorSchema.optional(),
          effectiveFrom: isoDate,
          effectiveTo: isoDate.nullable(),
          source: z.string(),
          released: z.boolean(),
          note: z.string().optional(),
        })
        .strict(),
    ),
    kitChildren: z.array(z.object({ parentPartNo: z.string(), childPartNo: z.string(), qty: quantity, unit: z.string(), source: z.string() }).strict()),
    /** Fictional minimum equipment list, copied into the release as is. */
    mel: z.array(MelEntrySchema),
  })
  .strict();

export type FixtureData = z.infer<typeof FixtureDataSchema>;
export type SeatSpec = z.infer<typeof SeatSpecSchema>;

/** The fixture file cannot be used. `issues` holds one `path: message` line per problem. */
export class FixtureError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`The fixture file is invalid: ${issues.length} problem${issues.length === 1 ? "" : "s"}. First: ${issues[0] ?? "unknown"}`);
    this.name = "FixtureError";
    this.issues = issues;
  }
}

/** Parsed fixture JSON checked against the schema; on failure, one `path: message` line per problem. */
export function parseFixtureData(json: unknown): { data: FixtureData; issues: [] } | { data: null; issues: string[] } {
  const parsed = FixtureDataSchema.safeParse(json);
  if (parsed.success) return { data: parsed.data, issues: [] };
  return { data: null, issues: parsed.error.issues.map((issue) => `${issue.path.map(String).join(".") || "fixture"}: ${issue.message}`) };
}
