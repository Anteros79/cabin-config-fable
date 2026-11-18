// Structural schema for reference release content (DOM-02, DOM-05, DOM-09, DOM-12, DOM-13, DOM-14).
// Every object is strict, so a misspelt selector or constraint key is an error instead of a
// silently ignored (and therefore broadening) restriction. Semantic checks live in validate.ts.
import { z } from "zod";
import { isIsoDate } from "./dates.ts";
import { MAX_QTY, MAX_REPLACEMENTS_PER_LOCATION } from "./limits.ts";
import { normalizeTail, TAIL_PATTERN } from "./resolve.ts";
import type { Finding, ReleaseContent } from "./types.ts";

const namespace = z.enum(["fixture", "candidate", "accepted"]);
const isoDate = z.string().refine(isIsoDate, "Not a real calendar date written as YYYY-MM-DD.");
const quantity = z.number().int().min(1).max(MAX_QTY);
const count = z.number().int().min(0);
const tail = z.string().refine((t) => t === normalizeTail(t) && TAIL_PATTERN.test(t), "Tails are upper case, trimmed, 2-10 letters, digits or hyphens.");
const locationKind = z.enum(["SEAT", "FLOOR", "BIN", "ARMREST"]);
const side = z.enum(["L", "R"]);
const unique = (items: string[]) => new Set(items).size === items.length;
const raw = z.record(z.string(), z.unknown());

export const SourceArtifactSchema = z
  .object({
    id: z.string(),
    namespace,
    kind: z.string(),
    title: z.string(),
    revision: z.string(),
    owner: z.string(),
    authority: z.enum(["fictional-fixture", "supplied-unverified", "approved"]),
    released: z.boolean(),
    effectiveFrom: isoDate.nullable(),
    expiresOn: isoDate.nullable(),
    file: z.object({ path: z.string(), sha256: z.string(), bytes: count, parseStatus: z.string() }).strict().optional(),
    note: z.string().optional(),
  })
  .strict();

export const AircraftSubtypeSchema = z.object({ id: z.string(), namespace, name: z.string(), note: z.string().optional() }).strict();

export const AircraftSchema = z.object({ tail, namespace, subtypeId: z.string(), note: z.string().optional() }).strict();

export const MaintenanceVariantSchema = z
  .object({
    id: z.string(),
    namespace,
    name: z.string(),
    subtypeId: z.string(),
    hardware: z.string().nullable(),
    released: z.boolean(),
    statusNote: z.string(),
    layoutRevisionIds: z.array(z.string()),
    attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    sourceId: z.string(),
  })
  .strict();

export const LayoutSchema = z.object({ id: z.string(), namespace, subtypeId: z.string(), name: z.string(), note: z.string().optional() }).strict();

export const RowLabelSchema = z
  .object({
    printedLabel: z.string(),
    exists: z.boolean(),
    physicalOrder: z.number().int().min(1).nullable(),
    raw: raw.optional(),
    locator: z.string().optional(),
  })
  .strict();

export const RangeClaimSchema = z
  .object({
    raw: z.string(),
    min: z.number().nullable(),
    max: z.number().nullable(),
    unit: z.string(),
    approximate: z.boolean(),
    measurementKind: z.string(),
    note: z.string().optional(),
  })
  .strict();

export const SeatAttributesSchema = z
  .object({
    printedRow: z.string(),
    letter: z.string(),
    code: z.string(),
    side,
    physicalRow: z.number().int(),
    positionType: z.enum(["WINDOW", "MIDDLE", "AISLE"]).nullable(),
    commercialTier: z.string().nullable(),
    pitch: RangeClaimSchema.nullable(),
    width: RangeClaimSchema.nullable(),
    exitRow: z.boolean().nullable(),
    bulkhead: z.boolean().nullable(),
    maintenanceZone: z.string().nullable(),
    seatGroup: z.string().nullable(),
    raw: raw.optional(),
    locator: z.string().optional(),
  })
  .strict();

export const FloorAttributesSchema = z
  .object({
    areaType: z.enum(["FULL_CABIN", "AREA"]),
    rowFrom: z.number().int().nullable(),
    rowTo: z.number().int().nullable(),
  })
  .strict();

export const BinAttributesSchema = z
  .object({
    side,
    module: z.number().int(),
    rowFrom: z.number().int(),
    rowTo: z.number().int(),
    binType: z.enum(["CLASSIC", "PIVOT", "LARGE_PIVOT"]),
    capacityBags: z.number().int().min(1),
  })
  .strict();

export const ArmrestAttributesSchema = z.object({ row: z.number().int(), side, between: z.tuple([z.string().nullable(), z.string().nullable()]) }).strict();

export const PlacementSchema = z.object({ x: z.number(), y: z.number(), z: z.number(), lx: z.number(), lz: z.number(), ly: z.number() }).strict();

export const CabinLocationSchema = z
  .object({
    id: z.string(),
    kind: locationKind,
    label: z.string(),
    componentIds: z.array(z.string()).refine(unique, "Component ids on one location must be unique."),
    seat: SeatAttributesSchema.optional(),
    floor: FloorAttributesSchema.optional(),
    bin: BinAttributesSchema.optional(),
    armrest: ArmrestAttributesSchema.optional(),
    placement: PlacementSchema,
  })
  .strict();

