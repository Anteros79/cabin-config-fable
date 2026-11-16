import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { geometryDeclaration, isKnownSeatLetter, seatPlacement, sideOf } from "../domain/geometry.ts";
import type { AircraftSubtype, CabinLocation, Finding, Layout, LayoutCategory, LayoutRevision, RangeClaim, RowLabel, SourceArtifact } from "../domain/types.ts";
import { checkOriginals, ORIGINAL_FILES, ORIGINALS_MANIFEST_PATH } from "./originals.ts";
import { parseCsv } from "./readers/csv.ts";
import { normaliseForQuote, readDocxParagraphs } from "./readers/docx.ts";
import { columnName, readXlsx } from "./readers/xlsx.ts";

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

/** Primary keys as the registry's schema_metadata declares them for each entity. */
const CONFIG_KEY = ["lopa_id"] as const;
const ROW_KEY = ["lopa_id", "row_number"] as const;
const SEAT_KEY = ["lopa_id", "row_number", "seat_letter"] as const;

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

type ClaimDefaults = Pick<RangeClaim, "unit" | "measurementKind">;

/** One number as the registry writes it: digits with an optional decimal part, no sign or exponent. */
const CLAIM_NUMBER = String.raw`\d+(?:\.\d+)?`;
/** `N` or `N-M` (hyphen, en dash or em dash, optional spaces), once the qualifier and unit are stripped. */
const CLAIM_RANGE = new RegExp(`^(${CLAIM_NUMBER})(?:\\s*[-\u2013\u2014]\\s*(${CLAIM_NUMBER}))?$`);

/**
 * Read a pitch or width value as a range claim. Blank values are no claim and no problem. A finite number is an
 * exact claim. A string may carry a leading `~` or `≈` (approximate) and a trailing `"`, `in`, `in.` or `inches`.
 * Anything else is no claim, with the problem named: "range reversed" or "unparsed".
 */
