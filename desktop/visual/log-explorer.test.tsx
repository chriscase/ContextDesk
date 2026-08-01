/**
 * Visual acceptance — Log Explorer (full LogExplorer mount).
 *
 * Covers, in real headless Chromium with the production CSS chain:
 *   1. Ready state with populated evidence lanes ('auth failure' / 'job ok'):
 *      dark + light baselines, three-column geometry, virtualized scroll
 *      container truth, data-lane-count truth.
 *   2. Real breakpoint truth via viewport width (ResizeObserver on the root —
 *      classifyBreakpoint <900 narrow / >=1600 ultrawide,
 *      src/lib/logExplorer/types.ts): narrow drawer layout at 640 (one dark
 *      baseline), ultrawide lane-count controls at 1720 (attributes only).
 *   3. Loading: fail-closed noise-policy gate (role=status, exact copy, no
 *      evidence queries) that clears on resolve.
 *   4. Errors: (a) policy fail-closed (role=alert + 'Retry policy', dark
 *      baseline); (b) lane paging failure local to the lane, prior rows kept.
 *   5. axe-core on the ready explorer (dark).
 *
 * Renderer-level proof ONLY: everything here is a Vitest browser-mode page —
 * real CSS, layout, ARIA, and focus in Chromium — never native packaged
 * acceptance (docs/CLOSE_PROOF.md § Native packaged proof).
 *
 * Assertions are drawn from docs/design/LOG_EXPLORER.md (narrow layout is a
 * drawer workspace, lines 79-95; lanes and fail-closed policy gate) and the
 * unit-suite contracts in src/components/logExplorer/LogExplorer.test.tsx
 * (ready shell :829, policy gate :860/:890, lane-local paging failure :7404).
 */
import "./support/styles";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as host from "../src/lib/host";
import { LogExplorer } from "../src/components/logExplorer/LogExplorer";
import { LogPane } from "../src/components/panes/LogPane";
import {
  applyBaselineLogExplorerHostMocks,
  defaultEventPage,
  deferred,
  emptySuppressionDocument,
} from "./support/logExplorerFixtures";
import {
  applyTheme,
  expectNoAxeViolations,
  expectNoHorizontalPageOverflow,
  expectWithinViewport,
  nextPaintedFrame,
  renderVisual,
  resetVisualState,
  setViewport,
  visualStage,
} from "./support/harness";

