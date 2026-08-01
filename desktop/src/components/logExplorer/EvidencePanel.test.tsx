import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LogInvestigationReportPreviewDto } from "../../lib/engine/investigationReports";
import type { ProposedReportSectionView } from "./InvestigationReport";
import {
  EvidencePanel,
  InvestigationModeControl,
  type BookmarkItemView,
  type EvidenceItemView,
  type FindingItemView,
  type NoteItemView,
} from "./EvidencePanel";

const evidence: EvidenceItemView = {
  id: "ev-1",
  title: "Checkout timeout cluster",
  eventRefs: [
    {
      corpusId: "c1",
      seq: 4,
      source: "api/app.jsonl",
      timestampHint: 1_700_000_004,
      timeQualityHint: "wall",
    },
    {
      corpusId: "c1",
      seq: 9,
      source: "worker/worker.log",
      timestampHint: 1_700_000_009,
      timeQualityHint: "wall",
    },
  ],
  evidenceStatus: "verified",
  createdAt: 1_700_000_100,
  provenanceLabel: "Saved manually",
};

const finding: FindingItemView = {
  id: "finding-1",
  kind: "inference",
  lifecycle: "accepted",
  title: "Retries amplify the database timeout",
  whyItMatters: "The retry storm increases queue pressure.",
  evidenceIds: [evidence.id],
  viewRecipe: null,
  provenanceLabel: "Authored manually",
};

const recipeFinding: FindingItemView = {
  ...finding,
  id: "finding-view-1",
  title: "Saved failure view",
  viewRecipe: {
    filters: {
      levels: ["error"],
      sources: [],
      services: [],
      hosts: [],
      timeFrom: null,
      timeTo: null,
      seqFrom: null,
      seqTo: null,
      templateId: null,
      traceId: null,
      keyword: null,
    },
    lanes: [{ id: "lane-0", label: "All sources", sources: [] }],
    visibleLaneCount: 1,
    linkMode: "independent",
    focusedLaneId: "lane-0",
    focusedEvent: null,
    selection: [],
    highlights: [],
    find: null,
    viewportAnchors: [],
  },
  policyStatus: "made_under_different_policy",
  policyStatusLabel: "Made under a different noise policy",
};

const note: NoteItemView = {
  id: "note-1",
  title: "Compare with deployment",
  body: "Check whether this started after the release window.",
  evidenceIds: [evidence.id],
  findingIds: [finding.id],
  provenanceLabel: "Authored manually",
};

const legacyBookmark: BookmarkItemView = {
  id: "bookmark-1",
  label: "Original triage marker",
  note: "Potential root cause",
  seqFrom: 4,
  seqTo: 9,
  eventRefs: [],
  evidenceStatus: "legacy_range",
};

function modeControl() {
  return (
    <InvestigationModeControl
      mode="investigation"
      investigationCount={1}
      chatCount={2}
      onChange={() => undefined}
    />
  );
}