export function parseRangeClaim(raw: unknown, defaults: ClaimDefaults): { claim: RangeClaim | null; problem: string | null } {
  if (raw === null || raw === undefined || raw === "") return { claim: null, problem: null };
  const claim = (min: number, max: number, approximate: boolean): RangeClaim => ({
    raw: String(raw),
    min,
    max,
    unit: defaults.unit,
    approximate,
    measurementKind: defaults.measurementKind,
  });
  if (typeof raw === "number") return Number.isFinite(raw) ? { claim: claim(raw, raw, false), problem: null } : { claim: null, problem: "unparsed" };
  if (typeof raw !== "string") return { claim: null, problem: "unparsed" };
  let text = raw.trim();
  const approximate = text.startsWith("~") || text.startsWith("\u2248");
  if (approximate) text = text.slice(1).trimStart();
  text = text.replace(/(?:"|inches|in\.|in)$/, "").trimEnd();
  const m = CLAIM_RANGE.exec(text);
  if (!m) return { claim: null, problem: "unparsed" };
  const min = Number(m[1]);
  const max = Number(m[2] ?? m[1]);
  if (min > max) return { claim: null, problem: "range reversed" };
  return { claim: claim(min, max, approximate), problem: null };
}

/** True only when `configText` has `~` or `≈` immediately followed by exactly `value` (not a longer number). */
export function isApproximate(configText: string, value: number): boolean {
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`[~\u2248]${escaped}(?![\\d.])`).test(configText);
}

const PITCH_DEFAULTS: ClaimDefaults = { unit: "in", measurementKind: "seat pitch (as claimed by the registry)" };
const WIDTH_DEFAULTS: ClaimDefaults = { unit: "in", measurementKind: "unspecified" };
const WIDTH_NOTE =
  'Source field "effective_width_inches". The sources mix seat width and shoulder/armrest clearance, so the measurement kind is not established.';

/** Unreadable measurement values, counted per distinct raw value, so each raises one finding. */
type ClaimProblems = Map<string, { raw: unknown; problem: string; seats: number }>;

function readClaim(raw: unknown, defaults: ClaimDefaults, problems: ClaimProblems): RangeClaim | null {
  const { claim, problem } = parseRangeClaim(raw, defaults);
  if (problem !== null) {
    const key = JSON.stringify(raw) ?? String(raw);
    const seen = problems.get(key);
    if (seen) seen.seats += 1;
    else problems.set(key, { raw, problem, seats: 1 });
  }
  return claim;
}

function pitchClaim(raw: unknown, configLevelRaw: string, problems: ClaimProblems): RangeClaim | null {
  const claim = readClaim(raw, PITCH_DEFAULTS, problems);
  if (claim === null) return null;
  // The registry's configuration record qualifies some figures with "~"; the seat record drops it.
  const qualified = !claim.approximate && claim.min !== null && claim.min === claim.max && isApproximate(configLevelRaw, claim.min);
  return {
    ...claim,
    approximate: claim.approximate || qualified,
    note: qualified
      ? `Seat record states "${claim.raw}" as exact, but the configuration record qualifies it as approximate ("${configLevelRaw}"). Treated as approximate.`
      : undefined,
  };
}

function widthClaim(raw: unknown, problems: ClaimProblems): RangeClaim | null {
  const claim = readClaim(raw, WIDTH_DEFAULTS, problems);
  return claim === null ? null : { ...claim, note: WIDTH_NOTE };
}

/** Plain decimal text: no sign other than a leading minus, no leading zeros, no exponent, hex or padding. */
const DECIMAL_TEXT = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** A string equals a number only when it is plain decimal text with the same numeric value. */
function decimalTextEquals(text: string, value: number): boolean {
  return DECIMAL_TEXT.test(text) && Number(text) === value;
}

/**
 * Compare a JSON value with its CSV/XLSX counterpart under declared, counted conversions. A value field accepts
 * numerically equal decimal text ("1.50" equals 1.5). An identifier field (a registry primary-key field) compares
 * as exact strings: 16 equals "16", but "1.50" does not equal 1.5.
 */
export function sameValue(jsonValue: unknown, other: unknown, conversions: Record<string, number> = {}, kind: "value" | "identifier" = "value"): boolean {
  if (kind === "identifier" && (typeof jsonValue === "string" || typeof jsonValue === "number") && (typeof other === "string" || typeof other === "number")) {
    if (String(jsonValue) !== String(other)) return false;
    if (typeof jsonValue !== typeof other) {
      const counter = typeof jsonValue === "number" ? "numericText" : "numericIdentifierToString";
      conversions[counter] = (conversions[counter] ?? 0) + 1;
    }
    return true;
  }
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
    if (typeof other === "string" && decimalTextEquals(other, jsonValue)) {
      conversions.numericText = (conversions.numericText ?? 0) + 1;
      return true;
    }
    return false;
  }
  if (typeof jsonValue === "string") {
    if (typeof other === "string") return jsonValue === other;
    if (typeof other === "number" && decimalTextEquals(jsonValue, other)) {
      conversions.numericIdentifierToString = (conversions.numericIdentifierToString ?? 0) + 1;
      return true;
    }
    return false;
  }
  return false;
}

const MAX_LISTED_KEYS = 10;

function listKeys(keys: readonly string[]): string {
  const shown = keys.slice(0, MAX_LISTED_KEYS).join(", ");
  return keys.length > MAX_LISTED_KEYS ? `${shown} and ${keys.length - MAX_LISTED_KEYS} more` : shown;
}

/** Keys that occur more than once among `records`, in first-seen order. */
function duplicateKeys(records: readonly Json[], keyOf: (record: Json) => string): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const record of records) {
    const key = keyOf(record);
    if (seen.has(key)) duplicated.add(key);
    seen.add(key);
  }
  return [...duplicated];
}

