/**
 * Visual acceptance — Logs library action toolbar (#641 S3a hotfix).
 *
 * Covers, in real headless Chromium with the production CSS chain, the
 * regression where the @media (max-width: 78rem) override in
 * styles/components/panes.css turned .log-pane__toolbar into a
 * repeat(4, max-content) grid: max-content tracks cannot wrap, the base
 * flex-wrap became inert, and at every pane width in the 864–1248px window
 * band (which brackets the DEFAULT 1100x760 window → 900px pane cell) the
 * toolbar's right-side controls overflowed into .pane-panel's
 * overflow:hidden and were clipped ("Open in a…" cut mid-word, "Learn more"
 * fully hidden).
 *
 * Contract asserted here at pane widths 592 / 900 / 1240 (with the real
 * window widths that produce them — media queries classify the WINDOW):
 * every control in nav[aria-label="Logs actions"] is laid out (width > 0)
 * and ends inside the pane cell; the toolbar has no hidden horizontal
 * overflow of its own; the page never scrolls horizontally. Wrapping to
 * additional rows is acceptable — clipping is not.
 *
 * Renderer-level proof ONLY (docs/CLOSE_PROOF.md § Native packaged proof):
 * real CSS, layout, and ARIA in a Vitest browser-mode Chromium page — never
 * native packaged acceptance.
 */
import "./support/styles";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as host from "../src/lib/host";
import { LogPane } from "../src/components/panes/LogPane";
import { applyBaselineLogExplorerHostMocks } from "./support/logExplorerFixtures";
import {
  applyTheme,
  expectNoHorizontalPageOverflow,
  nextPaintedFrame,
  resetVisualState,
  visualStage,
} from "./support/harness";

