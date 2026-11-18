// Logical model for Cabin Kit. See docs/logical-model.md.
// Everything here is plain data so it can be frozen into visit snapshots and reports.

export type Namespace = "fixture" | "candidate" | "accepted";
export type IsoDate = string; // YYYY-MM-DD, calendar date, compared lexically

export type LocationKind = "SEAT" | "FLOOR" | "BIN" | "ARMREST";

export interface SourceArtifact {
  id: string;
  namespace: Namespace;
  kind: string;
  title: string;
  revision: string;
  owner: string;
  /** How much weight the artifact carries. Nothing supplied so far is "approved". */
  authority: "fictional-fixture" | "supplied-unverified" | "approved";
  released: boolean;
  /** Inclusive validity of the artifact itself. null start = not stated. */
  effectiveFrom: IsoDate | null;
  expiresOn: IsoDate | null;
  file?: { path: string; sha256: string; bytes: number; parseStatus: string };
  note?: string;
}

export interface AircraftSubtype {
  id: string;
  namespace: Namespace;
  name: string;
  note?: string;
}

export interface Aircraft {
  tail: string;
  namespace: Namespace;
  subtypeId: string;
  note?: string;
}

export interface MaintenanceVariant {
  id: string;
  namespace: Namespace;
  name: string;
  subtypeId: string;
  /** Seat hardware family carried by this maintenance variant. */
  hardware: string | null;
  released: boolean;
  statusNote: string;
  /** A variant may be served by several layout revisions. */
  layoutRevisionIds: string[];
  attributes: Record<string, string | number | boolean | null>;
  sourceId: string;
}

export interface Layout {
  id: string;
  namespace: Namespace;
  subtypeId: string;
  name: string;
  note?: string;
}

/** A printed row label and where (if anywhere) it sits physically. */
export interface RowLabel {
  printedLabel: string;
  exists: boolean;
  /** 1-based forward-to-aft order of rows that physically exist; null for labels that are skipped. */
  physicalOrder: number | null;
  raw?: Record<string, unknown>;
  locator?: string;
}

/** A measurement claim kept with its qualifiers. Never flattened to a single exact number. */
export interface RangeClaim {
  raw: string;
  min: number | null;
  max: number | null;
  unit: string;
  approximate: boolean;
  /** What the number measures, when the source says. "unspecified" when sources conflate kinds. */
  measurementKind: string;
  note?: string;
}

export interface SeatAttributes {
  printedRow: string;
  letter: string;
  code: string;
  side: "L" | "R";
  physicalRow: number;
  positionType: "WINDOW" | "MIDDLE" | "AISLE" | null;
  /** Commercial product tier. Independent of physical spacing. */
  commercialTier: string | null;
  /** Physical spacing claim. Independent of commercial tier. */
  pitch: RangeClaim | null;
  width: RangeClaim | null;
  exitRow: boolean | null;
  bulkhead: boolean | null;
  /** Maintenance zone used by applicability rules (fixture data only). */
  maintenanceZone: string | null;
  /** Hardware group (double/triple) when a source establishes it; null when it does not. */
  seatGroup: string | null;
  raw?: Record<string, unknown>;
  locator?: string;
}

export interface FloorAttributes {
  areaType: "FULL_CABIN" | "AREA";
  /** Physical row span covered, when defined. */
  rowFrom: number | null;
  rowTo: number | null;
}

export type BinType = "CLASSIC" | "PIVOT" | "LARGE_PIVOT";

export interface BinAttributes {
  side: "L" | "R";
  module: number;
  rowFrom: number;
  rowTo: number;
  binType: BinType;
  capacityBags: number;
}

/**
 * A bin's type and capacity, tolerating snapshots stored before they existed: a missing type reads as
 * "PIVOT" and a missing capacity as 4. Readers of stored data use this; new releases always carry both.
 */
export function binTypeOf(bin: BinAttributes): { binType: BinType; capacityBags: number } {
  return { binType: bin.binType ?? "PIVOT", capacityBags: bin.capacityBags ?? 4 };
}

export interface ArmrestAttributes {
  row: number;
  side: "L" | "R";
  /** Seat codes either side of the armrest; null = wall or aisle. */
  between: [string | null, string | null];
}

/** Approximate placement in the declared geometry frame (metres). */
export interface Placement {
  x: number;
  y: number;
  z: number;
  /** extent along X (fore-aft), Z (lateral) and Y (height) */
  lx: number;
  lz: number;
  ly: number;
}