/**
 * Compare one export table with the registry JSON, value by value, and return the number of values
 * compared. Every structural difference is a CROSS_FORMAT_MISMATCH error: a header set other than
 * `expectedFields`, a duplicate key on either side, a key present on one side only, a differing value.
 * A missing record or column is reported, never skipped silently.
 */
function compareTable(args: {
  sourceId: string;
  label: string;
  expectedFields: readonly string[];
  /** The registry's primary-key fields for this table: records are matched on them and they compare as exact strings. */
  keyFields: readonly string[];
  reference: Json[];
  other: { headers: string[]; records: Json[] };
  conversions: Record<string, number>;
  findings: Finding[];
}): number {
  const { sourceId, label, expectedFields, keyFields, reference, other, conversions, findings } = args;
  const keyOf = (record: Json) => keyFields.map((f) => String(record[f])).join("|");
  const mismatch = (message: string, refs: string[] = [sourceId]) => findings.push({ severity: "error", code: "CROSS_FORMAT_MISMATCH", message, refs });

  const missingColumns = expectedFields.filter((f) => !other.headers.includes(f));
  const extraColumns = [...new Set(other.headers.filter((h) => !expectedFields.includes(h)))];
  const repeatedColumns = [...new Set(other.headers.filter((h, i) => other.headers.indexOf(h) !== i))];
  if (missingColumns.length || extraColumns.length || repeatedColumns.length) {
    const parts = [
      missingColumns.length ? `missing: ${missingColumns.join(", ")}` : "",
      extraColumns.length ? `extra: ${extraColumns.join(", ")}` : "",
      repeatedColumns.length ? `repeated: ${repeatedColumns.join(", ")}` : "",
    ].filter(Boolean);
    mismatch(
      `${label} columns do not match the registry fields (${parts.join("; ")}). The export was not compared column by column; resolve the difference before import.`,
    );
  }

  for (const [side, records] of [
    ["the JSON registry", reference],
    [`the ${label}`, other.records],
  ] as const) {
    const duplicated = duplicateKeys(records, keyOf);
    if (duplicated.length) mismatch(`${label}: ${duplicated.length} key(s) occur more than once in ${side}: ${listKeys(duplicated)}.`);
  }

  const otherByKey = new Map<string, Json>();
  for (const record of other.records) {
    const key = keyOf(record);
    if (!otherByKey.has(key)) otherByKey.set(key, record);
  }
  const referenceKeys = new Set(reference.map(keyOf));
  const onlyInReference = [...referenceKeys].filter((k) => !otherByKey.has(k));
  const onlyInOther = [...otherByKey.keys()].filter((k) => !referenceKeys.has(k));
  if (onlyInReference.length) mismatch(`${label}: ${onlyInReference.length} key(s) only in the JSON registry: ${listKeys(onlyInReference)}.`);
  if (onlyInOther.length) mismatch(`${label}: ${onlyInOther.length} key(s) only in the ${label}: ${listKeys(onlyInOther)}.`);

  const comparable = expectedFields.filter((f) => other.headers.includes(f));
  let compared = 0;
  for (const record of reference) {
    const key = keyOf(record);
    // A record without a counterpart is reported above as a key on one side only; it leaves the count short.
    const counterpart = otherByKey.get(key);
    if (counterpart === undefined) continue;
    for (const field of comparable) {
      compared += 1;
      const cell = counterpart[field] ?? null;
      if (!sameValue(record[field], cell, conversions, keyFields.includes(field) ? "identifier" : "value"))
        mismatch(
          `${label} ${key} field "${field}" differs between exports (JSON ${JSON.stringify(record[field])} vs ${JSON.stringify(cell)}). No export is preferred; resolve the difference before import.`,
          [sourceId, key],
        );
    }
  }
  return compared;
}

export interface CandidateOptions {
  /** Stage originals that differ from the manifest, reporting the difference as a warning instead of an error. */
  acceptChanged?: boolean;
  manifestPath?: string;
}

