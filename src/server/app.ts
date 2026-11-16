import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import fastifyCompress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { compareCodePoints } from "../domain/order.ts";
import { buildPreparation, type PrepOverview } from "../domain/prep.ts";
import { lookup } from "../domain/resolve.ts";
import type { LookupResult, ReferenceRelease } from "../domain/types.ts";
import { AUTHORITY_NOTICE, DATE_RULE, REPLACEMENT_COUNT_SEMANTICS } from "../domain/types.ts";
import { buildSnapshot, DomainError } from "../domain/visitLogic.ts";
import type { ServerConfig } from "./config.ts";
import { installErrorHandler } from "./http/errors.ts";
import { applyHeaders } from "./http/headers.ts";
import { allowedHostnames, hostnameOf, isWriteAllowed } from "./http/hostGuard.ts";
import { ListVisitsQuery, LookupQuery, parseOr400, VisitIdParam } from "./http/schemas.ts";
import { renderReportPdf } from "./pdf.ts";
import { ReferenceStore, ReferenceStoreError } from "./referenceStore.ts";
import { StorageError, VisitStore } from "./visitStore.ts";

interface Faults {
  /** fail: refuse before writing. commitThenDrop: write, then drop the connection (uncertain outcome). */
  visitWrites: "fail" | "commitThenDrop" | null;
  remaining: number;
  reference: "fail" | null;
}

export interface AppHandle {
  app: FastifyInstance;
  visits: VisitStore;
  close(): Promise<void>;
}

