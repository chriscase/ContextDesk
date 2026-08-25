import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkFocus } from "./app-location.js";
import { ExperimentLab } from "./ExperimentLab.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function compareWorkspaceNav() {
  return screen.getByRole("navigation", { name: "Compare workspace" });
}

function openCompareWorkspace(label: string) {
  fireEvent.click(within(compareWorkspaceNav()).getByRole("link", { name: label }));
}

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

const attributedGoldView = {
  ...goldView,
  observations: [
    {
      id: "obs-1",
      candidateId: "cand-qwen-3.6-27b",
      dimension: "evidence_support",
      score: 3,
      rationale: "Connected the checkout symptom to the inventory timeout.",
      reviewerUsername: "dave",
    },
  ],
};

const seededThreeModelView = {
  ...view,
  agreement: {
    ...view.agreement,
    notes: [
      ...view.agreement.notes,
      "Synthetic three-model comparison fixture. Not live provider output.",
    ],
  },
  candidates: [
    view.candidates[0]!,
    {
      ...view.candidates[0]!,
      candidateId: "cand-gpt-oss-120b",
      modelLabel: "gpt-oss-120b",
      observedLatency: { status: "observed", milliseconds: 2380 },
    },
    {
      ...view.candidates[0]!,
      candidateId: "cand-ministral-14b",
      modelLabel: "ministral-14b",
      observedLatency: { status: "observed", milliseconds: 910 },
    },
  ],
};

const seededStrategyView = {
  ...view,
  id: "exp-strategy",
  packageId: "pkg-synth-strategy-paths-v1",
  agreement: {
    ...view.agreement,
    notes: [
      ...view.agreement.notes,
      "Synthetic two-approach checkout fixture. Not live provider output.",
    ],
  },
  candidates: [
    {
      ...view.candidates[0]!,
      candidateId: "cand-programmatic-agent",
      modelLabel: "programmatic-agent",
    },
    {
      ...view.candidates[0]!,
      candidateId: "cand-chat-operator",
      modelLabel: "chat-operator",
      observedLatency: { status: "unknown" },
    },
  ],
  traces: [
    {
      candidateId: "cand-programmatic-agent",
      sourceKind: "programmatic",
      completeness: "exact",
      unknowns: [],
      events: [],
      efficiency: {
        turnCount: { status: "observed", count: 4 },
        evidenceAcquisitionSteps: { status: "observed", count: 3 },
        latency: { status: "unknown" },
        cost: { status: "unknown" },
        providerCalls: { status: "unknown" },
      },
    },
    {
      candidateId: "cand-chat-operator",
      sourceKind: "plain_text",
      completeness: "partial",
      unknowns: ["tools"],
      events: [],
      efficiency: {
        turnCount: { status: "observed", count: 2 },
        evidenceAcquisitionSteps: { status: "observed", count: 1 },
        latency: { status: "unknown" },
        cost: { status: "unknown" },
        providerCalls: { status: "unknown" },
      },
    },
  ],
  comparison: {
    questionPaths: [
      {
        pathId: "q-programmatic",
        excerpt: "Which inventory call is blocking checkout?",
        candidateIds: ["cand-programmatic-agent"],
      },
      {
        pathId: "q-chat",
        excerpt: "What timed out in checkout?",
        candidateIds: ["cand-chat-operator"],
      },
    ],
    sharedEvidence: [],
    uniqueEvidence: [],
    divergence: [],
    convergence: [],
    efficiency: [],
    gold: { status: "present", version: 1, acceptedDecisionId: "dec-strategy" },
    notes: ["Textual similarity is not a winner."],
  },
};

