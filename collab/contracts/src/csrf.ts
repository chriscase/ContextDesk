/**
 * Browser mutation CSRF contract for cookie-authenticated collab HTTP.
 *
 * Sessions travel in a SameSite=Lax cookie. That already withholds the cookie
 * from a cross-site POST/PUT/PATCH/DELETE in modern browsers. This contract
 * adds a second, independently testable control: a custom request header that
 * a cross-site HTML form cannot set, and that a cross-origin fetch/XHR cannot
 * send without a CORS preflight this server never approves.
 *
 * Safe methods (GET/HEAD) stay exempt. State-changing /api methods require the
 * header whenever a session cookie is present, except the narrow pre-auth
 * login, logout, and setup paths documented below.
 */
import { checkObject, f, type ObjectShape } from "./parse.js";

export const COLLAB_CSRF_HEADER = "x-cd-collab-csrf" as const;
export const COLLAB_CSRF_HEADER_VALUE = "1" as const;
export const CSRF_ERROR_SCHEMA_ID = "cd-collab.csrf_error.v1" as const;

export const BROWSER_MUTATION_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
export type BrowserMutationMethod = (typeof BROWSER_MUTATION_METHODS)[number];

export type CsrfErrorCode = "csrf_required";

export interface CsrfErrorV1 {
  schemaId: typeof CSRF_ERROR_SCHEMA_ID;
  error: CsrfErrorCode;
}

const csrfErrorShape: ObjectShape = {
  schemaId: f.req(f.en(CSRF_ERROR_SCHEMA_ID)),
  error: f.req(f.en("csrf_required")),
};

export function parseCsrfError(raw: unknown): CsrfErrorV1 {
  checkObject("$", csrfErrorShape, raw);
  return raw as CsrfErrorV1;
}

/**
 * Normalize an inject or request URL to a pathname without query or trailing
 * slash (except `/`). Used so exemption matching cannot drift on `?` or `/`.
 */
export function apiPathname(url: string): string {
  const withoutQuery = url.split("?")[0] ?? url;
  if (withoutQuery.length > 1 && withoutQuery.endsWith("/")) {
    return withoutQuery.slice(0, -1);
  }
  return withoutQuery;
}

export function isCollabApiPath(url: string): boolean {
  const pathname = apiPathname(url);
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function isBrowserMutationMethod(method: string): boolean {
  return (BROWSER_MUTATION_METHODS as readonly string[]).includes(method.toUpperCase());
}

/**
 * Narrowly justified CSRF exemptions. Keep this list exact-match (plus the
 * `/api/setup/` prefix) so `/api/auth/login/extra` cannot inherit login's
 * exemption.
 *
 * - `POST /api/auth/login`: pre-auth; no session cookie exists yet; the sign-in
 *   form must remain usable.
 * - `POST /api/auth/logout`: explicit exception so the signed-in shell can
 *   clear the cookie without a custom header. A forged logout can at worst
 *   sign the operator out; it cannot write investigation or admin state.
 * - `/api/setup/*`: first-run owner-token setup, authenticated by the setup
 *   token header rather than the session cookie. The wizard must remain
 *   usable before a session exists.
 */
export function isCsrfExemptApiPath(url: string): boolean {
  const pathname = apiPathname(url);
  if (pathname === "/api/auth/login" || pathname === "/api/auth/logout") {
    return true;
  }
  return pathname === "/api/setup" || pathname.startsWith("/api/setup/");
}

export function requiresBrowserMutationCsrf(input: {
  method: string;
  path: string;
  hasSessionCookie: boolean;
}): boolean {
  if (!isBrowserMutationMethod(input.method)) return false;
  if (!isCollabApiPath(input.path)) return false;
  if (isCsrfExemptApiPath(input.path)) return false;
  return input.hasSessionCookie;
}
