import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as engine from "../../lib/engine/investigationReports";
import { InvestigationsPane } from "./InvestigationsPane";

vi.mock("../../lib/engine/investigationReports", () => ({
  investigationHostAvailable: vi.fn(),
  listLogCorpora: vi.fn(),
  logLoadActiveInvestigation: vi.fn(),
  logAssembleInvestigationReport: vi.fn(),
  logAcceptProposedReportSection: vi.fn(),
  logDismissProposedReportSection: vi.fn(),
  logSetInvestigationReportSection: vi.fn(),
  logPreviewInvestigationEvidence: vi.fn(),
  logSaveInvestigationReportExport: vi.fn(),
  logReleaseInvestigationReportExport: vi.fn(async () => true),
}));

const hostAvailableMock = vi.mocked(engine.investigationHostAvailable);
const listCorporaMock = vi.mocked(engine.listLogCorpora);
const loadInvestigationMock = vi.mocked(engine.logLoadActiveInvestigation);
const assembleMock = vi.mocked(engine.logAssembleInvestigationReport);
const acceptMock = vi.mocked(engine.logAcceptProposedReportSection);
const dismissMock = vi.mocked(engine.logDismissProposedReportSection);
const setSectionMock = vi.mocked(engine.logSetInvestigationReportSection);
const previewEvidenceMock = vi.mocked(engine.logPreviewInvestigationEvidence);

function corpus(id = "c1"): engine.LogCorpusSummaryDto {
  return {
    id,
    name: `checkout-incident-${id}`,
    eventCount: 1200,
    templateCount: 40,
    engine: "drain",
    createdAt: 1_700_000_000,
    sourceLabel: null,
    stats: null,
    topTemplates: [],
  };
}

function resolvedInvestigation(
  corpusId = "c1",
): engine.ResolvedInvestigationDocumentDto {
  return {
    document: {
      schemaVersion: 6,
      id: "inv-1",
      revision: 4,
      title: "Checkout latency regression",
      status: "active",
      corpusLinks: [{ corpusId }],
      evidence: [
        {
          id: "ev-1",
          title: "Checkout timeout cluster",
          provenance: "human",
          corpusId,
          eventRefs: [
            {
              corpusId,
              seq: 4,
              source: "api/app.jsonl",
              timestampHint: 1_700_000_004,
              timeQualityHint: "wall",
            },
          ],
          createdAt: 1_700_000_100,
          updatedAt: 1_700_000_100,
        },
      ],
      findings: [],
      notes: [],
      proposedFindings: [],
      reportSections: [],
      proposedReportSections: [
        {
          id: "prop-report-1",
          status: "proposed",
          kind: "executive_summary",
          body: "Retries amplified a database timeout into checkout failure.",
          evidenceIds: ["ev-1"],
          findingIds: [],
          noteIds: [],
          corpusId,
          investigationId: "inv-1",
          provenance: {
            source: "model",
            toolName: "propose_report_section",
          },
          idempotencyKey: "idem-1",
          createdAt: 1_700_000_200,
          updatedAt: 1_700_000_200,
        },
      ],
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_200,
    },
    evidence: [],
    findings: [],
  };
}

