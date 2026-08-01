import { createRef } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as engine from "../../lib/engine/investigationReports";
import {
  InvestigationReportExportDialog,
  InvestigationReportSurface,
  ProposedReportSectionCard,
  ReportSectionEditorDialog,
  type ProposedReportSectionView,
} from "./InvestigationReport";

const engineCalls: string[] = [];

vi.mock("../../lib/engine/investigationReports", () => ({
  logSaveInvestigationReportExport: vi.fn(),
  logReleaseInvestigationReportExport: vi.fn(),
}));

const saveMock = vi.mocked(engine.logSaveInvestigationReportExport);
const releaseMock = vi.mocked(engine.logReleaseInvestigationReportExport);

const EXACT_MARKDOWN =
  "# Investigation report\n\n[verified] exact host-rendered bytes\n";

function reportPreviewFixture(): engine.LogInvestigationReportPreviewDto {
  return {
    report: {
      schemaVersion: 1,
      investigationId: "inv-1",
      title: "Checkout latency regression",
      status: "active",
      sourceRevision: 9,
      generatedAt: 1_700_000_400,
      currentPolicy: {
        suppressionPolicyRevision: 7,
        resolvedTemplateRevision: 11,
        effectivePolicySha256: "abc123",
        noiseLens: "active",
      },
      scope: {
        corpusIds: ["corpus-1234abcd"],
        evidenceCount: 2,
        findingCount: 2,
        noteCount: 1,
        timeWindow: {
          minTimestampHint: 1_700_000_004,
          maxTimestampHint: 1_700_000_009,
          mixedQuality: true,
        },
      },
      sections: {
        executiveSummary: {
          sectionId: "sec-1",
          body: "Retries amplified a database timeout into checkout failure.",
          evidenceIds: ["ev-1"],
          findingIds: [],
          noteIds: [],
          acceptedFromProposalId: "prop-9",
          acceptedProposalProvenance: {
            source: "model",
            provider: "openai_compatible",
            modelId: "incident-model",
            runId: "run-9",
            toolName: "propose_report_section",
          },
          acceptedProposalAcceptance: {
            acceptedAt: 1_700_000_250,
            edited: true,
          },
          updatedAt: 1_700_000_300,
        },
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
          hasSavedView: true,
          citations: [
            {
              evidenceId: "ev-1",
              evidenceTitle: "Checkout timeout cluster",
              references: [
                {
                  corpusId: "corpus-1234abcd",
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
        {
          findingId: "finding-2",
          kind: "hypothesis",
          lifecycle: "accepted",
          title: "Connection pool exhaustion is the trigger",
          whyItMatters: "Pool metrics spike before the first timeout.",
          policyBindingStatus: "unbound_legacy",
          hasSavedView: false,
          citations: [
            {
              evidenceId: "ev-2",
              evidenceTitle: "Pool saturation window",
              references: [
                {
                  corpusId: "corpus-1234abcd",
                  seq: 9,
                  source: "worker/worker.log",
                  timestampHint: 1_700_000_009,
                  timeQualityHint: "wall",
                  status: "missing",
                },
              ],
            },
          ],
          createdAt: 1_700_000_120,
        },
      ],
      timeline: {
        entries: [
          {
            corpusId: "corpus-1234abcd",
            seq: 4,
            source: "api/app.jsonl",
            timestampHint: 1_700_000_004,
            timeQualityHint: "wall",
            evidenceId: "ev-1",
            evidenceTitle: "Checkout timeout cluster",
            status: "verified",
          },
          {
            corpusId: "corpus-1234abcd",
            seq: 7,
            source: "api/app.jsonl",
            timestampHint: 1_700_000_007,
            timeQualityHint: "wall",
            evidenceId: "ev-1",
            evidenceTitle: "Checkout timeout cluster",
            status: "stale",
          },
          {
            corpusId: "corpus-1234abcd",
            seq: 9,
            source: "worker/worker.log",
            timestampHint: 1_700_000_009,
            timeQualityHint: "order_only",
            evidenceId: "ev-2",
            evidenceTitle: "Pool saturation window",
            status: "missing",
          },
        ],
        omittedCount: 3,
      },
    },
    markdown: EXACT_MARKDOWN,
    exportId: "rep-1",
    exportBytes: EXACT_MARKDOWN.length,
    exportUnavailableReason: null,
  };
}

const proposedSection: ProposedReportSectionView = {
  id: "prop-report-1",
  kind: "next_actions",
  body: "Roll back the retry policy and re-run the load test.",
  status: "proposed",
  evidenceIdCount: 1,
  findingIdCount: 1,
  noteIdCount: 0,
  provenanceLabel: "Agent proposed",
};

beforeEach(() => {
  engineCalls.length = 0;
  saveMock.mockReset().mockImplementation(async () => {
    engineCalls.push("save");
    return { status: "saved" as const };
  });
  releaseMock.mockReset().mockImplementation(async () => {
    engineCalls.push("release");
    return true;
  });
});

describe("InvestigationReportSurface", () => {
  it("renders all seven sections in fixed order from the typed projection", () => {
    render(
      <InvestigationReportSurface
        preview={reportPreviewFixture()}
        busy={false}
        error={null}
      />,
    );

    const surface = screen.getByTestId("investigation-report");
    const labels = [
      ...surface.querySelectorAll(".investigation-report__section-label"),
    ].map((node) => node.textContent);
    expect(labels).toEqual([
      "1 · Incident scope & window",
      "2 · Executive summary",
      "3 · Accepted findings",
      "4 · Evidence-backed timeline",
      "5 · Hypotheses & alternatives",
      "6 · Unresolved questions",
      "7 · Next actions",
    ]);

    // Header: title, status, source revision, corpora, generated-at, policy.
    expect(surface.textContent).toContain("Checkout latency regression");
    expect(surface.textContent).toContain("active · revision 9");
    expect(surface.textContent).toContain("Corpus corpus-1");
    expect(
      screen.getByTestId("report-current-policy").textContent,
    ).toContain("suppression rev 7 · template rev 11");

    // Scope facts + honest mixed-quality time window: raw hints with the
    // mixed label, never fabricated calendar instants (blocker 4).
    const scope = screen.getByTestId("report-section-scope");
    expect(scope.textContent).toContain("2 evidence items");
    expect(scope.textContent).toContain(
      "hints 1700000004 → 1700000009 · mixed time quality — ordering hints, not calendar time",
    );
    expect(scope.textContent).not.toContain("2023-11-14T22:13:24Z");
    expect(scope.textContent).not.toContain("Z →");

    // The cross-quality timeline carries the bounded-ordering caveat, and the
    // order-only entry is a position, not an instant.
    const mixedTimeline = screen.getByTestId("report-section-timeline");
    expect(mixedTimeline.textContent).toContain("order-only · seq 9");
    expect(mixedTimeline.textContent).not.toContain("2023-11-14T22:13:29Z");
    expect(
      screen.getByTestId("report-timeline-mixed-caveat").textContent,
    ).toContain("cross-quality order is by stored hint, not established time");

    // Findings split: hypotheses never sit in section 3.
    const findings = screen.getByTestId("report-section-findings");
    expect(
      within(findings).getByTestId("report-finding-finding-1").textContent,
    ).toContain("inference · accepted");
    expect(
      within(findings).queryByTestId("report-finding-finding-2"),
    ).toBeNull();
    const hypotheses = screen.getByTestId("report-section-hypotheses");
    expect(
      within(hypotheses).getByTestId("report-finding-finding-2").textContent,
    ).toContain("hypothesis");

    // Policy binding + saved-view truth are stated per entry.
    expect(
      within(findings).getByTestId("report-finding-finding-1").textContent,
    ).toContain("Current noise policy");
    expect(
      within(findings).getByTestId("report-finding-finding-1").textContent,
    ).toContain("Saved view attached: yes");

    // Timeline: identity-only entries, explicit text markers, bounded render.
    const timeline = screen.getByTestId("report-section-timeline");
    expect(timeline.textContent).toContain("[verified]");
    expect(timeline.textContent).toContain("[stale]");
    expect(timeline.textContent).toContain("[missing]");
    expect(timeline.textContent).toContain("order-only · seq 9");
    expect(
      screen.getByTestId("report-timeline-omitted").textContent,
    ).toContain("3 omitted (bounded render)");
  });

  it("distinguishes authored sections from explicit Not authored placeholders", () => {
    const onEditSection = vi.fn();
    render(
      <InvestigationReportSurface
        preview={reportPreviewFixture()}
        busy={false}
        error={null}
        onEditSection={onEditSection}
      />,
    );

    const summary = screen.getByTestId("report-authored-executive_summary");
    expect(summary.textContent).toContain(
      "Retries amplified a database timeout",
    );
    expect(summary.textContent).toContain(
      "accepted from model proposal · openai_compatible · incident-model",
    );
    expect(summary.textContent).toContain("edited during acceptance");
    expect(
      within(summary).getByRole("button", { name: "Edit section" }),
    ).toBeTruthy();

    expect(
      screen.getByTestId("report-not-authored-unresolved_questions")
        .textContent,
    ).toBe("Not authored.");
    const nextActions = screen.getByTestId("report-authored-next_actions");
    expect(nextActions.textContent).toContain("Not authored.");
    fireEvent.click(
      within(nextActions).getByRole("button", { name: "Write section" }),
    );
    expect(onEditSection).toHaveBeenCalledWith(
      "next_actions",
      expect.any(HTMLButtonElement),
    );
  });

  it("navigates citation chips through onPreviewEvidence", () => {
    const onPreviewEvidence = vi.fn();
    render(
      <InvestigationReportSurface
        preview={reportPreviewFixture()}
        busy={false}
        error={null}
        onPreviewEvidence={onPreviewEvidence}
      />,
    );

    fireEvent.click(screen.getByTestId("report-citation-finding-1-ev-1"));
    expect(onPreviewEvidence).toHaveBeenCalledWith("ev-1");
  });

  it("shows the exact export markdown behind the Exact export preview toggle", () => {
    render(
      <InvestigationReportSurface
        preview={reportPreviewFixture()}
        busy={false}
        error={null}
      />,
    );

    expect(screen.queryByTestId("report-markdown-preview")).toBeNull();
    fireEvent.click(screen.getByTestId("report-markdown-toggle"));
    expect(screen.getByTestId("report-markdown-preview").textContent).toBe(
      EXACT_MARKDOWN,
    );
    fireEvent.click(screen.getByTestId("report-markdown-toggle"));
    expect(screen.queryByTestId("report-markdown-preview")).toBeNull();
  });

  it("surfaces assembly errors as an alert instead of an empty document", () => {
    render(
      <InvestigationReportSurface
        preview={null}
        busy={false}
        error="stale_revision: expected 4"
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "stale_revision: expected 4",
    );
  });
});

describe("ProposedReportSectionCard", () => {
  it("accepts as proposed, previews without mutating, and asserts the edited payload", () => {
    const onAccept = vi.fn();
    render(
      <ProposedReportSectionCard
        item={proposedSection}
        busy={false}
        onAccept={onAccept}
        onDismiss={() => undefined}
      />,
    );

    const card = screen.getByTestId("proposed-report-prop-report-1");
    expect(card.textContent).toContain("Next actions");
    expect(card.textContent).toContain("1 evidence · 1 finding · 0 note");

    fireEvent.click(screen.getByTestId("preview-proposed-report-prop-report-1"));
    const preview = screen.getByTestId(
      "proposed-report-preview-prop-report-1",
    );
    expect(preview.textContent).toContain("not accepted");
    expect(preview.textContent).toContain("Roll back the retry policy");
    fireEvent.click(
      within(preview).getByRole("button", { name: "Dismiss preview" }),
    );

    fireEvent.click(screen.getByTestId("accept-proposed-report-prop-report-1"));
    expect(onAccept).toHaveBeenCalledWith({ proposalId: "prop-report-1" });

    fireEvent.click(
      screen.getByTestId("edit-accept-proposed-report-prop-report-1"),
    );
    fireEvent.change(
      screen.getByTestId("proposed-report-edit-body-prop-report-1"),
      { target: { value: "  Tighter rollback plan.  " } },
    );
    fireEvent.click(
      screen.getByTestId("confirm-edit-accept-report-prop-report-1"),
    );
    expect(onAccept).toHaveBeenCalledWith({
      proposalId: "prop-report-1",
      body: "Tighter rollback plan.",
    });
  });

  it("requires a dismiss reason before the inline dismissal can confirm", () => {
    const onDismiss = vi.fn();
    render(
      <ProposedReportSectionCard
        item={proposedSection}
        busy={false}
        onAccept={() => undefined}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(screen.getByTestId("dismiss-proposed-report-prop-report-1"));
    const confirm = screen.getByTestId(
      "confirm-dismiss-proposed-report-prop-report-1",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.change(
      screen.getByTestId("dismiss-reason-proposed-report-prop-report-1"),
      { target: { value: "  Wrong incident scope  " } },
    );
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onDismiss).toHaveBeenCalledWith(
      "prop-report-1",
      "Wrong incident scope",
    );
  });
});

describe("ReportSectionEditorDialog", () => {
  it("traps Tab, saves the trimmed body, and refocuses the trigger on dismiss", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    const triggerRef = createRef<HTMLButtonElement>();
    (triggerRef as { current: HTMLButtonElement | null }).current = trigger;
    const onSave = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ReportSectionEditorDialog
        kind="unresolved_questions"
        initialBody={null}
        busy={false}
        triggerRef={triggerRef}
        onSave={onSave}
        onDismiss={onDismiss}
      />,
    );

    const body = screen.getByTestId(
      "report-section-body",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(document.activeElement).toBe(body));

    // Save is disabled until the body is non-empty.
    const save = screen.getByTestId("report-section-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(body, { target: { value: "  Why did p99 recover?  " } });
    expect(save.disabled).toBe(false);

    // Tab wraps from the last focusable back to the first.
    save.focus();
    fireEvent.keyDown(save, { key: "Tab" });
    expect(document.activeElement).toBe(body);
    fireEvent.keyDown(body, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(save);

    fireEvent.submit(save.closest("form")!);
    expect(onSave).toHaveBeenCalledWith("Why did p99 recover?");

    fireEvent.keyDown(body, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    trigger.remove();
  });
});

describe("InvestigationReportExportDialog", () => {
  function renderDialog(
    onDismiss = vi.fn(),
    preview = reportPreviewFixture(),
  ) {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    const triggerRef = createRef<HTMLButtonElement>();
    (triggerRef as { current: HTMLButtonElement | null }).current = trigger;
    const view = render(
      <InvestigationReportExportDialog
        preview={preview}
        triggerRef={triggerRef}
        onDismiss={onDismiss}
      />,
    );
    return { view, trigger, onDismiss };
  }

  it("shows the retained exact bytes immediately and saves them by artifact id", async () => {
    const { view, trigger } = renderDialog();

    // One artifact: the bytes are the preview's own — no prepare round-trip,
    // nothing that could re-assemble and drift from what was reviewed.
    expect(screen.getByTestId("report-export-preview").textContent).toBe(
      EXACT_MARKDOWN,
    );
    expect(
      screen.getByText(new RegExp(`${EXACT_MARKDOWN.length} bytes`)),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("report-export-save"));
    await waitFor(() =>
      expect(screen.getByTestId("report-export-result").textContent).toBe(
        "Saved the exact previewed Markdown.",
      ),
    );
    expect(saveMock).toHaveBeenCalledWith("rep-1");

    // The artifact's lifetime belongs to the preview (container), not this
    // dialog: closing must NOT release it, or a later Export of the same
    // preview would break.
    view.unmount();
    expect(releaseMock).not.toHaveBeenCalled();
    expect(engineCalls).toEqual(["save"]);
    trigger.remove();
  });

  it("moves focus inside, wraps Tab, and restores the trigger on Escape", async () => {
    const { trigger, onDismiss } = renderDialog();
    const close = screen.getByTestId("report-export-close");
    const save = screen.getByTestId("report-export-save");
    const preview = screen.getByTestId("report-export-preview");
    expect(document.activeElement).toBe(close);

    save.focus();
    fireEvent.keyDown(save, { key: "Tab" });
    expect(document.activeElement).toBe(preview);
    fireEvent.keyDown(preview, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(save);

    fireEvent.keyDown(close, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    trigger.remove();
  });

  it("reports a cancelled native save truthfully — nothing was written", async () => {
    saveMock.mockImplementation(async () => {
      engineCalls.push("save");
      return { status: "cancelled" as const };
    });
    renderDialog();
    fireEvent.click(screen.getByTestId("report-export-save"));
    await waitFor(() =>
      expect(screen.getByTestId("report-export-result").textContent).toBe(
        "Save cancelled. No file was written.",
      ),
    );
  });

  it("reports SavedWithWarning without upgrading it to a clean save", async () => {
    saveMock.mockImplementation(async () => ({
      status: "saved_with_warning" as const,
      warning: "fsync unsupported on this volume",
    }));
    renderDialog();
    fireEvent.click(screen.getByTestId("report-export-save"));
    await waitFor(() =>
      expect(screen.getByTestId("report-export-result").textContent).toContain(
        "durability warning: fsync unsupported on this volume",
      ),
    );
  });

  it("surfaces a host save failure (for example an evicted artifact) verbatim", async () => {
    saveMock.mockRejectedValue(
      new Error(
        "investigation report preview expired; refresh the preview and try again",
      ),
    );
    renderDialog();
    fireEvent.click(screen.getByTestId("report-export-save"));
    await waitFor(() =>
      expect(screen.getByTestId("report-export-result").textContent).toContain(
        "preview expired",
      ),
    );
  });

  it("keeps Save disabled with the exact reason when the render was refused at the export boundary", () => {
    const preview = reportPreviewFixture();
    preview.exportId = null;
    preview.exportBytes = null;
    preview.exportUnavailableReason =
      "investigation report failed host privacy validation; nothing was written";
    renderDialog(vi.fn(), preview);

    expect(
      (screen.getByTestId("report-export-save") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain(
      "failed host privacy validation",
    );
    expect(saveMock).not.toHaveBeenCalled();
  });
});
