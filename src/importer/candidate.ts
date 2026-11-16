import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { geometryDeclaration, isKnownSeatLetter, seatPlacement, sideOf } from "../domain/geometry.ts";
import type { AircraftSubtype, CabinLocation, Finding, Layout, LayoutCategory, LayoutRevision, RangeClaim, RowLabel, SourceArtifact } from "../domain/types.ts";
import { ORIGINAL_FILES } from "./originals.ts";
import { parseCsv } from "./readers/csv.ts";
import { normaliseForQuote, readDocxParagraphs } from "./readers/docx.ts";
import { readXlsx } from "./readers/xlsx.ts";

/**
 * Stages the supplied registry as CANDIDATE layouts: explorable, visibly unassigned, with no
 * tails, parts or applicability. Every value keeps its raw claim and a locator. Differences
 * between sources are reported as findings; no source is declared the winner.
 */
export { ORIGINAL_FILES };

const CONFIG_FIELDS = [
  "lopa_id",
  "boeing_model",
  "icao_code",
  "iata_code",
  "configuration_name",
  "interior_generation",
  "seat_hardware_model",
  "est_active_aircraft",
  "total_seats",
  "extra_legroom_seats",
  "preferred_seats",
  "standard_seats",
  "numbered_row_range",
  "elr_pitch_inches",
  "standard_pitch_inches",
  "max_seat_width_inches",
  "in_seat_power",
  "wifi_system",
  "lavatory_count_fwd",
  "lavatory_count_aft",
  "notes",
];
const ROW_FIELDS = [
  "lopa_id",
  "row_number",
  "row_exists",
  "active_seat_count",
  "omitted_seat_letters",
  "is_exit_row",
  "is_bulkhead_row",
  "recline_status",
  "recline_restriction_reason",
  "row_notes",
];
const SEAT_FIELDS = [
  "lopa_id",
  "row_number",
  "seat_letter",
  "seat_code",
  "seat_position_type",
  "commercial_tier",
  "pitch_range_inches",
  "effective_width_inches",
  "recline_status",
  "window_status",
  "window_notes",
  "is_exit_seat",
  "is_bulkhead_seat",
  "has_unobstructed_legroom",
  "tray_table_location",
  "underseat_storage_allowed",
  "power_type",
  "special_notes",
];

export interface CandidateContent {
  sources: SourceArtifact[];
  subtypes: AircraftSubtype[];
  layouts: Layout[];
  layoutRevisions: LayoutRevision[];
  layoutCategories: LayoutCategory[];
  findings: Finding[];
  stats: Record<string, unknown>;
}

