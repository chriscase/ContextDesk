/**
 * Private fixtures for visual/log-explorer.test.tsx — DTO builders plus the
 * baseline host-mock state, mirrored from the unit suite's beforeEach
 * (src/components/logExplorer/LogExplorer.test.tsx:661-827) with two
 * deliberate browser-mode differences:
 *   - no Object.defineProperty(window, "innerWidth") stub — the visual suite
 *     drives the REAL viewport (the Explorer's breakpoint comes from a
 *     ResizeObserver on its root element, LogExplorer.tsx:1505-1530);
 *   - no localStorage stub — real Chromium storage is used and cleared by
 *     resetVisualState() between tests.
 *
 * Owned exclusively by the log-explorer visual suite.
 */
import { vi } from "vitest";
import * as host from "../../src/lib/host";
import { ruleContributesToExclusion } from "../../src/lib/logExplorer/policyBinding";

/** Manually-settled promise for holding async host calls open (policy gate). */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** The unit suite's canonical two-event page: 'auth failure' + 'job ok'. */
export function defaultEventPage(): host.EventPageDto {
  return {
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
    nextTs: null,
    totalMatched: 2,
    timeQuality: "wall",
  };
}

export function emptySuppressionDocument(): host.SuppressionDocumentDto {
  return {
    schemaVersion: 1,
    corpusId: "c1",
    revision: 0,
    rules: [],
    previews: [],
    audit: [],
  };
}

/**
 * Derive the trusted lens the host would compute for a policy document
 * (enabled rules resolving matches_current) so the disclosed rule set can
 * never drift from the enforced query set (#819).
 */
export function lensFor(
  document: host.SuppressionDocumentDto,
): host.TrustedSuppressionLensDto {
  const templateIds = [
    ...new Set(
      document.rules
        .filter((rule) =>
          ruleContributesToExclusion(rule.state, rule.resolution ?? null),
        )
        .map((rule) => rule.predicate.templateId),
    ),
  ].sort((a, b) => a - b);
  return {
    corpusId: document.corpusId,
    state: "resolved",
    templateIds,
    policyRevision: document.revision,
    eventRevision: 0,
    templateAnalysisRevision: document.resolvedTemplateRevision ?? 0,
  };
}

export function useSuppressionPolicy(
  document: host.SuppressionDocumentDto,
): void {
  vi.mocked(host.hostLogLoadSuppression).mockResolvedValue(document);
  vi.mocked(host.hostLogSuppressionLens).mockResolvedValue(lensFor(document));
}

const exactCountByQuery = new Map<string, number>();

function exactCountQueryKey(
  corpusId: string,
  query: host.EventQueryDto = {},
): string {
  // Cursor/paging fields are excluded from the count identity (mirrors the
  // unit suite). The void reference keeps the base no-unused-vars config
  // (no ignoreRestSiblings outside src/**) happy with the rest-destructure.
  const { afterSeq, afterTs, beforeSeq, beforeTs, limit, sortByTime, ...rest } =
    query;
  void [afterSeq, afterTs, beforeSeq, beforeTs, limit, sortByTime];
  return JSON.stringify([corpusId, rest]);
}

/**
 * Re-establish the ready-state baseline on every mocked host function a test
 * may have overridden. Call from beforeEach after resetVisualState(). Uses
 * stable mockResolvedValue (never …Once) so real-browser window focus
 * refetches observe the same world.
 */
