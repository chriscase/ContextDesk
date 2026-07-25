/**
 * Structural tests for Logs list|detail chrome (no Tauri).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { LogCorpusSummaryDto } from "../../lib/host";
import { LogPane } from "./LogPane";

const hostMocks = vi.hoisted(() => ({
  listCorpora: vi.fn(),
  listTemplates: vi.fn(),
  clusterProblems: vi.fn(),
  search: vi.fn(),
  timeline: vi.fn(),
  setActiveCorpus: vi.fn(),
}));

vi.mock("../../lib/host", () => ({
  hostListLogCorpora: hostMocks.listCorpora,
  hostListenProcessProgress: vi.fn(async () => () => {}),
  hostCancelLogIngest: vi.fn(async () => true),
  hostDiscardLogCorpus: vi.fn(),
  hostExportLogCorpusPackage: vi.fn(),
  hostImportLogCorpusPackagePath: vi.fn(),
  hostIngestLogPath: vi.fn(),
  hostListLogTemplates: hostMocks.listTemplates,
  hostLogClusterProblems: hostMocks.clusterProblems,
  hostLogSearch: hostMocks.search,
  hostLogTimeline: hostMocks.timeline,
  hostOpenLogExplorer: vi.fn(),
  hostSetActiveLogCorpus: hostMocks.setActiveCorpus,
}));

vi.mock("../../lib/dialogs", () => ({
  dialogConfirm: vi.fn(async () => false),
  openDirectoryDialog: vi.fn(async () => null),
  openFileDialog: vi.fn(async () => null),
  saveFileDialog: vi.fn(async () => null),
}));

describe("LogPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hostMocks.listCorpora.mockResolvedValue([]);
    hostMocks.listTemplates.mockResolvedValue([]);
    hostMocks.clusterProblems.mockResolvedValue([]);
    hostMocks.search.mockResolvedValue([]);
    hostMocks.timeline.mockResolvedValue([]);
    hostMocks.setActiveCorpus.mockResolvedValue(null);
  });

  it("renders toolbar import/export actions and empty state", async () => {
    render(<LogPane />);
    expect(screen.getByTestId("log-pane")).toBeTruthy();
    // Toolbar + empty-state both offer Import logs
    expect(screen.getAllByRole("button", { name: /Import logs/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: /Import package/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Export package/i })).toBeTruthy();
    expect(await screen.findByText(/No corpora yet/i)).toBeTruthy();
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
    };
    hostMocks.listCorpora.mockResolvedValue([partialCorpus]);

    render(<LogPane />);
    fireEvent.click(await screen.findByRole("button", { name: /Partial incident/i }));

    const overview = await screen.findByTestId("log-overview");
    expect(overview.textContent).toContain("1/5 files imported");
    expect(overview.textContent).toContain(
      "partial: 2 excluded, 1 failed, 1 ignored",
    );
    const partial = within(overview).getByTestId("log-ingest-partial");
    expect(within(partial).getByText("binary: binary.log")).toBeTruthy();
    expect(within(partial).getByText("too_large: oversized.log")).toBeTruthy();
    expect(within(partial).getByText("open_failed: unreadable.log")).toBeTruthy();
    expect(within(partial).getByText("hidden: .ignored.log")).toBeTruthy();
  });
});
