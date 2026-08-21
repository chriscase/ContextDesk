import { describe, expect, it } from "vitest";
import { parseTriageJob, parseTriageJobCapabilities, parseTriageJobRequest } from "./triage-job.js";

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
});
