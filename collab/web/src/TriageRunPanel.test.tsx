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

    render(
      <TriageRunPanel
        caseId="case-1"
        canLead
        readOnly={false}
        routeFocus={{
          section: "triage-lane-runner",
          item: "job-1:qwen-reviewer",
          itemKind: "triage-candidate",
          lane: null,
          experiment: null,
        }}
      />,
    );
    expect(await screen.findByText("Start a snapshot-bound comparison")).toBeTruthy();
    expect(screen.getAllByText("qwen-3.6-27b", { exact: false }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("reviewer · settled")).toBeTruthy();
    expect(screen.getByText("Lanes settle independently; final same-snapshot proof waits for all lanes.")).toBeTruthy();
    expect(screen.getByText(/Same frozen snapshot/)).toBeTruthy();
    expect(screen.getByText("checkout.log")).toBeTruthy();
    expect(screen.getByText(/Agreement is not proof of correctness/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use this setup again" })).toBeTruthy();
    expect(screen.queryByText(/schemaId/)).toBeNull();
    const candidate = document.querySelector(
      '[data-route-item="job-1:qwen-reviewer"][data-route-kind="triage-candidate"]',
    ) as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(candidate));
  });

  it("keeps large citation sets collapsed until the engineer asks for them", async () => {
    const evidenceRefs = Array.from({ length: 20 }, (_, index) => `artifact-${index + 1}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/snapshots")) {
          return response({
            snapshots: [{
              id: "snapshot-1",
              fingerprint: "a".repeat(64),
              evidence: evidenceRefs.map((evidenceId) => ({ evidenceId })),
              createdBy: "lead",
            }],
          });
        }
        if (url.endsWith("/evidence")) {
          return response({
            artifacts: evidenceRefs.map((id, index) => ({
              id,
              kind: "log",
              filename: `service-${index + 1}.log`,
              verificationStatus: "verified",
            })),
          });
        }
        if (url.endsWith("/imports")) return response({ runs: [] });
        if (url.endsWith("/api/triage-profiles")) return response({ profiles: [] });
        if (url.endsWith("/api/triage-capabilities")) return response({ gatewayAvailable: false });
        return response({
          jobs: [1, 2].map((jobIndex) => ({
            id: `job-large-${jobIndex}`,
            snapshotId: "snapshot-1",
            snapshotFingerprint: "a".repeat(64),
            requestFingerprint: String(jobIndex).repeat(64),
            request: {
              strategyId: `contextdesk.standard-${jobIndex}`,
              question: "What happened?",
              taskFingerprint: `task-large-${jobIndex}`,
              mode: "deterministic_mock",
              candidates: [],
            },
            status: "completed",
            candidates: [{
              candidateId: `reviewer-${jobIndex}`,
              role: "reviewer",
              provider: "synthetic",
              profileId: null,
              model: `model-${jobIndex}`,
              version: null,
              status: "completed",
              benchmarkRunId: null,
              outputHash: "c".repeat(64),
              summary: "Review the cited evidence.",
              evidenceRefs,
              unknowns: [],
              errorCode: null,
              privacyClass: "owner_only",
            }],
            sameSnapshot: true,
            agreementNotice: "Agreement is not proof of correctness.",
            createdAt: "2026-08-20T00:00:00.000Z",
            startedAt: "2026-08-20T00:00:00.000Z",
            finishedAt: "2026-08-20T00:00:00.010Z",
            cancelRequestedAt: null,
          })),
        });
      }),
    );

    render(<TriageRunPanel caseId="case-1" canLead={false} readOnly />);
    expect((await screen.findAllByText("service-1.log")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("service-8.log").length).toBeGreaterThan(0);
    const more = screen.getAllByText("Show 12 more cited evidence items")[0]?.closest("details") as HTMLDetailsElement;
    expect(more.open).toBe(false);
    expect(more.textContent).toContain("service-9.log");
    fireEvent.click(screen.getAllByText("Show 12 more cited evidence items")[0]!);
    expect(more.open).toBe(true);
    expect(screen.getAllByText("service-20.log").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("checkbox", { name: /contextdesk\.standard-1/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /contextdesk\.standard-2/ }));
    const sharedSummary = await screen.findByText("Show 12 more shared evidence items");
    const sharedMore = sharedSummary.closest("details") as HTMLDetailsElement;
    expect(sharedMore.open).toBe(false);
    expect(sharedMore.textContent).toContain("service-20.log");
    fireEvent.click(sharedSummary);
    expect(sharedMore.open).toBe(true);
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

  it("selects a newly frozen snapshot and records the run against that exact evidence", async () => {
    const firstSnapshot = {
      id: "snapshot-1",
      fingerprint: "a".repeat(64),
      evidence: [{ evidenceId: "artifact-1" }],
      createdBy: "lead",
    };
    const secondSnapshot = {
      id: "snapshot-2",
      fingerprint: "d".repeat(64),
      evidence: [{ evidenceId: "artifact-1" }, { evidenceId: "artifact-2" }],
      createdBy: "lead",
    };
    const createdJob = {
      id: "job-new",
      snapshotId: secondSnapshot.id,
      snapshotFingerprint: secondSnapshot.fingerprint,
      requestFingerprint: "b".repeat(64),
      request: {
        strategyId: "contextdesk.standard",
        question: "What happened?",
        taskFingerprint: "task-1",
        mode: "deterministic_mock" as const,
        candidates: [],
      },
      status: "completed",
      candidates: [],
      sameSnapshot: true,
      agreementNotice: "Agreement is not proof of correctness.",
      createdAt: "2026-08-20T00:00:00.000Z",
      startedAt: "2026-08-20T00:00:00.000Z",
      finishedAt: "2026-08-20T00:00:00.010Z",
      cancelRequestedAt: null,
    };
    let snapshots = [firstSnapshot];
    let jobs: typeof createdJob[] = [];
    let postedBody: { snapshotId?: string } | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/triage-runs") && init?.method === "POST") {
        postedBody = JSON.parse(String(init.body)) as { snapshotId?: string };
        jobs = [createdJob];
        return response(createdJob);
      }
      if (url.endsWith("/snapshots")) return response({ snapshots });
      if (url.endsWith("/evidence")) return response({ artifacts: [] });
      if (url.endsWith("/imports")) return response({ runs: [] });
      if (url.endsWith("/api/triage-profiles")) return response({ profiles: [] });
      if (url.endsWith("/api/triage-capabilities")) return response({ gatewayAvailable: false });
      return response({ jobs });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TriageRunPanel caseId="case-1" canLead readOnly={false} />);
    const snapshotSelect = await screen.findByRole("combobox", { name: "Snapshot" });
    expect((snapshotSelect as HTMLSelectElement).value).toBe(firstSnapshot.id);

    snapshots = [firstSnapshot, secondSnapshot];
    act(() => {
      window.dispatchEvent(new CustomEvent("contextdesk:snapshot-frozen", {
        detail: { caseId: "case-1", snapshotId: secondSnapshot.id },
      }));
    });
    await waitFor(() => expect((snapshotSelect as HTMLSelectElement).value).toBe(secondSnapshot.id));

    fireEvent.click(screen.getByRole("button", { name: "Run synthetic comparison" }));
    await waitFor(() => expect(postedBody).toEqual(expect.objectContaining({
      snapshotId: secondSnapshot.id,
    })));
    expect((snapshotSelect as HTMLSelectElement).value).toBe(secondSnapshot.id);
    const receipt = await screen.findByRole("status", { name: "Launch receipt" });
    expect(receipt.textContent).toContain("2 frozen evidence items");
    // The receipt names the run in words. A truncated fingerprint identifies
    // nothing a reader can act on and cannot be matched against another system.
    expect(receipt.textContent).not.toContain(secondSnapshot.fingerprint.slice(0, 12));
    expect(screen.getByRole("button", { name: "Open the last run" })).toBeTruthy();
  });

  it("configures each gateway lane with its own gateway model", async () => {
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
      if (init?.method === "POST") {
        return response({
          id: "job-1",
          snapshotId: "snapshot-1",
          snapshotFingerprint: "a".repeat(64),
        });
      }
      return response({ jobs: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TriageRunPanel caseId="case-1" canLead readOnly={false} />);
    await screen.findByRole("heading", { name: "Run history" });
    fireEvent.change(screen.getByRole("combobox", { name: "Execution mode" }), { target: { value: "gateway" } });
    expect((screen.getByRole("combobox", { name: "Lane concurrency" }) as HTMLSelectElement).value).toBe("2");
    fireEvent.change(screen.getByRole("combobox", { name: "Lane concurrency" }), { target: { value: "3" } });
    fireEvent.change(screen.getByRole("combobox", { name: "qwen-3.6-27b gateway model" }), { target: { value: "profile:qwen" } });
    fireEvent.change(screen.getByRole("combobox", { name: "gpt-oss-120b gateway model" }), { target: { value: "profile:gpt" } });
    fireEvent.change(screen.getByRole("combobox", { name: "ministral-3-14b-instruct-2512 gateway model" }), { target: { value: "profile:qwen" } });
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

  it("keeps distinct catalog models selectable when they share one gateway connection", async () => {
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
            {
              id: "subject:qwen",
              profileId: "shared-employer-gateway",
              modelId: "qwen-3.6-27b",
              alias: "qwen-3.6-27b",
              label: "Qwen 3.6 27B",
              provider: "openai-compatible",
            },
            {
              id: "subject:gpt-oss",
              profileId: "shared-employer-gateway",
              modelId: "gpt-oss-120b",
              alias: "gpt-oss-120b",
              label: "GPT OSS 120B",
              provider: "openai-compatible",
            },
          ],
        });
      }
      if (url.endsWith("/api/triage-capabilities")) return response({ gatewayAvailable: true });
      if (init?.method === "POST") {
        return response({
          id: "job-1",
          snapshotId: "snapshot-1",
          snapshotFingerprint: "a".repeat(64),
        });
      }
      return response({ jobs: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TriageRunPanel caseId="case-1" canLead readOnly={false} />);
    await screen.findByRole("heading", { name: "Run history" });
    fireEvent.change(screen.getByRole("combobox", { name: "Execution mode" }), { target: { value: "gateway" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /ministral-3-14b-instruct-2512/ }));

    expect((screen.getByRole("combobox", { name: "qwen-3.6-27b gateway model" }) as HTMLSelectElement).value)
      .toBe("subject:qwen");
    expect((screen.getByRole("combobox", { name: "gpt-oss-120b gateway model" }) as HTMLSelectElement).value)
      .toBe("subject:gpt-oss");

    fireEvent.click(screen.getByRole("button", { name: "Run gateway comparison" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")?.[1];
    const body = JSON.parse(String(request?.body)) as {
      candidates: Array<{ candidateId: string; profileId: string | null; model: string }>;
    };
    expect(body.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateId: "qwen-reviewer",
        profileId: "shared-employer-gateway",
        model: "qwen-3.6-27b",
      }),
      expect.objectContaining({
        candidateId: "gpt-oss-contributor",
        profileId: "shared-employer-gateway",
        model: "gpt-oss-120b",
      }),
    ]));
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
    expect(
      (await screen.findByRole("status", { name: "Comparison handoff" })).textContent,
    ).toMatch(/ready in Compare, opened as the newest comparison/);
  });
});

describe("evidence snapshot cockpit", () => {
  function cockpitJob(overrides: {
    id: string;
    strategyId: string;
    status?: string;
    snapshotId?: string;
    snapshotFingerprint?: string;
    sameSnapshot?: boolean | null;
  }) {
    return {
      id: overrides.id,
      snapshotId: overrides.snapshotId ?? "snapshot-1",
      snapshotFingerprint: overrides.snapshotFingerprint ?? "a".repeat(64),
      requestFingerprint: "b".repeat(64),
      request: {
        strategyId: overrides.strategyId,
        question: "What happened?",
        taskFingerprint: "task-1",
        mode: "deterministic_mock" as const,
        candidates: [],
      },
      status: overrides.status ?? "completed",
      candidates: [],
      sameSnapshot: overrides.sameSnapshot === undefined ? true : overrides.sameSnapshot,
      agreementNotice: "Agreement is not proof of correctness.",
      createdAt: "2026-08-20T00:00:00.000Z",
      startedAt: "2026-08-20T00:00:00.000Z",
      finishedAt: "2026-08-20T00:00:00.010Z",
      cancelRequestedAt: null,
    };
  }

  function stubCockpitFetch(options: { snapshots?: unknown[]; jobs?: unknown[] }) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/snapshots")) return response({ snapshots: options.snapshots ?? [] });
        if (url.endsWith("/evidence")) return response({ artifacts: [] });
        if (url.endsWith("/imports")) return response({ runs: [] });
        if (url.endsWith("/api/triage-profiles")) return response({ profiles: [] });
        if (url.endsWith("/api/triage-capabilities")) return response({ gatewayAvailable: false });
        return response({ jobs: options.jobs ?? [] });
      }),
    );
  }

  it("declares a controlled comparison only when both proofs and exact fingerprints agree", async () => {
    stubCockpitFetch({
      snapshots: [{
        id: "snapshot-1",
        fingerprint: "a".repeat(64),
        evidence: [{ evidenceId: "artifact-1", verificationStatus: "verified" }],
        createdBy: "lead",
        createdAt: "2026-08-19T23:41:00.000Z",
        status: "frozen",
        visibility: "owner_only",
        parentSnapshotId: null,
        protocolVersion: "cd-collab.snapshot.v1",
        fairnessClass: "same_snapshot",
      }],
      jobs: [
        cockpitJob({ id: "job-alpha", strategyId: "alpha-strategy" }),
        cockpitJob({ id: "job-beta", strategyId: "beta-strategy" }),
      ],
    });
    render(<TriageRunPanel caseId="case-1" canLead={false} readOnly />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /alpha-strategy/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /beta-strategy/ }));

    expect(await screen.findByText("Controlled comparison — same frozen evidence.")).toBeTruthy();
    expect(screen.getByText(/Differences between lanes reflect the models and settings/)).toBeTruthy();
    expect(screen.getAllByText(/same-snapshot proof recorded/)).toHaveLength(2);
    expect(screen.getByText(/it does not make any lane's answer correct/)).toBeTruthy();
    expect(screen.getByText("frozen")).toBeTruthy();
    expect(screen.getByText("owner only")).toBeTruthy();
    expect(screen.getByText("2026-08-19 23:41 UTC")).toBeTruthy();
    expect(screen.getByText("none — root snapshot")).toBeTruthy();
    expect(screen.getByText("cd-collab.snapshot.v1")).toBeTruthy();
    expect(screen.getByText("1 · 1 verified")).toBeTruthy();
    expect(screen.getByText("content equivalence established")).toBeTruthy();
  });

  it("flags an evidence mismatch, explains why it matters, and points at supported repairs", async () => {
    stubCockpitFetch({
      snapshots: [
        { id: "snapshot-1", fingerprint: "a".repeat(64), evidence: [], createdBy: "lead" },
        { id: "snapshot-2", fingerprint: "d".repeat(64), evidence: [], createdBy: "lead" },
      ],
      jobs: [
        cockpitJob({ id: "job-alpha", strategyId: "alpha-strategy" }),
        cockpitJob({
          id: "job-beta",
          strategyId: "beta-strategy",
          snapshotId: "snapshot-2",
          snapshotFingerprint: "d".repeat(64),
          sameSnapshot: false,
        }),
      ],
    });
    render(<TriageRunPanel caseId="case-1" canLead readOnly={false} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /alpha-strategy/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /beta-strategy/ }));

    expect(await screen.findByText("Evidence mismatch — not a fair head-to-head.")).toBeTruthy();
    expect(
      screen.getByText(/recorded an explicit snapshot mismatch and their evidence fingerprints differ/),
    ).toBeTruthy();
    expect(screen.getByText(/can come from the evidence rather than the models/)).toBeTruthy();
    expect(screen.getByText(/press “Use this setup again” on the run whose snapshot you trust/)).toBeTruthy();
    expect(screen.getByText(/explicit mismatch recorded/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Inspect snapshot for run job-alpha" }));
    const fingerprint = screen
      .getAllByText("a".repeat(64))
      .find((node) => node.className.includes("snapshot-cockpit__fingerprint"));
    expect(fingerprint).toBeTruthy();
  });

  it("reports fairness as unknown when a selected run has no settled snapshot proof", async () => {
    stubCockpitFetch({
      snapshots: [{ id: "snapshot-1", fingerprint: "a".repeat(64), evidence: [], createdBy: "lead" }],
      jobs: [
        cockpitJob({ id: "job-alpha", strategyId: "alpha-strategy" }),
        cockpitJob({ id: "job-beta", strategyId: "beta-strategy", status: "partial", sameSnapshot: null }),
      ],
    });
    render(<TriageRunPanel caseId="case-1" canLead={false} readOnly />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /alpha-strategy/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /beta-strategy/ }));

    expect(await screen.findByText("Fairness unknown — snapshot proof incomplete.")).toBeTruthy();
    expect(screen.getByText(/this comparison stays unknown rather than fair/)).toBeTruthy();
    expect(screen.getByText(/proof pending or unavailable/)).toBeTruthy();
  });

  it("does not call matching run fingerprints controlled when snapshot fairness is unknown", async () => {
    stubCockpitFetch({
      snapshots: [{
        id: "snapshot-1",
        fingerprint: "a".repeat(64),
        evidence: [{ evidenceId: "artifact-1" }],
        createdBy: "lead",
        fairnessClass: "unknown",
      }],
      jobs: [
        cockpitJob({ id: "job-alpha", strategyId: "alpha-strategy" }),
        cockpitJob({ id: "job-beta", strategyId: "beta-strategy" }),
      ],
    });
    render(<TriageRunPanel caseId="case-1" canLead={false} readOnly />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /alpha-strategy/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /beta-strategy/ }));

    expect(await screen.findByText("Fairness unknown — snapshot proof incomplete.")).toBeTruthy();
    expect(screen.getByText(/reports unknown content equivalence/)).toBeTruthy();
    expect(screen.getAllByText(/run binding recorded · content equivalence unknown/)).toHaveLength(2);
    expect(screen.queryByText("Controlled comparison — same frozen evidence.")).toBeNull();
    expect(screen.queryByText("All selected runs proved the same frozen snapshot.")).toBeNull();
    expect(screen.getByText(/run records report one snapshot fingerprint/)).toBeTruthy();
  });

  it("flags a run whose snapshot ID resolves to a different catalog fingerprint", async () => {
    stubCockpitFetch({
      snapshots: [{
        id: "snapshot-1",
        fingerprint: "c".repeat(64),
        evidence: [],
        createdBy: "lead",
        fairnessClass: "same_snapshot",
      }],
      jobs: [
        cockpitJob({ id: "job-alpha", strategyId: "alpha-strategy" }),
        cockpitJob({ id: "job-beta", strategyId: "beta-strategy" }),
      ],
    });
    render(<TriageRunPanel caseId="case-1" canLead={false} readOnly />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /alpha-strategy/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /beta-strategy/ }));

    expect(await screen.findByText("Evidence mismatch — not a fair head-to-head.")).toBeTruthy();
    expect(screen.getByText(/snapshot ID resolves to a different catalog fingerprint/)).toBeTruthy();
    expect(screen.getAllByText(/snapshot ID and fingerprint conflict/)).toHaveLength(2);
    expect(screen.queryByText("All selected runs proved the same frozen snapshot.")).toBeNull();
  });

  it("guides the operator when only one run is selected", async () => {
    stubCockpitFetch({
      snapshots: [{ id: "snapshot-1", fingerprint: "a".repeat(64), evidence: [], createdBy: "lead" }],
      jobs: [
        cockpitJob({ id: "job-alpha", strategyId: "alpha-strategy" }),
        cockpitJob({ id: "job-beta", strategyId: "beta-strategy" }),
      ],
    });
    render(<TriageRunPanel caseId="case-1" canLead={false} readOnly />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /alpha-strategy/ }));

    expect(await screen.findByText("One run selected.")).toBeTruthy();
    expect(screen.getByText(/Select a second finished run/)).toBeTruthy();
  });

  it("contains a very long fingerprint in its wrapping block and copies it on request", async () => {
    const longFingerprint = "e".repeat(96);
    stubCockpitFetch({
      snapshots: [{ id: "snapshot-long", fingerprint: longFingerprint, evidence: [], createdBy: "lead" }],
    });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    try {
      render(<TriageRunPanel caseId="case-1" canLead={false} readOnly />);
      const fingerprint = await screen.findByText(longFingerprint);
      expect(fingerprint.className).toContain("snapshot-cockpit__fingerprint");

      fireEvent.click(screen.getByRole("button", { name: "Copy snapshot fingerprint" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(longFingerprint));
      expect((await screen.findByRole("status")).textContent).toMatch(/Fingerprint copied/);
    } finally {
      Reflect.deleteProperty(window.navigator, "clipboard");
    }
  });

  it("shows unknown for optional snapshot metadata the API response did not include", async () => {
    stubCockpitFetch({
      snapshots: [{
        id: "snapshot-bare",
        fingerprint: "a".repeat(64),
        evidence: [{ evidenceId: "artifact-1" }],
        createdBy: "lead",
      }],
    });
    render(<TriageRunPanel caseId="case-1" canLead={false} readOnly />);
    expect(await screen.findByText("Exact evidence fingerprint")).toBeTruthy();
    // status, visibility, frozen at, parent snapshot, protocol, and fairness are absent
    // from the payload, so each must read "unknown" — never a fabricated value.
    expect(screen.getAllByText("unknown")).toHaveLength(5);
    expect(screen.getByText("unknown — content equivalence not established")).toBeTruthy();
    expect(screen.getByText("Recorded participant")).toBeTruthy();
  });
});