// Full host module mock, mirrored from visual/log-explorer.test.tsx (itself
// mirrored from the unit suite's proven factory). Real-browser ESM validates
// every module's named imports against this mocked module across the whole
// static graph, so the factory must export the full union of host symbols
// imported anywhere in reachable src/** — not only what LogPane itself calls.
// Symbols outside the proven set are loud stubs so an unexpected call fails
// visibly instead of silently.
vi.mock("../src/lib/host", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/host")>();
  const hostExportNames = [
    // Engine module (investigationReports) host imports — ae2e1a3.
    "hostLogAssembleInvestigationReport",
    "hostLogPrepareInvestigationEvidence",
    "hostLogCommitInvestigationEvidence",
    "hostLogCancelInvestigationEvidencePrepare",
    "hostLogSetInvestigationReportSection",
    "hostLogAcceptProposedReportSection",
    "hostLogDismissProposedReportSection",
    "hostLogSaveInvestigationReportExport",
    "hostLogReleaseInvestigationReportExport",
    "CapabilityCheckDto",
    "DefaultWorkspaceDto",
    "ExplorerEventDto",
    "HandbookLinkDto",
    "HandbookManifestDto",
    "HandbookPageDto",
    "HelpAssetRefDto",
    "HelpTocEntryDto",
    "InvestigationFindingKind",
    "InvestigationFindingLifecycle",
    "InvestigationViewRecipeDto",
    "LocalCandidateDto",
    "LogBookmarkEventRefDto",
    "LogImportConfidenceDto",
    "LogSourceConfidenceDto",
    "LogTimezoneApplyRequestDto",
    "LogTimezoneClearRequestDto",
    "LogTimezoneDeclarationDto",
    "LogTimezonePreviewRequestDto",
    "LogTimezoneResolutionPreviewDto",
    "LogTimezoneScopeDto",
    "LogTimezoneSourceStatusDto",
    "LogTimezoneStateDto",
    "ModelOptionDto",
    "QualificationReportDto",
    "QualificationSelectArgs",
    "TimeQuality",
    "agentTurn",
    "completePermission",
    "createLogSearchRequestId",
    "hostApplyLogSourceTimezone",
    "hostApproveMemoryCandidate",
    "hostApproveModuleEnable",
    "hostArchiveChatSession",
    "hostBatchApproveMemoryCandidates",
    "hostBrowseModuleRegistry",
    "hostCancelCapabilityQualification",
    "hostCancelLogIngest",
    "hostCancelLogReanalysis",
    "hostCancelLogSearch",
    "hostCancelS3WorkspaceBackup",
    "hostCancelTurn",
    "hostCheckForUpdates",
    "hostCheckOllama",
    "hostClearCapabilityQualification",
    "hostClearFailedLogIngestDiagnostic",
    "hostClearLogSourceTimezone",
    "hostConfluenceHasToken",
    "hostDeleteChatSession",
    "hostDiscardLogCorpus",
    "hostDiscardMemoryCandidate",
    "hostEditMemoryCandidate",
    "hostEnsureDefaultWorkspace",
    "hostExportHandbookDocument",
    "hostExportLogCorpusPackage",
    "hostGetActiveProvider",
    "hostGetAmbientRecallEnabled",
    "hostGetBranding",
    "hostGetCapabilityQualification",
    "hostGetConfig",
    "hostGetConfluence",
    "hostGetDefaultChatModel",
    "hostGetDurableMemory",
    "hostGetFailedLogIngestDiagnostic",
    "hostGetHandbookManifest",
    "hostGetHandbookPage",
    "hostGetHelpAsset",
    "hostGetHelpPage",
    "hostGetHybridRetrieval",
    "hostGetLogCorpus",
    "hostGetModuleRegistrySettings",
    "hostGetRouterBudget",
    "hostGetS3BackupSettings",
    "hostGetWebResearchEnabled",
    "hostGetX",
    "hostImportLogCorpusPackagePath",
    "hostIngestLogPath",
    "hostInstallDemoLogCorpus",
    "hostInstallModule",
    "hostInstallUpdate",
    "hostListChatModels",
    "hostListChatSessions",
    "hostListChatSessionsForCorpus",
    "hostListConfluenceSpaces",
    "hostListConnectorKinds",
    "hostListConnectors",
    "hostListDurableMemories",
    "hostListHarvests",
    "hostListHelpSections",
    "hostListLocalCandidates",
    "hostListLogCorpora",
    "hostListLogTemplates",
    "hostListMemory",
    "hostListMemoryCandidates",
    "hostListModelsForDraft",
    "hostListModules",
    "hostListSkills",
    "hostListWebResearchSources",
    "hostListenProcessProgress",
    "hostListenS3BackupProgress",
    "hostLoadChatSession",
    "hostLoadLogOperationalMetricsAttachment",
    "hostLoadLogTimezoneState",
    "hostLogAcceptProposedFinding",
    "hostLogActivateTemplateSuppression",
    "hostLogAddBookmark",
    "hostLogAddInvestigationEvidence",
    "hostLogAddInvestigationFinding",
    "hostLogAddInvestigationNote",
    "hostLogApplyInvestigationFindingView",
    "hostLogClusterProblems",
    "hostLogCountEvents",
    "hostLogDeleteBookmark",
    "hostLogDismissProposedFinding",
    "hostLogEditInvestigationFinding",
    "hostLogEditInvestigationNote",
    "hostLogFacets",
    "hostLogListBookmarks",
    "hostLogLoadActiveInvestigation",
    "hostLogLoadSuppression",
    "hostLogMutateTemplateSuppressionRule",
    "hostLogPreviewInvestigationEvidence",
    "hostLogPreviewInvestigationFindingView",
    "hostLogPreviewTemplateSuppression",
    "hostLogProposeNoiseCandidates",
    "hostLogQueryEventNeighborhood",
    "hostLogQueryEventOriginal",
    "hostLogQueryEventRows",
    "hostLogQueryEvents",
    "hostLogRecomputeInvestigationFindingView",
    "hostLogSearch",
    "hostLogSearchEventsAdvanced",
    "hostLogSharedTimelineSummary",
    "hostLogSourceCatalog",
    "hostLogSuppressionDiagnosticSnapshot",
    "hostLogSuppressionLens",
    "hostOpenEngineeringHandbook",
    "hostOpenExternalUrl",
    "hostOpenLogExplorer",
    "hostOpenLogExplorerTarget",
    "hostPinChatSession",
    "hostPreflight",
    "hostPrepareLogDiagnosticReport",
    "hostPreviewLogSourceTimezone",
    "hostProbeAiGateway",
    "hostProbeUrl",
    "hostProposeConfluencePublish",
    "hostProviderHasSecret",
    "hostPurgeMemoryGdpr",
    "hostReadFile",
    "hostReanalyzeLogCorpus",
    "hostReleaseLogDiagnosticReport",
    "hostRemoveLogOperationalMetricsAttachment",
    "hostRemoveModule",
    "hostRenameChatSession",
    "hostResolveHandbookLink",
    "hostRestoreChatSession",
    "hostRunS3WorkspaceBackup",
    "hostSaveActiveProvider",
    "hostSaveChatSession",
    "hostSaveCompositionDraft",
    "hostSaveConfluence",
    "hostSaveConnectors",
    "hostSaveLogDiagnosticReport",
    "hostSaveLogOperationalMetricsAttachment",
    "hostSaveS3BackupSettings",
    "hostSaveX",
    "hostSearchChatSessions",
    "hostSearchHelpPages",
    "hostSessionContextImportBytes",
    "hostSessionContextImportPath",
    "hostSessionContextImportZip",
    "hostSessionContextList",
    "hostSessionContextRemove",
    "hostSetActiveLogCorpus",
    "hostSetAmbientRecallEnabled",
    "hostSetChatLinkedCorpus",
    "hostSetConnectorSecret",
    "hostSetDefaultChatModel",
    "hostSetHybridRetrieval",
    "hostSetModelToolsEnabled",
    "hostSetModuleEnabled",
    "hostSetModuleRegistrySettings",
    "hostSetProviderToolsEnabled",
    "hostSetRouterBudget",
    "hostSetSkillEnabled",
    "hostSetWebResearchEnabled",
    "hostSetWebResearchSources",
    "hostSetWorkspace",
    "hostSourceGitFetch",
    "hostSourceGitStatus",
    "hostStartCapabilityQualification",
    "hostSuggestChatTitle",
    "hostSuggestDefaultWorkspace",
    "hostTakeLogExplorerNavTarget",
    "hostTestConfluence",
    "hostTestX",
    "hostTrashChatSession",
    "hostValidateWorkspacePath",
    "hostWriteMemory",
    "hostXHasToken",
    "modelSelectionKey",
    "normalizeProviderKind",
    "parseModelSelectionKey",
    "profileIdForKind",
  ] as const;
  const loudStubNames = new Set([
    ...hostExportNames,
    ...Object.entries(original)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name),
  ]);
  const loudStubs = Object.fromEntries(
    [...loudStubNames].map((name) => [
      name,
      vi.fn(() => {
        throw new Error(`host.${name} is not mocked in the visual suite`);
      }),
    ]),
  );
  return {
    ...original,
    ...loudStubs,
    modelSelectionKey: (providerId: string, modelId: string) =>
      `${providerId}::${modelId}`,
    parseModelSelectionKey: (key: string) => {
      const split = key.indexOf("::");
      return split > 0
        ? {
            providerId: key.slice(0, split),
            modelId: key.slice(split + 2),
          }
        : { providerId: null, modelId: key };
    },
    createLogSearchRequestId: vi.fn(() => "find-request"),
    hostCancelLogSearch: vi.fn(async () => true),
    hostGetLogCorpus: vi.fn(async () => ({
      id: "c1",
      name: "fixture",
      eventCount: 10,
      templateCount: 2,
      engine: "duckdb",
      createdAt: 0,
    })),
    hostGetBranding: vi.fn(async () => ({
      name: "ContextDesk",
      slug: "contextdesk",
      tagline: "Developer knowledge workbench",
      version: "0.1.0",
      protocol: "cd.v1",
      channel: "dev",
      git_sha: "de43caeba66df05068a50db9356efad3b64a4a45",
      git_describe: null,
      identity_line: "v0.1.0 · channel=dev",
    })),
    hostSetActiveLogCorpus: vi.fn(async () => "c1"),
    hostLogListBookmarks: vi.fn(async () => []),
    hostLogLoadSuppression: vi.fn(async (corpusId: string) => ({
      schemaVersion: 1,
      corpusId,
      revision: 0,
      rules: [],
      previews: [],
      audit: [],
    })),
    hostLogSuppressionLens: vi.fn(async (corpusId: string) => ({
      corpusId,
      state: "resolved" as const,
      templateIds: [],
      policyRevision: 0,
      eventRevision: 0,
      templateAnalysisRevision: 0,
    })),
    hostLogProposeNoiseCandidates: vi.fn(async () => ({
      corpusId: "c1",
      unsuppressedEventCount: 10,
      corpusEventCount: 10,
      suppressionRevision: 0,
      eventRevision: 0,
      templateAnalysisRevision: 0,
      alreadySuppressedTemplateIds: [],
      timeQuality: "wall",
      rawTimeQuality: "wall",
      candidates: [],
      templatesScanned: 2,
      eligibleCandidateCount: 0,
      truncated: false,
      candidateCapTruncated: false,
      templateScanTruncated: false,
      responseBytesTruncated: false,
      metadataMissingTemplateIds: [],
      databaseQueryCount: 2,
      disclaimer: "Human review only. Nothing was auto-suppressed.",
      cancelled: false,
    })),
    hostLogPreviewTemplateSuppression: vi.fn(),
    hostLogActivateTemplateSuppression: vi.fn(),
    hostLogMutateTemplateSuppressionRule: vi.fn(),
    hostListChatModels: vi.fn(async () => [
      {
        id: "triage-1",
        label: "triage-1",
        selection_key: "tools-provider::triage-1",
        provider_id: "tools-provider",
        provider_label: "Tools Provider",
        group: "Tools Provider",
        is_default: true,
        tools_enabled: true,
      },
    ]),
    hostListChatSessionsForCorpus: vi.fn(async () => []),
    hostLoadChatSession: vi.fn(async () => null),
    hostTakeLogExplorerNavTarget: vi.fn(async () => null),
    hostOpenLogExplorerTarget: vi.fn(async () => {
      throw new Error("not used in the visual suite");
    }),
    hostLogFacets: vi.fn(async () => ({
      sources: { "api.log": 5, "worker.log": 5 },
      levels: { error: 3, info: 7 },
      services: { api: 5 },
      hosts: {},
      timeQuality: "wall",
    })),
    hostLogSourceCatalog: vi.fn(async () => ({
      sources: [
        { source: "api.log", eventCount: 5 },
        { source: "worker.log", eventCount: 5 },
      ],
      nextCursor: null,
      totalMatched: 2,
    })),
    hostLogQueryEvents: vi.fn(async () => ({
      events: [
        {
          seq: 1,
          ts: 1_700_000_000,
          timeQuality: "wall",
          level: "error",
          service: "api",
          host: null,
          templateId: 1,
          traceId: null,
          message: "auth failure",
          source: "api.log",
        },
        {
          seq: 2,
          ts: 1_700_000_001,
          timeQuality: "wall",
          level: "info",
          service: "worker",
          host: null,
          templateId: 2,
          traceId: null,
          message: "job ok",
          source: "worker.log",
        },
      ],
      nextCursor: null,
      totalMatched: 2,
      timeQuality: "wall",
    })),
    hostLogQueryEventRows: vi.fn(),
    hostLogCountEvents: vi.fn(),
    hostLogSharedTimelineSummary: vi.fn(async () => ({
      timeQuality: "wall",
      spanFrom: 1_700_000_000,
      spanTo: 1_700_000_004,
      bucketWidth: 1,
      bucketCount: 4,
      totalMatched: 2,
      buckets: [
        { index: 0, start: 1_700_000_000, end: 1_700_000_001 },
        { index: 1, start: 1_700_000_001, end: 1_700_000_002 },
        { index: 2, start: 1_700_000_002, end: 1_700_000_003 },
        { index: 3, start: 1_700_000_003, end: 1_700_000_004 },
      ],
      counts: [1, 1, 0, 0],
      severitySeries: [
        { severity: "error", counts: [1, 0, 0, 0] },
        { severity: "warn", counts: [0, 0, 0, 0] },
        { severity: "info", counts: [0, 1, 0, 0] },
        { severity: "debug", counts: [0, 0, 0, 0] },
        { severity: "other", counts: [0, 0, 0, 0] },
      ],
      lanes: [],
    })),
    hostLoadLogOperationalMetricsAttachment: vi.fn(async () =>
      Promise.reject({ code: "missing" }),
    ),
    hostSaveLogOperationalMetricsAttachment: vi.fn(),
    hostRemoveLogOperationalMetricsAttachment: vi.fn(),
    hostLogQueryEventOriginal: vi.fn(async () => ({
      state: "unavailable",
      reason: "Original representation unavailable for this corpus",
    })),
    hostLogSearchEvents: vi.fn(async () => []),
    hostLogSearchEventsAdvanced: vi.fn(async () => ({
      hits: [],
      partial: false,
      scanned: 0,
    })),
    hostLogQueryEventNeighborhood: vi.fn(async () => ({
      status: "missing",
      events: [],
      totalMatched: 0,
      corpusTotal: 0,
      timeQuality: "order_only",
    })),
    hostLoadLogTimezoneState: vi.fn(async (corpusId: string) => ({
      corpusId,
      eventRevision: 0,
      declarations: {},
      sources: [],
    })),
    hostPreviewLogSourceTimezone: vi.fn(),
    hostApplyLogSourceTimezone: vi.fn(),
    hostClearLogSourceTimezone: vi.fn(),
    hostLogAddBookmark: vi.fn(),
    hostLogDeleteBookmark: vi.fn(),
    hostLogLoadActiveInvestigation: vi.fn(async () => null),
    hostLogAddInvestigationEvidence: vi.fn(),
    hostLogAddInvestigationFinding: vi.fn(),
    hostLogAddInvestigationNote: vi.fn(),
    hostLogEditInvestigationFinding: vi.fn(),
    hostLogEditInvestigationNote: vi.fn(),
    hostLogPreviewInvestigationEvidence: vi.fn(),
    hostLogPreviewInvestigationFindingView: vi.fn(),
    hostLogRecomputeInvestigationFindingView: vi.fn(),
    hostLogApplyInvestigationFindingView: vi.fn(),
    hostLogAcceptProposedFinding: vi.fn(),
    hostLogDismissProposedFinding: vi.fn(),
    hostPrepareLogDiagnosticReport: vi.fn(async () => {
      throw new Error("diagnostics not exercised in the visual suite");
    }),
    hostReleaseLogDiagnosticReport: vi.fn(async () => true),
    hostSaveLogDiagnosticReport: vi.fn(),
    hostSaveChatSession: vi.fn(),
    hostSetChatLinkedCorpus: vi.fn(),
    agentTurn: vi.fn(async () => []),
  };
});

