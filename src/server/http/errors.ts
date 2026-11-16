import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DomainError } from "../../domain/visitLogic.ts";
import { ReferenceStoreError } from "../referenceStore.ts";
import { StorageError } from "../visitStore.ts";

/** Sends the error envelope: { error: { code, message, details } }. */
export function sendError(reply: FastifyReply, status: number, code: string, message: string, details: unknown = null): FastifyReply {
  return reply.code(status).send({ error: { code, message, details } });
}

/**
 * The one place that turns a thrown error into an answer.
 * Only expected failures get their own message. An unexpected error is logged with its stack and
 * answered with a fixed message plus the request id, so nothing internal reaches the client.
 */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: Error & { statusCode?: number }, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof DomainError) {
      if (error.status >= 500) request.log.error({ err: error }, error.message);
      else request.log.info({ code: error.code }, error.message);
      return sendError(reply, error.status, error.code, error.message, error.details);
    }
    if (error instanceof ReferenceStoreError) {
      request.log.warn({ err: error }, "reference store unavailable");
      return sendError(reply, 503, "REFERENCE_UNAVAILABLE", `Reference data is unavailable: ${error.message}`, { requestId: request.id });
    }
    if (error instanceof StorageError) {
      request.log.error({ err: error }, "visit store failure");
      return sendError(reply, 503, "STORAGE_UNAVAILABLE", "The store could not complete the request. Nothing was saved.", { requestId: request.id });
    }
    if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      request.log.info({ statusCode: error.statusCode }, error.message);
      return sendError(reply, error.statusCode, "BAD_REQUEST", error.message);
    }
    request.log.error({ err: error }, "unexpected error");
    return sendError(reply, 500, "INTERNAL_ERROR", "The request failed unexpectedly.", { requestId: request.id });
  });
}
