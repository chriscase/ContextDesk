import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
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
  hostSetLogViewContext: vi.fn(async () => {}),
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
    vi.mocked(host.hostLogFacets).mockResolvedValue({
      sources: { "api.log": 5, "worker.log": 5 },
      levels: { error: 3, info: 7 },
      services: { api: 5 },
      hosts: {},
      timeQuality: "wall",
    });
    vi.mocked(host.hostLogQueryEvents).mockResolvedValue(defaultEventPage());
    vi.mocked(host.hostLogSearchEvents).mockResolvedValue([]);
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
    expect(screen.getByTestId("log-explorer-view-context")).toBeTruthy();
    // Events load via virtualized list
    expect(await screen.findByText(/auth failure/)).toBeTruthy();
    const vlist = screen.getAllByTestId("virtualized-event-list")[0]!;
    expect(vlist.getAttribute("data-virtualized")).toBe("true");
    expect(within(vlist).getByText("api.log")).toBeTruthy();
    expect(within(vlist).getByText("worker.log")).toBeTruthy();
    expect(root.getAttribute("data-lane-count")).toBe("1");
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

    fireEvent.click(screen.getByRole("button", { name: "Link OFF" }));
    expect(root.getAttribute("data-link-mode")).toBe("off");
    expect(screen.queryByTestId("log-explorer-gap")).toBeNull();
  });

  it("labels mixed-time gaps as potential while allowing linked navigation", async () => {
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
    const root = screen.getByTestId("log-explorer");
    await waitFor(() =>
      expect(root.getAttribute("data-time-quality")).toBe("mixed"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Link OFF" }));
    await waitFor(() => expect(root.getAttribute("data-link-mode")).toBe("on"));
    expect(await screen.findByText(/potential gap region/)).toBeTruthy();
  });

  it("does not let late facet or page responses strengthen conservative time quality", async () => {
    const pendingFacets = deferred<host.LogFacetsDto>();
    const pendingPage = deferred<host.EventPageDto>();
    vi.mocked(host.hostLogFacets).mockReturnValue(pendingFacets.promise);
    vi.mocked(host.hostLogQueryEvents).mockReturnValue(pendingPage.promise);
    const orderOnlyPage = eventPage("search.log", "order_only");
    vi.mocked(host.hostLogSearchEvents).mockResolvedValue(
      orderOnlyPage.events.map((event) => ({
        event,
        score: 1,
        matchKind: "keyword",
        templateId: event.templateId,
      })),
    );

    render(<LogExplorer corpusId="c1" />);
    const root = await screen.findByTestId("log-explorer");
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(root.getAttribute("data-time-quality")).toBe("order_only"),
    );

    await act(async () => {
      pendingFacets.resolve({
        sources: { "late.log": 1 },
        levels: { info: 1 },
        services: {},
        hosts: {},
        timeQuality: "wall",
      });
      pendingPage.resolve(eventPage("late.log", "wall"));
      await Promise.resolve();
    });

    expect(root.getAttribute("data-time-quality")).toBe("order_only");
    expect(screen.getByText(/search\.log event 0/)).toBeTruthy();
    expect(screen.queryByText(/late\.log event 0/)).toBeNull();
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
      );
      expect(stored?.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(stored?.messages[0]?.content).toBe("What failed?");
      expect(stored?.messages[1]?.content).toBe("The API failed first.");
    });

    fireEvent.click(screen.getByText(stored!.title));
    expect(await within(thread).findByText("What failed?")).toBeTruthy();
    expect(
      await within(thread).findByText("The API failed first."),
    ).toBeTruthy();
  });
});