function assembled(): engine.LogInvestigationReportPreviewDto {
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
          kind: "observation",
          lifecycle: "accepted",
          title: "Timeouts cluster on one worker",
          whyItMatters: "Points at a single saturated dependency.",
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
    exportId: "rep-pane-1",
    exportBytes: 9,
    exportUnavailableReason: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function renderWithInvestigation() {
  render(<InvestigationsPane />);
  fireEvent.click(await screen.findByTestId("investigations-corpus-c1"));
  await screen.findByTestId("investigations-summary");
}

beforeEach(() => {
  vi.clearAllMocks();
  hostAvailableMock.mockReturnValue(true);
  listCorporaMock.mockResolvedValue([corpus()]);
  loadInvestigationMock.mockResolvedValue(resolvedInvestigation());
  assembleMock.mockResolvedValue(assembled());
  acceptMock.mockResolvedValue(resolvedInvestigation());
  dismissMock.mockResolvedValue(resolvedInvestigation());
  setSectionMock.mockResolvedValue(resolvedInvestigation());
});

describe("InvestigationsPane", () => {
  it("states that the desktop app is required instead of misreading browser stubs", () => {
    hostAvailableMock.mockReturnValue(false);
    render(<InvestigationsPane />);
    const note = screen.getByTestId("investigations-no-host");
    expect(within(note).getByRole("status").textContent).toContain(
      "require the desktop app",
    );
    expect(screen.queryByTestId("investigations-no-corpora")).toBeNull();
  });

  it("explains an empty corpus library and points at the Logs pane", async () => {
    listCorporaMock.mockResolvedValue([]);
    render(<InvestigationsPane />);
    const empty = await screen.findByTestId("investigations-no-corpora");
    expect(empty.textContent).toContain("No log corpora yet");
    expect(empty.textContent).toContain("Logs pane");
  });

  it("surfaces a corpora listing failure as an alert", async () => {
    listCorporaMock.mockRejectedValue(new Error("host offline"));
    render(<InvestigationsPane />);
    const alert = await screen.findByTestId("investigations-corpora-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("host offline");
  });

  it("explains how an investigation gets created instead of fabricating one", async () => {
    loadInvestigationMock.mockResolvedValue(null);
    render(<InvestigationsPane />);
    fireEvent.click(await screen.findByTestId("investigations-corpus-c1"));
    const guidance = await screen.findByTestId(
      "investigations-no-investigation",
    );
    expect(guidance.textContent).toContain("No investigation");
    expect(guidance.textContent).toContain("save evidence");
    expect(assembleMock).not.toHaveBeenCalled();
  });

  it("surfaces an investigation load failure as an alert with Reload", async () => {
    loadInvestigationMock.mockRejectedValueOnce(new Error("corpus locked"));
    render(<InvestigationsPane />);
    fireEvent.click(await screen.findByTestId("investigations-corpus-c1"));
    const alert = await screen.findByTestId("investigations-load-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("corpus locked");

    loadInvestigationMock.mockResolvedValueOnce(resolvedInvestigation());
    fireEvent.click(screen.getByTestId("investigations-reload"));
    await screen.findByTestId("investigations-summary");
    expect(loadInvestigationMock).toHaveBeenCalledTimes(2);
  });

  it("loads lazily, then renders summary counts, the report surface, and review cards", async () => {
    await renderWithInvestigation();

    expect(loadInvestigationMock).toHaveBeenCalledWith("c1", "active");
    await waitFor(() =>
      expect(assembleMock).toHaveBeenCalledWith("c1", "inv-1", "active"),
    );
    expect(
      screen.getByTestId("investigations-summary").textContent,
    ).toContain(
      "1 evidence · 0 findings · 0 notes · 0 authored sections · 1 proposed sections · revision 4",
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("investigation-report").textContent,
      ).toContain("Checkout latency regression"),
    );
    expect(screen.getByTestId("proposed-report-prop-report-1")).toBeTruthy();
  });

  it("accepts a proposed section at the loaded revision and reassembles the report", async () => {
    await renderWithInvestigation();
    await waitFor(() => expect(assembleMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId("accept-proposed-report-prop-report-1"));
    await waitFor(() =>
      expect(acceptMock).toHaveBeenCalledWith("c1", "inv-1", {
        proposalId: "prop-report-1",
        expectedRevision: 4,
        body: null,
      }),
    );
    await waitFor(() => expect(assembleMock).toHaveBeenCalledTimes(2));
    await act(async () => Promise.resolve());
    expect(assembleMock).toHaveBeenCalledTimes(2);
    expect(
      (await screen.findByTestId("investigations-status")).textContent,
    ).toContain("Accepted proposed report section.");
  });

  it("releases the prior export artifact when the preview is replaced", async () => {
    const releaseMock = vi.mocked(engine.logReleaseInvestigationReportExport);
    const replacement = assembled();
    replacement.exportId = "rep-pane-2";
    assembleMock
      .mockResolvedValueOnce(assembled())
      .mockResolvedValueOnce(replacement);
    await renderWithInvestigation();
    await waitFor(() => expect(assembleMock).toHaveBeenCalledTimes(1));

    // Accept re-assembles; adopting the replacement artifact must release
    // the prior one so the bounded host store never accumulates stale copies.
    fireEvent.click(screen.getByTestId("accept-proposed-report-prop-report-1"));
    await waitFor(() => expect(assembleMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(releaseMock).toHaveBeenCalledWith("rep-pane-1"));
  });

  it("releases every ignored retained artifact before it can consume the bounded host capacity", async () => {
    const releases = vi.mocked(engine.logReleaseInvestigationReportExport);
    const pending = Array.from({ length: 10 }, () =>
      deferred<engine.LogInvestigationReportPreviewDto>(),
    );
    let assemblyIndex = 0;
    listCorporaMock.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => corpus(`c${index}`)),
    );
    loadInvestigationMock.mockImplementation(async (corpusId) =>
      resolvedInvestigation(corpusId),
    );
    assembleMock.mockImplementation(() => pending[assemblyIndex++]!.promise);

    const view = render(<InvestigationsPane />);
    for (let index = 0; index < pending.length; index += 1) {
      fireEvent.click(
        await screen.findByTestId(`investigations-corpus-c${index}`),
      );
      await waitFor(() =>
        expect(assembleMock).toHaveBeenCalledTimes(index + 1),
      );
    }

    await act(async () => {
      pending.forEach((entry, index) => {
        const preview = assembled();
        preview.exportId = `ignored-${index}`;
        entry.resolve(preview);
      });
      await Promise.all(pending.map((entry) => entry.promise));
    });
    await waitFor(() => expect(releases).toHaveBeenCalledTimes(9));
    for (let index = 0; index < 9; index += 1) {
      expect(releases).toHaveBeenCalledWith(`ignored-${index}`);
    }
    expect(releases).not.toHaveBeenCalledWith("ignored-9");

    view.unmount();
    await waitFor(() => expect(releases).toHaveBeenCalledWith("ignored-9"));
  });

  it("invalidates unmount-time assembly and releases its late artifact", async () => {
    const releases = vi.mocked(engine.logReleaseInvestigationReportExport);
    const pending = deferred<engine.LogInvestigationReportPreviewDto>();
    assembleMock.mockReturnValueOnce(pending.promise);
    const view = render(<InvestigationsPane />);
    fireEvent.click(await screen.findByTestId("investigations-corpus-c1"));
    await waitFor(() => expect(assembleMock).toHaveBeenCalledTimes(1));
    view.unmount();

    const late = assembled();
    late.exportId = "late-after-unmount";
    await act(async () => {
      pending.resolve(late);
      await pending.promise;
    });
    await waitFor(() =>
      expect(releases).toHaveBeenCalledWith("late-after-unmount"),
    );
  });

  it("dismisses only with a reason and sends it with the pinned revision", async () => {
    await renderWithInvestigation();

    fireEvent.click(
      screen.getByTestId("dismiss-proposed-report-prop-report-1"),
    );
    const confirm = screen.getByTestId(
      "confirm-dismiss-proposed-report-prop-report-1",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(
      screen.getByTestId("dismiss-reason-proposed-report-prop-report-1"),
      { target: { value: "Wrong scope" } },
    );
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(dismissMock).toHaveBeenCalledWith("c1", "inv-1", {
        proposalId: "prop-report-1",
        expectedRevision: 4,
        reason: "Wrong scope",
      }),
    );
  });

  it("surfaces a stale-revision mutation failure as an alert with Reload", async () => {
    acceptMock.mockRejectedValue(
      new Error("stale_revision: expected 4, found 6"),
    );
    await renderWithInvestigation();

    fireEvent.click(screen.getByTestId("accept-proposed-report-prop-report-1"));
    const alert = await screen.findByTestId("investigations-mutation-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("stale_revision");

    fireEvent.click(screen.getByTestId("investigations-mutation-reload"));
    await waitFor(() =>
      expect(loadInvestigationMock).toHaveBeenCalledTimes(2),
    );
  });

  it("edits an authored section through the modal with the payload pinned to the revision", async () => {
    await renderWithInvestigation();
    await waitFor(() =>
      expect(
        screen.getByTestId("report-edit-section-unresolved_questions"),
      ).toBeTruthy(),
    );

    const trigger = screen.getByTestId(
      "report-edit-section-unresolved_questions",
    );
    fireEvent.click(trigger);
    const body = (await screen.findByTestId(
      "report-section-body",
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(document.activeElement).toBe(body));
    fireEvent.change(body, {
      target: { value: "Why did p99 recover before the fix shipped?" },
    });
    fireEvent.submit(body.closest("form")!);
    await waitFor(() =>
      expect(setSectionMock).toHaveBeenCalledWith("c1", "inv-1", 4, {
        kind: "unresolved_questions",
        body: "Why did p99 recover before the fix shipped?",
        evidenceIds: [],
        findingIds: [],
        noteIds: [],
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("report-section-backdrop")).toBeNull(),
    );

    // Escape path refocuses the trigger it was opened from.
    const refreshedTrigger = await screen.findByTestId(
      "report-edit-section-unresolved_questions",
    );
    fireEvent.click(refreshedTrigger);
    const reopened = await screen.findByTestId("report-section-body");
    fireEvent.keyDown(reopened, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(refreshedTrigger));
  });

  it("re-sends existing section citations on a body edit instead of dropping them", async () => {
    const withAuthored = resolvedInvestigation();
    withAuthored.document.reportSections = [
      {
        id: "sec-1",
        kind: "next_actions",
        body: "Roll back the retry policy.",
        evidenceIds: ["ev-1"],
        findingIds: ["finding-1"],
        noteIds: [],
        provenance: "human",
        acceptedFromProposalId: "prop-old",
        createdAt: 1_700_000_250,
        updatedAt: 1_700_000_250,
      },
    ];
    loadInvestigationMock.mockResolvedValue(withAuthored);
    const withSection = assembled();
    withSection.report.sections.nextActions = {
      sectionId: "sec-1",
      body: "Roll back the retry policy.",
      evidenceIds: ["ev-1"],
      findingIds: ["finding-1"],
      noteIds: [],
      acceptedFromProposalId: "prop-old",
      updatedAt: 1_700_000_250,
    };
    assembleMock.mockResolvedValue(withSection);
    await renderWithInvestigation();

    fireEvent.click(
      await screen.findByTestId("report-edit-section-next_actions"),
    );
    const body = (await screen.findByTestId(
      "report-section-body",
    )) as HTMLTextAreaElement;
    expect(body.value).toBe("Roll back the retry policy.");
    fireEvent.change(body, {
      target: { value: "Roll back the retry policy today." },
    });
    fireEvent.submit(body.closest("form")!);
    await waitFor(() =>
      expect(setSectionMock).toHaveBeenCalledWith("c1", "inv-1", 4, {
        kind: "next_actions",
        body: "Roll back the retry policy today.",
        evidenceIds: ["ev-1"],
        findingIds: ["finding-1"],
        noteIds: [],
      }),
    );
  });

  it("previews cited evidence identities beside the report without mutating it", async () => {
    previewEvidenceMock.mockResolvedValue({
      investigationId: "inv-1",
      revision: 4,
      item: resolvedInvestigation().document.evidence[0]!,
      references: [
        {
          eventRef: {
            corpusId: "c1",
            seq: 4,
            source: "api/app.jsonl",
            timestampHint: 1_700_000_004,
            timeQualityHint: "wall",
          },
          status: "verified",
          event: {
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
        },
      ],
    });
    await renderWithInvestigation();
    await waitFor(() =>
      expect(
        screen.getByTestId("report-citation-finding-1-ev-1"),
      ).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId("report-citation-finding-1-ev-1"));
    await waitFor(() =>
      expect(previewEvidenceMock).toHaveBeenCalledWith("c1", "inv-1", "ev-1"),
    );
    const preview = await screen.findByTestId(
      "investigations-evidence-preview",
    );
    expect(preview.textContent).toContain("report unchanged");
    expect(preview.textContent).toContain("seq 4 · api/app.jsonl · [verified]");
    expect(preview.textContent).toContain("checkout timed out");
    fireEvent.click(
      within(preview).getByRole("button", { name: "Close preview" }),
    );
    expect(
      screen.queryByTestId("investigations-evidence-preview"),
    ).toBeNull();
  });
});
