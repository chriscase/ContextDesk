import { ADMIN_PEOPLE_CSRF_HEADER, ADMIN_PEOPLE_CSRF_HEADER_VALUE } from "@cd-collab/contracts";
import type { FastifyRequest } from "fastify";

export const CSRF_HEADER = ADMIN_PEOPLE_CSRF_HEADER;
export const CSRF_HEADER_VALUE = ADMIN_PEOPLE_CSRF_HEADER_VALUE;

/**
 * Defense-in-depth CSRF guard for state-changing people/profile routes.
 *
 * Sessions travel in a SameSite=Lax cookie (see auth/routes.ts), which
 * already withholds the cookie from a cross-site POST/PUT/DELETE/PATCH in
 * every modern browser. This adds a second, independently testable control
 * on top: a plain cross-site HTML form cannot set an arbitrary request
 * header, and a cross-origin fetch/XHR that tries to would trigger a CORS
 * preflight this server never approves (no Access-Control-Allow-Origin is
 * ever sent, so the browser blocks the real request).
 *
 * The header name/value live in contracts (admin-people.ts) so this guard
 * and the People admin web client read them from one shared source.
 *
 * Scope: this guard covers only the admin-people mutation routes shipped in
 * this module. Retrofitting the rest of the collab API's older mutation
 * routes (authz group-role-map, cases, ...) with the same header check is
 * tracked as residual work, not silently done here.
 */
export function hasCsrfHeader(request: FastifyRequest): boolean {
  return request.headers[CSRF_HEADER] === CSRF_HEADER_VALUE;
}
