import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import checkoutTruth from "../../../../fixtures/log-lab/scenarios/checkout-cascade/truth/manifest.json";
import * as host from "../../lib/host";
import { LogExplorer } from "./LogExplorer";

vi.mock("../../lib/host", () => ({
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
  hostPrepareLogDiagnosticReport: vi.fn(async (manifest) => {
    const actual = await vi.importActual<
      typeof import("../../lib/logDiagnosticReport")
    >("../../lib/logDiagnosticReport");
    return {
      reportId: "cdlogdiag-0000000000000001-0000000000000001",
      markdown: actual.renderLogDiagnosticMarkdown(manifest),
      json: JSON.stringify(manifest, null, 2),
    };
  }),
  hostReleaseLogDiagnosticReport: vi.fn(async () => true),
  hostSaveLogDiagnosticReport: vi.fn(),
  hostSaveChatSession: vi.fn(),
  hostSetChatLinkedCorpus: vi.fn(),
  agentTurn: vi.fn(async () => []),
}));

function eventPage(
  source: string,
  timeQuality: host.TimeQuality,
  eventCount = 1,
  ts = 1_700_000_000,
  totalMatched = eventCount,
): host.EventPageDto {
  return {
    events: Array.from({ length: eventCount }, (_, index) => ({
      seq: Math.abs(
        [...source].reduce((sum, char) => sum + char.charCodeAt(0), 0) * 10 +
          index,
      ),
      ts: ts + index,
      timeQuality,
      level: "info",
      service: "fixture",
      host: null,
      templateId: 1,
      traceId: null,
      message: `${source} event ${index}`,
      source,
    })),
    nextCursor: null,
    nextTs: null,
    totalMatched,
    timeQuality,
  };
}

function defaultEventPage(): host.EventPageDto {
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
    totalMatched: 2,
    timeQuality: "wall",
  };
}

function eventRows(page: host.EventPageDto): host.EventRowsPageDto {
  const { totalMatched: _totalMatched, ...rows } = page;
  return rows;
}

function nonresidentFindEvent(
  seq: number,
  message: string,
): host.ExplorerEventDto {
  return {
    ...defaultEventPage().events[0]!,
    seq,
    ts: 1_700_000_000 + seq,
    message,
    source: "api.log",
  };
}

function findResultFor(
  event: host.ExplorerEventDto,
  options: {
    nextCursor?: number | null;
    nextTs?: number | null;
    totalMatched?: number | null;
  } = {},
): host.EventSearchResultDto {
  return {
    hits: [
      {
        event,
        score: 1,
        matchKind: "keyword",
        templateId: event.templateId,
      },
    ],
    nextCursor: options.nextCursor ?? null,
    nextTs: options.nextTs ?? null,
    totalMatched: options.totalMatched ?? 1,
    partial: false,
    scanned: 1,
  };
}

function foundNeighborhoodFor(
  event: host.ExplorerEventDto,
): Awaited<ReturnType<typeof host.hostLogQueryEventNeighborhood>> {
  return {
    status: "found",
    target: event,
    targetIndex: 0,
    events: [event],
    totalMatched: 1,
    corpusTotal: 10,
    timeQuality: "wall",
    nextCursor: null,
    nextTs: null,
    prevCursor: null,
    prevTs: null,
  };
}

