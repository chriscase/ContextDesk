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
  hostGetLogCorpus: vi.fn(async () => ({
    id: "c1",
    name: "fixture",
    eventCount: 10,
    templateCount: 2,
    engine: "duckdb",
    createdAt: 0,
  })),
  hostSetActiveLogCorpus: vi.fn(async () => "c1"),
  hostLogListBookmarks: vi.fn(async () => []),
  hostListChatSessionsForCorpus: vi.fn(async () => []),
  hostLoadChatSession: vi.fn(async () => null),
  hostLogFacets: vi.fn(async () => ({
    sources: { "api.log": 5, "worker.log": 5 },
    levels: { error: 3, info: 7 },
    services: { api: 5 },
    hosts: {},
    timeQuality: "wall",
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
  hostLogSearchEvents: vi.fn(async () => []),
  hostLogSearchEventsAdvanced: vi.fn(async () => ({ hits: [], partial: false, scanned: 0 })),
  hostLogAddBookmark: vi.fn(),
  hostLogDeleteBookmark: vi.fn(),
  hostSaveChatSession: vi.fn(),
  hostSetChatLinkedCorpus: vi.fn(),
  agentTurn: vi.fn(async () => []),
}));

function eventPage(
  source: string,
  timeQuality: host.TimeQuality,
  eventCount = 1,
  ts = 1_700_000_000,
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
    totalMatched: eventCount,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("LogExplorer shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.mocked(host.hostLogQueryEvents).mockResolvedValue(defaultEventPage());
    vi.mocked(host.hostLogSearchEvents).mockResolvedValue([]);
    vi.mocked(host.hostLogSearchEventsAdvanced).mockResolvedValue({ hits: [], partial: false, scanned: 0 });
    vi.mocked(host.hostListChatSessionsForCorpus).mockResolvedValue([]);
    vi.mocked(host.hostLoadChatSession).mockResolvedValue(null);
    vi.mocked(host.hostSaveChatSession).mockResolvedValue(null);
    vi.mocked(host.agentTurn).mockResolvedValue([]);
  });

  it("renders filters, lanes, chat column, splitters, virtualized rows", async () => {
    render(<LogExplorer corpusId="c1" />);
    const root = await screen.findByTestId("log-explorer");
    expect(root).toBeTruthy();
    expect(root.getAttribute("data-resizable")).toBe("true");
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
      fireEvent.click(
        screen.getByTitle(`${lanes} evidence lane${lanes === 1 ? "" : "s"}`),
      );

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
    fireEvent.click(screen.getByTitle("3 evidence lanes"));
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

    fireEvent.click(screen.getByTestId("time-link-follow_cursor"));
    // Order-only aggregate refuses wall-clock link.
    expect(root.getAttribute("data-link-mode")).toBe("independent");
    expect(screen.queryByTestId("log-explorer-gap")).toBeNull();
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
    fireEvent.click(screen.getByTitle("2 evidence lanes"));
    // New behavior: both lanes start as All sources — not auto-split by first-N.
    fireEvent.click(screen.getByTestId("lane-editor-toggle"));
    const editor = await screen.findByTestId("lane-editor");
    expect(editor.textContent).toMatch(/All sources/);
    // Compose lane-0 → api only, lane-1 → worker only.
    const checks = within(editor).getAllByRole("checkbox");
    // First source checkbox for lane-0
    fireEvent.click(checks[0]!);
    // Second lane's worker checkbox (after lane-0's sources)
    fireEvent.click(checks[checks.length - 1]!);
    const root = screen.getByTestId("log-explorer");
    await waitFor(() =>
      expect(root.getAttribute("data-time-quality")).toBe("mixed"),
    );

    fireEvent.click(screen.getByTestId("time-link-follow_cursor"));
    await waitFor(() =>
      expect(root.getAttribute("data-link-mode")).toBe("follow_cursor"),
    );
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
    fireEvent.click(screen.getByTestId("log-explorer-find-run"));
    await waitFor(() =>
      expect(host.hostLogSearchEventsAdvanced).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ semantic: false }),
      ),
    );
  });

  it("creates, sends, persists, and reopens a linked chat", async () => {
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
          { kind: "text_delta", payload: { text: "The API failed first." } },
          { kind: "turn_completed", payload: {} },
        ];
        for (const event of events) onEvent?.(event);
        return events;
      },
    );

    render(<LogExplorer corpusId="c1" />);
    await screen.findByText(/auth failure/);

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
        null,
        null,
        expect.any(Function),
        null,
        expect.objectContaining({
          corpus_id: "c1",
          brief: expect.stringContaining("corpusId=c1"),
        }),
      );
      expect(stored?.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(stored?.messages[0]?.content).toBe("What failed?");
      expect(stored?.messages[1]?.content).toBe("The API failed first.");
    });

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
    expect(root.getAttribute("data-time-quality")).toBe("wall");
    expect(
      (await screen.findAllByText("audit/deploy.jsonl")).length,
    ).toBeGreaterThan(1);
    expect(screen.getAllByText("worker/worker.log").length).toBeGreaterThan(1);
    expect(screen.queryByText("/Users/")).toBeNull();

    fireEvent.change(screen.getByLabelText("Find in logs"), {
      target: { value: "job-7f3a" },
    });
    fireEvent.click(screen.getByTestId("log-explorer-find-run"));
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
        null,
        null,
        expect.any(Function),
        null,
        expect.objectContaining({
          corpus_id: "corpus-a",
          brief: expect.stringContaining("corpusId=corpus-a"),
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
        null,
        null,
        expect.any(Function),
        null,
        expect.objectContaining({
          corpus_id: "corpus-b",
          brief: expect.stringContaining("corpusId=corpus-b"),
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
