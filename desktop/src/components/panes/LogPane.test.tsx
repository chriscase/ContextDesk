/**
 * Structural tests for Logs list|detail chrome (no Tauri).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { LogCorpusSummaryDto } from "../../lib/host";
import { LogPane } from "./LogPane";

const hostMocks = vi.hoisted(() => ({
  listCorpora: vi.fn(),
  listTemplates: vi.fn(),
  clusterProblems: vi.fn(),
  search: vi.fn(),
  timeline: vi.fn(),
  setActiveCorpus: vi.fn(),
  reanalyze: vi.fn(),
  cancelReanalysis: vi.fn(),
  discard: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("../../lib/host", () => ({
  hostListLogCorpora: hostMocks.listCorpora,
  hostListenProcessProgress: vi.fn(async () => () => {}),
  hostCancelLogIngest: vi.fn(async () => true),
  hostCancelLogReanalysis: hostMocks.cancelReanalysis,
  hostDiscardLogCorpus: hostMocks.discard,
  hostExportLogCorpusPackage: vi.fn(),
  hostImportLogCorpusPackagePath: vi.fn(),
  hostIngestLogPath: vi.fn(),
  hostListLogTemplates: hostMocks.listTemplates,
  hostLogClusterProblems: hostMocks.clusterProblems,
  hostLogSearch: hostMocks.search,
  hostLogTimeline: hostMocks.timeline,
  hostOpenLogExplorer: vi.fn(),
  hostReanalyzeLogCorpus: hostMocks.reanalyze,
  hostSetActiveLogCorpus: hostMocks.setActiveCorpus,
}));

vi.mock("../../lib/dialogs", () => ({
  dialogConfirm: hostMocks.confirm,
  openDirectoryDialog: vi.fn(async () => null),
  openFileDialog: vi.fn(async () => null),
  saveFileDialog: vi.fn(async () => null),
}));

function corpusButtonName(name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(?:\\s|$)`);
}

function corpus(id: string, name: string): LogCorpusSummaryDto {
  return {
    id,
    name,
    eventCount: 12,
    templateCount: 3,
    engine: "duckdb",
    createdAt: 1_700_000_000,
    sourceLabel: `${id}.log`,
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
  };
}

describe("LogPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hostMocks.listCorpora.mockResolvedValue([]);
    hostMocks.listTemplates.mockResolvedValue([]);
    hostMocks.clusterProblems.mockResolvedValue([]);
    hostMocks.search.mockResolvedValue([]);
    hostMocks.timeline.mockResolvedValue([]);
    hostMocks.setActiveCorpus.mockResolvedValue(null);
    hostMocks.reanalyze.mockResolvedValue({
      state: "complete",
      modelId: "fixture-local",
      embeddedTemplates: 1,
      totalTemplates: 1,
      reason: "trusted_local_reanalysis",
      updatedAt: 1,
    });
    hostMocks.confirm.mockResolvedValue(false);
    hostMocks.cancelReanalysis.mockResolvedValue(true);
    hostMocks.discard.mockResolvedValue(undefined);
  });

  it("renders toolbar import/export actions and empty state", async () => {
    render(<LogPane />);
    expect(screen.getByTestId("log-pane")).toBeTruthy();
    // Toolbar + empty-state both offer Import logs
    expect(
      screen.getAllByRole("button", { name: /Import logs/i }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByRole("button", { name: /Import package/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Export package/i }),
    ).toBeTruthy();
    expect(await screen.findByText(/No corpora yet/i)).toBeTruthy();
  });

  it("preserves primary corpus selection and keeps only one named overflow menu open", async () => {
    const first = corpus("corpus-a", "API incident");
    const second = corpus("corpus-b", "Worker incident");
    hostMocks.listCorpora.mockResolvedValue([first, second]);

    render(<LogPane />);
    const firstCard = await screen.findByRole("button", {
      name: corpusButtonName(first.name),
    });
    fireEvent.click(firstCard);
    await waitFor(() =>
      expect(hostMocks.setActiveCorpus).toHaveBeenCalledWith(first.id),
    );
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Discard$/ })).toBeNull();

    const firstTrigger = screen.getByRole("button", {
      name: `More actions for ${first.name}`,
    });
    fireEvent.click(firstTrigger);
    const firstMenu = await screen.findByRole("menu", {
      name: `Actions for ${first.name}`,
    });
    expect(within(firstMenu).getByRole("menuitem")).toBe(
      document.activeElement,
    );

    const secondTrigger = screen.getByRole("button", {
      name: `More actions for ${second.name}`,
    });
    fireEvent.click(secondTrigger);
    expect(
      await screen.findByRole("menu", {
        name: `Actions for ${second.name}`,
      }),
    ).toBeTruthy();
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(firstTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(secondTrigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("dismisses the corpus menu with Escape or outside pointer input and restores focus", async () => {
    const item = corpus("corpus-a", "API incident");
    hostMocks.listCorpora.mockResolvedValue([item]);

    render(<LogPane />);
    const trigger = await screen.findByRole("button", {
      name: `More actions for ${item.name}`,
    });
    fireEvent.click(trigger);
    expect(await screen.findByRole("menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    expect(await screen.findByRole("menu")).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("heading", { name: "Logs" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("opens from the keyboard and clamps the menu inside a narrow viewport", async () => {
    const item = corpus("corpus-a", "API incident");
    hostMocks.listCorpora.mockResolvedValue([item]);
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 240,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 180,
    });

    try {
      render(<LogPane />);
      const trigger = await screen.findByRole("button", {
        name: `More actions for ${item.name}`,
      });
      trigger.getBoundingClientRect = vi.fn(
        () =>
          ({
            left: 210,
            right: 238,
            top: 150,
            bottom: 178,
            width: 28,
            height: 28,
            x: 210,
            y: 150,
            toJSON: () => ({}),
          }) as DOMRect,
      );
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      const menu = await screen.findByRole("menu");
      menu.getBoundingClientRect = vi.fn(
        () =>
          ({
            left: 0,
            right: 160,
            top: 0,
            bottom: 80,
            width: 160,
            height: 80,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          }) as DOMRect,
      );
      fireEvent(window, new Event("resize"));
      await waitFor(() => {
        expect(menu.style.left).toBe("72px");
        expect(menu.style.top).toBe("66px");
      });
      expect(within(menu).getByRole("menuitem")).toBe(document.activeElement);
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalWidth,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: originalHeight,
      });
    }
  });

  it("requires discard confirmation, preserves the corpus on cancel, and restores trigger focus", async () => {
    const item = corpus("corpus-a", "API incident");
    hostMocks.listCorpora.mockResolvedValue([item]);
    hostMocks.confirm.mockResolvedValue(false);

    render(<LogPane />);
    const trigger = await screen.findByRole("button", {
      name: `More actions for ${item.name}`,
    });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitem"));

    await waitFor(() =>
      expect(hostMocks.confirm).toHaveBeenCalledWith(
        expect.stringContaining(item.name),
        expect.objectContaining({ kind: "warning" }),
      ),
    );
    expect(hostMocks.discard).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(
      screen.getByRole("button", { name: corpusButtonName(item.name) }),
    ).toBeTruthy();
  });

  it("discards only after confirmation and moves focus to the next corpus", async () => {
    const first = corpus("corpus-a", "API incident");
    const second = corpus("corpus-b", "Worker incident");
    hostMocks.listCorpora
      .mockResolvedValueOnce([first, second])
      .mockResolvedValue([second]);
    hostMocks.confirm.mockResolvedValue(true);

    render(<LogPane />);
    const trigger = await screen.findByRole("button", {
      name: `More actions for ${first.name}`,
    });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitem"));

    await waitFor(() =>
      expect(hostMocks.discard).toHaveBeenCalledWith(first.id),
    );
    const secondCard = await screen.findByRole("button", {
      name: corpusButtonName(second.name),
    });
    await waitFor(() => expect(document.activeElement).toBe(secondCard));
    expect(
      screen.queryByRole("button", {
        name: corpusButtonName(first.name),
      }),
    ).toBeNull();
  });

  it("renders persisted partial counters and bounded exclusion reasons", async () => {
    const partialCorpus: LogCorpusSummaryDto = {
      id: "partial-corpus",
      name: "Partial incident",
      eventCount: 2,
      templateCount: 1,
      engine: "duckdb",
      createdAt: 1_700_000_000,
      sourceLabel: "incident-logs",
      stats: {
        files: 1,
        discoveredFiles: 5,
        excludedFiles: 2,
        failedFiles: 1,
        ignoredFiles: 1,
        exclusionCounts: {
          binary: 1,
          too_large: 1,
          open_failed: 1,
          hidden: 1,
        },
        exclusionExamples: [
          "binary: binary.log",
          "too_large: oversized.log",
          "open_failed: unreadable.log",
          "hidden: .ignored.log",
        ],
        partial: true,
        lines: 2,
        templates: 1,
        reductionRatio: 2,
        embedded: 0,
        sourceBytes: 64,
        corpusBytes: 128,
        levelCounts: { info: 1, error: 1 },
        tsMin: 1,
        tsMax: 2,
        formatCounts: { plain: 2 },
      },
      topTemplates: [],
      embedding: {
        state: "deferred",
        modelId: "fixture-local",
        embeddedTemplates: 0,
        totalTemplates: 1,
        reason: "bulk_source_bytes_threshold",
        updatedAt: 1,
      },
    };
    hostMocks.listCorpora.mockResolvedValue([partialCorpus]);

    render(<LogPane />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: corpusButtonName("Partial incident"),
      }),
    );

    const overview = await screen.findByTestId("log-overview");
    expect(overview.textContent).toContain("1/5 files imported");
    expect(overview.textContent).toContain(
      "partial: 2 excluded, 1 failed, 1 ignored",
    );
    const partial = within(overview).getByTestId("log-ingest-partial");
    expect(within(partial).getByText("binary: binary.log")).toBeTruthy();
    expect(within(partial).getByText("too_large: oversized.log")).toBeTruthy();
    expect(
      within(partial).getByText("open_failed: unreadable.log"),
    ).toBeTruthy();
    expect(within(partial).getByText("hidden: .ignored.log")).toBeTruthy();
    expect(
      within(overview).getByTestId("log-embedding-state").textContent,
    ).toContain("Keyword-only · deferred");
  });

  it("does not eagerly query or render the overview timeline on corpus select (#521)", async () => {
    const corpus: LogCorpusSummaryDto = {
      id: "timeline-skip-corpus",
      name: "Busy incident",
      eventCount: 50_000,
      templateCount: 200,
      engine: "duckdb",
      createdAt: 1_700_000_000,
      sourceLabel: "big-dump",
      stats: {
        files: 6,
        discoveredFiles: 6,
        excludedFiles: 0,
        failedFiles: 0,
        ignoredFiles: 0,
        exclusionCounts: {},
        exclusionExamples: [],
        partial: false,
        lines: 50_000,
        templates: 200,
        reductionRatio: 250,
        embedded: 0,
        sourceBytes: 1_000_000,
        corpusBytes: 2_000_000,
        levelCounts: { info: 40_000, error: 10_000 },
        tsMin: 1,
        tsMax: 2,
        formatCounts: { json: 50_000 },
      },
      topTemplates: [],
      embedding: {
        state: "keyword_only",
        modelId: null,
        embeddedTemplates: 0,
        totalTemplates: 200,
        reason: "local_model_unavailable",
        updatedAt: 1,
      },
    };
    hostMocks.listCorpora.mockResolvedValue([corpus]);
    // If the old eager path returns, this would paint decorative bars.
    hostMocks.timeline.mockResolvedValue(
      Array.from({ length: 60 }, (_, i) => ({
        start: 1_700_000_000 + i * 60,
        count: 1000 + i,
      })),
    );

    render(<LogPane />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: corpusButtonName("Busy incident"),
      }),
    );
    const overview = await screen.findByTestId("log-overview");
    await waitFor(() => {
      expect(hostMocks.clusterProblems).toHaveBeenCalledWith(corpus.id, 12);
      expect(hostMocks.listTemplates).toHaveBeenCalledWith(corpus.id, 100);
    });
    expect(
      within(overview).getByText("250 avg. events/template"),
    ).toBeTruthy();
    fireEvent.click(
      within(overview).getByRole("button", {
        name: "Help: Events per template",
      }),
    );
    const groupingHelp = await screen.findByRole("dialog", {
      name: "Events per template",
    });
    expect(groupingHelp.textContent).toContain(
      "Every original redacted event remains",
    );
    expect(groupingHelp.textContent).toContain(
      "not a byte-compression or event-deletion claim",
    );
    fireEvent.click(
      within(groupingHelp).getByRole("button", { name: "Close help" }),
    );
    // Regression: selecting a corpus must not call hostLogTimeline.
    expect(hostMocks.timeline).not.toHaveBeenCalled();
    expect(
      within(overview).getByTestId("log-overview-no-eager-timeline"),
    ).toBeTruthy();
    expect(overview.querySelector(".log-timeline-bars")).toBeNull();
    // Multiple selects must not re-introduce the query.
    fireEvent.click(
      screen.getByRole("button", {
        name: corpusButtonName("Busy incident"),
      }),
    );
    await waitFor(() =>
      expect(hostMocks.clusterProblems.mock.calls.length).toBeGreaterThanOrEqual(
        1,
      ),
    );
    expect(hostMocks.timeline).not.toHaveBeenCalled();
  });

  it("requires confirmation and invokes trusted local re-analysis", async () => {
    const corpus: LogCorpusSummaryDto = {
      id: "00000000-0000-7000-8000-000000000001",
      name: "Keyword incident",
      eventCount: 2,
      templateCount: 1,
      engine: "duckdb",
      createdAt: 1_700_000_000,
      sourceLabel: "incident.log",
      stats: null,
      topTemplates: [],
      embedding: {
        state: "keyword_only",
        modelId: null,
        embeddedTemplates: 0,
        totalTemplates: 1,
        reason: "local_model_unavailable",
        updatedAt: 1,
      },
    };
    hostMocks.listCorpora.mockResolvedValue([corpus]);
    hostMocks.confirm.mockResolvedValue(true);

    render(<LogPane />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: corpusButtonName("Keyword incident"),
      }),
    );
    const reanalyze = screen.getByTestId("reanalyze-log-corpus");
    await waitFor(() => expect(reanalyze.hasAttribute("disabled")).toBe(false));
    fireEvent.click(reanalyze);

    await waitFor(() => {
      expect(hostMocks.confirm).toHaveBeenCalledWith(
        expect.stringContaining("stays on this machine"),
        expect.any(Object),
      );
      expect(hostMocks.reanalyze).toHaveBeenCalledWith(corpus.id);
    });
  });

  it("shows progress and routes cancellation to re-analysis", async () => {
    let resolveReanalysis!: (value: {
      state: "complete";
      modelId: string;
      embeddedTemplates: number;
      totalTemplates: number;
      reason: string;
      updatedAt: number;
    }) => void;
    hostMocks.reanalyze.mockReturnValue(
      new Promise((resolve) => {
        resolveReanalysis = resolve;
      }),
    );
    hostMocks.confirm.mockResolvedValue(true);
    hostMocks.listCorpora.mockResolvedValue([
      {
        id: "00000000-0000-7000-8000-000000000002",
        name: "Deferred incident",
        eventCount: 2,
        templateCount: 1,
        engine: "duckdb",
        createdAt: 1,
        sourceLabel: "incident.log",
        stats: null,
        topTemplates: [],
        embedding: {
          state: "deferred",
          modelId: "fixture-local",
          embeddedTemplates: 0,
          totalTemplates: 1,
          reason: "bulk_source_bytes_threshold",
          updatedAt: 1,
        },
      },
    ]);

    render(<LogPane />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: corpusButtonName("Deferred incident"),
      }),
    );
    const reanalyze = screen.getByTestId("reanalyze-log-corpus");
    await waitFor(() => expect(reanalyze.hasAttribute("disabled")).toBe(false));
    fireEvent.click(reanalyze);
    const cancel = await screen.findByRole("button", {
      name: "Cancel re-analysis",
    });
    fireEvent.click(cancel);
    await waitFor(() =>
      expect(hostMocks.cancelReanalysis).toHaveBeenCalledTimes(1),
    );

    resolveReanalysis({
      state: "complete",
      modelId: "fixture-local",
      embeddedTemplates: 1,
      totalTemplates: 1,
      reason: "trusted_local_reanalysis",
      updatedAt: 2,
    });
    expect(
      await screen.findByText(/Local re-analysis complete:/),
    ).toBeTruthy();
  });
});
