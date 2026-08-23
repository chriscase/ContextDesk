import { describe, expect, it } from "vitest";
import {
  isTriageFromJobRequest,
  parseTriageJob,
  parseTriageJobCapabilities,
  parseTriageJobCreateRequest,
  parseTriageJobRequest,
  triageJobRequestFingerprint,
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

const snapshotFingerprint = "a".repeat(64);

describe("triage job contracts", () => {
  it("accepts a provider-agnostic snapshot-bound request", () => {
    expect(parseTriageJobRequest(request).candidates[0]?.model).toBe("qwen-3.6-27b");
  });

  it("accepts safe host capability metadata without configuration details", () => {
    const capabilities = parseTriageJobCapabilities({
      schemaId: "cd-collab.triage_job_capabilities.v1",
      syntheticAvailable: true,
      gatewayAvailable: false,
      gatewayMinCandidates: 2,
      gatewayMaxCandidates: 16,
      profileCatalogConfigured: true,
      profileCount: 2,
    });
    expect(capabilities.gatewayAvailable).toBe(false);
    expect(capabilities.profileCount).toBe(2);
    expect(JSON.stringify(capabilities)).not.toContain("endpoint");
  });

  it("keeps the v1 job request parser stable and versions the create union separately", () => {
    expect(JSON.stringify(parseTriageJobRequest(request))).toBe(JSON.stringify(request));
    const rerun = {
      schemaId: "cd-collab.triage_job_create_request.v1" as const,
      fromJobId: "job-1",
      snapshotId: "snapshot-2",
      mode: "deterministic_mock" as const,
    };
    const parsed = parseTriageJobCreateRequest(rerun);
    expect(parsed).toEqual(rerun);
    expect(isTriageFromJobRequest(parsed)).toBe(true);
    expect(() => parseTriageJobRequest(rerun)).toThrow();
    expect(() =>
      parseTriageJobCreateRequest({
        ...rerun,
        question: "override",
      }),
    ).toThrow();
    expect(() =>
      parseTriageJobCreateRequest({
        ...request,
        fromJobId: "job-1",
      }),
    ).toThrow();
    expect(() => parseTriageJobCreateRequest({ fromJobId: "job-1" })).toThrow();
    expect(() =>
      parseTriageJobCreateRequest({
        ...rerun,
        mode: "live",
      }),
    ).toThrow();
    expect(() => parseTriageJobRequest({ ...request, parentJobId: "job-0" })).toThrow();
  });

  it("rejects contract drift and preserves unknown metrics", () => {
    expect(() => parseTriageJobRequest({ ...request, unexpected: true })).toThrow();
    expect(
      parseTriageJob({
        schemaId: "cd-collab.triage_job.v1",
        id: "job-1",
        caseId: "case-1",
        snapshotId: "snapshot-1",
        snapshotFingerprint,
        requestFingerprint: triageJobRequestFingerprint(snapshotFingerprint, request),
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

  it("rejects persisted snapshot/request drift, noncanonical fingerprints, and invalid lineage", () => {
    const valid = {
      schemaId: "cd-collab.triage_job.v1" as const,
      id: "job-1",
      caseId: "case-1",
      snapshotId: request.snapshotId,
      snapshotFingerprint,
      requestFingerprint: triageJobRequestFingerprint(snapshotFingerprint, request),
      cancellationId: "cancel-1",
      request,
      status: "queued" as const,
      candidates: request.candidates.map((candidate) => ({
        ...candidate,
        status: "queued" as const,
        benchmarkRunId: null,
        outputHash: null,
        summary: null,
        evidenceRefs: [],
        unknowns: [],
        usageStatus: "unknown" as const,
        costStatus: "unknown" as const,
        errorCode: null,
        startedAt: null,
        finishedAt: null,
        privacyClass: "owner_only" as const,
      })),
      sameSnapshot: null,
      agreementNotice: "Agreement is not proof of correctness." as const,
      requestedBy: "lead",
      requestedByUsername: "lead",
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      cancelRequestedAt: null,
      stoppedReason: null,
    };
    expect(parseTriageJob(valid)).toEqual(valid);
    expect(() => parseTriageJob({ ...valid, snapshotId: "snapshot-other" })).toThrow(
      /must match the persisted job snapshotId/,
    );
    expect(() => parseTriageJob({ ...valid, snapshotFingerprint: "bad" })).toThrow(
      /SHA-256/,
    );
    expect(() => parseTriageJob({ ...valid, requestFingerprint: "b".repeat(64) })).toThrow(
      /canonical triage request fingerprint/,
    );
    expect(() => parseTriageJob({ ...valid, parentJobId: "" })).toThrow(/must not be empty/);
    expect(() => parseTriageJob({ ...valid, parentJobId: valid.id })).toThrow(
      /must not reference the job itself/,
    );
  });
});
