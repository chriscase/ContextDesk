import { createRef, type RefObject } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as host from "../../lib/host";
import { NoisePolicyControl, SuppressTemplateDialog } from "./NoisePolicy";

vi.mock("../../lib/host", () => ({
  hostLogPreviewTemplateSuppression: vi.fn(),
  hostLogActivateTemplateSuppression: vi.fn(),
}));

function policy(
  state: host.SuppressionRuleState = "enabled",
): host.SuppressionDocumentDto {
  return {
    schemaVersion: 1,
    corpusId: "c1",
    revision: 7,
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
  beforeEach(() => vi.clearAllMocks());

  it("opens as a bounded popover, dismisses outside or with Escape, and restores focus", async () => {
    const triggerRef = createRef<HTMLButtonElement>();
    render(
      <NoisePolicyControl
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
    fireEvent.click(document.body);
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
        document={policy()}
        hiddenCount={250}
        state="ready"
        error={null}
        narrow
        triggerRef={triggerRef}
        onRetry={vi.fn()}
        onMutate={onMutate}
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
        document={policy("disabled")}
        hiddenCount={0}
        state="ready"
        error={null}
        narrow
        triggerRef={triggerRef}
        onRetry={vi.fn()}
        onMutate={onMutate}
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
    expect(screen.getByText("250")).toBeTruthy();
    expect(screen.getByText(/25.0% of raw corpus/)).toBeTruthy();
    expect(screen.getByText("heartbeat token=[REDACTED]")).toBeTruthy();
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
});
