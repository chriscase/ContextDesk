/**
 * Visual acceptance — Investigation report surface, review cards, export
 * dialog, and the Investigations pane (#532).
 *
 * Covers, at real rendered geometry in headless Chromium:
 * - The full report document at pane width (~52rem reading measure) and at
 *   the Explorer rail's 300px track: fixed seven-section order, authored vs
 *   Not-authored sections, per-finding policy-binding statuses (current /
 *   made_under_different_policy / unbound_legacy), and the identity-only
 *   timeline with all three [verified]/[stale]/[missing] text badges.
 * - Geometry: no horizontal page overflow at either width; timeline rows
 *   wrap (flex-wrap, investigation-report.css:161-170) instead of scrolling;
 *   the pane report column respects the --chat-measure cap in a wide
 *   container (investigation-report.css:302-313).
 * - Proposed-report-section review card: closed four-action state and the
 *   inline dismiss-reason state whose confirm stays disabled until a
 *   non-empty reason is typed.
 * - Export dialog: exact byte count line, internally scrolling preview well
 *   (both axes, investigation-report.css:189-202), axe on the open dialog.
 * - Investigations pane via the mocked engine boundary: loading, no-corpora,
 *   desktop-app-required degradation, and the loaded state across the
 *   container breakpoints (stacked at narrow 640, side-by-side at wide 1720),
 *   plus the section-editor dialog focus contract (focus lands in the
 *   textarea, Tab wraps, Escape refocuses the trigger).
 *
 * Renderer-level proof ONLY: Vitest browser mode driving real Chromium —
 * real CSS, layout, focus, and ARIA. This is never native packaged
 * acceptance (docs/CLOSE_PROOF.md § Native packaged proof).
 *
 * Assertions derive from the shipped unit contracts in
 * src/components/logExplorer/InvestigationReport.test.tsx (seven-section
 * order, authored mix, export prepare/save/release),
 * src/components/panes/InvestigationsPane.test.tsx (pane states + editor
 * dialog), and the geometry in
 * src/styles/components/investigation-report.css.
 */
import "./support/styles";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { fireEvent, waitFor, within } from "@testing-library/react";
import * as engine from "../src/lib/engine/investigationReports";
import {
  InvestigationReportExportDialog,
  InvestigationReportSurface,
  ProposedReportSectionCard,
} from "../src/components/logExplorer/InvestigationReport";
import { InvestigationsPane } from "../src/components/panes/InvestigationsPane";
import {
  applyTheme,
  expectNoAxeViolations,
  expectNoHorizontalPageOverflow,
  nextPaintedFrame,
  renderVisual,
  resetVisualState,
  setViewport,
} from "./support/harness";
import {
  CHAT_MEASURE_PX,
  RAIL_WIDTH,
  ReportFrame,
  corpora,
  exportMarkdownFixture,
  proposedSectionView,
  reportPreviewFixture,
  resolvedInvestigation,
} from "./support/investigationReportFixtures";

// House convention for pane suites (InvestigationsPane.test.tsx:6-18): mock
// the engine boundary module — the ONLY module through which report surfaces
// reach the host — so nothing in this suite can touch the (absent) Tauri
// bridge. The factory exports every runtime symbol the component graph
// imports; the type re-exports are erased at compile time.
vi.mock("../src/lib/engine/investigationReports", () => ({
  investigationHostAvailable: vi.fn(),
  listLogCorpora: vi.fn(),
  logLoadActiveInvestigation: vi.fn(),
  logAssembleInvestigationReport: vi.fn(),
  logAcceptProposedReportSection: vi.fn(),
  logDismissProposedReportSection: vi.fn(),
  logSetInvestigationReportSection: vi.fn(),
  logPreviewInvestigationEvidence: vi.fn(),
  logSaveInvestigationReportExport: vi.fn(),
  logReleaseInvestigationReportExport: vi.fn(),
}));

const hostAvailableMock = vi.mocked(engine.investigationHostAvailable);
const listCorporaMock = vi.mocked(engine.listLogCorpora);
const loadInvestigationMock = vi.mocked(engine.logLoadActiveInvestigation);
const assembleMock = vi.mocked(engine.logAssembleInvestigationReport);
const saveExportMock = vi.mocked(engine.logSaveInvestigationReportExport);
const releaseExportMock = vi.mocked(engine.logReleaseInvestigationReportExport);

