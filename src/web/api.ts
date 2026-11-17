import type { PrepOverview } from "../domain/prep.ts";
import type {
  ComponentDef,
  Finding,
  LayoutCategory,
  LayoutRevision,
  LookupResult,
  RecordInput,
  Report,
  SourceArtifact,
  Visit,
  VisitEvent,
  VisitState,
  VisitSummary,
  VisualProfile,
} from "../domain/types.ts";

/**
 * kind "http": the server answered; the outcome is known.
 * kind "network": no answer arrived. For a write this means the outcome is UNKNOWN: it may or may
 * not have been saved, so the caller retries with the same idempotency key.
 */
const API_BASE = "/api";
const visitUrl = (id: string, suffix = "") => `${API_BASE}/visits/${encodeURIComponent(id)}${suffix}`;

export type ApiErrorKind = "network" | "http" | "aborted";

/**
 * kind "http": the server answered; the outcome is known.
 * kind "network": no usable answer arrived. For a write this means the outcome is UNKNOWN: it may or may
 * not have been saved, so the caller retries with the same idempotency key.
 * kind "aborted": the caller cancelled the request; callers ignore it.
 */
export class ApiError extends Error {
  kind: ApiErrorKind;
  status: number;
  code: string;
  details: unknown;
  constructor(kind: ApiErrorKind, status: number, code: string, message: string, details: unknown = null) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function newKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`;
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface ErrorEnvelope {
  error: { code: string; message?: string; details?: unknown };
}
const isEnvelope = (p: unknown): p is ErrorEnvelope =>
  typeof p === "object" && p !== null && typeof (p as { error?: { code?: unknown } }).error?.code === "string";

export async function request<T>(method: string, url: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  const { timeoutMs = 20000, signal } = options;
  const isWrite = method !== "GET";
  const aborted = () => new ApiError("aborted", 0, "ABORTED", "The request was cancelled.");
  if (signal?.aborted) throw aborted();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  // The timer stays armed until the body has been read: a stalled body must not hang the caller.
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (signal?.aborted) throw aborted();
      throw new ApiError("network", 0, "NETWORK", timedOut ? "The server did not answer in time." : "The server could not be reached.", String(e));
    }
    let payload: unknown = null;
    let readable = true;
    try {
      payload = await response.json();
    } catch (e) {
      if (signal?.aborted) throw aborted();
      if (timedOut) throw new ApiError("network", response.status, "NETWORK", "The server did not answer in time.", String(e));
      readable = false;
    }
    if (response.ok) {
      if (!readable) throw new ApiError("network", response.status, "BAD_RESPONSE", "The server answer could not be read.");
      return payload as T;
    }
    const p = payload as { state?: string } | null;
    if (!isWrite && readable && p?.state) return payload as T; // lookup answers carry their own state even on 503
    // The server's own error envelope proves this attempt saved nothing: every error it reports is thrown before COMMIT
    // (VisitStore.write rolls back first). A 5xx without it may come from a proxy after the write was applied.
    // An earlier attempt with the same key may still be stored; useMutations keeps that outcome unknown (N2).
    if (isWrite && response.status >= 500 && !(readable && isEnvelope(payload))) {
      throw new ApiError("network", response.status, "OUTCOME_UNKNOWN", "The server answer could not be trusted; the outcome is unknown.");
    }
    const envelope = readable && isEnvelope(payload) ? payload.error : null;
    throw new ApiError(
      "http",
      response.status,
      envelope?.code ?? `HTTP_${response.status}`,
      envelope?.message ?? `Request failed (${response.status}).`,
      envelope?.details ?? null,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

export interface Health {
  status: string;
  authorityNotice: string;
  reference: { available: boolean; releaseId?: string; message?: string };
  visits: { available: boolean; visits?: number; drafts?: number; completed?: number; message?: string };
}
export interface ReferenceInfo {
  releaseId: string;
  label: string;
  contentHash: string;
  activatedAt: string | null;
  authorityNotice: string;
  dateRule: string;
  replacementCountSemantics: string;
  namespaces: Record<string, string>;
  counts: Record<string, unknown>;
  visualProfiles: VisualProfile[];
  findings: Finding[];
  stats: Record<string, unknown>;
  sources: SourceArtifact[];
  releases: { id: string; status: string; createdAt: string; activatedAt: string | null; label: string; findingCounts: Record<string, number> }[];
}
export interface LayoutSummary {
  id: string;
  layoutId: string;
  revision: string;
  namespace: string;
  status: string;
  name: string;
  subtypeId: string;
  seatSetStatus: string;
  seatCount: number;
  declaredSeatCount: number | null;
  floorMapStatus: string;
  binMapStatus: string;
  tierCounts: Record<string, number>;
  variants: string[];
  notes: string[];
}
export interface LayoutDetail {
  releaseId: string;
  layoutRevision: LayoutRevision;
  source: SourceArtifact | null;
  categories: LayoutCategory[];
  components: ComponentDef[];
}
export interface VisitEnvelope {
  visit: Visit;
  referenceNow?: { releaseId: string | null; changedSinceVisit: boolean };
  replayed?: boolean;
}
/** What a write returns: the visit without its frozen snapshot. Keep the snapshot from the initial GET. */
export interface VisitStateEnvelope {
  visit: VisitState;
  replayed?: boolean;
}
export interface ReportEnvelope {
  report: Report;
  basisSha256: string | null;
  linkedEvents: VisitEvent[];
}

const q = (params: Record<string, string | number | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");

export const api = {
  health: (o?: RequestOptions) => request<Health>("GET", `${API_BASE}/health`, undefined, { timeoutMs: 8000, ...o }),
  reference: (o?: RequestOptions) => request<ReferenceInfo>("GET", `${API_BASE}/reference`, undefined, o),
  tails: (o?: RequestOptions) => request<{ tails: { tail: string; note: string }[] }>("GET", `${API_BASE}/tails`, undefined, o),
  layouts: (o?: RequestOptions) =>
    request<{ layouts: LayoutSummary[]; layoutCategories: LayoutCategory[]; visualProfiles: VisualProfile[] }>("GET", `${API_BASE}/layouts`, undefined, o),
  layout: (id: string, o?: RequestOptions) => request<LayoutDetail>("GET", `${API_BASE}/layouts/${encodeURIComponent(id)}`, undefined, o),
  lookup: (tail: string, date: string, o?: RequestOptions) => request<LookupResult>("GET", `${API_BASE}/lookup?${q({ tail, date })}`, undefined, o),
  preparation: (tail: string, date: string, o?: RequestOptions) => request<PrepOverview>("GET", `${API_BASE}/preparation?${q({ tail, date })}`, undefined, o),
  visitPreparation: (id: string, o?: RequestOptions) => request<PrepOverview>("GET", visitUrl(id, "/preparation"), undefined, o),
  visits: (params: { status?: string; q?: string; limit?: number; offset?: number }, o?: RequestOptions) =>
    request<{ items: VisitSummary[]; total: number; limit: number; offset: number }>("GET", `${API_BASE}/visits?${q(params)}`, undefined, o),
  visit: (id: string, o?: RequestOptions) => request<VisitEnvelope>("GET", visitUrl(id), undefined, o),
  createVisit: (tail: string, checkDate: string, technician: string, idempotencyKey: string, o?: RequestOptions) =>
    request<VisitEnvelope>("POST", `${API_BASE}/visits`, { tail, checkDate, technician, idempotencyKey }, o),
  upsertRecord: (id: string, record: RecordInput, expectedRecordVersion: number, idempotencyKey: string, o?: RequestOptions) =>
    request<VisitStateEnvelope>("PUT", visitUrl(id, "/records"), { record, expectedRecordVersion, idempotencyKey }, o),
  removeRecord: (id: string, locationId: string, componentId: string, expectedRecordVersion: number, idempotencyKey: string, o?: RequestOptions) =>
    request<VisitStateEnvelope>("POST", visitUrl(id, "/records/remove"), { locationId, componentId, expectedRecordVersion, idempotencyKey }, o),
  complete: (id: string, expectedVisitVersion: number, idempotencyKey: string, o?: RequestOptions) =>
    request<{ visit: VisitState; report: Report; alreadyCompleted: boolean; replayed?: boolean }>(
      "POST",
      visitUrl(id, "/complete"),
      { confirm: true, expectedVisitVersion, idempotencyKey },
      o,
    ),
  report: (id: string, o?: RequestOptions) => request<ReportEnvelope>("GET", visitUrl(id, "/report"), undefined, o),
  addEvent: (id: string, type: string, note: string, author: string, idempotencyKey: string, o?: RequestOptions) =>
    request<{ visit: VisitState; replayed: boolean }>("POST", visitUrl(id, "/events"), { type, note, author, idempotencyKey }, o),
};
