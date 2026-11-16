import type { FastifyReply, FastifyRequest } from "fastify";

export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const IMMUTABLE = "public, max-age=31536000, immutable";

/** Security headers on every response; hashed build assets are immutable, everything else is no-store. */
export function applyHeaders(request: FastifyRequest, reply: FastifyReply): void {
  reply.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Cross-Origin-Resource-Policy", "same-origin");
  reply.header("Cross-Origin-Opener-Policy", "same-origin");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  const path = request.url.split("?")[0] ?? "";
  reply.header("Cache-Control", path.startsWith("/assets/") ? IMMUTABLE : "no-store");
}