const NOT_READ = "not read: file missing";
const RTF_STATUS = "not parsed: narrative evidence, hash recorded";
/** Replaced by every path that parses the file; it remains only when the import stopped on an unexpected error. */
const NOT_REACHED = "invalid: not parsed, the import stopped before reaching this file";

const isPlainObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function describeJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

const REGISTRY_ARRAYS = ["lopa_configurations", "lopa_rows", "lopa_seats"] as const;

interface Registry {
  schema_metadata: Json;
  lopa_configurations: Json[];
  lopa_rows: Json[];
  lopa_seats: Json[];
  [key: string]: unknown;
}

/** Every way `value` differs from the registry shape the importer reads, one sentence each; empty when it fits. */
export function registryShapeProblems(value: unknown): string[] {
  if (!isPlainObject(value)) return [`The registry JSON root is ${describeJson(value)}, not an object.`];
  const problems: string[] = [];
  if (!isPlainObject(value.schema_metadata))
    problems.push(
      `Registry field "schema_metadata" is ${value.schema_metadata === undefined ? "missing" : describeJson(value.schema_metadata)}, not an object.`,
    );
  for (const key of REGISTRY_ARRAYS) {
    const list = value[key];
    if (!Array.isArray(list)) {
      problems.push(`Registry field "${key}" is ${list === undefined ? "missing" : describeJson(list)}, not an array.`);
      continue;
    }
    const bad = list.flatMap((item, i) => (isPlainObject(item) ? [] : [i]));
    if (bad.length) problems.push(`Registry field "${key}" has ${bad.length} element(s) that are not objects (first at index ${bad[0]}).`);
  }
  return problems;
}

/**
 * Stage the supplied registry as candidate content. Never throws: every problem, including an
 * unexpected one (IMPORT_INTERNAL), is a finding, and every source ends with a real parse status.
 */
