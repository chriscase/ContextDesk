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
  hostLogQueryEventNeighborhood: vi.fn(async () => ({
    status: "missing",
    events: [],
    totalMatched: 0,
    corpusTotal: 0,
    timeQuality: "order_only",
  })),
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
    vi.mocked(host.hostLogListBookmarks).mockResolvedValue([]);
    vi.mocked(host.hostLogSearchEvents).mockResolvedValue([]);
    vi.mocked(host.hostLogSearchEventsAdvanced).mockResolvedValue({ hits: [], partial: false, scanned: 0 });
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

  it("focuses Find with the platform find shortcut", async () => {
    render(<LogExplorer corpusId="c1" />);
    const root = await screen.findByTestId("log-explorer");
    const input = screen.getByTestId("log-explorer-find");
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(root, { key: "f", metaKey: true });
    expect(document.activeElement).toBe(input);
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

    const headers = screen.getByTestId("log-explorer-col-headers");
    expect(headers.style.gridTemplateColumns).toContain("12rem");
    const messageResize = screen.getByTestId("col-resize-3");
    expect(messageResize.getAttribute("aria-label")).toBe(
      "Resize Message column",
    );
    fireEvent.keyDown(messageResize, { key: "ArrowRight" });
    await waitFor(() =>
      expect(headers.style.gridTemplateColumns).toContain("12.5rem"),
    );

    const timeResize = screen.getByTestId("col-resize-0");
    fireEvent.mouseDown(timeResize, { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 132 });
    fireEvent.mouseUp(window);
    await waitFor(() =>
      expect(headers.style.gridTemplateColumns).toContain("9.5rem"),
    );

    fireEvent.click(screen.getByTestId("col-autofit"));
    await waitFor(() =>
      expect(headers.style.gridTemplateColumns).toContain("40rem"),
    );
    fireEvent.click(screen.getByTestId("col-reset"));
    await waitFor(() =>
      expect(headers.style.gridTemplateColumns).toContain("12rem"),
    );

    const eventTime = screen.getByTestId("event-time-1");
    expect(eventTime.tabIndex).toBe(0);
    expect(eventTime.getAttribute("aria-label")).toMatch(
      /wall clock.*UTC/,
    );

    fireEvent.change(screen.getByTestId("preview-lines"), {
      target: { value: "12" },
    });
    fireEvent.click(screen.getByTestId("line-mode-wrap"));
    await waitFor(() =>
      expect(
        screen
          .getByTestId("virtualized-event-list")
          .getAttribute("data-total-height"),
      ).toBe(String(228 * page.events.length)),
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
    fireEvent.click(within(inspector).getByTestId("detail-close"));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-seq")).toBe("1"),
    );
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
      expect(screen.queryByTitle("2 evidence lanes")).toBeNull();

      fireEvent.click(await screen.findByText("auth failure"));
      expect(screen.getByTestId("log-explorer-detail")).toBeTruthy();

      const filtersToggle = screen.getByTestId("narrow-filters-toggle");
      fireEvent.click(filtersToggle);
      expect(filtersToggle.getAttribute("aria-expanded")).toBe("true");
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByTestId("log-explorer-find"),
        ),
      );

      const errorFacet = within(
        screen.getByTestId("log-explorer-filters"),
      )
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
            : allEvents.filter((event) =>
                sourceFilter.includes(event.source),
              );
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
    fireEvent.click(
      screen.getByRole("checkbox", { name: /api\.log/i }),
    );
    await waitFor(() =>
      expect(host.hostLogQueryEvents).toHaveBeenLastCalledWith(
        "c1",
        expect.objectContaining({ sources: ["api.log"] }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText("job ok")).toBeNull(),
    );

    fireEvent.click(
      await screen.findByTestId("bookmark-activate-bm-worker"),
    );
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
    expect(
      screen.getByTestId("bookmark-restore-view").textContent,
    ).toContain("temp reveal");

    fireEvent.click(screen.getByTestId("bookmark-restore-view"));
    await waitFor(() =>
      expect(host.hostLogQueryEvents).toHaveBeenLastCalledWith(
        "c1",
        expect.objectContaining({ sources: ["api.log"] }),
      ),
    );
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
    fireEvent.click(
      await screen.findByTestId("bookmark-activate-bm-missing"),
    );
    expect(await screen.findByTestId("bookmark-missing")).toBeTruthy();
    expect(screen.getByText(/not found in corpus/)).toBeTruthy();
    expect(screen.queryByText(/Jumped bookmark/i)).toBeNull();
  });

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
        const page =
          sources.includes("queue.log")
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
    fireEvent.click(
      await screen.findByRole("button", { name: "2L" }),
    );
    fireEvent.click(screen.getByTestId("lane-editor-toggle"));
    const editor = screen.getByTestId("lane-editor");
    const laneRows = editor.querySelectorAll(".log-explorer__lane-editor-row");
    expect(laneRows.length).toBe(2);
    fireEvent.click(
      within(laneRows[0] as HTMLElement).getByRole("checkbox", {
        name: /api\.log/i,
      }),
    );
    fireEvent.click(
      within(laneRows[1] as HTMLElement).getByRole("checkbox", {
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

    fireEvent.click(
      await screen.findByTestId("bookmark-activate-bm-queue"),
    );
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
    expect(
      screen.getAllByText(/Bookmark · queue\.log/).length,
    ).toBeGreaterThan(0);

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
    fireEvent.click(screen.getByTitle("2 evidence lanes"));

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
    vi.mocked(host.hostLogQueryEvents).mockImplementation(
      async (_corpusId, query) => {
        if ((query?.sources?.length ?? 0) === 0) {
          return eventPage("all.log", "wall", 2, 1_700_000_000, 35);
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
    fireEvent.click(screen.getByTitle("4 evidence lanes"));
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
      pending[2]!.resolve(
        eventPage("empty.log", "wall", 0, 1_700_000_050, 0),
      );
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
    expect(screen.getByTestId("lane-count-lane-2").textContent).toContain(
      "matched unavailable",
    );

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

    render(<LogExplorer corpusId="c1" />);
    fireEvent.click(await screen.findByTestId("load-older-lane-0"));
    expect(await screen.findByText("older 99")).toBeTruthy();
    expect(screen.getByText("middle 101")).toBeTruthy();
    expect(host.hostLogQueryEvents).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        beforeSeq: 101,
        beforeTs: 1_700_000_101,
      }),
    );

    fireEvent.click(screen.getByTestId("load-more-lane-0"));
    expect(await screen.findByText("newer 104")).toBeTruthy();
    expect(screen.getByText("older 100")).toBeTruthy();
    expect(host.hostLogQueryEvents).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        afterSeq: 102,
        afterTs: 1_700_000_102,
      }),
    );
    expect(screen.queryByTestId("load-older-lane-0")).toBeNull();
    expect(screen.queryByTestId("load-more-lane-0")).toBeNull();
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
    fireEvent.click(await screen.findByTestId("load-more-lane-0"));
    const alert = await screen.findByTestId("lane-page-error-lane-0");
    expect(within(alert).getByText(/fixture page unavailable/)).toBeTruthy();
    expect(screen.getByText("auth failure")).toBeTruthy();

    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("retry recovered")).toBeTruthy();
    expect(screen.queryByTestId("lane-page-error-lane-0")).toBeNull();
    expect(newerAttempts).toBe(2);
  });

  it("paginates lanes independently while a peer lane is still loading", async () => {
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
            ...eventPage("worker.log", "wall", 1, 1_700_000_101, 2),
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
    fireEvent.click(await screen.findByTitle("2 evidence lanes"));
    const apiMore = await screen.findByTestId("load-more-lane-0");
    const workerMore = await screen.findByTestId("load-more-lane-1");
    fireEvent.click(apiMore);
    await waitFor(() =>
      expect((apiMore as HTMLButtonElement).disabled).toBe(true),
    );

    fireEvent.click(workerMore);
    await waitFor(() =>
      expect(screen.queryByTestId("load-more-lane-1")).toBeNull(),
    );
    expect((apiMore as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      slowApi.resolve({
        ...eventPage("api.log", "wall", 1, 1_700_000_001, 2),
        nextCursor: null,
        nextTs: null,
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.queryByTestId("load-more-lane-0")).toBeNull(),
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
    fireEvent.click(await screen.findByTestId("load-more-lane-0"));
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
    fireEvent.click(screen.getByTestId("log-explorer-find-run"));
    await waitFor(() =>
      expect(host.hostLogSearchEventsAdvanced).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ semantic: false }),
      ),
    );
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
    fireEvent.click(screen.getByTestId("log-explorer-find-run"));
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

  it("does not allow a late Find response to replace a newer query", async () => {
    const oldSearch = deferred<host.EventSearchResultDto>();
    const resultEvent = (seq: number, message: string): host.ExplorerEventDto => ({
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
    fireEvent.click(screen.getByTestId("log-explorer-find-run"));
    await waitFor(() =>
      expect(host.hostLogSearchEventsAdvanced).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ query: "old" }),
      ),
    );

    fireEvent.change(find, { target: { value: "new" } });
    fireEvent.click(screen.getByTestId("log-explorer-find-run"));
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
