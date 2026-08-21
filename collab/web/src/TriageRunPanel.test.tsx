import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("TriageRunPanel", () => {
  it("does not let a stale polling response roll back a newer lane state", async () => {
    vi.useFakeTimers();
    let requestIndex = 0;
    const pendingLoads: Record<number, Array<{ url: string; resolve: (value: ReturnType<typeof response>) => void }>> = {};
    const queuedJob = {
      id: "job-1",
      snapshotId: "snapshot-1",
      snapshotFingerprint: "a".repeat(64),
      requestFingerprint: "b".repeat(64),
      request: {
        strategyId: "contextdesk.standard",
        question: "What happened?",
        taskFingerprint: "task-1",
        mode: "gateway" as const,
        candidates: [],
      },
      status: "running",
      candidates: [{
        candidateId: "qwen-reviewer",
        role: "reviewer",
        provider: "synthetic",
        profileId: null,
        model: "qwen-3.6-27b",
        version: null,
        status: "queued",
        benchmarkRunId: null,
        outputHash: null,
        summary: null,
        evidenceRefs: [],
        unknowns: [],
        errorCode: null,
        privacyClass: "owner_only",
      }],
      sameSnapshot: null,
      agreementNotice: "Agreement is not proof of correctness.",
      createdAt: "2026-08-20T00:00:00.000Z",
      startedAt: "2026-08-20T00:00:00.000Z",
      finishedAt: null,
      cancelRequestedAt: null,
    };
    const completedJob = {
      ...queuedJob,
      status: "completed",
      candidates: queuedJob.candidates.map((candidate) => ({
        ...candidate,
        status: "completed",
        summary: "newer lane state",
        outputHash: "c".repeat(64),
      })),
      sameSnapshot: true,
      finishedAt: "2026-08-20T00:00:00.010Z",
    };
    const resolveLoad = (loadIndex: number, jobs: unknown[]) => {
      for (const pending of pendingLoads[loadIndex] ?? []) {
        const url = pending.url;
        if (url.endsWith("/snapshots")) pending.resolve(response({ snapshots: [] }));
        else if (url.endsWith("/evidence")) pending.resolve(response({ artifacts: [] }));
        else if (url.endsWith("/imports")) pending.resolve(response({ runs: [] }));
        else if (url.endsWith("/api/triage-profiles")) pending.resolve(response({ profiles: [] }));
        else if (url.endsWith("/api/triage-capabilities")) pending.resolve(response({ gatewayAvailable: true }));
        else pending.resolve(response({ jobs }));
      }
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo) => {
      const url = String(input);
      const loadIndex = Math.floor(requestIndex / 6);
      requestIndex += 1;
      if (loadIndex === 0) {
        if (url.endsWith("/snapshots")) return Promise.resolve(response({ snapshots: [] }));
        if (url.endsWith("/evidence")) return Promise.resolve(response({ artifacts: [] }));
        if (url.endsWith("/imports")) return Promise.resolve(response({ runs: [] }));
        if (url.endsWith("/api/triage-profiles")) return Promise.resolve(response({ profiles: [] }));
        if (url.endsWith("/api/triage-capabilities")) return Promise.resolve(response({ gatewayAvailable: true }));
        return Promise.resolve(response({ jobs: [queuedJob] }));
      }
      return new Promise((resolve) => {
        (pendingLoads[loadIndex] ??= []).push({ url, resolve });
      });
    }));
    const flush = async () => {
      await act(async () => {
        for (let index = 0; index < 10; index += 1) await Promise.resolve();
      });
    };

    render(<TriageRunPanel caseId="case-1" canLead={false} readOnly />);
    await flush();
    expect(screen.getByText("reviewer · queued")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      window.dispatchEvent(new Event("contextdesk:external-run-imported"));
    });
    await act(async () => {
      resolveLoad(2, [completedJob]);
    });
    await flush();
    expect(screen.getByText("newer lane state")).toBeTruthy();
    expect(screen.getByText("reviewer · settled")).toBeTruthy();

    await act(async () => {
      resolveLoad(1, [queuedJob]);
    });
    expect(screen.getByText("newer lane state")).toBeTruthy();
    expect(screen.getByText("reviewer · settled")).toBeTruthy();
    expect(screen.queryByText("reviewer · queued")).toBeNull();
  });

  it("presents a snapshot-bound comparison and keeps provider output claims explicit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/snapshots")) {
          return response({
            snapshots: [
              {
                id: "snapshot-1",
                fingerprint: "a".repeat(64),
                evidence: [{ evidenceId: "artifact-1" }],
                createdBy: "lead",
              },
            ],
          });
        }
        if (url.endsWith("/evidence")) {
          return response({
            artifacts: [
              { id: "artifact-1", kind: "log", filename: "checkout.log", verificationStatus: "verified" },
            ],
          });
        }
        return response({
          jobs: [
            {
              id: "job-1",
              snapshotId: "snapshot-1",
              snapshotFingerprint: "a".repeat(64),
              requestFingerprint: "b".repeat(64),
              request: { strategyId: "contextdesk.standard", question: "What happened?", taskFingerprint: "task-1", mode: "deterministic_mock" },
              status: "completed",
              candidates: [
                {
                  candidateId: "qwen-reviewer",
                  role: "reviewer",
                  provider: "synthetic",
                  profileId: null,
                  model: "qwen-3.6-27b",
                  version: null,
                  status: "completed",
                  benchmarkRunId: null,
                  outputHash: "c".repeat(64),
                  summary: "Inspect the frozen evidence before changing the mitigation.",
                  evidenceRefs: ["artifact-1"],
                  unknowns: ["usage", "cost"],
                  errorCode: null,
                  privacyClass: "owner_only",
                },
              ],
              sameSnapshot: true,
              agreementNotice: "Agreement is not proof of correctness.",
              createdAt: "2026-08-20T00:00:00.000Z",
              startedAt: "2026-08-20T00:00:00.000Z",
              finishedAt: "2026-08-20T00:00:00.010Z",
              cancelRequestedAt: null,
            },
          ],
        });
      }),
    );

    render(<TriageRunPanel caseId="case-1" canLead readOnly={false} />);
    expect(await screen.findByText("Start a snapshot-bound comparison")).toBeTruthy();
    expect(screen.getAllByText("qwen-3.6-27b", { exact: false }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("reviewer · settled")).toBeTruthy();
    expect(screen.getByText("Lanes settle independently; final same-snapshot proof waits for all lanes.")).toBeTruthy();
    expect(screen.getByText(/Same frozen snapshot/)).toBeTruthy();
    expect(screen.getByText("checkout.log")).toBeTruthy();
    expect(screen.getByText(/Agreement is not proof of correctness/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use this setup again" })).toBeTruthy();
    expect(screen.queryByText(/schemaId/)).toBeNull();
  });

  it("adds an operator-picked lane by identifiers only and rejects DeepSeek", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/snapshots")) {
          return response({
            snapshots: [
              {
                id: "snapshot-1",
                fingerprint: "a".repeat(64),
                evidence: [{ evidenceId: "artifact-1" }],
                createdBy: "lead",
              },
            ],
          });
        }
        if (url.endsWith("/evidence")) return response({ artifacts: [] });
        if (url.endsWith("/imports")) return response({ runs: [] });
        if (url.endsWith("/api/triage-profiles")) return response({ profiles: [] });
        if (url.endsWith("/api/triage-capabilities")) return response({ gatewayAvailable: false });
        return response({ jobs: [] });
      }),
    );
    render(<TriageRunPanel caseId="case-1" canLead readOnly={false} />);
    expect(await screen.findByText("Add a model lane")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("New lane alias"), {
      target: { value: "deepseek-lane" },
    });
    fireEvent.change(screen.getByLabelText("New lane model id"), {
      target: { value: "qwen-3.6-27b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add lane" }));
    expect(
      await screen.findByText("DeepSeek lanes are not permitted in this deployment."),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText("New lane alias"), {
      target: { value: "extra-challenger" },
    });
    fireEvent.change(screen.getByLabelText("New lane model id"), {
      target: { value: "ministral-3-14b-instruct-2512" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add lane" }));
    await waitFor(() =>
      expect(screen.getAllByText("ministral-3-14b-instruct-2512").length).toBeGreaterThanOrEqual(2),
    );
    expect(screen.queryByText("DeepSeek lanes are not permitted in this deployment.")).toBeNull();
    expect(screen.getByText(/extra-challenger · reviewer/)).toBeTruthy();
  });

  it("keeps read-only history visible without launch or cancellation controls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        if (String(input).endsWith("/snapshots")) return response({ snapshots: [] });
        return response({ jobs: [] });
      }),
    );
    render(<TriageRunPanel caseId="case-1" canLead={false} readOnly />);
    expect(await screen.findByText(/No triage runs yet/)).toBeTruthy();
    expect(screen.queryByText("Start a snapshot-bound comparison")).toBeNull();
    expect(screen.queryByRole("button", { name: /Run synthetic comparison/ })).toBeNull();
  });

  it("redacts provider-shaped errors instead of rendering secrets or endpoints", async () => {
    const secret = "sk-live-should-never-render";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/snapshots")) {
          return response({ error: `Authorization: Bearer ${secret}; endpoint https://ai-gateway.vercel.sh/v1` }, false);
        }
        if (url.endsWith("/evidence")) return response({ artifacts: [] });
        if (url.endsWith("/imports")) return response({ runs: [] });
        return response({ jobs: [] });
      }),
    );

    render(<TriageRunPanel caseId="case-1" canLead={false} readOnly />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Snapshots could not be loaded.");
    expect(screen.queryByText(secret)).toBeNull();
    expect(screen.queryByText(/ai-gateway\.vercel\.sh/)).toBeNull();
  });

  it("configures each gateway lane with its own host profile", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/snapshots")) {
        return response({
          snapshots: [{ id: "snapshot-1", fingerprint: "a".repeat(64), evidence: [], createdBy: "lead" }],
        });
      }
      if (url.endsWith("/evidence")) return response({ artifacts: [] });
      if (url.endsWith("/imports")) return response({ runs: [] });
      if (url.endsWith("/api/triage-profiles")) {
        return response({
          profiles: [
            { id: "profile:qwen", label: "Qwen gateway", provider: "openai-compatible" },
            { id: "profile:gpt", label: "GPT gateway", provider: "openai-compatible" },
          ],
        });
      }
      if (init?.method === "POST") return response({ id: "job-1" });
      return response({ jobs: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TriageRunPanel caseId="case-1" canLead readOnly={false} />);
    await screen.findByRole("heading", { name: "Run history" });
    fireEvent.change(screen.getByRole("combobox", { name: "Execution mode" }), { target: { value: "gateway" } });
    expect((screen.getByRole("combobox", { name: "Lane concurrency" }) as HTMLSelectElement).value).toBe("2");
    fireEvent.change(screen.getByRole("combobox", { name: "Lane concurrency" }), { target: { value: "3" } });
    fireEvent.change(screen.getByRole("combobox", { name: "qwen-3.6-27b host connector profile" }), { target: { value: "profile:qwen" } });
    fireEvent.change(screen.getByRole("combobox", { name: "gpt-oss-120b host connector profile" }), { target: { value: "profile:gpt" } });
    fireEvent.change(screen.getByRole("combobox", { name: "ministral-3-14b-instruct-2512 host connector profile" }), { target: { value: "profile:qwen" } });
    fireEvent.click(screen.getByRole("button", { name: "Run gateway comparison" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/cases/case-1/triage-runs",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"profileId":"profile:qwen"'),
      }),
    ));
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")?.[1];
    expect(request?.body).toContain('"profileId":"profile:gpt"');
    expect(request?.body).toContain('"concurrency":3');
  });

  it("restores gateway lane concurrency when reusing a run setup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/snapshots")) {
          return response({ snapshots: [{ id: "snapshot-1", fingerprint: "a".repeat(64), evidence: [], createdBy: "lead" }] });
        }
        if (url.endsWith("/evidence")) return response({ artifacts: [] });
        if (url.endsWith("/imports")) return response({ runs: [] });
        if (url.endsWith("/api/triage-profiles")) return response({ profiles: [] });
        if (url.endsWith("/api/triage-capabilities")) return response({ gatewayAvailable: true });
        return response({
          jobs: [{
            id: "job-1",
            snapshotId: "snapshot-1",
            snapshotFingerprint: "a".repeat(64),
            requestFingerprint: "b".repeat(64),
            request: {
              strategyId: "contextdesk.standard",
              question: "What happened?",
              taskFingerprint: "task-1",
              mode: "gateway",
              concurrency: 4,
              candidates: [
                { candidateId: "qwen-reviewer", role: "reviewer", provider: "openai-compatible", profileId: "profile:qwen", model: "qwen-3.6-27b", version: null },
                { candidateId: "gpt-oss-contributor", role: "contributor", provider: "openai-compatible", profileId: "profile:gpt", model: "gpt-oss-120b", version: null },
              ],
            },
            status: "completed",
            candidates: [],
            sameSnapshot: true,
            agreementNotice: "Agreement is not proof of correctness.",
            createdAt: "2026-08-20T00:00:00.000Z",
            startedAt: "2026-08-20T00:00:00.000Z",
            finishedAt: "2026-08-20T00:00:00.010Z",
            cancelRequestedAt: null,
          }],
        });
      }),
    );

    render(<TriageRunPanel caseId="case-1" canLead readOnly={false} />);
    vi.stubGlobal("scrollTo", vi.fn());
    fireEvent.click(await screen.findByRole("button", { name: "Use this setup again" }));

    expect((await screen.findByRole("combobox", { name: "Lane concurrency" }) as HTMLSelectElement).value).toBe("4");
  });

  it("shows each candidate's independent queued, running, or settled lifecycle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/snapshots")) return response({ snapshots: [] });
        if (url.endsWith("/evidence")) return response({ artifacts: [] });
        if (url.endsWith("/imports")) return response({ runs: [] });
        if (url.endsWith("/api/triage-capabilities")) return response({ gatewayAvailable: true });
        if (url.endsWith("/api/triage-profiles")) return response({ profiles: [] });
        return response({
          jobs: [{
            id: "job-running",
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
            candidates: [
              {
                candidateId: "queued-lane",
                role: "reviewer",
                provider: "synthetic",
                profileId: null,
                model: "queued-model",
                version: null,
                status: "queued",
                benchmarkRunId: null,
                outputHash: null,
                summary: null,
                evidenceRefs: [],
                unknowns: [],
                errorCode: null,
                privacyClass: "owner_only",
              },
              {
                candidateId: "running-lane",
                role: "contributor",
                provider: "synthetic",
                profileId: null,
                model: "running-model",
                version: null,
                status: "running",
                benchmarkRunId: null,
                outputHash: null,
                summary: null,
                evidenceRefs: [],
                unknowns: [],
                errorCode: null,
                privacyClass: "owner_only",
              },
              {
                candidateId: "settled-lane",
                role: "challenger",
                provider: "synthetic",
                profileId: null,
                model: "settled-model",
                version: null,
                status: "completed",
                benchmarkRunId: null,
                outputHash: "c".repeat(64),
                summary: "Settled result.",
                evidenceRefs: [],
                unknowns: [],
                errorCode: null,
                privacyClass: "owner_only",
              },
            ],
            sameSnapshot: null,
            agreementNotice: "Agreement is not proof of correctness.",
            createdAt: "2026-08-20T00:00:00.000Z",
            startedAt: "2026-08-20T00:00:00.000Z",
            finishedAt: null,
            cancelRequestedAt: null,
          }],
        });
      }),
    );

    render(<TriageRunPanel caseId="case-1" canLead={false} readOnly />);
    expect(await screen.findByText("reviewer · queued")).toBeTruthy();
    expect(screen.getByText("contributor · running")).toBeTruthy();
    expect(screen.getByText("challenger · settled")).toBeTruthy();
  });

  it("shows when gateway execution is unavailable instead of offering a doomed launch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/snapshots")) return response({ snapshots: [{ id: "snapshot-1", fingerprint: "a".repeat(64), evidence: [], createdBy: "lead" }] });
        if (url.endsWith("/evidence")) return response({ artifacts: [] });
        if (url.endsWith("/imports")) return response({ runs: [] });
        if (url.endsWith("/api/triage-capabilities")) {
          return response({
            schemaId: "cd-collab.triage_job_capabilities.v1",
            syntheticAvailable: true,
            gatewayAvailable: false,
            gatewayMinCandidates: 2,
            gatewayMaxCandidates: 16,
            profileCatalogConfigured: false,
            profileCount: 0,
          });
        }
        if (url.endsWith("/api/triage-profiles")) return response({ profiles: [] });
        return response({ jobs: [] });
      }),
    );
    render(<TriageRunPanel caseId="case-1" canLead readOnly={false} />);
    await screen.findByRole("heading", { name: "Run history" });
    expect((screen.getByRole("option", { name: "Gateway unavailable on this host" }) as HTMLOptionElement).disabled).toBe(true);
  });

  it("hands a completed or partial connected run to Experiment Lab with an optional chat run", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/snapshots")) return response({ snapshots: [] });
      if (url.endsWith("/evidence")) return response({ artifacts: [] });
      if (url.endsWith("/imports")) {
        return response({
          runs: [
            {
              id: "external-chat-1",
              promptText: null,
              promptCompleteness: "unknown",
              importerUsername: "reviewer",
              operatorUsername: "operator",
              snapshotBinding: null,
              evidenceVisibility: "unknown",
              corroborationState: "unverified",
            },
          ],
        });
      }
      if (init?.method === "POST" && url.endsWith("/experiments/from-triage/job-partial")) {
        return response({ id: "experiment-handoff-1" });
      }
      return response({
        jobs: [
          {
            id: "job-partial",
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
            status: "partial",
            candidates: [],
            sameSnapshot: true,
            agreementNotice: "Agreement is not proof of correctness.",
            createdAt: "2026-08-20T00:00:00.000Z",
            startedAt: "2026-08-20T00:00:00.000Z",
            finishedAt: "2026-08-20T00:00:00.010Z",
            cancelRequestedAt: null,
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TriageRunPanel caseId="case-1" canLead readOnly={false} />);
    expect(await screen.findByRole("button", { name: "Review in Experiment Lab" })).toBeTruthy();
    const selector = screen.getByRole("combobox", { name: "External chat run to compare" });
    expect(screen.getByRole("option", { name: /operator · unknown prompt/ })).toBeTruthy();

    fireEvent.change(selector, { target: { value: "external-chat-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Review in Experiment Lab" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/cases/case-1/experiments/from-triage/job-partial",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ externalRunId: "external-chat-1" }),
      }),
    ));
    expect((await screen.findByRole("status")).textContent).toMatch(/Experiment .* is ready in Experiment Lab/);
  });
});