export interface CabinLocation {
  /** Unique inside one layout revision, e.g. "SEAT:3A", "FLOOR:FULL-CABIN", "BIN:L-01". */
  id: string;
  kind: LocationKind;
  label: string;
  /** Components that can be replaced at this location. */
  componentIds: string[];
  seat?: SeatAttributes;
  floor?: FloorAttributes;
  bin?: BinAttributes;
  armrest?: ArmrestAttributes;
  placement: Placement;
}

export interface GeometryDeclaration {
  version: string;
  units: "metre";
  axes: { x: string; y: string; z: string };
  origin: string;
  status: "illustrative-approximation";
  note: string;
  cabinLength: number;
  cabinHalfWidth: number;
  rowPitch: number;
}

export interface LayoutRevision {
  /** Immutable identity: layout id + revision. */
  id: string;
  layoutId: string;
  revision: string;
  namespace: Namespace;
  status: "released" | "planned" | "candidate";
  subtypeId: string;
  name: string;
  seatSetStatus: "complete" | "not-supplied";
  declaredSeatCount: number | null;
  declaredTierTotals?: Record<string, number>;
  rows: RowLabel[];
  locations: CabinLocation[];
  floorMapStatus: "fixture-defined" | "not-supplied";
  binMapStatus: "fixture-defined" | "not-supplied";
  geometry: GeometryDeclaration;
  sourceId: string;
  raw?: Record<string, unknown>;
  notes: string[];
}

export interface TailAssignment {
  id: string;
  namespace: Namespace;
  tail: string;
  variantId: string;
  layoutRevisionId: string;
  status: "released" | "planned";
  carpet: string | null;
  seam: string | null;
  upholstery: string | null;
  /** Inclusive. */
  effectiveFrom: IsoDate;
  /** Inclusive. null = open ended. */
  effectiveTo: IsoDate | null;
  sourceId: string;
}

export interface ComponentDef {
  id: string;
  name: string;
  locationKind: LocationKind;
  /**
   * Replacement-count semantics: quantity on a record is the number of this component
   * replaced at that location during the visit. It may not exceed this limit.
   */
  maxReplacementsPerLocation: number;
  countNote: string;
}

export interface Part {
  partNo: string;
  namespace: Namespace;
  description: string;
}

/** Each listed dimension restricts the rule; an absent dimension places no restriction. */
export interface ContextConstraint {
  variant?: string[];
  layoutRevision?: string[];
  subtype?: string[];
  hardware?: string[];
  carpet?: string[];
  seam?: string[];
  upholstery?: string[];
}

export interface LocationSelector {
  kind: LocationKind;
  /** Explicit location ids (e.g. "SEAT:3A"). */
  ids?: string[];
  zones?: string[];
  letters?: string[];
  sides?: ("L" | "R")[];
  /**
   * Printed row numbers, inclusive (`parsePrintedRow`). Absent is no bound on that side; at run time a
   * null from unvalidated data reads the same way.
   */
  rowFrom?: number;
  rowTo?: number;
  floorAreaTypes?: ("FULL_CABIN" | "AREA")[];
}

export interface ApplicabilityRule {
  id: string;
  namespace: Namespace;
  componentId: string;
  partNo: string;
  qtyPerReplacement: number;
  unit: string;
  constraint: ContextConstraint;
  locations: LocationSelector;
  released: boolean;
  /** Inclusive. */
  effectiveFrom: IsoDate;
  /** Inclusive. */
  effectiveTo: IsoDate | null;
  sourceId: string;
  note?: string;
}

export interface SubstituteApproval {
  id: string;
  namespace: Namespace;
  componentId: string;
  /** The primary part this approval may stand in for. */
  primaryPartNo: string;
  altPartNo: string;
  qtyPerReplacement: number;
  unit: string;
  constraint: ContextConstraint;
  locations?: LocationSelector;
  released: boolean;
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;
  /** Approval document. Its own release/effective/expiry is enforced separately. */
  sourceId: string;
  note?: string;
}

export interface KitChild {
  parentPartNo: string;
  childPartNo: string;
  qty: number;
  unit: string;
  sourceId: string;
}

export interface PendingChange {
  id: string;
  ruleId: string;
  note: string;
  sourceId: string | null;
  proposedEffectiveFrom: IsoDate | null;
}

