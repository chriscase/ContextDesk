import {
  COLLAB_CSRF_HEADER,
  COLLAB_CSRF_HEADER_VALUE,
  CSRF_ERROR_SCHEMA_ID,
  requiresBrowserMutationCsrf,
} from "@cd-collab/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { SESSION_COOKIE } from "./routes.js";

export const CSRF_HEADER = COLLAB_CSRF_HEADER;
export const CSRF_HEADER_VALUE = COLLAB_CSRF_HEADER_VALUE;

const rawInject = new WeakMap<FastifyInstance, FastifyInstance["inject"]>();

export function hasSessionCookieHeader(
  cookieHeader: string | string[] | undefined,
): boolean {
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader;
  if (typeof raw !== "string" || raw.length === 0) return false;
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== SESSION_COOKIE) continue;
    return trimmed.slice(eq + 1).length > 0;
  }
  return false;
}

/**
 * Canonical CSRF header check. Only the exact contract value is accepted.
 * Multi-value headers fail closed.
 */
export function hasCsrfHeader(request: FastifyRequest): boolean {
  const raw = request.headers[CSRF_HEADER];
  if (typeof raw === "string") return raw === CSRF_HEADER_VALUE;
  return false;
}

function csrfError(): { schemaId: typeof CSRF_ERROR_SCHEMA_ID; error: "csrf_required" } {
  return { schemaId: CSRF_ERROR_SCHEMA_ID, error: "csrf_required" };
}

/**
 * Fail-closed browser mutation CSRF: cookie-authenticated POST/PUT/PATCH/DELETE
 * under `/api` must carry the custom header, except login/logout/setup.
 * Registered first so the rejection happens before body parsing and domain writes.
 */
export function registerBrowserMutationCsrfGuard(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    if (
      !requiresBrowserMutationCsrf({
        method: request.method,
        path: request.url,
        hasSessionCookie: hasSessionCookieHeader(request.headers.cookie),
      })
    ) {
      return;
    }
    if (hasCsrfHeader(request)) return;
    return reply.code(403).send(csrfError());
  });
  decorateInjectWithBrowserCsrf(app);
}

/**
 * In-process `app.inject()` is not a browser. Tests and synthetic demo seeders
 * would otherwise have to repeat the CSRF header on every mutation. This wrap
 * attaches the canonical header when the live hook would require it, and never
 * applies to Node HTTP. Adversarial tests that omit the header must use
 * `injectWithoutBrowserCsrf`.
 */
function decorateInjectWithBrowserCsrf(app: FastifyInstance): void {
  if (rawInject.has(app)) return;
  const original = app.inject.bind(app) as FastifyInstance["inject"];
  rawInject.set(app, original);
  const wrapped = ((opts?: unknown, cb?: unknown) => {
    if (opts !== undefined && typeof opts === "object" && opts !== null && typeof cb !== "function") {
      return (original as (options: unknown) => unknown)(attachInjectCsrf(opts as Record<string, unknown>));
    }
    if (opts !== undefined && typeof opts === "object" && opts !== null) {
      return (original as (options: unknown, callback: unknown) => unknown)(
        attachInjectCsrf(opts as Record<string, unknown>),
        cb,
      );
    }
    return (original as (...args: unknown[]) => unknown)(opts, cb);
  }) as FastifyInstance["inject"];
  app.inject = wrapped;
}

export function injectWithoutBrowserCsrf(
  app: FastifyInstance,
  opts: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    payload?: unknown;
  },
): ReturnType<FastifyInstance["inject"]> {
  const original = rawInject.get(app) ?? app.inject.bind(app);
  return (original as (options: unknown) => ReturnType<FastifyInstance["inject"]>)(opts);
}

function attachInjectCsrf(opts: Record<string, unknown>): Record<string, unknown> {
  const headers = headerRecord(opts.headers);
  const cookieHeader = headers.cookie ?? headers.Cookie;
  if (
    !requiresBrowserMutationCsrf({
      method: String(opts.method ?? "GET"),
      path: String(opts.url ?? opts.path ?? ""),
      hasSessionCookie: hasSessionCookieHeader(cookieHeader),
    })
  ) {
    return opts;
  }
  if (Object.keys(headers).some((key) => key.toLowerCase() === CSRF_HEADER)) {
    return opts;
  }
  return {
    ...opts,
    headers: { ...headers, [CSRF_HEADER]: CSRF_HEADER_VALUE },
  };
}

function headerRecord(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
