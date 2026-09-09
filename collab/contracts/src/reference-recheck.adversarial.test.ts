import { describe, expect, it } from "vitest";
import { ContractViolation } from "./parse.js";
import {
  REFERENCE_RECHECK_CHANGED_SCHEMA_ID,
  REFERENCE_RECHECK_LIMITS,
  REFERENCE_RECHECK_PAGE_SCHEMA_ID,
  REFERENCE_RECHECK_REFUSED_SCHEMA_ID,
  REFERENCE_RECHECK_REQUEST_SCHEMA_ID,
  REFERENCE_RECHECK_SCHEMA_ID,
  REFERENCE_RECHECK_SUCCESS_SCHEMA_ID,
  parseReferenceRecheck,
  parseReferenceRecheckChanged,
  parseReferenceRecheckPage,
  parseReferenceRecheckRefused,
  parseReferenceRecheckRequest,
  parseReferenceRecheckSuccess,
} from "./reference-recheck.js";

const CASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ARTIFACT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RESULT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HASH = "a".repeat(64);

function reference(overrides: Record<string, unknown> = {}) {
  return {
    kind: "file_server_ref",
    uri: "https://files.example.test/incidents/core.log",
    expectedHash: HASH,
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: REFERENCE_RECHECK_REQUEST_SCHEMA_ID,
    caseId: CASE_ID,
    artifactId: ARTIFACT_ID,
    expectedReference: reference(),
    idempotencyKey: "recheck-key-1234",
    ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: REFERENCE_RECHECK_SCHEMA_ID,
    id: RESULT_ID,
    caseId: CASE_ID,
    artifactId: ARTIFACT_ID,
    outcome: "unreachable",
    reference: reference(),
    observedAt: "2026-09-09T19:00:01.000Z",
    ...overrides,
  };
}

