import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TriageRunPanel } from "./TriageRunPanel.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function response(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

function lane(
  candidateId: string,
  status: string,
  overrides: Partial<{ startedAt: string | null; errorCode: string | null; role: string }> = {},
) {
  return {
    candidateId,
    role: overrides.role ?? "reviewer",
    provider: "synthetic",
    profileId: null,
    model: `${candidateId}-model`,
    version: null,
    status,
    benchmarkRunId: null,
    outputHash: null,
    summary: null,
    evidenceRefs: [],
    unknowns: [],
    errorCode: overrides.errorCode ?? null,
    privacyClass: "owner_only",
    startedAt: "startedAt" in overrides ? overrides.startedAt ?? null : "2026-08-20T00:00:00.000Z",
  };
}

const CAPABILITIES = {
  schemaId: "cd-collab.triage_job_capabilities.v1",
  syntheticAvailable: true,
  gatewayAvailable: true,
  gatewayMinCandidates: 2,
  gatewayMaxCandidates: 16,
  profileCatalogConfigured: true,
  profileCount: 2,
  progressEventsPerLane: 2,
  maxProgressEvents: 32,
  maxEvidenceItemBytes: 4 * 1024 * 1024,
  maxEvidenceAggregateBytes: 8 * 1024 * 1024,
  cancellationSupported: true,
  retrySemantics: "explicit_rerun_idempotent",
  usageAvailable: false,
  costAvailable: false,
  unavailable: [
    "provider token usage is not reported by this host",
    "provider cost is not reported by this host",
  ],
};

function mountWith(job: Record<string, unknown>, capabilities: unknown = CAPABILITIES) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/snapshots")) return response({ snapshots: [] });
      if (url.endsWith("/evidence")) return response({ artifacts: [] });
      if (url.endsWith("/imports")) return response({ runs: [] });
      if (url.endsWith("/api/triage-capabilities")) return response(capabilities);
      if (url.endsWith("/api/triage-profiles")) return response({ profiles: [] });
      if (url.endsWith("/triage-runs")) return response({ caseId: "case-1", jobs: [job] });
      return response({});
    }),
  );
  return render(<TriageRunPanel caseId="case-1" canLead={false} readOnly />);
}

function jobFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    snapshotId: "snapshot-1",
    snapshotFingerprint: "a".repeat(64),
    requestFingerprint: "b".repeat(64),
    request: {
      strategyId: "contextdesk.standard",
      question: "What happened?",
      taskFingerprint: "task-1",
      mode: "gateway",
      candidates: [],
    },
    status: "running",
    candidates: [lane("lane-a", "running")],
    sameSnapshot: null,
    agreementNotice: "Agreement is not proof of correctness.",
    createdAt: "2026-08-20T00:00:00.000Z",
    startedAt: "2026-08-20T00:00:00.000Z",
    finishedAt: null,
    cancelRequestedAt: null,
    leaseExpiresAt: "2126-08-20T00:00:00.000Z",
    lastProgressAt: "2026-08-20T00:00:00.000Z",
    failure: null,
    ...overrides,
  };
}

describe("the primary progress view for a slow gateway", () => {
  it("shows lane, stage, completed of total, elapsed, and last movement", async () => {
    mountWith(jobFixture({
      candidates: [
        lane("lane-a", "completed"),
        lane("lane-b", "running", { role: "second-opinion" }),
      ],
    }));
    const wait = await screen.findByLabelText("contextdesk.standard wait state");
    expect(wait.textContent).toContain("Lane second-opinion");
    expect(wait.textContent).toContain("1/2 lanes produced a result");
    expect(wait.textContent).toMatch(/running \d/);
    expect(wait.textContent).toMatch(/last movement .* ago/);
  });

  it("states the operator's next action in words", async () => {
    mountWith(jobFixture());
    const wait = await screen.findByLabelText("contextdesk.standard wait state");
    expect(wait.textContent).toContain("Next:");
  });

  it("keeps raw trace, usage, and cost noise out of the primary view", async () => {
    mountWith(jobFixture({
      candidates: [lane("lane-a", "running"), lane("lane-b", "queued", { startedAt: null })],
    }));
    const wait = await screen.findByLabelText("contextdesk.standard wait state");
    const text = wait.textContent ?? "";
    expect(text).not.toMatch(/token|usage|cost|\$|trace|stack|http[s]?:\/\//i);
    // Concise enough to read at a glance while a gateway is slow.
    expect(text.length).toBeLessThanOrEqual(600);
  });

  it("names a stalled run as stalled even while its lease is being renewed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-20T00:10:00.000Z"));
    mountWith(jobFixture({
      // Renewed far into the future, but nothing has moved in ten minutes.
      leaseExpiresAt: "2126-08-20T00:00:00.000Z",
      lastProgressAt: "2026-08-20T00:00:00.000Z",
    }));
    const wait = await screen.findByLabelText("contextdesk.standard wait state");
    expect(wait.getAttribute("data-run-state")).toBe("stalled");
    expect(wait.textContent).toContain("no lane has moved recently");
  });

  it("marks a queued rerun as retrying rather than as a fresh queue", async () => {
    mountWith(jobFixture({
      status: "queued",
      parentJobId: "job-earlier",
      startedAt: null,
      leaseExpiresAt: null,
      lastProgressAt: null,
      candidates: [lane("lane-a", "queued", { startedAt: null })],
    }));
    const wait = await screen.findByLabelText("contextdesk.standard wait state");
    expect(wait.getAttribute("data-run-state")).toBe("retrying");
  });

  it("names a lapsed lease as stalled rather than as still running", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-20T00:05:00.000Z"));
    mountWith(jobFixture({ leaseExpiresAt: "2026-08-20T00:01:00.000Z" }));
    const wait = await screen.findByLabelText("contextdesk.standard wait state");
    expect(wait.getAttribute("data-run-state")).toBe("stalled");
    expect(wait.textContent).toContain("stopped reporting");
  });
});

