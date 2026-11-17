import { readFileSync } from "node:fs";
import { binPlacement, floorPlacement, geometryDeclaration, seatPlacement, sideOf } from "../domain/geometry.ts";
import { compareCodePoints } from "../domain/order.ts";
import type {
  Aircraft,
  AircraftSubtype,
  ApplicabilityRule,
  CabinLocation,
  ComponentDef,
  ContextConstraint,
  KitChild,
  Layout,
  LayoutRevision,
  MaintenanceVariant,
  Part,
  PendingChange,
  RowLabel,
  SourceArtifact,
  SubstituteApproval,
  TailAssignment,
  Vocabulary,
} from "../domain/types.ts";
import { type FixtureData, FixtureError, parseFixtureData, type SeatSpec } from "./fixtureSchema.ts";

/** Fixture content with nothing in it: what a release gets from a fixture file that is invalid. */
export function emptyFixtureContent(): FixtureContent {
  return {
    vocabulary: { carpets: [], seams: [], upholsteries: [], units: [] },
    sources: [],
    subtypes: [],
    aircraft: [],
    variants: [],
    layouts: [],
    layoutRevisions: [],
    assignments: [],
    components: [],
    parts: [],
    rules: [],
    substitutes: [],
    kitChildren: [],
    pendingChanges: [],
  };
}

export interface FixtureContent {
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
}

const LETTERS = ["A", "B", "C", "D", "E", "F"];
const ZONES = ["ELR", "STD", "EXIT"] as const;
const ns = "fixture" as const;
/** Seat components the builder generates rules for, and so the only ones a seat part override can name. */
const SEAT_COMPONENTS = ["CUSHION", "BACKREST"];
/** The forward floor area is rows 1 to FWD_LAST_ROW; the aft area is the last AFT_ROWS rows; mid is what lies between. */
const FWD_LAST_ROW = 5;
const AFT_ROWS = 10;
/** Fewest rows for which the forward, mid and aft areas are each at least one row and do not overlap. */
const MIN_SEAT_ROWS = FWD_LAST_ROW + 1 + AFT_ROWS;

function zoneOf(spec: SeatSpec, row: number): (typeof ZONES)[number] {
  if (spec.exitRows.includes(row)) return "EXIT";
  if (spec.elrRows.includes(row)) return "ELR";
  return "STD";
}

function floorAreas(rows: number): { id: string; label: string; from: number; to: number }[] {
  return [
    { id: "FWD", label: "Forward floor area", from: 1, to: FWD_LAST_ROW },
    { id: "MID", label: "Mid floor area", from: FWD_LAST_ROW + 1, to: rows - AFT_ROWS },
    { id: "AFT", label: "Aft floor area", from: rows - AFT_ROWS + 1, to: rows },
  ];
}

function seatSpecOf(data: FixtureData, id: string): SeatSpec {
  const spec = data.seatSpecs[id];
  if (!spec) throw new Error(`invariant: fixture data has no seat spec ${id}`);
  return spec;
}

