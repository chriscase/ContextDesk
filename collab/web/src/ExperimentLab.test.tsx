import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
      authorUsername: "erin",
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
    render(<ExperimentLab caseId="c1" canWrite canLead />);
    expect((await screen.findAllByText("qwen-3.6-27b")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Agreement is not proof of correctness/).length).toBeGreaterThan(0);
    expect(screen.getByRole("columnheader", { name: "Gold" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import experiment" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Strategy comparison" })).toBeTruthy();
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
          return { ok: true, json: async () => ({ experiments: [attributedGoldView] }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    render(<ExperimentLab caseId="c1" canWrite canLead />);
    expect(await screen.findByText(/Gold reference v1/)).toBeTruthy();
    expect(
      screen.getByText(/accepted decision “Treat inventory timeout as the benchmark cause\.” \(r2\)/),
    ).toBeTruthy();
    expect(screen.getByText(/promoted by dave/)).toBeTruthy();
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
    render(<ExperimentLab caseId="c1" canWrite canLead />);
    expect(await screen.findByText(/Question path: What timed out in checkout/)).toBeTruthy();
    expect(screen.getByText(/Shared evidence ev-demo-checkout-log/)).toBeTruthy();
    expect(screen.getByText(/Converges on gold ev-demo-checkout-log/)).toBeTruthy();
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
    render(<ExperimentLab caseId="c1" canWrite canLead />);

    expect(await screen.findByText(/package pkg-synth-three-model-checkout-v1/)).toBeTruthy();
    window.dispatchEvent(
      new CustomEvent("contextdesk:experiment-created", {
        detail: { experimentId: seededStrategyView.id },
      }),
    );

    await waitFor(() => expect(screen.getByText(/package pkg-synth-strategy-paths-v1/)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    render(<ExperimentLab caseId="c1" canWrite canLead readOnly />);
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
    render(<ExperimentLab caseId="c1" canWrite canLead />);
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
    render(<ExperimentLab caseId="c1" canWrite={false} canLead />);

    expect(await screen.findByRole("table", { name: /Candidate comparison/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Experiment lab" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Gold reference" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Strategy comparison" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Export review" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export share-safe review" })).toBeTruthy();
    const presenterSummary = screen.getByLabelText("Experiment summary");
    expect(presenterSummary.textContent).toMatch(/Candidates/);
    expect(presenterSummary.textContent).toMatch(/Shared evidence/);
    expect(presenterSummary.textContent).not.toMatch(/[{}]/);
    expect(screen.queryByText(/cd-collab\.experiment_lab_export\.v2/)).toBeNull();
    expect(screen.getAllByText(/Agreement is not proof of correctness/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Gold alignment is not a correctness verdict/)).toBeTruthy();
    expect(screen.getByText(/Not live provider output/)).toBeTruthy();

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
      "/api/cases/c1/experiments/exp-1/export",
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
    render(<ExperimentLab caseId="c1" canWrite={false} canLead />);

    expect(await screen.findByRole("table", { name: /Candidate comparison/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export share-safe review" }));
    expect(await screen.findByRole("heading", { name: "Share-safe export ready" })).toBeTruthy();

    const strategyButton = screen.getByRole("button", { name: "pkg-synth-strategy-paths-v1" });
    fireEvent.click(strategyButton);
    expect(screen.queryByRole("heading", { name: "Share-safe export ready" })).toBeNull();
    expect(screen.getByText(/package pkg-synth-strategy-paths-v1/)).toBeTruthy();
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
    render(<ExperimentLab caseId="c1" canWrite canLead />);

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
    render(<ExperimentLab caseId="c1" canWrite={false} canLead={false} readOnly />);

    expect(await screen.findByText(/programmatic-agent: partially aligned/)).toBeTruthy();
    expect(
      screen.getByText(/role differs on ev-demo-inventory-timeout \(treated as symptom\)/),
    ).toBeTruthy();
    expect(screen.getByText(/beyond the benchmark: ev-demo-pool-exhaustion/)).toBeTruthy();
    expect(
      screen.getByText(/chat-operator: unscored — no cited evidence to compare/),
    ).toBeTruthy();
    const summary = screen.getByLabelText("Experiment summary");
    expect(summary.textContent).toMatch(/Divergences1/);
    expect(summary.textContent).toMatch(/Decisionaccepted r2/);
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
    render(<ExperimentLab caseId="c1" canWrite={false} canLead={false} readOnly />);

    expect(await screen.findByRole("button", { name: "pkg-synth-three-model-checkout-v1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "pkg-synth-strategy-paths-v1" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Experiment lab" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Historical triage artifacts" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Gold reference" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Candidate comparison" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Strategy comparison" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/Static read-only mode/);
    expect(screen.getByText(/Sources: seeded · ContextDesk connector · pasted chat/)).toBeTruthy();
    expect(screen.getByText(/Next extensions: semantic search · multi-worker leases/)).toBeTruthy();
    expect(screen.getAllByText(/Synthetic three-model comparison fixture|Agreement is not proof of correctness/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Not live provider output/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "pkg-synth-strategy-paths-v1" }));
    expect(screen.getByText(/package pkg-synth-strategy-paths-v1/)).toBeTruthy();
    expect(screen.getAllByText("programmatic-agent").length).toBeGreaterThan(0);
    expect(screen.getAllByText("chat-operator").length).toBeGreaterThan(0);
    expect(screen.getByText(/Question path: Which inventory call is blocking checkout/)).toBeTruthy();
    expect(screen.getByText(/Question path: What timed out in checkout/)).toBeTruthy();
    expect(screen.getByText(/Textual similarity is not a winner/)).toBeTruthy();
    expect(screen.getByText(/Gold alignment is not a correctness verdict/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "pkg-synth-three-model-checkout-v1" }));
    expect(screen.getByText(/package pkg-synth-three-model-checkout-v1/)).toBeTruthy();
    for (const model of ["qwen-3.6-27b", "gpt-oss-120b", "ministral-14b"]) {
      expect(screen.getAllByText(model).length).toBeGreaterThan(0);
    }
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
    render(<ExperimentLab caseId="c1" canWrite canLead />);

    const scan = await screen.findByRole("region", { name: "At a glance" });
    expect(within(scan).getByRole("heading", { name: "What agrees" })).toBeTruthy();
    expect(within(scan).getByRole("heading", { name: "What differs" })).toBeTruthy();
    expect(within(scan).getByRole("heading", { name: "What stays unknown" })).toBeTruthy();
    expect(within(scan).getByRole("heading", { name: "What a human decided" })).toBeTruthy();
    expect(
      within(scan).getByText(
        "ev-demo-checkout-log — symptom, cited by programmatic-agent, chat-operator",
      ),
    ).toBeTruthy();
    expect(
      within(scan).getByText("programmatic-agent alone cites ev-demo-pool-exhaustion"),
    ).toBeTruthy();
    expect(
      within(scan).getByText(
        "ev-demo-inventory-timeout is read differently: programmatic-agent as cause; chat-operator as symptom",
      ),
    ).toBeTruthy();
    expect(
      within(scan).getByText(
        "question divergence — programmatic-agent and chat-operator asked different questions",
      ),
    ).toBeTruthy();
    expect(
      within(scan).getByText("chat-operator — trace cannot establish tools"),
    ).toBeTruthy();
    expect(
      within(scan).getByText("Gold benchmark — none recorded for this experiment"),
    ).toBeTruthy();
    expect(within(scan).getByText("Agreement is not proof of correctness.")).toBeTruthy();
    expect(
      within(scan).getByText("Differences are leads to investigate, not a ranking."),
    ).toBeTruthy();

    const matrix = screen.getByRole("table", { name: /Candidate comparison/ });
    expect(scan.compareDocumentPosition(matrix) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const helpfulnessTool = screen.getByText("Score candidate helpfulness");
    expect(
      scan.compareDocumentPosition(helpfulnessTool) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const proposeTool = screen.getByText("Propose a new human decision");
    expect(
      scan.compareDocumentPosition(proposeTool) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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
    render(<ExperimentLab caseId="c1" canWrite canLead />);

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
    expect(decidedCard?.textContent).toContain("Decided by erin");
    expect(decidedCard?.textContent).toContain("No gold benchmark recorded.");

    const decisionRegion = screen.getByRole("region", { name: "Accepted decision" });
    expect(
      within(decisionRegion).getByText(
        /Latest decision r1 \(proposed\): Investigate the inventory timeout/,
      ),
    ).toBeTruthy();
    expect(
      within(decisionRegion).getByText(
        /Rationale: Both lanes cite the checkout log; the timeout stays unproven\./,
      ),
    ).toBeTruthy();
    expect(within(decisionRegion).getByText(/Recorded by erin/)).toBeTruthy();
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
    render(<ExperimentLab caseId="c1" canWrite canLead />);

    expect(await screen.findByRole("table", { name: /Candidate comparison/ })).toBeTruthy();
    const matrixRegion = screen.getByRole("region", { name: "Candidate comparison" });
    const helpfulnessRegion = screen.getByRole("region", { name: "Helpfulness" });
    const alignmentRegion = screen.getByRole("region", { name: "Gold alignment" });
    expect(
      within(matrixRegion).getByText(
        "Candidate comparison — observed run facts and review signals",
      ),
    ).toBeTruthy();
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
    render(<ExperimentLab caseId="c1" canWrite canLead />);

    await screen.findByRole("region", { name: "At a glance" });
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\bwins\b|\bwinning\b|\bbest candidate\b|\bconfidence\b/i);
    expect(text).not.toMatch(/\bready to ship\b|\bconsensus quality\b|\bmost correct\b/i);
    expect(screen.getAllByText(/Agreement is not proof of correctness/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Textual similarity is not a winner/)).toBeTruthy();
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
    render(<ExperimentLab caseId="c1" canWrite={false} canLead={false} readOnly />);

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
    const contributor = render(<ExperimentLab caseId="c1" canWrite canLead={false} />);
    await screen.findByRole("region", { name: "At a glance" });
    for (const name of ["Import experiment", "Record helpfulness", "Propose decision"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
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
    const lead = render(<ExperimentLab caseId="c1" canWrite canLead />);
    expect(await screen.findByRole("button", { name: "Accept decision" })).toBeTruthy();
    expect(screen.getByText("Accept the proposed decision").tagName).toBe("SUMMARY");
    expect(screen.getByRole("button", { name: "Export share-safe review" })).toBeTruthy();
    lead.unmount();

    render(<ExperimentLab caseId="c1" canWrite canLead readOnly />);
    expect(await screen.findByText(/Static read-only mode/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export share-safe review" })).toBeTruthy();
    expect(screen.queryAllByRole("textbox").length).toBe(0);
    expect(screen.queryAllByRole("combobox").length).toBe(0);
    expect(screen.queryByRole("button", { name: "Accept decision" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Annotate trace" })).toBeNull();
  });

  it("keeps request routes and payload field names unchanged", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/experiments") && !init?.method) {
        return { ok: true, json: async () => ({ experiments: [cockpitView] }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExperimentLab caseId="c1" canWrite canLead />);
    await screen.findByRole("region", { name: "At a glance" });

    fireEvent.change(screen.getByPlaceholderText("Helpfulness rationale"), {
      target: { value: "Cited the checkout log." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record helpfulness" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).endsWith("/helpfulness")),
      ).toBe(true),
    );
    const helpfulnessCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/helpfulness"),
    )!;
    expect(String(helpfulnessCall[0])).toBe("/api/cases/c1/experiments/exp-cockpit/helpfulness");
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
    expect(helpfulnessBody.evidenceRefs).toEqual([]);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    fireEvent.change(screen.getByPlaceholderText("Proposed decision"), {
      target: { value: "Hold the release until the timeout is explained." },
    });
    fireEvent.change(screen.getByPlaceholderText("Decision rationale"), {
      target: { value: "The timeout stays unproven." },
    });
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
    expect(String(decisionCall[0])).toBe("/api/cases/c1/experiments/exp-cockpit/decisions");
    const decisionBody = JSON.parse(String(decisionCall[1]?.body)) as Record<string, unknown>;
    expect(Object.keys(decisionBody).sort()).toEqual([
      "evidenceRefs",
      "expectedRevision",
      "rationale",
      "text",
    ]);
    expect(decisionBody.expectedRevision).toBe(1);
    // A recorded proposal must never surface as an error (the reset after the
    // await used to throw on React's nulled currentTarget and paint one).
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Accept decision" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/accept"))).toBe(true),
    );
    const acceptCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/accept"))!;
    expect(String(acceptCall[0])).toBe(
      "/api/cases/c1/experiments/exp-cockpit/decisions/dec-cockpit/accept",
    );
    expect(JSON.parse(String(acceptCall[1]?.body))).toEqual({ expectedRevision: 1 });
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
  it("explains the eight readiness facets with factual states and section links", async () => {
    stubExperiments([cockpitView]);
    render(<ExperimentLab caseId="c1" canWrite canLead />);

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
    ).toBe("#cross-exam-heading");
  });

  it("ties each facet to its recorded review-queue volume without ranking", async () => {
    stubExperiments([cockpitView]);
    render(<ExperimentLab caseId="c1" canWrite canLead />);

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
    render(<ExperimentLab caseId="c1" canWrite canLead />);

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
    const links = within(queue).getAllByRole("link");
    expect(links.length).toBe(expectedOrder.length);
    expect(links[0]?.getAttribute("href")).toBe("#cross-exam-heading");
    expect(links.at(-1)?.getAttribute("href")).toBe("#decision-heading");
  });

  it("shows an honest empty queue that never certifies correctness", async () => {
    stubExperiments([readyView]);
    render(<ExperimentLab caseId="c1" canWrite canLead />);

    const queue = await screen.findByRole("region", { name: "Human review queue" });
    expect(within(queue).queryAllByRole("listitem").length).toBe(0);
    expect(
      within(queue).getByText(
        /An empty queue does not certify correctness — it only means nothing further was recorded\./,
      ),
    ).toBeTruthy();
    const readiness = screen.getByRole("region", { name: "Decision readiness" });
    expect(within(readiness).getByText("accepted r1")).toBeTruthy();
    expect(within(readiness).getByText("no unknown measurements recorded")).toBeTruthy();
    expect(within(readiness).getByText("2 complete")).toBeTruthy();
  });

  it("cross-examines shared, conflicting, and single-lane evidence without a benchmark", async () => {
    stubExperiments([cockpitView]);
    render(<ExperimentLab caseId="c1" canWrite canLead />);

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
    render(<ExperimentLab caseId="c1" canWrite canLead />);

    const table = await screen.findByRole("table", { name: /Evidence cross-examination/ });
    expect(within(table).getAllByText("anchor").length).toBe(2);
    expect(within(table).getByText("not an anchor")).toBeTruthy();
    expect(within(table).getAllByText("matches a benchmark anchor").length).toBe(2);
    expect(within(table).getByText("outside the benchmark anchors")).toBeTruthy();
    expect(
      within(table).getAllByText("benchmark anchor this lane does not cite").length,
    ).toBe(2);
    expect(within(table).getByText("anchor no lane cites")).toBeTruthy();
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
    render(<ExperimentLab caseId="c1" canWrite canLead />);

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
    render(<ExperimentLab caseId="c1" canWrite canLead />);
    const rerendered = await screen.findByRole("table", { name: /Evidence cross-examination/ });
    expect(
      within(rerendered).getAllByText("no trace recorded — coverage unknown").length,
    ).toBe(2);
  });

  it("keeps exactly one candidate matrix and one separately named cross-examination table", async () => {
    stubExperiments([cockpitView]);
    render(<ExperimentLab caseId="c1" canWrite canLead />);

    await screen.findByRole("table", { name: /Evidence cross-examination/ });
    // The browser qualification suite strict-locates table.experiment-lab__matrix
    // and .experiment-lab__matrix-wrap; the cross-examination table must never
    // share that identity, and each table keeps its own accessible name.
    const matrixTables = document.querySelectorAll("table.experiment-lab__matrix");
    expect(matrixTables.length).toBe(1);
    expect(document.querySelectorAll(".experiment-lab__matrix-wrap").length).toBe(1);
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
      within(matrixTables[0] as HTMLElement).getByText(
        "Candidate comparison — observed run facts and review signals",
      ),
    ).toBeTruthy();
    expect(
      within(crossexam).getByText(
        /Evidence cross-examination — recorded citations, benchmark anchors, and trace/,
      ),
    ).toBeTruthy();
  });

  it("focuses one lane while keeping every other lane visible and unfiltered", async () => {
    stubExperiments([cockpitView]);
    render(<ExperimentLab caseId="c1" canWrite canLead />);

    await screen.findByRole("region", { name: "Decision readiness" });
    const allLanes = screen.getByRole("button", { name: "All lanes" });
    expect(allLanes.getAttribute("aria-pressed")).toBe("true");

    const chip = screen.getByRole("button", { name: "programmatic-agent" });
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(allLanes.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen.getByText(/Focused on programmatic-agent\. Every other lane stays visible/),
    ).toBeTruthy();

    const digest = screen.getByRole("article", { name: "programmatic-agent" });
    expect(within(digest).getByText("Run status")).toBeTruthy();
    expect(within(digest).getByText("completed")).toBeTruthy();
    expect(within(digest).getByText(/Evidence only this lane cites/)).toBeTruthy();
    expect(within(digest).getByText(/ev-demo-pool-exhaustion/)).toBeTruthy();
    expect(
      within(digest).getByText(/Review queue entries naming this lane: 4/),
    ).toBeTruthy();
    expect(
      within(digest).getByText(/the decision basis is never trimmed to the focused lane/),
    ).toBeTruthy();

    // The other lane stays fully present everywhere.
    const table = screen.getByRole("table", { name: /Evidence cross-examination/ });
    expect(within(table).getByRole("columnheader", { name: /chat-operator/ })).toBeTruthy();
    expect(screen.getAllByText("chat-operator").length).toBeGreaterThan(0);
    const queue = screen.getByRole("region", { name: "Human review queue" });
    expect(within(queue).getAllByText("involves focused lane").length).toBe(4);
    expect(
      within(queue).getByText(/chat-operator has no recorded human helpfulness observation/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show all lanes equally" }));
    expect(screen.queryByText(/Focused on programmatic-agent/)).toBeNull();
    expect(allLanes.getAttribute("aria-pressed")).toBe("true");
  });

  it("clears focus when the operator switches historical artifacts", async () => {
    stubExperiments([cockpitView, seededThreeModelView]);
    render(<ExperimentLab caseId="c1" canWrite canLead />);

    await screen.findByRole("region", { name: "Decision readiness" });
    fireEvent.click(screen.getByRole("button", { name: "chat-operator" }));
    expect(screen.getByText(/Focused on chat-operator/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "pkg-synth-three-model-checkout-v1" }));
    expect(screen.queryByText(/Focused on chat-operator/)).toBeNull();
    expect(screen.getByRole("button", { name: "All lanes" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("keeps the cockpit read-only safe: focus works, no new mutation controls appear", async () => {
    stubExperiments([cockpitView]);
    render(<ExperimentLab caseId="c1" canWrite canLead readOnly />);

    await screen.findByRole("region", { name: "Decision readiness" });
    fireEvent.click(screen.getByRole("button", { name: "chat-operator" }));
    expect(screen.getByText(/Focused on chat-operator/)).toBeTruthy();
    expect(screen.queryAllByRole("textbox").length).toBe(0);
    expect(screen.queryAllByRole("combobox").length).toBe(0);
    for (const name of ["Import experiment", "Record helpfulness", "Propose decision"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByRole("region", { name: "Human review queue" })).toBeTruthy();
  });
});