export function buildCandidateContent(sourceRoot: string, options: CandidateOptions = {}): CandidateContent {
  const content: CandidateContent = { sources: [], subtypes: [], layouts: [], layoutRevisions: [], layoutCategories: [], findings: [], stats: {} };
  try {
    stageCandidate(sourceRoot, options, content);
    content.findings.push({
      severity: "conflict",
      code: "AIRLINE_DATA_NOT_SUPPLIED",
      message:
        "No approved dated tail assignment, parts/applicability/substitute catalogue, floor or bin map, coordinate frame, cabin height or image-to-layout mapping was supplied. The 'accepted' namespace is empty and candidate layouts stay unassigned.",
    });
  } catch (e) {
    content.findings.push({
      severity: "error",
      code: "IMPORT_INTERNAL",
      message: `The candidate import stopped on an unexpected error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  return content;
}

function stageCandidate(sourceRoot: string, options: CandidateOptions, out: CandidateContent): void {
  const { findings, stats, sources } = out;
  const bytesOf = new Map<string, Uint8Array>();
  findings.push(...checkOriginals(sourceRoot, options.manifestPath ?? ORIGINALS_MANIFEST_PATH, { acceptChanged: options.acceptChanged ?? false }));

  // A path that is not a regular file is reported by checkOriginals (SOURCE_FILE_MISSING) and recorded here as not read.
  const register = (id: string, file: string, kind: string, title: string, revision: string, note?: string) => {
    const path = join(sourceRoot, file);
    let isFile = false;
    try {
      isFile = statSync(path).isFile();
    } catch {
      isFile = false;
    }
    let bytes: Uint8Array | null = null;
    let parseStatus = isFile ? NOT_REACHED : NOT_READ;
    if (isFile) {
      try {
        bytes = readFileSync(path);
        bytesOf.set(id, bytes);
      } catch (e) {
        parseStatus = `invalid: could not be read (${(e as Error).message})`;
        findings.push({
          severity: "error",
          code: "SOURCE_UNREADABLE",
          message: `Supplied file "${file}" could not be read: ${(e as Error).message}`,
          refs: [id],
        });
      }
    }
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
      file: { path: file, sha256: bytes ? sha256(bytes) : "", bytes: bytes?.length ?? 0, parseStatus },
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
  );
  register("CAND-SRC-TEMPLATE-JSON", ORIGINAL_FILES.templateJson, "JSON template (not data)", "Space-named normalized JSON", "none", "Not imported.");
  register(
    "CAND-SRC-GEMINI-JSON",
    ORIGINAL_FILES.geminiJson,
    "JSON template (not data)",
    "Gemini code JSON",
    "none",
    "Not imported. Content is treated as reference text and is never executed.",
  );
  register("CAND-SRC-CONFIG-CSV", ORIGINAL_FILES.configCsv, "generated registry export (CSV)", "LOPA configurations CSV", "unknown");
  register("CAND-SRC-SEATS-CSV", ORIGINAL_FILES.seatsCsv, "generated registry export (CSV)", "LOPA seats CSV", "unknown");
  register("CAND-SRC-ROWS-XLSX", ORIGINAL_FILES.rowsXlsx, "generated registry export (XLSX)", "LOPA rows workbook", "unknown");
  register("CAND-SRC-SCHEMA-CSV", ORIGINAL_FILES.schemaCsv, "descriptive schema summary", "Cabin schema architecture CSV", "none");
  register("CAND-SRC-RTF", ORIGINAL_FILES.rtf, "narrative document (RTF)", "Southwest Cabin Configuration Standard", "not stated");
  register("CAND-SRC-DOCX", ORIGINAL_FILES.docx, "narrative document (DOCX)", "Current Aircraft Seat Configurations", "not stated");
  // The RTF is narrative evidence: its bytes are hashed and verified, never parsed.
  if (bytesOf.has("CAND-SRC-RTF")) setStatus("CAND-SRC-RTF", RTF_STATUS);

  // Text sources must be valid UTF-8; a byte-order mark is kept so the CSV reader can report it.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const textOf = (id: string, label: string): string | null => {
    const bytes = bytesOf.get(id);
    if (!bytes) return null;
    try {
      return decoder.decode(bytes);
    } catch {
      setStatus(id, "invalid: not valid UTF-8 text");
      findings.push({ severity: "error", code: "SOURCE_ENCODING", message: `${label} is not valid UTF-8 text; it was not parsed.`, refs: [id] });
      return null;
    }
  };

  // Templates: record what they are, never repair them. `jsonError` is null when the file parses.
  const readTemplate = (id: string, label: string): { status: string; jsonError: string | null } | null => {
    const text = textOf(id, label);
    if (text === null) return null;
    try {
      JSON.parse(text);
      return { status: "parsed: valid JSON (a template; not imported)", jsonError: null };
    } catch (e) {
      const jsonError = (e as Error).message;
      return { status: `invalid: not valid JSON (${jsonError})`, jsonError };
    }
  };
  const spaceNamed = readTemplate("CAND-SRC-TEMPLATE-JSON", "The space-named template JSON");
  const gemini = readTemplate("CAND-SRC-GEMINI-JSON", "The Gemini template JSON");
  const tBytes = bytesOf.get("CAND-SRC-TEMPLATE-JSON");
  const gBytes = bytesOf.get("CAND-SRC-GEMINI-JSON");
  const identicalTemplates = tBytes !== undefined && gBytes !== undefined && Buffer.compare(Buffer.from(tBytes), Buffer.from(gBytes)) === 0;
  for (const [id, template] of [
    ["CAND-SRC-TEMPLATE-JSON", spaceNamed],
    ["CAND-SRC-GEMINI-JSON", gemini],
  ] as const) {
    if (template === null) continue;
    setStatus(id, template.status);
    findings.push(
      template.jsonError !== null
        ? {
            severity: "info",
            code: "TEMPLATE_NOT_IMPORTED",
            message: `${id} is not valid JSON (${template.jsonError}). It is recorded as a template, not repaired and not imported.${identicalTemplates ? " It is byte-identical to the other template file." : ""}`,
            refs: [id],
          }
        : {
            severity: "warning",
            code: "UNEXPECTED_PARSEABLE_TEMPLATE",
            message: `${id} unexpectedly parses as JSON. It is still not imported; review it before relying on any comparison.`,
            refs: [id],
          },
    );
  }

  const statusOf = (id: string) => sources.find((x) => x.id === id)?.file?.parseStatus;
  stats.templates = { spaceNamed: statusOf("CAND-SRC-TEMPLATE-JSON"), gemini: statusOf("CAND-SRC-GEMINI-JSON"), byteIdentical: identicalTemplates };

  // Populated registry: parsed, then its shape checked before any property is read.
  let registry: Registry | null = null;
  const registryText = textOf("CAND-SRC-REGISTRY-JSON", "The registry JSON");
  if (registryText !== null) {
    let parsed: unknown;
    let parsedOk = true;
    try {
      parsed = JSON.parse(registryText);
    } catch (e) {
      parsedOk = false;
      setStatus("CAND-SRC-REGISTRY-JSON", `invalid: not valid JSON (${(e as Error).message})`);
      findings.push({
        severity: "error",
        code: "REGISTRY_UNREADABLE",
        message: `The populated registry JSON could not be parsed: ${(e as Error).message}`,
        refs: ["CAND-SRC-REGISTRY-JSON"],
      });
    }
    if (parsedOk) {
      const problems = registryShapeProblems(parsed);
      for (const message of problems) findings.push({ severity: "error", code: "REGISTRY_SHAPE", message, refs: ["CAND-SRC-REGISTRY-JSON"] });
      if (problems.length) setStatus("CAND-SRC-REGISTRY-JSON", `invalid: ${problems.length} registry shape problem(s); not imported`);
      else registry = parsed as Registry;
    }
  }

  // Exports and the schema summary are parsed on their own, whatever the state of the registry.
  const csvSource = (id: string, label: string, suffix = "") => {
    const text = textOf(id, label);
    if (text === null) return null;
    try {
      const csv = parseCsv(text);
      setStatus(id, `parsed: ${csv.records.length} records, ${csv.headers.length} columns${csv.hasBom ? ", UTF-8 BOM" : ""}${suffix}`);
      // an empty CSV cell stands for a JSON null (or, as a counted conversion, an empty string)
      const records = csv.records.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === "" ? null : v])));
      return { headers: csv.headers, records };
    } catch (e) {
      setStatus(id, `invalid: ${(e as Error).message}`);
      findings.push({ severity: "error", code: "SOURCE_UNREADABLE", message: `${label} could not be read: ${(e as Error).message}`, refs: [id] });
      return null;
    }
  };
  const configTable = csvSource("CAND-SRC-CONFIG-CSV", "Configuration CSV");
  const seatTable = csvSource("CAND-SRC-SEATS-CSV", "Seat CSV");
  csvSource("CAND-SRC-SCHEMA-CSV", "Schema summary CSV", "; descriptive, not operational records");

  let rowTable: { headers: string[]; records: Json[] } | null = null;
  const xlsxBytes = bytesOf.get("CAND-SRC-ROWS-XLSX");
  if (xlsxBytes) {
    try {
      const book = readXlsx(xlsxBytes);
      const sheet = book.sheets[0];
      const formulas = book.sheets.reduce((n, s) => n + s.cells.filter((c) => c.hasFormula).length, 0);
      setStatus(
        "CAND-SRC-ROWS-XLSX",
        `parsed: ${book.sheets.length} sheet(s) [${book.sheets.map((s) => `${s.name}:${s.state}`).join(", ")}], ${sheet ? sheet.rows.length - 1 : 0} data rows, ${formulas} formulas, macros ${book.hasMacros ? "present (not run)" : "absent"}, external links ${book.hasExternalLinks ? "present (not opened)" : "absent"}`,
      );
      if (book.sheets.length > 1)
        findings.push({
          severity: "warning",
          code: "XLSX_EXTRA_SHEETS",
          message: `Rows workbook has ${book.sheets.length} sheets; only the first ("${sheet?.name}") is compared. The others (${book.sheets
            .slice(1)
            .map((s) => `"${s.name}"`)
            .join(", ")}) are not read.`,
          refs: ["CAND-SRC-ROWS-XLSX"],
        });
      // a workbook without a sheet compares as an empty table, so every row and column is reported missing
      const headers = (sheet?.rows[0] ?? []).map((h) => (h === null ? "" : String(h)));
      const dataRows = sheet?.rows.slice(1) ?? [];
      // a value right of the last header has no column to be compared under; like a ragged CSV row, it is reported
      const beyondHeaders = dataRows.flatMap((cells, i) =>
        cells.flatMap((value, col) => (col >= headers.length && value !== null && value !== "" ? [`${columnName(col + 1)}${i + 2}`] : [])),
      );
      if (beyondHeaders.length)
        findings.push({
          severity: "error",
          code: "CROSS_FORMAT_MISMATCH",
          message: `Rows workbook has ${beyondHeaders.length} value(s) right of the last header (${headers.length ? `column ${columnName(headers.length)}` : "the header row is empty"}): ${listKeys(beyondHeaders)}. They have no column to be compared under; resolve the difference before import.`,
          refs: ["CAND-SRC-ROWS-XLSX"],
        });
      const records = dataRows.map((cells) => Object.fromEntries(headers.map((h, col) => [h, cells[col] ?? null])));
      rowTable = { headers, records };
    } catch (e) {
      setStatus("CAND-SRC-ROWS-XLSX", `invalid: ${(e as Error).message}`);
      findings.push({
        severity: "error",
        code: "SOURCE_UNREADABLE",
        message: `Rows workbook could not be read: ${(e as Error).message}`,
        refs: ["CAND-SRC-ROWS-XLSX"],
      });
    }
  }

  let paragraphs: DocxParagraph[] | null = null;
  const docxBytes = bytesOf.get("CAND-SRC-DOCX");
  if (docxBytes) {
    try {
      paragraphs = readDocxParagraphs(docxBytes).map((p) => ({ ...p, norm: normaliseForQuote(p.text) }));
      setStatus("CAND-SRC-DOCX", `parsed: ${paragraphs.filter((p) => p.text.trim()).length} non-empty paragraphs`);
    } catch (e) {
      setStatus("CAND-SRC-DOCX", `invalid: ${(e as Error).message}`);
      findings.push({ severity: "error", code: "SOURCE_UNREADABLE", message: `The DOCX could not be read: ${(e as Error).message}`, refs: ["CAND-SRC-DOCX"] });
    }
  }

  // Everything below needs a registry of the expected shape.
  if (registry === null) return;
  const meta = registry.schema_metadata;
  const schemaVersion = typeof meta.schema_version === "string" ? meta.schema_version : "unversioned";
  const generatedAt = typeof meta.generated_at_utc === "string" ? meta.generated_at_utc : null;
  const configs = registry.lopa_configurations;
  const rows = registry.lopa_rows;
  const seats = registry.lopa_seats;
  setStatus(
    "CAND-SRC-REGISTRY-JSON",
    `parsed: ${configs.length} configurations, ${rows.length} row records, ${seats.length} seats`,
    `schema ${schemaVersion}${generatedAt ? `, generated ${generatedAt}` : ""}`,
  );
  for (const key of Object.keys(registry)) {
    if (!["schema_metadata", ...REGISTRY_ARRAYS].includes(key)) {
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
  for (const [sourceId, label, expectedFields, keyFields, reference, other] of [
    ["CAND-SRC-CONFIG-CSV", "Configuration CSV", CONFIG_FIELDS, CONFIG_KEY, configs, configTable],
    ["CAND-SRC-SEATS-CSV", "Seat CSV", SEAT_FIELDS, SEAT_KEY, seats, seatTable],
    ["CAND-SRC-ROWS-XLSX", "Rows workbook", ROW_FIELDS, ROW_KEY, rows, rowTable],
  ] as const) {
    // an export that could not be read is reported above and leaves the count short
    if (other) compared += compareTable({ sourceId, label, expectedFields, keyFields, reference, other, conversions, findings });
  }
  // The comparison must have covered every registry value; anything less is a bypass, not agreement.
  const expectedCompared = configs.length * CONFIG_FIELDS.length + seats.length * SEAT_FIELDS.length + rows.length * ROW_FIELDS.length;
  if (compared !== expectedCompared)
    findings.push({
      severity: "error",
      code: "CROSS_FORMAT_INCOMPLETE",
      message: `${compared} attribute values were compared across the exports, but the registry holds ${expectedCompared}. The exports do not cover the registry; resolve the difference before import.`,
      refs: ["CAND-SRC-REGISTRY-JSON", "CAND-SRC-CONFIG-CSV", "CAND-SRC-SEATS-CSV", "CAND-SRC-ROWS-XLSX"],
    });
  stats.crossFormat = { attributeValuesCompared: compared, conversions };
  findings.push({
    severity: "info",
    code: "CROSS_FORMAT_AGREEMENT",
    message: `${compared} shared attribute values compared across the JSON, CSV and XLSX exports (conversions applied: ${JSON.stringify(conversions)}). Agreement between exports of one generated registry is not independent verification.`,
    refs: ["CAND-SRC-REGISTRY-JSON", "CAND-SRC-CONFIG-CSV", "CAND-SRC-SEATS-CSV", "CAND-SRC-ROWS-XLSX"],
  });

  const built = buildLayouts(configs, rows, seats, schemaVersion, findings);
  out.subtypes = built.subtypes;
  out.layouts = built.layouts;
  out.layoutRevisions = built.layoutRevisions;
  if (paragraphs) out.layoutCategories = buildLayoutCategories(paragraphs, built.layoutRevisions, findings);
}

type DocxParagraph = ReturnType<typeof readDocxParagraphs>[number] & { norm: string };

function buildLayouts(configs: Json[], rows: Json[], seats: Json[], schemaVersion: string, findings: Finding[]) {
  const subtypes = new Map<string, AircraftSubtype>();
  const layouts: Layout[] = [];
  const layoutRevisions: LayoutRevision[] = [];
  const pitchProblems: ClaimProblems = new Map();
  const widthProblems: ClaimProblems = new Map();
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
          pitch: pitchClaim(s.pitch_range_inches, elrRaw, pitchProblems),
          width: widthClaim(s.effective_width_inches, widthProblems),
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

  for (const [code, field, what, problems] of [
    ["PITCH_UNPARSED", "pitch_range_inches", "pitch", pitchProblems],
    ["WIDTH_UNPARSED", "effective_width_inches", "width", widthProblems],
  ] as const) {
    for (const { raw, problem, seats } of problems.values()) {
      findings.push({
        severity: "warning",
        code,
        message: `Seat ${field} value ${JSON.stringify(raw) ?? String(raw)} could not be read (${problem}); ${seats} ${seats === 1 ? "seat carries" : "seats carry"} it. Their ${what} claim is left empty.`,
        refs: ["CAND-SRC-REGISTRY-JSON"],
      });
    }
  }

  return { subtypes: [...subtypes.values()], layouts, layoutRevisions };
}

/** Narrative layout categories from the DOCX, each quote verified against the document text. */
function buildLayoutCategories(paragraphs: DocxParagraph[], layoutRevisions: LayoutRevision[], findings: Finding[]): LayoutCategory[] {
  const layoutCategories: LayoutCategory[] = [];
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

  return layoutCategories;
}
