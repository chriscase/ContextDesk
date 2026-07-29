/**
 * Structural tests for Logs list|detail chrome (no Tauri).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
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
  ingest: vi.fn(),
  importPackage: vi.fn(),
  reanalyze: vi.fn(),
  cancelReanalysis: vi.fn(),
  discard: vi.fn(),
  confirm: vi.fn(),
  getBranding: vi.fn(),
  getFailedIngestDiagnostic: vi.fn(),
  clearFailedIngestDiagnostic: vi.fn(),
  saveDiagnostic: vi.fn(),
  saveFile: vi.fn(),
  openFile: vi.fn(),
  listenProgress: vi.fn(),
}));

vi.mock("../../lib/host", () => ({
  hostListLogCorpora: hostMocks.listCorpora,
  hostListenProcessProgress: hostMocks.listenProgress,
  hostCancelLogIngest: vi.fn(async () => true),
  hostClearFailedLogIngestDiagnostic:
    hostMocks.clearFailedIngestDiagnostic,
  hostCancelLogReanalysis: hostMocks.cancelReanalysis,
  hostDiscardLogCorpus: hostMocks.discard,
  hostExportLogCorpusPackage: vi.fn(),
  hostGetBranding: hostMocks.getBranding,
  hostImportLogCorpusPackagePath: hostMocks.importPackage,
  hostGetFailedLogIngestDiagnostic: hostMocks.getFailedIngestDiagnostic,
  hostIngestLogPath: hostMocks.ingest,
  hostListLogTemplates: hostMocks.listTemplates,
  hostLogClusterProblems: hostMocks.clusterProblems,
  hostLogSearch: hostMocks.search,
  hostLogTimeline: hostMocks.timeline,
  hostOpenLogExplorer: vi.fn(),
  hostReanalyzeLogCorpus: hostMocks.reanalyze,
  hostSaveLogDiagnosticReport: hostMocks.saveDiagnostic,
  hostSetActiveLogCorpus: hostMocks.setActiveCorpus,
}));

vi.mock("../../lib/dialogs", () => ({
  dialogConfirm: hostMocks.confirm,
  openDirectoryDialog: vi.fn(async () => null),
  openFileDialog: hostMocks.openFile,
  saveFileDialog: hostMocks.saveFile,
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
    hostMocks.listenProgress.mockResolvedValue(() => {});
    hostMocks.setActiveCorpus.mockResolvedValue(null);
    hostMocks.getFailedIngestDiagnostic.mockResolvedValue(null);
    hostMocks.clearFailedIngestDiagnostic.mockResolvedValue(true);
    hostMocks.importPackage.mockResolvedValue({
      corpusId: "package-corpus",
      name: "Package corpus",
      originCorpusId: "origin-corpus",
    });
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
    hostMocks.getBranding.mockResolvedValue({
      name: "ContextDesk",
      slug: "contextdesk",
      tagline: "Developer knowledge workbench",
      version: "0.1.0",
      protocol: "cd.v1",
      channel: "dev",
      git_sha: "de43caeba66df05068a50db9356efad3b64a4a45",
      git_describe: null,
      identity_line: "v0.1.0 · channel=dev",
    });
    hostMocks.saveDiagnostic.mockResolvedValue(undefined);
    hostMocks.saveFile.mockResolvedValue(null);
    hostMocks.openFile.mockResolvedValue(null);
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
    expect(within(firstMenu).getAllByRole("menuitem")[0]).toBe(
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

  it("dismisses the corpus menu when keyboard focus leaves it", async () => {
    const item = corpus("corpus-a", "API incident");
    hostMocks.listCorpora.mockResolvedValue([item]);

    render(<LogPane />);
    const trigger = await screen.findByRole("button", {
      name: `More actions for ${item.name}`,
    });
    fireEvent.click(trigger);
    expect(await screen.findByRole("menu")).toBeTruthy();

    const logsHeading = screen.getByRole("heading", { name: "Logs" });
    const outsideButton = screen.getByRole("button", {
      name: /Import package/i,
    });
    act(() => outsideButton.focus());

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(outsideButton);
    expect(logsHeading).toBeTruthy();
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
      expect(within(menu).getAllByRole("menuitem")[0]).toBe(
        document.activeElement,
      );
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

  it("previews, copies, and safely saves privacy-bounded corpus diagnostics", async () => {
    const item: LogCorpusSummaryDto = {
      ...corpus("corpus-a", "API private.internal"),
      sourceLabel: "/Users/chris/Company/private.log",
      stats: {
        files: 1,
        discoveredFiles: 3,
        excludedFiles: 1,
        failedFiles: 1,
        ignoredFiles: 0,
        exclusionCounts: { binary: 1, open_failed: 1 },
        exclusionExamples: [
          "binary: /Users/chris/Company/core.bin",
          "open_failed: C:\\Company\\secret.log",
        ],
        partial: true,
        lines: 12,
        templates: 3,
        reductionRatio: 4,
        embedded: 0,
        sourceBytes: 64,
        corpusBytes: 128,
        levelCounts: { info: 10, error: 2 },
        tsMin: 1,
        tsMax: 12,
        formatCounts: { json: 12 },
      },
      topTemplates: [
        {
          id: 1,
          pattern: "PRIVATE_TEMPLATE_PAYLOAD customer=secret",
          count: 12,
          severity: 5,
        },
      ],
      embedding: {
        state: "partial",
        modelId: "embarrassing-private-model",
        embeddedTemplates: 1,
        totalTemplates: 3,
        reason: "private-provider",
        updatedAt: 1,
      },
    };
    hostMocks.listCorpora.mockResolvedValue([item]);
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    hostMocks.saveFile
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("/tmp/corpus-diagnostic.md")
      .mockResolvedValueOnce("/tmp/corpus-diagnostic.json");

    render(<LogPane />);
    const trigger = await screen.findByRole("button", {
      name: `More actions for ${item.name}`,
    });
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    const exportItem = within(menu).getByRole("menuitem", {
      name: "Export diagnostics…",
    });
    const discardItem = within(menu).getByRole("menuitem", {
      name: "Discard corpus…",
    });
    expect(document.activeElement).toBe(exportItem);
    fireEvent.keyDown(exportItem, { key: "ArrowDown" });
    expect(document.activeElement).toBe(discardItem);
    fireEvent.keyDown(discardItem, { key: "ArrowUp" });
    expect(document.activeElement).toBe(exportItem);
    fireEvent.click(exportItem);

    const dialog = await screen.findByRole("dialog", {
      name: "Export corpus diagnostics",
    });
    expect(screen.queryByRole("menu")).toBeNull();
    const note = within(dialog).getByLabelText(/Optional reproduction note/);
    await waitFor(() => expect(document.activeElement).toBe(note));
    const markdownToggle = within(dialog).getByRole("button", {
      name: "Markdown",
    });
    const jsonToggle = within(dialog).getByRole("button", { name: "JSON" });
    expect(markdownToggle.getAttribute("aria-pressed")).toBe("true");
    expect(jsonToggle.getAttribute("aria-pressed")).toBe("false");
    const keyboardPreview = within(dialog).getByLabelText(
      "Markdown diagnostic preview",
    );
    expect(keyboardPreview.getAttribute("tabindex")).toBe("0");
    act(() => keyboardPreview.focus());
    expect(document.activeElement).toBe(keyboardPreview);
    expect(dialog.textContent).toContain("Raw logs and event payloads");
    expect(dialog.textContent).toContain("provider/model inventories");
    fireEvent.change(note, {
      target: {
        value: "Repro at /Users/chris/Company with Bearer secret-token-value",
      },
    });

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Copy Markdown" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = String(writeText.mock.calls[0]?.[0]);
    expect(copied).toContain("[REDACTED_PATH]");
    expect(copied).not.toContain("secret-token-value");
    expect(copied).not.toContain("PRIVATE_TEMPLATE_PAYLOAD");
    expect(copied).not.toContain("embarrassing-private-model");
    expect(copied).not.toContain("private-provider");
    expect(copied).not.toContain(item.sourceLabel);

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save Markdown…" }),
    );
    await waitFor(() =>
      expect(
        within(dialog).getByText("Save cancelled. No file was written."),
      ).toBeTruthy(),
    );
    expect(hostMocks.saveDiagnostic).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save Markdown…" }),
    );
    await waitFor(() =>
      expect(hostMocks.saveDiagnostic).toHaveBeenCalledWith(
        "/tmp/corpus-diagnostic.md",
        "markdown",
        expect.stringContaining("# ContextDesk corpus diagnostic"),
        true,
      ),
    );

    fireEvent.click(jsonToggle);
    expect(markdownToggle.getAttribute("aria-pressed")).toBe("false");
    expect(jsonToggle.getAttribute("aria-pressed")).toBe("true");
    expect(
      within(dialog).getByLabelText("JSON diagnostic preview").textContent,
    ).toContain('"schemaVersion": 1');
    fireEvent.click(within(dialog).getByRole("button", { name: "Save JSON…" }));
    await waitFor(() =>
      expect(hostMocks.saveDiagnostic).toHaveBeenCalledWith(
        "/tmp/corpus-diagnostic.json",
        "json",
        expect.stringContaining('"schemaVersion": 1'),
        true,
      ),
    );

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("previews, copies, and clears one failed-ingest diagnostic without publishing a corpus", async () => {
    const firstFailure = {
      schemaVersion: 2,
      generatedAt: 1_753_680_000,
      sourceKind: "zip" as const,
      reasonCode: "invalid_archive" as const,
      summary:
        "The selected archive could not be validated; no corpus was published.",
      cancelled: false,
      progress: {
        lastPhase: "scan",
        linesProcessed: 0,
        filesProcessed: 4,
        bytesProcessed: 1024,
        templates: 0,
        updatesSeen: 3,
      },
      evidence: {
        scanCounts: {
          binary: 1,
          empty: 1,
          hidden: 1,
          oversized: 1,
          readFailed: 1,
          parseFailed: 1,
        },
        transcript: [
          { reason: "binary" as const, basename: "core.bin" },
          { reason: "empty" as const, basename: "empty.log" },
          {
            reason: "parse_failed" as const,
            basename: "malformed.log",
          },
        ],
        omittedEntries: 2,
      },
      redacted: true as const,
    };
    hostMocks.confirm.mockResolvedValue(true);
    hostMocks.ingest.mockRejectedValue(
      new Error(
        "zip open failed at /Users/employee/private.internal/secret.zip",
      ),
    );
    hostMocks.getFailedIngestDiagnostic
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(firstFailure);
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <LogPane
        pickDirectory={async () =>
          "/Users/employee/private.internal/secret.zip"
        }
      />,
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Import logs…" })[0]!,
    );

    const available = await screen.findByRole("region", {
      name: "Failed import diagnostic",
    });
    expect(available.textContent).toContain("No corpus was published");
    expect(available.textContent).toContain("only in memory");
    expect(hostMocks.listCorpora).toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: corpusButtonName("incident") }),
    ).toBeNull();

    const exportButton = within(available).getByRole("button", {
      name: "Export diagnostics…",
    });
    fireEvent.click(exportButton);
    const dialog = await screen.findByRole("dialog", {
      name: "Export failed-ingest diagnostics",
    });
    expect(within(dialog).getByText(/latest failed import/)).toBeTruthy();
    expect(
      within(dialog).getByLabelText("Markdown diagnostic preview").textContent,
    ).toContain("Reason: invalid_archive");
    expect(
      within(dialog).getByLabelText("Markdown diagnostic preview").textContent,
    ).toContain("binary: 1");
    expect(
      within(dialog).getByLabelText("Markdown diagnostic preview").textContent,
    ).toContain("parse_failed: malformed.log");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Copy Markdown" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = String(writeText.mock.calls[0]?.[0]);
    expect(copied).toContain("Corpus published: no");
    expect(copied).not.toContain("/Users/employee");
    expect(copied).not.toContain("private.internal");
    expect(copied).not.toContain("secret.zip");

    fireEvent.click(within(dialog).getByRole("button", { name: "JSON" }));
    const jsonPreview = within(dialog).getByLabelText(
      "JSON diagnostic preview",
    ).textContent;
    expect(jsonPreview).toContain('"scanCounts"');
    expect(jsonPreview).toContain('"binary": 1');
    expect(jsonPreview).toContain('"basename": "malformed.log"');
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Copy JSON" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(exportButton);

    fireEvent.click(
      within(available).getByRole("button", { name: "Clear diagnostic" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("region", {
          name: "Failed import diagnostic",
        }),
      ).toBeNull(),
    );
    expect(hostMocks.clearFailedIngestDiagnostic).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(
      screen.getAllByRole("button", { name: "Import logs…" })[0],
    );
  });

  it("replaces repeated failure evidence and clears it when a later import succeeds", async () => {
    const failure = (summary: string, basename: string) => ({
      schemaVersion: 2,
      generatedAt: 1_753_680_000,
      sourceKind: "directory" as const,
      reasonCode: "no_safe_events" as const,
      summary,
      cancelled: false,
      progress: {
        lastPhase: "parse",
        linesProcessed: 0,
        filesProcessed: 1,
        bytesProcessed: 4,
        templates: 0,
        updatesSeen: 3,
      },
      evidence: {
        scanCounts: {
          binary: 1,
          empty: 0,
          hidden: 0,
          oversized: 0,
          readFailed: 0,
          parseFailed: 0,
        },
        transcript: [{ reason: "binary" as const, basename }],
        omittedEntries: 0,
      },
      redacted: true as const,
    });
    const first = failure("First failed attempt.", "first.bin");
    const second = failure("Second failed attempt.", "second.bin");
    hostMocks.confirm.mockResolvedValue(true);
    hostMocks.ingest
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(new Error("second failure"))
      .mockResolvedValueOnce({
        corpusId: "successful-corpus",
        lines: 1,
        templates: 1,
        reductionRatio: 1,
        embedded: 0,
        files: 1,
        discoveredFiles: 1,
        excludedFiles: 0,
        failedFiles: 0,
        ignoredFiles: 0,
        exclusionCounts: {},
        exclusionExamples: [],
        partial: false,
        sourceBytes: 24,
        corpusBytes: 128,
        levelCounts: { info: 1 },
        tsMin: 1,
        tsMax: 1,
        formatCounts: { logfmt: 1 },
        topTemplates: [],
        embedding: {
          state: "keyword_only",
          modelId: null,
          embeddedTemplates: 0,
          totalTemplates: 1,
          reason: "embedding_not_requested",
          updatedAt: 1,
        },
      });
    hostMocks.getFailedIngestDiagnostic
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    render(<LogPane pickDirectory={async () => "/tmp/logs"} />);

    fireEvent.click(
      screen.getAllByRole("button", { name: "Import logs…" })[0]!,
    );
    let available = await screen.findByRole("region", {
      name: "Failed import diagnostic",
    });
    expect(available.textContent).toContain("First failed attempt.");

    fireEvent.click(
      screen.getAllByRole("button", { name: "Import logs…" })[0]!,
    );
    await waitFor(() => {
      available = screen.getByRole("region", {
        name: "Failed import diagnostic",
      });
      expect(available.textContent).toContain("Second failed attempt.");
      expect(available.textContent).not.toContain("First failed attempt.");
    });

    fireEvent.click(
      screen.getAllByRole("button", { name: "Import logs…" })[0]!,
    );
    await waitFor(() => expect(hostMocks.ingest).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", {
          name: "Failed import diagnostic",
        }),
      ).toBeNull(),
    );
    expect(hostMocks.getFailedIngestDiagnostic).toHaveBeenCalledTimes(3);
  });

  it("clears a stale raw-ingest diagnostic when a package import attempt begins", async () => {
    hostMocks.getFailedIngestDiagnostic.mockResolvedValue({
      schemaVersion: 2,
      generatedAt: 1,
      sourceKind: "directory",
      reasonCode: "no_safe_events",
      summary: "Stale raw ingest failure.",
      cancelled: false,
      progress: {
        lastPhase: "parse",
        linesProcessed: 0,
        filesProcessed: 1,
        bytesProcessed: 0,
        templates: 0,
        updatesSeen: 1,
      },
      evidence: {
        scanCounts: {
          binary: 1,
          empty: 0,
          hidden: 0,
          oversized: 0,
          readFailed: 0,
          parseFailed: 0,
        },
        transcript: [{ reason: "binary", basename: "old.bin" }],
        omittedEntries: 0,
      },
      redacted: true,
    });
    hostMocks.openFile.mockResolvedValue("/tmp/package.cdlog.zip");
    hostMocks.confirm.mockResolvedValue(true);
    hostMocks.importPackage.mockRejectedValue(
      new Error("package validation failed"),
    );

    render(<LogPane />);
    expect(
      await screen.findByRole("region", {
        name: "Failed import diagnostic",
      }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /Import package/i }),
    );
    await waitFor(() =>
      expect(hostMocks.importPackage).toHaveBeenCalledWith(
        "/tmp/package.cdlog.zip",
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("region", {
          name: "Failed import diagnostic",
        }),
      ).toBeNull(),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "package validation failed",
    );
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
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Discard corpus…" }),
    );

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
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Discard corpus…" }),
    );

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
    expect(within(overview).getByText("250 avg. events/template")).toBeTruthy();
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
      expect(
        hostMocks.clusterProblems.mock.calls.length,
      ).toBeGreaterThanOrEqual(1),
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
    await waitFor(() =>
      expect(hostMocks.listenProgress).toHaveBeenCalledTimes(1),
    );
    const publishProgress = hostMocks.listenProgress.mock.calls[0]?.[0];
    act(() => {
      publishProgress({
        kind: "log_ingest",
        phase: "embed",
        message: "Embedding templates",
        fraction: 0.8,
        lines_processed: 2,
        files_processed: 1,
        bytes_processed: 128,
        templates: 1,
        cancellable: true,
      });
    });
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
    expect(await screen.findByText(/Local re-analysis complete:/)).toBeTruthy();
  });
});