describe("EvidencePanel", () => {
  it("presents durable evidence with compact counts and explicit actions", () => {
    const preview = vi.fn();
    const reveal = vi.fn();
    render(
      <EvidencePanel
        modeControl={modeControl()}
        items={[evidence]}
        preview={null}
        busy={false}
        error={null}
        onPreview={preview}
        onReveal={reveal}
        onClearPreview={() => undefined}
      />,
    );

    const card = screen.getByTestId("evidence-item-ev-1");
    expect(card.textContent).toContain("Checkout timeout cluster");
    expect(card.textContent).toContain("2 events · 2 sources");
    expect(card.textContent).toContain("Verified");
    fireEvent.click(within(card).getByRole("button", { name: "Preview" }));
    fireEvent.click(within(card).getByRole("button", { name: "Reveal" }));
    expect(preview).toHaveBeenCalledWith(evidence);
    expect(reveal).toHaveBeenCalledWith(evidence);
  });

  it("previews authoritative rows without making reveal available for stale identities", () => {
    const stale = { ...evidence, evidenceStatus: "stale" as const };
    render(
      <EvidencePanel
        modeControl={modeControl()}
        items={[stale]}
        preview={{
          evidenceId: stale.id,
          events: [
            {
              seq: 4,
              ts: 1_700_000_004,
              timeQuality: "wall",
              level: "error",
              service: "checkout",
              host: null,
              templateId: 7,
              traceId: "trace-4",
              message: "checkout timed out",
              source: "api/app.jsonl",
            },
          ],
          missingCount: 0,
          staleCount: 1,
        }}
        busy={false}
        error={null}
        onPreview={() => undefined}
        onReveal={() => undefined}
        onClearPreview={() => undefined}
      />,
    );

    const preview = screen.getByTestId("evidence-preview");
    expect(preview.textContent).toContain("current view unchanged");
    expect(preview.textContent).toContain("1 changed");
    expect(preview.textContent).toContain("checkout timed out");
    expect(
      (
        within(preview).getByRole("button", {
          name: "Reveal in Explorer",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("filters a unified investigation record and opens cited material details", async () => {
    const preview = vi.fn();
    const activateBookmark = vi.fn();
    render(
      <EvidencePanel
        modeControl={modeControl()}
        items={[evidence]}
        findings={[finding]}
        notes={[note]}
        bookmarks={[legacyBookmark]}
        preview={null}
        busy={false}
        error={null}
        onPreview={preview}
        onReveal={() => undefined}
        onActivateBookmark={activateBookmark}
        onClearPreview={() => undefined}
      />,
    );

    expect(
      (
        screen.getByLabelText(
          "Show investigation material",
        ) as HTMLSelectElement
      ).value,
    ).toBe("all");
    const findingCard = screen.getByTestId("finding-item-finding-1");
    fireEvent.click(findingCard);
    const detail = screen.getByTestId("finding-detail-finding-1");
    expect(detail.textContent).toContain("Inference · accepted");
    expect(detail.textContent).toContain(finding.whyItMatters);
    const detailBack = within(detail).getByRole("button", { name: "Back" });
    await vi.waitFor(() => expect(document.activeElement).toBe(detailBack));
    fireEvent.click(detailBack);
    const restoredFindingCard = screen.getByTestId(
      "finding-item-finding-1",
    );
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(restoredFindingCard),
    );
    fireEvent.click(restoredFindingCard);
    fireEvent.click(
      within(screen.getByTestId("finding-detail-finding-1")).getByRole(
        "button",
        { name: /Checkout timeout cluster/ },
      ),
    );
    expect(preview).toHaveBeenCalledWith(evidence);

    fireEvent.change(screen.getByLabelText("Show investigation material"), {
      target: { value: "notes" },
    });
    expect(screen.queryByTestId("finding-item-finding-1")).toBeNull();
    fireEvent.click(screen.getByTestId("note-item-note-1"));
    expect(screen.getByTestId("note-detail-note-1").textContent).toContain(
      note.body,
    );
    fireEvent.click(
      within(screen.getByTestId("note-detail-note-1")).getByRole("button", {
        name: "Back",
      }),
    );
    fireEvent.change(screen.getByLabelText("Show investigation material"), {
      target: { value: "bookmarks" },
    });
    fireEvent.click(screen.getByTestId("investigation-bookmark-bookmark-1"));
    const bookmarkDetail = screen.getByTestId("bookmark-detail-bookmark-1");
    expect(bookmarkDetail.textContent).toContain(
      "not imported as a trusted Investigation note",
    );
    fireEvent.click(
      within(bookmarkDetail).getByRole("button", {
        name: "Reveal bookmark",
      }),
    );
    expect(activateBookmark).toHaveBeenCalledWith(legacyBookmark);
  });

  it("explains an empty material filter instead of leaving a blank rail", () => {
    render(
      <EvidencePanel
        modeControl={modeControl()}
        items={[evidence]}
        preview={null}
        busy={false}
        error={null}
        onPreview={() => undefined}
        onReveal={() => undefined}
        onClearPreview={() => undefined}
      />,
    );

    fireEvent.change(screen.getByLabelText("Show investigation material"), {
      target: { value: "findings" },
    });
    expect(screen.getByText("No findings saved yet")).toBeTruthy();
    expect(screen.getByText(/Choose All material/)).toBeTruthy();
  });

  it("keeps the shared rail mode selector explicit and keyboard navigable", async () => {
    const change = vi.fn();
    render(
      <InvestigationModeControl
        mode="investigation"
        investigationCount={3}
        chatCount={2}
        onChange={change}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /Investigation workspace view: Investigation, 3 items/,
      }),
    );
    const investigationOption = screen.getByRole("menuitemradio", {
      name: /Investigation.*3/,
    });
    const chatOption = screen.getByRole("menuitemradio", { name: /Chat.*2/ });
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(investigationOption),
    );
    fireEvent.keyDown(investigationOption, { key: "ArrowDown" });
    expect(document.activeElement).toBe(chatOption);
    fireEvent.click(chatOption);
    expect(change).toHaveBeenCalledWith("chat");
  });

  it("restores the mode trigger after blank-space dismissal", async () => {
    render(
      <div>
        <InvestigationModeControl
          mode="investigation"
          investigationCount={3}
          chatCount={2}
          onChange={() => undefined}
        />
        <div data-testid="outside-blank">Outside blank space</div>
      </div>,
    );

    const trigger = screen.getByRole("button", {
      name: /Investigation workspace view: Investigation, 3 items/,
    });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Investigation view" })).toBeTruthy();
    fireEvent.pointerDown(screen.getByTestId("outside-blank"));
    await vi.waitFor(() =>
      expect(
        screen.queryByRole("menu", { name: "Investigation view" }),
      ).toBeNull(),
    );
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("collapses to a compact Investigation rail and restores focus both ways", async () => {
    const toggle = vi.fn();
    const view = render(
      <EvidencePanel
        modeControl={modeControl()}
        items={[evidence]}
        preview={null}
        busy={false}
        error={null}
        collapsed={false}
        onPreview={() => undefined}
        onReveal={() => undefined}
        onClearPreview={() => undefined}
        onToggleCollapsed={toggle}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Investigation rail" }),
    );
    expect(toggle).toHaveBeenCalledTimes(1);
    view.rerender(
      <EvidencePanel
        modeControl={modeControl()}
        items={[evidence]}
        preview={null}
        busy={false}
        error={null}
        collapsed
        onPreview={() => undefined}
        onReveal={() => undefined}
        onClearPreview={() => undefined}
        onToggleCollapsed={toggle}
      />,
    );
    const reopen = screen.getByRole("button", {
      name: "Expand Investigation rail, 1 saved item",
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(reopen));

    view.rerender(
      <EvidencePanel
        modeControl={modeControl()}
        items={[evidence]}
        preview={null}
        busy={false}
        error={null}
        collapsed={false}
        onPreview={() => undefined}
        onReveal={() => undefined}
        onClearPreview={() => undefined}
        onToggleCollapsed={toggle}
      />,
    );
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", {
          name: "Collapse Investigation rail",
        }),
      ),
    );
  });

  it("shows Made under a different noise policy, blocks Apply, and offers recompute (#819)", () => {
    const apply = vi.fn();
    const recompute = vi.fn();
    const clearPreview = vi.fn();
    render(
      <EvidencePanel
        modeControl={modeControl()}
        items={[evidence]}
        findings={[recipeFinding]}
        preview={null}
        viewPreview={{
          findingId: recipeFinding.id,
          recipe: recipeFinding.viewRecipe!,
          changes: ["Filters: All logs → levels error"],
          missingCount: 0,
          staleCount: 0,
          policyStatus: "made_under_different_policy",
          policyStatusLabel: "Made under a different noise policy",
          policyBlocksApply: true,
        }}
        busy={false}
        error={null}
        onPreview={() => undefined}
        onReveal={() => undefined}
        onPreviewFindingView={() => undefined}
        onApplyFindingView={apply}
        onRecomputeFindingView={recompute}
        onClearPreview={() => undefined}
        onClearViewPreview={clearPreview}
      />,
    );

    fireEvent.click(screen.getByTestId(`finding-item-${recipeFinding.id}`));
    expect(
      screen.getByTestId(`finding-policy-${recipeFinding.id}`).textContent,
    ).toBe("Made under a different noise policy");
    const viewPreview = screen.getByTestId(
      `finding-view-preview-${recipeFinding.id}`,
    );
    expect(viewPreview.textContent).toContain(
      "Made under a different noise policy",
    );
    expect(viewPreview.textContent).toMatch(/Apply blocked/);
    const applyBtn = within(viewPreview).getByRole("button", {
      name: "Apply saved view",
    }) as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(true);
    fireEvent.click(applyBtn);
    expect(apply).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByTestId(`finding-recompute-${recipeFinding.id}`),
    );
    expect(recompute).toHaveBeenCalledWith(recipeFinding);
  });
});

