import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExperimentLab } from "./ExperimentLab.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const view = {
  id: "exp-1",
  packageId: "pkg-synth-three-model-checkout-v1",
  taskFingerprint: "task-162aec8ca84e72ecfc9164d4168d18b6e41367e7c10e9c23aef086bf83bfd007",
  snapshotFingerprint: "snap-5a75de4d710765b3fbb87afdc85beb25fd96f23b46ef4c59d416aa7ae61bbceb",
  candidates: [
    {
      candidateId: "cand-qwen-3.6-27b",
      modelLabel: "qwen-3.6-27b",
      role: "single",
      runStatus: "completed",
      observedLatency: { status: "observed", milliseconds: 4120 },
      cost: { status: "unknown" },
      usage: { status: "unknown" },
      helpfulnessState: "unreviewed",
      goldState: "unknown",
    },
  ],
  agreement: {
    sharedAnchors: [
      {
        evidenceRef: "ev-demo-checkout-log",
        role: "symptom",
        candidateIds: ["cand-qwen-3.6-27b"],
      },
    ],
    candidateSpecific: [],
    roleConflicts: [],
    notes: ["Agreement is not proof of correctness."],
  },
  observations: [],
  decisions: [],
};

describe("experiment lab", () => {
  it("renders the candidate matrix and agreement caveat", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/experiments")) {
          return { ok: true, json: async () => ({ experiments: [view] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<ExperimentLab caseId="c1" canWrite canLead />);
    expect((await screen.findAllByText("qwen-3.6-27b")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Agreement is not proof of correctness/).length).toBeGreaterThan(0);
    expect(screen.getByRole("columnheader", { name: "Gold" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import experiment" })).toBeTruthy();
  });

  it("posts a pasted package JSON", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/experiments")) {
        return { ok: true, json: async () => view };
      }
      return { ok: true, json: async () => ({ experiments: [view] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExperimentLab caseId="c1" canWrite canLead />);
    await screen.findAllByText("qwen-3.6-27b");
    fireEvent.change(screen.getByPlaceholderText(/Paste share-safe experiment/), {
      target: { value: JSON.stringify({ schemaId: "cd-collab.experiment_summary.v1" }) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import experiment" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/cases/c1/experiments",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