/**
 * Mount the Logs LIBRARY (not the Explorer embed) inside a real .pane-panel
 * cell of exact production width, select the fixture corpus so every
 * corpus-gated action enables, and wait until all 8 toolbar controls are
 * enabled. Mirrors renderInAppEmbed in visual/log-explorer.test.tsx, but
 * stops at the library surface — the toolbar under test only exists there.
 */
async function renderLibraryInCell(
  cellWidth: number,
  cellHeight: number,
): Promise<{ cell: HTMLElement; toolbar: HTMLElement }> {
  vi.mocked(host.hostListLogCorpora).mockResolvedValue([
    {
      id: "c1",
      name: "fixture",
      eventCount: 12,
      templateCount: 3,
      engine: "duckdb",
      createdAt: 1_700_000_000,
      sourceLabel: "c1.log",
      stats: null,
      topTemplates: [],
      embedding: {
        state: "keyword_only",
        modelId: null,
        embeddedTemplates: 0,
        totalTemplates: 3,
        reason: "local_model_unavailable",
        updatedAt: 1,
      },
    },
  ]);
  vi.mocked(host.hostListenProcessProgress).mockResolvedValue(() => undefined);
  vi.mocked(host.hostGetFailedLogIngestDiagnostic).mockResolvedValue(null);

  const stage = visualStage();
  const cell = document.createElement("div");
  cell.className = "pane-panel";
  cell.setAttribute("data-testid", "library-pane-cell");
  cell.style.width = `${cellWidth}px`;
  cell.style.height = `${cellHeight}px`;
  stage.appendChild(cell);
  render(<LogPane onOpenHelp={() => undefined} />, { container: cell });

  // Select the corpus row — Export/Re-analyze/Open Explorer/Open in app are
  // corpus-gated (same flow the unit suite drives, LogPane.test.tsx).
  const corpusRow = await screen.findByRole(
    "button",
    { name: /^fixture(\s|$)/ },
    { timeout: 8000 },
  );
  fireEvent.click(corpusRow);

  const toolbar = screen.getByRole("navigation", { name: "Logs actions" });
  await waitFor(
    () => {
      const buttons = within(toolbar).getAllByRole("button");
      expect(buttons).toHaveLength(8);
      for (const button of buttons) {
        expect((button as HTMLButtonElement).disabled).toBe(false);
      }
    },
    { timeout: 8000 },
  );
  await nextPaintedFrame();
  return { cell, toolbar };
}