function railReportPreview(): LogInvestigationReportPreviewDto {
  return {
    report: {
      schemaVersion: 1,
      investigationId: "inv-1",
      title: "Checkout latency regression",
      status: "active",
      sourceRevision: 4,
      generatedAt: 1_700_000_400,
      currentPolicy: null,
      scope: {
        corpusIds: ["c1"],
        evidenceCount: 1,
        findingCount: 1,
        noteCount: 0,
        timeWindow: null,
      },
      sections: {
        executiveSummary: null,
        unresolvedQuestions: null,
        nextActions: null,
      },
      findings: [
        {
          findingId: "finding-1",
          kind: "inference",
          lifecycle: "accepted",
          title: "Retries amplify the database timeout",
          whyItMatters: "The retry storm increases queue pressure.",
          policyBindingStatus: "current",
          hasSavedView: false,
          citations: [
            {
              evidenceId: "ev-1",
              evidenceTitle: "Checkout timeout cluster",
              references: [
                {
                  corpusId: "c1",
                  seq: 4,
                  source: "api/app.jsonl",
                  timestampHint: 1_700_000_004,
                  timeQualityHint: "wall",
                  status: "verified",
                },
              ],
            },
          ],
          createdAt: 1_700_000_100,
        },
      ],
      timeline: { entries: [], omittedCount: 0 },
    },
    markdown: "# report\n",
    exportId: "rep-rail-1",
    exportBytes: 16,
    exportUnavailableReason: null,
  };
}