describe("reference recheck adversarial parsing", () => {
  it("rejects unknown fields at every envelope and nested boundary", () => {
    expect(() => parseReferenceRecheckRequest(request({ role: "admin" }))).toThrow(
      /unknown key/,
    );
    expect(() =>
      parseReferenceRecheckRequest(request({
        expectedReference: reference({ refId: "internal-ref" }),
      })),
    ).toThrow(/unknown key/);
    expect(() =>
      parseReferenceRecheckRequest(request({
        expectedReference: reference({ verificationStatus: "verified" }),
      })),
    ).toThrow(/unknown key/);
    expect(() => parseReferenceRecheck(result({ providerError: "secret" }))).toThrow(
      /unknown key/,
    );
    expect(() =>
      parseReferenceRecheckSuccess({
        schemaId: REFERENCE_RECHECK_SUCCESS_SCHEMA_ID,
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        applied: result({ credentials: "secret" }),
      }),
    ).toThrow(/unknown key/);
    expect(() =>
      parseReferenceRecheckChanged({
        schemaId: REFERENCE_RECHECK_CHANGED_SCHEMA_ID,
        error: "reference_recheck_changed",
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        reason: "reference_identity_changed",
        currentReference: reference(),
        retryAfter: 1,
      }),
    ).toThrow(/unknown key/);
    expect(() =>
      parseReferenceRecheckRefused({
        schemaId: REFERENCE_RECHECK_REFUSED_SCHEMA_ID,
        error: "reference_recheck_refused",
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        reason: "observation_unsupported",
        detail: "No trusted observer supports this reference.",
        currentReference: reference({ provider: "s3" }),
      }),
    ).toThrow(/unknown key/);
  });

  it("rejects non-plain roots before every public parser reads a property", () => {
    const validEnvelopes: readonly [
      parser: (raw: unknown) => unknown,
      raw: Record<string, unknown>,
    ][] = [
      [parseReferenceRecheckRequest, request()],
      [parseReferenceRecheck, result()],
      [parseReferenceRecheckSuccess, {
        schemaId: REFERENCE_RECHECK_SUCCESS_SCHEMA_ID,
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        applied: result(),
      }],
      [parseReferenceRecheckPage, {
        schemaId: REFERENCE_RECHECK_PAGE_SCHEMA_ID,
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        items: [result()],
        nextCursor: null,
      }],
      [parseReferenceRecheckChanged, {
        schemaId: REFERENCE_RECHECK_CHANGED_SCHEMA_ID,
        error: "reference_recheck_changed",
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        reason: "reference_identity_changed",
        currentReference: reference(),
      }],
      [parseReferenceRecheckRefused, {
        schemaId: REFERENCE_RECHECK_REFUSED_SCHEMA_ID,
        error: "reference_recheck_refused",
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        reason: "observation_unsupported",
        detail: "No trusted observer supports this reference.",
        currentReference: reference(),
      }],
    ];

    for (const [parser, valid] of validEnvelopes) {
      let getterCalls = 0;
      const accessor = { ...valid };
      Object.defineProperty(accessor, "caseId", {
        configurable: true,
        enumerable: true,
        get() {
          getterCalls += 1;
          return CASE_ID;
        },
      });
      expect(() => parser(accessor)).toThrow(/accessor properties/);
      expect(getterCalls).toBe(0);

      const inherited = Object.assign(Object.create({ role: "admin" }), valid);
      expect(() => parser(inherited)).toThrow(/plain data with no inherited properties/);
    }
  });

  it("rejects nested accessors, symbols, cycles, hidden fields, and custom array keys", () => {
    let getterCalls = 0;
    const accessorReference = reference();
    Object.defineProperty(accessorReference, "uri", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "https://attacker.invalid/observed";
      },
    });
    expect(() =>
      parseReferenceRecheckRequest(request({ expectedReference: accessorReference })),
    ).toThrow(/accessor properties/);
    expect(getterCalls).toBe(0);

    const symbolReference = reference() as Record<PropertyKey, unknown>;
    symbolReference[Symbol("provider-secret")] = "secret";
    expect(() =>
      parseReferenceRecheckRequest(request({ expectedReference: symbolReference })),
    ).toThrow(/symbol keys/);

    const cyclicReference = reference() as Record<string, unknown>;
    cyclicReference.loop = cyclicReference;
    expect(() =>
      parseReferenceRecheckRequest(request({ expectedReference: cyclicReference })),
    ).toThrow(/cyclic values/);

    const hiddenReference = reference();
    Object.defineProperty(hiddenReference, "provider", {
      configurable: true,
      enumerable: false,
      value: "secret",
    });
    expect(() =>
      parseReferenceRecheckRequest(request({ expectedReference: hiddenReference })),
    ).toThrow(/non-enumerable properties/);

    const items = [result()] as unknown[] & { authority?: string };
    items.authority = "admin";
    expect(() =>
      parseReferenceRecheckPage({
        schemaId: REFERENCE_RECHECK_PAGE_SCHEMA_ID,
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        items,
        nextCursor: null,
      }),
    ).toThrow(/unknown array key/);

    const numericCustomKeyItems = [result()];
    Object.defineProperty(numericCustomKeyItems, "4294967295", {
      configurable: true,
      enumerable: true,
      value: result(),
    });
    expect(() =>
      parseReferenceRecheckPage({
        schemaId: REFERENCE_RECHECK_PAGE_SCHEMA_ID,
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        items: numericCustomKeyItems,
        nextCursor: null,
      }),
    ).toThrow(/unknown array key/);

    let itemGetterCalls = 0;
    const accessorItems = [result()];
    Object.defineProperty(accessorItems, "0", {
      configurable: true,
      enumerable: true,
      get() {
        itemGetterCalls += 1;
        return result();
      },
    });
    expect(() =>
      parseReferenceRecheckPage({
        schemaId: REFERENCE_RECHECK_PAGE_SCHEMA_ID,
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        items: accessorItems,
        nextCursor: null,
      }),
    ).toThrow(/accessor properties/);
    expect(itemGetterCalls).toBe(0);
  });

  it("accepts null-prototype records as inert plain data", () => {
    const expectedReference = Object.assign(Object.create(null), reference());
    const plainRequest = Object.assign(
      Object.create(null),
      request({ expectedReference }),
    );
    expect(parseReferenceRecheckRequest(plainRequest)).toEqual(request());
  });

  it("rejects malformed identities, digests, keys, clocks, and cursors", () => {
    for (const invalidId of [
      "",
      "not-a-uuid",
      CASE_ID.toUpperCase(),
      "aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa",
    ]) {
      expect(() => parseReferenceRecheckRequest(request({ caseId: invalidId }))).toThrow(
        ContractViolation,
      );
    }
    expect(() =>
      parseReferenceRecheckRequest(request({ artifactId: CASE_ID })),
    ).not.toThrow();
    expect(() =>
      parseReferenceRecheckRequest(request({
        expectedReference: reference({ expectedHash: HASH.toUpperCase() }),
      })),
    ).toThrow(/lowercase SHA-256/);
    expect(() =>
      parseReferenceRecheckRequest(request({
        expectedReference: reference({ expectedHash: "f".repeat(63) }),
      })),
    ).toThrow(/lowercase SHA-256/);
    expect(() => parseReferenceRecheckRequest(request({ idempotencyKey: "short" }))).toThrow(
      /8\.\.128/,
    );
    expect(() =>
      parseReferenceRecheckRequest(request({ idempotencyKey: `a${"b".repeat(128)}` })),
    ).toThrow(/8\.\.128/);
    expect(() =>
      parseReferenceRecheckRequest(request({ clientTime: "2026-09-09" })),
    ).toThrow(/ISO-8601/);
    expect(() =>
      parseReferenceRecheckPage({
        schemaId: REFERENCE_RECHECK_PAGE_SCHEMA_ID,
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        items: [],
        nextCursor: "unsafe/cursor",
      }),
    ).toThrow(/opaque cursor/);
  });

  it("rejects unsafe, normalized-different, and oversized compare-only URIs", () => {
    for (const uri of [
      " https://files.example.test/core.log",
      "https://files.example.test/core.log\nnext",
      "https://files.example.test/core\u202Egol",
      "https://files.example.test/\u212b",
      "x".repeat(REFERENCE_RECHECK_LIMITS.uriMaxChars + 1),
    ]) {
      expect(() =>
        parseReferenceRecheckRequest(request({ expectedReference: reference({ uri }) })),
      ).toThrow(ContractViolation);
    }
    expect(() =>
      parseReferenceRecheckRequest(request({
        expectedReference: reference({ uri: "s3://recorded-bucket/key" }),
      })),
    ).not.toThrow();
  });

  it("rejects sparse, duplicate, oversized, and cross-scope history pages", () => {
    const sparse = new Array(1);
    expect(() =>
      parseReferenceRecheckPage({
        schemaId: REFERENCE_RECHECK_PAGE_SCHEMA_ID,
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        items: sparse,
        nextCursor: null,
      }),
    ).toThrow(/sparse array/);

    expect(() =>
      parseReferenceRecheckPage({
        schemaId: REFERENCE_RECHECK_PAGE_SCHEMA_ID,
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        items: [result(), result()],
        nextCursor: null,
      }),
    ).toThrow(/duplicate result identity/);

    expect(() =>
      parseReferenceRecheckPage({
        schemaId: REFERENCE_RECHECK_PAGE_SCHEMA_ID,
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        items: Array.from(
          { length: REFERENCE_RECHECK_LIMITS.pageMaxItems + 1 },
          () => null,
        ),
        nextCursor: null,
      }),
    ).toThrow(/at most/);

    expect(() =>
      parseReferenceRecheckPage({
        schemaId: REFERENCE_RECHECK_PAGE_SCHEMA_ID,
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        items: [result({ caseId: ARTIFACT_ID })],
        nextCursor: null,
      }),
    ).toThrow(/must match root caseId/);
  });

  it("rejects false replay, verification, authority, and provider claims", () => {
    expect(() =>
      parseReferenceRecheckSuccess({
        schemaId: REFERENCE_RECHECK_SUCCESS_SCHEMA_ID,
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        applied: result(),
        replayed: true,
      }),
    ).toThrow(/unknown key/);
    for (const outcome of ["verified", "hash_verified", "identity_conflict"] as const) {
      expect(() => parseReferenceRecheck(result({ outcome }))).toThrow(ContractViolation);
    }
    expect(() =>
      parseReferenceRecheckRequest(request({ actorId: "identity-admin" })),
    ).toThrow(/unknown key/);
    expect(() =>
      parseReferenceRecheck(result({
        reference: reference({ actualBytes: "dGVzdA==" }),
      })),
    ).toThrow(/unknown key/);
  });

  it("rejects unsafe or oversized refusal details and invalid reason pairings", () => {
    const refused = (overrides: Record<string, unknown>) => ({
      schemaId: REFERENCE_RECHECK_REFUSED_SCHEMA_ID,
      error: "reference_recheck_refused",
      caseId: CASE_ID,
      artifactId: ARTIFACT_ID,
      reason: "observation_unsupported",
      detail: "No trusted observer supports this reference.",
      currentReference: reference(),
      ...overrides,
    });
    expect(() => parseReferenceRecheckRefused(refused({ detail: "line one\nline two" }))).toThrow(
      /single-line/,
    );
    expect(() =>
      parseReferenceRecheckRefused(refused({
        detail: "x".repeat(REFERENCE_RECHECK_LIMITS.detailMaxChars + 1),
      })),
    ).toThrow(/at most/);
    expect(() =>
      parseReferenceRecheckRefused(refused({ reason: "identity_conflict" })),
    ).toThrow(/expected one of/);
    expect(() =>
      parseReferenceRecheckChanged({
        schemaId: REFERENCE_RECHECK_CHANGED_SCHEMA_ID,
        error: "reference_recheck_changed",
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        reason: "investigation_archived",
        currentReference: reference(),
      }),
    ).toThrow(/expected one of/);
  });
});