function buildRevision(specId: string, spec: SeatSpec, subtypeId: string, sourceId: string): LayoutRevision {
  const rows: RowLabel[] = [];
  const locations: CabinLocation[] = [];
  for (let row = 1; row <= spec.rows; row++) {
    rows.push({ printedLabel: String(row), exists: true, physicalOrder: row });
    const present = LETTERS.filter((l) => !spec.omit.includes(`${row}${l}`));
    for (const letter of present) {
      const side = sideOf(letter);
      const blockSize = present.filter((l) => sideOf(l) === side).length;
      const code = `${row}${letter}`;
      locations.push({
        id: `SEAT:${code}`,
        kind: "SEAT",
        label: `Seat ${code}`,
        componentIds: ["CUSHION", "BACKREST"],
        seat: {
          printedRow: String(row),
          letter,
          code,
          side,
          physicalRow: row,
          positionType: letter === "A" || letter === "F" ? "WINDOW" : letter === "B" || letter === "E" ? "MIDDLE" : "AISLE",
          commercialTier: null,
          pitch: null,
          width: null,
          exitRow: spec.exitRows.includes(row),
          bulkhead: null,
          maintenanceZone: zoneOf(spec, row),
          seatGroup: blockSize === 3 ? "TRIPLE" : blockSize === 2 ? "DOUBLE" : "SINGLE",
        },
        placement: seatPlacement(row, letter),
      });
    }
  }
  locations.push({
    id: "FLOOR:FULL-CABIN",
    kind: "FLOOR",
    label: "Full cabin floor (fictional carpet-kit scope)",
    componentIds: ["CARPET_KIT"],
    floor: { areaType: "FULL_CABIN", rowFrom: 1, rowTo: spec.rows },
    placement: floorPlacement(1, spec.rows, spec.rows),
  });
  for (const area of floorAreas(spec.rows)) {
    locations.push({
      id: `FLOOR:${area.id}`,
      kind: "FLOOR",
      label: `${area.label} (rows ${area.from}-${area.to})`,
      componentIds: ["CARPET_PANEL"],
      floor: { areaType: "AREA", rowFrom: area.from, rowTo: area.to },
      placement: floorPlacement(area.from, area.to, spec.rows),
    });
  }
  const modules = Math.ceil(spec.rows / 3);
  for (const side of ["L", "R"] as const) {
    for (let m = 1; m <= modules; m++) {
      const from = (m - 1) * 3 + 1;
      const to = Math.min(m * 3, spec.rows);
      const tag = `${side}-${String(m).padStart(2, "0")}`;
      locations.push({
        id: `BIN:${tag}`,
        kind: "BIN",
        label: `Overhead bin ${tag} (rows ${from}-${to})`,
        componentIds: ["BIN_DOOR"],
        bin: { side, module: m, rowFrom: from, rowTo: to },
        placement: binPlacement(side, from, to),
      });
    }
  }
  const seatCount = locations.filter((l) => l.kind === "SEAT").length;
  return {
    id: `FX-L-${specId}@1`,
    layoutId: `FX-L-${specId}`,
    revision: "1",
    namespace: ns,
    status: "released",
    subtypeId,
    name: `Fictional ${seatCount}-seat layout (${specId})`,
    seatSetStatus: "complete",
    declaredSeatCount: seatCount,
    rows,
    locations,
    floorMapStatus: "fixture-defined",
    binMapStatus: "fixture-defined",
    geometry: geometryDeclaration(spec.rows),
    sourceId,
    notes: [
      "Fictional fixture layout. Exit rows, zones, floor areas and bin modules are fixture shortcuts.",
      `Omitted seats: ${spec.omit.length ? spec.omit.join(", ") : "none"}.`,
    ],
  };
}

/** Is `code` (`<row><letter>`) a seat of the spec's full row-and-letter grid, before omissions? */
function gridHas(spec: SeatSpec, code: string): boolean {
  const match = /^([1-9][0-9]*)([A-Z])$/.exec(code);
  return match !== null && Number(match[1]) <= spec.rows && LETTERS.includes(match[2] ?? "");
}

/** `zone|letter` pairs that at least one seat of the spec has, i.e. the seat rules the builder generates. */
function reachableSeats(spec: SeatSpec): Set<string> {
  const reachable = new Set<string>();
  for (let row = 1; row <= spec.rows; row++) {
    for (const letter of LETTERS) if (!spec.omit.includes(`${row}${letter}`)) reachable.add(`${zoneOf(spec, row)}|${letter}`);
  }
  return reachable;
}

/**
 * Cross-reference problems in schema-valid fixture data, one `path: message` line each. Every check
 * guards a key the builder would otherwise ignore or a value it would turn into nonsense.
 */
export function fixtureReferenceIssues(data: FixtureData): string[] {
  const issues: string[] = [];
  const variants = new Map(data.variants.map((v) => [v.id, v]));
  const componentIds = new Set(data.components.map((c) => c.id));

  for (const [id, spec] of Object.entries(data.seatSpecs)) {
    if (spec.rows < MIN_SEAT_ROWS) {
      issues.push(`seatSpecs.${id}.rows: ${spec.rows} rows is fewer than the ${MIN_SEAT_ROWS} the forward, mid and aft floor areas need.`);
    }
    for (const code of spec.omit) {
      if (!gridHas(spec, code)) issues.push(`seatSpecs.${id}.omit: seat ${code} is not in this ${spec.rows}-row layout (letters ${LETTERS.join("")}).`);
    }
    for (const list of ["exitRows", "elrRows"] as const) {
      for (const row of spec[list]) {
        if (row > spec.rows) issues.push(`seatSpecs.${id}.${list}: row ${row} is not in this ${spec.rows}-row layout.`);
      }
    }
    for (const row of new Set(spec.exitRows.filter((r) => spec.elrRows.includes(r)))) {
      issues.push(`seatSpecs.${id}: row ${row} is both an exit row and an ELR row; a row has one seat zone.`);
    }
  }
  data.variants.forEach((v, i) => {
    if (v.seatSpec !== null && !Object.hasOwn(data.seatSpecs, v.seatSpec)) issues.push(`variants.${i}.seatSpec: seat spec ${v.seatSpec} is not defined.`);
  });
  for (const id of Object.keys(data.variantOmissions)) {
    if (!variants.has(id)) issues.push(`variantOmissions.${id}: variant ${id} does not exist.`);
  }
  for (const key of Object.keys(data.partOverrides)) {
    const problem = overrideProblem(key, data, variants, componentIds);
    if (problem) issues.push(`partOverrides.${key}: ${problem}`);
  }
  const seenParts = new Set<string>();
  data.extraParts.forEach((p, i) => {
    if (seenParts.has(p.partNo)) issues.push(`extraParts.${i}.partNo: part ${p.partNo} is listed more than once.`);
    seenParts.add(p.partNo);
  });
  return issues;
}