function resolvedInvestigation(
  item: host.InvestigationEvidenceItemDto,
  event: host.ExplorerEventDto,
  status: "verified" | "missing" | "stale" = "verified",
): host.ResolvedInvestigationDocumentDto {
  return {
    document: {
      schemaVersion: 2,
      id: "019fa8d0-0000-7000-8000-000000000001",
      revision: 2,
      title: "Investigation · fixture",
      status: "active",
      corpusLinks: [{ corpusId: "c1" }],
      evidence: [item],
      findings: [],
      notes: [],
      createdAt: 1,
      updatedAt: 2,
    },
    evidence: [
      {
        item,
        references: [
          {
            eventRef: item.eventRefs[0]!,
            status,
            event: status === "missing" ? null : event,
          },
        ],
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const exactCountByQuery = new Map<string, number>();

function exactCountQueryKey(
  corpusId: string,
  query: host.EventQueryDto = {},
): string {
  const {
    afterSeq: _afterSeq,
    afterTs: _afterTs,
    beforeSeq: _beforeSeq,
    beforeTs: _beforeTs,
    limit: _limit,
    sortByTime: _sortByTime,
    ...countQuery
  } = query;
  return JSON.stringify([corpusId, countQuery]);
}

function scrollLaneToEdge(edge: "older" | "newer", laneIndex = 0): HTMLElement {
  const list = screen.getAllByTestId("virtualized-event-list")[laneIndex]!;
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 2_800 },
    scrollTop: {
      configurable: true,
      writable: true,
      value: edge === "older" ? 0 : 2_400,
    },
  });
  fireEvent.scroll(list);
  return list;
}

async function clickFindWhenReady(): Promise<void> {
  const button = screen.getByTestId("log-explorer-find-run");
  await waitFor(() => expect(button).toHaveProperty("disabled", false));
  fireEvent.click(button);
}

function bookmark(id: string, label: string, seq: number): host.LogBookmarkDto {
  return {
    id,
    label,
    note: null,
    seqFrom: seq,
    seqTo: seq,
    createdAt: 1,
    updatedAt: 1,
  };
}

function suppressionDocument(
  state: host.SuppressionRuleState = "enabled",
  revision = 3,
): host.SuppressionDocumentDto {
  return {
    schemaVersion: 1,
    corpusId: "c1",
    revision,
    rules: [
      {
        id: "019fb-noise-rule",
        name: "Routine heartbeat",
        rationale: "Known health-check traffic obscures incident evidence.",
        predicate: {
          templateId: 2,
          templateFingerprint: "template-2-fingerprint",
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
        id: "019fb-audit",
        revision,
        action: state === "enabled" ? "activated" : "disabled",
        ruleId: "019fb-noise-rule",
        previewToken: null,
        createdAt: 2,
      },
    ],
  };
}

function eventNeighborhood(
  target: host.ExplorerEventDto,
  status: host.EventNeighborhoodDto["status"] = "found",
  events: host.ExplorerEventDto[] = status === "found" ? [target] : [],
): host.EventNeighborhoodDto {
  return {
    status,
    target,
    events,
    targetIndex: status === "found" ? events.indexOf(target) : null,
    nextCursor: null,
    nextTs: null,
    prevCursor: null,
    prevTs: null,
    totalMatched: status === "found" ? events.length : 0,
    corpusTotal: Math.max(2, events.length),
    timeQuality: "wall",
  };
}

function openToolbarPicker(testId: string) {
  const trigger = screen.getByTestId(testId);
  if (trigger.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(trigger);
  }
  return trigger;
}

function chooseToolbarOption(testId: string, name: RegExp) {
  openToolbarPicker(testId);
  fireEvent.click(screen.getByRole("menuitemradio", { name }));
}

function chooseLaneCount(count: number) {
  chooseToolbarOption(
    "lane-count-picker",
    new RegExp(`^${count} lane${count === 1 ? "\\b" : "s\\b"}`),
  );
}

function chooseRowMode(mode: "Single line" | "Preview" | "Deep") {
  chooseToolbarOption("row-mode-picker", new RegExp(`^${mode}\\b`));
}

function chooseTimeMode(
  mode: "Independent" | "Follow selection" | "Align exact time",
) {
  chooseToolbarOption("time-link-picker", new RegExp(`^${mode}\\b`));
}

async function openInvestigationView(expectedItems: number) {
  const trigger = await screen.findByRole("button", {
    name: /Investigation workspace view: Chat/,
  });
  fireEvent.click(trigger);
  const option = await waitFor(() =>
    screen.getByRole("menuitemradio", {
      name: new RegExp(`Investigation.*${expectedItems}`),
    }),
  );
  fireEvent.click(option);
}

describe("LogExplorer shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 3840,
    });
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
    });
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
    exactCountByQuery.clear();
    vi.mocked(host.hostLogQueryEventRows).mockImplementation(
      async (requestedCorpusId, query) => {
        const page = await host.hostLogQueryEvents(requestedCorpusId, query);
        exactCountByQuery.set(
          exactCountQueryKey(requestedCorpusId, query),
          page.totalMatched,
        );
        const { totalMatched: _totalMatched, ...rows } = page;
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
    vi.mocked(host.hostLogLoadSuppression).mockResolvedValue({
      schemaVersion: 1,
      corpusId: "c1",
      revision: 0,
      rules: [],
      previews: [],
      audit: [],
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
  });

  it("renders filters, lanes, chat column, splitters, virtualized rows", async () => {
    render(<LogExplorer corpusId="c1" />);
    const root = await screen.findByTestId("log-explorer");
    expect(root).toBeTruthy();
    expect(root.getAttribute("data-resizable")).toBe("true");
    const identity = await screen.findByLabelText("Log Explorer for fixture");
    expect(within(identity).getByText("Log Explorer")).toBeTruthy();
    expect(within(identity).getByTitle("fixture")).toBeTruthy();
    expect(
      screen.getByTestId("log-explorer-global-counts").textContent,
    ).not.toContain("normal");
    expect(screen.getByTestId("log-explorer-filters")).toBeTruthy();
    expect(screen.getByTestId("log-explorer-lanes")).toBeTruthy();
    expect(screen.getByTestId("log-explorer-chat")).toBeTruthy();
    expect(screen.getByTestId("log-explorer-chat-thread")).toBeTruthy();
    expect(screen.getByTestId("log-explorer-chat-composer")).toBeTruthy();
    expect(screen.getByTestId("log-explorer-bookmarks")).toBeTruthy();
    expect(screen.getByTestId("linked-chat-header")).toBeTruthy();
    expect(screen.getByTestId("linked-chat-agent-context")).toBeTruthy();
    // Raw brief dump is developer-only; product surface is the structured disclosure.
    expect(screen.queryByTestId("log-explorer-view-context")).toBeNull();
    // Events load via virtualized list
    expect(await screen.findByText(/auth failure/)).toBeTruthy();
    const vlist = screen.getAllByTestId("virtualized-event-list")[0]!;
    expect(vlist.getAttribute("data-virtualized")).toBe("true");
    expect(within(vlist).getByText("api.log")).toBeTruthy();
    expect(within(vlist).getByText("worker.log")).toBeTruthy();
    expect(root.getAttribute("data-lane-count")).toBe("1");
    expect(screen.getByText(/Keyword-only corpus/)).toBeTruthy();
  });

  it("loads the durable noise policy before issuing any evidence query", async () => {
    const policy = deferred<host.SuppressionDocumentDto>();
    vi.mocked(host.hostLogLoadSuppression).mockReturnValue(policy.promise);

    render(<LogExplorer corpusId="c1" />);

    expect(
      await screen.findByText("Loading noise policy before evidence…"),
    ).toBeTruthy();
    expect(host.hostLogQueryEventRows).not.toHaveBeenCalled();
    expect(host.hostLogFacets).not.toHaveBeenCalled();
    expect(host.hostLogSearchEventsAdvanced).not.toHaveBeenCalled();
    expect(screen.queryByText(/auth failure/)).toBeNull();

    await act(async () => {
      policy.resolve({
        schemaVersion: 1,
        corpusId: "c1",
        revision: 0,
        rules: [],
        previews: [],
        audit: [],
      });
      await policy.promise;
    });

    expect(await screen.findByText(/auth failure/)).toBeTruthy();
    expect(screen.queryByTestId("noise-policy-gate")).toBeNull();
  });

  it("fails closed with a visible retry when the noise policy is unavailable", async () => {
    vi.mocked(host.hostLogLoadSuppression)
      .mockRejectedValueOnce(new Error("policy sidecar unreadable"))
      .mockResolvedValueOnce({
        schemaVersion: 1,
        corpusId: "c1",
        revision: 0,
        rules: [],
        previews: [],
        audit: [],
      });

    render(<LogExplorer corpusId="c1" />);

    expect(
      await screen.findByText(
        /Evidence is withheld.*policy sidecar unreadable/,
      ),
    ).toBeTruthy();
    expect(host.hostLogQueryEventRows).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry policy" }));
    expect(await screen.findByText(/auth failure/)).toBeTruthy();
  });

  it("applies one suppression lens to rows, counts, facets, timeline, and Find", async () => {
    vi.mocked(host.hostLogLoadSuppression).mockResolvedValue(
      suppressionDocument(),
    );
    vi.mocked(host.hostLogCountEvents).mockImplementation(
      async (_corpusId, query) => ({
        totalMatched: query?.templateIds?.includes(2) ? 4 : 1,
      }),
    );

    render(<LogExplorer corpusId="c1" />);

    await waitFor(() => expect(host.hostLogQueryEventRows).toHaveBeenCalled());
    const rowQuery = vi
      .mocked(host.hostLogQueryEventRows)
      .mock.calls.at(-1)?.[1];
    expect(rowQuery?.excludedTemplateIds).toEqual([2]);

    await waitFor(() => expect(host.hostLogFacets).toHaveBeenCalled());
    expect(
      vi.mocked(host.hostLogFacets).mock.calls.at(-1)?.[1]?.excludedTemplateIds,
    ).toEqual([2]);

    await waitFor(() =>
      expect(host.hostLogSharedTimelineSummary).toHaveBeenCalled(),
    );
    expect(
      vi.mocked(host.hostLogSharedTimelineSummary).mock.calls.at(-1)?.[1]
        ?.excludedTemplateIds,
    ).toEqual([2]);

    expect(
      await screen.findByRole("button", {
        name: "Noise · 1 rule · 4 hidden",
      }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Find in logs"), {
      target: { value: "failure" },
    });
    await clickFindWhenReady();
    await waitFor(() =>
      expect(host.hostLogSearchEventsAdvanced).toHaveBeenCalled(),
    );
    expect(
      vi.mocked(host.hostLogSearchEventsAdvanced).mock.calls.at(-1)?.[1]?.filter
        ?.excludedTemplateIds,
    ).toEqual([2]);
  });

  it("previews and confirms a human suppression before atomically refreshing evidence", async () => {
    const emptyPolicy: host.SuppressionDocumentDto = {
      schemaVersion: 1,
      corpusId: "c1",
      revision: 0,
      rules: [],
      previews: [],
      audit: [],
    };
    vi.mocked(host.hostLogLoadSuppression)
      .mockResolvedValueOnce(emptyPolicy)
      .mockResolvedValue(suppressionDocument());
    vi.mocked(host.hostLogQueryEvents).mockImplementation(
      async (_corpusId, query) => {
        const excluded = query?.excludedTemplateIds ?? [];
        const events = defaultEventPage().events.filter(
          (event) => !excluded.includes(event.templateId),
        );
        return {
          ...defaultEventPage(),
          events,
          totalMatched: events.length,
        };
      },
    );
    vi.mocked(host.hostLogCountEvents).mockImplementation(
      async (_corpusId, query) => ({
        totalMatched: query?.templateIds?.includes(2) ? 1 : 1,
      }),
    );
    vi.mocked(host.hostLogPreviewTemplateSuppression).mockResolvedValue({
      token: "preview-token",
      corpusId: "c1",
      eventRevision: 4,
      ruleRevision: 0,
      name: "Routine worker completion",
      rationale: "Expected completion chatter during this incident.",
      predicate: {
        templateId: 2,
        templateFingerprint: "template-2-fingerprint",
      },
      origin: "human",
      matchingEventCount: 1,
      incrementalEventCount: 1,
      corpusEventCount: 10,
      levelCounts: [{ level: "info", count: 1 }],
      sourceCount: 1,
      timeSpan: { from: 1_700_000_001, to: 1_700_000_001 },
      representatives: [
        {
          seq: 2,
          source: "worker.log",
          timestamp: 1_700_000_001,
          timeQuality: "wall",
          level: "info",
          redactedExcerpt: "job ok",
        },
      ],
      createdAt: 3,
    });
    vi.mocked(host.hostLogActivateTemplateSuppression).mockResolvedValue({
      revision: 3,
      rule: suppressionDocument().rules[0]!,
    });

    render(<LogExplorer corpusId="c1" />);
    fireEvent.click(await screen.findByText("job ok"));
    const inspector = await screen.findByTestId("log-explorer-detail");
    fireEvent.click(
      within(inspector).getByRole("button", {
        name: "Suppress template…",
      }),
    );
    fireEvent.change(screen.getByLabelText("Rule name"), {
      target: { value: "Routine worker completion" },
    });
    fireEvent.change(screen.getByLabelText("Rationale (required)"), {
      target: {
        value: "Expected completion chatter during this incident.",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));
    expect(await screen.findByText(/10.0% of raw corpus/)).toBeTruthy();
    expect(host.hostLogActivateTemplateSuppression).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm suppression" }),
    );
    await waitFor(() =>
      expect(host.hostLogActivateTemplateSuppression).toHaveBeenCalledWith(
        "c1",
        0,
        "preview-token",
      ),
    );
    await waitFor(() => expect(screen.queryByText("job ok")).toBeNull());
    expect(
      await screen.findByRole("button", {
        name: "Noise · 1 rule · 1 hidden",
      }),
    ).toBeTruthy();
    expect(
      vi
        .mocked(host.hostLogQueryEventRows)
        .mock.calls.some(([, query]) =>
          query?.excludedTemplateIds?.includes(2),
        ),
    ).toBe(true);
  });

  it("loads first evidence rows before starting large-corpus facet aggregation", async () => {
    const firstPage = deferred<host.EventPageDto>();
    const facetPage = deferred<host.LogFacetsDto>();
    let evidenceVisibleWhenFacetsStarted = false;
    vi.mocked(host.hostLogQueryEvents).mockReturnValue(firstPage.promise);
    vi.mocked(host.hostLogFacets).mockImplementation(() => {
      evidenceVisibleWhenFacetsStarted =
        screen.queryByText(/auth failure/) != null;
      return facetPage.promise;
    });

    render(<LogExplorer corpusId="c1" />);

    await waitFor(() =>
      expect(host.hostLogQueryEvents).toHaveBeenCalledTimes(1),
    );
    expect(host.hostLogFacets).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Loading first evidence rows…"),
    ).toBeTruthy();
    expect(screen.getByTestId("log-explorer-facets-loading")).toBeTruthy();

    await act(async () => {
      firstPage.resolve(defaultEventPage());
      await firstPage.promise;
    });

    expect(await screen.findByText(/auth failure/)).toBeTruthy();
    await waitFor(() => expect(host.hostLogFacets).toHaveBeenCalledTimes(1));
    expect(evidenceVisibleWhenFacetsStarted).toBe(true);
    expect(screen.getByTestId("log-explorer-facets-loading")).toBeTruthy();

    await act(async () => {
      facetPage.resolve({
        sources: { "api.log": 5, "worker.log": 5 },
        levels: { error: 3, info: 7 },
        services: { api: 5 },
        hosts: {},
        timeQuality: "wall",
      });
      await facetPage.promise;
    });
    await waitFor(() =>
      expect(screen.queryByTestId("log-explorer-facets-loading")).toBeNull(),
    );
  });

  it("paints bounded rows and clears evidence busy before exact counting begins or finishes", async () => {
    const rowPage = deferred<host.EventRowsPageDto>();
    const countPage = deferred<host.EventCountDto>();
    let evidenceVisibleWhenCountStarted = false;
    vi.mocked(host.hostLogQueryEventRows).mockReturnValue(rowPage.promise);
    vi.mocked(host.hostLogCountEvents).mockImplementation(() => {
      evidenceVisibleWhenCountStarted =
        screen.queryByText(/auth failure/) != null;
      return countPage.promise;
    });

    render(<LogExplorer corpusId="c1" />);

    await waitFor(() =>
      expect(host.hostLogQueryEventRows).toHaveBeenCalledTimes(1),
    );
    expect(host.hostLogCountEvents).not.toHaveBeenCalled();
    expect(screen.getByText("Loading first evidence rows…")).toBeTruthy();

    await act(async () => {
      rowPage.resolve(eventRows(defaultEventPage()));
      await rowPage.promise;
    });

    expect(await screen.findByText(/auth failure/)).toBeTruthy();
    expect(screen.queryByText("Loading first evidence rows…")).toBeNull();
    expect(screen.getByTestId("lane-count-lane-0").textContent).toContain(
      "counting matches… · 2 resident",
    );
    await waitFor(() =>
      expect(host.hostLogCountEvents).toHaveBeenCalledTimes(1),
    );
    expect(evidenceVisibleWhenCountStarted).toBe(true);
    expect(screen.getByTestId("lane-count-lane-0").textContent).toContain(
      "counting matches… · 2 resident",
    );

    await act(async () => {
      countPage.resolve({ totalMatched: 37 });
      await countPage.promise;
    });
    await waitFor(() =>
      expect(screen.getByTestId("lane-count-lane-0").textContent).toContain(
        "37 matched · 2 resident",
      ),
    );
  });

  it("ignores an exact count from an obsolete corpus lifecycle", async () => {
    const counts = {
      c1: deferred<host.EventCountDto>(),
      c2: deferred<host.EventCountDto>(),
    };
    vi.mocked(host.hostLogQueryEventRows).mockImplementation(
      async (requestedCorpusId) => {
        const base = defaultEventPage();
        const event = {
          ...base.events[0]!,
          seq: requestedCorpusId === "c1" ? 101 : 202,
          source: `${requestedCorpusId}.log`,
          message:
            requestedCorpusId === "c1"
              ? "obsolete corpus row"
              : "current corpus row",
        };
        return eventRows({ ...base, events: [event], totalMatched: 1 });
      },
    );
    vi.mocked(host.hostLogCountEvents).mockImplementation(
      (requestedCorpusId) => counts[requestedCorpusId as "c1" | "c2"].promise,
    );

    const view = render(<LogExplorer corpusId="c1" />);
    expect(await screen.findByText("obsolete corpus row")).toBeTruthy();
    await waitFor(() =>
      expect(host.hostLogCountEvents).toHaveBeenCalledWith(
        "c1",
        expect.anything(),
      ),
    );

    view.rerender(<LogExplorer corpusId="c2" />);
    expect(await screen.findByText("current corpus row")).toBeTruthy();
    await waitFor(() =>
      expect(host.hostLogCountEvents).toHaveBeenCalledWith(
        "c2",
        expect.anything(),
      ),
    );

    await act(async () => {
      counts.c2.resolve({ totalMatched: 22 });
      await counts.c2.promise;
    });
    await waitFor(() =>
      expect(screen.getByTestId("lane-count-lane-0").textContent).toContain(
        "22 matched",
      ),
    );

    await act(async () => {
      counts.c1.resolve({ totalMatched: 999 });
      await counts.c1.promise;
    });
    expect(screen.getByText("current corpus row")).toBeTruthy();
    expect(screen.getByTestId("lane-count-lane-0").textContent).toContain(
      "22 matched",
    );
    expect(screen.getByTestId("lane-count-lane-0").textContent).not.toContain(
      "999 matched",
    );
  });

  it("clears prior-corpus evidence and inspector before the next corpus resolves", async () => {
    const nextPage = deferred<host.EventRowsPageDto>();
    vi.mocked(host.hostLogQueryEventRows).mockImplementation(
      async (requestedCorpusId) => {
        if (requestedCorpusId === "c2") return nextPage.promise;
        const base = defaultEventPage();
        return eventRows({
          ...base,
          events: [
            {
              ...base.events[0]!,
              seq: 101,
              source: "c1.log",
              message: "private evidence from prior corpus",
            },
          ],
        });
      },
    );

    const view = render(<LogExplorer corpusId="c1" />);
    fireEvent.click(
      await screen.findByText("private evidence from prior corpus"),
    );
    expect(await screen.findByTestId("log-explorer-detail")).toBeTruthy();

    view.rerender(<LogExplorer corpusId="c2" />);
    expect(screen.queryByText("private evidence from prior corpus")).toBeNull();
    expect(screen.queryByTestId("log-explorer-detail")).toBeNull();
    expect(screen.getByText("Loading first evidence rows…")).toBeTruthy();

    const base = defaultEventPage();
    await act(async () => {
      nextPage.resolve(
        eventRows({
          ...base,
          events: [
            {
              ...base.events[0]!,
              seq: 202,
              source: "c2.log",
              message: "current corpus evidence",
            },
          ],
        }),
      );
      await nextPage.promise;
    });
    expect(await screen.findByText("current corpus evidence")).toBeTruthy();
  });

  it("resolves visible lane counts independently without inventing a global total", async () => {
    const laneCounts = {
      "a.log": deferred<host.EventCountDto>(),
      "b.log": deferred<host.EventCountDto>(),
      "c.log": deferred<host.EventCountDto>(),
    };
    let multiLaneView = false;
    vi.mocked(host.hostLogQueryEventRows).mockImplementation(
      async (_requestedCorpusId, query) => {
        const source = query?.sources?.[0] ?? "all.log";
        const rows =
          source === "c.log"
            ? eventPage(source, "wall", 0, 1_700_000_200, 0)
            : eventPage(source, "wall", 1);
        return eventRows(rows);
      },
    );
    vi.mocked(host.hostLogCountEvents).mockImplementation(
      async (_requestedCorpusId, query) => {
        const source = query?.sources?.[0] ?? "all.log";
        if (!multiLaneView) return { totalMatched: 13 };
        return laneCounts[source as keyof typeof laneCounts].promise;
      },
    );
    localStorage.setItem(
      "contextdesk.logExplorer.lanes.v1:c1",
      JSON.stringify([
        { id: "lane-0", label: "API", sources: ["a.log"] },
        { id: "lane-1", label: "Worker", sources: ["b.log"] },
        { id: "lane-2", label: "Empty", sources: ["c.log"] },
      ]),
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByText("a.log event 0");
    await waitFor(() =>
      expect(screen.getByTestId("lane-count-lane-0").textContent).toContain(
        "13 matched",
      ),
    );

    multiLaneView = true;
    chooseLaneCount(3);
    await waitFor(() =>
      expect(document.querySelectorAll("[data-lane-id]")).toHaveLength(3),
    );
    await waitFor(() =>
      expect(host.hostLogCountEvents).toHaveBeenCalledTimes(4),
    );
    expect(screen.getByTestId("lane-count-lane-0").textContent).toContain(
      "counting matches…",
    );

    await act(async () => {
      laneCounts["b.log"].resolve({ totalMatched: 7 });
      await laneCounts["b.log"].promise;
    });
    await waitFor(() =>
      expect(screen.getByTestId("lane-count-lane-1").textContent).toContain(
        "7 matched · 1 resident",
      ),
    );
    expect(screen.getByTestId("lane-count-lane-0").textContent).toContain(
      "counting matches…",
    );

    await act(async () => {
      laneCounts["a.log"].resolve({ totalMatched: 13 });
      laneCounts["c.log"].resolve({ totalMatched: 0 });
      await Promise.all([
        laneCounts["a.log"].promise,
        laneCounts["c.log"].promise,
      ]);
    });
    expect(screen.getByTestId("lane-count-lane-0").textContent).toContain(
      "13 matched · 1 resident",
    );
    expect(screen.getByTestId("lane-count-lane-2").textContent).toContain(
      "0 matched · 0 resident",
    );
    expect(
      screen.getByTestId("log-explorer-global-counts").textContent,
    ).toContain("3 lane queries");
    expect(screen.getByTestId("log-explorer-count-truth").textContent).toMatch(
      /matched per lane below · resident rows 2/,
    );
  });

  it("uses row-only pagination in both directions without recounting", async () => {
    const pageEvent = (
      seq: number,
      message: string,
    ): host.ExplorerEventDto => ({
      ...defaultEventPage().events[0]!,
      seq,
      ts: 1_700_000_000 + seq,
      message,
    });
    vi.mocked(host.hostLogQueryEventRows).mockImplementation(
      async (_requestedCorpusId, query) => {
        if (query?.beforeSeq === 101) {
          return {
            events: [pageEvent(99, "row-only older")],
            prevCursor: null,
            prevTs: null,
            nextCursor: 100,
            nextTs: 1_700_000_100,
            timeQuality: "wall",
          };
        }
        if (query?.afterSeq === 102) {
          return {
            events: [pageEvent(103, "row-only newer")],
            prevCursor: 103,
            prevTs: 1_700_000_103,
            nextCursor: null,
            nextTs: null,
            timeQuality: "wall",
          };
        }
        return {
          events: [
            pageEvent(101, "row-only middle 101"),
            pageEvent(102, "row-only middle 102"),
          ],
          prevCursor: 101,
          prevTs: 1_700_000_101,
          nextCursor: 102,
          nextTs: 1_700_000_102,
          timeQuality: "wall",
        };
      },
    );
    vi.mocked(host.hostLogCountEvents).mockResolvedValue({ totalMatched: 6 });

    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    render(<LogExplorer corpusId="c1" />);
    await screen.findByText("row-only middle 101");
    await waitFor(() =>
      expect(host.hostLogCountEvents).toHaveBeenCalledTimes(1),
    );

    scrollLaneToEdge("older");
    expect(await screen.findByText("row-only older")).toBeTruthy();
    clock.mockReturnValue(1_300);
    scrollLaneToEdge("newer");
    expect(await screen.findByText("row-only newer")).toBeTruthy();

    expect(host.hostLogQueryEventRows).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        beforeSeq: 101,
        beforeTs: 1_700_000_101,
      }),
    );
    expect(host.hostLogQueryEventRows).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        afterSeq: 102,
        afterTs: 1_700_000_102,
      }),
    );
    expect(host.hostLogCountEvents).toHaveBeenCalledTimes(1);
    expect(host.hostLogQueryEvents).not.toHaveBeenCalled();
    clock.mockRestore();
  });

  it("defers bookmark and Investigation metadata until first evidence rows paint", async () => {
    const firstPage = deferred<host.EventPageDto>();
    const bookmarkPage = deferred<host.LogBookmarkDto[]>();
    const investigationPage =
      deferred<host.ResolvedInvestigationDocumentDto | null>();
    let evidenceVisibleWhenBookmarksStarted = false;
    let evidenceVisibleWhenInvestigationStarted = false;
    vi.mocked(host.hostLogQueryEvents).mockReturnValue(firstPage.promise);
    vi.mocked(host.hostLogListBookmarks).mockImplementation(() => {
      evidenceVisibleWhenBookmarksStarted =
        screen.queryByText(/auth failure/) != null;
      return bookmarkPage.promise;
    });
    vi.mocked(host.hostLogLoadActiveInvestigation).mockImplementation(() => {
      evidenceVisibleWhenInvestigationStarted =
        screen.queryByText(/auth failure/) != null;
      return investigationPage.promise;
    });

    render(<LogExplorer corpusId="c1" />);

    await waitFor(() =>
      expect(host.hostLogQueryEvents).toHaveBeenCalledTimes(1),
    );
    expect(host.hostLogListBookmarks).not.toHaveBeenCalled();
    expect(host.hostLogLoadActiveInvestigation).not.toHaveBeenCalled();
    expect(screen.getByTestId("log-explorer-bookmarks-deferred")).toBeTruthy();

    await act(async () => {
      firstPage.resolve(defaultEventPage());
      await firstPage.promise;
    });

    expect(await screen.findByText(/auth failure/)).toBeTruthy();
    await waitFor(() => {
      expect(host.hostLogListBookmarks).toHaveBeenCalledTimes(1);
      expect(host.hostLogLoadActiveInvestigation).toHaveBeenCalledTimes(1);
    });
    expect(evidenceVisibleWhenBookmarksStarted).toBe(true);
    expect(evidenceVisibleWhenInvestigationStarted).toBe(true);
    expect(screen.getByTestId("log-explorer-bookmarks-loading")).toBeTruthy();
    expect(
      screen.getAllByTestId("log-explorer-investigation-loading").length,
    ).toBeGreaterThan(0);

    await act(async () => {
      bookmarkPage.resolve([]);
      investigationPage.resolve(null);
      await Promise.all([bookmarkPage.promise, investigationPage.promise]);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("log-explorer-bookmarks-loading")).toBeNull();
      expect(
        screen.queryAllByTestId("log-explorer-investigation-loading"),
      ).toHaveLength(0);
    });
    expect(screen.getByText("None yet — select rows + B")).toBeTruthy();
  });

  it("keeps metadata scoped to the latest corpus without rewriting host activation", async () => {
    const summaries = {
      c1: deferred<host.LogCorpusSummaryDto | null>(),
      c2: deferred<host.LogCorpusSummaryDto | null>(),
    };
    const bookmarkPages = {
      c1: deferred<host.LogBookmarkDto[]>(),
      c2: deferred<host.LogBookmarkDto[]>(),
    };
    const investigationPages = {
      c1: deferred<host.ResolvedInvestigationDocumentDto | null>(),
      c2: deferred<host.ResolvedInvestigationDocumentDto | null>(),
    };
    const c1Event = {
      ...defaultEventPage().events[0]!,
      message: "corpus one evidence",
      source: "one.log",
    };
    const c2Event = {
      ...defaultEventPage().events[0]!,
      seq: 2,
      message: "corpus two evidence",
      source: "two.log",
    };
    const investigationFor = (
      corpus: "c1" | "c2",
      event: host.ExplorerEventDto,
      title: string,
    ): host.ResolvedInvestigationDocumentDto => {
      const item: host.InvestigationEvidenceItemDto = {
        id: `${corpus}-evidence`,
        title,
        provenance: "human",
        corpusId: corpus,
        eventRefs: [
          {
            corpusId: corpus,
            seq: event.seq,
            source: event.source,
            timestampHint: event.ts,
            timeQualityHint: event.timeQuality,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      };
      const resolved = resolvedInvestigation(item, event);
      return {
        ...resolved,
        document: {
          ...resolved.document,
          id: `${corpus}-investigation`,
          title: `Investigation · ${corpus}`,
          corpusLinks: [{ corpusId: corpus }],
        },
      };
    };

    vi.mocked(host.hostGetLogCorpus).mockImplementation(
      (corpus) => summaries[corpus as "c1" | "c2"].promise,
    );
    vi.mocked(host.hostLogQueryEvents).mockImplementation(async (corpus) => ({
      ...defaultEventPage(),
      events: [corpus === "c1" ? c1Event : c2Event],
      totalMatched: 1,
    }));
    vi.mocked(host.hostLogListBookmarks).mockImplementation(
      (corpus) => bookmarkPages[corpus as "c1" | "c2"].promise,
    );
    vi.mocked(host.hostLogLoadActiveInvestigation).mockImplementation(
      (corpus) => investigationPages[corpus as "c1" | "c2"].promise,
    );

    const view = render(<LogExplorer corpusId="c1" />);
    expect(await screen.findByText(c1Event.message)).toBeTruthy();
    await waitFor(() =>
      expect(host.hostLogListBookmarks).toHaveBeenCalledWith("c1"),
    );

    view.rerender(<LogExplorer corpusId="c2" />);
    expect(await screen.findByText(c2Event.message)).toBeTruthy();
    await waitFor(() => {
      expect(host.hostLogListBookmarks).toHaveBeenCalledWith("c2");
      expect(host.hostLogLoadActiveInvestigation).toHaveBeenCalledWith("c2");
    });

    await act(async () => {
      summaries.c2.resolve({
        id: "c2",
        name: "new corpus",
        eventCount: 20,
        templateCount: 2,
        engine: "duckdb",
        createdAt: 2,
        sourceLabel: null,
        stats: null,
        topTemplates: [],
      });
      bookmarkPages.c2.resolve([bookmark("bm-c2", "new bookmark", 2)]);
      investigationPages.c2.resolve(
        investigationFor("c2", c2Event, "new investigation evidence"),
      );
      await Promise.all([
        summaries.c2.promise,
        bookmarkPages.c2.promise,
        investigationPages.c2.promise,
      ]);
    });

    expect(
      await screen.findByLabelText("Log Explorer for new corpus"),
    ).toBeTruthy();
    expect(await screen.findByTestId("bookmark-activate-bm-c2")).toBeTruthy();
    await openInvestigationView(2);
    expect(await screen.findByText("new investigation evidence")).toBeTruthy();

    await act(async () => {
      summaries.c1.resolve({
        id: "c1",
        name: "stale corpus",
        eventCount: 10,
        templateCount: 1,
        engine: "duckdb",
        createdAt: 1,
        sourceLabel: null,
        stats: null,
        topTemplates: [],
      });
      bookmarkPages.c1.resolve([bookmark("bm-c1", "stale bookmark", 1)]);
      investigationPages.c1.resolve(
        investigationFor("c1", c1Event, "stale investigation evidence"),
      );
      await Promise.all([
        summaries.c1.promise,
        bookmarkPages.c1.promise,
        investigationPages.c1.promise,
      ]);
    });

    expect(screen.getByLabelText("Log Explorer for new corpus")).toBeTruthy();
    expect(screen.getByTestId("bookmark-activate-bm-c2")).toBeTruthy();
    expect(screen.getByText("new investigation evidence")).toBeTruthy();
    expect(screen.queryByTestId("bookmark-activate-bm-c1")).toBeNull();
    expect(screen.queryByText("stale investigation evidence")).toBeNull();
    expect(host.hostSetActiveLogCorpus).not.toHaveBeenCalled();
  });

  it("keeps summary, bookmark, and Investigation load failures independent from evidence rows", async () => {
    vi.mocked(host.hostGetLogCorpus).mockRejectedValue(
      new Error("summary unavailable"),
    );
    vi.mocked(host.hostLogListBookmarks).mockRejectedValue(
      new Error("bookmark store unavailable"),
    );
    vi.mocked(host.hostLogLoadActiveInvestigation).mockRejectedValue(
      new Error("investigation store unavailable"),
    );

    render(<LogExplorer corpusId="c1" />);

    expect(await screen.findByText(/auth failure/)).toBeTruthy();
    expect(
      (await screen.findByTestId("log-explorer-summary-load-error"))
        .textContent,
    ).toContain("Corpus details unavailable");
    expect(
      (await screen.findByTestId("log-explorer-bookmarks-load-error"))
        .textContent,
    ).toContain("Bookmarks unavailable");
    expect(
      (await screen.findAllByTestId("log-explorer-investigation-load-error"))
        .length,
    ).toBeGreaterThan(0);
    expect(screen.getByTestId("virtualized-event-list")).toBeTruthy();
  });

  it("exports a bounded active-view diagnostic without payload, source, filter text, chats, or models", async () => {
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<LogExplorer corpusId="c1" />);
    await screen.findByText(/auth failure/);

    fireEvent.change(screen.getByLabelText("Filter logs"), {
      target: { value: "customer-private-filter" },
    });
    fireEvent.click(screen.getByTestId("log-explorer-filter-apply"));
    fireEvent.click(screen.getByText(/auth failure/));

    const trigger = screen.getByRole("button", {
      name: "Export diagnostics…",
    });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", {
      name: "Export corpus diagnostics",
    });
    await waitFor(() =>
      expect(
        within(dialog).getByLabelText("Markdown diagnostic preview")
          .textContent,
      ).toContain("Active Explorer view (payload-free)"),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Copy Markdown" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = String(writeText.mock.calls[0]?.[0]);
    expect(copied).toContain("Active Explorer view (payload-free)");
    expect(copied).toContain("Selected seqs (bounded): 1");
    expect(copied).toContain("Filter values withheld: keyword present");
    for (const forbidden of [
      "customer-private-filter",
      "auth failure",
      "api.log",
      "worker.log",
      "triage-1",
      "Tools Provider",
    ]) {
      expect(copied).not.toContain(forbidden);
    }

    fireEvent.click(within(dialog).getByRole("button", { name: "JSON" }));
    const json = within(dialog).getByLabelText(
      "JSON diagnostic preview",
    ).textContent;
    expect(json).toContain('"activeView"');
    expect(json).toContain('"sourceCount": 0');
    expect(json).not.toContain("customer-private-filter");

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("moves the timeline cursor with the visible log viewport without backend work", async () => {
    vi.mocked(host.hostLogQueryEvents).mockResolvedValue(
      eventPage("api.log", "wall", 10, 1_700_000_000),
    );
    vi.mocked(host.hostLogSharedTimelineSummary).mockResolvedValue({
      timeQuality: "wall",
      spanFrom: 1_700_000_000,
      spanTo: 1_700_000_010,
      bucketWidth: 1,
      bucketCount: 10,
      totalMatched: 10,
      buckets: Array.from({ length: 10 }, (_, index) => ({
        index,
        start: 1_700_000_000 + index,
        end: 1_700_000_001 + index,
      })),
      counts: Array.from({ length: 10 }, () => 1),
      severitySeries: [
        { severity: "error", counts: Array.from({ length: 10 }, () => 0) },
        { severity: "warn", counts: Array.from({ length: 10 }, () => 0) },
        { severity: "info", counts: Array.from({ length: 10 }, () => 1) },
        { severity: "debug", counts: Array.from({ length: 10 }, () => 0) },
        { severity: "other", counts: Array.from({ length: 10 }, () => 0) },
      ],
      lanes: [],
    });

    render(<LogExplorer corpusId="c1" />);
    const list = await screen.findByTestId("virtualized-event-list");
    const bars = await screen.findByTestId("timeline-navigator-bars");
    await waitFor(() =>
      expect(
        bars.querySelector<HTMLElement>(".timeline-navigator__preview-marker")
          ?.style.left,
      ).toBe("0%"),
    );
    const queryCalls = vi.mocked(host.hostLogQueryEvents).mock.calls.length;
    const summaryCalls = vi.mocked(host.hostLogSharedTimelineSummary).mock.calls
      .length;
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 56 },
      scrollHeight: { configurable: true, value: 280 },
      scrollTop: { configurable: true, writable: true, value: 112 },
    });
    fireEvent.scroll(list);

    await waitFor(() =>
      expect(
        bars.querySelector<HTMLElement>(".timeline-navigator__preview-marker")
          ?.style.left,
      ).toBe("40%"),
    );
    expect(host.hostLogQueryEvents).toHaveBeenCalledTimes(queryCalls);
    expect(host.hostLogSharedTimelineSummary).toHaveBeenCalledTimes(
      summaryCalls,
    );
  });

  it("uses descriptive keyboard-accessible toolbar pickers with truthful dismissal", async () => {
    render(<LogExplorer corpusId="c1" />);
    await screen.findByText(/auth failure/);

    const timeTrigger = openToolbarPicker("time-link-picker");
    const timeMenu = screen.getByRole("menu", { name: "Time options" });
    expect(
      within(timeMenu).getByText(
        "Selecting an event seeks each lane to its nearest time.",
      ),
    ).toBeTruthy();
    const independent = within(timeMenu).getByRole("menuitemradio", {
      name: /^Independent\b/,
    });
    const follow = within(timeMenu).getByRole("menuitemradio", {
      name: /^Follow selection\b/,
    });
    await waitFor(() => expect(document.activeElement).toBe(independent));
    fireEvent.keyDown(independent, { key: "ArrowDown" });
    expect(document.activeElement).toBe(follow);
    fireEvent.keyDown(follow, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(timeTrigger));
    expect(screen.queryByRole("menu", { name: "Time options" })).toBeNull();

    openToolbarPicker("row-mode-picker");
    expect(screen.getByRole("menu", { name: "Rows options" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("log-explorer-lanes"));
    expect(screen.queryByRole("menu", { name: "Rows options" })).toBeNull();

    chooseRowMode("Deep");
    expect(screen.getByTestId("row-mode-picker").textContent).toContain("Deep");

    const columnsTrigger = screen.getByTestId("columns-menu");
    fireEvent.click(columnsTrigger);
    const autoFit = screen.getByRole("menuitem", {
      name: /^Auto-fit columns\b/,
    });
    const reset = screen.getByRole("menuitem", {
      name: /^Reset columns\b/,
    });
    await waitFor(() => expect(document.activeElement).toBe(autoFit));
    fireEvent.keyDown(autoFit, { key: "ArrowDown" });
    expect(document.activeElement).toBe(reset);
    fireEvent.keyDown(reset, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(columnsTrigger));
  });

  it("starts new investigations with compact payload-first rows", async () => {
    render(<LogExplorer corpusId="c1" />);
    await screen.findByText(/auth failure/);

    const root = screen.getByTestId("log-explorer");
    expect(root.getAttribute("data-metadata-presentation")).toBe("compact");
    expect(root.getAttribute("data-field-emphasis")).toBe("payload");
    expect(screen.getByTestId("row-mode-picker").textContent).toContain(
      "Payload",
    );
    const firstList = screen.getAllByTestId("virtualized-event-list")[0]!;
    expect(firstList.getAttribute("data-metadata-presentation")).toBe(
      "compact",
    );
    expect(firstList.getAttribute("data-field-emphasis")).toBe("payload");
    expect(firstList.querySelector("[data-level-token]")).toBeTruthy();
  });

  it("keeps explicit metadata and field-emphasis choices inside Rows and persists them", async () => {
    const first = render(<LogExplorer corpusId="c1" />);
    await screen.findByText(/auth failure/);

    openToolbarPicker("row-mode-picker");
    fireEvent.change(screen.getByLabelText("Row metadata presentation"), {
      target: { value: "standard" },
    });
    fireEvent.change(screen.getByLabelText("Row field emphasis"), {
      target: { value: "metadata" },
    });

    const root = screen.getByTestId("log-explorer");
    expect(root.getAttribute("data-metadata-presentation")).toBe("standard");
    expect(root.getAttribute("data-field-emphasis")).toBe("metadata");
    expect(screen.getByTestId("row-mode-picker").textContent).toContain(
      "Metadata",
    );
    const firstList = screen.getAllByTestId("virtualized-event-list")[0]!;
    expect(firstList.getAttribute("data-metadata-presentation")).toBe(
      "standard",
    );
    expect(firstList.getAttribute("data-field-emphasis")).toBe("metadata");
    expect(firstList.querySelector("[data-level-token]")).toBeNull();
    expect(
      localStorage.getItem("contextdesk.logExplorer.metadataPresentation.v1"),
    ).toBe("standard");
    expect(
      localStorage.getItem("contextdesk.logExplorer.fieldEmphasis.v1"),
    ).toBe("metadata");

    first.unmount();
    render(<LogExplorer corpusId="c1" />);
    await screen.findByText(/auth failure/);
    expect(
      screen
        .getByTestId("log-explorer")
        .getAttribute("data-metadata-presentation"),
    ).toBe("standard");
    expect(
      screen
        .getAllByTestId("virtualized-event-list")[0]!
        .getAttribute("data-field-emphasis"),
    ).toBe("metadata");
  });

  it("collapses and reopens the normal-width chat rail without toolbar clutter", async () => {
    render(<LogExplorer corpusId="c1" />);
    const root = await screen.findByTestId("log-explorer");
    const body = screen.getByTestId("log-explorer-body");
    const modeControl = screen
      .getByTestId("log-explorer-chat")
      .querySelector<HTMLElement>(
        ":scope > .log-explorer__investigation-mode-control",
      );

    expect(root.getAttribute("data-chat-collapsed")).toBe("false");
    expect(modeControl!.style.paddingLeft).toBe("1.65rem");
    expect(screen.getByTestId("splitter-chat")).toBeTruthy();
    fireEvent.click(screen.getByTestId("collapse-linked-chat"));

    expect(root.getAttribute("data-chat-collapsed")).toBe("true");
    expect(screen.queryByTestId("splitter-chat")).toBeNull();
    expect(body.style.gridTemplateColumns).toContain("0px 42px");
    expect(screen.queryByTestId("log-explorer-chat-thread")).toBeNull();
    fireEvent.click(screen.getByTestId("expand-linked-chat"));

    expect(root.getAttribute("data-chat-collapsed")).toBe("false");
    expect(screen.getByTestId("splitter-chat")).toBeTruthy();
    expect(screen.getByTestId("log-explorer-chat-thread")).toBeTruthy();
  });

  it("collapses either side rail, preserves active filters, and restores focus", async () => {
    render(<LogExplorer corpusId="c1" />);
    const root = await screen.findByTestId("log-explorer");
    const body = screen.getByTestId("log-explorer-body");
    const filters = screen.getByTestId("log-explorer-filters");
    const errorFilter = (await within(filters).findByRole("checkbox", {
      name: /error/i,
    })) as HTMLInputElement;

    fireEvent.click(errorFilter);
    expect(errorFilter.checked).toBe(true);
    fireEvent.click(screen.getByTestId("collapse-log-filters"));

    expect(root.getAttribute("data-filters-collapsed")).toBe("true");
    expect(root.getAttribute("data-usable-evidence-width")).toBe("3492");
    expect(screen.queryByTestId("splitter-filters")).toBeNull();
    expect(body.style.gridTemplateColumns).toContain("42px 0px 1fr");
    expect(screen.getByTestId("log-explorer-filters").style.gridColumn).toBe(
      "1",
    );
    expect(screen.getByTestId("log-explorer-lanes").style.gridColumn).toBe("3");
    expect(screen.getByTestId("splitter-chat").style.gridColumn).toBe("4");
    expect(screen.getByTestId("log-explorer-chat").style.gridColumn).toBe("5");
    expect(screen.getByText(/auth failure/)).toBeTruthy();
    expect(screen.getByTestId("log-explorer-chat-composer")).toBeTruthy();
    const reopenFilters = screen.getByTestId("expand-log-filters");
    expect(reopenFilters.getAttribute("aria-label")).toBe(
      "Expand log filters, 1 active",
    );
    await waitFor(() => expect(document.activeElement).toBe(reopenFilters));

    fireEvent.click(screen.getByTestId("collapse-linked-chat"));
    expect(root.getAttribute("data-chat-collapsed")).toBe("true");
    expect(root.getAttribute("data-usable-evidence-width")).toBe("3756");
    expect(body.style.gridTemplateColumns).toContain("1fr 0px 42px");

    fireEvent.click(reopenFilters);
    expect(root.getAttribute("data-filters-collapsed")).toBe("false");
    expect(screen.getByTestId("splitter-filters")).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByTestId("collapse-log-filters"),
      ),
    );
    expect(
      (
        within(screen.getByTestId("log-explorer-filters")).getByRole(
          "checkbox",
          { name: /error/i },
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);

    fireEvent.click(screen.getByTestId("expand-linked-chat"));
    expect(root.getAttribute("data-chat-collapsed")).toBe("false");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByTestId("collapse-linked-chat"),
      ),
    );
  });

  it("gates lane counts by usable evidence width and restores the preferred composed lanes", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1280,
    });
    localStorage.setItem(
      "contextdesk.logExplorer.lanes.v1:c1",
      JSON.stringify([
        { id: "lane-0", label: "API", sources: ["api.log"] },
        { id: "lane-1", label: "Worker", sources: ["worker.log"] },
        { id: "lane-2", label: "DB", sources: ["db.log"] },
        { id: "lane-3", label: "Proxy", sources: ["proxy.log"] },
      ]),
    );

    render(<LogExplorer corpusId="c1" />);
    const root = await screen.findByTestId("log-explorer");
    await waitFor(() => {
      expect(root.getAttribute("data-breakpoint")).toBe("normal");
      expect(root.getAttribute("data-usable-evidence-width")).toBe("748");
      expect(root.getAttribute("data-max-lane-count")).toBe("1");
    });

    const lanePicker = openToolbarPicker("lane-count-picker");
    const twoLUnavailable = screen.getByRole("menuitemradio", {
      name: /^2 lanes\b/,
    });
    expect((twoLUnavailable as HTMLButtonElement).disabled).toBe(true);
    expect(twoLUnavailable.title).toMatch(
      /Needs 840px of usable evidence width; 748px available/,
    );
    expect(
      (
        screen.getByRole("menuitemradio", {
          name: /^1 lane\b/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    fireEvent.click(screen.getByTestId("collapse-linked-chat"));
    await waitFor(() => {
      expect(root.getAttribute("data-usable-evidence-width")).toBe("1012");
      expect(root.getAttribute("data-max-lane-count")).toBe("2");
    });
    openToolbarPicker("lane-count-picker");
    const twoL = screen.getByRole("menuitemradio", {
      name: /^2 lanes\b/,
    });
    expect((twoL as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(twoL);
    await waitFor(() => expect(root.getAttribute("data-lane-count")).toBe("2"));

    fireEvent.click(screen.getByTestId("lane-editor-toggle"));
    const editor = await screen.findByTestId("lane-editor");
    expect(
      (
        within(
          within(editor).getByRole("group", {
            name: "Worker source membership",
          }),
        ).getByRole("checkbox", {
          name: /worker\.log/i,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    fireEvent.click(screen.getByTestId("lane-editor-close"));

    fireEvent.click(screen.getByTestId("expand-linked-chat"));
    await waitFor(() => {
      expect(root.getAttribute("data-lane-count")).toBe("1");
      expect(root.getAttribute("data-max-lane-count")).toBe("1");
    });
    fireEvent.click(screen.getByTestId("collapse-linked-chat"));
    await waitFor(() => {
      expect(root.getAttribute("data-lane-count")).toBe("2");
      expect(root.getAttribute("data-max-lane-count")).toBe("2");
    });

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 3840,
    });
    fireEvent(window, new Event("resize"));
    await waitFor(() =>
      expect(root.getAttribute("data-max-lane-count")).toBe("4"),
    );
    openToolbarPicker("lane-count-picker");
    const fourL = screen.getByRole("menuitemradio", {
      name: /^4 lanes\b/,
    });
    expect((fourL as HTMLButtonElement).disabled).toBe(false);
    fourL.focus();
    fireEvent.click(fourL);
    await waitFor(() => expect(root.getAttribute("data-lane-count")).toBe("4"));
    await waitFor(() => expect(document.activeElement).toBe(lanePicker));
  });

  it("focuses Find with the platform find shortcut", async () => {
    render(<LogExplorer corpusId="c1" />);
    const root = await screen.findByTestId("log-explorer");
    const input = screen.getByTestId("log-explorer-find");
    expect(input.getAttribute("placeholder")).toBe("Find logs…");
    expect(input.getAttribute("aria-label")).toBe("Find in logs");
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(root, { key: "f", metaKey: true });
    expect(document.activeElement).toBe(input);

    fireEvent.click(
      screen.getByRole("button", { name: "Help: Find vs Filter" }),
    );
    expect(
      screen.getByText(/Find highlights matches and steps next\/previous/),
    ).toBeTruthy();
  });

  it("resizes every event column by keyboard/pointer and supports auto-fit/reset", async () => {
    const page = defaultEventPage();
    page.events[0] = {
      ...page.events[0]!,
      message: `long-message ${"detail ".repeat(60)}`,
    };
    vi.mocked(host.hostLogQueryEvents).mockResolvedValue(page);
    render(<LogExplorer corpusId="c1" />);
    await screen.findByText(/long-message/);

    const headers = screen.getByRole("row", {
      name: "All sources column headings",
    });
    expect(headers.style.gridTemplateColumns).toContain("16rem");
    const messageResize = within(headers).getByRole("button", {
      name: "Resize Message column for All sources",
    });
    expect(messageResize.getAttribute("aria-label")).toBe(
      "Resize Message column for All sources",
    );
    fireEvent.keyDown(messageResize, { key: "ArrowRight" });
    await waitFor(() =>
      expect(headers.style.gridTemplateColumns).toContain("16.5rem"),
    );

    const timeResize = within(headers).getByRole("button", {
      name: "Resize Time column for All sources",
    });
    fireEvent.mouseDown(timeResize, { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 132 });
    fireEvent.mouseUp(window);
    await waitFor(() =>
      expect(headers.style.gridTemplateColumns).toContain("9.25rem"),
    );

    fireEvent.click(screen.getByTestId("columns-menu"));
    fireEvent.click(screen.getByTestId("col-autofit"));
    await waitFor(() =>
      expect(headers.style.gridTemplateColumns).toContain("40rem"),
    );
    fireEvent.click(screen.getByTestId("columns-menu"));
    fireEvent.click(screen.getByTestId("col-reset"));
    await waitFor(() =>
      expect(headers.style.gridTemplateColumns).toContain("16rem"),
    );

    const eventTime = screen.getByTestId("event-time-1");
    expect(eventTime.tabIndex).toBe(0);
    expect(eventTime.getAttribute("aria-label")).toMatch(/wall clock.*UTC/);

    openToolbarPicker("row-mode-picker");
    fireEvent.change(screen.getByTestId("preview-lines"), {
      target: { value: "12" },
    });
    chooseRowMode("Preview");
    await waitFor(() =>
      expect(
        screen
          .getByTestId("virtualized-event-list")
          .getAttribute("data-total-height"),
      ).toBe("148"),
    );

    fireEvent.click(screen.getByText(/long-message/));
    const inspector = await screen.findByTestId("log-explorer-detail");
    expect(
      within(inspector).getByLabelText("Complete redacted message for event 1")
        .textContent,
    ).toBe(page.events[0]!.message);
    const metadata = within(inspector).getByTestId("detail-metadata");
    expect(metadata.textContent).toContain("api.log");
    expect(metadata.textContent).toContain("seq 1");
    expect(host.hostLogQueryEventOriginal).not.toHaveBeenCalled();
    fireEvent.click(within(inspector).getByTestId("detail-close"));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-seq")).toBe("1"),
    );
  });

  it("lazily reveals and copies the authoritative redacted original with fidelity notices", async () => {
    const load = deferred<host.EventOriginalRepresentationDto>();
    vi.mocked(host.hostLogQueryEventOriginal).mockReturnValue(load.promise);
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<LogExplorer corpusId="c1" />);
    await screen.findByText(/auth failure/);
    expect(host.hostLogQueryEventOriginal).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText(/auth failure/));
    const inspector = await screen.findByTestId("log-explorer-detail");
    const representation = within(inspector).getByRole("group", {
      name: "Event 1 representation",
    });
    const formatted = within(representation).getByRole("button", {
      name: "Formatted",
    });
    const original = within(representation).getByRole("button", {
      name: "Original (redacted)",
    });
    expect(formatted.getAttribute("aria-pressed")).toBe("true");
    expect(original.getAttribute("aria-pressed")).toBe("false");
    expect(host.hostLogQueryEventOriginal).not.toHaveBeenCalled();

    fireEvent.click(original);
    expect(host.hostLogQueryEventOriginal).toHaveBeenCalledWith("c1", 1);
    expect(
      within(inspector).getByText("Loading Original (redacted)…"),
    ).toBeTruthy();
    expect(
      (within(inspector).getByTestId("detail-copy") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await act(async () => {
      load.resolve({
        state: "available",
        label: "Original (redacted)",
        text: '{"message":"auth failure","unknown":"kept"}',
        sourceByteCount: 75_000,
        redactedCharCount: 70_000,
        storedCharCount: 65_536,
        truncated: true,
        encodingNormalized: true,
        redactionApplied: true,
      });
      await load.promise;
    });

    const notices = within(inspector).getByTestId("detail-original-notices");
    expect(notices.textContent).toContain("after secret redaction");
    expect(notices.textContent).toContain("65,536 stored characters");
    expect(notices.textContent).toContain("suffix is unavailable");
    expect(notices.textContent).toContain("Invalid UTF-8");
    expect(notices.textContent).toContain("Sensitive value patterns");
    expect(
      within(inspector).getByLabelText(
        "Stored Original (redacted) record for event 1",
      ).textContent,
    ).toBe('{"message":"auth failure","unknown":"kept"}');
    expect(
      within(inspector).getByTestId("detail-copy").getAttribute("aria-label"),
    ).toBe("Copy stored Original (redacted) record 1");

    fireEvent.click(within(inspector).getByTestId("detail-copy"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        '{"message":"auth failure","unknown":"kept"}',
      ),
    );

    fireEvent.click(formatted);
    expect(
      within(inspector).getByLabelText("Complete redacted message for event 1")
        .textContent,
    ).toBe("auth failure");
    fireEvent.click(within(inspector).getByTestId("detail-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText.mock.calls[1]?.[0]).toContain(
      "\terror\tapi.log\tauth failure",
    );
    expect(host.hostLogQueryEventOriginal).toHaveBeenCalledTimes(1);
  });

  it("shows honest unavailable and retryable error states without inventing original text", async () => {
    vi.mocked(host.hostLogQueryEventOriginal)
      .mockRejectedValueOnce(new Error("event store unavailable"))
      .mockResolvedValueOnce({
        state: "unavailable",
        reason: "Original representation unavailable for this corpus",
      });

    render(<LogExplorer corpusId="c1" />);
    await screen.findByText(/auth failure/);
    fireEvent.click(screen.getByText(/auth failure/));
    const inspector = await screen.findByTestId("log-explorer-detail");
    fireEvent.click(
      within(inspector).getByRole("button", {
        name: "Original (redacted)",
      }),
    );

    expect(
      await within(inspector).findByText(
        /Could not load Original.*event store unavailable/,
      ),
    ).toBeTruthy();
    fireEvent.click(within(inspector).getByRole("button", { name: "Retry" }));
    expect(
      (await within(inspector).findByTestId("detail-original-unavailable"))
        .textContent,
    ).toBe("Original representation unavailable for this corpus");
    expect(
      (within(inspector).getByTestId("detail-copy") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      within(inspector).queryByTestId("detail-original-message"),
    ).toBeNull();
    expect(host.hostLogQueryEventOriginal).toHaveBeenCalledTimes(2);
  });

  it("ignores stale original responses after switching events or closing the inspector", async () => {
    const first = deferred<host.EventOriginalRepresentationDto>();
    const second = deferred<host.EventOriginalRepresentationDto>();
    vi.mocked(host.hostLogQueryEventOriginal).mockImplementation(
      (_corpusId, seq) => (seq === 1 ? first.promise : second.promise),
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByText(/auth failure/);
    fireEvent.click(screen.getByText(/auth failure/));
    let inspector = await screen.findByTestId("log-explorer-detail");
    fireEvent.click(
      within(inspector).getByRole("button", {
        name: "Original (redacted)",
      }),
    );

    fireEvent.click(screen.getByText(/job ok/));
    inspector = await screen.findByTestId("log-explorer-detail");
    expect(inspector.getAttribute("aria-label")).toContain("sequence 2");
    expect(
      within(inspector).getByLabelText("Complete redacted message for event 2")
        .textContent,
    ).toBe("job ok");
    await act(async () => {
      first.resolve({
        state: "available",
        label: "Original (redacted)",
        text: "stale event one",
        sourceByteCount: 15,
        redactedCharCount: 15,
        storedCharCount: 15,
        truncated: false,
        encodingNormalized: false,
        redactionApplied: false,
      });
      await first.promise;
    });
    expect(screen.queryByText("stale event one")).toBeNull();

    fireEvent.click(
      within(inspector).getByRole("button", {
        name: "Original (redacted)",
      }),
    );
    fireEvent.click(within(inspector).getByTestId("detail-close"));
    await act(async () => {
      second.resolve({
        state: "available",
        label: "Original (redacted)",
        text: "stale event two",
        sourceByteCount: 15,
        redactedCharCount: 15,
        storedCharCount: 15,
        truncated: false,
        encodingNormalized: false,
        redactionApplied: false,
      });
      await second.promise;
    });
    expect(screen.queryByTestId("log-explorer-detail")).toBeNull();
    expect(screen.queryByText("stale event two")).toBeNull();
    expect(host.hostLogQueryEventOriginal).toHaveBeenNthCalledWith(1, "c1", 1);
    expect(host.hostLogQueryEventOriginal).toHaveBeenNthCalledWith(2, "c1", 2);
  });

  it("scopes synchronized resizable headings to every visible lane", async () => {
    render(<LogExplorer corpusId="c1" />);
    await screen.findByText(/auth failure/);
    chooseLaneCount(2);

    const lanes = screen.getByTestId("log-explorer-lanes");
    const filters = screen.getByTestId("log-explorer-filters");
    const chat = screen.getByTestId("log-explorer-chat");
    const headings = screen.getAllByRole("row", {
      name: /column headings$/,
    });
    expect(headings).toHaveLength(2);
    expect(headings.every((heading) => lanes.contains(heading))).toBe(true);
    expect(headings.some((heading) => filters.contains(heading))).toBe(false);
    expect(headings.some((heading) => chat.contains(heading))).toBe(false);

    for (const heading of headings) {
      expect(within(heading).getAllByRole("columnheader")).toHaveLength(4);
      expect(heading.style.gridTemplateColumns).toContain("16rem");
    }

    const laneTwoHeading = screen.getByRole("row", {
      name: "Lane 2 column headings",
    });
    fireEvent.keyDown(
      within(laneTwoHeading).getByRole("button", {
        name: "Resize Message column for Lane 2",
      }),
      { key: "ArrowRight" },
    );
    await waitFor(() => {
      for (const heading of headings) {
        expect(heading.style.gridTemplateColumns).toContain("16.5rem");
      }
    });

    const laneTwo = screen
      .getByRole("row", { name: "Lane 2 column headings" })
      .closest<HTMLElement>("[data-lane-id]");
    expect(laneTwo).toBeTruthy();
    const laneTwoRows = await within(laneTwo!).findByTestId(
      "virtualized-event-list",
    );
    Object.defineProperty(laneTwoRows, "scrollLeft", {
      configurable: true,
      value: 48,
      writable: true,
    });
    fireEvent.scroll(laneTwoRows);
    await waitFor(() =>
      expect(
        screen.getByRole("row", { name: "Lane 2 column headings" }).style
          .transform,
      ).toBe("translateX(-48px)"),
    );
    expect(
      screen.getByRole("row", { name: "All sources column headings" }).style
        .transform,
    ).toBe("translateX(-0px)");

    chooseLaneCount(1);
    chooseLaneCount(2);
    await waitFor(() =>
      expect(
        screen.getByRole("row", { name: "Lane 2 column headings" }).style
          .transform,
      ).toBe("translateX(-0px)"),
    );
  });

  it("keeps compact rail controls, event rows, and timestamps keyboard focusable", async () => {
    render(<LogExplorer corpusId="c1" />);
    const message = await screen.findByText("auth failure");

    const collapseFilters = screen.getByTestId("collapse-log-filters");
    collapseFilters.focus();
    expect(document.activeElement).toBe(collapseFilters);

    const collapseChat = screen.getByTestId("collapse-linked-chat");
    collapseChat.focus();
    expect(document.activeElement).toBe(collapseChat);

    const row = message.closest('[role="listitem"]') as HTMLElement;
    row.focus();
    expect(document.activeElement).toBe(row);
    expect(row.classList.contains("log-explorer__row--selected")).toBe(false);
    fireEvent.keyDown(row, { key: "Enter" });
    expect(row.classList.contains("log-explorer__row--selected")).toBe(true);

    const timestamp = screen.getByTestId("event-time-1");
    timestamp.focus();
    expect(document.activeElement).toBe(timestamp);
    expect(timestamp.closest('[role="listitem"]')).toBe(row);
  });

  it("keeps narrow logs primary with keyboard-safe filter and chat drawers", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 800,
    });
    try {
      render(<LogExplorer corpusId="c1" />);
      const root = await screen.findByTestId("log-explorer");
      await waitFor(() =>
        expect(root.getAttribute("data-breakpoint")).toBe("narrow"),
      );
      expect(root.getAttribute("data-lane-count")).toBe("1");
      expect(screen.queryByTestId("collapse-linked-chat")).toBeNull();
      expect(screen.queryByTestId("expand-linked-chat")).toBeNull();
      expect(screen.queryByTestId("lane-count-picker")).toBeNull();
      chooseRowMode("Deep");
      await waitFor(() =>
        expect(
          screen
            .getByTestId("virtualized-event-list")
            .getAttribute("data-total-height"),
        ).toBe("56"),
      );

      fireEvent.click(await screen.findByText("auth failure"));
      expect(screen.getByTestId("log-explorer-detail")).toBeTruthy();

      const filtersToggle = screen.getByTestId("narrow-filters-toggle");
      fireEvent.click(filtersToggle);
      expect(filtersToggle.getAttribute("aria-expanded")).toBe("true");
      const filtersDrawer = screen.getByTestId("log-explorer-filters");
      const filtersDrawerStyle = getComputedStyle(filtersDrawer);
      expect(filtersDrawerStyle.flexDirection).toBe("column");
      expect(filtersDrawer.firstElementChild).toBe(
        screen.getByTestId("close-filters-drawer"),
      );
      expect(
        filtersDrawer.compareDocumentPosition(
          screen.getByTestId("log-explorer-find"),
        ) & Node.DOCUMENT_POSITION_CONTAINED_BY,
      ).not.toBe(0);
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByTestId("log-explorer-find"),
        ),
      );
      fireEvent.click(screen.getByTestId("log-explorer-advanced-toggle"));
      expect(
        filtersDrawer.contains(screen.getByLabelText("Sequence start filter")),
      ).toBe(true);

      const errorFacet = within(screen.getByTestId("log-explorer-filters"))
        .getByText("error")
        .closest("label");
      fireEvent.click(within(errorFacet!).getByRole("checkbox"));
      expect(await screen.findByTestId("clear-all-filters")).toBeTruthy();
      fireEvent.click(screen.getByTestId("clear-all-filters"));
      await waitFor(() =>
        expect(screen.queryByTestId("clear-all-filters")).toBeNull(),
      );
      expect(screen.getByTestId("log-explorer-detail")).toBeTruthy();

      fireEvent.keyDown(screen.getByTestId("log-explorer-find"), {
        key: "Escape",
      });
      await waitFor(() => expect(document.activeElement).toBe(filtersToggle));
      expect(filtersToggle.getAttribute("aria-expanded")).toBe("false");

      const chatToggle = screen.getByTestId("narrow-chat-toggle");
      fireEvent.click(chatToggle);
      expect(chatToggle.getAttribute("aria-expanded")).toBe("true");
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByTestId("new-linked-chat"),
        ),
      );
      expect(screen.getByLabelText("Chat message")).toBeTruthy();
      expect(screen.getByTestId("send-linked-chat")).toBeTruthy();
      fireEvent.click(screen.getByTestId("close-chat-drawer"));
      await waitFor(() => expect(document.activeElement).toBe(chatToggle));
      expect(chatToggle.getAttribute("aria-expanded")).toBe("false");
      expect(screen.getByTestId("log-explorer-detail")).toBeTruthy();
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalWidth,
      });
    }
  });

  it("focuses the exact resident bookmark when timestamps and source basenames collide", async () => {
    const sharedTs = 1_700_000_050;
    const decoy: host.ExplorerEventDto = {
      seq: 101,
      ts: sharedTs,
      timeQuality: "wall",
      level: "error",
      service: "api-a",
      host: null,
      templateId: 11,
      traceId: null,
      message: "decoy event with the same timestamp",
      source: "team-a/api.log",
    };
    const target: host.ExplorerEventDto = {
      ...decoy,
      seq: 202,
      service: "api-b",
      templateId: 22,
      message: "stable bookmark target",
      source: "team-b/api.log",
    };
    vi.mocked(host.hostLogFacets).mockResolvedValue({
      sources: { "team-a/api.log": 1, "team-b/api.log": 1 },
      levels: { error: 2 },
      services: { "api-a": 1, "api-b": 1 },
      hosts: {},
      timeQuality: "wall",
    });
    vi.mocked(host.hostLogQueryEvents).mockResolvedValue({
      ...defaultEventPage(),
      events: [decoy, target],
      totalMatched: 2,
    });
    vi.mocked(host.hostLogListBookmarks).mockResolvedValue([
      bookmark("bm-stable", "stable identity", target.seq),
    ]);
    vi.mocked(host.hostLogQueryEventNeighborhood).mockResolvedValue(
      eventNeighborhood(target),
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByText(target.message);
    fireEvent.click(await screen.findByTestId("bookmark-activate-bm-stable"));

    const targetRow = document.querySelector<HTMLElement>(
      `[data-seq="${target.seq}"]`,
    );
    const decoyRow = document.querySelector<HTMLElement>(
      `[data-seq="${decoy.seq}"]`,
    );
    await waitFor(() => {
      expect(targetRow?.classList.contains("log-explorer__row--selected")).toBe(
        true,
      );
      expect(
        targetRow?.classList.contains("log-explorer__row--highlight"),
      ).toBe(true);
      expect(document.activeElement).toBe(targetRow);
    });
    expect(decoyRow?.classList.contains("log-explorer__row--selected")).toBe(
      false,
    );
    expect(decoyRow?.classList.contains("log-explorer__row--highlight")).toBe(
      false,
    );
    expect(screen.getByTestId("detail-metadata").textContent).toContain(
      "team-b/api.log",
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Bookmark visible: stable identity",
    );
    expect(host.hostLogQueryEventNeighborhood).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        targetSeq: target.seq,
        before: 0,
        after: 0,
      }),
    );
  });

  it("seeks a valid nonresident bookmark through one bounded neighborhood", async () => {
    const target: host.ExplorerEventDto = {
      seq: 50_001,
      ts: 1_700_050_001,
      timeQuality: "wall",
      level: "warn",
      service: "worker",
      host: null,
      templateId: 50_001,
      traceId: "trace-deep",
      message: "deep nonresident bookmark target",
      source: "worker.log",
    };
    const before = {
      ...target,
      seq: 50_000,
      message: "bounded neighbor before",
    };
    const after = { ...target, seq: 50_002, message: "bounded neighbor after" };
    vi.mocked(host.hostLogListBookmarks).mockResolvedValue([
      bookmark("bm-deep", "deep evidence", target.seq),
    ]);
    vi.mocked(host.hostLogQueryEventNeighborhood).mockImplementation(
      async (_corpusId, query) =>
        query.before === 0 && query.after === 0
          ? eventNeighborhood(target)
          : eventNeighborhood(target, "found", [before, target, after]),
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByText("auth failure");
    fireEvent.click(await screen.findByTestId("bookmark-activate-bm-deep"));

    expect((await screen.findAllByText(target.message)).length).toBe(2);
    const targetRow = document.querySelector<HTMLElement>(
      `[data-seq="${target.seq}"]`,
    );
    await waitFor(() => {
      expect(targetRow?.classList.contains("log-explorer__row--selected")).toBe(
        true,
      );
      expect(
        targetRow?.classList.contains("log-explorer__row--highlight"),
      ).toBe(true);
      expect(document.activeElement).toBe(targetRow);
    });
    expect(screen.queryByTestId("bookmark-restore-view")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "Bookmark visible under current filters: deep evidence",
    );
    expect(host.hostLogQueryEventNeighborhood).toHaveBeenNthCalledWith(
      2,
      "c1",
      expect.objectContaining({
        targetSeq: target.seq,
        before: 50,
        after: 50,
      }),
    );
    expect(host.hostLogQueryEventNeighborhood).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "level",
      apply: () => {
        const errorFacet = within(screen.getByTestId("log-explorer-filters"))
          .getByText("error")
          .closest("label");
        fireEvent.click(within(errorFacet!).getByRole("checkbox"));
      },
      expectedFilter: { levels: ["error"] },
      restoredFacet: "level:error",
    },
    {
      name: "text",
      apply: () => {
        fireEvent.change(screen.getByTestId("log-explorer-filter"), {
          target: { value: "auth" },
        });
        fireEvent.click(screen.getByTestId("log-explorer-filter-apply"));
      },
      expectedFilter: { keyword: "auth" },
      restoredFacet: "keyword:auth",
    },
    {
      name: "time",
      apply: () => {
        fireEvent.click(screen.getByTestId("log-explorer-advanced-toggle"));
        fireEvent.change(screen.getByLabelText("UTC end filter"), {
          target: { value: "2023-11-14T22:13:21Z" },
        });
        fireEvent.click(screen.getByTestId("apply-structured-filters"));
      },
      expectedFilter: { timeTo: 1_700_000_001 },
      restoredFacet: "UTC range",
    },
    {
      name: "sequence",
      apply: () => {
        fireEvent.click(screen.getByTestId("log-explorer-advanced-toggle"));
        fireEvent.change(screen.getByLabelText("Sequence end filter"), {
          target: { value: "1" },
        });
        fireEvent.click(screen.getByTestId("apply-structured-filters"));
      },
      expectedFilter: { seqTo: 1 },
      restoredFacet: "seq:start–1",
    },
  ])(
    "temporarily reveals a $name-filter-hidden bookmark and restores that filter",
    async ({ apply, expectedFilter, restoredFacet }) => {
      const allEvents = defaultEventPage().events;
      const target = allEvents.find((event) => event.seq === 2)!;
      vi.mocked(host.hostLogListBookmarks).mockResolvedValue([
        bookmark(`bm-hidden-${name}`, `${name} hidden evidence`, target.seq),
      ]);
      vi.mocked(host.hostLogQueryEvents).mockImplementation(
        async (_corpusId, query) => {
          const levels = query?.levels ?? [];
          const keyword = query?.keyword?.toLowerCase() ?? "";
          const sources = query?.sources ?? [];
          const timeFrom = query?.timeFrom;
          const timeTo = query?.timeTo;
          const seqFrom = query?.seqFrom;
          const seqTo = query?.seqTo;
          const events = allEvents.filter(
            (event) =>
              (levels.length === 0 || levels.includes(event.level)) &&
              (!keyword || event.message.toLowerCase().includes(keyword)) &&
              (sources.length === 0 || sources.includes(event.source)) &&
              (timeFrom == null || event.ts >= timeFrom) &&
              (timeTo == null || event.ts < timeTo) &&
              (seqFrom == null || event.seq >= seqFrom) &&
              (seqTo == null || event.seq <= seqTo),
          );
          return {
            ...defaultEventPage(),
            events,
            totalMatched: events.length,
          };
        },
      );
      vi.mocked(host.hostLogQueryEventNeighborhood).mockImplementation(
        async (_corpusId, query) => {
          const levels = query.filter?.levels ?? [];
          const keyword = query.filter?.keyword?.toLowerCase() ?? "";
          const sources = query.filter?.sources ?? [];
          const timeFrom = query.filter?.timeFrom;
          const timeTo = query.filter?.timeTo;
          const seqFrom = query.filter?.seqFrom;
          const seqTo = query.filter?.seqTo;
          const found =
            (levels.length === 0 || levels.includes(target.level)) &&
            (!keyword || target.message.toLowerCase().includes(keyword)) &&
            (sources.length === 0 || sources.includes(target.source)) &&
            (timeFrom == null || target.ts >= timeFrom) &&
            (timeTo == null || target.ts < timeTo) &&
            (seqFrom == null || target.seq >= seqFrom) &&
            (seqTo == null || target.seq <= seqTo);
          return eventNeighborhood(
            target,
            found ? "found" : "hidden_by_filter",
          );
        },
      );

      render(<LogExplorer corpusId="c1" />);
      await screen.findByText("job ok");
      await waitFor(() =>
        expect(
          within(screen.getByTestId("log-explorer-filters")).getByText("error"),
        ).toBeTruthy(),
      );
      apply();
      await waitFor(() => expect(screen.queryByText("job ok")).toBeNull());

      fireEvent.click(
        await screen.findByTestId(`bookmark-activate-bm-hidden-${name}`),
      );
      await screen.findByTestId("bookmark-restore-view");
      expect((await screen.findAllByText("job ok")).length).toBe(2);
      expect(screen.getByRole("status").textContent).toContain(
        `Bookmark temporarily revealed: ${name} hidden evidence`,
      );
      expect(host.hostLogQueryEventNeighborhood).toHaveBeenNthCalledWith(
        1,
        "c1",
        expect.objectContaining({
          targetSeq: target.seq,
          filter: expect.objectContaining(expectedFilter),
        }),
      );
      const targetRow = document.querySelector<HTMLElement>(
        `[data-seq="${target.seq}"]`,
      );
      expect(targetRow?.classList.contains("log-explorer__row--selected")).toBe(
        true,
      );
      expect(
        targetRow?.classList.contains("log-explorer__row--highlight"),
      ).toBe(true);

      fireEvent.click(screen.getByTestId("bookmark-restore-view"));
      expect(
        await screen.findByText(restoredFacet, { exact: false }),
      ).toBeTruthy();
      await waitFor(() => expect(screen.queryByText("job ok")).toBeNull());
      expect(screen.getByRole("status").textContent).toContain(
        "Restored prior Explorer view",
      );
    },
  );

  it("requires an explicit temporary reveal for a noise-suppressed bookmark and reapplies policy on restore", async () => {
    const allEvents = defaultEventPage().events;
    const target = allEvents.find((event) => event.templateId === 2)!;
    vi.mocked(host.hostLogLoadSuppression).mockResolvedValue(
      suppressionDocument(),
    );
    vi.mocked(host.hostLogCountEvents).mockImplementation(
      async (_corpusId, query) => ({
        totalMatched: query?.templateIds?.includes(2) ? 1 : 1,
      }),
    );
    vi.mocked(host.hostLogListBookmarks).mockResolvedValue([
      bookmark("bm-suppressed", "heartbeat evidence", target.seq),
    ]);
    vi.mocked(host.hostLogQueryEvents).mockImplementation(
      async (_corpusId, query) => {
        const excluded = query?.excludedTemplateIds ?? [];
        const events = allEvents.filter(
          (event) => !excluded.includes(event.templateId),
        );
        return {
          ...defaultEventPage(),
          events,
          totalMatched: events.length,
        };
      },
    );
    vi.mocked(host.hostLogQueryEventNeighborhood).mockImplementation(
      async (_corpusId, query) => {
        const hidden =
          query.filter?.excludedTemplateIds?.includes(target.templateId) ??
          false;
        return eventNeighborhood(
          target,
          hidden ? "hidden_by_filter" : "found",
          hidden ? [] : [target],
        );
      },
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByText("auth failure");
    expect(screen.queryByText("job ok")).toBeNull();

    fireEvent.click(
      await screen.findByTestId("bookmark-activate-bm-suppressed"),
    );
    const offer = await screen.findByTestId("suppressed-bookmark-offer");
    expect(within(offer).getByText(/Hidden by active noise rule/)).toBeTruthy();
    expect(screen.queryByText("job ok")).toBeNull();

    fireEvent.click(
      within(offer).getByRole("button", {
        name: "Reveal suppressed evidence",
      }),
    );
    expect((await screen.findAllByText("job ok")).length).toBeGreaterThan(0);
    expect(await screen.findByTestId("bookmark-restore-view")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "Suppressed bookmark temporarily revealed",
    );
    expect(
      vi
        .mocked(host.hostLogQueryEventNeighborhood)
        .mock.calls.some(
          ([, request]) =>
            request.filter?.excludedTemplateIds?.length === 0 &&
            request.targetSeq === target.seq,
        ),
    ).toBe(true);

    fireEvent.click(screen.getByTestId("bookmark-restore-view"));
    await waitFor(() => expect(screen.queryByText("job ok")).toBeNull());
    await waitFor(() =>
      expect(
        vi
          .mocked(host.hostLogQueryEventRows)
          .mock.calls.some(
            ([, query]) =>
              query?.excludedTemplateIds?.length === 1 &&
              query.excludedTemplateIds[0] === 2,
          ),
      ).toBe(true),
    );
  });

  it("reloads persisted bookmarks and activates them without stale reveal state", async () => {
    const target = defaultEventPage().events[0]!;
    vi.mocked(host.hostLogListBookmarks).mockResolvedValue([
      bookmark("bm-reloaded", "persisted evidence", target.seq),
    ]);
    vi.mocked(host.hostLogQueryEventNeighborhood).mockResolvedValue(
      eventNeighborhood(target),
    );

    const first = render(<LogExplorer corpusId="c1" />);
    expect(
      await screen.findByTestId("bookmark-activate-bm-reloaded"),
    ).toBeTruthy();
    first.unmount();

    render(<LogExplorer corpusId="c1" />);
    fireEvent.click(await screen.findByTestId("bookmark-activate-bm-reloaded"));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Bookmark visible: persisted evidence",
      ),
    );
    expect(host.hostLogListBookmarks).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("bookmark-restore-view")).toBeNull();
    const targetRow = document.querySelector<HTMLElement>(
      `[data-seq="${target.seq}"]`,
    );
    expect(targetRow?.classList.contains("log-explorer__row--selected")).toBe(
      true,
    );
    expect(targetRow?.classList.contains("log-explorer__row--highlight")).toBe(
      true,
    );
  });

  it("temporarily reveals a source-hidden bookmark and restores the exact prior view", async () => {
    const bookmark: host.LogBookmarkDto = {
      id: "bm-worker",
      label: "worker evidence",
      note: null,
      seqFrom: 2,
      seqTo: 2,
      createdAt: 1,
      updatedAt: 1,
    };
    const allEvents = defaultEventPage().events;
    const target = allEvents.find((event) => event.seq === 2)!;
    vi.mocked(host.hostLogListBookmarks).mockResolvedValue([bookmark]);
    vi.mocked(host.hostLogQueryEvents).mockImplementation(
      async (_corpusId, query) => {
        const sourceFilter = query?.sources ?? [];
        const events =
          sourceFilter.length === 0
            ? allEvents
            : allEvents.filter((event) => sourceFilter.includes(event.source));
        return {
          events,
          nextCursor: null,
          nextTs: null,
          prevCursor: null,
          prevTs: null,
          totalMatched: events.length,
          timeQuality: "wall",
        };
      },
    );
    vi.mocked(host.hostLogQueryEventNeighborhood).mockImplementation(
      async (_corpusId, query) => {
        const sources = query.filter?.sources ?? [];
        const found = sources.length === 0 || sources.includes(target.source);
        return {
          status: found ? "found" : "hidden_by_filter",
          target,
          events: found ? [target] : [],
          targetIndex: found ? 0 : null,
          nextCursor: null,
          nextTs: null,
          prevCursor: null,
          prevTs: null,
          totalMatched: found ? 1 : 0,
          corpusTotal: 2,
          timeQuality: "wall",
        };
      },
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByText("auth failure");
    fireEvent.click(await screen.findByRole("checkbox", { name: /api\.log/i }));
    await waitFor(() =>
      expect(host.hostLogQueryEvents).toHaveBeenLastCalledWith(
        "c1",
        expect.objectContaining({ sources: ["api.log"] }),
      ),
    );
    await waitFor(() => expect(screen.queryByText("job ok")).toBeNull());

    fireEvent.click(await screen.findByTestId("bookmark-activate-bm-worker"));
    await screen.findByTestId("bookmark-restore-view");
    await waitFor(() =>
      expect(host.hostLogQueryEventNeighborhood).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          targetSeq: 2,
          filter: expect.objectContaining({ sources: ["worker.log"] }),
        }),
      ),
    );
    expect(screen.getAllByText("job ok").length).toBeGreaterThan(0);
    expect(screen.getByTestId("bookmark-restore-view").textContent).toContain(
      "temp reveal",
    );
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Bookmark temporarily revealed: worker evidence",
      ),
    );

    fireEvent.click(screen.getByTestId("bookmark-restore-view"));
    await waitFor(() =>
      expect(host.hostLogQueryEvents).toHaveBeenLastCalledWith(
        "c1",
        expect.objectContaining({ sources: ["api.log"] }),
      ),
    );
    await waitFor(() => expect(screen.queryByText("job ok")).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Restored prior Explorer view",
      ),
    );
    expect(screen.getByRole("status").textContent).not.toContain(
      "Selection cleared",
    );
    expect(screen.queryByTestId("bookmark-restore-view")).toBeNull();
  });

  it("does not let an active Find refresh overwrite a temporary bookmark reveal", async () => {
    const allEvents = defaultEventPage().events;
    const findTarget = allEvents.find((event) => event.seq === 1)!;
    const bookmarkTarget = allEvents.find((event) => event.seq === 2)!;
    const staleFind =
      deferred<Awaited<ReturnType<typeof host.hostLogSearchEventsAdvanced>>>();
    const findResult: Awaited<
      ReturnType<typeof host.hostLogSearchEventsAdvanced>
    > = {
      hits: [
        {
          event: findTarget,
          score: 1,
          excerpt: "auth failure",
          matchKind: "keyword",
          templateId: findTarget.templateId,
        },
      ],
      partial: false,
      scanned: 2,
      totalMatched: 1,
    };
    let findRequestCount = 0;
    vi.mocked(host.hostLogListBookmarks).mockResolvedValue([
      bookmark("bm-find-race", "worker evidence", bookmarkTarget.seq),
    ]);
    vi.mocked(host.hostLogSearchEventsAdvanced).mockImplementation(async () => {
      findRequestCount += 1;
      return findRequestCount === 2 ? staleFind.promise : findResult;
    });
    vi.mocked(host.hostLogQueryEventNeighborhood).mockImplementation(
      async (_corpusId, query) => {
        const target =
          query.targetSeq === bookmarkTarget.seq ? bookmarkTarget : findTarget;
        const hidden =
          target.seq === bookmarkTarget.seq &&
          (query.filter?.levels ?? []).includes("error");
        return eventNeighborhood(target, hidden ? "hidden_by_filter" : "found");
      },
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByText("auth failure");

    fireEvent.change(screen.getByTestId("log-explorer-find"), {
      target: { value: "auth" },
    });
    await clickFindWhenReady();
    await waitFor(() =>
      expect(host.hostLogSearchEventsAdvanced).toHaveBeenCalledTimes(1),
    );

    const errorFacet = within(screen.getByTestId("log-explorer-filters"))
      .getByText("error")
      .closest("label");
    fireEvent.click(within(errorFacet!).getByRole("checkbox"));
    await waitFor(() =>
      expect(host.hostLogSearchEventsAdvanced).toHaveBeenCalledTimes(2),
    );

    fireEvent.click(
      await screen.findByTestId("bookmark-activate-bm-find-race"),
    );
    await screen.findByTestId("bookmark-restore-view");
    await waitFor(() =>
      expect(screen.getByTestId("detail-metadata").textContent).toContain(
        "seq 2",
      ),
    );
    expect(host.hostLogSearchEventsAdvanced).toHaveBeenCalledTimes(2);
    expect(
      document
        .querySelector<HTMLElement>('[data-seq="2"]')
        ?.classList.contains("log-explorer__row--selected"),
    ).toBe(true);
    expect(host.hostCancelLogSearch).toHaveBeenCalledWith("find-request");

    staleFind.resolve(findResult);
    await act(async () => {
      await staleFind.promise;
    });
    expect(
      document
        .querySelector<HTMLElement>('[data-seq="2"]')
        ?.classList.contains("log-explorer__row--selected"),
    ).toBe(true);

    fireEvent.click(screen.getByTestId("bookmark-restore-view"));
    await waitFor(() =>
      expect(host.hostLogSearchEventsAdvanced).toHaveBeenCalledTimes(3),
    );
    expect(
      (
        screen.getByRole("checkbox", {
          name: /error 3/i,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(screen.queryByTestId("bookmark-restore-view")).toBeNull();
  });

  it("reports a missing bookmark target without claiming navigation success", async () => {
    vi.mocked(host.hostLogListBookmarks).mockResolvedValue([
      {
        id: "bm-missing",
        label: "removed event",
        note: null,
        seqFrom: 404,
        seqTo: 404,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    vi.mocked(host.hostLogQueryEventNeighborhood).mockResolvedValue({
      status: "missing",
      target: null,
      events: [],
      targetIndex: null,
      nextCursor: null,
      nextTs: null,
      prevCursor: null,
      prevTs: null,
      totalMatched: 0,
      corpusTotal: 2,
      timeQuality: "wall",
    });

    render(<LogExplorer corpusId="c1" />);
    fireEvent.click(await screen.findByTestId("bookmark-activate-bm-missing"));
    expect(await screen.findByTestId("bookmark-missing")).toBeTruthy();
    expect(screen.getByText(/not found in corpus/)).toBeTruthy();
    expect(screen.queryByText(/Jumped bookmark/i)).toBeNull();
  });

  it("saves and highlights an exact noncontiguous evidence set without intervening rows", async () => {
    const sharedTs = 1_700_000_100;
    const events: host.ExplorerEventDto[] = [
      {
        seq: 10,
        ts: sharedTs,
        timeQuality: "wall",
        level: "error",
        service: "api",
        host: null,
        templateId: 10,
        traceId: null,
        message: "first selected clue",
        source: "api.log",
      },
      {
        seq: 11,
        ts: sharedTs + 1,
        timeQuality: "wall",
        level: "info",
        service: "api",
        host: null,
        templateId: 11,
        traceId: null,
        message: "intervening unselected event",
        source: "api.log",
      },
      {
        seq: 12,
        ts: sharedTs,
        timeQuality: "wall",
        level: "warn",
        service: "worker",
        host: null,
        templateId: 12,
        traceId: null,
        message: "second selected clue at duplicate timestamp",
        source: "worker.log",
      },
    ];
    vi.mocked(host.hostLogFacets).mockResolvedValue({
      sources: { "api.log": 2, "worker.log": 1 },
      levels: { error: 1, info: 1, warn: 1 },
      services: { api: 2, worker: 1 },
      hosts: {},
      timeQuality: "wall",
    });
    vi.mocked(host.hostLogQueryEvents).mockResolvedValue({
      ...defaultEventPage(),
      events,
      totalMatched: events.length,
    });
    const eventRefs: host.LogBookmarkEventRefDto[] = [
      events[0]!,
      events[2]!,
    ].map((event) => ({
      corpusId: "c1",
      seq: event.seq,
      source: event.source,
      timestampHint: event.ts,
      timeQualityHint: event.timeQuality,
    }));
    vi.mocked(host.hostLogAddBookmark).mockResolvedValue({
      id: "bm-exact",
      label: "2 selected events",
      seqFrom: 10,
      seqTo: 12,
      eventRefs,
      evidenceStatus: "verified",
      createdAt: 1,
      updatedAt: 1,
    });
    vi.mocked(host.hostLogQueryEventNeighborhood).mockResolvedValue(
      eventNeighborhood(events[0]!),
    );

    render(<LogExplorer corpusId="c1" />);
    fireEvent.click(await screen.findByText("first selected clue"));
    fireEvent.click(
      screen.getByText("second selected clue at duplicate timestamp"),
      { metaKey: true },
    );
    fireEvent.click(screen.getByRole("button", { name: "Bookmark (B)" }));

    await waitFor(() =>
      expect(host.hostLogAddBookmark).toHaveBeenCalledWith("c1", {
        seqFrom: 10,
        seqTo: 12,
        eventRefs,
        label: "2 selected events",
      }),
    );
    expect(
      vi
        .mocked(host.hostLogAddBookmark)
        .mock.calls[0]![1].eventRefs?.map((eventRef) => eventRef.seq),
    ).toEqual([10, 12]);

    fireEvent.click(screen.getByRole("button", { name: "Bookmark (B)" }));
    await screen.findByText("Already bookmarked: 2 selected events");
    expect(host.hostLogAddBookmark).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByTestId("bookmark-activate-bm-exact"));
    await waitFor(() =>
      expect(host.hostLogQueryEventNeighborhood).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ targetSeq: 10 }),
      ),
    );
    expect(
      document
        .querySelector<HTMLElement>('[data-seq="10"]')
        ?.classList.contains("log-explorer__row--highlight"),
    ).toBe(true);
    expect(
      document
        .querySelector<HTMLElement>('[data-seq="11"]')
        ?.classList.contains("log-explorer__row--highlight"),
    ).toBe(false);
    expect(
      document
        .querySelector<HTMLElement>('[data-seq="12"]')
        ?.classList.contains("log-explorer__row--highlight"),
    ).toBe(true);
  });

  it("prepares a governed chat question from exact selected identities without pasting payloads", async () => {
    render(<LogExplorer corpusId="c1" />);
    fireEvent.click(await screen.findByText("auth failure"));

    const strip = screen.getByTestId("selection-action-strip");
    expect(strip.textContent).toContain("1selected");
    fireEvent.click(
      within(strip).getByRole("button", { name: "Ask about selection" }),
    );

    const composer = await screen.findByLabelText("Chat message");
    await waitFor(() => expect(document.activeElement).toBe(composer));
    const prompt = (composer as HTMLTextAreaElement).value;
    expect(prompt).toContain("seq 1 (api.log)");
    expect(prompt).toContain("governed log tools");
    expect(prompt).not.toContain("auth failure");
    expect(screen.getByRole("status").textContent).toContain(
      "Prepared a governed chat question",
    );
  });

  it("saves, reloads, previews, and explicitly reveals durable exact evidence", async () => {
    const event = defaultEventPage().events[0]!;
    const eventRef: host.LogBookmarkEventRefDto = {
      corpusId: "c1",
      seq: event.seq,
      source: event.source,
      timestampHint: event.ts,
      timeQualityHint: event.timeQuality,
    };
    const item: host.InvestigationEvidenceItemDto = {
      id: "019fa8d0-0000-7000-8000-000000000002",
      title: "Authentication failure boundary",
      provenance: "human",
      corpusId: "c1",
      eventRefs: [eventRef],
      createdAt: 2,
      updatedAt: 2,
    };
    const saved = resolvedInvestigation(item, event);
    vi.mocked(host.hostLogAddInvestigationEvidence).mockResolvedValue(saved);
    vi.mocked(host.hostLogPreviewInvestigationEvidence).mockResolvedValue({
      investigationId: saved.document.id,
      revision: saved.document.revision,
      item,
      references: [
        {
          eventRef,
          status: "verified",
          event,
        },
      ],
    });
    vi.mocked(host.hostLogQueryEventNeighborhood).mockResolvedValue(
      eventNeighborhood(event),
    );

    const first = render(<LogExplorer corpusId="c1" />);
    fireEvent.click(await screen.findByText("auth failure"));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Save evidence",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Save selected evidence",
    });
    fireEvent.change(within(dialog).getByLabelText("Evidence title"), {
      target: { value: item.title },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save evidence" }),
    );

    await waitFor(() =>
      expect(host.hostLogAddInvestigationEvidence).toHaveBeenCalledWith("c1", {
        investigationId: null,
        expectedRevision: null,
        title: item.title,
        eventRefs: [eventRef],
      }),
    );
    const evidencePanel = await screen.findByTestId("log-explorer-evidence");
    expect(evidencePanel.textContent).toContain(item.title);
    expect(evidencePanel.textContent).toContain("1 event · 1 source");

    fireEvent.click(
      within(evidencePanel).getByRole("button", { name: "Preview" }),
    );
    await waitFor(() =>
      expect(host.hostLogPreviewInvestigationEvidence).toHaveBeenCalledWith(
        "c1",
        saved.document.id,
        item.id,
      ),
    );
    const preview = screen.getByTestId("evidence-preview");
    expect(preview.textContent).toContain("current view unchanged");
    expect(
      document
        .querySelector<HTMLElement>('[data-seq="1"]')
        ?.classList.contains("log-explorer__row--selected"),
    ).toBe(true);

    fireEvent.click(
      within(preview).getByRole("button", { name: "Reveal in Explorer" }),
    );
    await waitFor(() =>
      expect(host.hostLogQueryEventNeighborhood).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ targetSeq: 1 }),
      ),
    );

    first.unmount();
    vi.mocked(host.hostLogLoadActiveInvestigation).mockResolvedValue(saved);
    render(<LogExplorer corpusId="c1" />);
    await openInvestigationView(1);
    expect(await screen.findByText(item.title)).toBeTruthy();
  });

  it("atomically creates durable human findings and cited notes from exact selected identities", async () => {
    const event = defaultEventPage().events[0]!;
    const eventRef: host.LogBookmarkEventRefDto = {
      corpusId: "c1",
      seq: event.seq,
      source: event.source,
      timestampHint: event.ts,
      timeQualityHint: event.timeQuality,
    };
    const evidenceItem: host.InvestigationEvidenceItemDto = {
      id: "019fa8d0-0000-7000-8000-000000000012",
      title: "Retry storm follows database timeout",
      provenance: "human",
      corpusId: "c1",
      eventRefs: [eventRef],
      createdAt: 3,
      updatedAt: 3,
    };
    const finding: host.InvestigationFindingItemDto = {
      id: "019fa8d0-0000-7000-8000-000000000013",
      kind: "inference",
      lifecycle: "accepted",
      title: "Retry storm follows database timeout",
      whyItMatters: "Retries amplify the original failure.",
      evidenceIds: [evidenceItem.id],
      provenance: "human",
      createdAt: 3,
      updatedAt: 3,
    };
    const note: host.InvestigationNoteItemDto = {
      id: "019fa8d0-0000-7000-8000-000000000014",
      title: "Compare against deployment",
      body: "Confirm whether the onset follows the release window.",
      evidenceIds: [evidenceItem.id],
      findingIds: [],
      provenance: "human",
      createdAt: 4,
      updatedAt: 4,
    };
    const savedFinding = resolvedInvestigation(evidenceItem, event);
    savedFinding.document.revision = 3;
    savedFinding.document.findings = [finding];
    const savedNote: host.ResolvedInvestigationDocumentDto = {
      ...savedFinding,
      document: {
        ...savedFinding.document,
        revision: 4,
        findings: [finding],
        notes: [note],
      },
    };
    const resolvedFinding = { ...finding, lifecycle: "resolved" as const };
    const savedEdit: host.ResolvedInvestigationDocumentDto = {
      ...savedNote,
      document: {
        ...savedNote.document,
        revision: 5,
        findings: [resolvedFinding],
      },
    };
    vi.mocked(host.hostLogAddInvestigationFinding).mockResolvedValue(
      savedFinding,
    );
    vi.mocked(host.hostLogAddInvestigationNote).mockResolvedValue(savedNote);
    vi.mocked(host.hostLogEditInvestigationFinding).mockResolvedValue(
      savedEdit,
    );

    const view = render(<LogExplorer corpusId="c1" />);
    fireEvent.click(await screen.findByText("auth failure"));
    fireEvent.click(screen.getByRole("button", { name: "Add…" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Create finding/ }));
    const findingDialog = await screen.findByRole("dialog", {
      name: "Create finding",
    });
    fireEvent.click(
      within(findingDialog).getByRole("button", { name: /Inference/ }),
    );
    fireEvent.change(within(findingDialog).getByLabelText("Finding title"), {
      target: { value: finding.title },
    });
    fireEvent.change(within(findingDialog).getByLabelText("Why it matters"), {
      target: { value: finding.whyItMatters },
    });
    fireEvent.click(
      within(findingDialog).getByRole("button", { name: "Save finding" }),
    );

    await waitFor(() =>
      expect(host.hostLogAddInvestigationFinding).toHaveBeenCalledWith("c1", {
        investigationId: null,
        expectedRevision: null,
        kind: "inference",
        title: finding.title,
        whyItMatters: finding.whyItMatters,
        eventRefs: [eventRef],
        viewRecipe: expect.objectContaining({
          visibleLaneCount: 1,
          linkMode: "independent",
          selection: [eventRef],
          focusedEvent: eventRef,
        }),
      }),
    );
    const panel = await screen.findByTestId("log-explorer-evidence");
    fireEvent.click(within(panel).getByTestId(`finding-item-${finding.id}`));
    expect(
      within(panel).getByTestId(`finding-detail-${finding.id}`).textContent,
    ).toContain(finding.whyItMatters);
    fireEvent.click(within(panel).getByRole("button", { name: "Back" }));

    fireEvent.click(screen.getByRole("button", { name: "Add…" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Create cited note/ }),
    );
    const noteDialog = await screen.findByRole("dialog", {
      name: "Create cited note",
    });
    fireEvent.change(within(noteDialog).getByLabelText("Note title"), {
      target: { value: note.title },
    });
    fireEvent.change(within(noteDialog).getByLabelText("Investigation note"), {
      target: { value: note.body },
    });
    fireEvent.click(
      within(noteDialog).getByRole("button", { name: "Save note" }),
    );
    await waitFor(() =>
      expect(host.hostLogAddInvestigationNote).toHaveBeenCalledWith("c1", {
        investigationId: savedFinding.document.id,
        expectedRevision: savedFinding.document.revision,
        title: note.title,
        body: note.body,
        eventRefs: [eventRef],
      }),
    );
    expect(await screen.findByText(note.title)).toBeTruthy();

    fireEvent.click(screen.getByTestId(`finding-item-${finding.id}`));
    fireEvent.click(screen.getByRole("button", { name: "Edit finding" }));
    const editDialog = await screen.findByRole("dialog", {
      name: "Edit finding",
    });
    fireEvent.change(within(editDialog).getByLabelText("Finding status"), {
      target: { value: "resolved" },
    });
    fireEvent.click(
      within(editDialog).getByRole("button", { name: "Save changes" }),
    );
    await waitFor(() =>
      expect(host.hostLogEditInvestigationFinding).toHaveBeenCalledWith("c1", {
        investigationId: savedNote.document.id,
        expectedRevision: savedNote.document.revision,
        findingId: finding.id,
        kind: finding.kind,
        lifecycle: "resolved",
        title: finding.title,
        whyItMatters: finding.whyItMatters,
      }),
    );
    expect(
      screen.getByTestId(`finding-detail-${finding.id}`).textContent,
    ).toContain("Inference · resolved");

    view.unmount();
    vi.mocked(host.hostLogLoadActiveInvestigation).mockResolvedValue(savedEdit);
    render(<LogExplorer corpusId="c1" />);
    await openInvestigationView(3);
    expect(
      await screen.findByTestId(`finding-item-${finding.id}`),
    ).toBeTruthy();
    expect(screen.getByTestId(`note-item-${note.id}`)).toBeTruthy();
  });

  it("previews a finding view without mutation, applies it explicitly, and restores the exact prior view", async () => {
    const event = defaultEventPage().events[0]!;
    const eventRef: host.LogBookmarkEventRefDto = {
      corpusId: "c1",
      seq: event.seq,
      source: event.source,
      timestampHint: event.ts,
      timeQualityHint: event.timeQuality,
    };
    const recipe: host.InvestigationViewRecipeDto = {
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
      focusedEvent: eventRef,
      selection: [eventRef],
      highlights: [eventRef],
      find: null,
      viewportAnchors: [{ laneId: "lane-0", eventRef }],
    };
    const finding: host.InvestigationFindingItemDto = {
      id: "019fa8d0-0000-7000-8000-000000000021",
      kind: "observation",
      lifecycle: "accepted",
      title: "Checkout failure view",
      whyItMatters: "The first failure anchors the retry sequence.",
      evidenceIds: [],
      viewRecipe: recipe,
      provenance: "human",
      createdAt: 3,
      updatedAt: 3,
    };
    const loaded: host.ResolvedInvestigationDocumentDto = {
      document: {
        schemaVersion: 3,
        id: "019fa8d0-0000-7000-8000-000000000020",
        revision: 3,
        title: "Investigation · fixture",
        status: "active",
        corpusLinks: [{ corpusId: "c1" }],
        evidence: [],
        findings: [finding],
        notes: [],
        createdAt: 1,
        updatedAt: 3,
      },
      evidence: [],
    };
    const preview = {
      investigationId: loaded.document.id,
      revision: loaded.document.revision,
      findingId: finding.id,
      recipe,
      missingCount: 0,
      staleCount: 0,
    };
    vi.mocked(host.hostLogLoadActiveInvestigation).mockResolvedValue(loaded);
    vi.mocked(host.hostLogPreviewInvestigationFindingView).mockResolvedValue(
      preview,
    );
    vi.mocked(host.hostLogQueryEventNeighborhood).mockResolvedValue(
      eventNeighborhood(event),
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByText("auth failure");
    await openInvestigationView(1);
    fireEvent.click(await screen.findByTestId(`finding-item-${finding.id}`));

    const initialQueryCount = vi.mocked(host.hostLogQueryEvents).mock.calls
      .length;
    fireEvent.click(screen.getByRole("button", { name: "Preview saved view" }));
    const viewPreview = await screen.findByTestId(
      `finding-view-preview-${finding.id}`,
    );
    expect(viewPreview.textContent).toContain(
      "Preview only · current Explorer unchanged",
    );
    expect(viewPreview.textContent).toContain(
      "Filters: All logs → levels error",
    );
    expect(host.hostLogQueryEvents).toHaveBeenCalledTimes(initialQueryCount);

    fireEvent.click(
      within(viewPreview).getByRole("button", {
        name: "Apply saved view",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Applied saved Explorer view",
      ),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("checkbox", {
            name: /error/i,
          }) as HTMLInputElement
        ).checked,
      ).toBe(true),
    );
    const selectedRow = document.querySelector<HTMLElement>(
      `[data-seq="${event.seq}"]`,
    );
    await waitFor(() =>
      expect(
        selectedRow?.classList.contains("log-explorer__row--selected"),
      ).toBe(true),
    );
    expect(
      selectedRow?.classList.contains("log-explorer__row--highlight"),
    ).toBe(true);
    expect(host.hostLogPreviewInvestigationFindingView).toHaveBeenCalledTimes(
      2,
    );

    fireEvent.click(screen.getByTestId("bookmark-restore-view"));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Restored prior Explorer view",
      ),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("checkbox", {
            name: /error/i,
          }) as HTMLInputElement
        ).checked,
      ).toBe(false),
    );
  });

  it("blocks a finding view when its exact references are stale", async () => {
    const event = defaultEventPage().events[0]!;
    const eventRef: host.LogBookmarkEventRefDto = {
      corpusId: "c1",
      seq: event.seq,
      source: event.source,
      timestampHint: event.ts,
      timeQualityHint: event.timeQuality,
    };
    const recipe: host.InvestigationViewRecipeDto = {
      filters: {
        levels: [],
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
      focusedEvent: eventRef,
      selection: [],
      highlights: [],
      find: null,
      viewportAnchors: [],
    };
    const finding: host.InvestigationFindingItemDto = {
      id: "019fa8d0-0000-7000-8000-000000000023",
      kind: "hypothesis",
      lifecycle: "accepted",
      title: "Potentially stale view",
      whyItMatters: "Changed source identity must fail closed.",
      evidenceIds: [],
      viewRecipe: recipe,
      provenance: "human",
      createdAt: 3,
      updatedAt: 3,
    };
    const loaded: host.ResolvedInvestigationDocumentDto = {
      document: {
        schemaVersion: 3,
        id: "019fa8d0-0000-7000-8000-000000000022",
        revision: 3,
        title: "Investigation · fixture",
        status: "active",
        corpusLinks: [{ corpusId: "c1" }],
        evidence: [],
        findings: [finding],
        notes: [],
        createdAt: 1,
        updatedAt: 3,
      },
      evidence: [],
    };
    vi.mocked(host.hostLogLoadActiveInvestigation).mockResolvedValue(loaded);
    vi.mocked(host.hostLogPreviewInvestigationFindingView).mockResolvedValue({
      investigationId: loaded.document.id,
      revision: loaded.document.revision,
      findingId: finding.id,
      recipe,
      missingCount: 0,
      staleCount: 1,
    });

    render(<LogExplorer corpusId="c1" />);
    await screen.findByText("auth failure");
    await openInvestigationView(1);
    fireEvent.click(await screen.findByTestId(`finding-item-${finding.id}`));
    fireEvent.click(screen.getByRole("button", { name: "Preview saved view" }));

    const viewPreview = await screen.findByTestId(
      `finding-view-preview-${finding.id}`,
    );
    expect(viewPreview.textContent).toContain("Apply blocked");
    expect(
      (
        within(viewPreview).getByRole("button", {
          name: "Apply saved view",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(host.hostLogQueryEventNeighborhood).not.toHaveBeenCalled();
  });

  it("revalidates every evidence identity at Reveal time and blocks a changed corpus", async () => {
    const event = defaultEventPage().events[0]!;
    const eventRef: host.LogBookmarkEventRefDto = {
      corpusId: "c1",
      seq: event.seq,
      source: event.source,
      timestampHint: event.ts,
      timeQualityHint: event.timeQuality,
    };
    const item: host.InvestigationEvidenceItemDto = {
      id: "019fa8d0-0000-7000-8000-000000000003",
      title: "Evidence changed after load",
      provenance: "human",
      corpusId: "c1",
      eventRefs: [eventRef],
      createdAt: 2,
      updatedAt: 2,
    };
    const loaded = resolvedInvestigation(item, event);
    vi.mocked(host.hostLogLoadActiveInvestigation).mockResolvedValue(loaded);
    vi.mocked(host.hostLogPreviewInvestigationEvidence).mockResolvedValue({
      investigationId: loaded.document.id,
      revision: loaded.document.revision,
      item,
      references: [
        {
          eventRef,
          status: "stale",
          event: { ...event, source: "moved/api.log" },
        },
      ],
    });

    render(<LogExplorer corpusId="c1" />);
    await openInvestigationView(1);
    fireEvent.click(
      within(await screen.findByTestId(`evidence-item-${item.id}`)).getByRole(
        "button",
        { name: "Reveal" },
      ),
    );

    expect(
      await screen.findByText(
        /Reveal was blocked because the authoritative evidence changed/,
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("evidence-preview").textContent).toContain(
      "1 changed",
    );
    expect(host.hostLogQueryEventNeighborhood).not.toHaveBeenCalled();
  });

  it("does not let an older Investigation metadata load overwrite a newer save", async () => {
    const event = defaultEventPage().events[0]!;
    const eventRef: host.LogBookmarkEventRefDto = {
      corpusId: "c1",
      seq: event.seq,
      source: event.source,
      timestampHint: event.ts,
      timeQualityHint: event.timeQuality,
    };
    const item: host.InvestigationEvidenceItemDto = {
      id: "019fa8d0-0000-7000-8000-000000000004",
      title: "Newly saved evidence wins",
      provenance: "human",
      corpusId: "c1",
      eventRefs: [eventRef],
      createdAt: 2,
      updatedAt: 2,
    };
    const staleLoad = deferred<host.ResolvedInvestigationDocumentDto | null>();
    vi.mocked(host.hostLogLoadActiveInvestigation).mockReturnValue(
      staleLoad.promise,
    );
    vi.mocked(host.hostLogAddInvestigationEvidence).mockResolvedValue(
      resolvedInvestigation(item, event),
    );

    render(<LogExplorer corpusId="c1" />);
    fireEvent.click(await screen.findByText("auth failure"));
    fireEvent.click(screen.getByRole("button", { name: "Save evidence" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Save selected evidence",
    });
    fireEvent.change(within(dialog).getByLabelText("Evidence title"), {
      target: { value: item.title },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save evidence" }),
    );
    expect(await screen.findByText(item.title)).toBeTruthy();

    await act(async () => {
      staleLoad.resolve(null);
      await staleLoad.promise;
    });
    expect(screen.getByText(item.title)).toBeTruthy();
    expect(screen.getByTestId("log-explorer-evidence")).toBeTruthy();
  });

  it.each([
    {
      evidenceStatus: "missing" as const,
      visibleStatus: "Missing",
      message: "Bookmark evidence is missing from this corpus",
    },
    {
      evidenceStatus: "stale" as const,
      visibleStatus: "Stale",
      message: "Bookmark evidence identity no longer matches this corpus",
    },
  ])(
    "keeps $evidenceStatus exact evidence visible and refuses unrelated navigation",
    async ({ evidenceStatus, visibleStatus, message }) => {
      const target = defaultEventPage().events[0]!;
      vi.mocked(host.hostLogListBookmarks).mockResolvedValue([
        {
          id: `bm-${evidenceStatus}`,
          label: "durable exact clue",
          seqFrom: target.seq,
          seqTo: target.seq,
          eventRefs: [
            {
              corpusId: "c1",
              seq: target.seq,
              source: target.source,
              timestampHint: target.ts,
              timeQualityHint: target.timeQuality,
            },
          ],
          evidenceStatus,
          createdAt: 1,
          updatedAt: 1,
        },
      ]);

      render(<LogExplorer corpusId="c1" />);
      expect(
        (
          await screen.findByTestId(
            `bookmark-evidence-status-bm-${evidenceStatus}`,
          )
        ).textContent,
      ).toContain(visibleStatus);
      fireEvent.click(
        screen.getByTestId(`bookmark-activate-bm-${evidenceStatus}`),
      );
      expect(screen.getByRole("status").textContent).toContain(message);
      expect(host.hostLogQueryEventNeighborhood).not.toHaveBeenCalled();
      expect(
        screen.getByTestId(`bookmark-activate-bm-${evidenceStatus}`),
      ).toBeTruthy();
    },
  );

  it("temporarily composes the correct lane for a bookmark outside all visible lanes", async () => {
    const target: host.ExplorerEventDto = {
      seq: 77,
      ts: 1_700_000_077,
      timeQuality: "wall",
      level: "error",
      service: "queue",
      host: null,
      templateId: 77,
      traceId: "trace-77",
      message: "queue poison evidence",
      source: "queue.log",
    };
    vi.mocked(host.hostLogListBookmarks).mockResolvedValue([
      {
        id: "bm-queue",
        label: "queue clue",
        note: null,
        seqFrom: 77,
        seqTo: 77,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    vi.mocked(host.hostLogQueryEvents).mockImplementation(
      async (_corpusId, query) => {
        const sources = query?.sources ?? [];
        const page = sources.includes("queue.log")
          ? {
              ...eventPage("queue.log", "wall"),
              events: [target],
              totalMatched: 1,
            }
          : sources.length > 0
            ? eventPage(sources[0]!, "wall")
            : defaultEventPage();
        return page;
      },
    );
    vi.mocked(host.hostLogQueryEventNeighborhood).mockResolvedValue({
      status: "found",
      target,
      events: [target],
      targetIndex: 0,
      nextCursor: null,
      nextTs: null,
      prevCursor: null,
      prevTs: null,
      totalMatched: 1,
      corpusTotal: 11,
      timeQuality: "wall",
    });

    render(<LogExplorer corpusId="c1" />);
    await screen.findAllByTitle("worker.log");
    chooseLaneCount(2);
    fireEvent.click(screen.getByTestId("lane-editor-toggle"));
    const editor = screen.getByTestId("lane-editor");
    const laneRows = editor.querySelectorAll(".log-explorer__lane-editor-row");
    expect(laneRows.length).toBe(2);
    fireEvent.click(
      await within(laneRows[0] as HTMLElement).findByRole("checkbox", {
        name: /api\.log/i,
      }),
    );
    fireEvent.click(
      await within(laneRows[1] as HTMLElement).findByRole("checkbox", {
        name: /worker\.log/i,
      }),
    );
    await waitFor(() => {
      const sourceCalls = vi
        .mocked(host.hostLogQueryEvents)
        .mock.calls.map(([, query]) => query?.sources ?? []);
      expect(sourceCalls).toContainEqual(["api.log"]);
      expect(sourceCalls).toContainEqual(["worker.log"]);
    });

    fireEvent.click(await screen.findByTestId("bookmark-activate-bm-queue"));
    await screen.findByTestId("bookmark-restore-view");
    await waitFor(() =>
      expect(host.hostLogQueryEventNeighborhood).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          targetSeq: 77,
          filter: expect.objectContaining({ sources: ["queue.log"] }),
        }),
      ),
    );
    expect(screen.getAllByText("queue poison evidence").length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText(/Bookmark · queue\.log/).length).toBeGreaterThan(
      0,
    );

    fireEvent.click(screen.getByTestId("bookmark-restore-view"));
    await waitFor(() => {
      const sourceCalls = vi
        .mocked(host.hostLogQueryEvents)
        .mock.calls.map(([, query]) => query?.sources ?? []);
      expect(sourceCalls.at(-2)).toEqual(["api.log"]);
      expect(sourceCalls.at(-1)).toEqual(["worker.log"]);
    });
  });

  it.each([
    {
      lanes: 2,
      qualities: ["wall", "order_only"] as host.TimeQuality[],
      expected: "order_only",
    },
    {
      lanes: 3,
      qualities: ["mixed", "wall", "mixed"] as host.TimeQuality[],
      expected: "mixed",
    },
    {
      lanes: 4,
      qualities: ["wall", "wall", "wall", "wall"] as host.TimeQuality[],
      expected: "wall",
    },
  ])(
    "aggregates $lanes visible lanes to the least reliable time quality",
    async ({ lanes, qualities, expected }) => {
      const sources = ["api.log", "worker.log", "db.log", "proxy.log"];
      vi.mocked(host.hostLogFacets).mockResolvedValue({
        sources: Object.fromEntries(sources.map((source) => [source, 1])),
        levels: { info: 4 },
        services: {},
        hosts: {},
        timeQuality: "wall",
      });
      vi.mocked(host.hostLogQueryEvents).mockImplementation(
        async (_corpusId, query) => {
          const source = query?.sources?.[0];
          if (!source) return eventPage("all.log", "wall");
          const index = sources.indexOf(source);
          return eventPage(source, qualities[index] ?? "wall");
        },
      );

      // Pre-seed user-composed lanes (no automatic first-N assignment).
      localStorage.setItem(
        "contextdesk.logExplorer.lanes.v1:c1",
        JSON.stringify(
          Array.from({ length: lanes }, (_, i) => ({
            id: `lane-${i}`,
            label: sources[i],
            sources: [sources[i]],
          })),
        ),
      );
      render(<LogExplorer corpusId="c1" />);
      await screen.findByTitle(sources[lanes - 1]!);
      chooseLaneCount(lanes);

      const root = await screen.findByTestId("log-explorer");
      await waitFor(() => {
        expect(root.getAttribute("data-lane-count")).toBe(String(lanes));
        expect(root.getAttribute("data-time-quality")).toBe(expected);
      });
      for (let index = 0; index < lanes; index += 1) {
        const lane = document.querySelector(`[data-lane-id="lane-${index}"]`);
        expect(lane?.getAttribute("data-time-quality")).toBe(qualities[index]);
      }
    },
  );

  it.each([1, 2, 3, 4])(
    "keeps short Deep-mode events compact across %i visible lane(s)",
    async (laneCount) => {
      render(<LogExplorer corpusId="c1" />);
      if (laneCount > 1) {
        chooseLaneCount(laneCount);
      }
      chooseRowMode("Deep");

      await waitFor(() =>
        expect(screen.getAllByTestId("virtualized-event-list")).toHaveLength(
          laneCount,
        ),
      );
      for (const list of screen.getAllByTestId("virtualized-event-list")) {
        expect(list.getAttribute("data-total-height")).toBe("56");
      }
    },
  );

  it("labels corpus, per-lane matched, and resident counts without inventing a global lane total", async () => {
    vi.mocked(host.hostGetLogCorpus).mockResolvedValue({
      id: "c1",
      name: "fixture",
      eventCount: 35,
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
      sources: { "api.log": 6, "audit.log": 4 },
      levels: { info: 10 },
      services: {},
      hosts: {},
      timeQuality: "wall",
    });
    vi.mocked(host.hostLogQueryEvents).mockImplementation(
      async (_corpusId, query) => {
        const source = query?.sources?.[0];
        if (source === "api.log") {
          return eventPage("api.log", "wall", 6, 1_700_000_000, 6);
        }
        if (source === "audit.log") {
          return eventPage("audit.log", "wall", 4, 1_700_000_100, 4);
        }
        return eventPage("all.log", "wall", 2, 1_700_000_000, 35);
      },
    );
    localStorage.setItem(
      "contextdesk.logExplorer.lanes.v1:c1",
      JSON.stringify([
        { id: "lane-0", label: "API", sources: ["api.log"] },
        { id: "lane-1", label: "Audit", sources: ["audit.log"] },
      ]),
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByTitle("audit.log");
    chooseLaneCount(2);

    await waitFor(() => {
      expect(screen.getByTestId("lane-count-lane-0").textContent).toContain(
        "6 matched · 6 resident",
      );
      expect(screen.getByTestId("lane-count-lane-1").textContent).toContain(
        "4 matched · 4 resident",
      );
    });
    const global = screen.getByTestId("log-explorer-global-counts");
    expect(global.textContent).toContain("35 corpus events");
    expect(global.textContent).toContain("2 lane queries");
    expect(global.textContent).not.toMatch(/\b6 events\b/);
    expect(screen.getByTestId("log-explorer-count-truth").textContent).toMatch(
      /matched per lane below · resident rows 10/,
    );
  });

  it("keeps overlapping, empty, and paged lane counts honest across reverse response order", async () => {
    vi.mocked(host.hostGetLogCorpus).mockResolvedValue({
      id: "c1",
      name: "fixture",
      eventCount: 35,
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
      sources: {
        "shared.log": 6,
        "empty.log": 0,
        "paged.log": 100,
      },
      levels: { info: 106 },
      services: {},
      hosts: {},
      timeQuality: "wall",
    });
    const pending = Array.from({ length: 4 }, () =>
      deferred<host.EventPageDto>(),
    );
    let laneRequest = 0;
    let servedInitialOneLane = false;
    vi.mocked(host.hostLogQueryEvents).mockImplementation(
      async (_corpusId, query) => {
        if ((query?.sources?.length ?? 0) === 0) {
          return eventPage("all.log", "wall", 2, 1_700_000_000, 35);
        }
        if (!servedInitialOneLane && query?.sources?.[0] === "shared.log") {
          servedInitialOneLane = true;
          return eventPage("shared.log", "wall", 1, 1_700_000_000, 6);
        }
        return pending[laneRequest++]!.promise;
      },
    );
    localStorage.setItem(
      "contextdesk.logExplorer.lanes.v1:c1",
      JSON.stringify([
        { id: "lane-0", label: "Shared A", sources: ["shared.log"] },
        { id: "lane-1", label: "Shared B", sources: ["shared.log"] },
        { id: "lane-2", label: "Empty", sources: ["empty.log"] },
        { id: "lane-3", label: "Paged", sources: ["paged.log"] },
      ]),
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByTitle("paged.log");
    chooseLaneCount(4);
    await waitFor(() => expect(laneRequest).toBe(4));

    const shared = eventPage("shared.log", "wall", 2, 1_700_000_000, 6);
    shared.nextCursor = shared.events.at(-1)!.seq;
    shared.nextTs = shared.events.at(-1)!.ts;
    const paged = eventPage("paged.log", "wall", 1, 1_700_000_100, 100);
    paged.nextCursor = paged.events[0]!.seq;
    paged.nextTs = paged.events[0]!.ts;
    await act(async () => {
      pending[3]!.resolve(paged);
      pending[1]!.resolve({ ...shared, events: [...shared.events] });
      pending[0]!.resolve(shared);
      pending[2]!.resolve(eventPage("empty.log", "wall", 0, 1_700_000_050, 0));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByTestId("lane-count-lane-3").textContent).toContain(
        "100 matched · 1+ resident",
      ),
    );
    expect(screen.getByTestId("lane-count-lane-0").textContent).toContain(
      "6 matched · 2+ resident",
    );
    expect(screen.getByTestId("lane-count-lane-1").textContent).toContain(
      "6 matched · 2+ resident",
    );
    expect(screen.getByTestId("lane-count-lane-2").textContent).toContain(
      "0 matched · 0 resident",
    );
    const global = screen.getByTestId("log-explorer-global-counts");
    expect(global.textContent).toContain("35 corpus events");
    expect(global.textContent).toContain("4 lane queries");
    expect(global.textContent).not.toMatch(/112 matched|112 events/);
    expect(screen.getByTestId("log-explorer-count-truth").textContent).toMatch(
      /resident rows 5/,
    );
  });

  it("keeps linking off when a visible lane is empty or failed", async () => {
    vi.mocked(host.hostLogFacets).mockResolvedValue({
      sources: { "api.log": 1, "worker.log": 0, "db.log": 1 },
      levels: { info: 2 },
      services: {},
      hosts: {},
      timeQuality: "wall",
    });
    vi.mocked(host.hostLogQueryEvents).mockImplementation(
      async (_corpusId, query) => {
        const source = query?.sources?.[0];
        if (!source) return eventPage("all.log", "wall");
        if (source === "worker.log") return eventPage(source, "wall", 0);
        if (source === "db.log") throw new Error("fixture lane failure");
        return eventPage(source, "wall");
      },
    );

    localStorage.setItem(
      "contextdesk.logExplorer.lanes.v1:c1",
      JSON.stringify([
        { id: "lane-0", label: "api.log", sources: ["api.log"] },
        { id: "lane-1", label: "worker.log", sources: ["worker.log"] },
        { id: "lane-2", label: "db.log", sources: ["db.log"] },
      ]),
    );
    render(<LogExplorer corpusId="c1" />);
    await screen.findByTitle("db.log");
    chooseLaneCount(3);
    const root = screen.getByTestId("log-explorer");
    await waitFor(() => {
      expect(root.getAttribute("data-time-quality")).toBe("order_only");
      expect(
        document
          .querySelector('[data-lane-id="lane-1"]')
          ?.getAttribute("data-time-status"),
      ).toBe("empty");
      expect(
        document
          .querySelector('[data-lane-id="lane-2"]')
          ?.getAttribute("data-time-status"),
      ).toBe("error");
    });
    expect(screen.getByText(/evidence lane failed to load/)).toBeTruthy();
    expect(screen.getByTestId("lane-count-lane-2").textContent).toContain(
      "matched unavailable",
    );

    chooseTimeMode("Follow selection");
    // Order-only aggregate refuses wall-clock link.
    expect(root.getAttribute("data-link-mode")).toBe("independent");
    expect(screen.queryByTestId("log-explorer-gap")).toBeNull();
  });

  it("preserves wall-clock quality through an empty Find and Filter intersection, then restores Align", async () => {
    const visible = defaultEventPage().events[0]!;
    vi.mocked(host.hostLogSearchEventsAdvanced).mockResolvedValue({
      hits: [
        {
          event: visible,
          score: 1,
          matchKind: "keyword",
          templateId: visible.templateId,
        },
      ],
      nextCursor: null,
      nextTs: null,
      totalMatched: 1,
      partial: false,
      scanned: 1,
    });
    vi.mocked(host.hostLogQueryEvents).mockImplementation(
      async (_corpusId, query) => {
        if (query?.keyword === "no-shared-result") {
          return eventPage(query.sources?.[0] ?? "all.log", "wall", 0);
        }
        return eventPage(query?.sources?.[0] ?? "all.log", "wall");
      },
    );
    localStorage.setItem(
      "contextdesk.logExplorer.lanes.v1:c1",
      JSON.stringify([
        { id: "lane-0", label: "API", sources: ["api.log"] },
        { id: "lane-1", label: "Worker", sources: ["worker.log"] },
      ]),
    );

    render(<LogExplorer corpusId="c1" />);
    chooseLaneCount(2);
    const root = screen.getByTestId("log-explorer");
    await waitFor(() =>
      expect(root.getAttribute("data-time-quality")).toBe("wall"),
    );
    chooseTimeMode("Align exact time");
    expect(root.getAttribute("data-link-mode")).toBe("align_time");

    fireEvent.change(screen.getByTestId("log-explorer-find"), {
      target: { value: "rare identity" },
    });
    await clickFindWhenReady();
    expect(
      await screen.findByText(/Match 1 of 1.*1 result identities resident/),
    ).toBeTruthy();

    fireEvent.change(screen.getByTestId("log-explorer-filter"), {
      target: { value: "no-shared-result" },
    });
    fireEvent.click(screen.getByTestId("log-explorer-filter-apply"));
    await waitFor(() => {
      expect(root.getAttribute("data-time-quality")).toBe("wall");
      expect(root.getAttribute("data-link-mode")).toBe("independent");
      expect(
        document
          .querySelector('[data-lane-id="lane-0"]')
          ?.getAttribute("data-time-status"),
      ).toBe("empty");
    });
    expect(
      screen.getAllByText("time unavailable · no matching events"),
    ).toHaveLength(2);
    expect(
      screen.getByTestId("log-explorer-global-counts").textContent,
    ).toContain("wall clock");
    expect(
      screen.getByTestId("log-explorer-global-counts").textContent,
    ).not.toContain("order only");
    chooseTimeMode("Align exact time");
    expect(root.getAttribute("data-link-mode")).toBe("independent");
    const unavailableAlign = screen.getByRole("menuitemradio", {
      name: /^Align exact time\b/,
    }) as HTMLButtonElement;
    expect(unavailableAlign.disabled).toBe(true);
    expect(unavailableAlign.title).toBe(
      "Every visible lane needs matching events.",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "keyword:no-shared-result ×" }),
    );
    await waitFor(() => {
      expect(root.getAttribute("data-time-quality")).toBe("wall");
      expect(
        document
          .querySelector('[data-lane-id="lane-0"]')
          ?.getAttribute("data-time-status"),
      ).toBe("loaded");
    });
    chooseTimeMode("Align exact time");
    expect(root.getAttribute("data-link-mode")).toBe("align_time");
  });

  it.each([
    ["order_only", "order only (not calendar time)"],
    ["mixed", "mixed time quality"],
  ] as const)(
    "retains known %s quality for an empty result and refuses Align",
    async (quality, label) => {
      vi.mocked(host.hostLogFacets).mockResolvedValue({
        sources: { "api.log": 1 },
        levels: { info: 1 },
        services: {},
        hosts: {},
        timeQuality: quality,
      });
      vi.mocked(host.hostLogQueryEvents).mockResolvedValue(
        eventPage("api.log", quality, 0),
      );

      render(<LogExplorer corpusId="c1" />);
      const root = await screen.findByTestId("log-explorer");
      await waitFor(() => {
        expect(root.getAttribute("data-time-quality")).toBe(quality);
        expect(
          document
            .querySelector('[data-lane-id="lane-0"]')
            ?.getAttribute("data-time-status"),
        ).toBe("empty");
      });
      expect(
        screen.getByTestId("log-explorer-global-counts").textContent,
      ).toContain(label);
      expect(
        screen.getByText("time unavailable · no matching events"),
      ).toBeTruthy();
      chooseTimeMode("Align exact time");
      expect(root.getAttribute("data-link-mode")).toBe("independent");
      const unavailableAlign = screen.getByRole("menuitemradio", {
        name: /^Align exact time\b/,
      }) as HTMLButtonElement;
      expect(unavailableAlign.disabled).toBe(true);
      expect(unavailableAlign.title).toBe(
        "Every visible lane needs matching events.",
      );
    },
  );

  it("aligns wall-clock lanes on shared virtual rows with explicit empty cells and synchronized scroll", async () => {
    const makeEvent = (
      seq: number,
      ts: number,
      source: string,
    ): host.ExplorerEventDto => ({
      seq,
      ts,
      timeQuality: "wall",
      level: "info",
      service: source,
      host: null,
      templateId: 1,
      traceId: null,
      message: `${source} seq ${seq} ${"detail ".repeat(40)}`,
      source,
    });
    vi.mocked(host.hostLogFacets).mockResolvedValue({
      sources: { "api.log": 2, "worker.log": 2 },
      levels: { info: 4 },
      services: {},
      hosts: {},
      timeQuality: "wall",
    });
    vi.mocked(host.hostLogQueryEvents).mockImplementation(
      async (_corpusId, query) => {
        const source = query?.sources?.[0];
        const events =
          source === "api.log"
            ? [
                makeEvent(11, 1_700_000_000, "api.log"),
                makeEvent(13, 1_700_000_002, "api.log"),
              ]
            : source === "worker.log"
              ? [
                  makeEvent(21, 1_700_000_000, "worker.log"),
                  makeEvent(22, 1_700_000_001, "worker.log"),
                ]
              : [makeEvent(1, 1_700_000_000, "all.log")];
        return {
          events,
          nextCursor: null,
          nextTs: null,
          totalMatched: events.length,
          timeQuality: "wall",
        };
      },
    );
    localStorage.setItem(
      "contextdesk.logExplorer.lanes.v1:c1",
      JSON.stringify([
        { id: "lane-0", label: "API", sources: ["api.log"] },
        { id: "lane-1", label: "Worker", sources: ["worker.log"] },
      ]),
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByTitle("worker.log");
    chooseLaneCount(2);
    const root = screen.getByTestId("log-explorer");
    await waitFor(() =>
      expect(root.getAttribute("data-time-quality")).toBe("wall"),
    );
    chooseTimeMode("Align exact time");
    await waitFor(() =>
      expect(root.getAttribute("data-link-mode")).toBe("align_time"),
    );
    chooseRowMode("Deep");
    for (const message of document.querySelectorAll<HTMLElement>(
      "[data-row-message-seq]",
    )) {
      const seq = Number(message.dataset.rowMessageSeq);
      Object.defineProperty(message, "scrollHeight", {
        configurable: true,
        value: seq === 11 ? 90 : seq === 21 ? 54 : 18,
      });
    }
    openToolbarPicker("row-mode-picker");
    fireEvent.change(screen.getByTestId("preview-lines"), {
      target: { value: "12" },
    });

    expect(root.getAttribute("data-aligned-slots")).toBe("3");
    expect(screen.getByTestId("aligned-time-axis").textContent).toMatch(
      /3 resident slots/,
    );
    const lists = screen.getAllByTestId("virtualized-event-list");
    expect(lists).toHaveLength(2);
    expect(lists[0]!.getAttribute("data-aligned-slots")).toBe("3");
    expect(lists[1]!.getAttribute("data-aligned-slots")).toBe("3");
    await waitFor(() => {
      expect(lists[0]!.getAttribute("data-total-height")).toBe("158");
      expect(lists[1]!.getAttribute("data-total-height")).toBe("158");
    });
    chooseRowMode("Single line");
    fireEvent.click(screen.getByTestId("expand-row-11"));
    const expandedMessage = document.querySelector<HTMLElement>(
      '[data-row-message-seq="11"]',
    );
    expect(expandedMessage).toBeTruthy();
    expect(document.querySelector('[data-row-message-seq="21"]')).toBeNull();
    Object.defineProperty(expandedMessage!, "scrollHeight", {
      configurable: true,
      value: 90,
    });
    openToolbarPicker("row-mode-picker");
    fireEvent.change(screen.getByTestId("preview-lines"), {
      target: { value: "8" },
    });
    await waitFor(() => {
      expect(lists[0]!.getAttribute("data-total-height")).toBe("158");
      expect(lists[1]!.getAttribute("data-total-height")).toBe("158");
    });
    expect(screen.getAllByTestId("aligned-gap")).toHaveLength(2);
    expect(
      (document.querySelector('[data-seq="11"]') as HTMLElement).style.top,
    ).toBe(
      (document.querySelector('[data-seq="21"]') as HTMLElement).style.top,
    );

    lists[0]!.scrollTop = 42;
    fireEvent.scroll(lists[0]!);
    await waitFor(() => expect(lists[1]!.scrollTop).toBe(42));
  });

  it("refuses exact Align for mixed time while retaining approximate Follow", async () => {
    vi.mocked(host.hostLogFacets).mockResolvedValue({
      sources: { "api.log": 1, "worker.log": 1 },
      levels: { info: 2 },
      services: {},
      hosts: {},
      timeQuality: "mixed",
    });
    vi.mocked(host.hostLogQueryEvents).mockImplementation(
      async (_corpusId, query) =>
        eventPage(
          query?.sources?.[0] ?? "all.log",
          query?.sources?.[0] === "worker.log" ? "mixed" : "wall",
        ),
    );
    localStorage.setItem(
      "contextdesk.logExplorer.lanes.v1:c1",
      JSON.stringify([
        { id: "lane-0", label: "API", sources: ["api.log"] },
        { id: "lane-1", label: "Worker", sources: ["worker.log"] },
      ]),
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByTitle("worker.log");
    chooseLaneCount(2);
    const root = screen.getByTestId("log-explorer");
    await waitFor(() =>
      expect(root.getAttribute("data-time-quality")).toBe("mixed"),
    );
    chooseTimeMode("Align exact time");
    expect(root.getAttribute("data-link-mode")).toBe("independent");
    const unavailableAlign = screen.getByRole("menuitemradio", {
      name: /^Align exact time\b/,
    }) as HTMLButtonElement;
    expect(unavailableAlign.disabled).toBe(true);
    expect(unavailableAlign.title).toMatch(
      /mixed time quality.*not a reliable shared wall clock/,
    );

    chooseTimeMode("Follow selection");
    expect(root.getAttribute("data-link-mode")).toBe("follow_cursor");
    expect(screen.queryByTestId("aligned-time-axis")).toBeNull();
  });

  it("user-composed lanes assign sources without auto first-N assignment", async () => {
    vi.mocked(host.hostLogFacets).mockResolvedValue({
      sources: { "api.log": 1, "worker.log": 1 },
      levels: { info: 2 },
      services: {},
      hosts: {},
      timeQuality: "wall",
    });
    vi.mocked(host.hostLogQueryEvents).mockImplementation(
      async (_corpusId, query) => {
        const source = query?.sources?.[0];
        if (!source) return eventPage("all.log", "wall");
        return source === "api.log"
          ? eventPage(source, "wall", 1, 1_700_000_000)
          : eventPage(source, "mixed", 1, 1_700_000_100);
      },
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByTitle("worker.log");
    chooseLaneCount(2);
    // New behavior: both lanes start as All sources — not auto-split by first-N.
    fireEvent.click(screen.getByTestId("lane-editor-toggle"));
    const editor = await screen.findByTestId("lane-editor");
    expect(editor.textContent).toMatch(/All sources/);
    // Compose lane-0 → api only, lane-1 → worker only.
    const checks = await within(editor).findAllByRole("checkbox");
    // First source checkbox for lane-0
    fireEvent.click(checks[0]!);
    // Second lane's worker checkbox (after lane-0's sources)
    fireEvent.click(checks[checks.length - 1]!);
    const root = screen.getByTestId("log-explorer");
    await waitFor(() =>
      expect(root.getAttribute("data-time-quality")).toBe("mixed"),
    );

    chooseTimeMode("Follow selection");
    await waitFor(() =>
      expect(root.getAttribute("data-link-mode")).toBe("follow_cursor"),
    );
  });

  it("applies composed source membership in 1L and intersects global source filters", async () => {
    vi.mocked(host.hostLogFacets).mockResolvedValue({
      sources: { "api.log": 6, "worker.log": 7, "db.log": 6 },
      levels: { info: 19 },
      services: {},
      hosts: {},
      timeQuality: "wall",
    });
    localStorage.setItem(
      "contextdesk.logExplorer.lanes.v1:c1",
      JSON.stringify([
        {
          id: "lane-0",
          label: "2 sources",
          sources: ["api.log", "worker.log"],
        },
      ]),
    );
    vi.mocked(host.hostLogQueryEvents).mockImplementation(
      async (_corpusId, query) => {
        const querySources = query?.sources ?? ["all.log"];
        return {
          events: querySources.map((source, index) => ({
            seq: index + 1,
            ts: 1_700_000_000 + index,
            timeQuality: "wall" as const,
            level: "info",
            service: "fixture",
            host: null,
            templateId: 1,
            traceId: null,
            message: `${source} scoped row`,
            source,
          })),
          nextCursor: null,
          nextTs: null,
          totalMatched: querySources.length,
          timeQuality: "wall",
        };
      },
    );

    render(<LogExplorer corpusId="c1" />);

    await waitFor(() =>
      expect(host.hostLogQueryEvents).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          sources: ["api.log", "worker.log"],
        }),
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("log-explorer-count-truth").textContent,
      ).toMatch(/matched 2/),
    );

    const eventQueryCalls = vi.mocked(host.hostLogQueryEvents).mock.calls
      .length;
    fireEvent.click(await screen.findByRole("checkbox", { name: /db\.log/ }));

    await waitFor(() =>
      expect(
        screen.getByTestId("log-explorer-count-truth").textContent,
      ).toMatch(/matched 0/),
    );
    expect(host.hostLogQueryEvents).toHaveBeenCalledTimes(eventQueryCalls);
  });

  it("opens the compact lane composer, assigns sources independently, and restores focus on Done", async () => {
    render(<LogExplorer corpusId="c1" />);
    const toggle = await screen.findByTestId("lane-editor-toggle");
    chooseLaneCount(2);
    fireEvent.click(toggle);

    const editor = await screen.findByTestId("lane-editor");
    expect(editor.getAttribute("role")).toBe("dialog");
    expect(editor.getAttribute("data-lane-editor-mode")).toBe("popover");
    expect(editor.textContent).toContain("2 visible lanes");
    await waitFor(() =>
      expect(editor.textContent).toContain("2 available sources"),
    );
    expect(document.activeElement).toBe(
      screen.getByTestId("lane-editor-close"),
    );
    const editorContent = editor.querySelector(
      ".log-explorer__lane-editor-content",
    ) as HTMLElement;
    expect(editorContent.style.scrollbarGutter).toBe("stable");
    expect(editorContent.style.paddingInlineEnd).toBe("0.25rem");

    const laneRows = editor.querySelectorAll(".log-explorer__lane-editor-row");
    fireEvent.click(
      within(laneRows[0] as HTMLElement).getByRole("checkbox", {
        name: /api\.log/i,
      }),
    );
    fireEvent.click(
      within(laneRows[0] as HTMLElement).getByRole("checkbox", {
        name: /worker\.log/i,
      }),
    );
    fireEvent.click(
      within(laneRows[1] as HTMLElement).getByRole("checkbox", {
        name: /api\.log/i,
      }),
    );
    expect(screen.getByTestId("lane-editor-summary-lane-0").textContent).toBe(
      "2 sources",
    );
    expect(screen.getByTestId("lane-editor-summary-lane-1").textContent).toBe(
      "1 source",
    );
    fireEvent.click(screen.getByTestId("lane-editor-close"));
    await waitFor(() => expect(document.activeElement).toBe(toggle));
    expect(screen.queryByTestId("lane-editor")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByTestId("lane-editor-summary-lane-0").textContent).toBe(
      "2 sources",
    );
    expect(screen.getByTestId("lane-editor-summary-lane-1").textContent).toBe(
      "1 source",
    );
    fireEvent.click(screen.getByTestId("lane-editor-close"));
  });

  it("preserves hidden lane memberships across visible lane-count changes", async () => {
    render(<LogExplorer corpusId="c1" />);
    const toggle = await screen.findByTestId("lane-editor-toggle");

    chooseLaneCount(2);
    fireEvent.click(toggle);
    let editor = await screen.findByTestId("lane-editor");
    let laneRows = editor.querySelectorAll(".log-explorer__lane-editor-row");
    fireEvent.click(
      (await within(laneRows[0] as HTMLElement).findAllByRole("checkbox"))[0]!,
    );
    fireEvent.click(
      (await within(laneRows[1] as HTMLElement).findAllByRole("checkbox"))[1]!,
    );
    expect(screen.getByTestId("lane-editor-summary-lane-0").textContent).toBe(
      "1 source",
    );
    expect(screen.getByTestId("lane-editor-summary-lane-1").textContent).toBe(
      "1 source",
    );
    fireEvent.click(screen.getByTestId("lane-editor-close"));

    chooseLaneCount(1);
    chooseLaneCount(2);
    fireEvent.click(toggle);
    editor = await screen.findByTestId("lane-editor");
    laneRows = editor.querySelectorAll(".log-explorer__lane-editor-row");

    expect(screen.getByTestId("lane-editor-summary-lane-0").textContent).toBe(
      "1 source",
    );
    expect(screen.getByTestId("lane-editor-summary-lane-1").textContent).toBe(
      "1 source",
    );
    expect(
      within(laneRows[1] as HTMLElement)
        .getAllByRole("checkbox")
        .filter((check) => (check as HTMLInputElement).checked),
    ).toHaveLength(1);
  });

  it("closes the lane composer on Escape and outside click without losing composed lanes", async () => {
    render(<LogExplorer corpusId="c1" />);
    const toggle = await screen.findByTestId("lane-editor-toggle");
    fireEvent.click(toggle);
    const editor = await screen.findByTestId("lane-editor");
    fireEvent.click(
      await within(editor).findByRole("checkbox", { name: /worker\.log/i }),
    );
    fireEvent.keyDown(screen.getByTestId("lane-editor-close"), {
      key: "Escape",
    });
    await waitFor(() => expect(document.activeElement).toBe(toggle));

    fireEvent.click(toggle);
    await screen.findByTestId("lane-editor");
    const outsideTarget = screen.getByTestId("log-explorer-find");
    fireEvent.mouseDown(outsideTarget);
    outsideTarget.focus();
    expect(document.activeElement).toBe(outsideTarget);
    expect(screen.getByTestId("lane-editor")).not.toBeNull();
    fireEvent.mouseUp(outsideTarget);
    fireEvent.click(outsideTarget);
    await waitFor(() => expect(screen.queryByTestId("lane-editor")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(toggle));

    fireEvent.click(toggle);
    expect(screen.getByTestId("lane-editor-summary-lane-0").textContent).toBe(
      "1 source",
    );
  });

  it("keeps the full lane source catalog editable under a conflicting source filter", async () => {
    vi.mocked(host.hostLogFacets).mockImplementation(
      async (_corpusId, query) => {
        const sourceFilter = query?.sources ?? [];
        return {
          sources:
            sourceFilter.length === 1
              ? { [sourceFilter[0]!]: 5 }
              : { "api.log": 5, "worker.log": 5 },
          levels: { error: 3, info: 7 },
          services: { api: 5 },
          hosts: {},
          timeQuality: "wall",
        };
      },
    );

    render(<LogExplorer corpusId="c1" />);
    const toggle = await screen.findByTestId("lane-editor-toggle");
    fireEvent.click(toggle);
    let editor = await screen.findByTestId("lane-editor");
    fireEvent.click(
      await within(editor).findByRole("checkbox", { name: /api\.log/i }),
    );
    fireEvent.click(
      await within(editor).findByRole("checkbox", { name: /worker\.log/i }),
    );
    fireEvent.click(screen.getByTestId("lane-editor-close"));

    const filtersPanel = screen.getByTestId("log-explorer-filters");
    fireEvent.click(
      within(filtersPanel).getByRole("checkbox", { name: /api\.log/i }),
    );
    await screen.findByRole("button", { name: "source:api.log ×" });
    await waitFor(() =>
      expect(
        within(filtersPanel).queryByRole("checkbox", {
          name: /worker\.log/i,
        }),
      ).toBeNull(),
    );

    fireEvent.click(toggle);
    editor = await screen.findByTestId("lane-editor");
    expect(editor.textContent).toContain("2 available sources");
    const apiSource = within(editor).getByRole("checkbox", {
      name: /api\.log/i,
    }) as HTMLInputElement;
    const workerSource = within(editor).getByRole("checkbox", {
      name: /worker\.log/i,
    }) as HTMLInputElement;
    expect(apiSource.checked).toBe(true);
    expect(workerSource.checked).toBe(true);

    fireEvent.click(workerSource);
    expect(screen.getByTestId("lane-editor-summary-lane-0").textContent).toBe(
      "1 source",
    );
    expect(
      screen.getByRole("button", { name: "source:api.log ×" }),
    ).toBeTruthy();
  });

  it("pages and searches all 241 full source paths without losing lane membership", async () => {
    const sourcePaths = Array.from(
      { length: 241 },
      (_, index) => `region-${String(index).padStart(3, "0")}/service.log`,
    );
    vi.mocked(host.hostLogSourceCatalog).mockImplementation(
      async (_corpusId, query = {}) => {
        const search = query.search?.toLocaleLowerCase() ?? "";
        const matching = sourcePaths.filter((source) =>
          source.toLocaleLowerCase().includes(search),
        );
        const start = query.cursor
          ? Math.max(0, matching.indexOf(query.cursor) + 1)
          : 0;
        const limit = query.limit ?? 100;
        const page = matching.slice(start, start + limit);
        return {
          sources: page.map((source) => ({ source, eventCount: 1 })),
          nextCursor:
            start + page.length < matching.length
              ? (page[page.length - 1] ?? null)
              : null,
          totalMatched: matching.length,
        };
      },
    );

    render(<LogExplorer corpusId="c1" />);
    const toggle = await screen.findByTestId("lane-editor-toggle");
    expect(host.hostLogSourceCatalog).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    const editor = await screen.findByTestId("lane-editor");
    const lane = editor.querySelector(
      ".log-explorer__lane-editor-row",
    ) as HTMLElement;

    await waitFor(() =>
      expect(within(lane).getAllByRole("checkbox")).toHaveLength(200),
    );
    fireEvent.click(
      within(editor).getByRole("button", {
        name: "Load more sources (41 remaining)",
      }),
    );
    await waitFor(() =>
      expect(within(lane).getAllByRole("checkbox")).toHaveLength(241),
    );
    expect(
      within(lane).getByRole("checkbox", {
        name: "region-240/service.log",
      }),
    ).toBeTruthy();
    expect(
      within(lane)
        .getByRole("button", { name: "All sources active" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    const sourceSearch = within(editor).getByRole("searchbox", {
      name: "Find source",
    });
    fireEvent.change(sourceSearch, { target: { value: "region-240/" } });
    await waitFor(() =>
      expect(within(lane).getAllByRole("checkbox")).toHaveLength(1),
    );

    fireEvent.click(
      within(lane).getByRole("checkbox", {
        name: "region-240/service.log",
      }),
    );
    expect(screen.getByTestId("lane-editor-summary-lane-0").textContent).toBe(
      "1 source",
    );

    fireEvent.change(sourceSearch, { target: { value: "region-001/" } });
    await waitFor(() =>
      expect(
        within(lane).getByRole("checkbox", {
          name: "region-001/service.log",
        }),
      ).toBeTruthy(),
    );
    expect(screen.getByTestId("lane-editor-summary-lane-0").textContent).toBe(
      "1 source",
    );

    fireEvent.change(sourceSearch, { target: { value: "region-240/" } });
    const selectedSource = await within(lane).findByRole("checkbox", {
      name: "region-240/service.log",
    });
    expect((selectedSource as HTMLInputElement).checked).toBe(true);

    fireEvent.click(
      within(lane).getByRole("button", { name: "Use all sources" }),
    );
    expect(screen.getByTestId("lane-editor-summary-lane-0").textContent).toBe(
      "All sources",
    );
    expect(
      within(lane)
        .getByRole("button", { name: "All sources active" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(
      within(lane).getByRole("button", {
        name: "Restore 1 selected source",
      }),
    );
    expect(
      (
        within(lane).getByRole("checkbox", {
          name: "region-240/service.log",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(screen.getByTestId("lane-editor-summary-lane-0").textContent).toBe(
      "1 source",
    );
  });

  it("keeps all-sources lanes explicit in shared timeline requests", async () => {
    render(<LogExplorer corpusId="c1" />);

    chooseLaneCount(2);

    await waitFor(() => {
      expect(
        vi
          .mocked(host.hostLogSharedTimelineSummary)
          .mock.calls.some(
            ([, , lanes]) =>
              lanes?.length === 2 &&
              lanes.every(
                (lane) => lane.allSources === true && lane.sources.length === 0,
              ),
          ),
      ).toBe(true);
    });
  });

  it("ignores a stale source-catalog response after the corpus changes", async () => {
    const first = deferred<host.LogSourceCatalogPageDto>();
    vi.mocked(host.hostLogSourceCatalog).mockImplementation(
      async (requestedCorpusId) => {
        if (requestedCorpusId === "c1") return first.promise;
        return {
          sources: [{ source: "new-corpus/app.log", eventCount: 1 }],
          nextCursor: null,
          totalMatched: 1,
        };
      },
    );

    const view = render(<LogExplorer corpusId="c1" />);
    fireEvent.click(await screen.findByTestId("lane-editor-toggle"));
    await waitFor(() =>
      expect(host.hostLogSourceCatalog).toHaveBeenCalledWith(
        "c1",
        expect.anything(),
      ),
    );

    view.rerender(<LogExplorer corpusId="c2" />);
    expect(
      await screen.findByRole("checkbox", { name: "new-corpus/app.log" }),
    ).toBeTruthy();

    first.resolve({
      sources: [{ source: "stale-corpus/app.log", eventCount: 1 }],
      nextCursor: null,
      totalMatched: 1,
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      screen.queryByRole("checkbox", { name: "stale-corpus/app.log" }),
    ).toBeNull();
  });

  it("uses a bounded sheet mode on narrow windows while keeping the same lane editor controls", async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 800,
    });
    try {
      render(<LogExplorer corpusId="c1" />);
      const root = await screen.findByTestId("log-explorer");
      await waitFor(() =>
        expect(root.getAttribute("data-breakpoint")).toBe("narrow"),
      );
      const toggle = screen.getByTestId("lane-editor-toggle");
      fireEvent.click(toggle);
      const editor = await screen.findByTestId("lane-editor");
      expect(editor.getAttribute("data-lane-editor-mode")).toBe("sheet");
      expect(screen.getByTestId("lane-editor-close")).toBeTruthy();
      fireEvent.keyDown(screen.getByTestId("lane-editor-close"), {
        key: "Escape",
      });
      await waitFor(() => expect(document.activeElement).toBe(toggle));
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalWidth,
      });
    }
  });

  it("does not let a stale page response overwrite a newer filter load", async () => {
    const pages: Array<{
      promise: Promise<host.EventPageDto>;
      resolve: (value: host.EventPageDto) => void;
    }> = [];
    vi.mocked(host.hostLogQueryEvents).mockImplementation(async () => {
      const pending = deferred<host.EventPageDto>();
      pages.push(pending);
      return pending.promise;
    });

    render(<LogExplorer corpusId="c1" />);
    const root = await screen.findByTestId("log-explorer");
    await waitFor(() => expect(pages.length).toBeGreaterThanOrEqual(1));

    // Trigger a second load via filter keyword while first is still pending.
    fireEvent.change(screen.getByTestId("log-explorer-filter"), {
      target: { value: "job-7f3a" },
    });
    fireEvent.click(screen.getByTestId("log-explorer-filter-apply"));
    await waitFor(() => expect(pages.length).toBeGreaterThanOrEqual(2));

    await act(async () => {
      // Resolve older request second with wall late.log — must not win.
      pages[1]!.resolve(eventPage("filter.log", "order_only"));
      pages[0]!.resolve(eventPage("late.log", "wall"));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByText(/filter\.log event 0/)).toBeTruthy(),
    );
    expect(screen.queryByText(/late\.log event 0/)).toBeNull();
    expect(root.getAttribute("data-time-quality")).toBe("order_only");
  });

  it("pages backward and forward through the real lane while preserving resident rows", async () => {
    const pageEvent = (
      seq: number,
      message: string,
    ): host.ExplorerEventDto => ({
      seq,
      ts: 1_700_000_000 + seq,
      timeQuality: "wall",
      level: "info",
      service: "api",
      host: null,
      templateId: 1,
      traceId: null,
      message,
      source: "api.log",
    });
    vi.mocked(host.hostLogQueryEvents).mockImplementation(
      async (_corpusId, query) => {
        if (query?.beforeSeq === 101) {
          return {
            events: [pageEvent(99, "older 99"), pageEvent(100, "older 100")],
            prevCursor: null,
            prevTs: null,
            nextCursor: 100,
            nextTs: 1_700_000_100,
            totalMatched: 6,
            timeQuality: "wall",
          };
        }
        if (query?.afterSeq === 102) {
          return {
            events: [pageEvent(103, "newer 103"), pageEvent(104, "newer 104")],
            prevCursor: 103,
            prevTs: 1_700_000_103,
            nextCursor: null,
            nextTs: null,
            totalMatched: 6,
            timeQuality: "wall",
          };
        }
        return {
          events: [pageEvent(101, "middle 101"), pageEvent(102, "middle 102")],
          prevCursor: 101,
          prevTs: 1_700_000_101,
          nextCursor: 102,
          nextTs: 1_700_000_102,
          totalMatched: 6,
          timeQuality: "wall",
        };
      },
    );

    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    render(<LogExplorer corpusId="c1" />);
    await screen.findByText("middle 101");
    expect(screen.queryByText("Load older")).toBeNull();
    expect(screen.queryByText("Load newer")).toBeNull();

    scrollLaneToEdge("older");
    expect(await screen.findByText("older 99")).toBeTruthy();
    expect(screen.getByText("middle 101")).toBeTruthy();
    expect(host.hostLogQueryEvents).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        beforeSeq: 101,
        beforeTs: 1_700_000_101,
      }),
    );

    clock.mockReturnValue(1_300);
    scrollLaneToEdge("newer");
    expect(await screen.findByText("newer 104")).toBeTruthy();
    expect(screen.getByText("older 100")).toBeTruthy();
    expect(host.hostLogQueryEvents).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        afterSeq: 102,
        afterTs: 1_700_000_102,
      }),
    );
    expect(screen.queryByText("Load older")).toBeNull();
    expect(screen.queryByText("Load newer")).toBeNull();
    clock.mockRestore();
  });

  it("labels exact matched-range boundaries without inert paging controls", async () => {
    vi.mocked(host.hostLogQueryEvents).mockImplementation(
      async (_corpusId, query) =>
        query?.keyword === "nothing-here"
          ? eventPage("api.log", "wall", 0, 1_700_000_000, 0)
          : eventPage("api.log", "wall", 2, 1_700_000_000, 2),
    );

    render(<LogExplorer corpusId="c1" />);
    const loaded = await screen.findByText("All matched logs loaded");
    expect(loaded.title).toBe(
      "All 2 events matching this lane are in the resident window.",
    );
    expect(screen.queryByText("Beginning")).toBeNull();
    expect(screen.queryByText("End")).toBeNull();
    expect(screen.queryByText("Load older")).toBeNull();
    expect(screen.queryByText("Load newer")).toBeNull();

    fireEvent.change(screen.getByTestId("log-explorer-filter"), {
      target: { value: "nothing-here" },
    });
    fireEvent.click(screen.getByTestId("log-explorer-filter-apply"));
    const empty = await screen.findByText("No matching logs");
    expect(empty.title).toBe(
      "No events match this lane's sources and active filters.",
    );
  });

  it("places the start boundary above the lane event viewport", async () => {
    const firstPage = eventPage("api.log", "wall", 2, 1_700_000_000, 4);
    firstPage.nextCursor = firstPage.events.at(-1)!.seq;
    firstPage.nextTs = firstPage.events.at(-1)!.ts;
    vi.mocked(host.hostLogQueryEvents).mockResolvedValue(firstPage);

    render(<LogExplorer corpusId="c1" />);

    const boundary = await screen.findByTestId("lane-boundary-start-lane-0");
    const viewport = screen.getByTestId("virtualized-event-list");
    expect(
      boundary.compareDocumentPosition(viewport) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(screen.queryByTestId("lane-paging-lane-0")).toBeNull();
  });

  it("keeps a paging failure local to its lane and retries without clearing evidence", async () => {
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

    render(<LogExplorer corpusId="c1" />);
    await screen.findByText("auth failure");
    scrollLaneToEdge("newer");
    const alert = await screen.findByTestId("lane-page-error-lane-0");
    expect(within(alert).getByText(/fixture page unavailable/)).toBeTruthy();
    expect(screen.getByText("auth failure")).toBeTruthy();

    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("retry recovered")).toBeTruthy();
    expect(screen.queryByTestId("lane-page-error-lane-0")).toBeNull();
    expect(newerAttempts).toBe(2);
  });

  it("paginates lanes independently while a peer lane is still loading", async () => {
    const offsetSeqs = (page: host.EventPageDto, offset: number) => ({
      ...page,
      events: page.events.map((event) => ({
        ...event,
        seq: event.seq + offset,
      })),
    });
    localStorage.setItem(
      "contextdesk.logExplorer.lanes.v1:c1",
      JSON.stringify([
        { id: "lane-0", label: "API", sources: ["api.log"] },
        { id: "lane-1", label: "Worker", sources: ["worker.log"] },
      ]),
    );
    const slowApi = deferred<host.EventPageDto>();
    vi.mocked(host.hostLogQueryEvents).mockImplementation(
      async (_corpusId, query) => {
        const source = query?.sources?.[0];
        if (query?.afterSeq != null && source === "api.log") {
          return slowApi.promise;
        }
        if (query?.afterSeq != null && source === "worker.log") {
          return {
            ...offsetSeqs(
              eventPage("worker.log", "wall", 1, 1_700_000_101, 2),
              100_000,
            ),
            nextCursor: null,
            nextTs: null,
          };
        }
        if (source === "api.log") {
          const page = eventPage("api.log", "wall", 1, 1_700_000_000, 2);
          page.nextCursor = page.events[0]!.seq;
          page.nextTs = page.events[0]!.ts;
          return page;
        }
        if (source === "worker.log") {
          const page = eventPage("worker.log", "wall", 1, 1_700_000_100, 2);
          page.nextCursor = page.events[0]!.seq;
          page.nextTs = page.events[0]!.ts;
          return page;
        }
        return defaultEventPage();
      },
    );

    render(<LogExplorer corpusId="c1" />);
    chooseLaneCount(2);
    await waitFor(() =>
      expect(screen.getAllByTestId("virtualized-event-list")).toHaveLength(2),
    );
    scrollLaneToEdge("newer", 0);
    await waitFor(() =>
      expect(screen.getByTestId("lane-paging-lane-0").textContent).toContain(
        "Loading newer",
      ),
    );

    scrollLaneToEdge("newer", 1);
    await waitFor(() =>
      expect(screen.getByTestId("lane-paging-lane-1").textContent).toContain(
        "All matched logs loaded",
      ),
    );
    expect(screen.getByTestId("lane-paging-lane-0").textContent).toContain(
      "Loading newer",
    );

    await act(async () => {
      slowApi.resolve({
        ...offsetSeqs(
          eventPage("api.log", "wall", 1, 1_700_000_001, 2),
          100_000,
        ),
        nextCursor: null,
        nextTs: null,
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByTestId("lane-paging-lane-0").textContent).toContain(
        "All matched logs loaded",
      ),
    );
  });

  it("invalidates a late paging response when filters start a new generation", async () => {
    const paging = deferred<host.EventPageDto>();
    const initial = defaultEventPage();
    initial.nextCursor = 2;
    initial.nextTs = initial.events[1]!.ts;
    vi.mocked(host.hostLogQueryEvents).mockImplementation(
      async (_corpusId, query) => {
        if (query?.afterSeq === 2) return paging.promise;
        if (query?.keyword === "fresh") {
          return eventPage("fresh.log", "wall");
        }
        return initial;
      },
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByText("auth failure");
    scrollLaneToEdge("newer");
    fireEvent.change(screen.getByTestId("log-explorer-filter"), {
      target: { value: "fresh" },
    });
    fireEvent.click(screen.getByTestId("log-explorer-filter-apply"));
    expect(await screen.findByText(/fresh\.log event 0/)).toBeTruthy();

    await act(async () => {
      paging.resolve(eventPage("stale-page.log", "wall"));
      await Promise.resolve();
    });
    expect(screen.queryByText(/stale-page\.log event 0/)).toBeNull();
    expect(screen.getByText(/fresh\.log event 0/)).toBeTruthy();
  });

  it("documents semantic availability without treating Find as semantic search", async () => {
    vi.mocked(host.hostGetLogCorpus).mockResolvedValue({
      id: "c1",
      name: "semantic fixture",
      eventCount: 10,
      templateCount: 2,
      engine: "duckdb",
      createdAt: 0,
      sourceLabel: null,
      stats: null,
      topTemplates: [],
      embedding: {
        state: "complete",
        modelId: "fixture-local",
        embeddedTemplates: 2,
        totalTemplates: 2,
        reason: "trusted_local_reanalysis",
        updatedAt: 1,
      },
    });
    render(<LogExplorer corpusId="c1" />);
    expect(
      await screen.findByText(/Template-semantic ranking is available/),
    ).toBeTruthy();
    fireEvent.change(screen.getByTestId("log-explorer-find"), {
      target: { value: "auth" },
    });
    await clickFindWhenReady();
    await waitFor(() =>
      expect(host.hostLogSearchEventsAdvanced).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ semantic: false }),
      ),
    );
  });

  it("composes explicit service, host, trace, template, UTC, and sequence scopes with Find", async () => {
    vi.mocked(host.hostLogFacets).mockResolvedValue({
      sources: { "api.log": 5, "worker.log": 5 },
      levels: { error: 3, info: 7 },
      services: { api: 5, worker: 5 },
      hosts: { h1: 3, h2: 7 },
      timeQuality: "wall",
    });
    render(<LogExplorer corpusId="c1" />);
    const filtersPanel = await screen.findByTestId("log-explorer-filters");
    const services = (await within(filtersPanel).findByText("Services"))
      .nextElementSibling as HTMLElement;
    const hosts = (await within(filtersPanel).findByText("Hosts"))
      .nextElementSibling as HTMLElement;
    fireEvent.click(within(services).getByRole("checkbox", { name: /^api\b/ }));
    fireEvent.click(within(hosts).getByRole("checkbox", { name: /^h1\b/ }));
    fireEvent.click(screen.getByTestId("log-explorer-advanced-toggle"));
    fireEvent.change(screen.getByLabelText("Trace ID filter"), {
      target: { value: "trace-7f3a" },
    });
    fireEvent.change(screen.getByLabelText("Template ID filter"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByLabelText("UTC start filter"), {
      target: { value: "2023-11-14T22:13:20Z" },
    });
    fireEvent.change(screen.getByLabelText("UTC end filter"), {
      target: { value: "2023-11-14T22:13:22Z" },
    });
    fireEvent.change(screen.getByLabelText("Sequence start filter"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByLabelText("Sequence end filter"), {
      target: { value: "9" },
    });
    fireEvent.click(screen.getByTestId("apply-structured-filters"));

    const expectedScope = expect.objectContaining({
      services: ["api"],
      hosts: ["h1"],
      traceId: "trace-7f3a",
      templateId: 1,
      timeFrom: 1_700_000_000,
      timeTo: 1_700_000_002,
      seqFrom: 1,
      seqTo: 9,
    });
    await waitFor(() =>
      expect(host.hostLogQueryEvents).toHaveBeenLastCalledWith(
        "c1",
        expectedScope,
      ),
    );
    expect(screen.getByRole("button", { name: "service:api ×" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "host:h1 ×" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "trace:trace-7f3a ×" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "template:1 ×" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "seq:1–9 ×" })).toBeTruthy();

    fireEvent.change(screen.getByTestId("log-explorer-find"), {
      target: { value: "auth" },
    });
    await clickFindWhenReady();
    await waitFor(() =>
      expect(host.hostLogSearchEventsAdvanced).toHaveBeenLastCalledWith(
        "c1",
        expect.objectContaining({ query: "auth", filter: expectedScope }),
      ),
    );
  });

  it("disables exact UTC scope honestly for order-only data while retaining sequence scope", async () => {
    vi.mocked(host.hostLogFacets).mockResolvedValue({
      sources: { "plain.log": 10 },
      levels: { info: 10 },
      services: {},
      hosts: {},
      timeQuality: "order_only",
    });
    render(<LogExplorer corpusId="c1" />);
    await waitFor(() =>
      expect(screen.queryByTestId("log-explorer-facets-loading")).toBeNull(),
    );
    fireEvent.click(await screen.findByTestId("log-explorer-advanced-toggle"));
    const utcStart = screen.getByLabelText(
      "UTC start filter",
    ) as HTMLInputElement;
    const utcEnd = screen.getByLabelText("UTC end filter") as HTMLInputElement;
    expect(utcStart.disabled).toBe(true);
    expect(utcEnd.disabled).toBe(true);
    expect(
      screen.getByText(/Use the stable sequence range instead/),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Sequence start filter"), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByLabelText("Sequence end filter"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByTestId("apply-structured-filters"));
    await waitFor(() =>
      expect(host.hostLogQueryEvents).toHaveBeenLastCalledWith(
        "c1",
        expect.objectContaining({ seqFrom: 3, seqTo: 5 }),
      ),
    );
  });

  it("rejects an inverted structured range without mutating the active query", async () => {
    render(<LogExplorer corpusId="c1" />);
    fireEvent.click(await screen.findByTestId("log-explorer-advanced-toggle"));
    await waitFor(() => expect(host.hostLogQueryEvents).toHaveBeenCalled());
    const callsBefore = vi.mocked(host.hostLogQueryEvents).mock.calls.length;
    fireEvent.change(screen.getByLabelText("Sequence start filter"), {
      target: { value: "20" },
    });
    fireEvent.change(screen.getByLabelText("Sequence end filter"), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByTestId("apply-structured-filters"));
    expect(screen.getByRole("status").textContent).toContain(
      "Sequence start must be less than or equal to end",
    );
    await Promise.resolve();
    expect(host.hostLogQueryEvents).toHaveBeenCalledTimes(callsBefore);
    expect(screen.queryByRole("button", { name: /seq:/ })).toBeNull();
  });

  it("navigates cursor-paged Find results without materializing every hit", async () => {
    const findEvent = (seq: number): host.ExplorerEventDto => ({
      seq,
      ts: 1_700_000_000 + seq,
      timeQuality: "wall",
      level: seq % 2 === 0 ? "error" : "info",
      service: "api",
      host: null,
      templateId: 1,
      traceId: null,
      message: `needle result ${seq}`,
      source: "api.log",
    });
    vi.mocked(host.hostLogSearchEventsAdvanced).mockImplementation(
      async (_corpusId, query) => {
        const after = query?.filter?.afterSeq;
        const events =
          after === 11
            ? [findEvent(12), findEvent(13)]
            : [findEvent(10), findEvent(11)];
        return {
          hits: events.map((event) => ({
            event,
            score: 1,
            matchKind: "keyword",
            templateId: event.templateId,
          })),
          nextCursor: after === 11 ? null : 11,
          nextTs: after === 11 ? null : findEvent(11).ts,
          totalMatched: 4,
          partial: after !== 11,
          scanned: events.length,
        };
      },
    );
    vi.mocked(host.hostLogQueryEventNeighborhood).mockImplementation(
      async (_corpusId, query) => {
        const target = findEvent(query.targetSeq);
        return {
          status: "found",
          target,
          targetIndex: 0,
          events: [target],
          totalMatched: 10,
          corpusTotal: 10,
          timeQuality: "wall",
          nextCursor: null,
          nextTs: null,
          prevCursor: null,
          prevTs: null,
        };
      },
    );

    render(<LogExplorer corpusId="c1" />);
    fireEvent.change(screen.getByTestId("log-explorer-find"), {
      target: { value: "needle" },
    });
    await clickFindWhenReady();
    expect(
      await screen.findByText(/Match 1 of 4.*2 result identities resident/),
    ).toBeTruthy();
    expect(host.hostLogSearchEventsAdvanced).toHaveBeenLastCalledWith(
      "c1",
      expect.objectContaining({
        k: 50,
        filter: expect.objectContaining({
          afterSeq: null,
          afterTs: null,
        }),
      }),
    );

    fireEvent.click(screen.getByTestId("log-explorer-find-next"));
    expect(
      await screen.findByText(/Match 2 of 4.*2 result identities resident/),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("log-explorer-find-next"));
    expect(
      await screen.findByText(/Match 3 of 4.*2 result identities resident/),
    ).toBeTruthy();
    expect(host.hostLogSearchEventsAdvanced).toHaveBeenLastCalledWith(
      "c1",
      expect.objectContaining({
        filter: expect.objectContaining({
          afterSeq: 11,
          afterTs: findEvent(11).ts,
        }),
      }),
    );

    fireEvent.click(screen.getByTestId("log-explorer-find-prev"));
    expect(
      await screen.findByText(/Match 2 of 4.*2 result identities resident/),
    ).toBeTruthy();
    expect(host.hostLogSearchEventsAdvanced).toHaveBeenLastCalledWith(
      "c1",
      expect.objectContaining({
        filter: expect.objectContaining({
          afterSeq: null,
          afterTs: null,
        }),
      }),
    );

    const errorFacet = screen.getByText("error").closest("label");
    expect(errorFacet).toBeTruthy();
    fireEvent.click(within(errorFacet!).getByRole("checkbox"));
    await waitFor(() =>
      expect(host.hostLogSearchEventsAdvanced).toHaveBeenLastCalledWith(
        "c1",
        expect.objectContaining({
          filter: expect.objectContaining({
            levels: ["error"],
            afterSeq: null,
            afterTs: null,
          }),
        }),
      ),
    );
  });

  it("routes Find context seeks into the visible composed lane for the hit source", async () => {
    const makeEvent = (
      seq: number,
      source: string,
      message: string,
    ): host.ExplorerEventDto => ({
      seq,
      ts: 1_700_000_000 + seq,
      timeQuality: "wall",
      level: "info",
      service: "fixture",
      host: null,
      templateId: 1,
      traceId: null,
      message,
      source,
    });
    const page = (
      events: host.ExplorerEventDto[],
      totalMatched: number,
    ): host.EventPageDto => ({
      events,
      nextCursor: null,
      nextTs: null,
      prevCursor: null,
      prevTs: null,
      totalMatched,
      timeQuality: "wall",
    });
    const laneZeroEvents = [
      makeEvent(1, "api.log", "api context"),
      makeEvent(2, "worker.log", "worker context"),
    ];
    const laneOneInitialEvents = [makeEvent(10, "db.log", "db context")];
    const queueHit = makeEvent(30, "queue.log", "needle queue hit");
    vi.mocked(host.hostLogFacets).mockResolvedValue({
      sources: {
        "api.log": 6,
        "worker.log": 7,
        "queue.log": 6,
        "db.log": 6,
      },
      levels: { info: 25 },
      services: {},
      hosts: {},
      timeQuality: "wall",
    });
    localStorage.setItem(
      "contextdesk.logExplorer.lanes.v1:c1",
      JSON.stringify([
        {
          id: "lane-0",
          label: "API + worker",
          sources: ["api.log", "worker.log"],
        },
        { id: "lane-1", label: "Queue + DB", sources: ["queue.log", "db.log"] },
      ]),
    );
    vi.mocked(host.hostLogQueryEvents).mockImplementation(
      async (_corpusId, query) => {
        const sources = query?.sources ?? [];
        if (sources.includes("api.log") && sources.includes("worker.log")) {
          return page(laneZeroEvents, 13);
        }
        if (sources.includes("queue.log") && sources.includes("db.log")) {
          return page(laneOneInitialEvents, 16);
        }
        return page([...laneZeroEvents, ...laneOneInitialEvents, queueHit], 35);
      },
    );
    vi.mocked(host.hostLogSearchEventsAdvanced).mockResolvedValue({
      hits: [
        {
          event: queueHit,
          score: 1,
          matchKind: "keyword",
          templateId: queueHit.templateId,
        },
      ],
      nextCursor: null,
      nextTs: null,
      totalMatched: 13,
      partial: false,
      scanned: 13,
    });
    vi.mocked(host.hostLogQueryEventNeighborhood).mockResolvedValue({
      status: "found",
      target: queueHit,
      targetIndex: 0,
      events: [queueHit],
      totalMatched: 16,
      corpusTotal: 35,
      timeQuality: "wall",
      nextCursor: null,
      nextTs: null,
      prevCursor: null,
      prevTs: null,
    });

    render(<LogExplorer corpusId="c1" />);
    chooseLaneCount(2);
    await waitFor(() => {
      expect(screen.getByTestId("lane-count-lane-0").textContent).toContain(
        "13 matched",
      );
      expect(screen.getByTestId("lane-count-lane-1").textContent).toContain(
        "16 matched",
      );
    });

    fireEvent.change(screen.getByTestId("log-explorer-find"), {
      target: { value: "needle" },
    });
    await clickFindWhenReady();

    await waitFor(() =>
      expect(host.hostLogQueryEventNeighborhood).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          targetSeq: queueHit.seq,
          filter: expect.objectContaining({
            sources: ["queue.log", "db.log"],
          }),
        }),
      ),
    );
    expect(screen.getByTestId("lane-count-lane-0").textContent).toContain(
      "13 matched",
    );
    expect(screen.getByTestId("lane-count-lane-1").textContent).toContain(
      "16 matched",
    );
    expect(screen.getByTestId("log-explorer-count-truth").textContent).toMatch(
      /resident rows 3/,
    );
  });

  it("routes Navigator seeks through visible composed lane membership", async () => {
    const makeEvent = (
      seq: number,
      source: string,
      message: string,
    ): host.ExplorerEventDto => ({
      seq,
      ts: 1_700_000_000 + seq,
      timeQuality: "wall",
      level: "info",
      service: "fixture",
      host: null,
      templateId: 1,
      traceId: null,
      message,
      source,
    });
    const page = (
      events: host.ExplorerEventDto[],
      totalMatched: number,
    ): host.EventPageDto => ({
      events,
      nextCursor: null,
      nextTs: null,
      prevCursor: null,
      prevTs: null,
      totalMatched,
      timeQuality: "wall",
    });
    const laneZeroEvents = [
      makeEvent(1, "api.log", "api context"),
      makeEvent(2, "worker.log", "worker context"),
    ];
    const laneOneInitialEvents = [makeEvent(10, "db.log", "db context")];
    const queueTarget = makeEvent(30, "queue.log", "timeline target");
    vi.mocked(host.hostLogFacets).mockResolvedValue({
      sources: {
        "api.log": 6,
        "worker.log": 7,
        "queue.log": 6,
        "db.log": 6,
        "edge.log": 6,
      },
      levels: { info: 31 },
      services: {},
      hosts: {},
      timeQuality: "wall",
    });
    localStorage.setItem(
      "contextdesk.logExplorer.lanes.v1:c1",
      JSON.stringify([
        {
          id: "lane-0",
          label: "API + worker",
          sources: ["api.log", "worker.log"],
        },
        { id: "lane-1", label: "Queue + DB", sources: ["queue.log", "db.log"] },
      ]),
    );
    vi.mocked(host.hostLogQueryEvents).mockImplementation(
      async (_corpusId, query) => {
        if (query?.timeFrom != null && query.limit === 1) {
          return page([queueTarget], 35);
        }
        const sources = query?.sources ?? [];
        if (sources.includes("api.log") && sources.includes("worker.log")) {
          return page(laneZeroEvents, 13);
        }
        if (sources.includes("queue.log") && sources.includes("db.log")) {
          return page(laneOneInitialEvents, 16);
        }
        return page(
          [...laneZeroEvents, ...laneOneInitialEvents, queueTarget],
          35,
        );
      },
    );
    vi.mocked(host.hostLogQueryEventNeighborhood).mockResolvedValue({
      status: "found",
      target: queueTarget,
      targetIndex: 0,
      events: [queueTarget],
      totalMatched: 16,
      corpusTotal: 35,
      timeQuality: "wall",
      nextCursor: null,
      nextTs: null,
      prevCursor: null,
      prevTs: null,
    });

    render(<LogExplorer corpusId="c1" />);
    chooseLaneCount(2);
    await waitFor(() => {
      expect(screen.getByTestId("lane-count-lane-0").textContent).toContain(
        "13 matched",
      );
      expect(screen.getByTestId("lane-count-lane-1").textContent).toContain(
        "16 matched",
      );
    });

    const timelinePosition = await screen.findByLabelText("Timeline position");
    fireEvent.pointerUp(timelinePosition, { target: { value: "0" } });

    expect(host.hostLogSharedTimelineSummary).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        sources: ["api.log", "worker.log", "queue.log", "db.log"],
      }),
      [
        { sources: ["api.log", "worker.log"] },
        { sources: ["queue.log", "db.log"] },
      ],
      96,
    );
    expect(host.hostLogQueryEvents).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        sources: ["api.log", "worker.log", "queue.log", "db.log"],
        limit: 1,
      }),
    );
    await waitFor(() =>
      expect(host.hostLogQueryEventNeighborhood).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          targetSeq: queueTarget.seq,
          filter: expect.objectContaining({
            sources: ["queue.log", "db.log"],
          }),
        }),
      ),
    );
    expect(screen.getByTestId("lane-count-lane-0").textContent).toContain(
      "13 matched",
    );
    expect(screen.getByTestId("lane-count-lane-1").textContent).toContain(
      "16 matched",
    );
    expect(screen.getByTestId("log-explorer-count-truth").textContent).toMatch(
      /resident rows 3/,
    );
  });

  it("does not allow a late Find response to replace a newer query", async () => {
    vi.mocked(host.createLogSearchRequestId)
      .mockReturnValueOnce("find-old")
      .mockReturnValueOnce("find-new");
    const oldSearch = deferred<host.EventSearchResultDto>();
    const resultEvent = (
      seq: number,
      message: string,
    ): host.ExplorerEventDto => ({
      ...defaultEventPage().events[0]!,
      seq,
      ts: 1_700_000_000 + seq,
      message,
    });
    vi.mocked(host.hostLogSearchEventsAdvanced).mockImplementation(
      async (_corpusId, query) => {
        if (query?.query === "old") return oldSearch.promise;
        const event = resultEvent(20, "new result");
        return {
          hits: [
            {
              event,
              score: 1,
              matchKind: "keyword",
              templateId: event.templateId,
            },
          ],
          nextCursor: null,
          nextTs: null,
          totalMatched: 1,
          partial: false,
          scanned: 1,
        };
      },
    );

    render(<LogExplorer corpusId="c1" />);
    const find = screen.getByTestId("log-explorer-find");
    fireEvent.change(find, { target: { value: "old" } });
    await clickFindWhenReady();
    await waitFor(() =>
      expect(host.hostLogSearchEventsAdvanced).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ query: "old" }),
      ),
    );

    fireEvent.change(find, { target: { value: "new" } });
    await clickFindWhenReady();
    await waitFor(() =>
      expect(host.hostCancelLogSearch).toHaveBeenCalledWith("find-old"),
    );
    expect(
      await screen.findByText(/Match 1 of 1.*1 result identities resident/),
    ).toBeTruthy();

    await act(async () => {
      const staleEvent = resultEvent(10, "old stale result");
      oldSearch.resolve({
        hits: [
          {
            event: staleEvent,
            score: 1,
            matchKind: "keyword",
            templateId: staleEvent.templateId,
          },
        ],
        nextCursor: null,
        nextTs: null,
        totalMatched: 99,
        partial: false,
        scanned: 99,
      });
      await Promise.resolve();
    });
    expect(
      screen.getByText(/Match 1 of 1.*1 result identities resident/),
    ).toBeTruthy();
    expect(screen.queryByText(/Match 1 of 99/)).toBeNull();
  });

  it("retires backend cancellation before locating a nonresident Find match", async () => {
    const target = nonresidentFindEvent(90, "needle located in context");
    const neighborhood =
      deferred<
        Awaited<ReturnType<typeof host.hostLogQueryEventNeighborhood>>
      >();
    vi.mocked(host.hostLogSearchEventsAdvanced).mockResolvedValue(
      findResultFor(target),
    );
    vi.mocked(host.hostLogQueryEventNeighborhood).mockReturnValue(
      neighborhood.promise,
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByText("auth failure");
    fireEvent.change(screen.getByTestId("log-explorer-find"), {
      target: { value: "needle" },
    });
    await clickFindWhenReady();

    await waitFor(() =>
      expect(host.hostLogQueryEventNeighborhood).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ targetSeq: target.seq }),
      ),
    );
    expect(screen.queryByTestId("log-explorer-find-cancel")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "result page ready · locating match",
    );
    expect(screen.getByTestId("log-explorer-find-prev")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByTestId("log-explorer-find-next")).toHaveProperty(
      "disabled",
      true,
    );
    expect(host.hostCancelLogSearch).not.toHaveBeenCalled();

    await act(async () => {
      neighborhood.resolve(foundNeighborhoodFor(target));
      await neighborhood.promise;
    });
    expect(
      await screen.findByText(/Match 1 of 1.*1 result identities resident/),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).not.toContain(
      "locating match",
    );
  });

  it("clears Find-owned state and ignores a late search response when the term changes", async () => {
    const pendingSearch = deferred<host.EventSearchResultDto>();
    const target = nonresidentFindEvent(91, "stale search target");
    vi.mocked(host.createLogSearchRequestId).mockReturnValue("find-term");
    vi.mocked(host.hostLogSearchEventsAdvanced).mockReturnValue(
      pendingSearch.promise,
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByText("auth failure");
    const find = screen.getByTestId("log-explorer-find");
    fireEvent.change(find, { target: { value: "needle" } });
    await clickFindWhenReady();
    await screen.findByTestId("log-explorer-find-cancel");

    fireEvent.change(find, { target: { value: "replacement" } });
    expect(screen.queryByTestId("log-explorer-find-cancel")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "Find term changed — press Find to apply",
    );
    expect(screen.getByRole("status").textContent).not.toMatch(
      /busy|searching|locating match/,
    );
    await waitFor(() =>
      expect(host.hostCancelLogSearch).toHaveBeenCalledWith("find-term"),
    );

    await act(async () => {
      pendingSearch.resolve(findResultFor(target));
      await pendingSearch.promise;
    });
    expect(host.hostLogQueryEventNeighborhood).not.toHaveBeenCalled();
    expect(screen.queryByText(target.message)).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "Find term changed — press Find to apply",
    );
  });

  it("ignores a late Find neighborhood after the match mode changes", async () => {
    const target = nonresidentFindEvent(92, "stale mode target");
    const neighborhood =
      deferred<
        Awaited<ReturnType<typeof host.hostLogQueryEventNeighborhood>>
      >();
    vi.mocked(host.hostLogSearchEventsAdvanced).mockResolvedValue(
      findResultFor(target),
    );
    vi.mocked(host.hostLogQueryEventNeighborhood).mockReturnValue(
      neighborhood.promise,
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByText("auth failure");
    fireEvent.change(screen.getByTestId("log-explorer-find"), {
      target: { value: "needle" },
    });
    await clickFindWhenReady();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "locating match",
      ),
    );

    fireEvent.click(screen.getByTestId("log-explorer-advanced-toggle"));
    fireEvent.click(screen.getByTestId("find-mode-regex"));
    expect(screen.getByRole("status").textContent).toContain(
      "Find mode changed — press Find to apply",
    );
    expect(screen.getByRole("status").textContent).not.toContain(
      "locating match",
    );

    await act(async () => {
      neighborhood.resolve(foundNeighborhoodFor(target));
      await neighborhood.promise;
    });
    expect(screen.queryByText(target.message)).toBeNull();
    expect(screen.queryByTestId("log-explorer-find-cancel")).toBeNull();
  });

  it("ignores a late Find neighborhood after a Filter refresh", async () => {
    const target = nonresidentFindEvent(93, "stale unfiltered location");
    const neighborhood =
      deferred<
        Awaited<ReturnType<typeof host.hostLogQueryEventNeighborhood>>
      >();
    let searchCount = 0;
    vi.mocked(host.hostLogSearchEventsAdvanced).mockImplementation(async () => {
      searchCount += 1;
      return searchCount === 1
        ? findResultFor(target)
        : {
            hits: [],
            nextCursor: null,
            nextTs: null,
            totalMatched: 0,
            partial: false,
            scanned: 0,
          };
    });
    vi.mocked(host.hostLogQueryEventNeighborhood).mockReturnValue(
      neighborhood.promise,
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByText("auth failure");
    fireEvent.change(screen.getByTestId("log-explorer-find"), {
      target: { value: "needle" },
    });
    await clickFindWhenReady();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "locating match",
      ),
    );

    const errorFacet = screen.getByText("error").closest("label");
    fireEvent.click(within(errorFacet!).getByRole("checkbox"));
    await waitFor(() =>
      expect(host.hostLogSearchEventsAdvanced).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "no matches for “needle”",
      ),
    );

    await act(async () => {
      neighborhood.resolve(foundNeighborhoodFor(target));
      await neighborhood.promise;
    });
    expect(screen.queryByText(target.message)).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "no matches for “needle”",
    );
  });

  it("cancels one active backend Find request when Explorer unmounts", async () => {
    const pendingSearch = deferred<host.EventSearchResultDto>();
    vi.mocked(host.createLogSearchRequestId).mockReturnValue("find-unmount");
    vi.mocked(host.hostLogSearchEventsAdvanced).mockReturnValue(
      pendingSearch.promise,
    );

    const view = render(<LogExplorer corpusId="c1" />);
    await screen.findByText("auth failure");
    fireEvent.change(screen.getByTestId("log-explorer-find"), {
      target: { value: "needle" },
    });
    await clickFindWhenReady();
    await screen.findByTestId("log-explorer-find-cancel");

    view.unmount();
    await waitFor(() =>
      expect(host.hostCancelLogSearch).toHaveBeenCalledWith("find-unmount"),
    );
    expect(host.hostCancelLogSearch).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingSearch.resolve({
        hits: [],
        nextCursor: null,
        nextTs: null,
        totalMatched: 0,
        partial: false,
        scanned: 0,
      });
      await pendingSearch.promise;
    });
    expect(host.hostCancelLogSearch).toHaveBeenCalledTimes(1);
  });

  it("uses the locating phase when cursor pagination reveals a nonresident match", async () => {
    const first = defaultEventPage().events[0]!;
    const second = nonresidentFindEvent(94, "second page target");
    const neighborhood =
      deferred<
        Awaited<ReturnType<typeof host.hostLogQueryEventNeighborhood>>
      >();
    let searchCount = 0;
    vi.mocked(host.hostLogSearchEventsAdvanced).mockImplementation(async () => {
      searchCount += 1;
      return searchCount === 1
        ? findResultFor(first, {
            nextCursor: first.seq,
            nextTs: first.ts,
            totalMatched: 2,
          })
        : findResultFor(second, { totalMatched: 2 });
    });
    vi.mocked(host.hostLogQueryEventNeighborhood).mockReturnValue(
      neighborhood.promise,
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByText("auth failure");
    fireEvent.change(screen.getByTestId("log-explorer-find"), {
      target: { value: "needle" },
    });
    await clickFindWhenReady();
    await screen.findByText(/Match 1 of 2.*1 result identities resident/);

    fireEvent.click(screen.getByTestId("log-explorer-find-next"));
    await waitFor(() =>
      expect(host.hostLogQueryEventNeighborhood).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ targetSeq: second.seq }),
      ),
    );
    expect(screen.queryByTestId("log-explorer-find-cancel")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "result page ready · locating match",
    );

    await act(async () => {
      neighborhood.resolve(foundNeighborhoodFor(second));
      await neighborhood.promise;
    });
    expect(
      await screen.findByText(/Match 2 of 2.*1 result identities resident/),
    ).toBeTruthy();
  });

  it("cancels an in-flight Find without replacing the previous visible results", async () => {
    vi.mocked(host.createLogSearchRequestId)
      .mockReturnValueOnce("find-kept")
      .mockReturnValueOnce("find-cancelled");
    const cancelledSearch = deferred<host.EventSearchResultDto>();
    let searchCalls = 0;
    const keptEvent: host.ExplorerEventDto = {
      ...defaultEventPage().events[0]!,
      seq: 20,
      message: "trusted visible result",
    };
    const partialEvent: host.ExplorerEventDto = {
      ...keptEvent,
      seq: 21,
      message: "untrusted partial cancelled result",
    };
    vi.mocked(host.hostLogSearchEventsAdvanced).mockImplementation(async () => {
      searchCalls += 1;
      if (searchCalls === 2) return cancelledSearch.promise;
      return {
        hits: [
          {
            event: keptEvent,
            score: 1,
            matchKind: "keyword",
            templateId: keptEvent.templateId,
          },
        ],
        nextCursor: null,
        nextTs: null,
        totalMatched: 1,
        partial: false,
        scanned: 1,
      };
    });

    render(<LogExplorer corpusId="c1" />);
    const find = screen.getByTestId("log-explorer-find");
    fireEvent.change(find, { target: { value: "cancel me" } });
    await clickFindWhenReady();
    expect(
      await screen.findByText(/Match 1 of 1.*1 result identities resident/),
    ).toBeTruthy();

    await clickFindWhenReady();
    const cancel = await screen.findByTestId("log-explorer-find-cancel");
    expect(cancel.textContent).toBe("Cancel");
    expect(host.hostLogSearchEventsAdvanced).toHaveBeenLastCalledWith(
      "c1",
      expect.objectContaining({ requestId: "find-cancelled" }),
    );

    fireEvent.click(cancel);
    await waitFor(() =>
      expect(host.hostCancelLogSearch).toHaveBeenCalledWith("find-cancelled"),
    );
    expect(
      await screen.findByText(
        "Find cancellation requested · previous visible results preserved",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("log-explorer-find-cancel")).toBeNull();

    await act(async () => {
      cancelledSearch.resolve({
        hits: [
          {
            event: partialEvent,
            score: 1,
            matchKind: "regex",
            templateId: partialEvent.templateId,
          },
        ],
        nextCursor: null,
        nextTs: null,
        totalMatched: 99,
        partial: false,
        cancelled: false,
        scanned: 12,
      });
      await Promise.resolve();
    });

    expect(
      screen.getByText(
        "Find cancellation requested · previous visible results preserved",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Match 1 of 1.*1 result identities resident/),
    ).toBeTruthy();
    expect(screen.queryByText("untrusted partial cancelled result")).toBeNull();
    expect(screen.queryByTestId("log-explorer-find-cancel")).toBeNull();
  });

  it("allows cancellation to be retried when the backend request is not registered yet", async () => {
    const pendingSearch = deferred<host.EventSearchResultDto>();
    vi.mocked(host.createLogSearchRequestId).mockReturnValue("find-race");
    vi.mocked(host.hostCancelLogSearch)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    vi.mocked(host.hostLogSearchEventsAdvanced).mockReturnValue(
      pendingSearch.promise,
    );

    render(<LogExplorer corpusId="c1" />);
    fireEvent.change(screen.getByTestId("log-explorer-find"), {
      target: { value: "slow regex" },
    });
    await clickFindWhenReady();

    fireEvent.click(await screen.findByTestId("log-explorer-find-cancel"));
    expect(
      await screen.findByText("Find is still running · try Cancel again"),
    ).toBeTruthy();
    const retry = screen.getByTestId("log-explorer-find-cancel");
    expect(retry.textContent).toBe("Cancel");
    expect(retry).toHaveProperty("disabled", false);

    fireEvent.click(retry);
    await waitFor(() =>
      expect(host.hostCancelLogSearch).toHaveBeenNthCalledWith(2, "find-race"),
    );
    expect(screen.queryByTestId("log-explorer-find-cancel")).toBeNull();
    expect(
      await screen.findByText(
        "Find cancellation requested · previous visible results preserved",
      ),
    ).toBeTruthy();

    await act(async () => {
      pendingSearch.resolve({
        hits: [],
        nextCursor: null,
        nextTs: null,
        totalMatched: null,
        partial: true,
        diagnostic: "cancelled",
        cancelled: true,
        scanned: 0,
      });
      await Promise.resolve();
    });
    expect(
      screen.getByText(
        "Find cancellation requested · previous visible results preserved",
      ),
    ).toBeTruthy();
  });

  it("reruns active Find inside a keyword Filter and ignores the stale unfiltered response", async () => {
    const unfilteredSearch = deferred<host.EventSearchResultDto>();
    const filteredEvent: host.ExplorerEventDto = {
      ...defaultEventPage().events[0]!,
      message: "needle event_id=behavior-0",
    };
    vi.mocked(host.hostLogSearchEventsAdvanced).mockImplementation(
      async (_corpusId, query) => {
        if (query?.filter?.keyword === "event_id=behavior-0") {
          return {
            hits: [
              {
                event: filteredEvent,
                score: 1,
                matchKind: "keyword",
                templateId: filteredEvent.templateId,
              },
            ],
            nextCursor: null,
            nextTs: null,
            totalMatched: 1,
            partial: false,
            scanned: 1,
          };
        }
        return unfilteredSearch.promise;
      },
    );

    render(<LogExplorer corpusId="c1" />);
    fireEvent.change(screen.getByTestId("log-explorer-find"), {
      target: { value: "needle" },
    });
    await clickFindWhenReady();
    await waitFor(() =>
      expect(host.hostLogSearchEventsAdvanced).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          query: "needle",
          filter: expect.objectContaining({ keyword: null }),
        }),
      ),
    );

    fireEvent.change(screen.getByTestId("log-explorer-filter"), {
      target: { value: "event_id=behavior-0" },
    });
    fireEvent.click(screen.getByTestId("log-explorer-filter-apply"));

    expect(
      await screen.findByText(/Match 1 of 1.*1 result identities resident/),
    ).toBeTruthy();
    expect(host.hostLogSearchEventsAdvanced).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        query: "needle",
        filter: expect.objectContaining({ keyword: "event_id=behavior-0" }),
      }),
    );

    await act(async () => {
      const staleEvent = {
        ...filteredEvent,
        seq: 99,
        message: "needle from the stale unfiltered response",
      };
      unfilteredSearch.resolve({
        hits: [
          {
            event: staleEvent,
            score: 1,
            matchKind: "keyword",
            templateId: staleEvent.templateId,
          },
        ],
        nextCursor: null,
        nextTs: null,
        totalMatched: 4,
        partial: false,
        scanned: 4,
      });
      await Promise.resolve();
    });
    expect(
      screen.getByText(/Match 1 of 1.*1 result identities resident/),
    ).toBeTruthy();
    expect(screen.queryByText(/Match 1 of 4/)).toBeNull();
  });

  it("creates, sends, persists, and reopens a linked chat", async () => {
    let stored: host.ChatSessionDto | null = null;
    const privateMetricMarker = "PRIVATE_METRIC_NOT_CHAT_CONTEXT";
    const metricDocument = JSON.stringify({
      schemaVersion: 1,
      id: privateMetricMarker,
      name: privateMetricMarker,
      series: [
        {
          id: "cpu",
          name: privateMetricMarker,
          unit: "%",
          timeQuality: "wall",
          provenance: { source: "test-only-monitor" },
          points: [
            { timestamp: 1_700_000_000, value: 10 },
            { timestamp: 1_700_000_004, value: 20 },
          ],
        },
      ],
    });
    vi.mocked(
      host.hostLoadLogOperationalMetricsAttachment,
    ).mockResolvedValueOnce({
      metadata: {
        schemaVersion: 1,
        attachmentId: "019fb100-0000-7000-8000-000000000002",
        corpusId: "c1",
        contentSha256: "b".repeat(64),
        contentBytes: metricDocument.length,
        metricSchemaVersion: 1,
        displayName: "private-metrics.json",
        validatedAtUnixSecs: 1_700_000_100,
        source: { kind: "manual_load" },
        timeQualityDeclarations: ["wall"],
      },
      documentText: metricDocument,
    });
    vi.mocked(host.hostLogLoadSuppression).mockResolvedValue(
      suppressionDocument(),
    );
    vi.mocked(host.hostLogCountEvents).mockImplementation(
      async (_corpusId, query) => ({
        totalMatched: query?.templateIds?.includes(2) ? 1 : 1,
      }),
    );
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (session) => {
      stored = session;
      return session;
    });
    vi.mocked(host.hostLoadChatSession).mockImplementation(async () => stored);
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(
      async () =>
        stored
          ? [
              {
                id: stored.id,
                title: stored.title,
                archived: false,
                pinned: false,
                created_at: stored.created_at,
                updated_at: stored.updated_at,
                message_count: stored.messages.length,
                preview: stored.messages.at(-1)?.content ?? "",
                linked_corpus_id: stored.linked_corpus_id,
              },
            ]
          : [],
    );
    vi.mocked(host.agentTurn).mockImplementation(
      async (_sessionId, _text, _forceLocal, _model, _provider, onEvent) => {
        const events: host.EventDto[] = [
          { kind: "turn_started", payload: { model: "fixture-model" } },
          { kind: "text_delta", payload: { text: "The API failed first." } },
          { kind: "turn_completed", payload: {} },
        ];
        for (const event of events) onEvent?.(event);
        return events;
      },
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByText(/auth failure/);
    await screen.findByTestId("timeline-session-metrics");

    fireEvent.click(screen.getByTestId("new-linked-chat"));
    await waitFor(() => {
      expect(stored?.linked_corpus_id).toBe("c1");
      expect(stored?.messages).toHaveLength(0);
    });

    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "What failed?" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));

    const thread = screen.getByTestId("log-explorer-chat-thread");
    await within(thread).findByText("The API failed first.");
    await waitFor(() => {
      expect(host.agentTurn).toHaveBeenCalledWith(
        stored?.id,
        "What failed?",
        false,
        "triage-1",
        "tools-provider",
        expect.any(Function),
        null,
        expect.objectContaining({
          corpus_id: "c1",
          brief: expect.stringMatching(
            /corpusId=c1;.*noisePolicy=active; noisePolicyRevision=3; noiseRuleCount=1; noiseHiddenCount=1; noiseExcludedEventsNotAnalyzed=true/,
          ),
        }),
        false,
        expect.objectContaining({
          userMessageId: expect.any(String),
          assistantMessageId: expect.any(String),
        }),
      );
      expect(stored?.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(stored?.messages[0]?.content).toBe("What failed?");
      expect(stored?.messages[1]?.content).toBe("The API failed first.");
      expect(stored?.chat_model).toBe("triage-1");
      expect(stored?.provider_profile_id).toBe("tools-provider");
    });
    const turnContext = vi.mocked(host.agentTurn).mock.calls.at(-1)?.[7];
    expect(JSON.stringify(turnContext)).not.toContain(privateMetricMarker);

    fireEvent.click(screen.getByTestId("linked-chat-switcher-toggle"));
    fireEvent.click(
      within(screen.getByTestId("linked-chat-switcher")).getByText(
        stored!.title,
      ),
    );
    expect(await within(thread).findByText("What failed?")).toBeTruthy();
    expect(
      await within(thread).findByText("The API failed first."),
    ).toBeTruthy();
  });

  it("investigates the Log Lab mystery without exposing evaluator truth", async () => {
    const decisiveClues = checkoutTruth.investigation.decisive_clues;
    const fixtureSources = Object.fromEntries(
      Object.entries(checkoutTruth.expected.files_by_path).map(
        ([source, expected]) => [source, expected.events],
      ),
    );
    const fixtureEvents: host.ExplorerEventDto[] = decisiveClues.map(
      (clue, index) => ({
        seq: index + 100,
        ts: checkoutTruth.investigation.affected_interval.from + index * 20,
        timeQuality: "wall",
        level: clue.event_id === "edge-504" ? "error" : "info",
        service: clue.source.split("/")[0] ?? "fixture",
        host: null,
        templateId: index + 1,
        traceId:
          clue.event_id === "worker-loop" || clue.event_id === "edge-504"
            ? "trace-checkout-42"
            : null,
        message: `event_id=${clue.event_id} ${clue.query}`,
        source: clue.source,
      }),
    );
    vi.mocked(host.hostLogFacets).mockResolvedValue({
      sources: fixtureSources,
      levels: { info: fixtureEvents.length - 1, error: 1 },
      services: {},
      hosts: {},
      timeQuality: "wall",
    });
    vi.mocked(host.hostLogQueryEvents).mockImplementation(
      async (_corpusId, query) => {
        const sources = query?.sources ?? [];
        const events =
          sources.length === 0
            ? fixtureEvents
            : fixtureEvents.filter((event) => sources.includes(event.source));
        return {
          events,
          nextCursor: null,
          nextTs: null,
          totalMatched: events.length,
          timeQuality: "wall",
        };
      },
    );
    vi.mocked(host.hostLogSearchEventsAdvanced).mockImplementation(
      async (_corpusId, search) => {
        const hits = fixtureEvents
          .filter((event) =>
            event.message.includes(search?.query ?? "job-7f3a"),
          )
          .map((event) => ({
            event,
            score: 1,
            matchKind: "keyword",
            templateId: event.templateId,
          }));
        return { hits, partial: false, scanned: hits.length };
      },
    );

    let stored: host.ChatSessionDto | null = null;
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (session) => {
      stored = session;
      return session;
    });
    vi.mocked(host.hostLoadChatSession).mockImplementation(async () => stored);
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(
      async () =>
        stored
          ? [
              {
                id: stored.id,
                title: stored.title,
                archived: false,
                pinned: false,
                created_at: stored.created_at,
                updated_at: stored.updated_at,
                message_count: stored.messages.length,
                preview: stored.messages.at(-1)?.content ?? "",
                linked_corpus_id: stored.linked_corpus_id,
              },
            ]
          : [],
    );
    vi.mocked(host.hostLogAddBookmark).mockImplementation(
      async (_corpusId, args) => ({
        id: "log-lab-bookmark",
        label: args.label,
        note: null,
        seqFrom: args.seqFrom,
        seqTo: args.seqTo,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    vi.mocked(host.agentTurn).mockImplementation(
      async (_sessionId, _text, _forceLocal, _model, _provider, onEvent) => {
        const events: host.EventDto[] = [
          {
            kind: "text_delta",
            payload: {
              text: "The retry loop and pool shrink caused the outage.",
            },
          },
          { kind: "turn_completed", payload: {} },
        ];
        for (const event of events) onEvent?.(event);
        return events;
      },
    );

    render(<LogExplorer corpusId="log-lab-checkout-cascade" />);
    const root = await screen.findByTestId("log-explorer");
    await waitFor(() =>
      expect(root.getAttribute("data-time-quality")).toBe("wall"),
    );
    expect(
      (await screen.findAllByLabelText(/^Source audit\/deploy\.jsonl;/)).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByLabelText(/^Source worker\/worker\.log;/).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("/Users/")).toBeNull();

    fireEvent.change(screen.getByLabelText("Find in logs"), {
      target: { value: "job-7f3a" },
    });
    await clickFindWhenReady();
    await waitFor(() =>
      expect(host.hostLogSearchEventsAdvanced).toHaveBeenCalledWith(
        "log-lab-checkout-cascade",
        expect.objectContaining({ query: "job-7f3a" }),
      ),
    );
    // Find preserves context — does not replace the table with only hits.
    expect(await screen.findByText(/event_id=worker-loop/)).toBeTruthy();

    fireEvent.click(screen.getByText(/event_id=worker-loop/));
    fireEvent.click(screen.getByRole("button", { name: "Bookmark (B)" }));
    await waitFor(() =>
      expect(host.hostLogAddBookmark).toHaveBeenCalledWith(
        "log-lab-checkout-cascade",
        expect.objectContaining({
          seqFrom: 101,
          seqTo: 101,
          label: "seq 101",
        }),
      ),
    );
    expect(
      await screen.findByTestId("bookmark-activate-log-lab-bookmark"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Bookmark (B)" }));
    fireEvent.keyDown(root, { key: "b" });
    await screen.findByText("Already bookmarked: seq 101");
    expect(host.hostLogAddBookmark).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("new-linked-chat"));
    await waitFor(() =>
      expect(stored?.linked_corpus_id).toBe("log-lab-checkout-cascade"),
    );
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: checkoutTruth.investigation.canonical_questions[0] },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));
    expect(
      await screen.findByText(
        "The retry loop and pool shrink caused the outage.",
      ),
    ).toBeTruthy();

    const context = vi.mocked(host.agentTurn).mock.calls.at(-1)?.[7];
    expect(context).toEqual(
      expect.objectContaining({
        corpus_id: "log-lab-checkout-cascade",
        brief: expect.stringContaining("selectedSeqs=[101]"),
      }),
    );
    const serializedContext = JSON.stringify(context);
    expect(serializedContext).not.toContain(
      checkoutTruth.investigation.root_cause,
    );
    expect(serializedContext).not.toContain('"decisive_clues"');
    expect(serializedContext).not.toContain('"rubric"');
  });

  it("keeps two Explorer chat snapshots isolated when one window unmounts", async () => {
    const stored = new Map<string, host.ChatSessionDto>();
    const pendingTurns: Array<{
      promise: Promise<host.EventDto[]>;
      resolve: (value: host.EventDto[]) => void;
    }> = [];
    vi.mocked(host.agentTurn).mockImplementation(async () => {
      const pending = deferred<host.EventDto[]>();
      pendingTurns.push(pending);
      return pending.promise;
    });
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (session) => {
      stored.set(session.id, session);
      return session;
    });
    vi.mocked(host.hostLoadChatSession).mockImplementation(
      async (id) => stored.get(id) ?? null,
    );
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(
      async (corpusId) =>
        [...stored.values()]
          .filter((session) => session.linked_corpus_id === corpusId)
          .map((session) => ({
            id: session.id,
            title: session.title,
            archived: false,
            pinned: false,
            created_at: session.created_at,
            updated_at: session.updated_at,
            message_count: session.messages.length,
            preview: session.messages.at(-1)?.content ?? "",
            linked_corpus_id: session.linked_corpus_id,
          })),
    );

    const explorerA = render(<LogExplorer corpusId="corpus-a" />);
    const explorerB = render(<LogExplorer corpusId="corpus-b" />);
    await within(explorerA.container).findByText(/auth failure/);
    await within(explorerB.container).findByText(/auth failure/);

    fireEvent.click(within(explorerA.container).getByTestId("new-linked-chat"));
    await waitFor(() =>
      expect(
        [...stored.values()].some(
          (session) => session.linked_corpus_id === "corpus-a",
        ),
      ).toBe(true),
    );
    fireEvent.change(
      within(explorerA.container).getByLabelText("Chat message"),
      { target: { value: "Question A" } },
    );
    fireEvent.click(
      within(explorerA.container).getByTestId("send-linked-chat"),
    );
    await waitFor(() =>
      expect(host.agentTurn).toHaveBeenCalledWith(
        expect.any(String),
        "Question A",
        false,
        "triage-1",
        "tools-provider",
        expect.any(Function),
        null,
        expect.objectContaining({
          corpus_id: "corpus-a",
          brief: expect.stringContaining("corpusId=corpus-a"),
        }),
        false,
        expect.objectContaining({
          userMessageId: expect.any(String),
          assistantMessageId: expect.any(String),
        }),
      ),
    );

    explorerA.unmount();

    fireEvent.click(within(explorerB.container).getByTestId("new-linked-chat"));
    await waitFor(() =>
      expect(
        [...stored.values()].some(
          (session) => session.linked_corpus_id === "corpus-b",
        ),
      ).toBe(true),
    );
    fireEvent.change(
      within(explorerB.container).getByLabelText("Chat message"),
      { target: { value: "Question B" } },
    );
    fireEvent.click(
      within(explorerB.container).getByTestId("send-linked-chat"),
    );
    await waitFor(() =>
      expect(host.agentTurn).toHaveBeenCalledWith(
        expect.any(String),
        "Question B",
        false,
        "triage-1",
        "tools-provider",
        expect.any(Function),
        null,
        expect.objectContaining({
          corpus_id: "corpus-b",
          brief: expect.stringContaining("corpusId=corpus-b"),
        }),
        false,
        expect.objectContaining({
          userMessageId: expect.any(String),
          assistantMessageId: expect.any(String),
        }),
      ),
    );

    const contexts = vi
      .mocked(host.agentTurn)
      .mock.calls.map((call) => call[7])
      .filter((context) => context != null);
    expect(contexts).toEqual([
      expect.objectContaining({ corpus_id: "corpus-a" }),
      expect.objectContaining({ corpus_id: "corpus-b" }),
    ]);

    await act(async () => {
      for (const pending of pendingTurns) pending.resolve([]);
      await Promise.all(pendingTurns.map((pending) => pending.promise));
    });
    await waitFor(() => {
      expect(
        [...stored.values()].find(
          (session) => session.linked_corpus_id === "corpus-a",
        )?.messages[0]?.content,
      ).toBe("Question A");
      expect(
        [...stored.values()].find(
          (session) => session.linked_corpus_id === "corpus-b",
        )?.messages[0]?.content,
      ).toBe("Question B");
    });

    explorerB.unmount();
    const reloadedA = render(<LogExplorer corpusId="corpus-a" />);
    await within(reloadedA.container).findByText(/auth failure/);
    const sessionA = [...stored.values()].find(
      (session) => session.linked_corpus_id === "corpus-a",
    )!;
    fireEvent.click(
      within(reloadedA.container).getByTestId("linked-chat-switcher-toggle"),
    );
    fireEvent.click(within(reloadedA.container).getByText(sessionA.title));
    expect(
      await within(
        within(reloadedA.container).getByTestId("log-explorer-chat-thread"),
      ).findByText("Question A"),
    ).toBeTruthy();
  });

  it("shows tool progress from a real agent turn stream in the linked rail", async () => {
    let stored: host.ChatSessionDto | null = null;
    vi.mocked(host.hostSaveChatSession).mockImplementation(async (session) => {
      stored = session;
      return session;
    });
    vi.mocked(host.hostLoadChatSession).mockImplementation(async () => stored);
    vi.mocked(host.hostListChatSessionsForCorpus).mockImplementation(
      async () =>
        stored
          ? [
              {
                id: stored.id,
                title: stored.title,
                archived: false,
                pinned: false,
                created_at: stored.created_at,
                updated_at: stored.updated_at,
                message_count: stored.messages.length,
                preview: stored.messages.at(-1)?.content ?? "",
                linked_corpus_id: stored.linked_corpus_id,
              },
            ]
          : [],
    );
    vi.mocked(host.agentTurn).mockImplementation(
      async (_sessionId, _text, _forceLocal, _model, _provider, onEvent) => {
        const events: host.EventDto[] = [
          { kind: "turn_started", payload: { model: "fixture-model" } },
          {
            kind: "tool",
            payload: {
              id: "t1",
              name: "search_logs",
              summary: "3 hits for job-7f3a",
              ok: true,
            },
          },
          {
            kind: "text_delta",
            payload: {
              text: "job-7f3a exhausted the pool after db_pool_max shrank.",
            },
          },
          { kind: "turn_completed", payload: {} },
        ];
        for (const event of events) onEvent?.(event);
        return events;
      },
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByText(/auth failure/);
    fireEvent.click(screen.getByTestId("new-linked-chat"));
    await waitFor(() => expect(stored?.linked_corpus_id).toBe("c1"));
    fireEvent.change(screen.getByLabelText("Chat message"), {
      target: { value: "What caused the incident?" },
    });
    fireEvent.click(screen.getByTestId("send-linked-chat"));
    const thread = screen.getByTestId("log-explorer-chat-thread");
    expect(await within(thread).findByText(/search_logs/)).toBeTruthy();
    expect(
      await within(thread).findByText(/job-7f3a exhausted the pool/),
    ).toBeTruthy();
    await waitFor(() => {
      expect(stored?.messages.some((m) => m.role === "assistant")).toBe(true);
    });
  });
});