/**
 * The clipping contract: every toolbar control is laid out and ends inside
 * the pane cell (getBoundingClientRect is the pre-clip truth — .pane-panel
 * is overflow:hidden, so a rect past cell.right IS the clipped pixel), the
 * toolbar hides no horizontal overflow of its own, and the page never
 * scrolls horizontally. Wrapped rows are fine; clipped controls are not.
 */
function expectToolbarUnclipped(cell: HTMLElement, toolbar: HTMLElement): void {
  const cellRect = cell.getBoundingClientRect();
  const buttons = within(toolbar).getAllByRole("button");
  expect(buttons).toHaveLength(8);
  for (const button of buttons) {
    const rect = button.getBoundingClientRect();
    const label = button.textContent ?? "?";
    expect(rect.width, `"${label}" collapsed to zero width`).toBeGreaterThan(0);
    expect(
      rect.right,
      `"${label}" right edge ${rect.right} escapes the pane cell right edge ${cellRect.right}`,
    ).toBeLessThanOrEqual(cellRect.right + 1);
    expect(
      rect.left,
      `"${label}" left edge ${rect.left} escapes the pane cell left edge ${cellRect.left}`,
    ).toBeGreaterThanOrEqual(cellRect.left - 1);
  }
  expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth + 1);
  expectNoHorizontalPageOverflow();
}

