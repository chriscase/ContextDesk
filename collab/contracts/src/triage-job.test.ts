import { describe, expect, it } from "vitest";
import { ContractViolation } from "./parse.js";
import {
  TRIAGE_JOB_RERUN_AUTHORITY,
  TRIAGE_JOB_RERUN_IDEMPOTENCY,
  TRIAGE_JOB_RERUN_REFUSALS,
  TRIAGE_JOB_RERUN_REFUSED_SCHEMA_ID,
  TRIAGE_JOB_RERUN_REQUEST_SCHEMA_ID,
  TRIAGE_JOB_RERUN_RESPONSE_CONTEXT,
  TRIAGE_JOB_RERUN_SUCCESS_SCHEMA_ID,
  parseTriageJob,
  parseTriageJobCapabilities,
  parseTriageJobRequest,
  parseTriageJobRerunRefused,
  parseTriageJobRerunRequest,
  parseTriageJobRerunSuccess,
  type TriageJobRerunResponseContextV1,
  type TriageJobV1,
} from "./triage-job.js";

const request = {
  schemaId: "cd-collab.triage_job_request.v1",
  snapshotId: "snapshot-1",
  mode: "deterministic_mock",
  strategyId: "contextdesk.standard",
  question: "What happened and what should we inspect next?",
  policyFingerprint: null,
  taskFingerprint: "task-fingerprint",
  candidates: [
    {
      candidateId: "qwen-reviewer",
      role: "reviewer",
      provider: "synthetic",
      profileId: null,
      model: "qwen-3.6-27b",
      version: null,
    },
  ],
};

const CASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FROM_JOB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TARGET_SNAPSHOT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const APPLIED_JOB_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FROM_FINGERPRINT = "a".repeat(64);
const TARGET_FINGERPRINT = "b".repeat(64);
const APPLIED_REQUEST_FINGERPRINT = "c".repeat(64);

const rerunContext: TriageJobRerunResponseContextV1 = {
  caseId: CASE_ID,
  fromJobId: FROM_JOB_ID,
  targetSnapshotId: TARGET_SNAPSHOT_ID,
};

function rerunRequest(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: TRIAGE_JOB_RERUN_REQUEST_SCHEMA_ID,
    caseId: CASE_ID,
    fromJobId: FROM_JOB_ID,
    targetSnapshotId: TARGET_SNAPSHOT_ID,
    expectedFromRequestFingerprint: FROM_FINGERPRINT,
    expectedTargetSnapshotFingerprint: TARGET_FINGERPRINT,
    idempotencyKey: "triage-rerun-0001",
    ...overrides,
  };
}

function appliedJob(overrides: Partial<TriageJobV1> = {}): TriageJobV1 {
  return {
    schemaId: "cd-collab.triage_job.v1",
    id: APPLIED_JOB_ID,
    caseId: CASE_ID,
    snapshotId: TARGET_SNAPSHOT_ID,
    snapshotFingerprint: TARGET_FINGERPRINT,
    requestFingerprint: APPLIED_REQUEST_FINGERPRINT,
    cancellationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    parentJobId: FROM_JOB_ID,
    request: {
      ...request,
      snapshotId: TARGET_SNAPSHOT_ID,
      parentJobId: FROM_JOB_ID,
    },
    status: "queued",
    candidates: [],
    sameSnapshot: true,
    agreementNotice: "Agreement is not proof of correctness.",
    requestedBy: "uid=lead",
    requestedByUsername: "lead",
    createdAt: "2026-09-09T12:00:00.000Z",
    updatedAt: "2026-09-09T12:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    stoppedReason: null,
    ...overrides,
  };
}

function rerunSuccess(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: TRIAGE_JOB_RERUN_SUCCESS_SCHEMA_ID,
    caseId: CASE_ID,
    fromJobId: FROM_JOB_ID,
    targetSnapshotId: TARGET_SNAPSHOT_ID,
    applied: appliedJob(),
    replayed: false,
    ...overrides,
  };
}

function rerunRefused(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: TRIAGE_JOB_RERUN_REFUSED_SCHEMA_ID,
    error: "triage_job_rerun_refused",
    caseId: CASE_ID,
    fromJobId: FROM_JOB_ID,
    targetSnapshotId: TARGET_SNAPSHOT_ID,
    reason: "case_archived",
    detail: "The investigation is archived.",
    ...overrides,
  };
}

