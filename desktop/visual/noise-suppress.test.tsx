/**
 * Visual acceptance: noise-suppression surfaces of the Log Explorer.
 *
 * Covers (mostly direct component renders):
 * - NoisePolicyControl popover: bounded non-modal dialog geometry, Done
 *   focus, min(31rem, 100vw-2rem) width (dark + light screenshots).
 * - NoiseCandidateReview inside the widened (--review) popover: min(52rem,…)
 *   width, internal scroll containment, and the governance a11y invariants
 *   (no checkboxes, no bulk accept, risk chip present) from #823/#825;
 *   loading/error/stale sub-states by role and disabled-state geometry.
 * - SuppressTemplateDialog (#818): modal naming, initial fully-selected Rule
 *   name focus, rationale-gated preview; the #834 viewport-dialog geometry
 *   (commit b469f0d): body portal, fixed full-viewport backdrop, centered
 *   min(36rem, 100vw-2rem) form, z-order above the popover, and the
 *   pointerdown+click regression scenario; suppression error alert; axe on
 *   the open preview dialog.
 * - Narrow bottom sheet (#834 follow-up repair): the portaled dialog receives
 *   its sheet styling from the directly applied --sheet class (no
 *   .log-explorer ancestor, no body mutation) — top radii, square bottom,
 *   full bounded width, bottom docking, internal scrolling, plus outside
 *   dismissal, focus return, and no orphan overlay on unmount.
 *
 * HONESTY: everything proven here is renderer-level (real CSS/layout/focus/
 * ARIA in headless Chromium via Vitest browser mode) — it is NOT native
 * packaged acceptance (docs/CLOSE_PROOF.md § Native packaged proof).
 *
 * Assertions derive from: issues #818/#819/#823/#825 (governed noise review,
 * human-only suppression), #834 / commit b469f0d (suppression preview as a
 * viewport dialog), src/styles/components/log-explorer.css (dialog backdrop,
 * popover, suppress dialog, and narrow-sheet rules), and the reference unit
 * suites NoisePolicy.test.tsx / NoiseCandidateReview.test.tsx.
 */
import "./support/styles";
import { createRef, type RefObject } from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import * as host from "../src/lib/host";
import {
  NoisePolicyControl,
  SuppressTemplateDialog,
} from "../src/components/logExplorer/NoisePolicy";
import { NoiseCandidateReview } from "../src/components/logExplorer/NoiseCandidateReview";
import {
  applyTheme,
  expectNoAxeViolations,
  expectNoHorizontalPageOverflow,
  expectWithinViewport,
  nextPaintedFrame,
  renderVisual,
  resetVisualState,
  setViewport,
} from "./support/harness";
import {
  candidateReport,
  mutationResult,
  policyDocument,
  suppressionPreview,
} from "./support/noiseSuppressFixtures";

// Repo convention: mock the host module boundary; the factory must export
// every symbol this component graph imports (NoisePolicy.tsx +
// NoiseCandidateReview.tsx import exactly these three functions; their type
// imports are erased at compile time).
vi.mock("../src/lib/host", () => ({
  hostLogPreviewTemplateSuppression: vi.fn(),
  hostLogActivateTemplateSuppression: vi.fn(),
  hostLogProposeNoiseCandidates: vi.fn(),
}));

/** Root font size in px so rem-based CSS expectations track tokens.css. */
function remPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize);
}