/** A layout category described in narrative evidence, with an explicit crosswalk status. */
export interface LayoutCategory {
  id: string;
  namespace: Namespace;
  name: string;
  claimedSeatCount: number | null;
  seatSetStatus: "matched-to-candidate" | "not-supplied";
  crosswalk: { layoutRevisionId: string; basis: "inferred" | "stated" }[];
  claims: { text: string; sourceId: string; locator: string }[];
  note: string;
}

export interface VisualProfile {
  id: string;
  name: string;
  basis: string;
  status: "unassigned-illustrative";
  evidence: string[];
  note: string;
}

export interface Vocabulary {
  carpets: string[];
  seams: string[];
  upholsteries: string[];
  units: string[];
}

export type Condition = "STAINED" | "TORN" | "WORN" | "BROKEN" | "MISSING" | "WONT_LATCH" | "OTHER";
export type MelCategory = "A" | "B" | "C" | "D";
export type MelClass =
  | { class: "COSMETIC" }
  | { class: "MEL"; item: string; category: MelCategory; intervalDays: number; conditions: string; blocksSeat?: true }
  | { class: "NO_GO"; reason: string };

export interface MelEntry {
  id: string;
  componentId: string;
  condition: Condition;
  result: MelClass;
  /** Replaces `result` while the seat is blocked (life vest). */
  whenSeatBlocked?: MelClass;
  /** Configuration override; the most specific entry wins. */
  constraint?: { variant?: string[] };
  sourceId: string;
}

export interface ReleaseContent {
  schema: "cabin-kit.reference/1";
  label: string;
  vocabulary: Vocabulary;
  sources: SourceArtifact[];
  subtypes: AircraftSubtype[];
  aircraft: Aircraft[];
  variants: MaintenanceVariant[];
  layouts: Layout[];
  layoutRevisions: LayoutRevision[];
  assignments: TailAssignment[];
  components: ComponentDef[];
  parts: Part[];
  rules: ApplicabilityRule[];
  substitutes: SubstituteApproval[];
  kitChildren: KitChild[];
  pendingChanges: PendingChange[];
  layoutCategories: LayoutCategory[];
  visualProfiles: VisualProfile[];
  mel: MelEntry[];
}

export interface ReferenceRelease extends ReleaseContent {
  id: string;
  contentHash: string;
  activatedAt: string | null;
}

export type FindingSeverity = "error" | "conflict" | "warning" | "info";

export interface Finding {
  severity: FindingSeverity;
  code: string;
  message: string;
  refs?: string[];
}

// ---------------------------------------------------------------------------
// Lookup and resolution

export type LookupState =
  | "INVALID_INPUT"
  | "UNKNOWN_TAIL"
  | "UNCONFIGURED"
  | "OVERLAP"
  | "PLANNED"
  | "SOURCE_INVALID"
  | "PARTIAL"
  | "RESOLVED"
  | "SERVICE_UNAVAILABLE";

export interface ExclusionReason {
  code:
    | "NOT_RELEASED"
    | "RULE_NOT_YET_EFFECTIVE"
    | "RULE_EXPIRED"
    | "SOURCE_MISSING"
    | "SOURCE_NOT_RELEASED"
    | "SOURCE_NOT_YET_EFFECTIVE"
    | "SOURCE_EXPIRED"
    | "APPROVAL_NOT_YET_EFFECTIVE"
    | "APPROVAL_EXPIRED"
    /** A mandatory kit child, at any depth below the part, cites a source that is not valid on the date. */
    | "KIT_SOURCE_INVALID"
    /** The kit below the part cannot be expanded: it is cyclic, nested too deep or its quantities overflow. */
    | "KIT_INVALID";
  message: string;
  /**
   * The source a `KIT_SOURCE_INVALID` reason refers to (the kit child's), so a report can cite it
   * (DOM-16). Absent on every other reason and on reasons frozen before it was written.
   */
  sourceId?: string;
}

export interface PartLine {
  partNo: string;
  description: string;
  qty: number;
  unit: string;
  role: "PRIMARY" | "ALTERNATE" | "MANDATORY_CHILD";
  parentPartNo: string | null;
  sourceId: string;
}

