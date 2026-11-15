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
  VisitSummary,
  VisualProfile,
} from "../domain/types.ts";

/**
 * kind "http": the server answered; the outcome is known.
 * kind "network": no answer arrived. For a write this means the outcome is UNKNOWN: it may or may
 * not have been saved, so the caller retries with the same idempotency key.
 */
export class ApiError extends Error {
  kind: "http" | "network";
  status: number;
  code: string;
  details: unknown;
  constructor(kind: "http" | "network", status: number, code: string, message: string, details: unknown = null) {
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

async function request<T>(method: string, url: string, body?: unknown, timeoutMs = 20000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    throw new ApiError("network", 0, "NETWORK", controller.signal.aborted ? "The server did not answer in time." : "The server could not be reached.", String(e));
  } finally {
    clearTimeout(timer);
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    if (response.ok) throw new ApiError("network", response.status, "BAD_RESPONSE", "The server answer could not be read.");
  }
  if (!response.ok) {
    const p = payload as { error?: { code?: string; message?: string; details?: unknown }; state?: string; message?: string } | null;
    if (p?.state) return payload as T; // lookup answers carry their own state even on 503
    throw new ApiError("http", response.status, p?.error?.code ?? `HTTP_${response.status}`, p?.error?.message ?? `Request failed (${response.status}).`, p?.error?.details ?? null);
  }
  return payload as T;
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
  health: () => request<Health>("GET", "/api/health", undefined, 8000),
  reference: () => request<ReferenceInfo>("GET", "/api/reference"),
  tails: () => request<{ tails: { tail: string; note: string }[] }>("GET", "/api/tails"),
  layouts: () => request<{ layouts: LayoutSummary[]; layoutCategories: LayoutCategory[]; visualProfiles: VisualProfile[] }>("GET", "/api/layouts"),
  layout: (id: string) => request<LayoutDetail>("GET", `/api/layouts/${encodeURIComponent(id)}`),
  lookup: (tail: string, date: string) => request<LookupResult>("GET", `/api/lookup?${q({ tail, date })}`),
  preparation: (tail: string, date: string) => request<PrepOverview>("GET", `/api/preparation?${q({ tail, date })}`),
  visitPreparation: (id: string) => request<PrepOverview>("GET", `/api/visits/${id}/preparation`),
  visits: (params: { status?: string; q?: string; limit?: number; offset?: number }) =>
    request<{ items: VisitSummary[]; total: number; limit: number; offset: number }>("GET", `/api/visits?${q(params)}`),
  visit: (id: string) => request<VisitEnvelope>("GET", `/api/visits/${id}`),
  createVisit: (tail: string, checkDate: string, technician: string, idempotencyKey: string) =>
    request<VisitEnvelope>("POST", "/api/visits", { tail, checkDate, technician, idempotencyKey }),
  upsertRecord: (id: string, record: RecordInput, expectedRecordVersion: number, idempotencyKey: string) =>
    request<VisitEnvelope>("PUT", `/api/visits/${id}/records`, { record, expectedRecordVersion, idempotencyKey }),
  removeRecord: (id: string, locationId: string, componentId: string, expectedRecordVersion: number, idempotencyKey: string) =>
    request<VisitEnvelope>("POST", `/api/visits/${id}/records/remove`, { locationId, componentId, expectedRecordVersion, idempotencyKey }),
  complete: (id: string, expectedVisitVersion: number, idempotencyKey: string) =>
    request<{ visit: Visit; report: Report; alreadyCompleted: boolean }>("POST", `/api/visits/${id}/complete`, { confirm: true, expectedVisitVersion, idempotencyKey }),
  report: (id: string) => request<ReportEnvelope>("GET", `/api/visits/${id}/report`),
  addEvent: (id: string, type: string, note: string, author: string) => request<{ visit: Visit }>("POST", `/api/visits/${id}/events`, { type, note, author }),
};