describe("triage job contracts", () => {
  it("accepts a provider-agnostic snapshot-bound request", () => {
    expect(parseTriageJobRequest(request).candidates[0]?.model).toBe("qwen-3.6-27b");
  });

  it("accepts safe host capability metadata without configuration details", () => {
    const capabilities = parseTriageJobCapabilities({
      schemaId: "cd-collab.triage_job_capabilities.v1",
      syntheticAvailable: true,
      gatewayAvailable: false,
      gatewayMinCandidates: 1,
      gatewayMaxCandidates: 16,
      profileCatalogConfigured: true,
      profileCount: 2,
    });
    expect(capabilities.gatewayAvailable).toBe(false);
    expect(capabilities.profileCount).toBe(2);
    expect(JSON.stringify(capabilities)).not.toContain("endpoint");
  });

  it("rejects contract drift and preserves unknown metrics", () => {
    expect(() => parseTriageJobRequest({ ...request, unexpected: true })).toThrow();
    expect(
      parseTriageJob({
        schemaId: "cd-collab.triage_job.v1",
        id: "job-1",
        caseId: "case-1",
        snapshotId: "snapshot-1",
        snapshotFingerprint: "fingerprint",
        requestFingerprint: "request-fingerprint",
        cancellationId: "cancel-1",
        request,
        status: "completed",
        candidates: [
          {
            ...request.candidates[0],
            status: "completed",
            benchmarkRunId: null,
            outputHash: "hash",
            summary: "Synthetic evidence-backed result.",
            evidenceRefs: ["artifact-1"],
            unknowns: ["usage", "cost"],
            usageStatus: "unknown",
            costStatus: "unknown",
            errorCode: null,
            startedAt: "2026-08-20T00:00:00.000Z",
            finishedAt: "2026-08-20T00:00:00.010Z",
            privacyClass: "owner_only",
          },
        ],
        sameSnapshot: true,
        agreementNotice: "Agreement is not proof of correctness.",
        requestedBy: "uid=lead",
        requestedByUsername: "lead",
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.010Z",
        startedAt: "2026-08-20T00:00:00.000Z",
        finishedAt: "2026-08-20T00:00:00.010Z",
        cancelRequestedAt: null,
        stoppedReason: null,
      }).candidates[0]?.usageStatus,
    ).toBe("unknown");
  });

  it("preserves the legacy request parser and its backwards-compatible identifiers", () => {
    const parsed = parseTriageJobRequest(request);
    expect(parsed).toBe(request);
    expect(parsed.snapshotId).toBe("snapshot-1");
  });
});

