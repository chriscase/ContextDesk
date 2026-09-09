import { describe, expect, it } from "vitest";
import {
  REFERENCE_RECHECK_CHANGED_SCHEMA_ID,
  REFERENCE_RECHECK_CHANGE_REASONS,
  REFERENCE_RECHECK_IDEMPOTENCY,
  REFERENCE_RECHECK_LIMITS,
  REFERENCE_RECHECK_OUTCOMES,
  REFERENCE_RECHECK_PAGE_SCHEMA_ID,
  REFERENCE_RECHECK_REFUSED_SCHEMA_ID,
  REFERENCE_RECHECK_REFUSALS,
  REFERENCE_RECHECK_REQUEST_SCHEMA_ID,
  REFERENCE_RECHECK_RESPONSE_CONTEXT,
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
const SECOND_RESULT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const HASH = "a".repeat(64);
const CURSOR = "cursor_12345678";

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
    clientTime: "2026-09-09T14:00:00-05:00",
    ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: REFERENCE_RECHECK_SCHEMA_ID,
    id: RESULT_ID,
    caseId: CASE_ID,
    artifactId: ARTIFACT_ID,
    outcome: "reachable_metadata",
    reference: reference(),
    observedAt: "2026-09-09T19:00:01.000Z",
    ...overrides,
  };
}