export function applyBaselineLogExplorerHostMocks(): void {
  vi.clearAllMocks();
  exactCountByQuery.clear();
  vi.mocked(host.hostGetLogCorpus).mockResolvedValue({
    id: "c1",
    name: "fixture",
    eventCount: 10,
    templateCount: 2,
    engine: "duckdb",
    createdAt: 0,
    sourceLabel: null,
    stats: null,
    topTemplates: [],
    embedding: {
      state: "keyword_only",
      modelId: null,
      embeddedTemplates: 0,
      totalTemplates: 2,
      reason: "local_model_unavailable",
      updatedAt: 1,
    },
  });
  vi.mocked(host.hostLogFacets).mockResolvedValue({
    sources: { "api.log": 5, "worker.log": 5 },
    levels: { error: 3, info: 7 },
    services: { api: 5 },
    hosts: {},
    timeQuality: "wall",
  });
  vi.mocked(host.hostLogSourceCatalog).mockResolvedValue({
    sources: [
      { source: "api.log", eventCount: 5 },
      { source: "worker.log", eventCount: 5 },
    ],
    nextCursor: null,
    totalMatched: 2,
  });
  vi.mocked(host.hostLogQueryEvents).mockResolvedValue(defaultEventPage());
  vi.mocked(host.hostLogQueryEventRows).mockImplementation(
    async (requestedCorpusId, query) => {
      const page = await host.hostLogQueryEvents(requestedCorpusId, query);
      exactCountByQuery.set(
        exactCountQueryKey(requestedCorpusId, query),
        page.totalMatched,
      );
      const { totalMatched, ...rows } = page;
      void totalMatched;
      return rows;
    },
  );
  vi.mocked(host.hostLogCountEvents).mockImplementation(
    async (requestedCorpusId, query) => ({
      totalMatched:
        exactCountByQuery.get(exactCountQueryKey(requestedCorpusId, query)) ??
        defaultEventPage().totalMatched,
    }),
  );
  vi.mocked(host.hostLogQueryEventOriginal).mockResolvedValue({
    state: "unavailable",
    reason: "Original representation unavailable for this corpus",
  });
  vi.mocked(host.hostLogListBookmarks).mockResolvedValue([]);
  useSuppressionPolicy(emptySuppressionDocument());
  vi.mocked(host.hostLogProposeNoiseCandidates).mockResolvedValue({
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
  });
  vi.mocked(host.hostLogPreviewTemplateSuppression).mockReset();
  vi.mocked(host.hostLogActivateTemplateSuppression).mockReset();
  vi.mocked(host.hostLogMutateTemplateSuppressionRule).mockReset();
  vi.mocked(host.hostLogLoadActiveInvestigation).mockResolvedValue(null);
  vi.mocked(host.hostListChatModels).mockResolvedValue([
    {
      id: "triage-1",
      label: "triage-1",
      selection_key: "tools-provider::triage-1",
      provider_id: "tools-provider",
      provider_label: "Tools Provider",
      group: "Tools Provider",
      is_default: true,
      tools_enabled: true,
      tools_disabled_reason: null,
      availability: "discovered",
      availability_detail: null,
      hidden: false,
      hidden_by: null,
      pinned_rank: null,
    },
  ]);
  vi.mocked(host.hostLogSearchEvents).mockResolvedValue([]);
  vi.mocked(host.createLogSearchRequestId).mockReturnValue("find-request");
  vi.mocked(host.hostCancelLogSearch).mockResolvedValue(true);
  vi.mocked(host.hostLogSearchEventsAdvanced).mockResolvedValue({
    hits: [],
    partial: false,
    scanned: 0,
  });
  vi.mocked(host.hostLogQueryEventNeighborhood).mockResolvedValue({
    status: "missing",
    events: [],
    totalMatched: 0,
    corpusTotal: 10,
    timeQuality: "wall",
  });
  vi.mocked(host.hostLoadLogTimezoneState).mockResolvedValue({
    corpusId: "c1",
    eventRevision: 0,
    declarations: {},
    sources: [],
  });
  vi.mocked(host.hostPreviewLogSourceTimezone).mockReset();
  vi.mocked(host.hostApplyLogSourceTimezone).mockReset();
  vi.mocked(host.hostClearLogSourceTimezone).mockReset();
  vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue([]);
  vi.mocked(host.hostLoadChatSession).mockResolvedValue(null);
  vi.mocked(host.hostSaveChatSession).mockResolvedValue(null);
  vi.mocked(host.hostSetChatLinkedCorpus).mockImplementation(
    async (sessionId, corpusId, draftSession) => {
      if (!draftSession) return null;
      return host.hostSaveChatSession({
        ...draftSession,
        id: sessionId,
        linked_corpus_id: corpusId,
      });
    },
  );
  vi.mocked(host.agentTurn).mockResolvedValue([]);
  vi.mocked(host.hostTakeLogExplorerNavTarget).mockResolvedValue(null);
}