type Json = Record<string, unknown>;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pitchClaim(raw: string, configLevelRaw: string): RangeClaim {
  const m = /^(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?$/.exec(raw.trim());
  const min = m ? Number(m[1]) : null;
  const max = m ? Number(m[2] ?? m[1]) : null;
  // The registry's configuration record qualifies some figures with "~"; the seat record drops it.
  const approximate = min !== null && min === max && new RegExp(`~\\s*${min}\\b`).test(configLevelRaw);
  return {
    raw,
    min,
    max,
    unit: "in",
    approximate,
    measurementKind: "seat pitch (as claimed by the registry)",
    note: approximate
      ? `Seat record states "${raw}" as exact, but the configuration record qualifies it as approximate ("${configLevelRaw}"). Treated as approximate.`
      : undefined,
  };
}

function widthClaim(value: unknown): RangeClaim {
  const n = typeof value === "number" ? value : null;
  return {
    raw: String(value),
    min: n,
    max: n,
    unit: "in",
    approximate: false,
    measurementKind: "unspecified",
    note: 'Source field "effective_width_inches". The sources mix seat width and shoulder/armrest clearance, so the measurement kind is not established.',
  };
}

/** Compare a JSON value with its CSV/XLSX counterpart under declared, counted conversions. */
function sameValue(jsonValue: unknown, other: unknown, conversions: Record<string, number>): boolean {
  if (other === null || other === undefined) {
    if (jsonValue === "") {
      conversions.blankToEmptyString = (conversions.blankToEmptyString ?? 0) + 1;
      return true;
    }
    return jsonValue === null;
  }
  if (typeof jsonValue === "boolean") {
    if (typeof other === "boolean") return jsonValue === other;
    if (other === "True" || other === "False") {
      conversions.booleanText = (conversions.booleanText ?? 0) + 1;
      return jsonValue === (other === "True");
    }
    return false;
  }
  if (typeof jsonValue === "number") {
    if (typeof other === "number") return jsonValue === other;
    if (typeof other === "string" && other.trim() !== "" && Number(other) === jsonValue) {
      conversions.numericText = (conversions.numericText ?? 0) + 1;
      return true;
    }
    return false;
  }
  if (typeof jsonValue === "string") {
    if (typeof other === "string") return jsonValue === other;
    if (typeof other === "number" && String(other) === jsonValue) {
      conversions.numericIdentifierToString = (conversions.numericIdentifierToString ?? 0) + 1;
      return true;
    }
    return false;
  }
  return false;
}

export function buildCandidateContent(sourceRoot: string): CandidateContent {
  const findings: Finding[] = [];
  const stats: Record<string, unknown> = {};
  const sources: SourceArtifact[] = [];
  const bytesOf = new Map<string, Uint8Array>();

  const register = (id: string, file: string, kind: string, title: string, revision: string, parseStatus: string, note?: string) => {
    const path = join(sourceRoot, file);
    if (!existsSync(path)) {
      findings.push({ severity: "error", code: "SOURCE_FILE_MISSING", message: `Supplied file "${file}" was not found under the source root.`, refs: [id] });
      return;
    }
    const bytes = readFileSync(path);
    bytesOf.set(id, bytes);
    sources.push({
      id,
      namespace: "candidate",
      kind,
      title,
      revision,
      owner: "Not stated",
      authority: "supplied-unverified",
      released: false,
      effectiveFrom: null,
      expiresOn: null,
      file: { path: file, sha256: sha256(bytes), bytes: bytes.length, parseStatus },
      note,
    });
  };
  const setStatus = (id: string, parseStatus: string, revision?: string) => {
    const s = sources.find((x) => x.id === id);
    if (s?.file) s.file.parseStatus = parseStatus;
    if (s && revision) s.revision = revision;
  };

  register(
    "CAND-SRC-REGISTRY-JSON",
    ORIGINAL_FILES.registryJson,
    "generated registry export (JSON)",
    "Southwest 737 LOPA registry (normalized JSON)",
    "unknown",
    "pending",
  );
  register(
    "CAND-SRC-TEMPLATE-JSON",
    ORIGINAL_FILES.templateJson,
    "JSON template (not data)",
    "Space-named normalized JSON",
    "none",
    "pending",
    "Not imported.",
  );
  register(
    "CAND-SRC-GEMINI-JSON",
    ORIGINAL_FILES.geminiJson,
    "JSON template (not data)",
    "Gemini code JSON",
    "none",
    "pending",
    "Not imported. Content is treated as reference text and is never executed.",
  );
  register("CAND-SRC-CONFIG-CSV", ORIGINAL_FILES.configCsv, "generated registry export (CSV)", "LOPA configurations CSV", "unknown", "pending");
  register("CAND-SRC-SEATS-CSV", ORIGINAL_FILES.seatsCsv, "generated registry export (CSV)", "LOPA seats CSV", "unknown", "pending");
  register("CAND-SRC-ROWS-XLSX", ORIGINAL_FILES.rowsXlsx, "generated registry export (XLSX)", "LOPA rows workbook", "unknown", "pending");
  register(
    "CAND-SRC-SCHEMA-CSV",
    ORIGINAL_FILES.schemaCsv,
    "descriptive schema summary",
    "Cabin schema architecture CSV",
    "none",
    "read; descriptive, not operational records",
  );
  register(
    "CAND-SRC-RTF",
    ORIGINAL_FILES.rtf,
    "narrative document (RTF)",
    "Southwest Cabin Configuration Standard",
    "not stated",
    "read as narrative evidence; see evidence/extracts",
  );
  register("CAND-SRC-DOCX", ORIGINAL_FILES.docx, "narrative document (DOCX)", "Current Aircraft Seat Configurations", "not stated", "pending");

  const empty: CandidateContent = { sources, subtypes: [], layouts: [], layoutRevisions: [], layoutCategories: [], findings, stats };
  if (findings.some((f) => f.severity === "error")) return empty;

  // Templates: record what they are, never repair them.
  const templateStatus = (id: string): string => {
    try {
      JSON.parse(Buffer.from(bytesOf.get(id)!).toString("utf8"));
      return "parsed as JSON";
    } catch (e) {
      return `invalid JSON: ${(e as Error).message}`;
    }
  };
  const tStatus = templateStatus("CAND-SRC-TEMPLATE-JSON");
  const gStatus = templateStatus("CAND-SRC-GEMINI-JSON");
  setStatus("CAND-SRC-TEMPLATE-JSON", tStatus);
  setStatus("CAND-SRC-GEMINI-JSON", gStatus);
  const identicalTemplates = Buffer.compare(Buffer.from(bytesOf.get("CAND-SRC-TEMPLATE-JSON")!), Buffer.from(bytesOf.get("CAND-SRC-GEMINI-JSON")!)) === 0;
  stats.templates = { spaceNamed: tStatus, gemini: gStatus, byteIdentical: identicalTemplates };
  for (const [id, status] of [
    ["CAND-SRC-TEMPLATE-JSON", tStatus],
    ["CAND-SRC-GEMINI-JSON", gStatus],
  ] as const) {
    findings.push({
      severity: status.startsWith("invalid") ? "info" : "warning",
      code: status.startsWith("invalid") ? "TEMPLATE_NOT_IMPORTED" : "UNEXPECTED_PARSEABLE_TEMPLATE",
      message: status.startsWith("invalid")
        ? `${id} is not valid JSON (${status}). It is recorded as a template, not repaired and not imported.${identicalTemplates ? " It is byte-identical to the other template file." : ""}`
        : `${id} unexpectedly parses as JSON. It is still not imported; review it before relying on any comparison.`,
      refs: [id],
    });
  }

  // Populated registry
  let registry: Json;
  try {
    registry = JSON.parse(Buffer.from(bytesOf.get("CAND-SRC-REGISTRY-JSON")!).toString("utf8")) as Json;
  } catch (e) {
    setStatus("CAND-SRC-REGISTRY-JSON", `invalid JSON: ${(e as Error).message}`);
    findings.push({
      severity: "error",
      code: "REGISTRY_UNREADABLE",
      message: `The populated registry JSON could not be parsed: ${(e as Error).message}`,
      refs: ["CAND-SRC-REGISTRY-JSON"],
    });
    return empty;
  }
  const meta = (registry.schema_metadata ?? {}) as Json;
  const schemaVersion = typeof meta.schema_version === "string" ? meta.schema_version : "unversioned";
  const generatedAt = typeof meta.generated_at_utc === "string" ? meta.generated_at_utc : null;
  setStatus("CAND-SRC-REGISTRY-JSON", "parsed", `schema ${schemaVersion}${generatedAt ? `, generated ${generatedAt}` : ""}`);
  const configs = (registry.lopa_configurations ?? []) as Json[];
  const rows = (registry.lopa_rows ?? []) as Json[];
  const seats = (registry.lopa_seats ?? []) as Json[];
  if (!Array.isArray(configs) || !Array.isArray(rows) || !Array.isArray(seats)) {
    findings.push({
      severity: "error",
      code: "REGISTRY_SHAPE",
      message: "The registry JSON does not contain the three expected arrays.",
      refs: ["CAND-SRC-REGISTRY-JSON"],
    });
    return empty;
  }
  for (const key of Object.keys(registry)) {
    if (!["schema_metadata", "lopa_configurations", "lopa_rows", "lopa_seats"].includes(key)) {
      findings.push({
        severity: "warning",
        code: "UNSUPPORTED_FIELD",
        message: `Registry top-level field "${key}" is not understood and is ignored.`,
        refs: ["CAND-SRC-REGISTRY-JSON"],
      });
    }
  }
  const unknownFields = (records: Json[], known: string[], label: string) => {
    const extra = new Set<string>();
    const missing = new Set<string>();
    for (const r of records) {
      for (const k of Object.keys(r)) if (!known.includes(k)) extra.add(k);
      for (const k of known) if (!(k in r)) missing.add(k);
    }
    for (const k of extra)
      findings.push({
        severity: "warning",
        code: "UNSUPPORTED_FIELD",
        message: `${label} field "${k}" is not understood; it is kept only in the raw record.`,
        refs: ["CAND-SRC-REGISTRY-JSON"],
      });
    for (const k of missing)
      findings.push({ severity: "error", code: "MISSING_FIELD", message: `${label} records are missing field "${k}".`, refs: ["CAND-SRC-REGISTRY-JSON"] });
  };
  unknownFields(configs, CONFIG_FIELDS, "Configuration");
  unknownFields(rows, ROW_FIELDS, "Row");
  unknownFields(seats, SEAT_FIELDS, "Seat");

  // declared record counts
  const entities = (meta.entities ?? {}) as Record<string, Json>;
  for (const [name, actual] of [
    ["lopa_configurations", configs.length],
    ["lopa_rows", rows.length],
    ["lopa_seats", seats.length],
  ] as const) {
    const declared = entities[name]?.record_count;
    if (typeof declared === "number" && declared !== actual) {
      findings.push({
        severity: "error",
        code: "RECORD_COUNT",
        message: `Registry metadata declares ${declared} ${name} records but ${actual} are present.`,
        refs: ["CAND-SRC-REGISTRY-JSON"],
      });
    }
  }
  stats.registry = { schemaVersion, generatedAt, configurations: configs.length, rowRecords: rows.length, seats: seats.length };

  // duplicate keys and foreign keys
  const configIds = new Set<string>();
  for (const c of configs) {
    const id = String(c.lopa_id);
    if (configIds.has(id)) findings.push({ severity: "error", code: "DUPLICATE_KEY", message: `Duplicate configuration ${id}.`, refs: [id] });
    configIds.add(id);
  }
  const rowKeys = new Map<string, Json>();
  for (const r of rows) {
    const key = `${r.lopa_id}|${r.row_number}`;
    if (rowKeys.has(key)) findings.push({ severity: "error", code: "DUPLICATE_KEY", message: `Duplicate row record ${key}.`, refs: [key] });
    rowKeys.set(key, r);
    if (!configIds.has(String(r.lopa_id)))
      findings.push({ severity: "error", code: "ORPHAN", message: `Row ${key} refers to unknown configuration.`, refs: [key] });
  }
  const seatKeys = new Set<string>();
  for (const s of seats) {
    const key = `${s.lopa_id}|${s.row_number}|${s.seat_letter}`;
    if (seatKeys.has(key)) findings.push({ severity: "error", code: "DUPLICATE_KEY", message: `Duplicate seat record ${key}.`, refs: [key] });
    seatKeys.add(key);
    const row = rowKeys.get(`${s.lopa_id}|${s.row_number}`);
    if (!row) findings.push({ severity: "error", code: "ORPHAN", message: `Seat ${key} refers to a row that is not in the registry.`, refs: [key] });
    else if (row.row_exists !== true)
      findings.push({ severity: "error", code: "SEAT_ROW", message: `Seat ${key} sits on a row marked as not existing.`, refs: [key] });
    if (s.seat_code !== `${s.row_number}${s.seat_letter}`)
      findings.push({ severity: "error", code: "SEAT_IDENTITY", message: `Seat ${key} has seat_code "${s.seat_code}".`, refs: [key] });
    if (!isKnownSeatLetter(String(s.seat_letter)))
      findings.push({
        severity: "error",
        code: "SEAT_LETTER_UNKNOWN",
        message: `Seat ${key} has seat letter "${s.seat_letter}", which the geometry frame cannot place (A-F); the seat is left out.`,
        refs: [key],
      });
  }

  // Cross-format agreement (declared, counted conversions; any substantive difference is reported, not resolved)
  const conversions: Record<string, number> = {};
  let compared = 0;
  const mismatch = (where: string, field: string, a: unknown, b: unknown) =>
    findings.push({
      severity: "error",
      code: "CROSS_FORMAT_MISMATCH",
      message: `${where} field "${field}" differs between exports (JSON ${JSON.stringify(a)} vs ${JSON.stringify(b)}). No export is preferred; resolve the difference before import.`,
      refs: [where],
    });
  try {
    const csv = parseCsv(Buffer.from(bytesOf.get("CAND-SRC-CONFIG-CSV")!).toString("utf8"));
    setStatus("CAND-SRC-CONFIG-CSV", `parsed: ${csv.records.length} records, ${csv.headers.length} columns${csv.hasBom ? ", UTF-8 BOM" : ""}`);
    if (csv.records.length !== configs.length)
      findings.push({
        severity: "error",
        code: "CROSS_FORMAT_MISMATCH",
        message: `Configuration CSV has ${csv.records.length} records, JSON has ${configs.length}.`,
        refs: ["CAND-SRC-CONFIG-CSV"],
      });
    const byId = new Map(csv.records.map((r) => [r.lopa_id, r]));
    for (const c of configs) {
      const other = byId.get(String(c.lopa_id));
      if (!other) continue;
      for (const f of csv.headers) {
        if (!(f in c)) continue;
        compared += 1;
        const cell = other[f] === "" ? null : other[f];
        if (!sameValue(c[f], cell, conversions)) mismatch(`configuration ${c.lopa_id}`, f, c[f], other[f]);
      }
    }
  } catch (e) {
    setStatus("CAND-SRC-CONFIG-CSV", `unreadable: ${(e as Error).message}`);
    findings.push({
      severity: "error",
      code: "SOURCE_UNREADABLE",
      message: `Configuration CSV could not be read: ${(e as Error).message}`,
      refs: ["CAND-SRC-CONFIG-CSV"],
    });
  }
  try {
    const csv = parseCsv(Buffer.from(bytesOf.get("CAND-SRC-SEATS-CSV")!).toString("utf8"));
    setStatus("CAND-SRC-SEATS-CSV", `parsed: ${csv.records.length} records, ${csv.headers.length} columns${csv.hasBom ? ", UTF-8 BOM" : ""}`);
    if (csv.records.length !== seats.length)
      findings.push({
        severity: "error",
        code: "CROSS_FORMAT_MISMATCH",
        message: `Seat CSV has ${csv.records.length} records, JSON has ${seats.length}.`,
        refs: ["CAND-SRC-SEATS-CSV"],
      });
    const byKey = new Map(csv.records.map((r) => [`${r.lopa_id}|${r.row_number}|${r.seat_letter}`, r]));
    for (const s of seats) {
      const other = byKey.get(`${s.lopa_id}|${s.row_number}|${s.seat_letter}`);
      if (!other) {
        findings.push({
          severity: "error",
          code: "CROSS_FORMAT_MISMATCH",
          message: `Seat ${s.lopa_id} ${s.seat_code} is missing from the seat CSV.`,
          refs: ["CAND-SRC-SEATS-CSV"],
        });
        continue;
      }
      for (const f of csv.headers) {
        if (!(f in s)) continue;
        compared += 1;
        const cell = other[f] === "" ? null : other[f];
        if (!sameValue(s[f], cell, conversions)) mismatch(`seat ${s.lopa_id} ${s.seat_code}`, f, s[f], other[f]);
      }
    }
  } catch (e) {
    setStatus("CAND-SRC-SEATS-CSV", `unreadable: ${(e as Error).message}`);
    findings.push({
      severity: "error",
      code: "SOURCE_UNREADABLE",
      message: `Seat CSV could not be read: ${(e as Error).message}`,
      refs: ["CAND-SRC-SEATS-CSV"],
    });
  }
  try {
    const book = readXlsx(bytesOf.get("CAND-SRC-ROWS-XLSX")!);
    const sheet = book.sheets[0];
    const formulas = book.sheets.reduce((n, s) => n + s.cells.filter((c) => c.hasFormula).length, 0);
    setStatus(
      "CAND-SRC-ROWS-XLSX",
      `parsed: ${book.sheets.length} sheet(s) [${book.sheets.map((s) => `${s.name}:${s.state}`).join(", ")}], ${sheet ? sheet.rows.length - 1 : 0} data rows, ${formulas} formulas, macros ${book.hasMacros ? "present (not run)" : "absent"}, external links ${book.hasExternalLinks ? "present (not opened)" : "absent"}`,
    );
    if (sheet) {
      const headers = (sheet.rows[0] ?? []).map((h) => String(h));
      const data = sheet.rows.slice(1);
      if (data.length !== rows.length)
        findings.push({
          severity: "error",
          code: "CROSS_FORMAT_MISMATCH",
          message: `Rows workbook has ${data.length} data rows, JSON has ${rows.length}.`,
          refs: ["CAND-SRC-ROWS-XLSX"],
        });
      const idCol = headers.indexOf("lopa_id");
      const rowCol = headers.indexOf("row_number");
      const byKey = new Map(data.map((r) => [`${r[idCol]}|${r[rowCol]}`, r]));
      for (const r of rows) {
        const other = byKey.get(`${r.lopa_id}|${r.row_number}`);
        if (!other) {
          findings.push({
            severity: "error",
            code: "CROSS_FORMAT_MISMATCH",
            message: `Row ${r.lopa_id} ${r.row_number} is missing from the workbook.`,
            refs: ["CAND-SRC-ROWS-XLSX"],
          });
          continue;
        }
        headers.forEach((f, col) => {
          if (!(f in r)) return;
          compared += 1;
          if (!sameValue(r[f], other[col] ?? null, conversions)) mismatch(`row ${r.lopa_id} ${r.row_number}`, f, r[f], other[col]);
        });
      }
    }
  } catch (e) {
    setStatus("CAND-SRC-ROWS-XLSX", `unreadable: ${(e as Error).message}`);
    findings.push({
      severity: "error",
      code: "SOURCE_UNREADABLE",
      message: `Rows workbook could not be read: ${(e as Error).message}`,
      refs: ["CAND-SRC-ROWS-XLSX"],
    });
  }
  stats.crossFormat = { attributeValuesCompared: compared, conversions };
  findings.push({
    severity: "info",
    code: "CROSS_FORMAT_AGREEMENT",
    message: `${compared} shared attribute values compared across the JSON, CSV and XLSX exports (conversions applied: ${JSON.stringify(conversions)}). Agreement between exports of one generated registry is not independent verification.`,
    refs: ["CAND-SRC-REGISTRY-JSON", "CAND-SRC-CONFIG-CSV", "CAND-SRC-SEATS-CSV", "CAND-SRC-ROWS-XLSX"],
  });

  // Layouts
  const subtypes = new Map<string, AircraftSubtype>();
  const layouts: Layout[] = [];
  const layoutRevisions: LayoutRevision[] = [];
  configs.forEach((c, configIndex) => {
    const lopaId = String(c.lopa_id);
    const model = String(c.boeing_model);
    const subtypeId = `CAND-${model
      .replace(/^Boeing\s+/, "")
      .replace(/\s+/g, "-")
      .toUpperCase()}`;
    if (!subtypes.has(subtypeId)) subtypes.set(subtypeId, { id: subtypeId, namespace: "candidate", name: `${model} (as named by the registry)` });
    const layoutId = `CAND-${lopaId}`;
    layouts.push({ id: layoutId, namespace: "candidate", subtypeId, name: `${model} - ${c.configuration_name}`, note: String(c.notes ?? "") });

    const configRows = rows
      .map((r, i) => ({ r, i }))
      .filter((x) => String(x.r.lopa_id) === lopaId)
      .sort((a, b) => Number(a.r.row_number) - Number(b.r.row_number));
    let order = 0;
    const rowLabels: RowLabel[] = configRows.map(({ r, i }) => ({
      printedLabel: String(r.row_number),
      exists: r.row_exists === true,
      physicalOrder: r.row_exists === true ? ++order : null,
      raw: r,
      locator: `${ORIGINAL_FILES.registryJson}#/lopa_rows/${i}`,
    }));
    const physical = new Map(rowLabels.map((r) => [r.printedLabel, r.physicalOrder]));
    // a seat whose letter cannot be placed is reported above (SEAT_LETTER_UNKNOWN) and left out here
    const configSeats = seats.map((s, i) => ({ s, i })).filter((x) => String(x.s.lopa_id) === lopaId && isKnownSeatLetter(String(x.s.seat_letter)));
    const elrRaw = String(c.elr_pitch_inches ?? "");
    const locations: CabinLocation[] = configSeats.map(({ s, i }) => {
      const letter = String(s.seat_letter);
      const printedRow = String(s.row_number);
      const code = `${printedRow}${letter}`;
      const physicalRow = physical.get(printedRow) ?? 0;
      const position = String(s.seat_position_type).toUpperCase();
      return {
        id: `SEAT:${code}`,
        kind: "SEAT",
        label: `Seat ${code}`,
        componentIds: ["CUSHION", "BACKREST"],
        seat: {
          printedRow,
          letter,
          code,
          side: sideOf(letter),
          physicalRow,
          positionType: position === "WINDOW" || position === "MIDDLE" || position === "AISLE" ? position : null,
          commercialTier: typeof s.commercial_tier === "string" ? s.commercial_tier : null,
          pitch: typeof s.pitch_range_inches === "string" ? pitchClaim(s.pitch_range_inches, elrRaw) : null,
          width: widthClaim(s.effective_width_inches),
          exitRow: typeof s.is_exit_seat === "boolean" ? s.is_exit_seat : null,
          bulkhead: typeof s.is_bulkhead_seat === "boolean" ? s.is_bulkhead_seat : null,
          maintenanceZone: null,
          seatGroup: null,
          raw: s,
          locator: `${ORIGINAL_FILES.registryJson}#/lopa_seats/${i}`,
        },
        placement: seatPlacement(physicalRow, letter),
      };
    });

    // row-level claims against seat records
    for (const { r } of configRows) {
      const label = String(r.row_number);
      const present = locations.filter((l) => l.seat!.printedRow === label).map((l) => l.seat!.letter);
      if (typeof r.active_seat_count === "number" && r.active_seat_count !== present.length) {
        findings.push({
          severity: "error",
          code: "ROW_SEAT_COUNT",
          message: `${lopaId} row ${label} declares ${r.active_seat_count} active seats but ${present.length} seat records exist.`,
          refs: [`${lopaId}|${label}`],
        });
      }
      const omitted = String(r.omitted_seat_letters ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      const expectedOmitted = ["A", "B", "C", "D", "E", "F"].filter((l) => !present.includes(l));
      if (omitted.join(",") !== expectedOmitted.join(",")) {
        findings.push({
          severity: "error",
          code: "ROW_OMITTED_LETTERS",
          message: `${lopaId} row ${label} lists omitted letters "${omitted.join(",")}" but seat records imply "${expectedOmitted.join(",")}".`,
          refs: [`${lopaId}|${label}`],
        });
      }
      // partial-side bulkhead ambiguity: the row flag and the seat flags describe different scopes
      const flags = locations.filter((l) => l.seat!.printedRow === label).map((l) => l.seat!.bulkhead);
      const bulkheadSeats = flags.filter((f) => f === true).length;
      if (flags.length > 0 && ((r.is_bulkhead_row === true && bulkheadSeats !== flags.length) || (r.is_bulkhead_row === false && bulkheadSeats > 0))) {
        findings.push({
          severity: "conflict",
          code: "BULKHEAD_PARTIAL_SIDE",
          message: `${lopaId} row ${label}: row-level bulkhead flag is ${String(r.is_bulkhead_row)} but ${bulkheadSeats} of ${flags.length} seats are bulkhead seats. Seat-level flags are kept per seat; the row flag is never applied to the whole row.`,
          refs: [`${lopaId}|${label}`],
        });
      }
    }
    const notes = [
      "Candidate layout from a supplied, unverified registry export. Not assigned to any tail; no approved dated tail assignment was supplied.",
      "No approved parts, applicability or substitute catalogue was supplied: every component is unresolved.",
      "Floor panel and overhead-bin module maps were not supplied. The 3D floor and bins are illustrative and not selectable.",
      "Row spacing and seat sizes are a uniform illustrative approximation, not derived from the pitch claims.",
    ];
    const splitRows = rowLabels
      .filter((r) => r.exists)
      .filter((r) => {
        const inRow = locations.filter((l) => l.seat!.printedRow === r.printedLabel);
        const left = new Set(inRow.filter((l) => l.seat!.side === "L").map((l) => l.seat!.commercialTier));
        const right = new Set(inRow.filter((l) => l.seat!.side === "R").map((l) => l.seat!.commercialTier));
        return left.size > 0 && right.size > 0 && [...left].some((t) => !right.has(t));
      })
      .map((r) => r.printedLabel);
    if (splitRows.length)
      notes.push(`Rows with different commercial tiers on the left and right blocks: ${splitRows.join(", ")}. Tier is held per seat, never per row.`);
    const skipped = rowLabels.filter((r) => !r.exists).map((r) => r.printedLabel);
    if (skipped.length) notes.push(`Printed row labels that do not physically exist: ${skipped.join(", ")}.`);

    layoutRevisions.push({
      id: `${layoutId}@${schemaVersion}`,
      layoutId,
      revision: schemaVersion,
      namespace: "candidate",
      status: "candidate",
      subtypeId,
      name: `${lopaId}: ${model}, ${c.configuration_name}`,
      seatSetStatus: "complete",
      declaredSeatCount: typeof c.total_seats === "number" ? c.total_seats : null,
      declaredTierTotals: {
        "Extra Legroom": Number(c.extra_legroom_seats),
        Preferred: Number(c.preferred_seats),
        Standard: Number(c.standard_seats),
      },
      rows: rowLabels,
      locations,
      floorMapStatus: "not-supplied",
      binMapStatus: "not-supplied",
      geometry: geometryDeclaration(order),
      sourceId: "CAND-SRC-REGISTRY-JSON",
      raw: { ...c, locator: `${ORIGINAL_FILES.registryJson}#/lopa_configurations/${configIndex}` },
      notes,
    });
  });

  // Narrative layout categories from the DOCX, each quote verified against the document bytes.
  const layoutCategories: LayoutCategory[] = [];
  try {
    const paragraphs = readDocxParagraphs(bytesOf.get("CAND-SRC-DOCX")!).map((p) => ({ ...p, norm: normaliseForQuote(p.text) }));
    setStatus("CAND-SRC-DOCX", `parsed: ${paragraphs.filter((p) => p.text.trim()).length} non-empty paragraphs`);
    const curatedPath = join(dirname(fileURLToPath(import.meta.url)), "curated", "docx-layout-categories.json");
    const curated = JSON.parse(readFileSync(curatedPath, "utf8")) as {
      id: string;
      name: string;
      claimedSeatCount: number | null;
      crosswalk: string[];
      quotes: string[];
      note: string;
    }[];
    const revisionByLayout = new Map(layoutRevisions.map((r) => [r.layoutId, r.id]));
    for (const c of curated) {
      const claims: LayoutCategory["claims"] = [];
      for (const quote of c.quotes) {
        const hit = paragraphs.find((p) => p.norm.includes(normaliseForQuote(quote)));
        if (!hit) {
          findings.push({
            severity: "error",
            code: "QUOTE_NOT_FOUND",
            message: `Curated quote "${quote}" for ${c.id} was not found in the supplied DOCX. Nothing is assumed about its contents.`,
            refs: [c.id],
          });
          continue;
        }
        claims.push({ text: hit.text.trim(), sourceId: "CAND-SRC-DOCX", locator: `${ORIGINAL_FILES.docx}#${hit.locator}` });
      }
      const crosswalk = c.crosswalk
        .map((layoutId) => revisionByLayout.get(layoutId))
        .filter((id): id is string => Boolean(id))
        .map((layoutRevisionId) => ({ layoutRevisionId, basis: "inferred" as const }));
      if (crosswalk.length !== c.crosswalk.length) {
        findings.push({
          severity: "error",
          code: "CROSSWALK",
          message: `Layout category ${c.id} crosswalks to a registry configuration that is not present.`,
          refs: [c.id],
        });
      }
      layoutCategories.push({
        id: c.id,
        namespace: "candidate",
        name: c.name,
        claimedSeatCount: c.claimedSeatCount,
        seatSetStatus: crosswalk.length > 0 ? "matched-to-candidate" : "not-supplied",
        crosswalk,
        claims,
        note: c.note,
      });
      if (crosswalk.length === 0) {
        findings.push({
          severity: "conflict",
          code: "LAYOUT_NOT_SUPPLIED",
          message: `${c.name}: described in the DOCX but no seat set is supplied. Kept as an explicit unresolved category; no layout is derived.`,
          refs: [c.id],
        });
      } else if (crosswalk.length > 1) {
        findings.push({
          severity: "info",
          code: "GRAIN_DIFFERENCE",
          message: `${c.name}: one document category maps (by inference) to ${crosswalk.length} registry configurations. Both records are kept.`,
          refs: [c.id],
        });
      }
    }
  } catch (e) {
    setStatus("CAND-SRC-DOCX", `unreadable: ${(e as Error).message}`);
    findings.push({ severity: "error", code: "SOURCE_UNREADABLE", message: `The DOCX could not be read: ${(e as Error).message}`, refs: ["CAND-SRC-DOCX"] });
  }

  findings.push({
    severity: "conflict",
    code: "AIRLINE_DATA_NOT_SUPPLIED",
    message:
      "No approved dated tail assignment, parts/applicability/substitute catalogue, floor or bin map, coordinate frame, cabin height or image-to-layout mapping was supplied. The 'accepted' namespace is empty and candidate layouts stay unassigned.",
  });

  return { sources, subtypes: [...subtypes.values()], layouts, layoutRevisions, layoutCategories, findings, stats };
}