/** Spreadsheet applications run cells that start with these characters as formulas; a leading quote makes them text. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  const raw = String(value ?? "");
  const text = typeof value === "string" && FORMULA_LEAD.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function preparationCsv(prep: PrepOverview): string {
  const header = [
    "line_type",
    "part_no",
    "description",
    "component",
    "qty_per_replacement",
    "unit",
    "coverage_locations",
    "coverage_summary",
    "source",
    "source_revision",
    "valid_from",
    "valid_to",
    "pending_change",
    "alternate_for",
    "note",
  ];
  const rows: unknown[][] = [];
  for (const line of prep.lines) {
    rows.push([
      "PRIMARY",
      line.partNo,
      line.description,
      line.componentName,
      line.qtyPerReplacement,
      line.unit,
      line.coverageCount,
      line.coverageSummary,
      line.source?.id ?? "",
      line.source?.revision ?? "",
      line.ruleEffectiveFrom,
      line.ruleEffectiveTo ?? "",
      line.pendingChanges.map((p) => p.note).join(" | "),
      "",
      "Coverage = locations where the part would apply; not replacements made",
    ]);
    for (const s of line.requiredSupplements) {
      rows.push([
        "REQUIRED_SUPPLEMENT",
        s.partNo,
        s.description,
        line.componentName,
        s.qty,
        s.unit,
        "",
        "",
        s.sourceId,
        "",
        "",
        "",
        "",
        line.partNo,
        "Required with each primary replacement",
      ]);
    }
    for (const alt of line.alternates) {
      rows.push([
        "ALTERNATE",
        alt.altPartNo,
        alt.altDescription,
        line.componentName,
        alt.qtyPerReplacement,
        alt.unit,
        alt.locationCount,
        "",
        alt.approvalSource?.id ?? "",
        alt.approvalSource?.revision ?? "",
        alt.effectiveFrom,
        alt.effectiveTo ?? "",
        "",
        line.partNo,
        "Separately approved alternate; replaces the primary when chosen",
      ]);
      for (const s of alt.requiredSupplements) {
        rows.push([
          "REQUIRED_SUPPLEMENT",
          s.partNo,
          s.description,
          line.componentName,
          s.qty,
          s.unit,
          "",
          "",
          s.sourceId,
          "",
          "",
          "",
          "",
          alt.altPartNo,
          "Required with each alternate replacement",
        ]);
      }
    }
  }
  for (const gap of prep.gaps) {
    rows.push(["GAP", "", gap.message, gap.componentId, "", "", gap.locationIds.length, gap.locationSummary, "", "", "", "", "", "", gap.status]);
  }
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function createApp(config: ServerConfig): AppHandle {
  const app = Fastify({
    logger: { level: config.logLevel },
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    bodyLimit: 256 * 1024,
  });
  app.register(fastifyCompress, { threshold: 1024, encodings: ["br", "gzip"] });
  const visits = VisitStore.open(config.visitsPath, config.referencePath);
  const faults: Faults = { visitWrites: null, remaining: 0, reference: null };

  let reference: { store: ReferenceStore; ino: number; mtimeMs: number } | null = null;
  const closeReference = () => {
    try {
      reference?.store.close();
    } catch {
      /* ignore */
    }
    reference = null;
  };
  /** The active release, re-opening the store if the file was replaced by an import or reset. */
  const activeRelease = (): ReferenceRelease => {
    if (faults.reference === "fail") throw new ReferenceStoreError("FAULT", "Simulated reference store failure.");
    if (!existsSync(config.referencePath)) {
      closeReference();
      throw new ReferenceStoreError("STORE_MISSING", "The reference store has not been imported.");
    }
    const stat = statSync(config.referencePath);
    if (reference && reference.ino !== stat.ino) closeReference();
    if (!reference)
      reference = { store: ReferenceStore.open(config.referencePath, config.visitsPath, { readOnly: true }), ino: stat.ino, mtimeMs: stat.mtimeMs };
    try {
      return reference.store.loadActive();
    } catch (e) {
      closeReference();
      throw e;
    }
  };

  const fail = (reply: FastifyReply, status: number, code: string, message: string, details?: unknown) =>
    reply.code(status).send({ error: { code, message, details: details ?? null } });

  installErrorHandler(app);
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Request-Id", request.id);
    return payload;
  });

  const allowedHosts = allowedHostnames(config);
  app.addHook("onRequest", async (request, reply) => {
    applyHeaders(request, reply);
    if (!allowedHosts.has(hostnameOf(request.headers.host) ?? "")) {
      return fail(reply, 403, "HOST_NOT_ALLOWED", "This host name is not allowed.");
    }
    if (request.method !== "GET" && request.method !== "HEAD" && !isWriteAllowed(request.headers)) {
      return fail(reply, 403, "CROSS_ORIGIN_WRITE", "Cross-origin writes are not allowed.");
    }
  });

  // @fastify/compress attaches to routes through an onRoute hook, and register() loads it asynchronously.
  // Routes are therefore declared inside a plugin that runs after it, or they would not be compressed.
  // The outer root `app` is used on purpose inside it, so hooks and handlers stay on the root instance;
  // switching to the plugin's own instance parameter would encapsulate them and they would stop applying.
  app.register(async () => {
    // Error answers under /assets/ (missing files) must never be cached as immutable.
    app.addHook("onSend", async (_request, reply, payload) => {
      if (reply.statusCode >= 400) reply.header("Cache-Control", "no-store");
      return payload;
    });

    const body = (request: FastifyRequest): Record<string, unknown> => {
      const b = request.body;
      if (typeof b !== "object" || b === null || Array.isArray(b)) throw new DomainError("INVALID_BODY", "A JSON object body is required.", 400);
      return b as Record<string, unknown>;
    };
    /** A malformed id cannot name a visit, so it gets the same answer as an unknown one. */
    const visitId = (raw: unknown): string => {
      const parsed = VisitIdParam.safeParse(raw);
      if (!parsed.success) throw new DomainError("VISIT_NOT_FOUND", "Visit not found.", 404);
      return parsed.data;
    };
    const optionalVersion = (value: unknown, name: string): number | undefined => {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
        throw new DomainError("INVALID_VERSION", `${name} must be a non-negative whole number.`, 400);
      return value;
    };
    const optionalKey = (value: unknown): string | undefined => {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== "string" || value.length < 8 || value.length > 100)
        throw new DomainError("INVALID_IDEMPOTENCY_KEY", "idempotencyKey must be 8-100 characters.", 400);
      return value;
    };
    /** Applies a simulated write fault (test builds only). Returns true when the response must be dropped. */
    const writeFault = (): boolean => {
      if (!faults.visitWrites || faults.remaining <= 0) return false;
      faults.remaining -= 1;
      const mode = faults.visitWrites;
      if (faults.remaining === 0) faults.visitWrites = null;
      if (mode === "fail") throw new StorageError("Simulated visit store failure");
      return true;
    };
    const drop = (reply: FastifyReply) => {
      reply.hijack();
      reply.raw.destroy();
    };

    app.get("/api/health", async () => {
      let referenceStatus: Record<string, unknown>;
      try {
        const release = activeRelease();
        referenceStatus = { available: true, releaseId: release.id, contentHash: release.contentHash, activatedAt: release.activatedAt };
      } catch (e) {
        referenceStatus = { available: false, message: (e as Error).message };
      }
      let visitStatus: Record<string, unknown>;
      try {
        visitStatus = { available: true, ...visits.counts() };
      } catch (e) {
        visitStatus = { available: false, message: (e as Error).message };
      }
      return {
        status: referenceStatus.available && visitStatus.available ? "ok" : "degraded",
        demo: true,
        authorityNotice: AUTHORITY_NOTICE,
        reference: referenceStatus,
        visits: visitStatus,
      };
    });

    app.get("/api/reference", async () => {
      const release = activeRelease();
      const detail = reference!.store.findings(release.id);
      const countBy = <T>(items: T[], key: (item: T) => string) => {
        const out: Record<string, number> = {};
        for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
        return out;
      };
      return {
        releaseId: release.id,
        label: release.label,
        contentHash: release.contentHash,
        activatedAt: release.activatedAt,
        authorityNotice: AUTHORITY_NOTICE,
        dateRule: DATE_RULE,
        replacementCountSemantics: REPLACEMENT_COUNT_SEMANTICS,
        namespaces: {
          fixture: "Fictional regression fixtures (tails, variants, parts, rules). Used to demonstrate the full workflow.",
          candidate: "Supplied, unverified registry layouts. Explorable, unassigned, no tails or parts.",
          accepted: "Approved airline data. Empty: none was supplied.",
        },
        counts: {
          aircraft: release.aircraft.length,
          variants: release.variants.length,
          layoutRevisions: countBy(release.layoutRevisions, (r) => r.namespace),
          rules: release.rules.length,
          substitutes: release.substitutes.length,
          parts: release.parts.length,
          sources: countBy(release.sources, (s) => s.namespace),
          accepted: 0,
        },
        vocabulary: release.vocabulary,
        visualProfiles: release.visualProfiles,
        findings: detail.findings,
        stats: detail.stats,
        sources: release.sources,
        releases: reference!.store.listReleases(),
      };
    });

    app.get("/api/tails", async () => {
      const release = activeRelease();
      return {
        demo: true,
        tails: release.aircraft
          .map((a) => ({ tail: a.tail, subtypeId: a.subtypeId, namespace: a.namespace, note: a.note ?? "" }))
          .sort((a, b) => compareCodePoints(a.tail, b.tail)),
      };
    });

    app.get("/api/layouts", async () => {
      const release = activeRelease();
      return {
        releaseId: release.id,
        layouts: release.layoutRevisions.map((r) => {
          const seats = r.locations.filter((l) => l.kind === "SEAT");
          const tiers: Record<string, number> = {};
          for (const s of seats) {
            const key = s.seat?.commercialTier ?? s.seat?.maintenanceZone ?? "unspecified";
            tiers[key] = (tiers[key] ?? 0) + 1;
          }
          return {
            id: r.id,
            layoutId: r.layoutId,
            revision: r.revision,
            namespace: r.namespace,
            status: r.status,
            name: r.name,
            subtypeId: r.subtypeId,
            seatSetStatus: r.seatSetStatus,
            seatCount: seats.length,
            declaredSeatCount: r.declaredSeatCount,
            floorMapStatus: r.floorMapStatus,
            binMapStatus: r.binMapStatus,
            tierCounts: tiers,
            variants: release.variants.filter((v) => v.layoutRevisionIds.includes(r.id)).map((v) => v.id),
            notes: r.notes,
          };
        }),
        layoutCategories: release.layoutCategories,
        visualProfiles: release.visualProfiles,
      };
    });

    app.get<{ Params: { id: string } }>("/api/layouts/:id", async (request) => {
      const release = activeRelease();
      const revision = release.layoutRevisions.find((r) => r.id === request.params.id);
      if (!revision) throw new DomainError("LAYOUT_NOT_FOUND", "Layout revision not found.", 404);
      return {
        releaseId: release.id,
        layoutRevision: revision,
        layout: release.layouts.find((l) => l.id === revision.layoutId) ?? null,
        subtype: release.subtypes.find((s) => s.id === revision.subtypeId) ?? null,
        source: release.sources.find((s) => s.id === revision.sourceId) ?? null,
        variants: release.variants.filter((v) => v.layoutRevisionIds.includes(revision.id)),
        categories: release.layoutCategories.filter((c) => c.crosswalk.some((x) => x.layoutRevisionId === revision.id)),
        components: release.components,
      };
    });

    const runLookup = (tail: unknown, date: unknown): { release: ReferenceRelease | null; result: LookupResult } => {
      let release: ReferenceRelease;
      try {
        release = activeRelease();
      } catch (e) {
        return {
          release: null,
          result: {
            state: "SERVICE_UNAVAILABLE",
            reasonCode: "REFERENCE_UNAVAILABLE",
            message: `Reference data is unavailable (${(e as Error).message}). No configuration can be resolved; nothing is assumed.`,
            tail: typeof tail === "string" ? tail.trim().toUpperCase() : "",
            checkDate: typeof date === "string" ? date : "",
            referenceReleaseId: null,
            demo: true,
          },
        };
      }
      return { release, result: lookup(release, tail, date) };
    };

    app.get("/api/lookup", async (request, reply) => {
      const query = parseOr400(LookupQuery, request.query, "INVALID_QUERY");
      const { result } = runLookup(query.tail, query.date);
      if (result.state === "SERVICE_UNAVAILABLE") reply.code(503);
      return result;
    });

    app.get("/api/preparation", async (request, reply) => {
      const query = parseOr400(LookupQuery, request.query, "INVALID_QUERY");
      const { release, result } = runLookup(query.tail, query.date);
      if (!release) return fail(reply, 503, "REFERENCE_UNAVAILABLE", result.message);
      const snapshot = buildSnapshot(release, result, new Date().toISOString());
      const prep = buildPreparation(snapshot);
      if (query.format === "csv") {
        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header("Content-Disposition", `attachment; filename="cabin-kit-preparation-${prep.tail}-${prep.checkDate}.csv"`);
        return preparationCsv(prep);
      }
      return prep;
    });

    app.get<{ Querystring: { status?: unknown } }>("/api/visits", async (request) => {
      const { status } = request.query;
      if (status !== undefined && status !== "DRAFT" && status !== "COMPLETED")
        throw new DomainError("INVALID_STATUS", "status must be DRAFT or COMPLETED.", 400);
      return visits.listVisits(parseOr400(ListVisitsQuery, request.query, "INVALID_QUERY"));
    });

    app.post("/api/visits", async (request, reply) => {
      const b = body(request);
      const key = optionalKey(b.idempotencyKey);
      const { release, result } = runLookup(b.tail, b.checkDate);
      if (!release) return fail(reply, 503, "REFERENCE_UNAVAILABLE", result.message);
      if (result.state !== "RESOLVED" && result.state !== "PARTIAL") {
        return fail(reply, 422, "CONFIGURATION_NOT_RESOLVED", `A visit needs an unambiguous valid configuration. ${result.message}`, {
          state: result.state,
          reasonCode: result.reasonCode,
        });
      }
      const snapshot = buildSnapshot(release, result, new Date().toISOString());
      const dropAfter = writeFault();
      const created = visits.createVisit(snapshot, b.technician, { idempotencyKey: key });
      if (dropAfter) return drop(reply);
      reply.code(created.replayed ? 200 : 201);
      return { visit: created.visit, replayed: created.replayed };
    });

    app.get<{ Params: { id: string } }>("/api/visits/:id", async (request) => {
      const visit = visits.getVisit(visitId(request.params.id));
      let referenceNow: { releaseId: string | null; changedSinceVisit: boolean } = { releaseId: null, changedSinceVisit: false };
      try {
        const release = activeRelease();
        referenceNow = { releaseId: release.id, changedSinceVisit: release.id !== visit.referenceReleaseId };
      } catch {
        /* the visit is self-contained; reference availability does not matter here */
      }
      return { visit, referenceNow };
    });

    app.get<{ Params: { id: string }; Querystring: { format?: string } }>("/api/visits/:id/preparation", async (request, reply) => {
      const prep = buildPreparation(visits.getVisit(visitId(request.params.id)).snapshot);
      if (request.query.format === "csv") {
        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header("Content-Disposition", `attachment; filename="cabin-kit-preparation-${prep.tail}-${prep.checkDate}.csv"`);
        return preparationCsv(prep);
      }
      return prep;
    });

    app.put<{ Params: { id: string } }>("/api/visits/:id/records", async (request, reply) => {
      const b = body(request);
      for (const k of Object.keys(b)) {
        if (!["record", "expectedRecordVersion", "idempotencyKey"].includes(k)) {
          throw new DomainError("UNSUPPORTED_FIELD", `Field "${k}" is not accepted. Part lines and totals are derived by the server.`);
        }
      }
      const dropAfter = writeFault();
      const result = visits.upsertRecord(visitId(request.params.id), b.record, optionalVersion(b.expectedRecordVersion, "expectedRecordVersion"), {
        idempotencyKey: optionalKey(b.idempotencyKey),
      });
      if (dropAfter) return drop(reply);
      return result;
    });

    app.post<{ Params: { id: string } }>("/api/visits/:id/records/remove", async (request, reply) => {
      const b = body(request);
      const dropAfter = writeFault();
      const result = visits.removeRecord(
        visitId(request.params.id),
        b.locationId,
        b.componentId,
        optionalVersion(b.expectedRecordVersion, "expectedRecordVersion"),
        {
          idempotencyKey: optionalKey(b.idempotencyKey),
        },
      );
      if (dropAfter) return drop(reply);
      return result;
    });

    app.post<{ Params: { id: string } }>("/api/visits/:id/complete", async (request, reply) => {
      const b = body(request);
      if (b.confirm !== true) throw new DomainError("CONFIRMATION_REQUIRED", "Completion must be confirmed explicitly (confirm: true).", 400);
      const dropAfter = writeFault();
      const result = visits.completeVisit(visitId(request.params.id), optionalVersion(b.expectedVisitVersion, "expectedVisitVersion"), {
        idempotencyKey: optionalKey(b.idempotencyKey),
      });
      if (dropAfter) return drop(reply);
      return result;
    });

    app.post<{ Params: { id: string } }>("/api/visits/:id/events", async (request, reply) => {
      const b = body(request);
      for (const k of Object.keys(b)) {
        if (!["type", "note", "author", "idempotencyKey"].includes(k)) {
          throw new DomainError("UNSUPPORTED_FIELD", `Field "${k}" is not accepted. Events take only type, note, author and idempotencyKey.`, 422);
        }
      }
      const { visit, replayed } = visits.addLinkedEvent(visitId(request.params.id), b.type, b.note, b.author, {
        idempotencyKey: optionalKey(b.idempotencyKey),
      });
      reply.code(replayed ? 200 : 201);
      return { visit, replayed };
    });

    app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/api/visits/:id/report", async (request, reply) => {
      const result = visits.getReport(visitId(request.params.id));
      if (request.query.download) {
        reply.header(
          "Content-Disposition",
          `attachment; filename="cabin-kit-report-${result.report.visit.tail}-${result.report.visit.checkDate}-visit-${result.report.visit.number}.json"`,
        );
      }
      return result;
    });

    app.get<{ Params: { id: string } }>("/api/visits/:id/report.pdf", async (request, reply) => {
      const { report, linkedEvents, basisSha256 } = visits.getReport(visitId(request.params.id));
      const pdf = await renderReportPdf(report, linkedEvents, basisSha256);
      reply.header("Content-Type", "application/pdf");
      reply.header(
        "Content-Disposition",
        `inline; filename="cabin-kit-report-${report.visit.tail}-${report.visit.checkDate}-visit-${report.visit.number}.pdf"`,
      );
      return reply.send(pdf);
    });

    if (config.testFaults) {
      app.post("/api/__test/faults", async (request) => {
        const b = body(request);
        faults.visitWrites = b.visitWrites === "fail" || b.visitWrites === "commitThenDrop" ? b.visitWrites : null;
        faults.remaining = typeof b.remaining === "number" ? b.remaining : faults.visitWrites ? 1 : 0;
        faults.reference = b.reference === "fail" ? "fail" : null;
        return { faults };
      });
    }

    if (existsSync(config.webRoot)) {
      app.register(fastifyStatic, { root: config.webRoot, index: ["index.html"], cacheControl: false });
    } else {
      app.get("/", async (_request, reply) => {
        reply.type("text/plain");
        return "Cabin Kit API is running. The web client has not been built; run `npm run build`.";
      });
    }
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return fail(reply, 404, "NOT_FOUND", "No such API route.");
      return fail(reply, 404, "NOT_FOUND", "Not found.");
    });
  });

  /** Set on the first call; later calls get the same promise, so the stores are closed once. */
  let closed: Promise<void> | null = null;
  return {
    app,
    visits,
    close() {
      closed ??= (async () => {
        await app.close();
        closeReference();
        visits.close();
      })();
      return closed;
    },
  };
}