export interface FrozenSubstitute {
  id: string;
  altPartNo: string;
  altDescription: string;
  qtyPerReplacement: number;
  unit: string;
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;
  sourceId: string;
  /** Mandatory children per one alternate unit, already expanded through nested kits. */
  children: { partNo: string; description: string; qty: number; unit: string; sourceId: string }[];
  /** null = every location the rule covers. */
  locationIds: string[] | null;
  note?: string;
}

export interface ExcludedSubstitute {
  id: string;
  altPartNo: string;
  reasons: ExclusionReason[];
}

export interface FrozenRule {
  id: string;
  componentId: string;
  partNo: string;
  partDescription: string;
  qtyPerReplacement: number;
  unit: string;
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;
  sourceId: string;
  constraint: ContextConstraint;
  locations: LocationSelector;
  pendingChanges: PendingChange[];
  substitutes: FrozenSubstitute[];
  excludedSubstitutes: ExcludedSubstitute[];
  /** Mandatory children of the primary part itself, if it is a kit. */
  children: { partNo: string; description: string; qty: number; unit: string; sourceId: string }[];
  note?: string;
}

/** A rule that covered a component but could not grant eligibility on the check date, with why. */
export interface ExcludedRule {
  ruleId: string;
  partNo: string;
  /** Always written by new code; absent from no-match exclusions frozen before report schema 2. */
  sourceId?: string;
  reasons: ExclusionReason[];
}

/**
 * `excluded` is written on every status by new code (empty when nothing was excluded). Snapshots
 * frozen before report schema 2 lack it on RESOLVED and AMBIGUOUS components; readers treat a
 * missing field as `[]`.
 */
export type ComponentResolution =
  | { locationId: string; componentId: string; status: "RESOLVED"; ruleId: string; dominatedRuleIds: string[]; excluded?: ExcludedRule[] }
  | {
      locationId: string;
      componentId: string;
      status: "NO_MATCH";
      message: string;
      excluded: ExcludedRule[];
    }
  | {
      locationId: string;
      componentId: string;
      status: "AMBIGUOUS";
      message: string;
      candidates: { ruleId: string; partNo: string; sourceId: string }[];
      excluded?: ExcludedRule[];
    };

export interface ResolvedContext {
  aircraft: Aircraft;
  subtype: AircraftSubtype;
  assignment: TailAssignment;
  variant: MaintenanceVariant;
  layout: Layout;
  layoutRevision: LayoutRevision;
  configurationSource: SourceArtifact;
  /** Advisory only: assignments that are planned and never used for resolution. */
  plannedAdvisories: TailAssignment[];
}

export interface Resolution {
  rules: Record<string, FrozenRule>;
  components: ComponentResolution[];
  counts: { resolved: number; noMatch: number; ambiguous: number };
  sources: Record<string, SourceArtifact>;
  componentDefs: Record<string, ComponentDef>;
}

export interface LookupResult {
  state: LookupState;
  reasonCode: string;
  message: string;
  tail: string;
  checkDate: string;
  referenceReleaseId: string | null;
  demo: true;
  /** Dated intervals considered, shown for gap/overlap/planned explanations. */
  assignmentsConsidered?: {
    id: string;
    variantId: string;
    layoutRevisionId: string;
    status: string;
    /** How lookup treated it: a released assignment of unreleased data is treated as planned (DOM-21). */
    effectiveStatus: "released" | "planned";
    /** Why the treatment differs from `status`, or which referenced data is missing; null when nothing needs explaining. */
    reason: string | null;
    effectiveFrom: IsoDate;
    effectiveTo: IsoDate | null;
    coversDate: boolean;
  }[];
  aircraft?: Aircraft;
  context?: ResolvedContext;
  resolution?: Resolution;
}

// ---------------------------------------------------------------------------
// Visits

export interface VisitSnapshot {
  schema: "cabin-kit.snapshot/1";
  capturedAt: string;
  referenceReleaseId: string;
  referenceContentHash: string;
  tail: string;
  checkDate: IsoDate;
  lookupState: "RESOLVED" | "PARTIAL";
  context: ResolvedContext;
  resolution: Resolution;
  dateRule: string;
  geometryVersion: string;
}

export type SelectionType = "PRIMARY" | "ALTERNATE";

export interface RecordInput {
  locationId: string;
  componentId: string;
  selection: SelectionType;
  substituteId: string | null;
  quantity: number;
  note: string;
}

