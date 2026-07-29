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
import type {
  LogClusterDto,
  LogCorpusSummaryDto,
  LogTemplateRowDto,
} from "../../lib/host";
import {
  renderLogDiagnosticMarkdown,
  type LogDiagnosticManifest,
} from "../../lib/logDiagnosticReport";
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
  prepareDiagnostic: vi.fn(),
  releaseDiagnostic: vi.fn(),
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
  hostPrepareLogDiagnosticReport: hostMocks.prepareDiagnostic,
  hostReleaseLogDiagnosticReport: hostMocks.releaseDiagnostic,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
    hostMocks.saveDiagnostic.mockResolvedValue({ status: "saved" });
    hostMocks.releaseDiagnostic.mockResolvedValue(true);
    hostMocks.prepareDiagnostic.mockImplementation(
      async (manifest: LogDiagnosticManifest) => ({
        reportId: "cdlogdiag-0000000000000001-0000000000000001",
        markdown: renderLogDiagnosticMarkdown(manifest),
        json: JSON.stringify(manifest, null, 2),
      }),
    );
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
    hostMocks.saveDiagnostic
      .mockResolvedValueOnce({ status: "cancelled" })
      .mockResolvedValueOnce({
        status: "saved_with_warning",
        warning: "parent directory sync failed",
      })
      .mockResolvedValueOnce({ status: "saved" });

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
    const scrollBody = within(dialog).getByRole("region", {
      name: "Diagnostic details and exact preview",
    });
    const primarySave = within(dialog).getByRole("button", {
      name: "Save Markdown…",
    });
    expect(scrollBody.tabIndex).toBe(0);
    expect(scrollBody.contains(primarySave)).toBe(false);
    expect(primarySave.closest("footer")?.parentElement).toBe(dialog);
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
    await waitFor(() =>
      expect(keyboardPreview.textContent).toContain(
        "# ContextDesk corpus diagnostic",
      ),
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
    await waitFor(() =>
      expect(keyboardPreview.textContent).toContain("[REDACTED_PATH]"),
    );

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
      primarySave,
    );
    await waitFor(() =>
      expect(
        within(dialog).getByText("Save cancelled. No file was written."),
      ).toBeTruthy(),
    );
    expect(hostMocks.saveDiagnostic).toHaveBeenCalledTimes(1);
    expect(hostMocks.saveDiagnostic).toHaveBeenLastCalledWith(
      "cdlogdiag-0000000000000001-0000000000000001",
      "markdown",
    );

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save Markdown…" }),
    );
    await waitFor(() =>
      expect(hostMocks.saveDiagnostic).toHaveBeenLastCalledWith(
        "cdlogdiag-0000000000000001-0000000000000001",
        "markdown",
      ),
    );
    expect(
      within(dialog).getByText(/Saved redacted Markdown diagnostics.*warning/),
    ).toBeTruthy();
    expect(dialog.textContent).not.toContain("Diagnostics were not saved");
    expect(hostMocks.saveDiagnostic).toHaveBeenCalledTimes(2);

    fireEvent.click(jsonToggle);
    expect(markdownToggle.getAttribute("aria-pressed")).toBe("false");
    expect(jsonToggle.getAttribute("aria-pressed")).toBe("true");
    expect(
      within(dialog).getByLabelText("JSON diagnostic preview").textContent,
    ).toContain('"schemaVersion": 1');
    fireEvent.click(within(dialog).getByRole("button", { name: "Save JSON…" }));
    await waitFor(() =>
      expect(hostMocks.saveDiagnostic).toHaveBeenLastCalledWith(
        "cdlogdiag-0000000000000001-0000000000000001",
        "json",
      ),
    );
    expect(hostMocks.saveDiagnostic).toHaveBeenCalledTimes(3);

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
    await waitFor(() =>
      expect(
        within(dialog).getByLabelText("Markdown diagnostic preview")
          .textContent,
      ).toContain("Reason: invalid_archive"),
    );
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

  it("keeps 250k-event corpus activation responsive until analysis is explicitly requested (#743)", async () => {
    const largeCorpus = {
      ...corpus("large-corpus", "Company-scale incident"),
      eventCount: 250_000,
      templateCount: 12_500,
    };
    const pendingClusters = deferred<LogClusterDto[]>();
    const pendingTemplates = deferred<LogTemplateRowDto[]>();
    hostMocks.listCorpora.mockResolvedValue([largeCorpus]);
    hostMocks.clusterProblems.mockReturnValue(pendingClusters.promise);
    hostMocks.listTemplates.mockReturnValue(pendingTemplates.promise);

    render(<LogPane />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: corpusButtonName(largeCorpus.name),
      }),
    );

    expect(await screen.findByTestId("log-overview")).toBeTruthy();
    await waitFor(() =>
      expect(hostMocks.setActiveCorpus).toHaveBeenCalledWith(largeCorpus.id),
    );
    expect(hostMocks.clusterProblems).not.toHaveBeenCalled();
    expect(hostMocks.listTemplates).not.toHaveBeenCalled();
    expect(hostMocks.timeline).not.toHaveBeenCalled();

    const menuTrigger = screen.getByRole("button", {
      name: `More actions for ${largeCorpus.name}`,
    });
    expect(menuTrigger.hasAttribute("disabled")).toBe(false);
    fireEvent.click(menuTrigger);
    expect(await screen.findByRole("menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(menuTrigger));

    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    const load = screen.getByRole("button", { name: "Load analysis" });
    load.focus();
    fireEvent.click(load);

    await waitFor(() => {
      expect(hostMocks.clusterProblems).toHaveBeenCalledWith(
        largeCorpus.id,
        12,
      );
      expect(hostMocks.listTemplates).toHaveBeenCalledWith(largeCorpus.id, 100);
    });
    expect(
      screen.getByText(/You can keep selecting and managing corpora/),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Loading analysis…" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(document.activeElement).toBe(load);
    expect(menuTrigger.hasAttribute("disabled")).toBe(false);
    fireEvent.click(menuTrigger);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Export diagnostics…" }),
    );
    const pendingDialog = await screen.findByRole("dialog", {
      name: "Export corpus diagnostics",
    });
    fireEvent.keyDown(pendingDialog, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(menuTrigger));
  });

  it("serializes host activation so the newest corpus is written last (#743)", async () => {
    const first = corpus("corpus-a", "Slow activation");
    const second = corpus("corpus-b", "Newest activation");
    const firstActivation = deferred<null>();
    hostMocks.listCorpora.mockResolvedValue([first, second]);
    hostMocks.setActiveCorpus.mockImplementation((id: string) =>
      id === first.id ? firstActivation.promise : Promise.resolve(null),
    );

    render(<LogPane />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: corpusButtonName(first.name),
      }),
    );
    await waitFor(() =>
      expect(hostMocks.setActiveCorpus).toHaveBeenCalledWith(first.id),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: corpusButtonName(second.name),
      }),
    );
    expect(
      await screen.findByRole("heading", { name: second.name }),
    ).toBeTruthy();
    expect(hostMocks.setActiveCorpus.mock.calls.map(([id]) => id)).toEqual([
      first.id,
    ]);

    await act(async () => {
      firstActivation.resolve(null);
      await firstActivation.promise;
    });
    await waitFor(() =>
      expect(hostMocks.setActiveCorpus.mock.calls.map(([id]) => id)).toEqual([
        first.id,
        second.id,
      ]),
    );
    expect(screen.getByRole("heading", { name: second.name })).toBeTruthy();
  });

  it("surfaces activation failure only for the current corpus (#743)", async () => {
    const item = corpus("corpus-a", "Activation failure");
    hostMocks.listCorpora.mockResolvedValue([item]);
    hostMocks.setActiveCorpus.mockRejectedValue(
      new Error("host activation unavailable"),
    );

    render(<LogPane />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: corpusButtonName(item.name),
      }),
    );

    expect(
      await screen.findByRole("heading", { name: item.name }),
    ).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "host activation unavailable",
    );
  });

  it("ignores an older corpus-list refresh that resolves after a newer import refresh (#743)", async () => {
    const oldCorpus = corpus("corpus-old", "Obsolete list");
    const newCorpus = corpus("corpus-new", "Imported list");
    const oldList = deferred<LogCorpusSummaryDto[]>();
    const newList = deferred<LogCorpusSummaryDto[]>();
    hostMocks.listCorpora
      .mockReturnValueOnce(oldList.promise)
      .mockReturnValueOnce(newList.promise);
    hostMocks.openFile.mockResolvedValue("/tmp/synthetic-package.cdlog");
    hostMocks.confirm.mockResolvedValue(true);
    hostMocks.importPackage.mockResolvedValue({
      corpusId: newCorpus.id,
      name: newCorpus.name,
      originCorpusId: "synthetic-origin",
    });

    render(<LogPane />);
    fireEvent.click(screen.getByRole("button", { name: "Import package…" }));
    await waitFor(() => expect(hostMocks.listCorpora).toHaveBeenCalledTimes(2));

    await act(async () => {
      newList.resolve([newCorpus]);
      await newList.promise;
    });
    expect(
      await screen.findByRole("heading", { name: newCorpus.name }),
    ).toBeTruthy();

    await act(async () => {
      oldList.resolve([oldCorpus]);
      await oldList.promise;
    });
    expect(
      screen.getByRole("button", {
        name: corpusButtonName(newCorpus.name),
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: corpusButtonName(oldCorpus.name),
      }),
    ).toBeNull();
  });

  it("keeps the newest corpus selected when an older discard finishes late (#743)", async () => {
    const first = corpus("corpus-a", "Discard pending");
    const second = corpus("corpus-b", "Keep selected");
    const discard = deferred<void>();
    hostMocks.listCorpora
      .mockResolvedValueOnce([first, second])
      .mockResolvedValue([second]);
    hostMocks.confirm.mockResolvedValue(true);
    hostMocks.discard.mockReturnValue(discard.promise);

    render(<LogPane />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: corpusButtonName(first.name),
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: `More actions for ${first.name}` }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Discard corpus/i }),
    );
    await waitFor(() => expect(hostMocks.discard).toHaveBeenCalledWith(first.id));

    fireEvent.click(
      screen.getByRole("button", {
        name: corpusButtonName(second.name),
      }),
    );
    expect(
      await screen.findByRole("heading", { name: second.name }),
    ).toBeTruthy();

    await act(async () => {
      discard.resolve();
      await discard.promise;
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: corpusButtonName(first.name),
        }),
      ).toBeNull(),
    );
    expect(screen.getByRole("heading", { name: second.name })).toBeTruthy();
  });

  it("isolates deferred analysis by corpus and coalesces repeated activation (#743)", async () => {
    const first = {
      ...corpus("corpus-a", "API incident"),
      eventCount: 250_000,
    };
    const second = corpus("corpus-b", "Worker incident");
    const firstClusters = deferred<LogClusterDto[]>();
    const firstTemplates = deferred<LogTemplateRowDto[]>();
    hostMocks.listCorpora.mockResolvedValue([first, second]);
    hostMocks.clusterProblems.mockImplementation((id: string) =>
      id === first.id
        ? firstClusters.promise
        : Promise.resolve<LogClusterDto[]>([]),
    );
    hostMocks.listTemplates.mockImplementation((id: string) =>
      id === first.id
        ? firstTemplates.promise
        : Promise.resolve<LogTemplateRowDto[]>([]),
    );

    render(<LogPane />);
    const firstCard = await screen.findByRole("button", {
      name: corpusButtonName(first.name),
    });
    fireEvent.click(firstCard);
    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    fireEvent.click(screen.getByRole("button", { name: "Load analysis" }));
    await waitFor(() =>
      expect(hostMocks.clusterProblems).toHaveBeenCalledTimes(1),
    );

    // Re-activating the same corpus while its bounded request is pending must
    // keep the request coalesced rather than starting duplicate work.
    fireEvent.click(firstCard);
    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    const loading = screen.getByRole("button", {
      name: "Loading analysis…",
    });
    expect(loading.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(loading);
    expect(hostMocks.clusterProblems).toHaveBeenCalledTimes(1);
    expect(hostMocks.listTemplates).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: corpusButtonName(second.name) }),
    );
    expect(
      await screen.findByRole("heading", { name: second.name }),
    ).toBeTruthy();
    expect(screen.queryByText("FIRST_CORPUS_TEMPLATE")).toBeNull();

    act(() => {
      firstClusters.resolve([
        {
          clusterId: 7,
          label: "FIRST_CORPUS_CLUSTER",
          count: 10,
          severity: 4,
          score: 8,
          templateIds: [9],
          exemplars: ["first exemplar"],
        },
      ]);
      firstTemplates.resolve([
        {
          id: 9,
          pattern: "FIRST_CORPUS_TEMPLATE",
          count: 10,
          severity: 4,
        },
      ]);
    });
    await act(async () => {
      await Promise.all([firstClusters.promise, firstTemplates.promise]);
    });

    // A late response for the first corpus cannot paint over the newer active
    // corpus, but remains cached when the user deliberately returns.
    expect(screen.getByRole("heading", { name: second.name })).toBeTruthy();
    expect(screen.queryByText("FIRST_CORPUS_TEMPLATE")).toBeNull();
    fireEvent.click(firstCard);
    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    expect(await screen.findByText("FIRST_CORPUS_TEMPLATE")).toBeTruthy();
    expect(hostMocks.clusterProblems).toHaveBeenCalledTimes(1);
    expect(hostMocks.listTemplates).toHaveBeenCalledTimes(1);
  });

  it("discards invalidate analysis cache so re-load refetches (#743)", async () => {
    const item = {
      ...corpus("corpus-a", "Discardable incident"),
      eventCount: 250_000,
    };
    hostMocks.listCorpora.mockResolvedValue([item]);
    hostMocks.clusterProblems.mockResolvedValue([
      {
        clusterId: 1,
        label: "CACHED_CLUSTER",
        count: 9,
        severity: 3,
        score: 5,
        templateIds: [1],
        exemplars: ["cached"],
      },
    ]);
    hostMocks.listTemplates.mockResolvedValue([
      { id: 1, pattern: "CACHED_TEMPLATE", count: 9, severity: 3 },
    ]);
    hostMocks.confirm.mockResolvedValue(true);
    hostMocks.discard.mockResolvedValue(undefined);

    render(<LogPane />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: corpusButtonName(item.name),
      }),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    fireEvent.click(screen.getByRole("button", { name: "Load analysis" }));
    expect(await screen.findByText("CACHED_TEMPLATE")).toBeTruthy();
    expect(hostMocks.clusterProblems).toHaveBeenCalledTimes(1);

    // Discard clears cache; re-add corpus (same id) via list refresh after discard.
    hostMocks.listCorpora.mockResolvedValue([]);
    fireEvent.click(
      screen.getByRole("button", { name: `More actions for ${item.name}` }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: /Discard/i }));
    await waitFor(() => expect(hostMocks.discard).toHaveBeenCalledWith(item.id));

    hostMocks.listCorpora.mockResolvedValue([item]);
    // Trigger remount path by re-render list: call refresh via re-import simulation —
    // re-select after putting corpus back by re-rendering with new list poll.
    // The pane refresh is internal; simulate by discarding then re-importing package
    // that selects a new corpus, then selecting the re-listed id.
    hostMocks.listCorpora.mockResolvedValue([item]);
    // Force refresh by import package flow which calls refresh + selectCorpus
    hostMocks.confirm.mockResolvedValue(true);
    hostMocks.importPackage.mockResolvedValue({
      corpusId: item.id,
      name: item.name,
      originCorpusId: "origin",
    });
    hostMocks.openFile.mockResolvedValue("/tmp/synthetic-package.cdlogpkg");
    fireEvent.click(screen.getByRole("button", { name: "Import package…" }));
    await waitFor(() =>
      expect(hostMocks.setActiveCorpus).toHaveBeenCalledWith(item.id),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    // Cache was cleared on discard — Load analysis must hit the host again.
    expect(screen.getByRole("button", { name: "Load analysis" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load analysis" }));
    await waitFor(() =>
      expect(hostMocks.clusterProblems).toHaveBeenCalledTimes(2),
    );
  });

  it("event-count growth invalidates cached analysis on list refresh (#743)", async () => {
    const v1 = {
      ...corpus("corpus-grow", "Growing incident"),
      eventCount: 250_000,
    };
    const v2 = { ...v1, eventCount: 260_000 };
    hostMocks.listCorpora.mockResolvedValue([v1]);
    hostMocks.clusterProblems.mockResolvedValue([]);
    hostMocks.listTemplates.mockResolvedValue([
      { id: 1, pattern: "GROW_TEMPLATE", count: 3, severity: 2 },
    ]);

    render(<LogPane />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: corpusButtonName(v1.name),
      }),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    fireEvent.click(screen.getByRole("button", { name: "Load analysis" }));
    expect(await screen.findByText("GROW_TEMPLATE")).toBeTruthy();
    expect(hostMocks.clusterProblems).toHaveBeenCalledTimes(1);

    // Simulate re-ingest: list refresh reports higher eventCount for same id.
    hostMocks.listCorpora.mockResolvedValue([v2]);
    hostMocks.confirm.mockResolvedValue(true);
    hostMocks.openFile.mockResolvedValue("/tmp/more-logs.zip");
    hostMocks.ingest.mockResolvedValue({
      corpusId: v2.id,
      name: v2.name,
      eventCount: v2.eventCount,
    });
    // Import triggers refresh after select — use package import which calls refresh.
    hostMocks.importPackage.mockResolvedValue({
      corpusId: v2.id,
      name: v2.name,
      originCorpusId: "origin",
    });
    fireEvent.click(screen.getByRole("button", { name: "Import package…" }));
    await waitFor(() =>
      expect(hostMocks.setActiveCorpus).toHaveBeenCalledWith(v2.id),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    // Stale ready cache must not short-circuit after eventCount change.
    const load = screen.getByRole("button", { name: "Load analysis" });
    expect(
      screen.queryByRole("button", { name: "Refresh analysis" }),
    ).toBeNull();
    fireEvent.click(load);
    await waitFor(() =>
      expect(hostMocks.clusterProblems).toHaveBeenCalledTimes(2),
    );
  });

  it("records honest component timing boundaries for a synthetic 250k corpus card (#743)", async () => {
    const large = {
      ...corpus("timing-250k", "Timing incident"),
      eventCount: 250_000,
      templateCount: 12_500,
    };
    const pendingClusters = deferred<LogClusterDto[]>();
    const pendingTemplates = deferred<LogTemplateRowDto[]>();
    hostMocks.listCorpora.mockResolvedValue([large]);
    hostMocks.clusterProblems.mockReturnValue(pendingClusters.promise);
    hostMocks.listTemplates.mockReturnValue(pendingTemplates.promise);

    const t0 = performance.now();
    render(<LogPane />);
    const card = await screen.findByRole("button", {
      name: corpusButtonName(large.name),
    });
    const listReady = performance.now();

    fireEvent.click(card);
    expect(await screen.findByTestId("log-overview")).toBeTruthy();
    const selectionReady = performance.now();
    expect(hostMocks.clusterProblems).not.toHaveBeenCalled();
    expect(hostMocks.listTemplates).not.toHaveBeenCalled();

    // Optional analysis is explicit and independent of selection timing.
    fireEvent.click(screen.getByRole("tab", { name: "Analysis" }));
    fireEvent.click(screen.getByRole("button", { name: "Load analysis" }));
    const analysisStarted = performance.now();
    act(() => {
      pendingClusters.resolve([]);
      pendingTemplates.resolve([]);
    });
    await waitFor(() =>
      expect(
        screen.getByText(/Loaded 0 templates and 0 problem clusters/),
      ).toBeTruthy(),
    );
    const analysisDone = performance.now();

    const listMs = listReady - t0;
    const selectMs = selectionReady - listReady;
    const analysisMs = analysisDone - analysisStarted;
    expect([listMs, selectMs, analysisMs].every((value) => value >= 0)).toBe(
      true,
    );
    // Component-harness evidence only — not a DuckDB or packaged-app SLO.
    console.info(
      JSON.stringify({
        kind: "log-pane-743-component-timing",
        environment: "vitest-jsdom-with-deferred-host-mocks",
        eventCount: 250_000,
        list_render_ms: Number(listMs.toFixed(2)),
        selection_to_overview_ms: Number(selectMs.toFixed(2)),
        on_demand_analysis_ms: Number(analysisMs.toFixed(2)),
        note: "Synthetic card only; packaged DuckDB timing remains required.",
      }),
    );
  });

  it("waits for both optional analysis calls to settle before enabling retry (#743)", async () => {
    const item = corpus("corpus-a", "Partial analysis failure");
    const pendingTemplates = deferred<LogTemplateRowDto[]>();
    hostMocks.listCorpora.mockResolvedValue([item]);
    hostMocks.clusterProblems
      .mockRejectedValueOnce(new Error("cluster failed"))
      .mockResolvedValue([]);
    hostMocks.listTemplates
      .mockReturnValueOnce(pendingTemplates.promise)
      .mockResolvedValue([]);

    render(<LogPane />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: corpusButtonName(item.name),
      }),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Analysis" }));
    fireEvent.click(screen.getByRole("button", { name: "Load analysis" }));
    await waitFor(() =>
      expect(hostMocks.clusterProblems).toHaveBeenCalledTimes(1),
    );

    expect(
      screen.getByRole("button", { name: "Loading analysis…" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Retry analysis" }),
    ).toBeNull();

    await act(async () => {
      pendingTemplates.resolve([]);
      await pendingTemplates.promise;
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "cluster failed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry analysis" }));
    await waitFor(() =>
      expect(hostMocks.clusterProblems).toHaveBeenCalledTimes(2),
    );
    expect(hostMocks.listTemplates).toHaveBeenCalledTimes(2);
  });

  it("keeps diagnostics and retry available after on-demand analysis fails (#743)", async () => {
    const item = corpus("corpus-a", "Recoverable incident");
    hostMocks.listCorpora.mockResolvedValue([item]);
    hostMocks.clusterProblems
      .mockRejectedValueOnce(new Error("bounded analysis unavailable"))
      .mockResolvedValue([]);
    hostMocks.listTemplates.mockResolvedValue([]);

    render(<LogPane />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: corpusButtonName(item.name),
      }),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Analysis" }));
    fireEvent.click(screen.getByRole("button", { name: "Load analysis" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "bounded analysis unavailable",
    );
    const menuTrigger = screen.getByRole("button", {
      name: `More actions for ${item.name}`,
    });
    expect(menuTrigger.hasAttribute("disabled")).toBe(false);
    fireEvent.click(menuTrigger);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Export diagnostics…" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Export corpus diagnostics",
    });
    fireEvent.keyDown(dialog, { key: "Escape" });

    const retry = await screen.findByRole("button", {
      name: "Retry analysis",
    });
    await waitFor(() => expect(document.activeElement).toBe(menuTrigger));
    retry.focus();
    fireEvent.click(retry);
    expect(
      await screen.findByText("Loaded 0 templates and 0 problem clusters."),
    ).toBeTruthy();
    expect(document.activeElement).toBe(retry);
    expect(hostMocks.clusterProblems).toHaveBeenCalledTimes(2);
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

  it("invalidates optional analysis after same-count local re-analysis (#743)", async () => {
    const item = corpus("corpus-reanalyze", "Same-count re-analysis");
    hostMocks.listCorpora.mockResolvedValue([item]);
    hostMocks.confirm.mockResolvedValue(true);
    hostMocks.listTemplates.mockResolvedValue([
      { id: 1, pattern: "BEFORE_REANALYSIS", count: 3, severity: 2 },
    ]);

    render(<LogPane />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: corpusButtonName(item.name),
      }),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    fireEvent.click(screen.getByRole("button", { name: "Load analysis" }));
    expect(await screen.findByText("BEFORE_REANALYSIS")).toBeTruthy();

    fireEvent.click(screen.getByTestId("reanalyze-log-corpus"));
    await waitFor(() =>
      expect(hostMocks.reanalyze).toHaveBeenCalledWith(item.id),
    );
    await screen.findByText(/Local re-analysis complete:/);

    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    expect(screen.getByRole("button", { name: "Load analysis" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Refresh analysis" }),
    ).toBeNull();
  });

  it("does not restore an older corpus when its re-analysis finishes late (#743)", async () => {
    const first = corpus("corpus-a", "Analysis pending");
    const second = corpus("corpus-b", "Newest selection");
    const pending = deferred<{
      state: "complete";
      modelId: string;
      embeddedTemplates: number;
      totalTemplates: number;
      reason: string;
      updatedAt: number;
    }>();
    hostMocks.listCorpora.mockResolvedValue([first, second]);
    hostMocks.confirm.mockResolvedValue(true);
    hostMocks.reanalyze.mockReturnValue(pending.promise);

    render(<LogPane />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: corpusButtonName(first.name),
      }),
    );
    fireEvent.click(screen.getByTestId("reanalyze-log-corpus"));
    await waitFor(() =>
      expect(hostMocks.reanalyze).toHaveBeenCalledWith(first.id),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: corpusButtonName(second.name),
      }),
    );
    expect(
      await screen.findByRole("heading", { name: second.name }),
    ).toBeTruthy();

    await act(async () => {
      pending.resolve({
        state: "complete",
        modelId: "fixture-local",
        embeddedTemplates: 3,
        totalTemplates: 3,
        reason: "trusted_local_reanalysis",
        updatedAt: 2,
      });
      await pending.promise;
    });
    await screen.findByText(/Local re-analysis complete:/);
    expect(screen.getByRole("heading", { name: second.name })).toBeTruthy();
    expect(
      hostMocks.setActiveCorpus.mock.calls.map(([id]) => id).at(-1),
    ).toBe(second.id);
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