describe("Logs library action toolbar (#641)", () => {
  beforeEach(async () => {
    await resetVisualState();
    applyBaselineLogExplorerHostMocks();
  });

  it("owner band 1100x760 window / 900px pane: no action clips (dark + light baselines)", async () => {
    // Exact owner window; default 200px sidebar + chrome rows leave a 900x680
    // pane cell (layout.css:211). 1100px window sits inside the 78rem media
    // tier — the band where the repeat(4, max-content) grid used to push
    // "Open in app" and "Learn more" past the pane's overflow:hidden edge.
    await page.viewport(1100, 760);
    const { cell, toolbar } = await renderLibraryInCell(900, 680);

    expectToolbarUnclipped(cell, toolbar);

    await expect(page.elementLocator(cell)).toMatchScreenshot(
      "library-900-dark",
    );
    await applyTheme("light");
    await expect(page.elementLocator(cell)).toMatchScreenshot(
      "library-900-light",
    );
    await applyTheme("dark");
  });

  it("640x800 window / 592px pane: the two-column tier keeps every action visible", async () => {
    // <=760px windows collapse the sidebar to 48px (layout.css:506-517);
    // 640px window is inside the 54rem recovery tier (2-column grid,
    // white-space:normal labels).
    await page.viewport(640, 800);
    const { cell, toolbar } = await renderLibraryInCell(592, 720);

    expectToolbarUnclipped(cell, toolbar);

    await expect(page.elementLocator(cell)).toMatchScreenshot(
      "library-592-dark",
    );
  });

  it("1440x900 window / 1240px pane: the wide flex-end row stays unclipped", async () => {
    // Above the 78rem tier (window > 1248px): the base right-aligned
    // flex-wrap row — the pre-existing good state, pinned so the hotfix
    // never regresses it.
    await page.viewport(1440, 900);
    const { cell, toolbar } = await renderLibraryInCell(1240, 820);

    expectToolbarUnclipped(cell, toolbar);

    await expect(page.elementLocator(cell)).toMatchScreenshot(
      "library-1240-dark",
    );
  });
});