const SECTION_LABELS = [
  "1 · Incident scope & window",
  "2 · Executive summary",
  "3 · Accepted findings",
  "4 · Evidence-backed timeline",
  "5 · Hypotheses & alternatives",
  "6 · Unresolved questions",
  "7 · Next actions",
];

function renderSurface(width: number | string) {
  return renderVisual(
    <ReportFrame width={width}>
      <InvestigationReportSurface
        preview={reportPreviewFixture()}
        busy={false}
        error={null}
        onPreviewEvidence={() => undefined}
        onEditSection={() => undefined}
        onExport={() => undefined}
      />
    </ReportFrame>,
  );
}

/**
 * Render the pane inside the exact container Workspace gives it
 * (shell/Workspace.tsx:124-128 mounts it in div.pane-panel; the explicit
 * 100vh stands in for the app-shell grid track, mirroring help.test.tsx).
 */
function renderPane() {
  return renderVisual(
    <div className="pane-panel" style={{ height: "100vh" }}>
      <InvestigationsPane />
    </div>,
  );
}

async function renderLoadedPane() {
  const view = renderPane();
  fireEvent.click(await view.findByTestId("investigations-corpus-c1"));
  await view.findByTestId("investigations-summary");
  // Lazy assembly resolves after load; the surface title proves it painted.
  await waitFor(() =>
    expect(view.getByTestId("investigation-report").textContent).toContain(
      "Checkout latency regression",
    ),
  );
  return view;
}

