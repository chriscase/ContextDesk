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
  gold: null,
  alignments: [
    {
      candidateId: "cand-qwen-3.6-27b",
      status: "unknown",
      matchedAnchors: [],
      missingAnchors: [],
      extraAnchors: [],
      notes: ["Gold alignment is not a correctness verdict."],
    },
  ],
};

const goldView = {
  ...view,
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
      goldState: "present",
    },
  ],
  decisions: [
    {
      id: "dec-1",
      status: "accepted",
      revision: 2,
      text: "Treat inventory timeout as the benchmark cause.",
      rationale: "Human benchmark, not a truth claim.",
    },
  ],
  gold: {
    goldId: "gold-synth-three-model-checkout-v1",
    version: 1,
    predecessorGoldId: null,
    packageId: "pkg-synth-three-model-checkout-v1",
    acceptedDecisionId: "dec-1",
    acceptedDecisionRevision: 2,
    evidenceAnchors: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
    promotedByUsername: "dave",
    notes: ["A gold reference is a human benchmark decision, not an infallible truth claim."],
  },
  alignments: [
    {
      candidateId: "cand-qwen-3.6-27b",
      status: "aligned",
      matchedAnchors: ["ev-demo-checkout-log", "ev-demo-inventory-timeout"],
      missingAnchors: [],
      extraAnchors: [],
      notes: ["Gold alignment is not a correctness verdict."],
    },
  ],
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
    expect(screen.getByText(/No gold reference/)).toBeTruthy();
    expect(
      screen.getAllByText(/A gold reference is a human benchmark decision/).length,
    ).toBeGreaterThan(0);
  });

  it("renders gold provenance separately from helpfulness and alignment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/experiments")) {
          return { ok: true, json: async () => ({ experiments: [goldView] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<ExperimentLab caseId="c1" canWrite canLead />);
    expect(await screen.findByText(/Gold reference v1/)).toBeTruthy();
    expect(screen.getByText(/accepted decision dec-1 r2/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Gold alignment" })).toBeTruthy();
    expect(screen.getByText(/cand-qwen-3.6-27b: aligned/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Promote accepted decision to gold" }),
    ).toBeTruthy();
    expect(screen.queryByText("Helpfulness: dave scored")).toBeNull();
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