const proposedReportSection: ProposedReportSectionView = {
  id: "prop-report-1",
  kind: "executive_summary",
  body: "Checkout failed because retries amplified a database timeout.",
  status: "proposed",
  evidenceIdCount: 1,
  findingIdCount: 0,
  noteIdCount: 0,
  provenanceLabel: "Agent proposed",
};

describe("EvidencePanel report integration (#532)", () => {
  it("opens the Report detail exclusively and restores focus to the entry point", async () => {
    const openReport = vi.fn();
    render(
      <EvidencePanel
        modeControl={modeControl()}
        items={[evidence]}
        findings={[finding]}
        preview={null}
        reportPreview={railReportPreview()}
        busy={false}
        error={null}
        onPreview={() => undefined}
        onReveal={() => undefined}
        onOpenReport={openReport}
        onClearPreview={() => undefined}
      />,
    );

    // Single-detail exclusivity: a finding detail yields to the report.
    fireEvent.click(screen.getByTestId("finding-item-finding-1"));
    expect(screen.getByTestId("finding-detail-finding-1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("open-report"));
    expect(openReport).toHaveBeenCalledTimes(1);
    const detail = screen.getByTestId("report-detail");
    expect(screen.queryByTestId("finding-detail-finding-1")).toBeNull();
    expect(screen.queryByLabelText("Show investigation material")).toBeNull();
    expect(
      within(detail).getByTestId("investigation-report").textContent,
    ).toContain("Checkout latency regression");

    const back = within(detail).getByRole("button", { name: "Back" });
    await vi.waitFor(() => expect(document.activeElement).toBe(back));
    fireEvent.click(back);
    expect(screen.queryByTestId("report-detail")).toBeNull();
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("open-report")),
    );
  });

  it("keeps the Report entry visible but disabled with cause when unavailable", () => {
    const openReport = vi.fn();
    render(
      <EvidencePanel
        modeControl={modeControl()}
        items={[]}
        preview={null}
        busy={false}
        error={null}
        onPreview={() => undefined}
        onReveal={() => undefined}
        onOpenReport={openReport}
        reportUnavailableReason="No investigation yet — save evidence from selected rows first"
        onClearPreview={() => undefined}
      />,
    );

    const button = screen.getByTestId("open-report") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("No investigation yet");
    fireEvent.click(button);
    expect(openReport).not.toHaveBeenCalled();
  });

  it("routes report citation chips through onPreview and returns to the report on Back", async () => {
    const onPreview = vi.fn();
    const clearPreview = vi.fn();
    const view = render(
      <EvidencePanel
        modeControl={modeControl()}
        items={[evidence]}
        preview={null}
        reportPreview={railReportPreview()}
        busy={false}
        error={null}
        onPreview={onPreview}
        onReveal={() => undefined}
        onOpenReport={() => undefined}
        onClearPreview={clearPreview}
      />,
    );

    fireEvent.click(screen.getByTestId("open-report"));
    fireEvent.click(screen.getByTestId("report-citation-finding-1-ev-1"));
    expect(onPreview).toHaveBeenCalledWith(evidence);
    expect(screen.queryByTestId("report-detail")).toBeNull();

    // The container answers onPreview by supplying the bounded preview.
    view.rerender(
      <EvidencePanel
        modeControl={modeControl()}
        items={[evidence]}
        preview={{
          evidenceId: evidence.id,
          events: [],
          missingCount: 0,
          staleCount: 0,
        }}
        reportPreview={railReportPreview()}
        busy={false}
        error={null}
        onPreview={onPreview}
        onReveal={() => undefined}
        onOpenReport={() => undefined}
        onClearPreview={clearPreview}
      />,
    );
    const preview = screen.getByTestId("evidence-preview");
    fireEvent.click(within(preview).getByRole("button", { name: "Back" }));
    expect(clearPreview).toHaveBeenCalled();
    view.rerender(
      <EvidencePanel
        modeControl={modeControl()}
        items={[evidence]}
        preview={null}
        reportPreview={railReportPreview()}
        busy={false}
        error={null}
        onPreview={onPreview}
        onReveal={() => undefined}
        onOpenReport={() => undefined}
        onClearPreview={clearPreview}
      />,
    );
    expect(screen.getByTestId("report-detail")).toBeTruthy();
  });

  it("reviews proposed report sections in the rail with a required dismiss reason", () => {
    const accept = vi.fn();
    const dismiss = vi.fn();
    render(
      <EvidencePanel
        modeControl={modeControl()}
        items={[]}
        proposedReportSections={[proposedReportSection]}
        preview={null}
        busy={false}
        error={null}
        onPreview={() => undefined}
        onReveal={() => undefined}
        onAcceptProposedReportSection={accept}
        onDismissProposedReportSection={dismiss}
        onClearPreview={() => undefined}
      />,
    );

    // Open proposals keep the rail non-empty and count into the filter.
    const filter = screen.getByLabelText(
      "Show investigation material",
    ) as HTMLSelectElement;
    expect(screen.getByTestId("proposed-report-prop-report-1")).toBeTruthy();
    fireEvent.change(filter, { target: { value: "report" } });
    expect(screen.getByTestId("proposed-report-prop-report-1")).toBeTruthy();
    fireEvent.change(filter, { target: { value: "notes" } });
    expect(screen.queryByTestId("proposed-report-prop-report-1")).toBeNull();
    fireEvent.change(filter, { target: { value: "all" } });

    fireEvent.click(screen.getByTestId("accept-proposed-report-prop-report-1"));
    expect(accept).toHaveBeenCalledWith({ proposalId: "prop-report-1" });

    fireEvent.click(
      screen.getByTestId("dismiss-proposed-report-prop-report-1"),
    );
    const confirm = screen.getByTestId(
      "confirm-dismiss-proposed-report-prop-report-1",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(
      screen.getByTestId("dismiss-reason-proposed-report-prop-report-1"),
      { target: { value: "Not supported by the evidence" } },
    );
    fireEvent.click(confirm);
    expect(dismiss).toHaveBeenCalledWith(
      "prop-report-1",
      "Not supported by the evidence",
    );
  });

  it("offers Reload inside the error alert for stale-revision recovery", () => {
    const reload = vi.fn();
    render(
      <EvidencePanel
        modeControl={modeControl()}
        items={[evidence]}
        preview={null}
        busy={false}
        error="stale_revision: expected 4, found 6"
        onPreview={() => undefined}
        onReveal={() => undefined}
        onReloadInvestigation={reload}
        onClearPreview={() => undefined}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("stale_revision");
    fireEvent.click(within(alert).getByTestId("reload-investigation"));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