describe("investigation report visual acceptance", () => {
  beforeEach(async () => {
    await resetVisualState();
    vi.clearAllMocks();
    hostAvailableMock.mockReturnValue(true);
    listCorporaMock.mockResolvedValue(corpora());
    loadInvestigationMock.mockResolvedValue(resolvedInvestigation());
    assembleMock.mockResolvedValue(reportPreviewFixture());
    saveExportMock.mockResolvedValue({ status: "saved" });
    releaseExportMock.mockResolvedValue(true);
  });

  it("renders the seven-section report at pane width with the authored mix and policy statuses", async () => {
    const view = renderSurface("52rem");
    const surface = view.getByTestId("investigation-report");

    // Fixed seven-section order from the typed projection.
    const labels = [
      ...surface.querySelectorAll(".investigation-report__section-label"),
    ].map((node) => node.textContent);
    expect(labels).toEqual(SECTION_LABELS);

    // Authored + not-authored mix: accepted-from-proposal summary, direct
    // human next-actions, explicit Not authored placeholder in between.
    const summary = view.getByTestId("report-authored-executive_summary");
    expect(summary.textContent).toContain(
      "Retries amplified a database timeout",
    );
    expect(summary.textContent).toContain(
      "accepted from model proposal · openai_compatible · incident-model",
    );
    expect(summary.textContent).toContain("edited during acceptance");
    const unresolved = view.getByTestId(
      "report-not-authored-unresolved_questions",
    );
    expect(unresolved.textContent).toBe("Not authored.");
    const nextActions = view.getByTestId("report-authored-next_actions");
    expect(nextActions.textContent).toContain("Human authored");
    expect(nextActions.textContent).not.toContain("agent proposal");

    // All three policy-binding statuses render as text, incl. unbound_legacy.
    const byStatus = (id: string): HTMLElement => {
      const badge = view
        .getByTestId(`report-finding-${id}`)
        .querySelector<HTMLElement>(".investigation-report__policy");
      expect(badge).not.toBeNull();
      return badge!;
    };
    expect(byStatus("finding-1").textContent).toBe("Current noise policy");
    expect(byStatus("finding-2").textContent).toBe(
      "Made under a different noise policy",
    );
    const legacy = byStatus("finding-3");
    expect(legacy.textContent).toBe("Legacy finding · no noise-policy binding");
    expect(legacy.getAttribute("data-policy-status")).toBe("unbound_legacy");
    // Hypotheses never sit in section 3.
    const findingsSection = view.getByTestId("report-section-findings");
    expect(
      within(findingsSection).queryByTestId("report-finding-finding-3"),
    ).toBeNull();
    within(view.getByTestId("report-section-hypotheses")).getByTestId(
      "report-finding-finding-3",
    );

    // Timeline: all three text badges plus the order-only row and the bound.
    const timeline = view.getByTestId("report-section-timeline");
    expect(timeline.textContent).toContain("[verified]");
    expect(timeline.textContent).toContain("[stale]");
    expect(timeline.textContent).toContain("[missing]");
    expect(timeline.textContent).toContain("order-only · seq 9");
    expect(view.getByTestId("report-timeline-omitted").textContent).toContain(
      "3 omitted (bounded render)",
    );

    // Geometry: rows wrap inside the column (flex-wrap, never a horizontal
    // scroll surface) and the page never scrolls sideways.
    const entries = timeline.querySelectorAll<HTMLElement>(
      ".investigation-report__timeline-entry",
    );
    expect(entries.length).toBe(3);
    for (const entry of entries) {
      expect(getComputedStyle(entry).flexWrap).toBe("wrap");
    }
    const list = timeline.querySelector<HTMLElement>(
      ".investigation-report__timeline",
    );
    expect(list).not.toBeNull();
    expect(list!.scrollWidth).toBeLessThanOrEqual(list!.clientWidth);
    expect(surface.scrollWidth).toBeLessThanOrEqual(surface.clientWidth);
    expectNoHorizontalPageOverflow();

    await expectNoAxeViolations(surface);

    // The full document is taller than the 800px viewport, and the tester
    // only paints the in-viewport region — an element capture would bake a
    // blank bottom half into the baseline. Grow the viewport (fixed height,
    // deterministic) so all seven sections are painted in the capture.
    await page.viewport(1280, 1600);
    await nextPaintedFrame();
    await expect(page.elementLocator(surface)).toMatchScreenshot(
      "investigation-report-pane-dark",
    );
    await applyTheme("light");
    await expect(page.elementLocator(surface)).toMatchScreenshot(
      "investigation-report-pane-light",
    );
  });

  it("stays inside the 300px rail track without horizontal overflow", async () => {
    const view = renderSurface(RAIL_WIDTH);
    const surface = view.getByTestId("investigation-report");
    expect(Math.round(surface.getBoundingClientRect().width)).toBe(RAIL_WIDTH);

    // Every section is present even at rail width…
    const labels = [
      ...surface.querySelectorAll(".investigation-report__section-label"),
    ].map((node) => node.textContent);
    expect(labels).toEqual(SECTION_LABELS);

    // …and long identities wrap inside the column instead of escaping it.
    expect(surface.scrollWidth).toBeLessThanOrEqual(surface.clientWidth);
    for (const finding of surface.querySelectorAll<HTMLElement>(
      ".investigation-report__finding",
    )) {
      expect(finding.scrollWidth).toBeLessThanOrEqual(finding.clientWidth);
    }
    expectNoHorizontalPageOverflow();

    // Same painted-region constraint as the pane-width capture: the rail
    // document runs ~1150px tall, so grow the viewport before shooting.
    await page.viewport(1280, 1600);
    await nextPaintedFrame();
    await expect(page.elementLocator(surface)).toMatchScreenshot(
      "investigation-report-rail-dark",
    );
  });

  it("gates the review card's inline dismissal on a non-empty reason", async () => {
    const onDismiss = vi.fn();
    const view = renderVisual(
      <ReportFrame width={352}>
        <ProposedReportSectionCard
          item={proposedSectionView}
          busy={false}
          onAccept={() => undefined}
          onDismiss={onDismiss}
        />
      </ReportFrame>,
    );

    // Closed state: kicker, kind label, counts line, all four actions.
    const card = view.getByTestId(`proposed-report-${proposedSectionView.id}`);
    expect(card.textContent).toContain("Proposed report section");
    expect(card.textContent).toContain("Executive summary");
    expect(card.textContent).toContain(
      "1 evidence · 1 finding · 0 note citations · Agent proposed",
    );
    const cardRect = card.getBoundingClientRect();
    for (const id of [
      `preview-proposed-report-${proposedSectionView.id}`,
      `accept-proposed-report-${proposedSectionView.id}`,
      `edit-accept-proposed-report-${proposedSectionView.id}`,
      `dismiss-proposed-report-${proposedSectionView.id}`,
    ]) {
      const button = view.getByTestId(id) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      const rect = button.getBoundingClientRect();
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.right).toBeLessThanOrEqual(cardRect.right + 0.5);
    }

    // Inline dismiss state: confirm stays disabled until a reason is typed.
    fireEvent.click(
      view.getByTestId(`dismiss-proposed-report-${proposedSectionView.id}`),
    );
    const dismissBlock = view.getByTestId(
      `proposed-report-dismiss-${proposedSectionView.id}`,
    );
    expect(dismissBlock.textContent).toContain("Dismiss reason (required)");
    const confirm = view.getByTestId(
      `confirm-dismiss-proposed-report-${proposedSectionView.id}`,
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.change(
      view.getByTestId(
        `dismiss-reason-proposed-report-${proposedSectionView.id}`,
      ),
      { target: { value: "Wrong incident scope" } },
    );
    expect(confirm.disabled).toBe(false);

    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    expectNoHorizontalPageOverflow();

    await expect(page.elementLocator(card)).toMatchScreenshot(
      "proposed-report-dismiss-dark",
    );
  });

  it("shows the exact export byte count with an internally scrolling preview", async () => {
    const prepared = exportMarkdownFixture();
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    const triggerRef = createRef<HTMLButtonElement>();
    (triggerRef as { current: HTMLButtonElement | null }).current = trigger;
    const view = renderVisual(
      <InvestigationReportExportDialog
        preview={prepared}
        triggerRef={triggerRef}
        onDismiss={() => undefined}
      />,
    );

    const dialog = view.getByRole("dialog", {
      name: "Export investigation report",
    });
    await waitFor(() =>
      expect(dialog.textContent).toContain(
        `Exact export preview · ${prepared.exportBytes!.toLocaleString("en-US")} bytes`,
      ),
    );
    // One painted frame before any computed read (harness.ts:38-49) so
    // axe/screenshots never see stale computed styles.
    await nextPaintedFrame();
    const previewEl = view.getByTestId("report-export-preview");
    expect(previewEl.textContent).toBe(prepared.markdown);

    // The preview well scrolls internally on both axes (overflow:auto,
    // white-space:pre, max-height 20rem — investigation-report.css:189-202);
    // the dialog and the page never grow sideways.
    const style = getComputedStyle(previewEl);
    expect(style.overflowY).toBe("auto");
    expect(style.overflowX).toBe("auto");
    expect(previewEl.scrollHeight).toBeGreaterThan(previewEl.clientHeight);
    expect(previewEl.scrollWidth).toBeGreaterThan(previewEl.clientWidth);
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    expectNoHorizontalPageOverflow();

    const save = view.getByTestId("report-export-save") as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    await expectNoAxeViolations(dialog);

    await expect(page.elementLocator(dialog)).toMatchScreenshot(
      "report-export-dialog-dark",
    );
    trigger.remove();
  });

  it("renders the pane loading, no-corpora, and desktop-app-required states", async () => {
    // Loading: the corpora listing is still pending.
    listCorporaMock.mockReturnValue(new Promise(() => undefined));
    const loading = renderPane();
    const status = loading.getByRole("status");
    expect(status.textContent).toBe("Loading log corpora…");
    loading.unmount();

    // Empty library: points at the Logs pane.
    listCorporaMock.mockResolvedValue([]);
    const empty = renderPane();
    const emptyNote = await empty.findByTestId("investigations-no-corpora");
    expect(emptyNote.textContent).toContain("No log corpora yet");
    expect(emptyNote.textContent).toContain("Logs pane");
    empty.unmount();

    // Browser-mode degradation: truthful desktop-app-required copy.
    hostAvailableMock.mockReturnValue(false);
    const degraded = renderPane();
    const note = degraded.getByTestId("investigations-no-host");
    expect(within(note).getByRole("status").textContent).toContain(
      "require the desktop app",
    );
    expect(degraded.queryByTestId("investigations-no-corpora")).toBeNull();
    expectNoHorizontalPageOverflow();
  });

  it("lays the loaded pane out per container breakpoint: normal, stacked narrow, side-by-side wide", async () => {
    const view = await renderLoadedPane();
    const pane = view.getByTestId("investigations-pane");
    expect(pane.getAttribute("data-breakpoint")).toBe("normal");
    expect(view.getByTestId("investigations-summary").textContent).toContain(
      "1 evidence · 0 findings · 0 notes · 2 authored sections · 1 proposed sections · revision 4",
    );
    // The review rail carries the proposed-section card next to the report.
    view.getByTestId("proposed-report-prop-report-1");

    const content = pane.querySelector<HTMLElement>(
      ".investigations-pane__content",
    );
    expect(content).not.toBeNull();
    expect(getComputedStyle(content!).display).toBe("grid");
    expectNoHorizontalPageOverflow();

    await expectNoAxeViolations(pane);
    await expect(page.elementLocator(pane)).toMatchScreenshot(
      "investigations-pane-loaded-dark",
    );

    // Narrow 640: the ResizeObserver reclassifies from real laid-out width;
    // report and review stack, and the corpus rail becomes a row strip.
    await setViewport("narrow");
    await waitFor(
      () => expect(pane.getAttribute("data-breakpoint")).toBe("narrow"),
      { timeout: 5000 },
    );
    await nextPaintedFrame();
    expect(getComputedStyle(content!).display).toBe("flex");
    expect(getComputedStyle(content!).flexDirection).toBe("column");
    const reportColumn = pane.querySelector<HTMLElement>(
      ".investigations-pane__report-column",
    )!;
    const review = pane.querySelector<HTMLElement>(
      ".investigations-pane__review",
    )!;
    expect(review.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      reportColumn.getBoundingClientRect().bottom,
    );
    // Regression for the narrow corpus-rail collapse: the strip must keep
    // its natural height (flex-shrink: 0 + min-height: auto in the narrow
    // block of investigation-report.css) so the report content starts below
    // it instead of being painted over.
    {
      const corpusRail = pane.querySelector<HTMLElement>(
        ".investigations-pane__corpora",
      )!;
      const main = pane.querySelector<HTMLElement>(
        ".investigations-pane__main",
      )!;
      expect(corpusRail.getBoundingClientRect().height).toBeGreaterThan(1);
      const card = view.getByTestId("investigations-corpus-c1");
      expect(card.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        main.getBoundingClientRect().top + 1,
      );
    }
    expectNoHorizontalPageOverflow();
    await expect(page.elementLocator(pane)).toMatchScreenshot(
      "investigations-pane-loaded-dark-narrow",
    );

    // Wide 1720: side-by-side, and the report column respects the shared
    // reading measure cap instead of cramming the workspace width
    // (investigation-report.css:302-313, --chat-measure = 52rem).
    await setViewport("wide");
    await waitFor(
      () => expect(pane.getAttribute("data-breakpoint")).toBe("wide"),
      { timeout: 5000 },
    );
    await nextPaintedFrame();
    expect(getComputedStyle(content!).display).toBe("grid");
    const columnRect = reportColumn.getBoundingClientRect();
    const reviewRect = review.getBoundingClientRect();
    expect(reviewRect.left).toBeGreaterThanOrEqual(columnRect.right);
    expect(columnRect.width).toBeLessThanOrEqual(CHAT_MEASURE_PX + 0.5);
    expectNoHorizontalPageOverflow();
  });

  it("traps focus in the section-editor dialog and refocuses the trigger on close", async () => {
    const view = await renderLoadedPane();

    // unresolved_questions is not authored, so the trigger reads Write section.
    const trigger = view.getByTestId(
      "report-edit-section-unresolved_questions",
    );
    expect(trigger.textContent).toBe("Write section");
    fireEvent.click(trigger);

    const dialog = view.getByRole("dialog", {
      name: "Write Unresolved questions",
    });
    const body = view.getByTestId("report-section-body") as HTMLTextAreaElement;
    // Opening moves focus into the dialog (queueMicrotask-deferred).
    await waitFor(() => expect(document.activeElement).toBe(body));

    // Tab wraps inside the dialog: from the last focusable (Save, enabled
    // once the body is non-empty) back to the first (the textarea), and
    // Shift+Tab wraps the other way.
    fireEvent.change(body, { target: { value: "Why did p99 recover early?" } });
    const save = view.getByTestId("report-section-save") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    save.focus();
    fireEvent.keyDown(save, { key: "Tab" });
    expect(document.activeElement).toBe(body);
    fireEvent.keyDown(body, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(save);
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    // Escape closes and refocuses the originating trigger.
    fireEvent.keyDown(body, { key: "Escape" });
    await waitFor(() =>
      expect(view.queryByTestId("report-section-backdrop")).toBeNull(),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.getByTestId("report-edit-section-unresolved_questions"),
      ),
    );
  });
});
