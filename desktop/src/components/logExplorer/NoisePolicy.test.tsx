import { createRef, type RefObject } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as host from "../../lib/host";
import { NoisePolicyControl, SuppressTemplateDialog } from "./NoisePolicy";

vi.mock("../../lib/host", () => ({
  hostLogPreviewTemplateSuppression: vi.fn(),
  hostLogActivateTemplateSuppression: vi.fn(),
  hostLogProposeNoiseCandidates: vi.fn(),
}));

function policy(
  state: host.SuppressionRuleState = "enabled",
  resolution?: host.SuppressionRuleResolutionDto | null,
): host.SuppressionDocumentDto {
  return {
    schemaVersion: 1,
    corpusId: "c1",
    revision: 7,
    resolvedTemplateRevision: 11,
    rules: [
      {
        id: "rule-1",
        name: "Routine heartbeat",
        rationale: "Known repetitive health traffic.",
        predicate: {
          templateId: 22,
          templateFingerprint: "template-22",
        },
        origin: "human",
        state,
        createdAt: 1,
        updatedAt: 2,
        resolution:
          resolution === undefined
            ? {
                kind: "matches_current",
                matchesNothing: false,
                explanation: "Exact template matches the current corpus.",
              }
            : resolution,
      },
    ],
    previews: [],
    audit: [
      {
        id: "audit-1",
        revision: 7,
        action: state === "enabled" ? "activated" : "disabled",
        ruleId: "rule-1",
        previewToken: null,
        createdAt: 2,
      },
    ],
  };
}

function preview(): host.SuppressionPreviewDto {
  return {
    token: "preview-token",
    corpusId: "c1",
    eventRevision: 4,
    ruleRevision: 7,
    name: "Routine heartbeat",
    rationale: "Known repetitive health traffic.",
    predicate: {
      templateId: 22,
      templateFingerprint: "template-22",
    },
    origin: "human",
    matchingEventCount: 250,
    incrementalEventCount: 240,
    corpusEventCount: 1_000,
    levelCounts: [
      { level: "INFO", count: 245 },
      { level: "WARN", count: 5 },
    ],
    sourceCount: 3,
    timeSpan: { from: 1_700_000_000, to: 1_700_003_600 },
    representatives: [
      {
        seq: 44,
        source: "health.log",
        timestamp: 1_700_000_000,
        timeQuality: "wall",
        level: "INFO",
        redactedExcerpt: "heartbeat token=[REDACTED]",
      },
    ],
    createdAt: 3,
  };
}

function candidateReport(): host.NoiseCandidateReportDto {
  return {
    corpusId: "c1",
    unsuppressedEventCount: 1_000,
    corpusEventCount: 1_000,
    suppressionRevision: 7,
    eventRevision: 4,
    templateAnalysisRevision: 2,
    alreadySuppressedTemplateIds: [],
    timeQuality: "wall",
    rawTimeQuality: "wall",
    candidates: [
      {
        templateId: 44,
        templateFingerprint: "candidate-template-44",
        pattern: "routine health probe <*>",
        score: 62,
        eventCount: 400,
        corpusShareBps: 4_000,
        sourceCount: 3,
        timeQuality: "wall",
        wallTimeSpan: { from: 1_700_000_000, to: 1_700_003_600 },
        orderSpan: null,
        levelCounts: [{ level: "INFO", count: 400 }],
        otherLevelCount: 0,
        levelCountsTruncated: false,
        errorOrFatalCount: 0,
        warnCount: 0,
        infoCount: 400,
        reasonCodes: [
          "high_frequency",
          "high_corpus_share",
          "steady_background",
        ],
        explanation:
          "High-volume steady informational traffic; human review required.",
        alreadySuppressed: false,
        shareBasis: "unsuppressed_events",
        proposalKind: "suppression_candidate",
        representatives: [
          {
            seq: 4,
            source: "health.log",
            timestamp: 1_700_000_000,
            timeQuality: "wall",
            level: "INFO",
            redactedExcerpt: "routine health probe token=[REDACTED]",
          },
        ],
        shape: "steady",
      },
    ],
    templatesScanned: 7,
    eligibleCandidateCount: 1,
    truncated: false,
    candidateCapTruncated: false,
    templateScanTruncated: false,
    responseBytesTruncated: false,
    metadataMissingTemplateIds: [],
    databaseQueryCount: 4,
    disclaimer: "Human review only.",
    cancelled: false,
  };
}