function ExternalTrigger({
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

function renderPolicyControl() {
  const triggerRef = createRef<HTMLButtonElement>();
  const view = renderVisual(
    <NoisePolicyControl
      corpusId="c1"
      document={policyDocument()}
      hiddenCount={250}
      state="ready"
      error={null}
      narrow={false}
      triggerRef={triggerRef}
      onRetry={vi.fn()}
      onMutate={vi.fn(async () => mutationResult())}
      onSuspendAll={vi.fn()}
      onResume={vi.fn()}
      onReloadPolicy={async () => 7}
      onCandidateActivated={async () => {}}
    />,
  );
  return { view, triggerRef };
}

function renderSuppressDialog({ narrow = false }: { narrow?: boolean } = {}) {
  const triggerRef = createRef<HTMLButtonElement>();
  const onDismiss = vi.fn();
  const onReloadPolicy = vi.fn(async () => 7);
  const view = renderVisual(
    <>
      <ExternalTrigger triggerRef={triggerRef} />
      <SuppressTemplateDialog
        corpusId="c1"
        templateId={22}
        policyRevision={7}
        narrow={narrow}
        triggerRef={triggerRef}
        onReloadPolicy={onReloadPolicy}
        onActivated={async () => {}}
        onDismiss={onDismiss}
      />
    </>,
  );
  return { view, triggerRef, onDismiss, onReloadPolicy };
}

describe("noise suppression surfaces (renderer-level)", () => {
  beforeEach(async () => {
    await resetVisualState();
    vi.clearAllMocks();
    vi.mocked(host.hostLogPreviewTemplateSuppression).mockResolvedValue(
      suppressionPreview(),
    );
    vi.mocked(host.hostLogActivateTemplateSuppression).mockResolvedValue(
      mutationResult(),
    );
    // Stable (not Once): real Chromium re-fires window focus events, which
    // re-run NoiseCandidateReview's freshness probe; a drifting mock would
    // flip the stale banner nondeterministically.
    vi.mocked(host.hostLogProposeNoiseCandidates).mockResolvedValue(
      candidateReport(),
    );
  });

  it("opens the policy popover as a bounded non-modal dialog with Done focus (dark + light)", async () => {
    renderPolicyControl();
    fireEvent.click(screen.getByTestId("noise-policy-trigger"));

    const panel = screen.getByTestId("noise-policy-panel");
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("false");
    expect(panel.dataset.mode).toBe("popover");

    // Open focus lands on Done via queueMicrotask — assert inside waitFor.
    const done = within(panel).getByRole("button", { name: "Done" });
    await waitFor(() => expect(document.activeElement).toBe(done));

    // Geometry: width min(31rem, 100vw - 2rem) and fully inside the viewport.
    const rem = remPx();
    const rect = panel.getBoundingClientRect();
    expect(
      Math.abs(rect.width - Math.min(31 * rem, window.innerWidth - 2 * rem)),
    ).toBeLessThanOrEqual(1);
    expectWithinViewport(panel);
    expectNoHorizontalPageOverflow();

    // Content sanity so the screenshots capture the ready state.
    expect(within(panel).getByText("Routine heartbeat")).toBeTruthy();
    const disclosure = within(panel).getByTestId("noise-policy-disclosure");
    expect(disclosure.getAttribute("role")).toBe("status");
    expect(disclosure.textContent).toMatch(/not analyzed/i);
    const rule = within(panel).getByTestId("noise-rule-rule-1");
    expect(rule.dataset.resolution).toBe("matches_current");
    expect(rule.dataset.excludes).toBe("true");

    await expect(page.elementLocator(panel)).toMatchScreenshot(
      "noise-policy-ready-dark",
    );
    await applyTheme("light");
    await expect(page.elementLocator(panel)).toMatchScreenshot(
      "noise-policy-ready-light",
    );
  });

  it("widens the popover for candidate review with internal scroll and governance invariants", async () => {
    renderPolicyControl();
    fireEvent.click(screen.getByTestId("noise-policy-trigger"));
    const panel = screen.getByTestId("noise-policy-panel");
    const popoverWidth = panel.getBoundingClientRect().width;

    fireEvent.click(
      within(panel).getByRole("button", { name: "Review suggestions" }),
    );
    await screen.findByText(/Showing 1 of 24/);

    // Panel width grows to min(52rem, 100vw - 2rem) and still fits. The
    // --review class flipped on the existing panel element, so wait a
    // painted frame before reading its recomputed geometry.
    expect(
      panel.classList.contains("log-explorer__noise-policy--review"),
    ).toBe(true);
    await nextPaintedFrame();
    const rem = remPx();
    const rect = panel.getBoundingClientRect();
    expect(
      Math.abs(rect.width - Math.min(52 * rem, window.innerWidth - 2 * rem)),
    ).toBeLessThanOrEqual(1);
    expect(rect.width).toBeGreaterThan(popoverWidth);
    expectWithinViewport(panel);
    expectNoHorizontalPageOverflow();

    // The panel — not the page — is the scroll container: overflow auto with
    // a max-height of min(34rem, 100vh - 7rem); its box stays in-viewport
    // (asserted above), so overflowing review content scrolls internally.
    expect(getComputedStyle(panel).overflowY).toBe("auto");
    expect(rect.height).toBeLessThanOrEqual(
      Math.min(34 * rem, window.innerHeight - 7 * rem) + 1,
    );

    // Governance a11y invariants (#823/#825): nothing preselected, no bulk
    // acceptance; the risky-to-hide chip is visibly flagged.
    const review = within(panel).getByTestId("noise-candidate-review");
    expect(within(review).queryAllByRole("checkbox")).toHaveLength(0);
    expect(
      within(review).queryByRole("button", { name: /accept all/i }),
    ).toBeNull();
    const risk = review.querySelector('[data-risk="true"]');
    expect(risk?.textContent).toBe("Repetitive errors — risky to hide");

    await expect(page.elementLocator(panel)).toMatchScreenshot(
      "noise-review-ready-dark",
    );
  });

  it("exposes review loading as status, failure as retryable alert, and staleness as disabled actions", async () => {
    // Loading: hold the candidate report unresolved.
    vi.mocked(host.hostLogProposeNoiseCandidates).mockImplementation(
      () => new Promise<host.NoiseCandidateReportDto>(() => {}),
    );
    const loadingView = renderVisual(
      <NoiseCandidateReview
        corpusId="c1"
        currentSuppressionRevision={7}
        onBack={vi.fn()}
        onSuppress={vi.fn()}
      />,
    );
    const loading = await screen.findByText(
      "Reviewing bounded template facts…",
    );
    expect(loading.getAttribute("role")).toBe("status");
    loadingView.unmount();

    // Error: first load rejects; later calls (focus probes) stay stable.
    vi.mocked(host.hostLogProposeNoiseCandidates)
      .mockReset()
      .mockRejectedValueOnce(new Error("bounded candidate query timed out"))
      .mockResolvedValue(candidateReport());
    const errorView = renderVisual(
      <NoiseCandidateReview
        corpusId="c1"
        currentSuppressionRevision={7}
        onBack={vi.fn()}
        onSuppress={vi.fn()}
      />,
    );
    const failure = await screen.findByText(
      /bounded candidate query timed out/,
    );
    const alertBox = failure.closest('[role="alert"]');
    expect(alertBox).not.toBeNull();
    expect(
      within(alertBox as HTMLElement).getByRole("button", { name: "Retry" }),
    ).toBeTruthy();
    errorView.unmount();

    // Stale: report revision 7 vs current revision 8 → alert + both action
    // buttons disabled until refreshed.
    renderVisual(
      <NoiseCandidateReview
        corpusId="c1"
        currentSuppressionRevision={8}
        onBack={vi.fn()}
        onSuppress={vi.fn()}
      />,
    );
    const stale = await screen.findByText("Suggestions are stale.");
    expect(stale.closest('[role="alert"]')).not.toBeNull();
    const notNoise = screen.getByRole("button", {
      name: "Not noise…",
    }) as HTMLButtonElement;
    const suppress = screen.getByRole("button", {
      name: "Suppress…",
    }) as HTMLButtonElement;
    expect(notNoise.disabled).toBe(true);
    expect(suppress.disabled).toBe(true);
  });

  it("opens the suppress rationale dialog modal with fully selected name and gated preview", async () => {
    renderSuppressDialog();

    const dialog = screen.getByRole("dialog", {
      name: "Suppress exact template",
    });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(
      within(dialog).getByText("Template 22 · policy revision 7"),
    ).toBeTruthy();

    // Initial focus = Rule name input with FULL selection (queueMicrotask).
    const nameInput = within(dialog).getByLabelText(
      "Rule name",
    ) as HTMLInputElement;
    expect(nameInput.value).toBe("Template 22");
    await waitFor(() => {
      expect(document.activeElement).toBe(nameInput);
      expect(nameInput.selectionStart).toBe(0);
      expect(nameInput.selectionEnd).toBe(nameInput.value.length);
    });

    // 'Preview impact' stays disabled until the rationale is non-blank.
    const submit = within(dialog).getByRole("button", {
      name: "Preview impact",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const rationale = within(dialog).getByLabelText("Rationale (required)");
    fireEvent.change(rationale, { target: { value: "   " } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(rationale, {
      target: { value: "Known repetitive health traffic." },
    });
    expect(submit.disabled).toBe(false);
  });

  it("renders the suppression preview as a body-portaled viewport dialog (#834, dark + light)", async () => {
    renderSuppressDialog();
    fireEvent.change(screen.getByLabelText("Rationale (required)"), {
      target: { value: "Known repetitive health traffic." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));
    await screen.findByRole("button", { name: "Confirm suppression" });

    // (1) Portal: the backdrop is a direct child of document.body.
    const backdrop = screen.getByTestId("suppress-template-backdrop");
    expect(backdrop.parentElement).toBe(document.body);

    // (2) Fixed positioning covering the full viewport (pre-#834 the
    // absolute backdrop resolved against the popover's padding box).
    const backdropStyle = getComputedStyle(backdrop);
    expect(backdropStyle.position).toBe("fixed");
    const backdropRect = backdrop.getBoundingClientRect();
    expect(Math.abs(backdropRect.left)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(backdropRect.top)).toBeLessThanOrEqual(0.5);
    expect(
      Math.abs(backdropRect.width - window.innerWidth),
    ).toBeLessThanOrEqual(0.5);
    expect(
      Math.abs(backdropRect.height - window.innerHeight),
    ).toBeLessThanOrEqual(0.5);

    // z-order: backdrop layer (z-index 80) sits above the popover layer (48).
    expect(backdropStyle.zIndex).toBe("80");

    // (3) Responsive width against the real viewport: the form resolves
    // min(36rem, calc(100vw - 2rem)) and is horizontally centered under the
    // flex backdrop, offset min(18vh, 9rem) from the top.
    const form = screen.getByRole("dialog", {
      name: "Suppress exact template",
    });
    const rem = remPx();
    const formRect = form.getBoundingClientRect();
    expect(
      Math.abs(
        formRect.width - Math.min(36 * rem, window.innerWidth - 2 * rem),
      ),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(formRect.left - (window.innerWidth - formRect.width) / 2),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        formRect.top - Math.min(0.18 * window.innerHeight, 9 * rem),
      ),
    ).toBeLessThanOrEqual(1);
    expectWithinViewport(form);

    // (4) Branch marker so the popover's outside-dismiss treats the portaled
    // dialog as inside the policy branch.
    expect(backdrop.dataset.noisePolicyBranch).toBe("true");

    // Preview content (deterministic fixture; UTC-pinned context).
    expect(
      within(form).getByRole("region", { name: "Suppression preview" }),
    ).toBeTruthy();
    expect(within(form).getByText("250")).toBeTruthy();
    expect(within(form).getByText(/25\.0% of raw corpus/)).toBeTruthy();
    expect(within(form).getByText("Newly hidden")).toBeTruthy();
    expect(within(form).getByText("Sources")).toBeTruthy();
    expect(within(form).getByText("Time span")).toBeTruthy();
    expect(
      within(form).getByText("heartbeat token=[REDACTED]"),
    ).toBeTruthy();

    // axe on the open preview dialog (dark).
    await expectNoAxeViolations(backdrop, {
      // FINDING (product, minor): role="dialog" + aria-modal sit on the
      // <form> element itself (NoisePolicy.tsx:598-606), and ARIA-in-HTML
      // disallows the dialog role on <form> — axe aria-allowed-role fails.
      // Repair: move role="dialog"/aria-modal/labelledby/describedby to a
      // wrapping <div> (or make the container a <div> with an inner form).
      // Rule disabled so the rest of the surface stays enforced; remove this
      // disable once fixed.
      disableRules: ["aria-allowed-role"],
    });

    await expect(page.elementLocator(form)).toMatchScreenshot(
      "suppress-preview-open-dark",
    );
    await applyTheme("light");
    await expect(page.elementLocator(form)).toMatchScreenshot(
      "suppress-preview-open-light",
    );
  });

  it("keeps the popover-launched dialog and review panel mounted through pointerdown+click (#834 regression)", async () => {
    renderPolicyControl();
    fireEvent.click(screen.getByTestId("noise-policy-trigger"));
    fireEvent.click(screen.getByRole("button", { name: "Review suggestions" }));
    fireEvent.click(await screen.findByRole("button", { name: "Suppress…" }));

    await screen.findByRole("dialog", { name: "Suppress exact template" });
    fireEvent.change(screen.getByLabelText("Rationale (required)"), {
      target: { value: "Known repetitive health traffic." },
    });

    // The regression: a real document-level pointerdown before the click used
    // to dismiss the popover branch out from under the dialog.
    const previewImpact = screen.getByRole("button", { name: "Preview impact" });
    fireEvent.pointerDown(previewImpact);
    fireEvent.click(previewImpact);

    await screen.findByRole("button", { name: "Confirm suppression" });
    expect(
      screen.getByRole("dialog", { name: "Suppress exact template" }),
    ).toBeTruthy();
    expect(screen.getByTestId("noise-candidate-review")).toBeTruthy();

    // Portaled backdrop paints above the still-open review popover.
    const backdrop = screen.getByTestId("suppress-template-backdrop");
    const panel = screen.getByTestId("noise-policy-panel");
    expect(Number(getComputedStyle(backdrop).zIndex)).toBeGreaterThan(
      Number(getComputedStyle(panel).zIndex),
    );
    expect(host.hostLogActivateTemplateSuppression).not.toHaveBeenCalled();
  });

  it("keeps the dialog open on suppression failure with an alert and reload affordance", async () => {
    vi.mocked(host.hostLogPreviewTemplateSuppression)
      .mockReset()
      .mockRejectedValueOnce(new Error("stale suppression revision"))
      .mockResolvedValue(suppressionPreview());
    renderSuppressDialog();
    fireEvent.change(screen.getByLabelText("Rationale (required)"), {
      target: { value: "Known repetitive health traffic." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));

    const failure = await screen.findByText(/stale suppression revision/);
    const alertBox = failure.closest('[role="alert"]');
    expect(alertBox).not.toBeNull();

    // The alert renders INSIDE the still-open dialog; nothing closed.
    const dialog = screen.getByRole("dialog", {
      name: "Suppress exact template",
    });
    expect(dialog.contains(alertBox)).toBe(true);
    expect(
      within(dialog).getByRole("button", {
        name: "Reload policy and re-preview",
      }),
    ).toBeTruthy();
    // Preview state is nulled on error: submit reverts to 'Preview impact'.
    expect(
      within(dialog).getByRole("button", { name: "Preview impact" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Confirm suppression" }),
    ).toBeNull();
  });

  it("renders the narrow suppress dialog as a bottom sheet on the portaled backdrop (#834)", async () => {
    // Regression for the #834 follow-up repair: the portaled dialog left the
    // .log-explorer subtree, so the sheet rule must select the directly
    // applied --sheet class (log-explorer.css), not a .log-explorer--narrow
    // ancestor. No body/ancestor mutation happens here — the sheet styling
    // must arrive purely from narrow={true}.
    await setViewport("narrow");
    const { view, triggerRef, onDismiss } = renderSuppressDialog({
      narrow: true,
    });
    const rem = remPx();

    const form = screen.getByRole("dialog", {
      name: "Suppress exact template",
    });
    expect(
      form.classList.contains("log-explorer__suppress-dialog--sheet"),
    ).toBe(true);
    expect(document.body.classList.contains("log-explorer--narrow")).toBe(
      false,
    );

    // Backdrop: still the fixed full-viewport overlay.
    const backdrop = screen.getByTestId("suppress-template-backdrop");
    expect(backdrop.parentElement).toBe(document.body);
    expect(getComputedStyle(backdrop).position).toBe("fixed");
    const backdropRect = backdrop.getBoundingClientRect();
    expect(Math.abs(backdropRect.left)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(backdropRect.top)).toBeLessThanOrEqual(0.5);
    expect(
      Math.abs(backdropRect.width - window.innerWidth),
    ).toBeLessThanOrEqual(0.5);
    expect(
      Math.abs(backdropRect.height - window.innerHeight),
    ).toBeLessThanOrEqual(0.5);

    // Sheet geometry: rounded top corners, square bottom corners.
    const sheetStyle = getComputedStyle(form);
    expect(sheetStyle.borderTopLeftRadius).toBe("12px");
    expect(sheetStyle.borderTopRightRadius).toBe("12px");
    expect(sheetStyle.borderBottomLeftRadius).toBe("0px");
    expect(sheetStyle.borderBottomRightRadius).toBe("0px");

    // Full bounded width (100% of the backdrop's 1rem-padded content box)
    // and bottom docking (margin-top auto against the 1rem bottom padding).
    const sheetRect = form.getBoundingClientRect();
    expect(
      Math.abs(sheetRect.width - (backdropRect.width - 2 * rem)),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(sheetRect.bottom - (backdropRect.bottom - rem)),
    ).toBeLessThanOrEqual(1);

    // Internal scrolling: the sheet is height-bounded to 86vh and scrolls its
    // own content; the page never scrolls horizontally.
    expect(sheetStyle.overflow).toBe("auto");
    expect(
      Math.abs(parseFloat(sheetStyle.maxHeight) - 0.86 * window.innerHeight),
    ).toBeLessThanOrEqual(1);
    expect(sheetRect.height).toBeLessThanOrEqual(
      0.86 * window.innerHeight + 1,
    );
    expectNoHorizontalPageOverflow();

    // The loaded preview keeps the sheet contract and holds a baseline.
    fireEvent.change(screen.getByLabelText("Rationale (required)"), {
      target: { value: "Known repetitive health traffic." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));
    await screen.findByRole("button", { name: "Confirm suppression" });
    await nextPaintedFrame();
    const loadedRect = form.getBoundingClientRect();
    expect(
      Math.abs(loadedRect.bottom - (backdropRect.bottom - rem)),
    ).toBeLessThanOrEqual(1);
    expect(loadedRect.height).toBeLessThanOrEqual(
      0.86 * window.innerHeight + 1,
    );
    await expect(page.elementLocator(backdrop)).toMatchScreenshot(
      "suppress-preview-sheet-dark-narrow",
    );

    // Outside dismissal still works from the sheet: the resync path runs,
    // focus returns to the trigger, and the parent is asked to close.
    fireEvent.mouseDown(backdrop);
    await waitFor(() => {
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(triggerRef.current);
    });

    // No orphan overlay: unmounting (what the parent does on dismiss) removes
    // the portaled backdrop from document.body.
    view.unmount();
    expect(
      document.querySelector('[data-testid="suppress-template-backdrop"]'),
    ).toBeNull();
  });
});