const cockpitView = {
  ...seededStrategyView,
  id: "exp-cockpit",
  packageId: "pkg-synth-cockpit-v1",
  agreement: {
    sharedAnchors: [
      {
        evidenceRef: "ev-demo-checkout-log",
        role: "symptom",
        candidateIds: ["cand-programmatic-agent", "cand-chat-operator"],
      },
    ],
    candidateSpecific: [
      { candidateId: "cand-programmatic-agent", evidenceRefs: ["ev-demo-pool-exhaustion"] },
      { candidateId: "cand-chat-operator", evidenceRefs: [] },
    ],
    roleConflicts: [
      {
        evidenceRef: "ev-demo-inventory-timeout",
        assignments: [
          { candidateId: "cand-programmatic-agent", role: "cause" },
          { candidateId: "cand-chat-operator", role: "symptom" },
        ],
      },
    ],
    notes: ["Agreement is not proof of correctness."],
  },
  decisions: [
    {
      id: "dec-cockpit",
      status: "proposed",
      revision: 1,
      text: "Investigate the inventory timeout before checkout retries.",
      rationale: "Both lanes cite the checkout log; the timeout stays unproven.",
      evidenceRefs: ["ev-demo-checkout-log"],
      authorUsername: "erin",
      ownerId: "actor-synthetic-owner",
      ownerUsername: "Synthetic Owner",
      remainingUnknowns: ["Does the timeout reproduce after the synthetic cache is warmed?"],
    },
  ],
  gold: null,
  alignments: [
    {
      candidateId: "cand-programmatic-agent",
      status: "unknown",
      matchedAnchors: [],
      missingAnchors: [],
      extraAnchors: [],
      notes: ["Gold alignment is not a correctness verdict."],
    },
    {
      candidateId: "cand-chat-operator",
      status: "unscored",
      matchedAnchors: [],
      missingAnchors: [],
      extraAnchors: [],
      notes: ["Gold alignment is not a correctness verdict."],
    },
  ],
  comparison: {
    ...seededStrategyView.comparison,
    divergence: [
      {
        kind: "question",
        summary: "cand-programmatic-agent and cand-chat-operator asked different questions",
      },
    ],
    gold: { status: "absent", version: null, acceptedDecisionId: null },
  },
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
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);
    expect((await screen.findAllByText("qwen-3.6-27b")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Agreement is not proof of correctness/).length).toBeGreaterThan(0);
    expect(screen.getByRole("columnheader", { name: "Gold" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import experiment" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Compare workspace" })).toBeTruthy();
    expect(screen.getByText(/No gold reference/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Strategy comparison" })).toBeNull();
    openCompareWorkspace("Strategy paths");
    expect(screen.getByRole("heading", { name: "Strategy comparison" })).toBeTruthy();
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
          return { ok: true, json: async () => ({ experiments: [attributedGoldView] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);
    expect(await screen.findByText(/Gold reference v1/)).toBeTruthy();
    expect(
      screen.getByText(/accepted decision “Treat inventory timeout as the benchmark cause\.” \(r2\)/),
    ).toBeTruthy();
    expect(screen.getByText(/promoted by dave/)).toBeTruthy();
    openCompareWorkspace("Signals");
    expect(
      screen.getByText(/Helpfulness: dave scored qwen-3.6-27b evidence support 3\/3/),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Gold alignment" })).toBeTruthy();
    expect(screen.getByText(/qwen-3.6-27b: aligned — cites every benchmark anchor/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Promote accepted decision to gold" }),
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "Helpfulness" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Accepted decision" })).toBeTruthy();
    expect(screen.getByText("Score candidate helpfulness").tagName).toBe("SUMMARY");
    expect(screen.getByText("Propose a new human decision").tagName).toBe("SUMMARY");
    expect(screen.getByText(/Latest decision r2 \(accepted\): Treat inventory timeout/)).toBeTruthy();
    expect(screen.getByText(/Recorded by identity unavailable in this view/)).toBeTruthy();
    expect(screen.getByText("Decision owner: Unassigned")).toBeTruthy();
    expect(screen.getByText("Remaining unknowns: none recorded")).toBeTruthy();
    expect(
      screen.getByRole("group", { name: "Evidence anchors for this human benchmark" }),
    ).toBeTruthy();
    expect(screen.queryByPlaceholderText(/gold evidence anchors, comma separated/i)).toBeNull();
  });

  it("builds a gold benchmark from recognizable evidence choices instead of raw ids", async () => {
    const pickerView = {
      ...goldView,
      agreement: {
        ...goldView.agreement,
        candidateSpecific: [
          {
            candidateId: "cand-qwen-3.6-27b",
            evidenceRefs: ["ev-demo-inventory-timeout"],
          },
        ],
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/experiments") && !init?.method) {
        return { ok: true, json: async () => ({ experiments: [pickerView] }) };
      }
      if (url.endsWith("/evidence")) {
        return {
          ok: true,
          json: async () => ({
            artifacts: [
              {
                id: "ev-demo-checkout-log",
                kind: "log",
                filename: "synthetic-checkout-timeout.log",
                uri: null,
                mediaType: "text/plain",
                privacyClass: "share_safe",
                verificationStatus: "verified",
              },
              {
                id: "ev-demo-inventory-timeout",
                kind: "log",
                filename: "synthetic-inventory-timeout.log",
                uri: null,
                mediaType: "text/plain",
                privacyClass: "share_safe",
                verificationStatus: "verified",
              },
              {
                id: "ev-unrelated-case-artifact",
                kind: "log",
                filename: "unrelated-case-only.log",
                uri: null,
                mediaType: "text/plain",
                privacyClass: "owner_only",
                verificationStatus: "verified",
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    expect((await screen.findAllByText("synthetic-checkout-timeout.log")).length).toBeGreaterThan(0);
    const benchmarkEvidence = screen.getByRole("group", {
      name: "Evidence anchors for this human benchmark",
    });
    expect(screen.queryByText("unrelated-case-only.log")).toBeNull();
    const roleSelectors = within(benchmarkEvidence).getAllByRole("combobox");
    expect(roleSelectors.map((select) => select.getAttribute("aria-label"))).toEqual([
      "Expected role for synthetic-checkout-timeout.log",
      "Expected role for synthetic-inventory-timeout.log",
    ]);
    fireEvent.click(within(benchmarkEvidence).getAllByRole("checkbox")[0]!);
    fireEvent.change(roleSelectors[0]!, {
      target: { value: "symptom" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Promote accepted decision to gold" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/gold") && init?.method === "POST"),
      ).toBe(true),
    );
    const goldCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith("/gold") && init?.method === "POST",
    )!;
    const body = JSON.parse(String(goldCall[1]?.body)) as Record<string, unknown>;
    expect(body.evidenceAnchors).toEqual(["ev-demo-checkout-log"]);
    expect(body.expectedRelationships).toEqual([
      { evidenceRef: "ev-demo-checkout-log", role: "symptom" },
    ]);
  });

  it("keeps raw benchmark and decision identities out of primary summaries", async () => {
    const opaqueStrategyView = {
      ...seededStrategyView,
      gold: goldView.gold,
      decisions: goldView.decisions,
      alignments: goldView.alignments.map((alignment) => ({
        ...alignment,
        candidateId: "cand-programmatic-agent",
      })),
      comparison: {
        ...seededStrategyView.comparison,
        gold: { status: "present", version: 1, acceptedDecisionId: "dec-opaque-missing" },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        if (String(input).endsWith("/experiments")) {
          return { ok: true, json: async () => ({ experiments: [opaqueStrategyView] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite={false} canLead={false} readOnly />);

    const gold = await screen.findByRole("region", { name: "Gold reference" });
    const goldSummary = gold.querySelector(".experiment-lab__gold-summary");
    expect(goldSummary?.textContent).toContain("2 benchmark anchors");
    expect(goldSummary?.textContent).not.toMatch(/ev-demo-|dec-/);
    const goldDetails = within(gold)
      .getByText("Technical benchmark identity and evidence references")
      .closest("details");
    expect(goldDetails?.hasAttribute("open")).toBe(false);
    expect(goldDetails?.textContent).toContain("ev-demo-inventory-timeout");

    openCompareWorkspace("Strategy paths");
    const strategySummary = document.querySelector(".experiment-lab__strategy-benchmark-summary");
    expect(strategySummary?.textContent).toContain("accepted decision record unavailable");
    expect(strategySummary?.textContent).not.toContain("dec-opaque-missing");
    const strategyDetails = screen
      .getByText("Technical benchmark decision identity")
      .closest("details");
    expect(strategyDetails?.hasAttribute("open")).toBe(false);
    expect(strategyDetails?.textContent).toContain("dec-opaque-missing");
  });

  it("renders shared evidence and unknown question paths separately from gold", async () => {
    const compared = {
      ...goldView,
      traces: [
        {
          candidateId: "cand-qwen-3.6-27b",
          sourceKind: "plain_text",
          completeness: "unknown",
          unknowns: ["turns", "tools"],
          events: [
            {
              eventId: "evt-1",
              sequence: 1,
              kind: "assistant_response",
              actor: "unknown",
              excerpt: "checkout timed out, not sure about the pool",
              evidenceRefs: [],
              unknowns: ["kind", "actor"],
            },
          ],
          efficiency: {
            turnCount: { status: "unknown" },
            evidenceAcquisitionSteps: { status: "unknown" },
            latency: { status: "unknown" },
            cost: { status: "unknown" },
            providerCalls: { status: "unknown" },
          },
        },
      ],
      comparison: {
        questionPaths: [
          {
            pathId: "q1",
            excerpt: "What timed out in checkout?",
            candidateIds: ["cand-qwen-3.6-27b"],
          },
        ],
        sharedEvidence: [{ evidenceRef: "ev-demo-checkout-log", candidateIds: ["cand-qwen-3.6-27b"] }],
        uniqueEvidence: [],
        divergence: [{ kind: "question", summary: "Approaches asked different questions" }],
        convergence: [{ evidenceRef: "ev-demo-checkout-log", inGold: true, candidateIds: ["cand-qwen-3.6-27b"] }],
        efficiency: [{ candidateId: "cand-qwen-3.6-27b", efficiency: { turnCount: { status: "unknown" } } }],
        gold: { status: "present", version: 1, acceptedDecisionId: "dec-1" },
        notes: ["Textual similarity is not a winner."],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/experiments")) {
          return { ok: true, json: async () => ({ experiments: [compared] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);
    expect(await screen.findByRole("heading", { name: "At a glance" })).toBeTruthy();
    openCompareWorkspace("Evidence");
    expect(screen.getAllByText(/Shared supporting evidence/).length).toBeGreaterThan(0);
    openCompareWorkspace("Strategy paths");
    expect(screen.getByText(/Question path: What timed out in checkout/)).toBeTruthy();
    expect(screen.getByText(/Models converge on supporting evidence in the human benchmark/)).toBeTruthy();
    expect(screen.getByText(/unknown: turns, tools/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import trace" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Annotate trace" })).toBeTruthy();
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
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);
    await screen.findAllByText("qwen-3.6-27b");
    fireEvent.change(screen.getByPlaceholderText(/Paste share-safe experiment/), {
      target: { value: JSON.stringify({ schemaId: "cd-collab.experiment_summary.v1" }) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import experiment" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/cases/00000000-0000-4000-8000-000000000001/experiments",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reloads and selects an experiment created by the connected-run handoff", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      if (String(input).endsWith("/experiments")) {
        return {
          ok: true,
          json: async () => ({
            experiments: fetchMock.mock.calls.length === 1 ? [view] : [view, seededStrategyView],
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    expect(await screen.findByText(/package pkg-synth-three-model-checkout-v1/)).toBeTruthy();
    window.dispatchEvent(
      new CustomEvent("contextdesk:experiment-created", {
        detail: { experimentId: seededStrategyView.id },
      }),
    );

    await waitFor(() => expect(screen.getByText(/package pkg-synth-strategy-paths-v1/)).toBeTruthy());
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/experiments")),
    ).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/evidence"))).toBe(true);
  });

  it("keeps only the share-safe export action in static read-only mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/experiments")) {
          return { ok: true, json: async () => ({ experiments: [goldView] }) };
        }
        if (url.endsWith("/export")) {
          return {
            ok: true,
            json: async () => ({
              schemaId: "cd-collab.experiment_lab_export.v2",
              privacyClass: "share_safe",
            }),
          };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead readOnly />);
    expect(await screen.findByText(/Static read-only mode/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export share-safe review" })).toBeTruthy();
    for (const name of [
      "Import experiment",
      "Import trace",
      "Record helpfulness",
      "Propose decision",
      "Promote accepted decision to gold",
    ]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("surfaces share-safe export failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/experiments")) {
          return { ok: true, json: async () => ({ experiments: [view] }) };
        }
        if (url.endsWith("/export")) {
          return {
            ok: false,
            json: async () => ({ error: "Imported fingerprint is not export-compatible" }),
          };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);
    await screen.findAllByText("qwen-3.6-27b");
    fireEvent.click(screen.getByRole("button", { name: "Export share-safe review" }));
    expect(await screen.findByText("Imported fingerprint is not export-compatible")).toBeTruthy();
  });

  it("keeps the presenter summary readable and the raw export explicit", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/experiments")) {
        return { ok: true, json: async () => ({ experiments: [seededThreeModelView] }) };
      }
      if (url.endsWith("/export")) {
        return {
          ok: true,
          json: async () => ({
            schemaId: "cd-collab.experiment_lab_export.v2",
            privacyClass: "share_safe",
            review: {
              candidates: [{}],
              decision: { status: "accepted", revision: 2 },
              gold: { version: 1 },
              omissions: {
                modelLabelsIncluded: false,
                participantIdentitiesIncluded: false,
                freeTextIncluded: false,
                privateContentIncluded: false,
                correlatableMetadataIncluded: false,
              },
              caveats: [
                "agreement_not_correctness",
                "gold_is_human_benchmark",
                "gold_alignment_not_correctness",
              ],
            },
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite={false} canLead />);

    expect(await screen.findByRole("table", { name: /Candidate comparison/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Experiment lab" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Gold reference" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Strategy comparison" })).toBeNull();
    expect(screen.getByRole("region", { name: "Export review" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export share-safe review" })).toBeTruthy();
    const presenterSummary = screen.getByLabelText("Experiment summary");
    expect(presenterSummary.textContent).toMatch(/Candidates/);
    expect(presenterSummary.textContent).toMatch(/Shared evidence/);
    expect(presenterSummary.textContent).not.toMatch(/[{}]/);
    expect(screen.queryByText(/cd-collab\.experiment_lab_export\.v2/)).toBeNull();
    expect(screen.getAllByText(/Agreement is not proof of correctness/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Gold alignment is not a correctness verdict/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Not live provider output/)).toBeTruthy();
    openCompareWorkspace("Strategy paths");
    expect(screen.getByRole("region", { name: "Strategy comparison" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Export share-safe review" }));

    expect(screen.queryByText(/"schemaId"/)).toBeNull();
    expect(await screen.findByRole("heading", { name: "Share-safe export ready" })).toBeTruthy();
    expect(screen.getByText(/A concise privacy-safe summary is shown by default/)).toBeTruthy();
    expect(screen.getByText(/1 candidate/)).toBeTruthy();
    expect(screen.getByText(/accepted · revision 2/)).toBeTruthy();
    expect(screen.getByText(/Omitted: model labels, participant identities/)).toBeTruthy();
    const rawDisclosure = screen.getByText("View raw export");
    const rawDetails = rawDisclosure.closest("details");
    expect(rawDisclosure.tagName).toBe("SUMMARY");
    expect(rawDetails).not.toBeNull();
    expect(rawDetails?.hasAttribute("open")).toBe(false);

    fireEvent.click(rawDisclosure);

    expect(rawDetails?.hasAttribute("open")).toBe(true);
    const exportedPayload = await screen.findByText(/"schemaId"/);
    expect(exportedPayload.tagName).toBe("PRE");
    expect(screen.getByText(/"privacyClass": "share_safe"/)).toBeTruthy();
    expect(exportedPayload.textContent).not.toMatch(/dave|reviewerUsername|promotedByUsername/);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/cases/00000000-0000-4000-8000-000000000001/experiments/exp-1/export",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("clears an export when the presenter switches historical artifacts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/experiments")) {
          return {
            ok: true,
            json: async () => ({ experiments: [seededThreeModelView, seededStrategyView] }),
          };
        }
        if (url.endsWith("/export")) {
          return {
            ok: true,
            json: async () => ({
              schemaId: "cd-collab.experiment_lab_export.v2",
              privacyClass: "share_safe",
              review: { candidates: [{}] },
            }),
          };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite={false} canLead />);

    expect(await screen.findByRole("table", { name: /Candidate comparison/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export share-safe review" }));
    expect(await screen.findByRole("heading", { name: "Share-safe export ready" })).toBeTruthy();

    expect(screen.queryByRole("button", { name: /pkg-synth/ })).toBeNull();
    const strategyButton = screen.getByRole("button", { name: /Comparison 2/ });
    fireEvent.click(strategyButton);
    expect(screen.queryByRole("heading", { name: "Share-safe export ready" })).toBeNull();
    expect(screen.getByText(/package pkg-synth-strategy-paths-v1/)).toBeTruthy();
    expect(screen.getByText("Technical artifact identity").closest("details")?.hasAttribute("open")).toBe(false);
    expect(strategyButton.getAttribute("aria-current")).toBe("page");
  });

  it("surfaces a stale decision conflict instead of failing silently", async () => {
    const proposed = {
      ...view,
      decisions: [
        {
          id: "dec-proposed",
          status: "proposed",
          revision: 3,
          text: "Check the inventory client timeout.",
          rationale: "Needs lead review.",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/experiments") && !init?.method) {
          return { ok: true, json: async () => ({ experiments: [proposed] }) };
        }
        if (url.endsWith("/accept")) {
          return {
            ok: false,
            json: async () => ({ error: "revision_conflict: decision changed" }),
          };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    fireEvent.click(await screen.findByRole("button", { name: "Accept decision" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("revision_conflict: decision changed");
  });

  it("explains alignment, divergence, and decision state in plain language", async () => {
    const explained = {
      ...seededStrategyView,
      decisions: [
        {
          id: "dec-strategy",
          status: "accepted",
          revision: 2,
          text: "Both strategies converge on inventory timeout.",
          rationale: "Human benchmark, not a truth claim.",
        },
      ],
      comparison: {
        ...seededStrategyView.comparison,
        divergence: [{ kind: "question", summary: "Approaches asked different questions" }],
      },
      alignments: [
        {
          candidateId: "cand-programmatic-agent",
          status: "partial",
          matchedAnchors: ["ev-demo-checkout-log"],
          missingAnchors: [],
          extraAnchors: ["ev-demo-pool-exhaustion"],
          roleMismatches: [{ evidenceRef: "ev-demo-inventory-timeout", role: "symptom" }],
          notes: ["Gold alignment is not a correctness verdict."],
        },
        {
          candidateId: "cand-chat-operator",
          status: "unscored",
          matchedAnchors: [],
          missingAnchors: [],
          extraAnchors: [],
          notes: ["Gold alignment is not a correctness verdict."],
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        if (String(input).endsWith("/experiments")) {
          return { ok: true, json: async () => ({ experiments: [explained] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite={false} canLead={false} readOnly />);

    await screen.findByRole("heading", { name: "At a glance" });
    const summary = screen.getByLabelText("Experiment summary");
    expect(summary.textContent).toMatch(/Divergences1/);
    expect(summary.textContent).toMatch(/Decisionaccepted r2/);
    openCompareWorkspace("Signals");
    expect(await screen.findByText(/programmatic-agent: partially aligned/)).toBeTruthy();
    expect(
      screen.getByText(/role differs on 1 benchmark anchor/),
    ).toBeTruthy();
    expect(screen.getByText(/1 citation beyond the benchmark/)).toBeTruthy();
    const alignmentSummary = document.querySelector(".experiment-lab__alignment-summary");
    expect(alignmentSummary?.textContent).not.toContain("ev-demo-");
    const alignmentDetails = screen
      .getAllByText("Technical alignment evidence references")[0]
      ?.closest("details");
    expect(alignmentDetails?.hasAttribute("open")).toBe(false);
    expect(alignmentDetails?.textContent).toContain("ev-demo-inventory-timeout");
    expect(alignmentDetails?.textContent).toContain("ev-demo-pool-exhaustion");
    expect(
      screen.getByText(/chat-operator: unscored — no cited evidence to compare/),
    ).toBeTruthy();
    openCompareWorkspace("Strategy paths");
    expect(
      screen.getByText(/pasted chat · partial trace — unproven steps stay unknown/),
    ).toBeTruthy();
    expect(screen.getByText(/structured run · complete trace/)).toBeTruthy();
    expect(
      screen.getByText(/accepted decision \(r2\): “Both strategies converge on inventory timeout\.”/),
    ).toBeTruthy();
  });

  it("keeps seeded model and interaction-strategy packages selectable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        if (String(input).endsWith("/experiments")) {
          return {
            ok: true,
            json: async () => ({ experiments: [seededThreeModelView, seededStrategyView] }),
          };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite={false} canLead={false} readOnly />);

    expect(
      await screen.findByRole("button", {
        name: /Comparison 1: qwen-3\.6-27b \+ gpt-oss-120b \+ 1 more/,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /Comparison 2: programmatic-agent \+ chat-operator/,
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /pkg-synth/ })).toBeNull();
    expect(screen.getByRole("heading", { name: "Experiment lab" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Historical triage artifacts" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Gold reference" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Candidate comparison" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Strategy comparison" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/Static read-only mode/);
    expect(screen.getByText(/Sources: seeded · ContextDesk connector · pasted chat/)).toBeTruthy();
    expect(screen.getByText(/Next extensions: semantic search · multi-worker leases/)).toBeTruthy();
    expect(screen.getAllByText(/Synthetic three-model comparison fixture|Agreement is not proof of correctness/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Not live provider output/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Comparison 2/ }));
    expect(screen.getByText(/package pkg-synth-strategy-paths-v1/)).toBeTruthy();
    expect(screen.getAllByText("programmatic-agent").length).toBeGreaterThan(0);
    expect(screen.getAllByText("chat-operator").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Textual similarity is not a winner/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Gold alignment is not a correctness verdict/).length).toBeGreaterThan(0);
    openCompareWorkspace("Strategy paths");
    expect(screen.getByText(/Question path: Which inventory call is blocking checkout/)).toBeTruthy();
    expect(screen.getByText(/Question path: What timed out in checkout/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Comparison 1/ }));
    expect(screen.getByText(/package pkg-synth-three-model-checkout-v1/)).toBeTruthy();
    for (const model of ["qwen-3.6-27b", "gpt-oss-120b", "ministral-14b"]) {
      expect(screen.getAllByText(model).length).toBeGreaterThan(0);
    }
  });

  it("exposes a readable bench-artifact import path without making raw JSON primary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/experiments")) {
          return { ok: true, json: async () => ({ experiments: [view] }) };
        }
        if (url.includes("/presence")) {
          return {
            ok: true,
            json: async () => ({
              schemaId: "cd-collab.presence.v1",
              caseId: "00000000-0000-4000-8000-000000000001",
              ttlSeconds: 30,
              members: [],
            }),
          };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);
    expect(await screen.findByRole("button", { name: "Import experiment" })).toBeTruthy();
    expect(screen.getByText("Import bench-compare / recorded artifact").tagName).toBe("SUMMARY");
    fireEvent.click(screen.getByText("Import bench-compare / recorded artifact"));
    expect(
      screen.getByText(/Primary view remains the candidate table, evidence, and accepted decision/i),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Convert and import onto case" })).toBeTruthy();
  });

  it("summarises agreement, difference, unknowns, and the decision before advanced tools", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        if (String(input).endsWith("/experiments")) {
          return { ok: true, json: async () => ({ experiments: [cockpitView] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    const scan = await screen.findByRole("region", { name: "At a glance" });
    expect(within(scan).getByRole("heading", { name: "Investigative findings" })).toBeTruthy();
    expect(within(scan).getByRole("heading", { name: "What stays unknown" })).toBeTruthy();
    expect(within(scan).getByRole("heading", { name: "What a human decided" })).toBeTruthy();
    expect(within(scan).getByRole("heading", { name: "Models assign different meaning to the same evidence" })).toBeTruthy();
    expect(within(scan).getByRole("heading", { name: "One model relies on evidence the other lanes do not cite" })).toBeTruthy();
    expect(within(scan).getAllByText(/Supporting excerpt not captured/).length).toBeGreaterThan(0);
    expect(within(scan).getByText(/programmatic-agent treats it as cause; chat-operator treats it as symptom/)).toBeTruthy();
    expect(within(scan).getByText(/Resolve the role before accepting a causal conclusion/)).toBeTruthy();
    expect(
      within(scan).getByText("chat-operator — trace cannot establish tools"),
    ).toBeTruthy();
    expect(
      within(scan).getByText("Gold benchmark — none recorded for this experiment"),
    ).toBeTruthy();
    expect(within(scan).getAllByText(/Agreement is not proof of correctness/).length).toBeGreaterThan(0);
    expect(within(scan).getByText(/Agreement is not proof of correctness; differences are leads to investigate/)).toBeTruthy();

    const matrix = screen.getByRole("table", { name: /Candidate comparison/ });
    expect(scan.compareDocumentPosition(matrix) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const proposeTool = screen.getByText("Propose a new human decision");
    expect(
      scan.compareDocumentPosition(proposeTool) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    openCompareWorkspace("Signals");
    expect(screen.getByText("Score candidate helpfulness")).toBeTruthy();
  });

  it("surfaces decision text, rationale, status, revision, and author at scan level and in the decision section", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        if (String(input).endsWith("/experiments")) {
          return { ok: true, json: async () => ({ experiments: [cockpitView] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    const scan = await screen.findByRole("region", { name: "At a glance" });
    const decidedCard = within(scan)
      .getByRole("heading", { name: "What a human decided" })
      .closest("article");
    expect(decidedCard?.textContent).toContain("proposed");
    expect(decidedCard?.textContent).toContain("r1");
    expect(decidedCard?.textContent).toContain(
      "Investigate the inventory timeout before checkout retries.",
    );
    expect(decidedCard?.textContent).toContain(
      "Why: Both lanes cite the checkout log; the timeout stays unproven.",
    );
    expect(decidedCard?.textContent).toContain("Recorded by erin");
    expect(decidedCard?.textContent).toContain("owner Synthetic Owner");
    expect(decidedCard?.textContent).toContain("remaining unknowns 1");
    expect(decidedCard?.textContent).toContain("No gold benchmark recorded.");

    const decisionRegion = screen.getByRole("region", { name: "Accepted decision" });
    expect(
      within(decisionRegion).getByText(
        /Latest decision r1 \(proposed\): Investigate the inventory timeout/,
      ),
    ).toBeTruthy();
    expect(within(decisionRegion).getByText("Decision owner: Synthetic Owner")).toBeTruthy();
    expect(
      within(decisionRegion).getByText(
        "Does the timeout reproduce after the synthetic cache is warmed?",
      ),
    ).toBeTruthy();
    expect(
      within(decisionRegion).getByText(
        /Rationale: Both lanes cite the checkout log; the timeout stays unproven\./,
      ),
    ).toBeTruthy();
    expect(within(decisionRegion).getByText(/Recorded by erin/)).toBeTruthy();
  });

  it("labels restored decisions as historical instead of attributing them to the mapped user", async () => {
    const restoredView = {
      ...cockpitView,
      id: "exp-restored-history",
      decisions: cockpitView.decisions.map((decision) => ({
        ...decision,
        authorUsername: "historical-canonical-west",
        ownerUsername: "historical-canonical-owner",
      })),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        if (String(input).endsWith("/experiments")) {
          return { ok: true, json: async () => ({ experiments: [restoredView] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    const scan = await screen.findByRole("region", { name: "At a glance" });
    expect(within(scan).getByText("restored history")).toBeTruthy();
    expect(within(scan).getByText(/Recorded by Historical participant \(restored\)/)).toBeTruthy();
    expect(within(scan).queryByText(/canonical-west/)).toBeNull();

    const decisionRegion = screen.getByRole("region", { name: "Accepted decision" });
    expect(within(decisionRegion).getByText(
      /This decision was restored as historical record/,
    )).toBeTruthy();
    expect(within(decisionRegion).getByText(
      /Recorded by Historical participant \(restored\)/,
    )).toBeTruthy();
    expect(within(decisionRegion).getByText(
      "Decision owner: Historical participant (restored)",
    )).toBeTruthy();
  });

  it("keeps observed run facts, helpfulness, and gold alignment in separate labeled regions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        if (String(input).endsWith("/experiments")) {
          return { ok: true, json: async () => ({ experiments: [attributedGoldView] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    expect(await screen.findByRole("table", { name: /Candidate comparison/ })).toBeTruthy();
    const matrixRegion = screen.getByRole("region", { name: "Candidate comparison" });
    expect(
      within(matrixRegion).getByText(
        "Candidate comparison — observed run facts and review signals",
      ),
    ).toBeTruthy();
    openCompareWorkspace("Signals");
    const helpfulnessRegion = screen.getByRole("region", { name: "Helpfulness" });
    const alignmentRegion = screen.getByRole("region", { name: "Gold alignment" });
    expect(within(helpfulnessRegion).getByText("Separate from gold")).toBeTruthy();
    expect(
      within(helpfulnessRegion).queryByText(/aligned — cites every benchmark anchor/),
    ).toBeNull();
    expect(
      within(alignmentRegion).getByText(/Gold alignment is not a correctness verdict/),
    ).toBeTruthy();
    expect(within(alignmentRegion).queryByText(/Helpfulness: dave scored/)).toBeNull();
  });

  it("avoids winner, confidence, and correctness-verdict language", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        if (String(input).endsWith("/experiments")) {
          return { ok: true, json: async () => ({ experiments: [cockpitView] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    await screen.findByRole("region", { name: "At a glance" });
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\bwins\b|\bwinning\b|\bbest candidate\b|\bconfidence\b/i);
    expect(text).not.toMatch(/\bready to ship\b|\bconsensus quality\b|\bmost correct\b/i);
    expect(screen.getAllByText(/Agreement is not proof of correctness/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Textual similarity is not a winner/).length).toBeGreaterThan(0);
    expect(screen.getByText("Facts only · no winner implied")).toBeTruthy();
  });

  it("lists partial traces, missing traces, and a missing gold benchmark as explicit unknowns", async () => {
    const unknownsView = {
      ...cockpitView,
      traces: [{ ...cockpitView.traces[0]!, completeness: "partial", unknowns: ["turns"] }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        if (String(input).endsWith("/experiments")) {
          return { ok: true, json: async () => ({ experiments: [unknownsView] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite={false} canLead={false} readOnly />);

    const scan = await screen.findByRole("region", { name: "At a glance" });
    const unknownCard = within(scan)
      .getByRole("heading", { name: "What stays unknown" })
      .closest("article");
    expect(unknownCard?.textContent).toContain(
      "programmatic-agent — partial trace — unproven steps stay unknown",
    );
    expect(unknownCard?.textContent).toContain("programmatic-agent — trace cannot establish turns");
    expect(unknownCard?.textContent).toContain("chat-operator — no interaction trace recorded");
    expect(unknownCard?.textContent).toContain("Gold benchmark — none recorded for this experiment");
    expect(unknownCard?.textContent).toContain("cost unknown");
    expect(unknownCard?.textContent).toContain("usage unknown");
    const summary = screen.getByLabelText("Experiment summary");
    expect(summary.textContent).toMatch(/Explicit unknowns/);
  });

  it("scopes mutation controls to contributor and case-lead roles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        if (String(input).endsWith("/experiments")) {
          return { ok: true, json: async () => ({ experiments: [attributedGoldView] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    const contributor = render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead={false} />);
    await screen.findByRole("region", { name: "At a glance" });
    expect(screen.getByRole("button", { name: "Import experiment" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Propose decision" })).toBeTruthy();
    openCompareWorkspace("Signals");
    expect(screen.getByRole("button", { name: "Record helpfulness" })).toBeTruthy();
    for (const name of [
      "Accept decision",
      "Promote accepted decision to gold",
      "Export share-safe review",
    ]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    contributor.unmount();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        if (String(input).endsWith("/experiments")) {
          return { ok: true, json: async () => ({ experiments: [cockpitView] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    const lead = render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);
    expect(await screen.findByRole("button", { name: "Accept decision" })).toBeTruthy();
    expect(screen.getByText("Accept the proposed decision").tagName).toBe("SUMMARY");
    expect(screen.getByRole("button", { name: "Export share-safe review" })).toBeTruthy();
    lead.unmount();

    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead readOnly />);
    expect(await screen.findByText(/Static read-only mode/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export share-safe review" })).toBeTruthy();
    expect(screen.queryAllByRole("textbox").length).toBe(0);
    expect(screen.queryAllByRole("combobox").length).toBe(0);
    expect(screen.queryByRole("button", { name: "Accept decision" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Annotate trace" })).toBeNull();
  });

  it("submits accessible evidence choices and honest decision ownership without raw ids", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/experiments") && !init?.method) {
        return { ok: true, json: async () => ({ experiments: [cockpitView] }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);
    await screen.findByRole("region", { name: "At a glance" });
    openCompareWorkspace("Signals");
    expect(screen.queryByPlaceholderText(/evidence refs, comma separated/i)).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Helpfulness rationale"), {
      target: { value: "Cited the checkout log." },
    });
    const helpfulnessEvidence = screen.getByRole("group", {
      name: "Evidence supporting this helpfulness review (optional)",
    });
    expect(within(helpfulnessEvidence).getByRole("searchbox")).toBeTruthy();
    fireEvent.click(within(helpfulnessEvidence).getAllByRole("checkbox")[0]!);
    fireEvent.change(within(helpfulnessEvidence).getByRole("searchbox"), {
      target: { value: "no other matching evidence" },
    });
    expect(
      (within(helpfulnessEvidence).getAllByRole("checkbox")[0] as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Record helpfulness" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).endsWith("/helpfulness")),
      ).toBe(true),
    );
    const helpfulnessCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/helpfulness"),
    )!;
    expect(String(helpfulnessCall[0])).toBe("/api/cases/00000000-0000-4000-8000-000000000001/experiments/exp-cockpit/helpfulness");
    const helpfulnessBody = JSON.parse(String(helpfulnessCall[1]?.body)) as Record<string, unknown>;
    expect(Object.keys(helpfulnessBody).sort()).toEqual([
      "candidateId",
      "dimension",
      "evidenceRefs",
      "rationale",
      "score",
    ]);
    expect(helpfulnessBody.candidateId).toBe("cand-programmatic-agent");
    expect(helpfulnessBody.dimension).toBe("evidence_support");
    expect(helpfulnessBody.score).toBe(2);
    expect(helpfulnessBody.evidenceRefs).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    fireEvent.change(screen.getByPlaceholderText("Proposed decision"), {
      target: { value: "Hold the release until the timeout is explained." },
    });
    fireEvent.change(screen.getByPlaceholderText("Decision rationale"), {
      target: { value: "The timeout stays unproven." },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Decision owner" }), {
      target: { value: "self" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Remaining unknowns or open questions" }), {
      target: { value: "Does the synthetic timeout reproduce?\nWhich trace would disconfirm it?" },
    });
    const decisionEvidence = screen.getByRole("group", {
      name: "Evidence supporting this decision (optional)",
    });
    fireEvent.click(within(decisionEvidence).getAllByRole("checkbox")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Propose decision" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => String(url).endsWith("/decisions") && init?.method === "POST",
        ),
      ).toBe(true),
    );
    const decisionCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith("/decisions") && init?.method === "POST",
    )!;
    expect(String(decisionCall[0])).toBe("/api/cases/00000000-0000-4000-8000-000000000001/experiments/exp-cockpit/decisions");
    const decisionBody = JSON.parse(String(decisionCall[1]?.body)) as Record<string, unknown>;
    expect(Object.keys(decisionBody).sort()).toEqual([
      "evidenceRefs",
      "expectedRevision",
      "ownerAssignment",
      "rationale",
      "remainingUnknowns",
      "text",
    ]);
    expect(decisionBody.expectedRevision).toBe(1);
    expect(decisionBody.ownerAssignment).toBe("self");
    expect(decisionBody.remainingUnknowns).toEqual([
      "Does the synthetic timeout reproduce?",
      "Which trace would disconfirm it?",
    ]);
    expect(decisionBody.evidenceRefs).toHaveLength(1);
    // A recorded proposal must never surface as an error (the reset after the
    // await used to throw on React's nulled currentTarget and paint one).
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Accept decision" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/accept"))).toBe(true),
    );
    const acceptCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/accept"))!;
    expect(String(acceptCall[0])).toBe(
      "/api/cases/00000000-0000-4000-8000-000000000001/experiments/exp-cockpit/decisions/dec-cockpit/accept",
    );
    expect(JSON.parse(String(acceptCall[1]?.body))).toEqual({ expectedRevision: 1 });
  });

  it("resets evidence picker search and selection when the experiment changes", async () => {
    const second = {
      ...cockpitView,
      id: "exp-cockpit-second",
      packageId: "pkg-synth-cockpit-v2",
    };
    stubExperiments([cockpitView, second]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    const firstPicker = await screen.findByRole("group", {
      name: "Evidence supporting this decision (optional)",
    });
    const firstCheckbox = within(firstPicker).getAllByRole("checkbox")[0] as HTMLInputElement;
    const firstSearch = within(firstPicker).getByRole("searchbox") as HTMLInputElement;
    fireEvent.click(firstCheckbox);
    fireEvent.change(firstSearch, { target: { value: "checkout" } });
    expect(firstCheckbox.checked).toBe(true);
    expect(firstSearch.value).toBe("checkout");

    fireEvent.click(screen.getByRole("button", { name: /Comparison 2/ }));

    const secondPicker = screen.getByRole("group", {
      name: "Evidence supporting this decision (optional)",
    });
    await waitFor(() =>
      expect((within(secondPicker).getByRole("searchbox") as HTMLInputElement).value).toBe(""),
    );
    expect(
      within(secondPicker)
        .getAllByRole("checkbox")
        .every((checkbox) => !(checkbox as HTMLInputElement).checked),
    ).toBe(true);
  });
});

// Fully recorded variant: every queue source is satisfied, so the review queue
// must render its honest empty state instead of inventing work or verdicts.
const readyView = {
  ...cockpitView,
  id: "exp-ready",
  packageId: "pkg-synth-ready-v1",
  candidates: cockpitView.candidates.map((row) => ({
    ...row,
    runStatus: "completed",
    observedLatency: { status: "observed", milliseconds: 1200 },
    cost: { status: "observed" },
    usage: { status: "observed" },
  })),
  agreement: { ...cockpitView.agreement, candidateSpecific: [], roleConflicts: [] },
  observations: [
    {
      id: "obs-a",
      candidateId: "cand-programmatic-agent",
      dimension: "evidence_support",
      score: 2,
      rationale: "Cited the checkout log.",
      reviewerUsername: "dave",
    },
    {
      id: "obs-b",
      candidateId: "cand-chat-operator",
      dimension: "evidence_support",
      score: 1,
      rationale: "Cited the checkout log.",
      reviewerUsername: "dave",
    },
  ],
  decisions: [
    {
      id: "dec-ready",
      status: "accepted",
      revision: 1,
      text: "Treat the inventory timeout as the recorded cause.",
      rationale: "Human benchmark, not a truth claim.",
      authorUsername: "erin",
    },
  ],
  gold: { ...goldView.gold, evidenceAnchors: ["ev-demo-checkout-log"] },
  alignments: cockpitView.alignments.map((row) => ({
    ...row,
    status: "aligned",
    matchedAnchors: ["ev-demo-checkout-log"],
  })),
  traces: cockpitView.traces.map((trace) => ({ ...trace, completeness: "exact", unknowns: [] })),
  comparison: {
    ...cockpitView.comparison,
    divergence: [],
    gold: { status: "present", version: 1, acceptedDecisionId: "dec-ready" },
  },
};

// Benchmark-present variant with recorded missing and extra anchors, so the
// cross-examination can be checked against every gold relationship it states.
const benchmarkCrossView = {
  ...cockpitView,
  id: "exp-bench",
  packageId: "pkg-synth-bench-v1",
  agreement: {
    sharedAnchors: [
      {
        evidenceRef: "ev-demo-checkout-log",
        role: "symptom",
        candidateIds: ["cand-programmatic-agent", "cand-chat-operator"],
      },
    ],
    candidateSpecific: [
      { candidateId: "cand-programmatic-agent", evidenceRefs: ["ev-demo-pool-exhaustion"] },
      { candidateId: "cand-chat-operator", evidenceRefs: [] },
    ],
    roleConflicts: [],
    notes: ["Agreement is not proof of correctness."],
  },
  decisions: goldView.decisions,
  gold: { ...goldView.gold },
  alignments: [
    {
      candidateId: "cand-programmatic-agent",
      status: "partial",
      matchedAnchors: ["ev-demo-checkout-log"],
      missingAnchors: ["ev-demo-inventory-timeout"],
      extraAnchors: ["ev-demo-pool-exhaustion"],
      notes: ["Gold alignment is not a correctness verdict."],
    },
    {
      candidateId: "cand-chat-operator",
      status: "partial",
      matchedAnchors: ["ev-demo-checkout-log"],
      missingAnchors: ["ev-demo-inventory-timeout"],
      extraAnchors: [],
      notes: ["Gold alignment is not a correctness verdict."],
    },
  ],
  comparison: {
    ...cockpitView.comparison,
    divergence: [],
    gold: { status: "present", version: 1, acceptedDecisionId: "dec-1" },
  },
};

function stubExperiments(experiments: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo) => {
      if (String(input).endsWith("/experiments")) {
        return { ok: true, json: async () => ({ experiments }) };
      }
      return { ok: false, json: async () => ({}) };
    }),
  );
}

describe("decision readiness cockpit", () => {
  it("centers a captured synthetic artifact and keeps its opaque identity in technical details", async () => {
    const artifactView = {
      ...cockpitView,
      id: "exp-artifact-present",
      traces: cockpitView.traces.map((trace, index) => index === 0 ? {
        ...trace,
        events: [{
          eventId: "trace-event-synthetic-1",
          sequence: 1,
          kind: "evidence_review",
          actor: "investigator",
          authorUsername: "analyst-one",
          excerpt: "2026-08-15T14:02:11Z worker-pool WARN queue depth=48\n  at SyntheticWorker.reserve(worker.ts:42); evidence ev-demo-inventory-timeout",
          evidenceRefs: ["ev-demo-inventory-timeout"],
          unknowns: [],
        }],
      } : trace),
    };
    stubExperiments([artifactView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    const scan = await screen.findByRole("region", { name: "At a glance" });
    expect(within(scan).getByText(/worker-pool WARN queue depth=48/)).toBeTruthy();
    expect(within(scan).getByText(/SyntheticWorker\.reserve/)).toBeTruthy();
    expect(
      [...scan.querySelectorAll(".experiment-lab__artifact-excerpt")].every(
        (excerpt) => !excerpt.textContent?.includes("ev-demo-inventory-timeout"),
      ),
    ).toBe(true);
    expect(within(scan).getAllByText(/What the models claim/).length).toBeGreaterThan(0);
    expect(within(scan).getAllByText(/Why this matters/).length).toBeGreaterThan(0);
    expect(within(scan).getAllByText(/Next step/).length).toBeGreaterThan(0);
    const technical = within(scan).getAllByText("Technical details")[0]?.closest("details") as HTMLDetailsElement;
    expect(technical.open).toBe(false);
    expect(technical.textContent).toContain("ev-demo-inventory-timeout");
  });

  it("joins recorded evidence metadata and bytes into a readable, bounded artifact view", async () => {
    const content = "2026-08-24T06:14:22Z inventory-client ERROR TimeoutError: inventory lookup exceeded 30000ms\n  at InventoryClient.fetch (inventory-client.ts:118)";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/experiments")) {
        return { ok: true, json: async () => ({ experiments: [cockpitView] }) };
      }
      if (url.endsWith("/evidence")) {
        return {
          ok: true,
          json: async () => ({
            artifacts: [{
              id: "ev-demo-inventory-timeout",
              kind: "log",
              filename: "synthetic-inventory-timeout.log",
              uri: null,
              mediaType: "text/plain",
              privacyClass: "share_safe",
              verificationStatus: "verified",
            }],
          }),
        };
      }
      if (url.endsWith("/evidence/ev-demo-inventory-timeout/bytes")) {
        return { ok: true, json: async () => ({ contentBase64: btoa(content) }) };
      }
      return { ok: false, json: async () => ({}) };
    }));

    render(
      <ExperimentLab
        caseId="00000000-0000-4000-8000-000000000001"
        canWrite
        canLead
      />,
    );

    const scan = await screen.findByRole("region", { name: "At a glance" });
    expect(await within(scan).findByText("synthetic-inventory-timeout.log")).toBeTruthy();
    // Artifact metadata and artifact bytes are loaded by separate effects. Wait
    // for the byte-backed excerpt instead of coupling this assertion to their
    // relative scheduling speed on the current runner.
    expect(await within(scan).findByText(/inventory lookup exceeded 30000ms/)).toBeTruthy();
    const inspect = within(scan).getAllByRole("link", { name: "Inspect supporting artifact" })[0]!;
    expect(inspect.getAttribute("href")).toContain("kind=evidence");
    expect(within(scan).getAllByRole("button", { name: /Copy synthetic-inventory-timeout\.log text/ }).length)
      .toBeGreaterThan(0);
  });

  it("keeps large logs and stack traces bounded until the operator expands them", async () => {
    const longExcerpt = Array.from(
      { length: 12 },
      (_, index) => `${String(index + 1).padStart(2, "0")} synthetic stack frame at Worker.step${index + 1} (worker.ts:${40 + index})`,
    ).join("\n");
    const artifactView = {
      ...cockpitView,
      id: "exp-artifact-large",
      traces: cockpitView.traces.map((trace, index) => index === 0 ? {
        ...trace,
        events: [{
          eventId: "trace-event-synthetic-large",
          sequence: 1,
          kind: "evidence_review",
          actor: "tool",
          excerpt: longExcerpt,
          evidenceRefs: ["ev-demo-inventory-timeout"],
          unknowns: [],
        }],
      } : trace),
    };
    stubExperiments([artifactView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    const controls = await screen.findAllByText(/Expand complete log or stack trace · 12 lines/);
    expect(controls.length).toBeGreaterThan(0);
    expect(controls[0]?.textContent).toMatch(/12 lines · [\d,]+ characters/);
    const expandable = controls[0]!.closest("details") as HTMLDetailsElement;
    expect(expandable.open).toBe(false);
    expect(expandable.previousElementSibling?.classList.contains("experiment-lab__artifact-preview")).toBe(true);
    expect(expandable.querySelector(".experiment-lab__artifact-full")?.textContent).toContain(
      "12 synthetic stack frame",
    );
    fireEvent.click(controls[0]!);
    expect(expandable.open).toBe(true);
  });

  it("keeps internal artifact, evidence, and lane identities inside closed technical disclosures", async () => {
    stubExperiments([cockpitView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    const scan = await screen.findByRole("region", { name: "At a glance" });
    expect(within(scan).getAllByText(/Supporting evidence needs inspection/).length).toBeGreaterThan(0);
    expect(within(scan).getByRole("heading", {
      name: "Models assign different meaning to the same evidence",
    })).toBeTruthy();

    const textParentsContaining = (value: string): HTMLElement[] => {
      const walker = document.createTreeWalker(document.body, 4);
      const parents: HTMLElement[] = [];
      let node = walker.nextNode();
      while (node) {
        if (node.nodeValue?.includes(value) && node.parentElement) parents.push(node.parentElement);
        node = walker.nextNode();
      }
      return parents;
    };

    for (const internalIdentity of [
      "pkg-synth-cockpit-v1",
      "task-162aec8",
      "ev-demo-inventory-timeout",
      "cand-programmatic-agent",
    ]) {
      const occurrences = textParentsContaining(internalIdentity);
      expect(occurrences.length).toBeGreaterThan(0);
      expect(occurrences.every((element) => {
        const disclosure = element.closest("details");
        return disclosure !== null && disclosure.hasAttribute("open") === false;
      })).toBe(true);
    }
  });

  it("states honestly when a supporting excerpt was not captured and gives an action", async () => {
    stubExperiments([cockpitView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);
    const scan = await screen.findByRole("region", { name: "At a glance" });
    expect(within(scan).getAllByText(/Supporting excerpt not captured/).length).toBeGreaterThan(0);
    expect(within(scan).getByText(/inspect surrounding log or stack-trace context/)).toBeTruthy();
  });

  it("explains the eight readiness facets with factual states and section links", async () => {
    stubExperiments([cockpitView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    const readiness = await screen.findByRole("region", { name: "Decision readiness" });
    for (const facet of [
      "Candidate completion",
      "Shared evidence",
      "Divergence",
      "Unknown measurements",
      "Trace completeness",
      "Human observations",
      "Decision state",
      "Benchmark state",
    ]) {
      expect(within(readiness).getByRole("heading", { name: facet })).toBeTruthy();
    }
    expect(within(readiness).getByText("2 lanes · 2 completed")).toBeTruthy();
    expect(within(readiness).getByText("1 shared anchor recorded")).toBeTruthy();
    expect(
      within(readiness).getByText(
        "1 role conflict · 1 single-lane citation set · 1 strategy divergence",
      ),
    ).toBeTruthy();
    expect(within(readiness).getByText("5 measurements unknown")).toBeTruthy();
    expect(within(readiness).getByText("1 complete · 1 partial")).toBeTruthy();
    expect(within(readiness).getByText("0 recorded · 0 of 2 lanes reviewed")).toBeTruthy();
    expect(within(readiness).getByText("proposed r1 — not accepted")).toBeTruthy();
    expect(within(readiness).getByText("none recorded — alignment stays unknown")).toBeTruthy();
    expect(
      within(readiness).getByText(/Whether the record is sufficient for a decision is a human judgment/),
    ).toBeTruthy();

    const explainers = within(readiness).getAllByText("What this measures");
    expect(explainers.length).toBe(8);
    for (const summary of explainers) {
      expect(summary.tagName).toBe("SUMMARY");
      expect(summary.closest("details")?.hasAttribute("open")).toBe(false);
    }
    expect(
      within(readiness)
        .getAllByRole("link", { name: "Open cross-examination" })[0]
        ?.getAttribute("href"),
    ).toMatch(/^\/investigations\/00000000-0000-4000-8000-000000000001\/compare\?section=cross-exam-heading/);
  });

  it("ties each facet to its recorded review-queue volume without ranking", async () => {
    stubExperiments([cockpitView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    const readiness = await screen.findByRole("region", { name: "Decision readiness" });
    const facetCard = (name: string) =>
      within(readiness).getByRole("heading", { name }).closest("article");
    expect(facetCard("Human observations")?.textContent).toContain("2 items in the review queue");
    expect(facetCard("Trace completeness")?.textContent).toContain("2 items in the review queue");
    expect(facetCard("Decision state")?.textContent).toContain("1 item in the review queue");
    expect(facetCard("Shared evidence")?.textContent).toContain("nothing queued from this facet");
    expect(facetCard("Candidate completion")?.textContent).toContain(
      "nothing queued from this facet",
    );
  });

  it("derives a deterministic human review queue in fixed category order", async () => {
    stubExperiments([cockpitView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    await screen.findByRole("heading", { name: "At a glance" });
    openCompareWorkspace("Review queue");
    const queue = await screen.findByRole("region", { name: "Human review queue" });
    expect(within(queue).getByText("Fixed order · not a priority ranking")).toBeTruthy();
    expect(
      within(queue).getByText(/The same record always produces the same queue/),
    ).toBeTruthy();

    const categories = within(queue)
      .getAllByRole("heading", { level: 5 })
      .map((heading) => heading.textContent ?? "");
    expect(categories.map((text) => text.replace(/\d+ items?$/, ""))).toEqual([
      "Recorded conflicts",
      "Single-lane evidence",
      "Unknown measurements",
      "Trace completeness",
      "Human observations",
      "Benchmark comparison",
      "Decision state",
    ]);

    const items = within(queue)
      .getAllByRole("listitem")
      .map((item) => item.textContent ?? "");
    const expectedOrder = [
      "Role conflict recorded on ev-demo-inventory-timeout — programmatic-agent as cause; chat-operator as symptom",
      "Recorded question divergence — programmatic-agent and chat-operator asked different questions",
      "Only programmatic-agent cites ev-demo-pool-exhaustion — no other lane corroborates it",
      "programmatic-agent has no recorded cost, usage",
      "chat-operator has no recorded latency, cost, usage",
      "chat-operator trace is partial — unproven steps stay unknown",
      "chat-operator trace leaves tools unknown",
      "programmatic-agent has no recorded human helpfulness observation",
      "chat-operator has no recorded human helpfulness observation",
      "No gold benchmark is recorded — benchmark comparison stays unknown for every lane",
      "chat-operator cited no evidence to compare against the benchmark",
      "Decision r1 is proposed and awaits human adjudication",
    ];
    expect(items.length).toBe(expectedOrder.length);
    expectedOrder.forEach((expected, index) => {
      expect(items[index]).toContain(expected);
    });
    const visibleTitles = within(queue)
      .getAllByRole("heading", { level: 6 })
      .map((heading) => heading.textContent ?? "");
    expect(visibleTitles.some((title) => title.includes("ev-demo-"))).toBe(false);
    expect(visibleTitles).toContain(
      "Recorded question divergence — programmatic-agent and chat-operator asked different questions",
    );
    const links = within(queue).getAllByRole("link");
    expect(links.length).toBe(expectedOrder.length);
    expect(links[0]?.getAttribute("href")).toContain("/investigations/00000000-0000-4000-8000-000000000001/compare?section=cross-exam-heading&item=");
    expect(links.at(-1)?.getAttribute("href")).toContain("/investigations/00000000-0000-4000-8000-000000000001/decide?section=decision-heading");
    expect(links.every((link) => link.getAttribute("href") !== "/investigations")).toBe(true);
  });

  it("shows an honest empty queue that never certifies correctness", async () => {
    stubExperiments([readyView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    await screen.findByRole("region", { name: "Decision readiness" });
    expect(within(screen.getByRole("region", { name: "Decision readiness" })).getByText("accepted r1")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Decision readiness" })).getByText("no unknown measurements recorded")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Decision readiness" })).getByText("2 complete")).toBeTruthy();
    openCompareWorkspace("Review queue");
    const queue = await screen.findByRole("region", { name: "Human review queue" });
    expect(within(queue).queryAllByRole("listitem").length).toBe(0);
    expect(
      within(queue).getByText(
        /An empty queue does not certify correctness — it only means nothing further was recorded\./,
      ),
    ).toBeTruthy();
  });

  it("cross-examines shared, conflicting, and single-lane evidence without a benchmark", async () => {
    stubExperiments([cockpitView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    await screen.findByRole("heading", { name: "At a glance" });
    openCompareWorkspace("Evidence");
    const table = await screen.findByRole("table", { name: /Evidence cross-examination/ });
    const evidenceRegion = screen.getByRole("region", { name: "Shared and different evidence" });
    expect(within(evidenceRegion).getByRole("table", { name: /Evidence cross-examination/ })).toBe(
      table,
    );
    expect(within(table).getAllByText("cited as symptom").length).toBe(3);
    expect(within(table).getByText("cited as cause")).toBeTruthy();
    expect(within(table).getByText("cited — role not recorded")).toBeTruthy();
    expect(within(table).getAllByText("not recorded").length).toBe(1);
    expect(within(table).getByText("role conflict")).toBeTruthy();
    expect(within(table).getByText("single lane")).toBeTruthy();
    expect(within(table).getAllByText("unknown — no benchmark recorded").length).toBe(3);
    expect(screen.getByText("How to read this table").tagName).toBe("SUMMARY");
    expect(
      screen.getByText("How to read this table").closest("details")?.hasAttribute("open"),
    ).toBe(false);
  });

  it("cross-examines missing and extra anchors against the recorded benchmark", async () => {
    stubExperiments([benchmarkCrossView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    await screen.findByRole("heading", { name: "At a glance" });
    openCompareWorkspace("Evidence");
    const table = await screen.findByRole("table", { name: /Evidence cross-examination/ });
    expect(within(table).getAllByText("anchor").length).toBe(2);
    expect(within(table).getByText("not an anchor")).toBeTruthy();
    expect(within(table).getAllByText("matches a benchmark anchor").length).toBe(2);
    expect(within(table).getByText("outside the benchmark anchors")).toBeTruthy();
    expect(
      within(table).getAllByText("benchmark anchor this lane does not cite").length,
    ).toBe(2);
    expect(within(table).getByText("anchor no lane cites")).toBeTruthy();
    openCompareWorkspace("Review queue");
    const queue = screen.getByRole("region", { name: "Human review queue" });
    expect(
      within(queue).getByText(
        /programmatic-agent does not cite benchmark anchor ev-demo-inventory-timeout/,
      ),
    ).toBeTruthy();
    expect(
      within(queue).getByText(
        /programmatic-agent cites ev-demo-pool-exhaustion outside the benchmark anchors/,
      ),
    ).toBeTruthy();
  });

  it("keeps unknown trace coverage explicit in the cross-examination footer", async () => {
    stubExperiments([benchmarkCrossView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    await screen.findByRole("heading", { name: "At a glance" });
    openCompareWorkspace("Evidence");
    const table = await screen.findByRole("table", { name: /Evidence cross-examination/ });
    expect(within(table).getByRole("rowheader", { name: "Trace coverage" })).toBeTruthy();
    expect(
      within(table).getByText("complete trace — 0 of 3 cross-examined refs appear in its events"),
    ).toBeTruthy();
    expect(
      within(table).getByText(
        "partial trace — 0 of 3 cross-examined refs appear in its events; the rest stay unknown",
      ),
    ).toBeTruthy();

    const missingTraceView = { ...benchmarkCrossView, id: "exp-none", traces: [] };
    cleanup();
    vi.unstubAllGlobals();
    stubExperiments([missingTraceView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);
    await screen.findByRole("heading", { name: "At a glance" });
    openCompareWorkspace("Evidence");
    const rerendered = await screen.findByRole("table", { name: /Evidence cross-examination/ });
    expect(
      within(rerendered).getAllByText("no trace recorded — coverage unknown").length,
    ).toBe(2);
  });

  it("keeps exactly one candidate matrix and one separately named cross-examination table", async () => {
    stubExperiments([cockpitView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    expect(await screen.findByRole("table", { name: /Candidate comparison/ })).toBeTruthy();
    const matrixTables = document.querySelectorAll("table.experiment-lab__matrix");
    expect(matrixTables.length).toBe(1);
    expect(document.querySelectorAll(".experiment-lab__matrix-wrap").length).toBe(1);
    expect(document.querySelectorAll("table.experiment-lab__crossexam").length).toBe(0);
    expect(
      within(matrixTables[0] as HTMLElement).getByText(
        "Candidate comparison — observed run facts and review signals",
      ),
    ).toBeTruthy();

    openCompareWorkspace("Evidence");
    // The browser qualification suite strict-locates table.experiment-lab__matrix
    // and .experiment-lab__matrix-wrap; the cross-examination table must never
    // share that identity, and each table keeps its own accessible name.
    expect(document.querySelectorAll("table.experiment-lab__matrix").length).toBe(0);
    const crossexamTables = document.querySelectorAll("table.experiment-lab__crossexam");
    expect(crossexamTables.length).toBe(1);
    const crossexam = crossexamTables[0] as HTMLElement;
    expect(crossexam.classList.contains("experiment-lab__matrix")).toBe(false);
    expect(crossexam.parentElement?.classList.contains("experiment-lab__crossexam-wrap")).toBe(
      true,
    );
    expect(crossexam.parentElement?.classList.contains("experiment-lab__matrix-wrap")).toBe(
      false,
    );
    expect(
      within(crossexam).getByText(
        /Evidence cross-examination — recorded citations, benchmark anchors, and trace/,
      ),
    ).toBeTruthy();
  });

  it("inspects one lane in place while keeping the aggregate decision basis unchanged", async () => {
    stubExperiments([cockpitView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    await screen.findByRole("region", { name: "Decision readiness" });
    const allLanes = screen.getByRole("button", { name: "All lanes" });
    expect(allLanes.getAttribute("aria-pressed")).toBe("true");

    const chip = screen.getByRole("button", { name: "programmatic-agent" });
    fireEvent.click(chip);
    expect(await screen.findByText(/Highlighting programmatic-agent in place/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "programmatic-agent" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "All lanes" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(window.location.search).toContain("lane=cand-programmatic-agent");
    expect(window.location.search).toContain("section=scan-heading");

    act(() => {
      window.dispatchEvent(new CustomEvent("contextdesk:experiment-created", {
        detail: { experimentId: "exp-cockpit" },
      }));
    });
    await waitFor(() => {
      const experimentRefreshes = vi.mocked(fetch).mock.calls.filter(([input]) =>
        String(input).endsWith("/experiments"),
      );
      expect(experimentRefreshes.length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByText(/Highlighting programmatic-agent in place/)).toBeTruthy();

    const digest = screen.getByRole("article", { name: "programmatic-agent" });
    expect(within(digest).getByText("Question or input")).toBeTruthy();
    expect(within(digest).getByText("Evidence it used")).toBeTruthy();
    expect(within(digest).getByText("Latest recorded conclusion")).toBeTruthy();
    expect(within(digest).getByText("Still unknown")).toBeTruthy();
    expect(within(digest).getByText("View full chronological lane history")).toBeTruthy();
    expect(within(digest).getByText("Run status")).toBeTruthy();
    expect(within(digest).getByText("completed")).toBeTruthy();
    expect(within(digest).getByText(/Evidence only this lane cites/)).toBeTruthy();
    expect(within(digest).getByText(/ev-demo-pool-exhaustion/)).toBeTruthy();
    expect(
      within(digest).getByText(/4 review queue items mention this lane/),
    ).toBeTruthy();
    expect(
      within(digest).getByText(/never changes the aggregate comparison, benchmark, or accepted human decision/),
    ).toBeTruthy();

    // Candidate comparison on Summary still lists the unfocused lane.
    const matrix = screen.getByRole("table", { name: /Candidate comparison/ });
    expect(within(matrix).getByRole("rowheader", { name: /chat-operator/ })).toBeTruthy();
    expect(screen.getAllByText("chat-operator").length).toBeGreaterThan(0);

    openCompareWorkspace("Evidence");
    const table = screen.getByRole("table", { name: /Evidence cross-examination/ });
    expect(within(table).getByRole("columnheader", { name: /chat-operator/ })).toBeTruthy();
    openCompareWorkspace("Review queue");
    const queue = screen.getByRole("region", { name: "Human review queue" });
    expect(within(queue).getAllByText("involves focused lane").length).toBe(4);
    expect(
      within(queue).getAllByText(/chat-operator has no recorded human helpfulness observation/)[0],
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "All lanes" }));
    expect(screen.queryByText(/Highlighting programmatic-agent/)).toBeNull();
    expect(screen.getByRole("button", { name: "All lanes" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("clears focus when the operator switches historical artifacts", async () => {
    stubExperiments([cockpitView, seededThreeModelView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    await screen.findByRole("region", { name: "Decision readiness" });
    fireEvent.click(screen.getByRole("button", { name: "chat-operator" }));
    expect(await screen.findByText(/Highlighting chat-operator in place/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Comparison 2/ }));
    expect(screen.queryByText(/Highlighting chat-operator/)).toBeNull();
    expect(screen.getByRole("button", { name: "All lanes" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("keeps the cockpit read-only safe: focus works, no new mutation controls appear", async () => {
    stubExperiments([cockpitView]);
    render(
      <ExperimentLab
        caseId="00000000-0000-4000-8000-000000000001"
        canWrite
        canLead
        readOnly
        routeFocus={{
          section: "readiness-heading",
          item: null,
          lane: "cand-chat-operator",
          experiment: "exp-cockpit",
        }}
      />,
    );

    await screen.findByRole("region", { name: "Decision readiness" });
    expect(await screen.findByText(/Highlighting chat-operator in place/)).toBeTruthy();
    expect(screen.queryAllByRole("textbox").length).toBe(0);
    expect(screen.queryAllByRole("combobox").length).toBe(0);
    for (const name of ["Import experiment", "Record helpfulness", "Propose decision"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    openCompareWorkspace("Review queue");
    expect(screen.getByRole("region", { name: "Human review queue" })).toBeTruthy();
  });
});

describe("focused surfaces", () => {
  it("renders the complete lab when no surface prop is given (backwards compatible)", async () => {
    stubExperiments([goldView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);
    expect(await screen.findByRole("heading", { name: "Experiment lab" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "At a glance" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Accepted decision" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Export review" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import experiment" })).toBeTruthy();
  });

  it("comparison surface shows review material without decision or export controls", async () => {
    stubExperiments([goldView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead surface="comparison" />);
    expect(await screen.findByRole("heading", { name: "Experiment lab" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "At a glance" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Strategy comparison" })).toBeNull();
    openCompareWorkspace("Strategy paths");
    expect(screen.getByRole("heading", { name: "Strategy comparison" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import experiment" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Accepted decision" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Export review" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Export share-safe review" })).toBeNull();
  });

  it("decision surface shows the journal and export without the comparison material", async () => {
    stubExperiments([goldView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead surface="decision" />);
    expect(await screen.findByRole("heading", { name: "Decision journal" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Accepted decision" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Export review" })).toBeTruthy();
    expect(
      screen.getByText(/Latest decision r2 \(accepted\): Treat inventory timeout/),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "At a glance" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Strategy comparison" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Gold alignment" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Import experiment" })).toBeNull();
    // Identity truth stays visible on both surfaces.
    expect(screen.getByText(/The server remains authoritative/)).toBeTruthy();
  });
});

describe("focused Compare workspace", () => {
  function CompareHarness(props: { initial?: WorkFocus }) {
    const [focus, setFocus] = useState<WorkFocus | undefined>(props.initial);
    return (
      <ExperimentLab
        caseId="00000000-0000-4000-8000-000000000001"
        canWrite
        canLead
        {...(focus ? { routeFocus: focus } : {})}
        onDeepNavigate={(nextFocus) => {
          const params = new URLSearchParams({ section: nextFocus.section });
          if (nextFocus.item) params.set("item", nextFocus.item);
          if (nextFocus.lane) params.set("lane", nextFocus.lane);
          if (nextFocus.experiment) params.set("experiment", nextFocus.experiment);
          window.history.pushState(
            nextFocus,
            "",
            `/investigations/00000000-0000-4000-8000-000000000001/compare?${params.toString()}#${encodeURIComponent(nextFocus.section)}`,
          );
          setFocus(nextFocus);
        }}
      />
    );
  }

  function RoutedCasesHarness(props: { remountOnFocus?: boolean }) {
    const [focus, setFocus] = useState<WorkFocus | undefined>();
    const route = (nextFocus: WorkFocus) => {
      const params = new URLSearchParams({ section: nextFocus.section });
      if (nextFocus.item) params.set("item", nextFocus.item);
      if (nextFocus.lane) params.set("lane", nextFocus.lane);
      if (nextFocus.experiment) params.set("experiment", nextFocus.experiment);
      window.history.pushState(
        nextFocus,
        "",
        `/investigations/00000000-0000-4000-8000-000000000001/compare?${params.toString()}#${encodeURIComponent(nextFocus.section)}`,
      );
      setFocus(nextFocus);
    };
    const routeGeneration = props.remountOnFocus && focus ? "focused" : "bare";
    const focusProps = focus ? { routeFocus: focus } : {};
    return (
      <>
        <section aria-label="Compare stage">
          <ExperimentLab
            key={`compare-${routeGeneration}`}
            caseId="00000000-0000-4000-8000-000000000001"
            surface="comparison"
            canWrite
            canLead
            {...focusProps}
            onDeepNavigate={route}
          />
        </section>
        <section aria-label="Decide stage" hidden>
          <ExperimentLab
            key={`decide-${routeGeneration}`}
            caseId="00000000-0000-4000-8000-000000000001"
            surface="decision"
            canWrite
            canLead
            {...focusProps}
            onDeepNavigate={route}
          />
        </section>
      </>
    );
  }

  it("renders one major subsection at a time and a useful default summary", async () => {
    stubExperiments([cockpitView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    expect(await screen.findByRole("heading", { name: "At a glance" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Decision readiness" })).toBeTruthy();
    expect(screen.getByRole("table", { name: /Candidate comparison/ })).toBeTruthy();
    expect(screen.getByLabelText("Experiment summary").textContent).toMatch(/Candidates/);
    expect(screen.queryByRole("region", { name: "Human review queue" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Shared and different evidence" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Strategy comparison" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Helpfulness" })).toBeNull();
    expect(screen.queryByText("Jump to:")).toBeNull();
  });

  it("makes every subsection keyboard reachable and URL-backed", async () => {
    stubExperiments([cockpitView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);
    await screen.findByRole("navigation", { name: "Compare workspace" });

    const expected = [
      ["Summary", "scan-heading", "At a glance"],
      ["Review queue", "review-queue-heading", "Human review queue"],
      ["Evidence", "evidence-heading", "Shared and different evidence"],
      ["Strategy paths", "strategy-heading", "Strategy comparison"],
      ["Signals", "helpfulness-heading", "Helpfulness"],
    ] as const;

    for (const [label, section, heading] of expected) {
      const link = within(compareWorkspaceNav()).getByRole("link", { name: label });
      expect(link.getAttribute("href")).toContain(`section=${section}`);
      link.focus();
      expect(document.activeElement).toBe(link);
      fireEvent.click(link);
      expect(await screen.findByRole(label === "Strategy paths" ? "heading" : "region", { name: heading })).toBeTruthy();
      expect(window.location.search).toContain(`section=${section}`);
      expect(within(compareWorkspaceNav()).getByRole("link", { name: label }).getAttribute("aria-current")).toBe("page");
    }
  });

  it("selects the mapped subsection from shipped section, item, and lane deep links", async () => {
    stubExperiments([cockpitView]);
    render(
      <ExperimentLab
        caseId="00000000-0000-4000-8000-000000000001"
        canWrite
        canLead
        routeFocus={{
          section: "cross-exam-heading",
          item: "ev-demo-inventory-timeout",
          lane: "cand-programmatic-agent",
          experiment: "exp-cockpit",
        }}
      />,
    );

    expect(await screen.findByRole("region", { name: "Shared and different evidence" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "At a glance" })).toBeNull();
    const routedItem = document.querySelector("[data-route-item='ev-demo-inventory-timeout']");
    expect(routedItem).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(routedItem));
    expect(await screen.findByText(/Highlighting programmatic-agent/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "programmatic-agent" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByText(/highlights matching cards, table columns, and review references in place/)).toBeTruthy();
  });

  it("never focuses a same-id route target inside a hidden stage", async () => {
    const hiddenStage = document.createElement("section");
    hiddenStage.hidden = true;
    const hiddenDuplicate = document.createElement("button");
    hiddenDuplicate.dataset.routeItem = "ev-demo-inventory-timeout";
    hiddenDuplicate.dataset.routeKind = "evidence";
    hiddenStage.append(hiddenDuplicate);
    document.body.prepend(hiddenStage);
    try {
      stubExperiments([cockpitView]);
      render(
        <ExperimentLab
          caseId="00000000-0000-4000-8000-000000000001"
          canWrite
          canLead
          routeFocus={{
            section: "cross-exam-heading",
            item: "ev-demo-inventory-timeout",
            itemKind: "evidence",
            lane: null,
            experiment: "exp-cockpit",
          }}
        />,
      );

      await screen.findByRole("region", { name: "Shared and different evidence" });
      const visibleTarget = [...document.querySelectorAll<HTMLElement>(
        "[data-route-item='ev-demo-inventory-timeout'][data-route-kind='evidence']",
      )].find((element) => !element.closest("[hidden]"));
      expect(visibleTarget).toBeTruthy();
      await waitFor(() => expect(document.activeElement).toBe(visibleTarget));
      expect(document.activeElement).not.toBe(hiddenDuplicate);
    } finally {
      hiddenStage.remove();
    }
  });

  it("fails unknown section ids to the useful summary instead of a blank screen", async () => {
    stubExperiments([cockpitView]);
    render(
      <ExperimentLab
        caseId="00000000-0000-4000-8000-000000000001"
        canWrite
        canLead
        routeFocus={{
          section: "not-a-shipped-section",
          item: null,
          lane: null,
          experiment: "exp-cockpit",
        }}
      />,
    );

    expect(await screen.findByRole("heading", { name: "At a glance" })).toBeTruthy();
    expect(screen.getByLabelText("Experiment summary").textContent).toMatch(/Candidates2/);
    expect(screen.queryByRole("region", { name: "Human review queue" })).toBeNull();
  });

  it("restores the subsection across in-app navigation, reload props, and back/forward", async () => {
    stubExperiments([cockpitView]);
    const { rerender } = render(<CompareHarness />);
    await screen.findByRole("heading", { name: "At a glance" });

    fireEvent.click(within(compareWorkspaceNav()).getByRole("link", { name: "Evidence" }));
    expect(await screen.findByRole("region", { name: "Shared and different evidence" })).toBeTruthy();

    rerender(
      <ExperimentLab
        caseId="00000000-0000-4000-8000-000000000001"
        canWrite
        canLead
        routeFocus={{
          section: "strategy-heading",
          item: null,
          lane: null,
          experiment: "exp-cockpit",
        }}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Strategy comparison" })).toBeTruthy();

    rerender(
      <ExperimentLab
        caseId="00000000-0000-4000-8000-000000000001"
        canWrite
        canLead
        routeFocus={{
          section: "review-queue-heading",
          item: null,
          lane: "cand-chat-operator",
          experiment: "exp-cockpit",
        }}
      />,
    );
    expect(await screen.findByRole("region", { name: "Human review queue" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "chat-operator" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("updates routed experiment focus atomically when switching historical artifacts", async () => {
    stubExperiments([cockpitView, seededThreeModelView]);
    render(
      <CompareHarness
        initial={{
          section: "cross-exam-heading",
          item: "ev-demo-inventory-timeout",
          lane: "cand-programmatic-agent",
          experiment: "exp-cockpit",
        }}
      />,
    );

    expect(await screen.findByRole("region", { name: "Shared and different evidence" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "programmatic-agent" }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: /Comparison 2/ }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Comparison 2/ }).getAttribute("aria-current")).toBe(
        "page",
      );
    });
    expect(screen.getByRole("region", { name: "Shared and different evidence" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "All lanes" }).getAttribute("aria-pressed")).toBe("true");
    expect(window.location.search).toContain("section=evidence-heading");
    expect(window.location.search).toContain("experiment=exp-1");
    expect(window.location.search).not.toContain("item=");
    expect(window.location.search).not.toContain("lane=");
  });

  it("focuses and scrolls a mapped legacy section-only destination", async () => {
    stubExperiments([cockpitView]);
    const scrollIntoView = vi.fn();
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      render(
        <ExperimentLab
          caseId="00000000-0000-4000-8000-000000000001"
          canWrite
          canLead
          routeFocus={{
            section: "candidate-comparison-heading",
            item: null,
            lane: null,
            experiment: "exp-cockpit",
          }}
        />,
      );

      const heading = await screen.findByRole("heading", { name: "Candidate comparison" });
      await waitFor(() => expect(document.activeElement).toBe(heading));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", inline: "nearest" });
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScroll;
    }
  });

  it("does not scroll to a distant lane anchor when focusing a lane", async () => {
    stubExperiments([cockpitView]);
    const scrollIntoView = vi.fn();
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

      await screen.findByRole("region", { name: "Decision readiness" });
      openCompareWorkspace("Review queue");
      expect(screen.getByRole("region", { name: "Human review queue" })).toBeTruthy();
      scrollIntoView.mockClear();

      const laneButton = screen.getByRole("button", { name: "programmatic-agent" });
      laneButton.focus();
      fireEvent.click(laneButton);
      expect(window.location.search).toContain("lane=cand-programmatic-agent");
      expect(window.location.search).toContain("section=review-queue-heading");
      expect(screen.getByRole("region", { name: "Human review queue" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Strategy comparison" })).toBeNull();
      expect(screen.queryByRole("heading", { name: "At a glance" })).toBeNull();
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(laneButton);
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScroll;
    }
  });

  it("does not focus or scroll when the first parent-routed focus only selects a lane", async () => {
    stubExperiments([seededThreeModelView]);
    const scrollIntoView = vi.fn();
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<CompareHarness />);

      const summaryHeading = await screen.findByRole("heading", { name: "At a glance" });
      const laneButton = screen.getByRole("button", { name: "qwen-3.6-27b" });
      laneButton.focus();
      scrollIntoView.mockClear();

      fireEvent.click(laneButton);

      await waitFor(() => {
        expect(window.location.search).toContain("lane=cand-qwen-3.6-27b");
        expect(screen.getByRole("button", { name: "qwen-3.6-27b" }).getAttribute("aria-pressed")).toBe(
          "true",
        );
      });
      expect(window.location.search).toContain("section=scan-heading");
      expect(window.location.search).toContain("experiment=exp-1");
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(laneButton);
      expect(document.activeElement).not.toBe(summaryHeading);
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScroll;
    }
  });

  it("keeps an internally routed lane click non-navigational across a lab remount", async () => {
    stubExperiments([seededThreeModelView]);
    const scrollIntoView = vi.fn();
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<RoutedCasesHarness remountOnFocus />);

      const summaryHeading = await screen.findByRole("heading", { name: "At a glance" });
      const laneButton = screen.getByRole("button", { name: "qwen-3.6-27b" });
      laneButton.focus();
      scrollIntoView.mockClear();
      fireEvent.click(laneButton);

      await waitFor(() => {
        expect(window.location.search).toContain("lane=cand-qwen-3.6-27b");
        expect(screen.getByRole("button", { name: "qwen-3.6-27b" }).getAttribute("aria-pressed"))
          .toBe("true");
      });
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(document.activeElement).not.toBe(summaryHeading);
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScroll;
    }
  });

  it("lands evidence and strategy review links on the relevant subsection", async () => {
    stubExperiments([cockpitView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);
    await screen.findByRole("heading", { name: "At a glance" });

    const inspect = screen.getAllByRole("link", { name: "Inspect supporting artifact" })[0]!;
    expect(inspect.getAttribute("href")).toContain("section=cross-exam-heading");
    fireEvent.click(inspect);
    expect(await screen.findByRole("region", { name: "Shared and different evidence" })).toBeTruthy();
    expect(screen.getByRole("table", { name: /Evidence cross-examination/ })).toBeTruthy();
    const evidenceRow = document.querySelector<HTMLElement>(
      "[data-route-item='ev-demo-inventory-timeout']",
    );
    await waitFor(() => expect(document.activeElement).toBe(evidenceRow));

    openCompareWorkspace("Review queue");
    fireEvent.click(screen.getAllByRole("link", { name: "open cross-examination" })[0]!);
    expect(await screen.findByRole("region", { name: "Shared and different evidence" })).toBeTruthy();
    expect(screen.getByRole("table", { name: /Evidence cross-examination/ })).toBeTruthy();

    openCompareWorkspace("Review queue");
    fireEvent.click(screen.getByRole("link", { name: "open strategy comparison" }));
    const strategyHeading = await screen.findByRole("heading", { name: "Strategy comparison" });
    await waitFor(() => expect(document.activeElement).toBe(strategyHeading));

    openCompareWorkspace("Review queue");
    fireEvent.click(screen.getAllByRole("link", { name: "open run facts" })[0]!);
    const candidateHeading = await screen.findByRole("heading", { name: "Candidate comparison" });
    await waitFor(() => expect(document.activeElement).toBe(candidateHeading));
    expect(screen.queryByRole("region", { name: "Human review queue" })).toBeNull();
  });

  it("uses a native Decide href for cross-stage decision links", async () => {
    stubExperiments([cockpitView]);
    const onDeepNavigate = vi.fn();
    render(
      <ExperimentLab
        caseId="00000000-0000-4000-8000-000000000001"
        canWrite
        canLead
        surface="comparison"
        onDeepNavigate={onDeepNavigate}
      />,
    );
    await screen.findByRole("heading", { name: "At a glance" });
    openCompareWorkspace("Review queue");
    onDeepNavigate.mockClear();

    const decisionLink = screen.getByRole("link", { name: "open decision" });
    expect(decisionLink.getAttribute("href")).toMatch(
      /^\/investigations\/00000000-0000-4000-8000-000000000001\/decide\?section=decision-heading/,
    );
    decisionLink.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(decisionLink, { metaKey: true });
    expect(onDeepNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Human review queue" })).toBeTruthy();
  });

  it("expands long evidence and leaves short evidence fully visible", async () => {
    const longExcerpt = Array.from(
      { length: 12 },
      (_, index) => `${String(index + 1).padStart(2, "0")} synthetic stack frame at Worker.step${index + 1} (worker.ts:${40 + index})${index === 0 ? "; evidence ev-private-anchor" : ""}`,
    ).join("\n");
    const artifactView = {
      ...cockpitView,
      traces: cockpitView.traces.map((trace, index) => index === 0 ? {
        ...trace,
        events: [{
          eventId: "trace-event-synthetic-large",
          sequence: 1,
          kind: "evidence_review",
          actor: "tool",
          excerpt: longExcerpt,
          evidenceRefs: ["ev-demo-inventory-timeout"],
          unknowns: [],
        }, {
          eventId: "trace-event-synthetic-short",
          sequence: 2,
          kind: "evidence_review",
          actor: "tool",
          excerpt: "short checkout timeout line",
          evidenceRefs: ["ev-demo-pool-exhaustion"],
          unknowns: [],
        }],
      } : trace),
    };
    stubExperiments([artifactView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);

    const expand = await screen.findByText(/Expand complete log or stack trace · 12 lines/);
    const details = expand.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.previousElementSibling?.textContent).not.toContain("ev-private-anchor");
    fireEvent.click(expand);
    expect(details.open).toBe(true);
    expect(screen.getByText(/Collapse complete log or stack trace · 12 lines/)).toBeTruthy();
    expect(details.querySelector(".experiment-lab__artifact-full")?.textContent).toBe(longExcerpt);

    openCompareWorkspace("Evidence");
    expect(screen.getAllByText("short checkout timeout line").length).toBeGreaterThan(0);
    const shortExcerpt = [...document.querySelectorAll(".experiment-lab__artifact-excerpt")].find(
      (node) => node.textContent === "short checkout timeout line",
    );
    expect(shortExcerpt?.closest(".experiment-lab__artifact-collapsible")).toBeNull();
  });

  it("keeps finding headings semantic and the workspace contained for narrow viewports", async () => {
    stubExperiments([cockpitView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);
    const scan = await screen.findByRole("region", { name: "At a glance" });
    const finding = within(scan).getByRole("heading", {
      name: "Models assign different meaning to the same evidence",
    });
    expect(finding.tagName).toBe("H6");
    expect(finding.classList.contains("experiment-lab__finding-title")).toBe(true);
    expect(document.querySelector(".experiment-lab__workspace")).toBeTruthy();
    expect(document.querySelector(".experiment-lab")?.className).toContain("experiment-lab");
    openCompareWorkspace("Evidence");
    expect(document.querySelector(".experiment-lab__crossexam-wrap")).toBeTruthy();
  });

  it("preserves modifier-click so a subsection href can open without in-app navigation", async () => {
    stubExperiments([cockpitView]);
    render(<ExperimentLab caseId="00000000-0000-4000-8000-000000000001" canWrite canLead />);
    await screen.findByRole("heading", { name: "At a glance" });
    const evidence = within(compareWorkspaceNav()).getByRole("link", { name: "Evidence" });
    fireEvent.click(evidence, { metaKey: true });
    expect(screen.getByRole("heading", { name: "At a glance" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Shared and different evidence" })).toBeNull();
  });
});