/** Why a part override key matches no rule the builder generates, or null when it does. */
function overrideProblem(key: string, data: FixtureData, variants: Map<string, FixtureData["variants"][number]>, componentIds: Set<string>): string | null {
  const fields = key.split("|");
  const variant = variants.get(fields[0] ?? "");
  if (!variant) return `variant ${fields[0]} does not exist.`;
  // An unreleased variant may carry staged overrides; they take effect once it is released.
  if (variant.seatSpec === null) return `variant ${variant.id} has no seat spec, so no rule uses this override.`;
  if (fields.length === 2 && fields[1] === "CARPET_KIT") return null;
  if (fields.length !== 4) return "expected VARIANT|ZONE|LETTER|COMPONENT or VARIANT|CARPET_KIT.";
  const [, zone = "", letter = "", component = ""] = fields;
  if (!(ZONES as readonly string[]).includes(zone)) return `zone ${zone} is not one of ${ZONES.join(", ")}.`;
  if (!LETTERS.includes(letter)) return `seat letter ${letter} is not one of ${LETTERS.join(", ")}.`;
  if (!SEAT_COMPONENTS.includes(component) || !componentIds.has(component))
    return `component ${component} is not a seat component (${SEAT_COMPONENTS.join(", ")}).`;
  const spec = data.seatSpecs[variant.seatSpec];
  if (spec && !reachableSeats(spec).has(`${zone}|${letter}`)) return `no seat of variant ${variant.id} is in zone ${zone} with letter ${letter}.`;
  return null;
}

/** Read, parse and validate the fixture file. Throws `FixtureError` listing every problem. */
export function loadFixtureData(path: string): FixtureData {
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new FixtureError([`fixture: the file ${path} cannot be read (${reason(error)}).`]);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new FixtureError([`fixture: the file ${path} is not valid JSON (${reason(error)}).`]);
  }
  const parsed = parseFixtureData(json);
  if (parsed.data === null) throw new FixtureError(parsed.issues);
  const issues = fixtureReferenceIssues(parsed.data);
  if (issues.length > 0) throw new FixtureError(issues);
  return parsed.data;
}