export const GeometryDeclarationSchema = z
  .object({
    version: z.string(),
    units: z.literal("metre"),
    axes: z.object({ x: z.string(), y: z.string(), z: z.string() }).strict(),
    origin: z.string(),
    status: z.literal("illustrative-approximation"),
    note: z.string(),
    cabinLength: z.number(),
    cabinHalfWidth: z.number(),
    rowPitch: z.number(),
  })
  .strict();

export const LayoutRevisionSchema = z
  .object({
    id: z.string(),
    layoutId: z.string(),
    revision: z.string(),
    namespace,
    status: z.enum(["released", "planned", "candidate"]),
    subtypeId: z.string(),
    name: z.string(),
    seatSetStatus: z.enum(["complete", "not-supplied"]),
    declaredSeatCount: count.nullable(),
    declaredTierTotals: z.record(z.string(), count).optional(),
    rows: z.array(RowLabelSchema),
    locations: z.array(CabinLocationSchema),
    floorMapStatus: z.enum(["fixture-defined", "not-supplied"]),
    binMapStatus: z.enum(["fixture-defined", "not-supplied"]),
    geometry: GeometryDeclarationSchema,
    sourceId: z.string(),
    raw: raw.optional(),
    notes: z.array(z.string()),
  })
  .strict();

export const TailAssignmentSchema = z
  .object({
    id: z.string(),
    namespace,
    tail,
    variantId: z.string(),
    layoutRevisionId: z.string(),
    status: z.enum(["released", "planned"]),
    carpet: z.string().nullable(),
    seam: z.string().nullable(),
    upholstery: z.string().nullable(),
    effectiveFrom: isoDate,
    effectiveTo: isoDate.nullable(),
    sourceId: z.string(),
  })
  .strict();

export const ComponentDefSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    locationKind,
    maxReplacementsPerLocation: z.number().int().min(1).max(MAX_REPLACEMENTS_PER_LOCATION),
    countNote: z.string(),
  })
  .strict();

export const PartSchema = z.object({ partNo: z.string(), namespace, description: z.string() }).strict();

export const ContextConstraintSchema = z
  .object({
    variant: z.array(z.string()).optional(),
    layoutRevision: z.array(z.string()).optional(),
    subtype: z.array(z.string()).optional(),
    hardware: z.array(z.string()).optional(),
    carpet: z.array(z.string()).optional(),
    seam: z.array(z.string()).optional(),
    upholstery: z.array(z.string()).optional(),
  })
  .strict();

export const LocationSelectorSchema = z
  .object({
    kind: locationKind,
    ids: z.array(z.string()).optional(),
    zones: z.array(z.string()).optional(),
    letters: z.array(z.string()).optional(),
    sides: z.array(side).optional(),
    rowFrom: z.number().int().optional(),
    rowTo: z.number().int().optional(),
    floorAreaTypes: z.array(z.enum(["FULL_CABIN", "AREA"])).optional(),
  })
  .strict();

export const ApplicabilityRuleSchema = z
  .object({
    id: z.string(),
    namespace,
    componentId: z.string(),
    partNo: z.string(),
    qtyPerReplacement: quantity,
    unit: z.string(),
    constraint: ContextConstraintSchema,
    locations: LocationSelectorSchema,
    released: z.boolean(),
    effectiveFrom: isoDate,
    effectiveTo: isoDate.nullable(),
    sourceId: z.string(),
    note: z.string().optional(),
  })
  .strict();

export const SubstituteApprovalSchema = z
  .object({
    id: z.string(),
    namespace,
    componentId: z.string(),
    primaryPartNo: z.string(),
    altPartNo: z.string(),
    qtyPerReplacement: quantity,
    unit: z.string(),
    constraint: ContextConstraintSchema,
    locations: LocationSelectorSchema.optional(),
    released: z.boolean(),
    effectiveFrom: isoDate,
    effectiveTo: isoDate.nullable(),
    sourceId: z.string(),
    note: z.string().optional(),
  })
  .strict();

export const KitChildSchema = z.object({ parentPartNo: z.string(), childPartNo: z.string(), qty: quantity, unit: z.string(), sourceId: z.string() }).strict();

export const PendingChangeSchema = z
  .object({
    id: z.string(),
    ruleId: z.string(),
    note: z.string(),
    sourceId: z.string().nullable(),
    proposedEffectiveFrom: isoDate.nullable(),
  })
  .strict();

export const LayoutCategorySchema = z
  .object({
    id: z.string(),
    namespace,
    name: z.string(),
    claimedSeatCount: count.nullable(),
    seatSetStatus: z.enum(["matched-to-candidate", "not-supplied"]),
    crosswalk: z.array(z.object({ layoutRevisionId: z.string(), basis: z.enum(["inferred", "stated"]) }).strict()),
    claims: z.array(z.object({ text: z.string(), sourceId: z.string(), locator: z.string() }).strict()),
    note: z.string(),
  })
  .strict();