export interface VisitRecord extends RecordInput {
  version: number;
  ruleId: string;
  primaryPartNo: string;
  locationLabel: string;
  componentName: string;
  lines: PartLine[];
  createdAt: string;
  updatedAt: string;
}

export type VisitStatus = "DRAFT" | "COMPLETED";

export interface VisitSummary {
  id: string;
  number: number;
  tail: string;
  checkDate: IsoDate;
  technician: string;
  status: VisitStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  recordCount: number;
  referenceReleaseId: string;
  lookupState: string;
  variantId: string;
  layoutRevisionId: string;
}

export interface VisitEvent {
  seq: number;
  type: string;
  at: string;
  payload: Record<string, unknown>;
}

export interface Visit extends VisitSummary {
  snapshot: VisitSnapshot;
  snapshotSha256: string;
  records: VisitRecord[];
  events: VisitEvent[];
}

/** A visit without its frozen snapshot: what write responses carry. */
export type VisitState = Omit<Visit, "snapshot">;

export interface ReportTotalLine {
  partNo: string;
  description: string;
  unit: string;
  quantity: number;
  roles: string[];
  locations: { locationId: string; locationLabel: string; componentId: string; quantity: number; role: string }[];
}

export interface ReportWorkItem {
  locationId: string;
  locationLabel: string;
  locationKind: LocationKind;
  componentId: string;
  componentName: string;
  selection: SelectionType;
  primaryPartNo: string;
  selectedPartNo: string;
  substituteId: string | null;
  replacements: number;
  lines: PartLine[];
  note: string;
  ruleId: string;
  ruleSourceId: string;
  selectionSourceId: string;
  pendingChanges: PendingChange[];
  recordedAt: string;
  updatedAt: string;
  recordVersion: number;
  /** Rules that covered this component but were not used. Report schema 2; absent from /1 reports. */
  excludedRules?: ExcludedRule[];
}

export interface ReportGap {
  componentId: string;
  status: "NO_MATCH" | "AMBIGUOUS";
  message: string;
  locationIds: string[];
  locationSummary: string;
  /** Sources cited by the gap's candidates or excluded rules. Report schema 2; absent from /1 reports. */
  sourceIds?: string[];
}

/** Schema written by `buildReport`. Stored `/1` reports are served unchanged. */
export const REPORT_SCHEMA = "cabin-kit.report/2";

export interface Report {
  schema: "cabin-kit.report/1" | "cabin-kit.report/2";
  reportKind: "FINAL" | "DRAFT_PREVIEW";
  generatedAt: string;
  authorityNotice: string;
  replacementCountSemantics: string;
  dateRule: string;
  visit: {
    id: string;
    number: number;
    status: VisitStatus;
    tail: string;
    checkDate: IsoDate;
    technician: string;
    createdAt: string;
    completedAt: string | null;
    version: number;
  };
  configuration: {
    referenceReleaseId: string;
    referenceContentHash: string;
    snapshotSha256: string;
    capturedAt: string;
    lookupState: string;
    subtype: string;
    variantId: string;
    variantName: string;
    hardware: string | null;
    layoutId: string;
    layoutRevisionId: string;
    layoutName: string;
    seatCount: number;
    carpet: string | null;
    seam: string | null;
    upholstery: string | null;
    assignmentId: string;
    assignmentEffectiveFrom: IsoDate;
    assignmentEffectiveTo: IsoDate | null;
    configurationSourceId: string;
    geometryVersion: string;
    namespace: Namespace;
  };
  work: ReportWorkItem[];
  totals: ReportTotalLine[];
  gaps: ReportGap[];
  sources: SourceArtifact[];
  linkedEvents: VisitEvent[];
  counts: { workItems: number; replacements: number; totalLines: number; unresolvedComponents: number };
}

export const AUTHORITY_NOTICE =
  "Fictional home-lab demonstration. Not an approved maintenance authority, engineering source or work instruction. " +
  "Part numbers, tails, applicability and geometry shown are fictional fixtures or unverified candidate data.";

export const DATE_RULE = "Effective-from and effective-to/expiry dates are calendar dates and are both inclusive.";

export const REPLACEMENT_COUNT_SEMANTICS =
  "Replacements = number of that component replaced at that location during this visit (one record per visit, location and component). " +
  "Line quantity = replacements x quantity per replacement; mandatory children = replacements x alternate quantity x child quantity.";