export function buildFixtureContent(data: FixtureData): FixtureContent {
  const sources: SourceArtifact[] = data.sources.map((s) => ({
    id: s.id,
    namespace: ns,
    kind: s.kind,
    title: s.title,
    revision: s.revision,
    owner: "Demo engineering desk (fictional)",
    authority: "fictional-fixture",
    released: s.released,
    effectiveFrom: s.effectiveFrom,
    expiresOn: s.expiresOn,
  }));
  const subtypes: AircraftSubtype[] = data.subtypes.map((s) => ({ id: s.id, namespace: ns, name: s.name }));

  // One layout may serve several maintenance variants: layouts are keyed by seat set, not by variant.
  const layouts: Layout[] = [];
  const layoutRevisions: LayoutRevision[] = [];
  const revisionFor = new Map<string, LayoutRevision>();
  const variants: MaintenanceVariant[] = [];
  for (const v of data.variants) {
    let revision: LayoutRevision;
    if (v.seatSpec === null) {
      revision = {
        id: `FX-L-${v.id}-PLANNED@0`,
        layoutId: `FX-L-${v.id}-PLANNED`,
        revision: "0",
        namespace: ns,
        status: "planned",
        subtypeId: v.subtype,
        name: `Fictional planned layout for ${v.id}`,
        seatSetStatus: "not-supplied",
        declaredSeatCount: null,
        rows: [],
        locations: [],
        floorMapStatus: "not-supplied",
        binMapStatus: "not-supplied",
        geometry: geometryDeclaration(0),
        sourceId: "FX-DOC-CONFIG",
        notes: ["Planned only. No seat set is defined and nothing can be resolved against it."],
      };
      layouts.push({ id: revision.layoutId, namespace: ns, subtypeId: v.subtype, name: revision.name });
      layoutRevisions.push(revision);
    } else {
      const key = `${v.seatSpec}|${v.subtype}`;
      const existing = revisionFor.get(key);
      if (existing) revision = existing;
      else {
        const specId = data.variants.some((o) => o.seatSpec === v.seatSpec && o.subtype !== v.subtype)
          ? `${v.seatSpec}-${v.subtype.replace("FX-", "")}`
          : v.seatSpec;
        revision = buildRevision(specId, seatSpecOf(data, v.seatSpec), v.subtype, "FX-DOC-CONFIG");
        revisionFor.set(key, revision);
        layouts.push({ id: revision.layoutId, namespace: ns, subtypeId: v.subtype, name: revision.name });
        layoutRevisions.push(revision);
      }
    }
    variants.push({
      id: v.id,
      namespace: ns,
      name: `${v.subtype.replace("FX-", "")} / ${v.hardware ?? "TBD"}`,
      subtypeId: v.subtype,
      hardware: v.hardware,
      released: v.released,
      statusNote: v.statusNote,
      layoutRevisionIds: [revision.id],
      attributes: { elr: v.elr, layoutNote: v.layoutNote, power: v.power, cabinHeight: v.cabinHeight },
      sourceId: "FX-DOC-CONFIG",
    });
  }

  const aircraft: Aircraft[] = data.aircraft.map((a) => ({ tail: a.tail, namespace: ns, subtypeId: a.subtype, note: a.note }));
  const variantById = new Map(variants.map((v) => [v.id, v]));
  const assignments: TailAssignment[] = data.assignments.map((a) => ({
    id: `FX-TA-${a.tail}-${a.variant}-${a.from}`,
    namespace: ns,
    tail: a.tail,
    variantId: a.variant,
    layoutRevisionId: variantById.get(a.variant)?.layoutRevisionIds[0] ?? "",
    status: a.status ?? "released",
    carpet: a.carpet,
    seam: a.seam,
    upholstery: null,
    effectiveFrom: a.from,
    effectiveTo: a.to,
    sourceId: a.source,
  }));

  const parts = new Map<string, Part>();
  const addPart = (partNo: string, description: string) => {
    if (!parts.has(partNo)) parts.set(partNo, { partNo, namespace: ns, description });
  };
  for (const p of data.extraParts) addPart(p.partNo, p.description);
  const rules: ApplicabilityRule[] = [];
  const revisionById = new Map(layoutRevisions.map((r) => [r.id, r]));
  for (const v of data.variants) {
    if (!v.released || v.seatSpec === null) continue;
    const revisionId = variantById.get(v.id)?.layoutRevisionIds[0];
    const revision = revisionId === undefined ? undefined : revisionById.get(revisionId);
    if (!revision) throw new Error(`invariant: released variant ${v.id} has no layout revision`);
    const omissions = data.variantOmissions[v.id] ?? {};
    const constraint: ContextConstraint = { variant: [v.id] };
    const common = { namespace: ns, constraint, released: true, effectiveFrom: data.ruleEffectiveFrom, effectiveTo: null, qtyPerReplacement: 1 };
    for (const componentId of ["CUSHION", "BACKREST"]) {
      for (const zone of ZONES) {
        for (const letter of LETTERS) {
          // Only generate rules that can actually match a seat (the baseline had unreachable patterns).
          const reachable = revision.locations.some((l) => l.seat?.maintenanceZone === zone && l.seat.letter === letter);
          if (!reachable) continue;
          const partNo = data.partOverrides[`${v.id}|${zone}|${letter}|${componentId}`] ?? `FAKE-${v.id}-${zone}-${letter}-${componentId}`;
          addPart(partNo, `Fictional ${componentId === "CUSHION" ? "cushion" : "backrest"} cover, ${v.id} ${zone} seat ${letter}`);
          const sourceId = componentId === "BACKREST" && zone === "EXIT" && omissions.backrestExitSource ? omissions.backrestExitSource : data.seatRuleSource;
          rules.push({
            ...common,
            id: `FX-R-${v.id}-${zone}-${letter}-${componentId}`,
            componentId,
            partNo,
            unit: "EA",
            locations: { kind: "SEAT", zones: [zone], letters: [letter] },
            sourceId,
          });
        }
      }
    }
    const kitPart = data.partOverrides[`${v.id}|CARPET_KIT`] ?? `FAKE-${v.id}-CARPET-KIT`;
    addPart(kitPart, `Fictional full-cabin carpet kit, ${v.id}`);
    rules.push({
      ...common,
      id: `FX-R-${v.id}-CARPET-KIT`,
      componentId: "CARPET_KIT",
      partNo: kitPart,
      unit: "KIT",
      locations: { kind: "FLOOR", ids: ["FLOOR:FULL-CABIN"] },
      sourceId: data.carpetRuleSource,
    });
    for (const area of floorAreas(seatSpecOf(data, v.seatSpec).rows)) {
      if (area.id === "AFT" && omissions.aftPanelUnreleased) continue;
      const partNo = `FAKE-${v.id}-${area.id}-PANEL`;
      addPart(partNo, `Fictional ${area.label.toLowerCase()} carpet panel, ${v.id}`);
      rules.push({
        ...common,
        id: `FX-R-${v.id}-${area.id}-PANEL`,
        componentId: "CARPET_PANEL",
        partNo,
        unit: "PANEL",
        locations: { kind: "FLOOR", ids: [`FLOOR:${area.id}`] },
        sourceId: data.carpetRuleSource,
      });
    }
    if (!omissions.noBinRules) {
      for (const loc of revision.locations.filter((l) => l.kind === "BIN")) {
        const tag = loc.id.replace("BIN:", "");
        const partNo = `FAKE-${v.id}-BIN-${tag}`;
        addPart(partNo, `Fictional overhead bin door ${tag}, ${v.id}`);
        rules.push({
          ...common,
          id: `FX-R-${v.id}-BIN-${tag}`,
          componentId: "BIN_DOOR",
          partNo,
          unit: "EA",
          locations: { kind: "BIN", ids: [loc.id] },
          sourceId: data.seatRuleSource,
        });
      }
    }
  }
  for (const r of data.extraRules) {
    rules.push({
      id: r.id,
      namespace: ns,
      componentId: r.componentId,
      partNo: r.partNo,
      qtyPerReplacement: r.qtyPerReplacement,
      unit: r.unit,
      constraint: r.constraint,
      locations: r.locations,
      released: r.released,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo ?? null,
      sourceId: r.source,
      note: r.note,
    });
  }
  const substitutes: SubstituteApproval[] = data.substitutes.map((s) => ({
    id: s.id,
    namespace: ns,
    componentId: s.componentId,
    primaryPartNo: s.primaryPartNo,
    altPartNo: s.altPartNo,
    qtyPerReplacement: s.qtyPerReplacement,
    unit: s.unit,
    constraint: s.constraint,
    locations: s.locations,
    released: s.released,
    effectiveFrom: s.effectiveFrom,
    effectiveTo: s.effectiveTo,
    sourceId: s.source,
    note: s.note,
  }));
  const kitChildren: KitChild[] = data.kitChildren.map((k) => ({
    parentPartNo: k.parentPartNo,
    childPartNo: k.childPartNo,
    qty: k.qty,
    unit: k.unit,
    sourceId: k.source,
  }));

  const vocabulary: Vocabulary = {
    carpets: [...data.vocabulary.carpets],
    seams: [...data.vocabulary.seams],
    upholsteries: [...data.vocabulary.upholsteries],
    units: [...data.vocabulary.units],
  };
  const components: ComponentDef[] = data.components.map((c) => ({
    id: c.id,
    name: c.name,
    locationKind: c.locationKind,
    maxReplacementsPerLocation: c.maxReplacementsPerLocation,
    countNote: c.countNote,
  }));
  const pendingChanges: PendingChange[] = data.pendingChanges.map((p) => ({
    id: p.id,
    ruleId: p.ruleId,
    note: p.note,
    sourceId: p.sourceId,
    proposedEffectiveFrom: p.proposedEffectiveFrom,
  }));

  return {
    vocabulary,
    sources,
    subtypes,
    aircraft,
    variants,
    layouts,
    layoutRevisions,
    assignments,
    components,
    parts: [...parts.values()].sort((a, b) => compareCodePoints(a.partNo, b.partNo)),
    rules,
    substitutes,
    kitChildren,
    pendingChanges,
  };
}