describe("an over-budget evidence refusal in the reader's view", () => {
  const failed = jobFixture({
    status: "failed",
    finishedAt: "2026-08-20T00:00:05.000Z",
    candidates: [
      lane("lane-a", "failed", { startedAt: null, errorCode: "evidence_budget_exceeded" }),
      lane("lane-b", "failed", { startedAt: null, errorCode: "evidence_budget_exceeded" }),
    ],
    failure: {
      code: "evidence_budget_exceeded",
      scope: "aggregate",
      allowedBytes: 8 * 1024 * 1024,
      actualBytes: 8 * 1024 * 1024 + 512 * 1024,
    },
  });

  it("explains the refusal with both numbers and says nothing was sent", async () => {
    mountWith(failed);
    const note = await screen.findByText(/over the 8 MiB limit/);
    expect(note.getAttribute("data-run-failure")).toBe("evidence_budget_exceeded");
    expect(note.textContent).toContain("8.50 MiB");
    expect(note.textContent).toContain("Nothing was sent to a provider");
    expect(note.textContent).toContain("retrying this one will refuse again");
  });

  it("does not fall back to the generic no-result note for a named refusal", async () => {
    mountWith(failed);
    await screen.findByText(/over the 8 MiB limit/);
    expect(screen.queryByText(/No lane produced a result on this run/)).toBeNull();
  });

  it("calls the retry safe because nothing reached a provider", async () => {
    mountWith(failed);
    const retry = await screen.findByText(/^Retry:/);
    expect(retry.getAttribute("data-retry-disposition")).toBe("safe");
    expect(retry.textContent).toContain("Trim the frozen evidence first");
  });
});

describe("retry disposition after a lost lane", () => {
  it("calls a retry uncertain when a lane started and the host lost it", async () => {
    mountWith(jobFixture({
      status: "failed",
      finishedAt: "2026-08-20T00:05:00.000Z",
      candidates: [
        lane("lane-a", "failed", { errorCode: "gateway_runner_error" }),
        lane("lane-b", "completed"),
      ],
    }));
    const retry = await screen.findByText(/^Retry:/);
    expect(retry.getAttribute("data-retry-disposition")).toBe("uncertain");
    expect(retry.textContent).toContain("may repeat work that already ran");
  });

  it("calls a retry safe when no lane was ever dispatched", async () => {
    mountWith(jobFixture({
      status: "cancelled",
      finishedAt: "2026-08-20T00:00:02.000Z",
      cancelRequestedAt: "2026-08-20T00:00:01.000Z",
      candidates: [lane("lane-a", "cancelled", { startedAt: null })],
    }));
    const retry = await screen.findByText(/^Retry:/);
    expect(retry.getAttribute("data-retry-disposition")).toBe("safe");
  });
});

describe("the launcher's readiness statement", () => {
  it("states executable lane limits, evidence limits, cancellation and retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/snapshots")) {
          return response({
            snapshots: [{
              id: "snapshot-1",
              fingerprint: "a".repeat(64),
              evidence: [],
              createdBy: "lead",
              fairnessClass: "same_snapshot",
            }],
          });
        }
        if (url.endsWith("/evidence")) return response({ artifacts: [] });
        if (url.endsWith("/imports")) return response({ runs: [] });
        if (url.endsWith("/api/triage-capabilities")) return response(CAPABILITIES);
        if (url.endsWith("/api/triage-profiles")) return response({ profiles: [] });
        if (url.endsWith("/triage-runs")) return response({ caseId: "case-1", jobs: [] });
        return response({});
      }),
    );
    render(<TriageRunPanel caseId="case-1" canLead readOnly={false} />);
    const readiness = await screen.findByTestId("triage-readiness");
    const text = readiness.textContent ?? "";
    expect(text).toContain("2–16 gateway lanes");
    expect(text).toContain("every count in that range is executable");
    expect(text).toContain("8 MiB per run");
    expect(text).toContain("4 MiB per item");
    expect(text).toContain("Cancellation is durable");
    expect(text).toContain("explicit rerun bound to the run it repeats");
    expect(text).toContain("provider cost is not reported by this host");
  });
});
