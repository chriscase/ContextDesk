import { describe, expect, it } from "vitest";
import { ContractViolation } from "./parse.js";
import {
  BROWSER_MUTATION_METHODS,
  COLLAB_CSRF_HEADER,
  COLLAB_CSRF_HEADER_VALUE,
  CSRF_ERROR_SCHEMA_ID,
  apiPathname,
  isBrowserMutationMethod,
  isCollabApiPath,
  isCsrfExemptApiPath,
  parseCsrfError,
  requiresBrowserMutationCsrf,
} from "./csrf.js";

describe("browser mutation CSRF contract", () => {
  it("keeps the header name/value as a non-simple CORS header", () => {
    expect(COLLAB_CSRF_HEADER).toBe("x-cd-collab-csrf");
    expect(COLLAB_CSRF_HEADER.startsWith("x-")).toBe(true);
    expect(COLLAB_CSRF_HEADER_VALUE).toBe("1");
    expect(BROWSER_MUTATION_METHODS).toEqual(["POST", "PUT", "PATCH", "DELETE"]);
  });

  it("treats only POST/PUT/PATCH/DELETE as mutations", () => {
    expect(isBrowserMutationMethod("POST")).toBe(true);
    expect(isBrowserMutationMethod("patch")).toBe(true);
    expect(isBrowserMutationMethod("GET")).toBe(false);
    expect(isBrowserMutationMethod("HEAD")).toBe(false);
    expect(isBrowserMutationMethod("OPTIONS")).toBe(false);
  });

  it("exempts only login, logout, and setup paths, including query/slash variants", () => {
    expect(isCsrfExemptApiPath("/api/auth/login")).toBe(true);
    expect(isCsrfExemptApiPath("/api/auth/login/")).toBe(true);
    expect(isCsrfExemptApiPath("/api/auth/login?next=/cases")).toBe(true);
    expect(isCsrfExemptApiPath("/api/auth/logout")).toBe(true);
    expect(isCsrfExemptApiPath("/api/setup")).toBe(true);
    expect(isCsrfExemptApiPath("/api/setup/claim")).toBe(true);
    expect(isCsrfExemptApiPath("/api/setup/secrets")).toBe(true);
    expect(isCsrfExemptApiPath("/api/setup/draft")).toBe(true);
    expect(isCsrfExemptApiPath("/api/setup/verify")).toBe(true);
    expect(isCsrfExemptApiPath("/api/auth/login/extra")).toBe(false);
    expect(isCsrfExemptApiPath("/api/auth/logins")).toBe(false);
    expect(isCsrfExemptApiPath("/api/setupfoo")).toBe(false);
    expect(isCsrfExemptApiPath("/api/cases")).toBe(false);
    expect(isCsrfExemptApiPath("/api/authz/group-role-map")).toBe(false);
    expect(isCsrfExemptApiPath("/health")).toBe(false);
  });

  it("requires the header only for cookie-authenticated /api mutations", () => {
    expect(
      requiresBrowserMutationCsrf({
        method: "POST",
        path: "/api/cases",
        hasSessionCookie: true,
      }),
    ).toBe(true);
    expect(
      requiresBrowserMutationCsrf({
        method: "POST",
        path: "/api/cases",
        hasSessionCookie: false,
      }),
    ).toBe(false);
    expect(
      requiresBrowserMutationCsrf({
        method: "GET",
        path: "/api/cases",
        hasSessionCookie: true,
      }),
    ).toBe(false);
    expect(
      requiresBrowserMutationCsrf({
        method: "POST",
        path: "/api/auth/login",
        hasSessionCookie: true,
      }),
    ).toBe(false);
    expect(
      requiresBrowserMutationCsrf({
        method: "POST",
        path: "/api/auth/logout",
        hasSessionCookie: true,
      }),
    ).toBe(false);
    expect(
      requiresBrowserMutationCsrf({
        method: "PUT",
        path: "/api/setup/draft",
        hasSessionCookie: true,
      }),
    ).toBe(false);
    expect(
      requiresBrowserMutationCsrf({
        method: "POST",
        path: "/health",
        hasSessionCookie: true,
      }),
    ).toBe(false);
  });

  it("normalizes pathnames and recognizes /api routes", () => {
    expect(apiPathname("/api/cases?x=1")).toBe("/api/cases");
    expect(apiPathname("/api/cases/")).toBe("/api/cases");
    expect(isCollabApiPath("/api/cases")).toBe(true);
    expect(isCollabApiPath("/ready")).toBe(false);
  });

  it("parses the fail-closed CSRF error and rejects drift", () => {
    expect(
      parseCsrfError({ schemaId: CSRF_ERROR_SCHEMA_ID, error: "csrf_required" }),
    ).toEqual({ schemaId: CSRF_ERROR_SCHEMA_ID, error: "csrf_required" });
    expect(() =>
      parseCsrfError({ schemaId: CSRF_ERROR_SCHEMA_ID, error: "forbidden" }),
    ).toThrow(ContractViolation);
    expect(() =>
      parseCsrfError({
        schemaId: CSRF_ERROR_SCHEMA_ID,
        error: "csrf_required",
        extra: true,
      }),
    ).toThrow(/unknown key/);
  });
});