function Trigger({
  triggerRef,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button ref={triggerRef} type="button">
      Inspector action
    </button>
  );
}

describe("NoisePolicyControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(host.hostLogPreviewTemplateSuppression).mockResolvedValue(
      preview(),
    );
    vi.mocked(host.hostLogProposeNoiseCandidates).mockResolvedValue(
      candidateReport(),
    );
  });

  it("opens as a bounded popover, dismisses outside or with Escape, and restores focus", async () => {
    const triggerRef = createRef<HTMLButtonElement>();
    render(
      <NoisePolicyControl
        corpusId="c1"
        document={policy()}
        hiddenCount={250}
        state="ready"
        error={null}
        narrow={false}
        triggerRef={triggerRef}
        onRetry={vi.fn()}
        onMutate={vi.fn()}
        onSuspendAll={vi.fn()}
        onResume={vi.fn()}
        onReloadPolicy={async () => 7}
        onCandidateActivated={async () => {}}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Noise · 1 rule · 250 hidden",
    });
    fireEvent.click(trigger);
    expect(screen.getByTestId("noise-policy-panel").dataset.mode).toBe(
      "popover",
    );
    expect(await screen.findByText("Routine heartbeat")).toBeTruthy();
    expect(screen.getByTestId("noise-policy-disclosure").textContent).toMatch(
      /not analyzed/i,
    );
    fireEvent.pointerDown(document.body);
    await waitFor(() =>
      expect(screen.queryByTestId("noise-policy-panel")).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    fireEvent.click(trigger);
    expect(await screen.findByText("Routine heartbeat")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("noise-policy-panel")).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("exposes Suspend all and Resume without disabling rules", async () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const onSuspendAll = vi.fn();
    const onResume = vi.fn();
    const onMutate = vi.fn();
    const { unmount } = render(
      <NoisePolicyControl
        corpusId="c1"
        document={policy()}
        hiddenCount={250}
        state="ready"
        error={null}
        narrow={false}
        lensSuspended={false}
        triggerRef={triggerRef}
        onRetry={vi.fn()}
        onMutate={onMutate}
        onSuspendAll={onSuspendAll}
        onResume={onResume}
        onReloadPolicy={async () => 7}
        onCandidateActivated={async () => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Noise · 1 rule · 250 hidden" }),
    );
    fireEvent.click(screen.getByTestId("noise-lens-suspend-all"));
    expect(onSuspendAll).toHaveBeenCalledTimes(1);
    expect(onMutate).not.toHaveBeenCalled();
    unmount();

    render(
      <NoisePolicyControl
        corpusId="c1"
        document={policy()}
        hiddenCount={250}
        state="ready"
        error={null}
        narrow={false}
        lensSuspended
        triggerRef={triggerRef}
        onRetry={vi.fn()}
        onMutate={onMutate}
        onSuspendAll={onSuspendAll}
        onResume={onResume}
        onReloadPolicy={async () => 7}
        onCandidateActivated={async () => {}}
      />,
    );
    const suspendedTrigger = screen.getByRole("button", {
      name: "Noise · suspended · 1 rule · 0 excluded",
    });
    fireEvent.click(suspendedTrigger);
    const disclosure = await screen.findByTestId("noise-policy-disclosure");
    expect(disclosure.textContent).toMatch(/suspended/i);
    expect(disclosure.textContent).toMatch(/not disabled/i);
    fireEvent.click(screen.getByTestId("noise-lens-resume"));
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onMutate).not.toHaveBeenCalled();
  });

  it("uses a narrow sheet and exposes disable, re-enable, remove, and audit actions", async () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const onMutate = vi.fn(async () => ({
      revision: 8,
      rule: policy().rules[0]!,
    }));
    const { rerender } = render(
      <NoisePolicyControl
        corpusId="c1"
        document={policy()}
        hiddenCount={250}
        state="ready"
        error={null}
        narrow
        triggerRef={triggerRef}
        onRetry={vi.fn()}
        onMutate={onMutate}
        onReloadPolicy={async () => 7}
        onCandidateActivated={async () => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Noise · 1 rule · 250 hidden",
      }),
    );
    expect(screen.getByTestId("noise-policy-panel").dataset.mode).toBe("sheet");
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() =>
      expect(onMutate).toHaveBeenCalledWith("rule-1", "disable"),
    );

    rerender(
      <NoisePolicyControl
        corpusId="c1"
        document={policy("disabled")}
        hiddenCount={0}
        state="ready"
        error={null}
        narrow
        triggerRef={triggerRef}
        onRetry={vi.fn()}
        onMutate={onMutate}
        onReloadPolicy={async () => 7}
        onCandidateActivated={async () => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Re-enable" }));
    await waitFor(() =>
      expect(onMutate).toHaveBeenCalledWith("rule-1", "reenable"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(onMutate).toHaveBeenCalledWith("rule-1", "remove"),
    );
    fireEvent.click(screen.getByRole("button", { name: /Show audit/ }));
    expect(screen.getByText("revision 7")).toBeTruthy();
  });

  it("reviews suggestions without activating them and reuses explicit suppression preview", async () => {
    const triggerRef = createRef<HTMLButtonElement>();
    render(
      <NoisePolicyControl
        corpusId="c1"
        document={policy()}
        hiddenCount={250}
        state="ready"
        error={null}
        narrow={false}
        triggerRef={triggerRef}
        onRetry={vi.fn()}
        onMutate={vi.fn()}
        onReloadPolicy={async () => 7}
        onCandidateActivated={async () => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Noise · 1 rule · 250 hidden" }),
    );
    const reviewSuggestions = screen.getByRole("button", {
      name: "Review suggestions",
    });
    fireEvent.pointerDown(reviewSuggestions);
    fireEvent.click(reviewSuggestions);
    expect(await screen.findByText("routine health probe <*>")).toBeTruthy();
    expect(host.hostLogActivateTemplateSuppression).not.toHaveBeenCalled();
    expect(host.hostLogPreviewTemplateSuppression).not.toHaveBeenCalled();

    fireEvent.click(
      await screen.findByRole("button", { name: "Suppress…" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Suppress exact template" }),
    ).toBeTruthy();
    expect(
      screen.getAllByText(/Template 44/).some((element) =>
        element.textContent?.includes("policy revision 7"),
      ),
    ).toBe(true);
    expect(host.hostLogActivateTemplateSuppression).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByTestId("suppress-template-backdrop"), {
      key: "Escape",
    });
    await waitFor(() =>
      expect(screen.queryByTestId("suppress-template-backdrop")).toBeNull(),
    );
    expect(screen.getByTestId("noise-candidate-review")).toBeTruthy();
    expect(host.hostLogPreviewTemplateSuppression).not.toHaveBeenCalled();
  });

  it("keeps a portaled suppression dialog open through pointerdown and preview click", async () => {
    const triggerRef = createRef<HTMLButtonElement>();
    render(
      <NoisePolicyControl
        corpusId="c1"
        document={policy()}
        hiddenCount={250}
        state="ready"
        error={null}
        narrow={false}
        triggerRef={triggerRef}
        onRetry={vi.fn()}
        onMutate={vi.fn()}
        onReloadPolicy={async () => 8}
        onCandidateActivated={async () => {}}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Noise · 1 rule · 250 hidden" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Review suggestions" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Suppress…" }),
    );
    fireEvent.change(screen.getByLabelText("Rationale (required)"), {
      target: { value: "Known repetitive health traffic." },
    });

    const previewImpact = screen.getByRole("button", {
      name: "Preview impact",
    });
    fireEvent.pointerDown(previewImpact);
    fireEvent.click(previewImpact);

    expect(
      await screen.findByRole("button", { name: "Confirm suppression" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("dialog", { name: "Suppress exact template" }),
    ).toBeTruthy();
    expect(host.hostLogActivateTemplateSuppression).not.toHaveBeenCalled();
  });
});

describe("SuppressTemplateDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(host.hostLogPreviewTemplateSuppression).mockResolvedValue(
      preview(),
    );
    vi.mocked(host.hostLogActivateTemplateSuppression).mockResolvedValue({
      revision: 8,
      rule: policy().rules[0]!,
    });
  });

  it("carries the narrow sheet class on the portaled form itself (#834 repair)", () => {
    // The dialog portals to document.body, so no .log-explorer--narrow
    // ancestor can scope its sheet styling; the directly applied --sheet
    // class is the narrow signal the stylesheet keys on. Rendered geometry
    // is proven renderer-level in desktop/visual/noise-suppress.test.tsx.
    const triggerRef = createRef<HTMLButtonElement>();
    const { unmount } = render(
      <>
        <Trigger triggerRef={triggerRef} />
        <SuppressTemplateDialog
          corpusId="c1"
          templateId={22}
          policyRevision={7}
          narrow
          triggerRef={triggerRef}
          onReloadPolicy={async () => 7}
          onActivated={async () => {}}
          onDismiss={vi.fn()}
        />
      </>,
    );
    const form = screen.getByRole("dialog", {
      name: "Suppress exact template",
    });
    expect(form.classList.contains("log-explorer__suppress-dialog--sheet")).toBe(
      true,
    );
    expect(
      screen.getByTestId("suppress-template-backdrop").parentElement,
    ).toBe(document.body);
    unmount();

    const wideRef = createRef<HTMLButtonElement>();
    render(
      <>
        <Trigger triggerRef={wideRef} />
        <SuppressTemplateDialog
          corpusId="c1"
          templateId={22}
          policyRevision={7}
          narrow={false}
          triggerRef={wideRef}
          onReloadPolicy={async () => 7}
          onActivated={async () => {}}
          onDismiss={vi.fn()}
        />
      </>,
    );
    expect(
      screen
        .getByRole("dialog", { name: "Suppress exact template" })
        .classList.contains("log-explorer__suppress-dialog--sheet"),
    ).toBe(false);
  });

  it("previews trusted impact and requires explicit confirmation", async () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const onActivated = vi.fn(async () => {});
    const onDismiss = vi.fn();
    render(
      <>
        <Trigger triggerRef={triggerRef} />
        <SuppressTemplateDialog
          corpusId="c1"
          templateId={22}
          policyRevision={7}
          narrow={false}
          triggerRef={triggerRef}
          onReloadPolicy={async () => 7}
          onActivated={onActivated}
          onDismiss={onDismiss}
        />
      </>,
    );

    expect(
      screen.getByTestId("suppress-template-backdrop").parentElement,
    ).toBe(document.body);

    fireEvent.change(screen.getByLabelText("Rule name"), {
      target: { value: "Routine heartbeat" },
    });
    fireEvent.change(screen.getByLabelText("Rationale (required)"), {
      target: { value: "Known repetitive health traffic." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));
    await waitFor(() =>
      expect(host.hostLogPreviewTemplateSuppression).toHaveBeenCalledWith(
        "c1",
        {
          expectedRevision: 7,
          name: "Routine heartbeat",
          rationale: "Known repetitive health traffic.",
          templateId: 22,
        },
      ),
    );
    await waitFor(() => {
      expect(screen.getByText("250")).toBeTruthy();
      expect(screen.getByText(/25.0% of raw corpus/)).toBeTruthy();
      expect(screen.getByText("heartbeat token=[REDACTED]")).toBeTruthy();
    });
    expect(host.hostLogActivateTemplateSuppression).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm suppression" }),
    );
    await waitFor(() =>
      expect(host.hostLogActivateTemplateSuppression).toHaveBeenCalledWith(
        "c1",
        7,
        "preview-token",
      ),
    );
    expect(onActivated).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("cancels with Escape and restores inspector focus", async () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const onDismiss = vi.fn();
    render(
      <>
        <Trigger triggerRef={triggerRef} />
        <SuppressTemplateDialog
          corpusId="c1"
          templateId={22}
          policyRevision={7}
          narrow
          triggerRef={triggerRef}
          onReloadPolicy={async () => 7}
          onActivated={async () => {}}
          onDismiss={onDismiss}
        />
      </>,
    );

    fireEvent.keyDown(screen.getByTestId("suppress-template-backdrop"), {
      key: "Escape",
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(document.activeElement).toBe(triggerRef.current),
    );
    expect(host.hostLogPreviewTemplateSuppression).not.toHaveBeenCalled();
  });

  it("resynchronizes the durable policy after dismissing a preview", async () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const onDismiss = vi.fn();
    const onReloadPolicy = vi.fn(async () => 8);
    render(
      <>
        <Trigger triggerRef={triggerRef} />
        <SuppressTemplateDialog
          corpusId="c1"
          templateId={22}
          policyRevision={7}
          narrow={false}
          triggerRef={triggerRef}
          onReloadPolicy={onReloadPolicy}
          onActivated={async () => {}}
          onDismiss={onDismiss}
        />
      </>,
    );

    fireEvent.change(screen.getByLabelText("Rationale (required)"), {
      target: { value: "Known repetitive health traffic." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));
    expect(
      await screen.findByRole("button", { name: "Confirm suppression" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onReloadPolicy).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(document.activeElement).toBe(triggerRef.current),
    );
    expect(host.hostLogActivateTemplateSuppression).not.toHaveBeenCalled();
  });

  it("keeps stale errors visible and reloads before re-previewing", async () => {
    vi.mocked(host.hostLogPreviewTemplateSuppression)
      .mockRejectedValueOnce(new Error("stale suppression revision"))
      .mockResolvedValueOnce({ ...preview(), ruleRevision: 9 });
    const triggerRef = createRef<HTMLButtonElement>();
    const onReloadPolicy = vi.fn(async () => 9);
    render(
      <>
        <Trigger triggerRef={triggerRef} />
        <SuppressTemplateDialog
          corpusId="c1"
          templateId={22}
          policyRevision={7}
          narrow={false}
          triggerRef={triggerRef}
          onReloadPolicy={onReloadPolicy}
          onActivated={async () => {}}
          onDismiss={vi.fn()}
        />
      </>,
    );

    fireEvent.change(screen.getByLabelText("Rationale (required)"), {
      target: { value: "Known repetitive health traffic." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));
    expect(await screen.findByText(/stale suppression revision/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Reload policy and re-preview",
      }),
    );
    await waitFor(() => expect(onReloadPolicy).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(host.hostLogPreviewTemplateSuppression).toHaveBeenLastCalledWith(
        "c1",
        expect.objectContaining({ expectedRevision: 9, templateId: 22 }),
      ),
    );
    expect(
      await screen.findByRole("button", { name: "Confirm suppression" }),
    ).toBeTruthy();
  });

  it("shows durable resolution lifecycle for stale rules that exclude nothing (#819)", async () => {
    const triggerRef = createRef<HTMLButtonElement>();
    render(
      <NoisePolicyControl
        corpusId="c1"
        document={policy("enabled", {
          kind: "stale_target_missing",
          matchesNothing: true,
          explanation: "Target template no longer exists.",
        })}
        hiddenCount={0}
        state="ready"
        error={null}
        narrow={false}
        triggerRef={triggerRef}
        onRetry={vi.fn()}
        onMutate={vi.fn()}
        onReloadPolicy={async () => 7}
        onCandidateActivated={async () => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("noise-policy-trigger"));
    const rule = await screen.findByTestId("noise-rule-rule-1");
    expect(rule.getAttribute("data-resolution")).toBe("stale_target_missing");
    expect(rule.getAttribute("data-excludes")).toBe("false");
    expect(screen.getByTestId("noise-rule-resolution-rule-1").textContent).toMatch(
      /Stale — matches nothing/,
    );
    expect(screen.getByText(/templates r11/)).toBeTruthy();
  });
});