describe("reference recheck contracts", () => {
  it("parses a route-bound compare-only request without adding omitted fields", () => {
    const parsed = parseReferenceRecheckRequest(request());
    expect(parsed).toEqual(request());
    expect(parsed.expectedReference).not.toHaveProperty("refId");
    expect(parsed.expectedReference).not.toHaveProperty("verificationStatus");

    const withoutClientTime = request();
    delete (withoutClientTime as { clientTime?: string }).clientTime;
    const omitted = parseReferenceRecheckRequest(withoutClientTime);
    expect(omitted).not.toHaveProperty("clientTime");
  });

  it("parses both bounded observation outcomes and excludes verified", () => {
    expect(parseReferenceRecheck(result()).outcome).toBe("reachable_metadata");
    expect(parseReferenceRecheck(result({ outcome: "unreachable" })).outcome).toBe(
      "unreachable",
    );
    expect(() => parseReferenceRecheck(result({ outcome: "verified" }))).toThrow(
      /expected one of/,
    );
    expect(() => parseReferenceRecheck(result({ outcome: "hash_verified" }))).toThrow(
      /expected one of/,
    );
  });

  it("binds success and every history item to one case and artifact", () => {
    const success = parseReferenceRecheckSuccess({
      schemaId: REFERENCE_RECHECK_SUCCESS_SCHEMA_ID,
      caseId: CASE_ID,
      artifactId: ARTIFACT_ID,
      applied: result(),
    });
    expect(success.applied.id).toBe(RESULT_ID);
    expect(success).not.toHaveProperty("replayed");

    const page = parseReferenceRecheckPage({
      schemaId: REFERENCE_RECHECK_PAGE_SCHEMA_ID,
      caseId: CASE_ID,
      artifactId: ARTIFACT_ID,
      items: [
        result(),
        result({ id: SECOND_RESULT_ID, outcome: "unreachable" }),
      ],
      nextCursor: CURSOR,
    });
    expect(page.items.map((item) => item.id)).toEqual([RESULT_ID, SECOND_RESULT_ID]);
    expect(page.nextCursor).toBe(CURSOR);

    expect(() =>
      parseReferenceRecheckSuccess({
        schemaId: REFERENCE_RECHECK_SUCCESS_SCHEMA_ID,
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        applied: result({ caseId: SECOND_RESULT_ID }),
      }),
    ).toThrow(/must match root caseId/);
    expect(() =>
      parseReferenceRecheckPage({
        schemaId: REFERENCE_RECHECK_PAGE_SCHEMA_ID,
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        items: [result({ artifactId: SECOND_RESULT_ID })],
        nextCursor: null,
      }),
    ).toThrow(/must match root artifactId/);
  });

  it("parses bounded changed and refused envelopes", () => {
    expect(
      parseReferenceRecheckChanged({
        schemaId: REFERENCE_RECHECK_CHANGED_SCHEMA_ID,
        error: "reference_recheck_changed",
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        reason: "reference_identity_changed",
        currentReference: reference({ expectedHash: null }),
      }),
    ).toMatchObject({
      reason: "reference_identity_changed",
      currentReference: { expectedHash: null },
    });
    expect(
      parseReferenceRecheckChanged({
        schemaId: REFERENCE_RECHECK_CHANGED_SCHEMA_ID,
        error: "reference_recheck_changed",
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        reason: "idempotency_intent_mismatch",
        currentReference: reference(),
      }).reason,
    ).toBe("idempotency_intent_mismatch");

    expect(
      parseReferenceRecheckRefused({
        schemaId: REFERENCE_RECHECK_REFUSED_SCHEMA_ID,
        error: "reference_recheck_refused",
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        reason: "investigation_archived",
        detail: "Archived investigations do not accept a new reference check.",
        currentReference: reference(),
      }).reason,
    ).toBe("investigation_archived");
    expect(
      parseReferenceRecheckRefused({
        schemaId: REFERENCE_RECHECK_REFUSED_SCHEMA_ID,
        error: "reference_recheck_refused",
        caseId: CASE_ID,
        artifactId: ARTIFACT_ID,
        reason: "observation_unsupported",
        detail: "No trusted observer supports this reference.",
        currentReference: reference(),
      }).reason,
    ).toBe("observation_unsupported");
  });

  it("returns detached deeply frozen request, result, success, page, and errors", () => {
    const input = request();
    const parsedRequest = parseReferenceRecheckRequest(input);
    input.expectedReference.uri = "https://attacker.invalid/changed";
    expect(parsedRequest.expectedReference.uri).toBe(
      "https://files.example.test/incidents/core.log",
    );
    expect(Object.isFrozen(parsedRequest)).toBe(true);
    expect(Object.isFrozen(parsedRequest.expectedReference)).toBe(true);

    const pageInput = {
      schemaId: REFERENCE_RECHECK_PAGE_SCHEMA_ID,
      caseId: CASE_ID,
      artifactId: ARTIFACT_ID,
      items: [result()],
      nextCursor: null,
    };
    const parsedPage = parseReferenceRecheckPage(pageInput);
    pageInput.items[0]!.reference.uri = "https://attacker.invalid/changed";
    expect(parsedPage.items[0]?.reference.uri).toBe(
      "https://files.example.test/incidents/core.log",
    );
    expect(Object.isFrozen(parsedPage)).toBe(true);
    expect(Object.isFrozen(parsedPage.items)).toBe(true);
    expect(Object.isFrozen(parsedPage.items[0])).toBe(true);
    expect(Object.isFrozen(parsedPage.items[0]?.reference)).toBe(true);

    const parsedSuccess = parseReferenceRecheckSuccess({
      schemaId: REFERENCE_RECHECK_SUCCESS_SCHEMA_ID,
      caseId: CASE_ID,
      artifactId: ARTIFACT_ID,
      applied: result(),
    });
    expect(Object.isFrozen(parsedSuccess)).toBe(true);
    expect(Object.isFrozen(parsedSuccess.applied)).toBe(true);

    const changed = parseReferenceRecheckChanged({
      schemaId: REFERENCE_RECHECK_CHANGED_SCHEMA_ID,
      error: "reference_recheck_changed",
      caseId: CASE_ID,
      artifactId: ARTIFACT_ID,
      reason: "reference_identity_changed",
      currentReference: reference(),
    });
    const refused = parseReferenceRecheckRefused({
      schemaId: REFERENCE_RECHECK_REFUSED_SCHEMA_ID,
      error: "reference_recheck_refused",
      caseId: CASE_ID,
      artifactId: ARTIFACT_ID,
      reason: "observation_unsupported",
      detail: "No trusted observer supports this reference.",
      currentReference: reference(),
    });
    expect(Object.isFrozen(changed.currentReference)).toBe(true);
    expect(Object.isFrozen(refused.currentReference)).toBe(true);
  });

  it("freezes server-owned observation, authority, and ambiguous-outcome rules", () => {
    expect(Object.isFrozen(REFERENCE_RECHECK_OUTCOMES)).toBe(true);
    expect(Object.isFrozen(REFERENCE_RECHECK_CHANGE_REASONS)).toBe(true);
    expect(Object.isFrozen(REFERENCE_RECHECK_REFUSALS)).toBe(true);
    expect(REFERENCE_RECHECK_RESPONSE_CONTEXT).toEqual({
      routeIdentity:
        "request_and_response_case_and_artifact_equal_authoritative_route_identities",
      observationTarget:
        "server_loaded_reference_only_and_request_reference_is_compare_only",
      authorization:
        "post_requires_write_and_reads_require_read_with_private_artifact_concealment",
      successIdentity:
        "applied_reference_equals_request_precondition_and_server_revalidated_reference",
      changedIdentity:
        "current_reference_is_server_loaded_and_never_a_second_lookup_target",
    });
    expect(REFERENCE_RECHECK_IDEMPOTENCY.lookupKey).toEqual([
      "authenticatedActorIdentityId",
      "caseId",
      "artifactId",
      "idempotencyKey",
    ]);
    expect(REFERENCE_RECHECK_IDEMPOTENCY.uncertainOutcome).toContain(
      "get_reconciliation_before_manual_replay",
    );
    expect(REFERENCE_RECHECK_IDEMPOTENCY.automaticPostRetry).toBe(false);
    expect(Object.isFrozen(REFERENCE_RECHECK_LIMITS)).toBe(true);
    expect(Object.isFrozen(REFERENCE_RECHECK_RESPONSE_CONTEXT)).toBe(true);
    expect(Object.isFrozen(REFERENCE_RECHECK_IDEMPOTENCY)).toBe(true);
    expect(Object.isFrozen(REFERENCE_RECHECK_IDEMPOTENCY.lookupKey)).toBe(true);
    expect(Object.isFrozen(REFERENCE_RECHECK_IDEMPOTENCY.intentFields)).toBe(true);
    expect(Object.isFrozen(REFERENCE_RECHECK_IDEMPOTENCY.replayBefore)).toBe(true);
  });
});
