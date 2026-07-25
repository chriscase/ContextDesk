import {
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

describe("LogExplorer shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