export const VisualProfileSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    basis: z.string(),
    status: z.literal("unassigned-illustrative"),
    evidence: z.array(z.string()),
    note: z.string(),
  })
  .strict();

export const VocabularySchema = z
  .object({ carpets: z.array(z.string()), seams: z.array(z.string()), upholsteries: z.array(z.string()), units: z.array(z.string()) })
  .strict();

const melClass = z.discriminatedUnion("class", [
  z.object({ class: z.literal("COSMETIC") }).strict(),
  z
    .object({
      class: z.literal("MEL"),
      item: z.string(),
      category: z.enum(["A", "B", "C", "D"]),
      intervalDays: z.number().int().min(0),
      conditions: z.string(),
      blocksSeat: z.literal(true).optional(),
    })
    .strict(),
  z.object({ class: z.literal("NO_GO"), reason: z.string() }).strict(),
]);

export const MelEntrySchema = z
  .object({
    id: z.string(),
    componentId: z.string(),
    condition: z.enum(["STAINED", "TORN", "WORN", "BROKEN", "MISSING", "WONT_LATCH", "OTHER"]),
    result: melClass,
    whenSeatBlocked: melClass.optional(),
    constraint: z
      .object({ variant: z.array(z.string()).optional() })
      .strict()
      .optional(),
    sourceId: z.string(),
  })
  .strict();

export const ReleaseContentSchema = z
  .object({
    schema: z.literal("cabin-kit.reference/1"),
    label: z.string(),
    vocabulary: VocabularySchema,
    sources: z.array(SourceArtifactSchema),
    subtypes: z.array(AircraftSubtypeSchema),
    aircraft: z.array(AircraftSchema),
    variants: z.array(MaintenanceVariantSchema),
    layouts: z.array(LayoutSchema),
    layoutRevisions: z.array(LayoutRevisionSchema),
    assignments: z.array(TailAssignmentSchema),
    components: z.array(ComponentDefSchema),
    parts: z.array(PartSchema),
    rules: z.array(ApplicabilityRuleSchema),
    substitutes: z.array(SubstituteApprovalSchema),
    kitChildren: z.array(KitChildSchema),
    pendingChanges: z.array(PendingChangeSchema),
    layoutCategories: z.array(LayoutCategorySchema),
    visualProfiles: z.array(VisualProfileSchema),
    mel: z.array(MelEntrySchema),
  })
  .strict();

/** Most findings reported one by one; the rest are summarised in one more finding. */
const MAX_LISTED = 50;

/** The value under `key`, or undefined once the path leaves the data. */
function stepInto(value: unknown, key: PropertyKey): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return (value as Record<PropertyKey, unknown>)[key];
}

function stringField(value: unknown, key: string): string | undefined {
  const field = stepInto(value, key);
  return typeof field === "string" ? field : undefined;
}

/** The key the semantic checks use as a ref for an entity of this collection. */
function entityKey(collection: PropertyKey, entity: unknown): string | undefined {
  switch (collection) {
    case "aircraft":
      return stringField(entity, "tail");
    case "parts":
      return stringField(entity, "partNo");
    case "kitChildren": {
      const parent = stringField(entity, "parentPartNo");
      const child = stringField(entity, "childPartNo");
      return parent !== undefined && child !== undefined ? `${parent}>${child}` : undefined;
    }
    default:
      return stringField(entity, "id");
  }
}

/** The nearest entity id on the path (a location is named `<revision>#<location>`), or the entity type. */
function refFor(content: unknown, path: readonly PropertyKey[]): string {
  let ref: string | undefined;
  let value = content;
  let revision: string | undefined;
  for (let i = 0; i < path.length; i++) {
    const key = path[i] as PropertyKey;
    value = stepInto(value, key);
    const collection = path[i - 1];
    if (typeof key !== "number" || collection === undefined) continue;
    const id = entityKey(collection, value);
    if (id === undefined) continue;
    if (collection === "layoutRevisions") revision = id;
    ref = collection === "locations" && revision !== undefined ? `${revision}#${id}` : id;
  }
  return ref ?? String(path[0] ?? "release");
}

/** Structural problems with release content, as blocking findings. Empty when the content is sound. */
export function structuralFindings(content: unknown): Finding[] {
  const parsed = ReleaseContentSchema.safeParse(content);
  if (parsed.success) return [];
  const issues = parsed.error.issues;
  const findings: Finding[] = issues.slice(0, MAX_LISTED).map((issue) => ({
    severity: "error",
    code: "SCHEMA_INVALID",
    message: `${issue.path.map(String).join(".") || "release"}: ${issue.message}`,
    refs: [refFor(content, issue.path)],
  }));
  if (issues.length > MAX_LISTED) {
    findings.push({
      severity: "error",
      code: "SCHEMA_INVALID",
      message: `${issues.length - MAX_LISTED} more structural problems are not listed.`,
      refs: ["release"],
    });
  }
  return findings;
}

// Compile-time agreement, both directions, between the schema and the hand-written types.
type Inferred = z.infer<typeof ReleaseContentSchema>;
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
export type SchemaAgreesWithTypes = [Expect<Equal<Inferred, ReleaseContent>>];
