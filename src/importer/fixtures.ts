import { readFileSync } from "node:fs";
import { binPlacement, floorPlacement, geometryDeclaration, seatPlacement, sideOf } from "../domain/geometry.ts";
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
  LocationSelector,
  MaintenanceVariant,
  Part,
  PendingChange,
  RowLabel,
  SourceArtifact,
  SubstituteApproval,
  TailAssignment,
  Vocabulary,
} from "../domain/types.ts";

interface SeatSpec {
  rows: number;
  omit: string[];
  exitRows: number[];
  elrRows: number[];
}

interface FixtureData {
  note: string;
  vocabulary: Vocabulary;
  sources: { id: string; kind: string; revision: string; title: string; effectiveFrom: string | null; expiresOn: string | null; released: boolean }[];
  subtypes: { id: string; name: string }[];
  seatSpecs: Record<string, SeatSpec>;
  variants: {
    id: string;
    subtype: string;
    hardware: string | null;
    elr: string | null;
    layoutNote: string | null;
    power: boolean | null;
    cabinHeight: string | null;
    statusNote: string;
    seatSpec: string | null;
    released: boolean;
  }[];
  aircraft: { tail: string; subtype: string; note: string }[];
  assignments: { tail: string; variant: string; carpet: string | null; seam: string | null; from: string; to: string | null; source: string; status?: "planned" }[];
  components: ComponentDef[];
  seatRuleSource: string;
  carpetRuleSource: string;
  ruleEffectiveFrom: string;
  partOverrides: Record<string, string>;
  variantOmissions: Record<string, { noBinRules?: boolean; backrestExitSource?: string; aftPanelUnreleased?: boolean }>;
  extraParts: { partNo: string; description: string }[];
  extraRules: {
    id: string;
    componentId: string;
    partNo: string;
    unit: string;
    constraint: ContextConstraint;
    locations: LocationSelector;
    effectiveFrom: string;
    effectiveTo?: string | null;
    source: string;
    released: boolean;
    note?: string;
  }[];
  pendingChanges: PendingChange[];
  substitutes: {
    id: string;
    componentId: string;
    primaryPartNo: string;
    altPartNo: string;
    qtyPerReplacement: number;
    unit: string;
    constraint: ContextConstraint;
    locations?: LocationSelector;
    effectiveFrom: string;
    effectiveTo: string | null;
    source: string;
    note?: string;
  }[];
  kitChildren: { parentPartNo: string; childPartNo: string; qty: number; unit: string; source: string }[];
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

function zoneOf(spec: SeatSpec, row: number): (typeof ZONES)[number] {
  if (spec.exitRows.includes(row)) return "EXIT";
  if (spec.elrRows.includes(row)) return "ELR";
  return "STD";
}

function floorAreas(rows: number): { id: string; label: string; from: number; to: number }[] {
  return [
    { id: "FWD", label: "Forward floor area", from: 1, to: 5 },
    { id: "MID", label: "Mid floor area", from: 6, to: rows - 10 },
    { id: "AFT", label: "Aft floor area", from: rows - 9, to: rows },
  ];
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

export function loadFixtureData(path: string): FixtureData {
  return JSON.parse(readFileSync(path, "utf8")) as FixtureData;
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
        const specId = data.variants.some((o) => o.seatSpec === v.seatSpec && o.subtype !== v.subtype) ? `${v.seatSpec}-${v.subtype.replace("FX-", "")}` : v.seatSpec;
        revision = buildRevision(specId, data.seatSpecs[v.seatSpec], v.subtype, "FX-DOC-CONFIG");
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
    const revision = revisionById.get(variantById.get(v.id)!.layoutRevisionIds[0])!;
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
    for (const area of floorAreas(data.seatSpecs[v.seatSpec].rows)) {
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
      qtyPerReplacement: 1,
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
    released: true,
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

  return {
    vocabulary: data.vocabulary,
    sources,
    subtypes,
    aircraft,
    variants,
    layouts,
    layoutRevisions,
    assignments,
    components: data.components,
    parts: [...parts.values()].sort((a, b) => a.partNo.localeCompare(b.partNo)),
    rules,
    substitutes,
    kitChildren,
    pendingChanges: data.pendingChanges,
  };
}