describe("strict triage rerun contracts", () => {
  it("parses a canonical server-resolved rerun intent as a detached frozen value", () => {
    const raw = rerunRequest();
    const parsed = parseTriageJobRerunRequest(raw);
    expect(parsed).toEqual(raw);
    expect(parsed).not.toBe(raw);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(raw)).toBe(false);
  });

  it("rejects sparse, unknown, non-canonical, and unsafe request values", () => {
    for (const key of [
      "schemaId",
      "caseId",
      "fromJobId",
      "targetSnapshotId",
      "expectedFromRequestFingerprint",
      "expectedTargetSnapshotFingerprint",
      "idempotencyKey",
    ]) {
      const sparse = rerunRequest();
      delete (sparse as Record<string, unknown>)[key];
      expect(() => parseTriageJobRerunRequest(sparse), key).toThrow(ContractViolation);
    }
    expect(() => parseTriageJobRerunRequest(rerunRequest({ extra: true }))).toThrow(
      ContractViolation,
    );
    expect(() =>
      parseTriageJobRerunRequest(rerunRequest({ caseId: CASE_ID.toUpperCase() })),
    ).toThrow(ContractViolation);
    expect(() =>
      parseTriageJobRerunRequest(
        rerunRequest({ expectedFromRequestFingerprint: FROM_FINGERPRINT.toUpperCase() }),
      ),
    ).toThrow(ContractViolation);
    expect(() =>
      parseTriageJobRerunRequest(rerunRequest({ idempotencyKey: "short" })),
    ).toThrow(ContractViolation);
    expect(() =>
      parseTriageJobRerunRequest(
        rerunRequest({ idempotencyKey: `x${"a".repeat(128)}` }),
      ),
    ).toThrow(ContractViolation);
    expect(() =>
      parseTriageJobRerunRequest(rerunRequest({ idempotencyKey: "bad key!" })),
    ).toThrow(ContractViolation);
  });

  it("accepts exact idempotency-key bounds", () => {
    expect(
      parseTriageJobRerunRequest(rerunRequest({ idempotencyKey: "a1234567" }))
        .idempotencyKey,
    ).toBe("a1234567");
    const maximum = `a${"b".repeat(127)}`;
    expect(
      parseTriageJobRerunRequest(rerunRequest({ idempotencyKey: maximum }))
        .idempotencyKey,
    ).toBe(maximum);
  });

  it("binds a strict success to trusted context and deeply freezes a copy", () => {
    const raw = rerunSuccess();
    const parsed = parseTriageJobRerunSuccess(raw, rerunContext);
    expect(parsed.applied.id).toBe(APPLIED_JOB_ID);
    expect(parsed.applied.parentJobId).toBe(FROM_JOB_ID);
    expect(parsed.applied.request.snapshotId).toBe(TARGET_SNAPSHOT_ID);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.applied)).toBe(true);
    expect(Object.isFrozen(parsed.applied.request)).toBe(true);
    expect(Object.isFrozen(parsed.applied.candidates)).toBe(true);
    expect(Object.isFrozen(raw)).toBe(false);
    expect(Object.isFrozen(raw.applied)).toBe(false);
    raw.applied.request.question = "Caller mutated the response after parsing.";
    expect(parsed.applied.request.question).toBe(request.question);
  });

  it("rejects success envelope, trusted-context, and applied-job identity drift", () => {
    expect(() =>
      parseTriageJobRerunSuccess(rerunSuccess({ unexpected: true }), rerunContext),
    ).toThrow(ContractViolation);
    expect(() =>
      parseTriageJobRerunSuccess(rerunSuccess(), {
        ...rerunContext,
        caseId: "55555555-5555-4555-8555-555555555555",
      }),
    ).toThrow(ContractViolation);
    expect(() =>
      parseTriageJobRerunSuccess(rerunSuccess(), {
        ...rerunContext,
        unexpected: true,
      }),
    ).toThrow(ContractViolation);
    expect(() =>
      parseTriageJobRerunSuccess(
        rerunSuccess({ applied: appliedJob({ caseId: "55555555-5555-4555-8555-555555555555" }) }),
        rerunContext,
      ),
    ).toThrow(ContractViolation);
    expect(() =>
      parseTriageJobRerunSuccess(
        rerunSuccess({ applied: appliedJob({ snapshotId: "55555555-5555-4555-8555-555555555555" }) }),
        rerunContext,
      ),
    ).toThrow(ContractViolation);
    expect(() =>
      parseTriageJobRerunSuccess(
        rerunSuccess({ applied: appliedJob({ parentJobId: "55555555-5555-4555-8555-555555555555" }) }),
        rerunContext,
      ),
    ).toThrow(ContractViolation);
  });

  it("rejects malformed strict applied-job identities and fingerprints", () => {
    expect(() =>
      parseTriageJobRerunSuccess(
        rerunSuccess({ applied: appliedJob({ id: "job-1" }) }),
        rerunContext,
      ),
    ).toThrow(ContractViolation);
    expect(() =>
      parseTriageJobRerunSuccess(
        rerunSuccess({ applied: appliedJob({ id: FROM_JOB_ID }) }),
        rerunContext,
      ),
    ).toThrow(ContractViolation);
    expect(() =>
      parseTriageJobRerunSuccess(
        rerunSuccess({ applied: appliedJob({ cancellationId: "cancel-1" }) }),
        rerunContext,
      ),
    ).toThrow(ContractViolation);
    expect(() =>
      parseTriageJobRerunSuccess(
        rerunSuccess({ applied: appliedJob({ snapshotFingerprint: "not-a-digest" }) }),
        rerunContext,
      ),
    ).toThrow(ContractViolation);
    expect(() =>
      parseTriageJobRerunSuccess(
        rerunSuccess({ applied: appliedJob({ requestFingerprint: "D".repeat(64) }) }),
        rerunContext,
      ),
    ).toThrow(ContractViolation);
  });

  it("parses every exact refusal reason with schema/error/context pairing", () => {
    for (const reason of TRIAGE_JOB_RERUN_REFUSALS) {
      const parsed = parseTriageJobRerunRefused(rerunRefused({ reason }), rerunContext);
      expect(parsed.reason).toBe(reason);
      expect(parsed.error).toBe("triage_job_rerun_refused");
      expect(Object.isFrozen(parsed)).toBe(true);
    }
  });

  it("rejects refusal drift, mismatched context, and unsafe detail", () => {
    expect(() =>
      parseTriageJobRerunRefused(rerunRefused({ error: "conflict" }), rerunContext),
    ).toThrow(ContractViolation);
    expect(() =>
      parseTriageJobRerunRefused(rerunRefused({ reason: "unknown" }), rerunContext),
    ).toThrow(ContractViolation);
    expect(() =>
      parseTriageJobRerunRefused(rerunRefused({ extra: true }), rerunContext),
    ).toThrow(ContractViolation);
    expect(() =>
      parseTriageJobRerunRefused(rerunRefused(), {
        ...rerunContext,
        targetSnapshotId: "55555555-5555-4555-8555-555555555555",
      }),
    ).toThrow(ContractViolation);
    expect(() =>
      parseTriageJobRerunRefused(rerunRefused({ detail: "unsafe\u0000detail" }), rerunContext),
    ).toThrow(ContractViolation);
    expect(() =>
      parseTriageJobRerunRefused(rerunRefused({ detail: "x".repeat(601) }), rerunContext),
    ).toThrow(ContractViolation);
  });

  it("keeps authority, replay rules, and response bindings frozen", () => {
    expect(Object.isFrozen(TRIAGE_JOB_RERUN_AUTHORITY)).toBe(true);
    expect(Object.isFrozen(TRIAGE_JOB_RERUN_IDEMPOTENCY)).toBe(true);
    expect(Object.isFrozen(TRIAGE_JOB_RERUN_IDEMPOTENCY.lookupKey)).toBe(true);
    expect(Object.isFrozen(TRIAGE_JOB_RERUN_IDEMPOTENCY.intentFields)).toBe(true);
    expect(Object.isFrozen(TRIAGE_JOB_RERUN_IDEMPOTENCY.excludesFromIntent)).toBe(true);
    expect(Object.isFrozen(TRIAGE_JOB_RERUN_IDEMPOTENCY.replayBefore)).toBe(true);
    expect(Object.isFrozen(TRIAGE_JOB_RERUN_RESPONSE_CONTEXT)).toBe(true);
  });
});