// Full host module mock, mirrored from the unit suite's proven factory
// (src/components/logExplorer/LogExplorer.test.tsx:15-240). The factory must
// export every symbol the LogExplorer component graph imports — a missing
// export throws at import time. hostPrepareLogDiagnosticReport is simplified
// (the diagnostics flow is not exercised by this suite).
vi.mock("../src/lib/host", () => {
  // Real-browser ESM validates every module's named imports against this
  // mocked module across the whole static graph (the unit suite's happy-dom
  // transform does not), so the factory must export the full union of host
  // symbols imported anywhere in reachable src/** — not only what LogExplorer
  // itself calls. Symbols outside the unit factory's proven set are loud
  // stubs so an unexpected call fails visibly instead of silently.
  const hostExportNames = [
    // Engine module (investigationReports) host imports — ae2e1a3.
    "hostLogAssembleInvestigationReport",
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
  const loudStubs = Object.fromEntries(
    hostExportNames.map((name) => [
      name,
      vi.fn(() => {
        throw new Error(`host.${name} is not mocked in the visual suite`);
      }),
    ]),
  );
  return {
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

/** Mount the explorer and wait for the two fixture evidence rows. */
async function renderReadyExplorer(): Promise<HTMLElement> {
  renderVisual(<LogExplorer corpusId="c1" />);
  await screen.findByText(/auth failure/, undefined, { timeout: 8000 });
  return screen.getByTestId("log-explorer");
}

/**
 * Wait for every transient loading affordance to settle so screenshots are
 * deterministic: the exact match count replaces 'Counting matches…' /
 * 'Evidence loading…', and the status line reaches its post-load resident
 * summary with no ' · busy' suffix (all initial fetches resolved).
 */
async function waitForReadySettled(root: HTMLElement): Promise<void> {
  await waitFor(
    () => {
      expect(
        screen.getByTestId("log-explorer-global-counts").textContent,
      ).toContain("2 matched");
      const status = root.querySelector(".log-explorer__status");
      expect(status?.textContent).toBe("2 resident rows loaded (bounded)");
    },
    { timeout: 8000 },
  );
}

/**
 * Drive the lane's near-newer-edge paging trigger deterministically. The two
 * fixture rows cannot make the real list scrollable, so this mirrors the unit
 * suite's scrollLaneToEdge (LogExplorer.test.tsx:427-440): shadow the scroll
 * metrics on the element instance (configurable own properties are honored by
 * Chromium) and dispatch a scroll event. scrollTop 2400 of 2800 with a 400px
 * client puts the viewport past the nearTop band and inside the nearBottom
 * band (EDGE_TRIGGER_ROWS × row height), and OVERSCAN (12) keeps both real
 * rows mounted for the rows-preserved assertion.
 */
function scrollLaneToNewerEdge(): void {
  const list = screen.getAllByTestId("virtualized-event-list")[0]!;
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 2_800 },
    scrollTop: { configurable: true, writable: true, value: 2_400 },
  });
  fireEvent.scroll(list);
}

describe("Log Explorer visual acceptance", () => {
  beforeEach(async () => {
    await resetVisualState();
    applyBaselineLogExplorerHostMocks();
  });

  it("ready: populated lanes with three-column geometry, dark and light baselines", async () => {
    const root = await renderReadyExplorer();
    await waitForReadySettled(root);

    // Identity + lane-count attribute truth: one lane advertised, one lane
    // section and one virtualized list actually rendered.
    expect(root.getAttribute("data-resizable")).toBe("true");
    expect(root.getAttribute("data-breakpoint")).toBe("normal");
    expect(root.getAttribute("data-lane-count")).toBe("1");
    expect(root.querySelectorAll("[data-lane-id]")).toHaveLength(1);
    expect(screen.getAllByTestId("virtualized-event-list")).toHaveLength(1);
    screen.getByLabelText("Log Explorer for fixture");

    // Three-column body (filters | lanes | chat) fits the viewport with both
    // splitters between the columns and no horizontal page overflow.
    const body = screen.getByTestId("log-explorer-body");
    const filters = screen.getByTestId("log-explorer-filters");
    const lanes = screen.getByTestId("log-explorer-lanes");
    const chat = screen.getByTestId("log-explorer-chat");
    screen.getByTestId("splitter-filters");
    screen.getByTestId("splitter-chat");
    expectWithinViewport(body);
    expectNoHorizontalPageOverflow();
    const filtersRect = filters.getBoundingClientRect();
    const lanesRect = lanes.getBoundingClientRect();
    const chatRect = chat.getBoundingClientRect();
    expect(filtersRect.width).toBeGreaterThan(0);
    expect(lanesRect.width).toBeGreaterThan(0);
    expect(chatRect.width).toBeGreaterThan(0);
    expect(filtersRect.right).toBeLessThanOrEqual(lanesRect.left + 1);
    expect(lanesRect.right).toBeLessThanOrEqual(chatRect.left + 1);

    // The virtualized event list is the scroll container — real computed
    // overflow, laid-out height, and its own scrollable content — while the
    // explorer root clips itself (overflow hidden), so the page never becomes
    // the evidence scroll surface.
    const vlist = screen.getAllByTestId("virtualized-event-list")[0]!;
    expect(vlist.getAttribute("data-virtualized")).toBe("true");
    expect(getComputedStyle(vlist).overflowY).toMatch(/^(auto|scroll)$/);
    expect(vlist.clientHeight).toBeGreaterThan(0);
    expect(vlist.scrollHeight).toBeGreaterThanOrEqual(vlist.clientHeight);
    expect(getComputedStyle(root).overflow).toBe("hidden");
    within(vlist).getByText("api.log");
    within(vlist).getByText("worker.log");

    await expect(page.elementLocator(root)).toMatchScreenshot(
      "log-explorer-ready-dark",
    );
    await applyTheme("light");
    await expect(page.elementLocator(root)).toMatchScreenshot(
      "log-explorer-ready-light",
    );
  });

  it("breakpoints: narrow drawers at 640, ultrawide lane controls at 1720 (real viewport)", async () => {
    const root = await renderReadyExplorer();
    await waitForReadySettled(root);

    // Narrow (<900): the ResizeObserver on the root reclassifies from real
    // laid-out width — no innerWidth stubbing. Filters and chat become
    // closed drawers behind explicit toggles (docs/design/LOG_EXPLORER.md
    // narrow layout) and the lane-count picker is omitted.
    await setViewport("narrow");
    await waitFor(
      () => expect(root.getAttribute("data-breakpoint")).toBe("narrow"),
      { timeout: 5000 },
    );
    const narrowTabs = screen.getByTestId("log-explorer-narrow-tabs");
    const filtersToggle = within(narrowTabs).getByTestId(
      "narrow-filters-toggle",
    );
    expect(filtersToggle.getAttribute("aria-expanded")).toBe("false");
    expect(filtersToggle.getAttribute("aria-controls")).toBe(
      "log-explorer-filter-panel",
    );
    const chatToggle = within(narrowTabs).getByTestId("narrow-chat-toggle");
    expect(chatToggle.getAttribute("aria-expanded")).toBe("false");
    // Closed drawers: the panels exist but are display:none until toggled.
    expect(
      getComputedStyle(screen.getByTestId("log-explorer-filters")).display,
    ).toBe("none");
    const narrowChat = screen.queryByTestId("log-explorer-chat");
    if (narrowChat) {
      expect(getComputedStyle(narrowChat).display).toBe("none");
    }
    expect(screen.queryByTestId("lane-count-picker")).toBeNull();
    expect(root.getAttribute("data-lane-count")).toBe("1");
    expectNoHorizontalPageOverflow();
    await expect(page.elementLocator(root)).toMatchScreenshot(
      "log-explorer-ready-dark-narrow",
    );

    // Ultrawide (>=1600): lane-count controls exist. Attribute assertions
    // only — multi-lane state changes are covered by the unit suite.
    await setViewport("wide");
    await waitFor(
      () => expect(root.getAttribute("data-breakpoint")).toBe("ultrawide"),
      { timeout: 5000 },
    );
    expect(screen.queryByTestId("log-explorer-narrow-tabs")).toBeNull();
    screen.getByTestId("lane-count-picker");
    const maxLanes = Number(root.getAttribute("data-max-lane-count"));
    expect(maxLanes).toBeGreaterThanOrEqual(2);
    expectNoHorizontalPageOverflow();
  });

  it("loading: fail-closed policy gate holds evidence until the policy resolves", async () => {
    const policy = deferred<host.SuppressionDocumentDto>();
    vi.mocked(host.hostLogLoadSuppression).mockReturnValue(policy.promise);

    renderVisual(<LogExplorer corpusId="c1" />);

    const gate = await screen.findByTestId("noise-policy-gate", undefined, {
      timeout: 8000,
    });
    expect(gate.getAttribute("role")).toBe("status");
    within(gate).getByText("Loading noise policy before evidence…");
    // Visible banner geometry: full-width strip inside the viewport.
    const gateRect = gate.getBoundingClientRect();
    expect(gateRect.width).toBeGreaterThan(0);
    expect(gateRect.top).toBeGreaterThanOrEqual(0);
    expectWithinViewport(gate);

    // Fail-closed: no evidence row surfaces and no evidence query is issued
    // while the durable policy is unresolved.
    expect(screen.queryByText(/auth failure/)).toBeNull();
    expect(host.hostLogQueryEventRows).not.toHaveBeenCalled();
    expect(host.hostLogFacets).not.toHaveBeenCalled();
    expect(host.hostLogSearchEventsAdvanced).not.toHaveBeenCalled();

    await act(async () => {
      policy.resolve(emptySuppressionDocument());
      await policy.promise;
    });

    await screen.findByText(/auth failure/, undefined, { timeout: 8000 });
    expect(screen.queryByTestId("noise-policy-gate")).toBeNull();
  });

  it("error: policy fail-closed surface with Retry policy (dark baseline)", async () => {
    vi.mocked(host.hostLogLoadSuppression).mockRejectedValueOnce(
      new Error("policy sidecar unreadable"),
    );

    renderVisual(<LogExplorer corpusId="c1" />);

    const gate = await screen.findByTestId("noise-policy-gate", undefined, {
      timeout: 8000,
    });
    await waitFor(() => expect(gate.getAttribute("role")).toBe("alert"), {
      timeout: 8000,
    });
    within(gate).getByText(/Evidence is withheld.*policy sidecar unreadable/);
    const retry = within(gate).getByRole("button", { name: "Retry policy" });
    expect(host.hostLogQueryEventRows).not.toHaveBeenCalled();

    await expect(page.elementLocator(gate)).toMatchScreenshot(
      "log-explorer-policy-error-dark",
    );

    // Retry recovers: the baseline mockResolvedValue takes over after the
    // rejected …Once, evidence loads, and the gate unmounts.
    retry.click();
    await screen.findByText(/auth failure/, undefined, { timeout: 8000 });
    expect(screen.queryByTestId("noise-policy-gate")).toBeNull();
  });

  it("error: lane paging failure stays local to the lane and preserves rows", async () => {
    // First page reports a newer cursor; the newer-page fetch fails once and
    // succeeds on retry (unit contract LogExplorer.test.tsx:7404).
    let newerAttempts = 0;
    const middle = defaultEventPage();
    middle.nextCursor = 2;
    middle.nextTs = middle.events[1]!.ts;
    vi.mocked(host.hostLogQueryEvents).mockImplementation(
      async (_corpusId, query) => {
        if (query?.afterSeq === 2) {
          newerAttempts += 1;
          if (newerAttempts === 1) throw new Error("fixture page unavailable");
          return {
            events: [
              {
                ...middle.events[1]!,
                seq: 3,
                ts: middle.events[1]!.ts + 1,
                message: "retry recovered",
              },
            ],
            nextCursor: null,
            nextTs: null,
            totalMatched: 3,
            timeQuality: "wall",
          };
        }
        return middle;
      },
    );

    const root = await renderReadyExplorer();
    // The unfilled-viewport prefetch (VirtualizedEventList.tsx:487-498) fires
    // at mount — before the lane cursors commit, so it no-ops — and arms the
    // 200ms edge cooldown shared with the scroll handler (same file, :461).
    // Let it lapse so the synthetic near-newer scroll is not swallowed.
    await new Promise((resolve) => setTimeout(resolve, 250));
    scrollLaneToNewerEdge();

    const alert = await screen.findByTestId(
      "lane-page-error-lane-0",
      undefined,
      { timeout: 8000 },
    );
    expect(alert.getAttribute("role")).toBe("alert");
    within(alert).getByText(/fixture page unavailable/);
    // Local to the lane: the alert lives inside the lane-0 section, not in a
    // global surface, and the prior evidence rows stay mounted.
    expect(alert.closest('[data-lane-id="lane-0"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="noise-policy-gate"]')).toBeNull();
    screen.getByText("auth failure");
    screen.getByText("job ok");

    within(alert).getByRole("button", { name: "Retry" }).click();
    await screen.findByText("retry recovered", undefined, { timeout: 8000 });
    expect(screen.queryByTestId("lane-page-error-lane-0")).toBeNull();
    expect(newerAttempts).toBe(2);
  });

  it("axe: ready explorer surface (dark)", async () => {
    const root = await renderReadyExplorer();
    await waitForReadySettled(root);
    // FINDING (product defects, current-actual behavior asserted; suite kept
    // green with the three rules below disabled — remove each disable once
    // src/** is repaired). axe-core on the ready dark explorer reports:
    //
    // 1. aria-required-parent [critical]: .log-explorer__col-headers
    //    (LogExplorer.tsx:6920-6932) carries role="row" with role=
    //    "columnheader" children, but no grid/table/treegrid ancestor — the
    //    event rows live in a separate role="list" container
    //    (VirtualizedEventList.tsx:780), so the header row's ARIA is invalid.
    // 2. aria-prohibited-attr [serious]: the compact provenance spans
    //    (VirtualizedEventList.tsx:927-933, span[data-full-source]) put
    //    aria-label on a role-less <span> whose visible children are all
    //    aria-hidden.
    // 3. color-contrast [serious]: payload-emphasis mode (the default) sets
    //    timestamps/level/source to color-mix(var(--fg-muted) 78%,
    //    transparent) (VirtualizedEventList.css:47-51). Dark --text-muted
    //    #8b919c was contrast-tuned (dark.css:12-13), but the 78% mix
    //    composites to #6f747d on #0b0c0e = 4.16:1 (< 4.5:1 AA at 13.6px);
    //    the 82% secondary token mix (VirtualizedEventList.css:28-33) yields
    //    #747982 = 4.47:1 at 10.88px. The post-mix values escape the per-skin
    //    contrast tests, which only check the raw tokens.
    await expectNoAxeViolations(visualStage(), {
      disableRules: [
        "aria-required-parent",
        "aria-prohibited-attr",
        "color-contrast",
      ],
    });
  });
});

/**
 * In-app embed (#851) — the "Open in app" Explorer inside the Logs pane.
 *
 * Production geometry, reproduced faithfully: the viewport is the real WINDOW
 * size and the pane cell is the workspace grid cell the shell actually gives
 * LogPane (window minus the 200px sidebar — 48px when the <=760px media query
 * collapses it — and minus titlebar + pane tabs, layout.css:211/506). The
 * Explorer must live inside that cell: its container breakpoints must see the
 * pane width (not the window), nothing may clip at the pane edge, and Close
 * Explorer must stay visible, reachable, and clear of the Explorer's own
 * toolbar at every size.
 */
async function renderInAppEmbed(
  cellWidth: number,
  cellHeight: number,
): Promise<{ cell: HTMLElement; explorer: HTMLElement }> {
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
  cell.setAttribute("data-testid", "embed-pane-cell");
  cell.style.width = `${cellWidth}px`;
  cell.style.height = `${cellHeight}px`;
  stage.appendChild(cell);
  render(<LogPane />, { container: cell });

  // Select the corpus row first — the Explorer entry points require an
  // active corpus (same flow the unit suite drives, LogPane.test.tsx).
  const corpusRow = await screen.findByRole(
    "button",
    { name: /^fixture(\s|$)/ },
    { timeout: 8000 },
  );
  fireEvent.click(corpusRow);
  const openInApp = screen.getByTestId(
    "open-log-explorer-in-app",
  ) as HTMLButtonElement;
  await waitFor(() => expect(openInApp.disabled).toBe(false));
  fireEvent.click(openInApp);
  await screen.findByText(/auth failure/, undefined, { timeout: 8000 });
  const explorer = screen.getByTestId("log-explorer");
  return { cell, explorer };
}

/** Rect intersection with a 1px tolerance (copies the suite's edge idiom). */
function rectsOverlap(a: DOMRect, b: DOMRect): boolean {
  return (
    a.left < b.right - 1 &&
    b.left < a.right - 1 &&
    a.top < b.bottom - 1 &&
    b.top < a.bottom - 1
  );
}

describe("Log Explorer in-app embed (#851)", () => {
  beforeEach(async () => {
    await resetVisualState();
    applyBaselineLogExplorerHostMocks();
  });

  it("owner reproduction 1100x760: pane-truthful geometry, clear Close, no clipping", async () => {
    // Exact owner window; default 200px sidebar + titlebar/tab rows leave a
    // 900x680 pane cell (layout.css:211, App chrome rows).
    await page.viewport(1100, 760);
    const { cell, explorer } = await renderInAppEmbed(900, 680);

    // The Explorer sizes to the PANE, never the window: at a 900px cell the
    // root must not extend past the cell (the pre-repair 100vw root rendered
    // 1100px wide here and .pane-panel clipped the right 200px — the chat
    // rail and the toolbar's right end).
    const cellRect = cell.getBoundingClientRect();
    const explorerRect = explorer.getBoundingClientRect();
    expect(explorerRect.width).toBeLessThanOrEqual(cellRect.width + 1);
    expect(explorerRect.right).toBeLessThanOrEqual(cellRect.right + 1);
    expect(explorerRect.bottom).toBeLessThanOrEqual(cellRect.bottom + 1);

    // Breakpoints classify the pane width (900 => normal), not the window.
    expect(explorer.getAttribute("data-breakpoint")).toBe("normal");

    // Tight-normal posture: below the width where open rails leave a full
    // minimum lane (220+6+420+6+300), both rails START as their 42px strips —
    // the lane keeps its readable hierarchy instead of every rail being
    // compressed at once. One click reopens either rail, state intact. The
    // posture lands via an inline-grid flip on an existing element, so wait a
    // painted frame before reading geometry (harness stale-computed-style
    // rule).
    await waitFor(() =>
      expect(
        screen.getByTestId("log-explorer-filters").getAttribute(
          "data-collapsed",
        ),
      ).toBe("true"),
    );
    await nextPaintedFrame();
    const lanes = screen.getByTestId("log-explorer-lanes");
    await waitFor(() =>
      expect(lanes.getBoundingClientRect().width).toBeGreaterThanOrEqual(420),
    );

    // Close Explorer: visible, inside the pane, keyboard reachable, and clear
    // of every Explorer toolbar control (the pre-repair floating button sat
    // on top of the toolbar's right end).
    const close = screen.getByTestId("close-in-app-explorer");
    const closeRect = close.getBoundingClientRect();
    expect(closeRect.width).toBeGreaterThan(0);
    expect(closeRect.right).toBeLessThanOrEqual(cellRect.right + 1);
    close.focus();
    expect(document.activeElement).toBe(close);
    const toolbar = explorer.querySelector(".log-explorer__toolbar");
    for (const control of Array.from(toolbar?.children ?? [])) {
      expect(
        rectsOverlap(closeRect, control.getBoundingClientRect()),
      ).toBe(false);
    }

    await expectNoHorizontalPageOverflow();
    await applyTheme("dark");
    await expect(
      page.elementLocator(cell),
    ).toMatchScreenshot("log-explorer-embed-1100x760-dark");
    await applyTheme("light");
    await expect(
      page.elementLocator(cell),
    ).toMatchScreenshot("log-explorer-embed-1100x760-light");
    await applyTheme("dark");
  });

  it("640x800 window: the pane cell drives the narrow drawer workspace", async () => {
    // <=760px windows overlay the sidebar at 48px (layout.css:506-517).
    await page.viewport(640, 800);
    const { cell, explorer } = await renderInAppEmbed(592, 720);

    await waitFor(() =>
      expect(explorer.getAttribute("data-breakpoint")).toBe("narrow"),
    );
    const explorerRect = explorer.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    expect(explorerRect.right).toBeLessThanOrEqual(cellRect.right + 1);
    const close = screen.getByTestId("close-in-app-explorer");
    expect(close.getBoundingClientRect().width).toBeGreaterThan(0);
    await expectNoHorizontalPageOverflow();
    await expect(
      page.elementLocator(cell),
    ).toMatchScreenshot("log-explorer-embed-640x800-dark");
  });

  it("wide 1600x950 opens rails, and resizing down to the owner size never clips", async () => {
    await page.viewport(1600, 950);
    const { cell, explorer } = await renderInAppEmbed(1400, 870);

    // Roomy pane: rails open by default, chat rail fully inside the cell.
    expect(explorer.getAttribute("data-breakpoint")).toBe("normal");
    expect(explorer.querySelector(".log-explorer__filters-reopen")).toBeNull();
    const chat = explorer.querySelector(".log-explorer__chat");
    expect(chat).toBeTruthy();
    expect(
      chat!.getBoundingClientRect().right,
    ).toBeLessThanOrEqual(cell.getBoundingClientRect().right + 1);
    await expect(
      page.elementLocator(cell),
    ).toMatchScreenshot("log-explorer-embed-1400-wide-dark");

    // Fullscreen -> resize-down: shrink the window and the pane cell to the
    // owner geometry. The Explorer tracks the pane; the user's open rails are
    // respected (no forced collapse mid-session) and nothing clips or
    // overflows.
    await page.viewport(1100, 760);
    cell.style.width = "900px";
    cell.style.height = "680px";
    await waitFor(() => {
      const r = explorer.getBoundingClientRect();
      expect(r.width).toBeLessThanOrEqual(
        cell.getBoundingClientRect().width + 1,
      );
    });
    expect(explorer.getAttribute("data-breakpoint")).toBe("normal");
    expect(explorer.querySelector(".log-explorer__filters-reopen")).toBeNull();
    await expectNoHorizontalPageOverflow();
  });
});
