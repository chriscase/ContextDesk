import { describe, expect, it } from "vitest";
import {
  classifyHttpFailure,
  classifyRequestException,
  protocolFailure,
} from "./errors.js";

describe("runtime failure classification", () => {
  it.each([401, 403] as const)(
    "classifies %i as authentication loss before consulting known body fields",
    (status) => {
      expect(classifyHttpFailure(status, {
        kind: "lifecycle_refused",
        action: "archive",
        reason: "legal_hold",
      })).toEqual({ kind: "auth_lost", status });
    },
  );

  it("classifies the stable status vocabulary", () => {
    expect(classifyHttpFailure(400)).toEqual({ kind: "validation", status: 400 });
    expect(classifyHttpFailure(404)).toEqual({ kind: "not_found", status: 404 });
    expect(classifyHttpFailure(409)).toEqual({ kind: "conflict", status: 409 });
    expect(classifyHttpFailure(503)).toEqual({ kind: "unavailable", status: 503 });
    expect(classifyHttpFailure(500)).toEqual({ kind: "server_failure", status: 500 });
    expect(classifyHttpFailure(599)).toEqual({ kind: "server_failure", status: 599 });
    expect(classifyHttpFailure(418)).toEqual({
      kind: "unexpected_response",
      status: 418,
    });
    expect(classifyHttpFailure(200)).toEqual({
      kind: "unexpected_response",
      status: 200,
    });
  });

  it("uses only bounded, known lifecycle fields for a 409 refusal", () => {
    expect(classifyHttpFailure(409, {
      kind: "lifecycle_refused",
      action: "archive",
      reason: "legal_hold",
    })).toEqual({
      kind: "lifecycle_refused",
      status: 409,
      action: "archive",
      reason: "legal_hold",
    });
  });

  it("does not let known lifecycle fields override a different status", () => {
    expect(classifyHttpFailure(503, {
      kind: "lifecycle_refused",
      action: "restore",
      reason: "not_archived",
    })).toEqual({ kind: "unavailable", status: 503 });
  });

  it.each([
    "content_type",
    "json",
    "contract",
    "identity",
  ] as const)("creates a bounded %s protocol failure", (reason) => {
    expect(protocolFailure(reason)).toEqual({ kind: "protocol", reason });
  });

  it("classifies request exceptions without publishing their contents", () => {
    const secret = "private-host.invalid/token-123";
    expect(classifyRequestException(new TypeError(secret))).toEqual({ kind: "network" });
    expect(classifyRequestException(new Error(secret))).toEqual({ kind: "unexpected" });
    expect(classifyRequestException({ name: "NetworkError", message: secret })).toEqual({
      kind: "network",
    });
    expect(JSON.stringify(classifyRequestException(new Error(secret)))).not.toContain(secret);
  });

  it("recognizes explicit and platform-style cancellation before network errors", () => {
    expect(classifyRequestException(new TypeError("cancelled"), true)).toEqual({
      kind: "aborted",
    });
    expect(classifyRequestException({
      name: "AbortError",
      message: "request and URL must stay private",
    })).toEqual({ kind: "aborted" });
  });
});
