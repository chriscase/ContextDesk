/**
 * Structural tests for Logs list|detail chrome (no Tauri).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  LogIngestReportDto,
  LogTemplateRowDto,
} from "../../lib/host";
import { hostOpenLogExplorer } from "../../lib/host";
import {
  renderLogDiagnosticMarkdown,
  type LogDiagnosticManifest,
} from "../../lib/logDiagnosticReport";
import { createMockEngineClient } from "@contextdesk/client";
import { LogPane, quickImportSourceKind } from "./LogPane";
import { loadCorpusImportActivity } from "../../lib/activity/importActivityBridge";

describe("quick import source classification", () => {
  it.each([
    ["directory", "/logs/archive.zip", "directory"],
    ["file", "/logs/current.log", "file"],
    ["file", "C:\\Logs\\rotations.ZIP", "zip"],
  ] as const)("classifies %s %s as %s", (mode, path, expected) => {
    expect(quickImportSourceKind(mode, path)).toBe(expected);
  });
});

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
  cancelIngest: vi.fn(async () => true),
  discard: vi.fn(),
  confirm: vi.fn(),
  getBranding: vi.fn(),
  getFailedIngestDiagnostic: vi.fn(),
  clearFailedIngestDiagnostic: vi.fn(),
  prepareDiagnostic: vi.fn(),
  releaseDiagnostic: vi.fn(),
  saveDiagnostic: vi.fn(),
  saveFile: vi.fn(),
  openDirectory: vi.fn(),
  openFile: vi.fn(),
  listenProgress: vi.fn(),
  loadTimezoneState: vi.fn(),
  previewTimezone: vi.fn(),
  applyTimezone: vi.fn(),
  clearTimezone: vi.fn(),
}));

// Reviewed-import (ImportFlow) tests inject a deterministic mock EngineClient
// in place of the real Tauri adapter, mirroring ImportFlow.test.tsx.
const engineMocks = vi.hoisted(() => ({
  client: null as unknown as ReturnType<typeof createMockEngineClient> | null,
}));
vi.mock("../../lib/engine/tauriEngineClient", () => ({
  createTauriEngineClient: () => engineMocks.client,
}));

// #851: the in-app embed tests exercise LogPane's chrome, not the Explorer
// internals (covered by LogExplorer.test.tsx and the visual suite) — the
// full Explorer cannot mount against this file's partial host mock anyway.
vi.mock("../logExplorer/LogExplorer", () => ({
  LogExplorer: ({ corpusId }: { corpusId: string }) => (
    <div data-testid="stub-log-explorer">{corpusId}</div>
  ),
}));

vi.mock("../../lib/host", () => ({
  hostListLogCorpora: hostMocks.listCorpora,
  hostListenProcessProgress: hostMocks.listenProgress,
  hostCancelLogIngest: hostMocks.cancelIngest,
  hostClearFailedLogIngestDiagnostic: hostMocks.clearFailedIngestDiagnostic,
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
  hostLoadLogTimezoneState: hostMocks.loadTimezoneState,
  hostLogClusterProblems: hostMocks.clusterProblems,
  hostLogSearch: hostMocks.search,
  hostLogTimeline: hostMocks.timeline,
  hostOpenLogExplorer: vi.fn(),
  hostPreviewLogSourceTimezone: hostMocks.previewTimezone,
  hostApplyLogSourceTimezone: hostMocks.applyTimezone,
  hostClearLogSourceTimezone: hostMocks.clearTimezone,
  hostReanalyzeLogCorpus: hostMocks.reanalyze,
  hostSaveLogDiagnosticReport: hostMocks.saveDiagnostic,
  hostSetActiveLogCorpus: hostMocks.setActiveCorpus,
  // Referenced by lib/engine/investigationReports delegation exports (#532),
  // pulled into this graph through LogPane's in-app LogExplorer embed.
  hostLogLoadActiveInvestigation: vi.fn(async () => null),
  hostLogPreviewInvestigationEvidence: vi.fn(),
  hostLogAssembleInvestigationReport: vi.fn(),
  hostLogSetInvestigationReportSection: vi.fn(),
  hostLogAcceptProposedReportSection: vi.fn(),
  hostLogDismissProposedReportSection: vi.fn(),
  hostLogSaveInvestigationReportExport: vi.fn(),
  hostLogReleaseInvestigationReportExport: vi.fn(async () => true),
}));

const revisionBridgeMocks = vi.hoisted(() => ({
  broadcast: vi.fn(async () => {}),
}));
vi.mock("../../lib/logExplorer/timeRevisionBridge", () => ({
  broadcastTimeRevisionChanged: revisionBridgeMocks.broadcast,
}));

vi.mock("../../lib/dialogs", () => ({
  dialogConfirm: hostMocks.confirm,
  openDirectoryDialog: hostMocks.openDirectory,
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

function successfulImport(corpusId: string): LogIngestReportDto {
  return {
    corpusId,
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
    formatCounts: { plain: 1 },
    topTemplates: [],
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

async function chooseImportMode(
  name: "Import a folder…" | "Import a raw log file or ZIP…",
  triggerIndex = 0,
) {
  fireEvent.click(
    screen.getAllByRole("button", { name: "Import logs…" })[triggerIndex]!,
  );
  const menu = await screen.findByRole("menu", { name: "Import logs" });
  fireEvent.click(within(menu).getByRole("menuitem", { name }));
}

function installMemoryStorage(): void {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  });
}

describe("LogPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMemoryStorage();
    hostMocks.listCorpora.mockResolvedValue([]);
    hostMocks.listTemplates.mockResolvedValue([]);
    hostMocks.clusterProblems.mockResolvedValue([]);
    hostMocks.search.mockResolvedValue([]);
    hostMocks.timeline.mockResolvedValue([]);
    hostMocks.listenProgress.mockResolvedValue(() => {});
    hostMocks.loadTimezoneState.mockImplementation(async (corpusId: string) => ({
      corpusId,
      eventRevision: 0,
      declarations: {},
      sources: [],
    }));
    hostMocks.previewTimezone.mockResolvedValue({
      corpusId: "timezone-corpus",
      eventRevision: 4,
      source: "app/server.log",
      ianaZone: "America/Chicago",
      previewToken: "timezone-preview",
      affectedRecords: 12,
      existingWallClockRecords: 0,
      firstResolvedTs: 1_700_000_000,
      lastResolvedTs: 1_700_000_120,
      dstGapRecords: 0,
      dstFoldAmbiguities: 0,
      unchangedOrderOnlyRecords: 0,
      unsupportedTimestampRecords: 0,
      zoneAbbreviationMismatchRecords: 0,
      outOfRangeRecords: 0,
      precision: "whole_second",
    });
    hostMocks.applyTimezone.mockResolvedValue({
      revision: 5,
      previousRevision: 4,
      changedEvents: 12,
      eventCount: 12,
      tsMin: 1_700_000_000,
      tsMax: 1_700_000_120,
    });
    hostMocks.clearTimezone.mockResolvedValue({
      revision: 6,
      previousRevision: 5,
      changedEvents: 12,
      eventCount: 12,
      tsMin: 1,
      tsMax: 12,
    });
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
    hostMocks.openDirectory.mockResolvedValue(null);
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
      screen.getByRole("button", { name: /Import ContextDesk package/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Export package/i }),
    ).toBeTruthy();
    expect(await screen.findByText(/No corpora yet/i)).toBeTruthy();
  });

  it("groups every Logs action by intent while keeping page identity separate", () => {
    const onOpenHelp = vi.fn();
    render(<LogPane onOpenHelp={onOpenHelp} />);

    const toolbar = screen.getByRole("navigation", {
      name: "Logs actions",
    });
    expect(
      toolbar.contains(screen.getByRole("heading", { name: "Logs" })),
    ).toBe(false);

    const imports = within(toolbar).getByRole("group", { name: "Import" });
    expect(
      within(imports).getByRole("button", { name: "Import logs…" }),
    ).toBeTruthy();
    expect(
      within(imports).getByRole("button", {
        name: "Import ContextDesk package…",
      }),
    ).toBeTruthy();

    const corpusActions = within(toolbar).getByRole("group", {
      name: "Corpus operations",
    });
    expect(
      within(corpusActions).getByRole("button", {
        name: "Export package…",
      }),
    ).toBeTruthy();
    expect(
      within(corpusActions).getByRole("button", {
        name: "Re-analyze locally…",
      }),
    ).toBeTruthy();

    const explorerActions = within(toolbar).getByRole("group", {
      name: "Open and explore",
    });
    expect(
      within(explorerActions).getByRole("button", {
        name: "Open Explorer…",
      }),
    ).toBeTruthy();
    expect(
      within(explorerActions).getByRole("button", { name: "Open in app" }),
    ).toBeTruthy();

    const help = within(toolbar).getByRole("group", { name: "Help" });
    fireEvent.click(within(help).getByRole("button", { name: "Learn more" }));
    expect(onOpenHelp).toHaveBeenCalledWith("log-explorer");
  });

  it("keeps every action in one semantic toolbar without a JS-only overflow mode", () => {
    render(<LogPane onOpenHelp={vi.fn()} />);
    const toolbar = screen.getByRole("navigation", {
      name: "Logs actions",
    });
    expect(within(toolbar).getAllByRole("group")).toHaveLength(4);
    expect(within(toolbar).getAllByRole("button")).toHaveLength(8);
    expect(
      within(toolbar).queryByRole("button", {
        name: /more logs actions/i,
      }),
    ).toBeNull();
  });

  it("layout truth (#641): every .log-pane__toolbar rule stays wrappable — no max-content tracks", () => {
    // happy-dom performs no layout and loads no stylesheets, so the real
    // clipping contract lives in visual/logs-library.test.tsx (real Chromium,
    // pane widths 592/900/1240). This source-level tripwire pins the exact
    // inversion that caused #641: a media tier turned the toolbar into a
    // repeat(4, max-content) grid — max-content tracks cannot wrap or shrink,
    // the base flex-wrap became inert, and the right-side actions clipped
    // into .pane-panel's overflow:hidden across the 864-1248px window band.
    const panesCss = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "styles",
        "components",
        "panes.css",
      ),
      "utf8",
    );
    const toolbarBlocks = panesCss.match(/\.log-pane__toolbar\s*\{[^}]*\}/g);
    expect(toolbarBlocks?.length).toBeGreaterThanOrEqual(1);
    // The base rule must keep wrapping enabled.
    expect(toolbarBlocks![0]).toContain("flex-wrap: wrap");
    for (const block of toolbarBlocks!) {
      // Grid overrides are allowed only with shrinkable tracks: max-content
      // (and fixed px tracks) overflow instead of wrapping.
      expect(block).not.toMatch(/max-content/);
      expect(block).not.toMatch(/grid-template-columns:[^;]*\dpx/);
      // Nothing may disable wrapping outright.
      expect(block).not.toMatch(/flex-wrap:\s*nowrap/);
    }
  });

  it("explains unavailable corpus actions and completed re-analysis", async () => {
    const complete = {
      ...corpus("corpus-complete", "Complete corpus"),
      embedding: {
        state: "complete" as const,
        modelId: "fixture-local",
        embeddedTemplates: 3,
        totalTemplates: 3,
        reason: "complete",
        updatedAt: 2,
      },
    };
    hostMocks.listCorpora.mockResolvedValue([complete]);

    render(<LogPane />);
    const exportAction = screen.getByRole("button", {
      name: "Export package…",
    });
    expect(exportAction.hasAttribute("disabled")).toBe(true);
    const unavailableId = exportAction.getAttribute("aria-describedby");
    expect(unavailableId).toBeTruthy();
    expect(document.getElementById(unavailableId!)?.textContent).toContain(
      "Select a corpus",
    );
    expect(exportAction.getAttribute("title")).toContain("Select a corpus");

    fireEvent.click(
      await screen.findByRole("button", {
        name: corpusButtonName(complete.name),
      }),
    );
    const reanalyze = screen.getByRole("button", {
      name: "Re-analyze locally…",
    });
    await waitFor(() => expect(reanalyze.hasAttribute("disabled")).toBe(true));
    const completeId = reanalyze.getAttribute("aria-describedby");
    expect(completeId).toBeTruthy();
    expect(document.getElementById(completeId!)?.textContent).toContain(
      "already fully analyzed locally",
    );
    expect(reanalyze.getAttribute("title")).toContain(
      "already fully analyzed locally",
    );
  });

  it("offers intentional folder and file import modes from both entry points", async () => {
    localStorage.setItem("cd-activity-inspector-mode", "compact");
    hostMocks.openDirectory.mockResolvedValue("/tmp/incident-folder");
    hostMocks.openFile.mockResolvedValue("/tmp/server.log");
    hostMocks.confirm.mockResolvedValue(true);
    hostMocks.ingest.mockResolvedValue(successfulImport("chosen-corpus"));

    render(<LogPane />);
    await screen.findByText(/No corpora yet/i);
    const emptyTrigger = screen.getAllByRole("button", {
      name: "Import logs…",
    })[1]!;

    await chooseImportMode("Import a folder…");
    await waitFor(() =>
      expect(hostMocks.ingest).toHaveBeenCalledWith(
        "/tmp/incident-folder",
        "incident",
        expect.stringMatching(/^import:/),
      ),
    );
    expect(hostMocks.openDirectory).toHaveBeenCalledWith("Choose log folder");
    expect(hostMocks.openFile).not.toHaveBeenCalled();
    expect(
      (await screen.findByTestId("activity-import-summary")).getAttribute(
        "data-source-kind",
      ),
    ).toBe("directory");
    await waitFor(() =>
      expect(emptyTrigger.hasAttribute("disabled")).toBe(false),
    );

    await chooseImportMode("Import a raw log file or ZIP…", 1);
    await waitFor(() =>
      expect(hostMocks.ingest).toHaveBeenCalledWith(
        "/tmp/server.log",
        "incident",
        expect.stringMatching(/^import:/),
      ),
    );
    expect(hostMocks.openFile).toHaveBeenCalledWith("Choose log file or ZIP", [
      {
        name: "Logs",
        extensions: ["log", "txt", "json", "jsonl", "zip"],
      },
    ]);
    expect(hostMocks.openDirectory).toHaveBeenCalledTimes(1);
    expect(hostMocks.ingest).toHaveBeenCalledTimes(2);
    expect(hostMocks.confirm).toHaveBeenCalledTimes(2);
    expect(
      screen
        .getByTestId("activity-import-summary")
        .getAttribute("data-source-kind"),
    ).toBe("file");
  });

  it("ends the action when either native import chooser is cancelled", async () => {
    render(<LogPane />);
    await screen.findByText(/No corpora yet/i);
    const toolbarTrigger = screen.getAllByRole("button", {
      name: "Import logs…",
    })[0]!;
    const emptyTrigger = screen.getAllByRole("button", {
      name: "Import logs…",
    })[1]!;

    await chooseImportMode("Import a folder…");
    await waitFor(() => expect(document.activeElement).toBe(toolbarTrigger));
    expect(hostMocks.openDirectory).toHaveBeenCalledTimes(1);
    expect(hostMocks.openFile).not.toHaveBeenCalled();
    expect(hostMocks.confirm).not.toHaveBeenCalled();
    expect(hostMocks.ingest).not.toHaveBeenCalled();

    await chooseImportMode("Import a raw log file or ZIP…", 1);
    await waitFor(() => expect(document.activeElement).toBe(emptyTrigger));
    expect(hostMocks.openFile).toHaveBeenCalledTimes(1);
    expect(hostMocks.openDirectory).toHaveBeenCalledTimes(1);
    expect(hostMocks.confirm).not.toHaveBeenCalled();
    expect(hostMocks.ingest).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Cancel ingest")).toBeNull();
    expect(screen.getByText(/No corpora yet/i)).toBeTruthy();
    expect(hostMocks.listCorpora).toHaveBeenCalledTimes(1);
  });

  it("restores focus on Escape but lets outside actions retain focus", async () => {
    render(<LogPane />);
    await screen.findByText(/No corpora yet/i);
    const [toolbarTrigger, emptyTrigger] = screen.getAllByRole("button", {
      name: "Import logs…",
    });

    fireEvent.click(toolbarTrigger!);
    expect(
      await screen.findByRole("menu", { name: "Import logs" }),
    ).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Import logs" })).toBeNull(),
    );
    expect(document.activeElement).toBe(toolbarTrigger);

    fireEvent.click(emptyTrigger!);
    expect(
      await screen.findByRole("menu", { name: "Import logs" }),
    ).toBeTruthy();
    const packageAction = screen.getByRole("button", {
      name: "Import ContextDesk package…",
    });
    fireEvent.pointerDown(packageAction);
    act(() => packageAction.focus());
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Import logs" })).toBeNull(),
    );
    expect(document.activeElement).toBe(packageAction);
    expect(hostMocks.openDirectory).not.toHaveBeenCalled();
    expect(hostMocks.openFile).not.toHaveBeenCalled();
  });

  it("supports keyboard opening and navigation in the import menu", async () => {
    render(<LogPane />);
    const trigger = screen.getAllByRole("button", {
      name: "Import logs…",
    })[0]!;
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu", { name: "Import logs" });
    const folder = within(menu).getByRole("menuitem", {
      name: "Import a folder…",
    });
    const file = within(menu).getByRole("menuitem", {
      name: "Import a raw log file or ZIP…",
    });
    expect(document.activeElement).toBe(folder);

    fireEvent.keyDown(folder, { key: "ArrowDown" });
    expect(document.activeElement).toBe(file);
    fireEvent.keyDown(file, { key: "ArrowDown" });
    expect(document.activeElement).toBe(folder);
    fireEvent.keyDown(folder, { key: "ArrowUp" });
    expect(document.activeElement).toBe(file);
    fireEvent.keyDown(file, { key: "Home" });
    expect(document.activeElement).toBe(folder);
    fireEvent.keyDown(folder, { key: "End" });
    expect(document.activeElement).toBe(file);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.queryByRole("menu", { name: "Import logs" })).toBeNull();

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    const reopened = await screen.findByRole("menu", {
      name: "Import logs",
    });
    expect(
      within(reopened).getByRole("menuitem", {
        name: "Import a raw log file or ZIP…",
      }),
    ).toBe(document.activeElement);
  });

  it("dismisses both portaled menus in capture phase when an outside destination stops propagation", async () => {
    const item = corpus("corpus-a", "API incident");
    hostMocks.listCorpora.mockResolvedValue([item]);

    render(<LogPane />);
    const importTrigger = screen.getAllByRole("button", {
      name: "Import logs…",
    })[0]!;
    const corpusTrigger = await screen.findByRole("button", {
      name: `More actions for ${item.name}`,
    });
    const destination = screen.getByRole("button", {
      name: "Import ContextDesk package…",
    });
    const stopPropagation = (event: Event) => event.stopPropagation();
    destination.addEventListener("pointerdown", stopPropagation);

    try {
      fireEvent.click(importTrigger);
      expect(
        await screen.findByRole("menu", { name: "Import logs" }),
      ).toBeTruthy();
      fireEvent.pointerDown(destination);
      act(() => destination.focus());
      await waitFor(() =>
        expect(screen.queryByRole("menu", { name: "Import logs" })).toBeNull(),
      );
      expect(document.activeElement).toBe(destination);

      fireEvent.click(corpusTrigger);
      expect(
        await screen.findByRole("menu", {
          name: `Actions for ${item.name}`,
        }),
      ).toBeTruthy();
      fireEvent.pointerDown(destination);
      act(() => destination.focus());
      await waitFor(() =>
        expect(
          screen.queryByRole("menu", {
            name: `Actions for ${item.name}`,
          }),
        ).toBeNull(),
      );
      expect(document.activeElement).toBe(destination);
    } finally {
      destination.removeEventListener("pointerdown", stopPropagation);
    }
  });

  it("restores each portaled menu trigger when Escape starts inside the menu", async () => {
    const item = corpus("corpus-a", "API incident");
    hostMocks.listCorpora.mockResolvedValue([item]);

    render(<LogPane />);
    const importTrigger = screen.getAllByRole("button", {
      name: "Import logs…",
    })[0]!;
    importTrigger.focus();
    fireEvent.keyDown(importTrigger, { key: "ArrowDown" });
    const importMenu = await screen.findByRole("menu", {
      name: "Import logs",
    });
    const importItem = within(importMenu).getByRole("menuitem", {
      name: "Import a folder…",
    });
    fireEvent.keyDown(importItem, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Import logs" })).toBeNull(),
    );
    expect(document.activeElement).toBe(importTrigger);

    const corpusTrigger = await screen.findByRole("button", {
      name: `More actions for ${item.name}`,
    });
    corpusTrigger.focus();
    fireEvent.keyDown(corpusTrigger, { key: "ArrowDown" });
    const corpusMenu = await screen.findByRole("menu", {
      name: `Actions for ${item.name}`,
    });
    fireEvent.keyDown(
      within(corpusMenu).getByRole("menuitem", {
        name: "Export diagnostics…",
      }),
      { key: "Escape" },
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("menu", {
          name: `Actions for ${item.name}`,
        }),
      ).toBeNull(),
    );
    expect(document.activeElement).toBe(corpusTrigger);
  });

  it("keeps interactions inside each portaled root open until an action dismisses it", async () => {
    const item = corpus("corpus-a", "API incident");
    hostMocks.listCorpora.mockResolvedValue([item]);
    hostMocks.confirm.mockResolvedValue(false);

    render(<LogPane />);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Import logs…" })[0]!,
    );
    const importMenu = await screen.findByRole("menu", {
      name: "Import logs",
    });
    fireEvent.pointerDown(importMenu);
    fireEvent.click(importMenu);
    expect(screen.getByRole("menu", { name: "Import logs" })).toBe(importMenu);
    fireEvent.keyDown(importMenu, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Import logs" })).toBeNull(),
    );

    const corpusTrigger = await screen.findByRole("button", {
      name: `More actions for ${item.name}`,
    });
    fireEvent.click(corpusTrigger);
    const corpusMenu = await screen.findByRole("menu", {
      name: `Actions for ${item.name}`,
    });
    fireEvent.pointerDown(corpusMenu);
    fireEvent.click(corpusMenu);
    expect(screen.getByRole("menu", { name: `Actions for ${item.name}` })).toBe(
      corpusMenu,
    );

    fireEvent.click(
      within(corpusMenu).getByRole("menuitem", {
        name: "Discard corpus…",
      }),
    );
    await waitFor(() => expect(hostMocks.confirm).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(hostMocks.discard).not.toHaveBeenCalled();
  });

  it("keeps Import and corpus overflow mutually exclusive as peer menus", async () => {
    const item = corpus("corpus-a", "API incident");
    hostMocks.listCorpora.mockResolvedValue([item]);

    render(<LogPane />);
    const corpusTrigger = await screen.findByRole("button", {
      name: `More actions for ${item.name}`,
    });
    const importTrigger = screen.getAllByRole("button", {
      name: "Import logs…",
    })[0]!;

    fireEvent.click(corpusTrigger);
    expect(
      await screen.findByRole("menu", {
        name: `Actions for ${item.name}`,
      }),
    ).toBeTruthy();
    fireEvent.click(importTrigger);
    const importMenu = await screen.findByRole("menu", {
      name: "Import logs",
    });
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(corpusTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(importTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(within(importMenu).getAllByRole("menuitem")[0]).toBe(
      document.activeElement,
    );

    fireEvent.click(corpusTrigger);
    const corpusMenu = await screen.findByRole("menu", {
      name: `Actions for ${item.name}`,
    });
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(importTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(corpusTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(within(corpusMenu).getAllByRole("menuitem")[0]).toBe(
      document.activeElement,
    );
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
      name: /Import ContextDesk package/i,
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

    fireEvent.click(primarySave);
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
    localStorage.setItem("cd-activity-inspector-mode", "compact");
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
    await chooseImportMode("Import a folder…");

    const available = await screen.findByRole("region", {
      name: "Failed import diagnostic",
    });
    expect(available.textContent).toContain("No corpus was published");
    expect(available.textContent).toContain("only in memory");
    expect(hostMocks.listCorpora).toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: corpusButtonName("incident") }),
    ).toBeNull();
    const failedActivity = screen.getByTestId("activity-import-summary");
    expect(failedActivity.getAttribute("data-outcome")).toBe("failed");
    expect(failedActivity.getAttribute("data-source-kind")).toBe("zip");

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
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy JSON" }));
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

  it("records a quick cancelled ZIP attempt as cancelled without publishing", async () => {
    localStorage.setItem("cd-activity-inspector-mode", "compact");
    hostMocks.confirm.mockResolvedValue(true);
    hostMocks.ingest.mockRejectedValue(new Error("ingest cancelled"));
    hostMocks.getFailedIngestDiagnostic
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        schemaVersion: 2,
        generatedAt: 1_753_680_000,
        sourceKind: "zip",
        reasonCode: "cancelled",
        summary: "Import cancelled before publication.",
        cancelled: true,
        progress: {
          lastPhase: "scan",
          linesProcessed: 0,
          filesProcessed: 0,
          bytesProcessed: 0,
          templates: 0,
          updatesSeen: 1,
        },
        evidence: {
          scanCounts: {
            binary: 0,
            empty: 0,
            hidden: 0,
            oversized: 0,
            readFailed: 0,
            parseFailed: 0,
          },
          transcript: [],
          omittedEntries: 0,
        },
        redacted: true,
      });

    render(<LogPane pickDirectory={async () => "/tmp/logs.zip"} />);
    await chooseImportMode("Import a folder…");

    const activitySummary = await screen.findByTestId(
      "activity-import-summary",
    );
    expect(activitySummary.getAttribute("data-outcome")).toBe("cancelled");
    expect(activitySummary.getAttribute("data-source-kind")).toBe("zip");
    expect(screen.queryByTestId("corpus-list")).toBeNull();
    expect(loadCorpusImportActivity("cancelled").events).toEqual([]);
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

    await chooseImportMode("Import a folder…");
    let available = await screen.findByRole("region", {
      name: "Failed import diagnostic",
    });
    expect(available.textContent).toContain("First failed attempt.");

    await chooseImportMode("Import a folder…");
    await waitFor(() => {
      available = screen.getByRole("region", {
        name: "Failed import diagnostic",
      });
      expect(available.textContent).toContain("Second failed attempt.");
      expect(available.textContent).not.toContain("First failed attempt.");
    });

    await chooseImportMode("Import a folder…");
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

  it("shows a bounded truthful source review after import without exposing the selected path or payload", async () => {
    hostMocks.confirm.mockResolvedValue(true);
    const importedCorpus = corpus("company-corpus", "Company import");
    const otherCorpus = corpus("other-corpus", "Previous import");
    hostMocks.listCorpora
      .mockResolvedValueOnce([])
      .mockResolvedValue([importedCorpus, otherCorpus]);
    hostMocks.ingest.mockResolvedValue({
      corpusId: "company-corpus",
      lines: 3,
      templates: 2,
      reductionRatio: 1.5,
      embedded: 0,
      files: 2,
      discoveredFiles: 2,
      excludedFiles: 0,
      failedFiles: 0,
      ignoredFiles: 0,
      exclusionCounts: {},
      exclusionExamples: [],
      partial: false,
      sourceBytes: 256,
      corpusBytes: 512,
      levelCounts: { info: 2, error: 1 },
      tsMin: 1,
      tsMax: 2,
      formatCounts: {
        "date-level-logger-thread-record": 2,
        json: 1,
      },
      topTemplates: [],
      confidence: {
        corpusTimeQuality: "mixed",
        counts: {
          wall: 1,
          orderOnly: 1,
          mixed: 0,
          matched: 2,
          ambiguous: 0,
          unknown: 0,
          unresolved: 1,
        },
        sources: [
          {
            source: "api/events.jsonl",
            lines: 1,
            formatId: "json",
            formatVersion: 1,
            outcome: "matched",
            runnerUpMargin: 100,
            producerHint: null,
            timeQuality: "wall",
            unresolvedReasons: [],
            timestampPrefixSamples: [],
          },
          {
            source: "app/server.log",
            lines: 2,
            formatId: "date-level-logger-thread-record",
            formatVersion: 1,
            outcome: "matched",
            runnerUpMargin: 30,
            producerHint: "wildfly-or-jboss-family",
            timeQuality: "order_only",
            unresolvedReasons: ["no_timezone"],
            timestampPrefixSamples: [
              "2021-03-05 02:53:53,654",
              "2021-03-05 02:53:54,101",
            ],
          },
        ],
      },
      embedding: {
        state: "keyword_only",
        modelId: null,
        embeddedTemplates: 0,
        totalTemplates: 2,
        reason: "embedding_not_requested",
        updatedAt: 1,
      },
    });

    render(
      <LogPane
        pickDirectory={async () =>
          "/Users/employee/private.internal/customer-incident"
        }
      />,
    );
    await screen.findByText(/No corpora yet/i);
    await chooseImportMode("Import a folder…");

    const confidence = await screen.findByTestId("log-import-confidence");
    expect(confidence.textContent).toContain(
      "1 exact wall-clock source · 1 source needs review",
    );
    expect(confidence.textContent).toContain(
      "ContextDesk did not guess a timezone",
    );
    expect(confidence.textContent).not.toContain("/Users/employee");
    expect(confidence.textContent).not.toContain("customer-incident");
    expect(confidence.textContent).not.toContain("Remote connection failed");

    const review = within(confidence).getByRole("button", {
      name: "Review 1 source",
    });
    expect(review.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(review);
    expect(review.getAttribute("aria-expanded")).toBe("true");
    expect(confidence.textContent).toContain("app/server.log");
    expect(confidence.textContent).toContain("No timezone — order-only");
    expect(confidence.textContent).toContain(
      "date-level-logger-thread-record v1 — margin 30",
    );
    expect(confidence.textContent).toContain(
      "Family hint: wildfly or jboss family (not verified)",
    );
    expect(
      within(confidence).getByLabelText("Timestamp examples for app/server.log")
        .textContent,
    ).toContain("2021-03-05 02:53:53,654");

    fireEvent.click(review);
    expect(
      within(confidence).queryByText("No timezone — order-only"),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: corpusButtonName(otherCorpus.name),
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("log-import-confidence")).toBeNull(),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: corpusButtonName(importedCorpus.name),
      }),
    );
    expect(await screen.findByTestId("log-import-confidence")).toBeTruthy();
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
      screen.getByRole("button", { name: /Import ContextDesk package/i }),
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
    localStorage.setItem(
      "contextdesk.importActivity.v1:corpus-a",
      "retained-on-cancel",
    );

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
    expect(
      localStorage.getItem("contextdesk.importActivity.v1:corpus-a"),
    ).toBe("retained-on-cancel");
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
    localStorage.setItem(
      "contextdesk.importActivity.v1:corpus-a",
      "discarded",
    );
    localStorage.setItem(
      "contextdesk.importActivity.v1:corpus-b",
      "retained",
    );

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
    expect(
      localStorage.getItem("contextdesk.importActivity.v1:corpus-a"),
    ).toBeNull();
    expect(
      localStorage.getItem("contextdesk.importActivity.v1:corpus-b"),
    ).toBe("retained");
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
    fireEvent.click(
      screen.getByRole("button", { name: "Import ContextDesk package…" }),
    );
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
    await waitFor(() =>
      expect(hostMocks.discard).toHaveBeenCalledWith(first.id),
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
    await waitFor(() =>
      expect(hostMocks.discard).toHaveBeenCalledWith(item.id),
    );

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
    fireEvent.click(
      screen.getByRole("button", { name: "Import ContextDesk package…" }),
    );
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
    fireEvent.click(
      screen.getByRole("button", { name: "Import ContextDesk package…" }),
    );
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
    expect(screen.queryByRole("button", { name: "Retry analysis" })).toBeNull();

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
      expect(hostMocks.reanalyze).toHaveBeenCalledWith(
        corpus.id,
        expect.stringMatching(/^reanalyze:/),
      );
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
      expect(hostMocks.reanalyze).toHaveBeenCalledWith(
        item.id,
        expect.stringMatching(/^reanalyze:/),
      ),
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
      expect(hostMocks.reanalyze).toHaveBeenCalledWith(
        first.id,
        expect.stringMatching(/^reanalyze:/),
      ),
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
    expect(hostMocks.setActiveCorpus.mock.calls.map(([id]) => id).at(-1)).toBe(
      second.id,
    );
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
    await waitFor(() => expect(hostMocks.reanalyze).toHaveBeenCalledOnce());
    const correlationId = hostMocks.reanalyze.mock.calls[0]?.[1];
    const publishProgress = hostMocks.listenProgress.mock.calls[0]?.[0];
    act(() => {
      publishProgress({
        operation_id: "host-reanalysis",
        correlation_id: correlationId,
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

  it("discloses omitted timezone rows after the real 64-entry process-local cap", async () => {
    const { saveActivityMode } = await import("../../lib/activity/prefs");
    const tz = await import("../../lib/activity/timezoneActivity");
    saveActivityMode("compact");

    // Seed the exact LogPane initial state: createTimezoneActivityLog() then
    // fill to the production TIMEZONE_ACTIVITY_CAP via recordTimezoneActivity
    // (same functions applyTimezone uses). One more apply via the real UI
    // path increments omitted and surfaces the merged ledger note.
    let seed = tz.createTimezoneActivityLog(tz.TIMEZONE_ACTIVITY_CAP);
    expect(tz.TIMEZONE_ACTIVITY_CAP).toBe(64);
    for (let i = 0; i < tz.TIMEZONE_ACTIVITY_CAP; i++) {
      seed = tz.recordTimezoneActivity(seed, {
        corpusId: "timezone-corpus",
        outcome: "applied",
        zone: "America/Chicago",
        sourceCount: 1,
      });
    }
    expect(seed.entries.length).toBe(64);
    expect(seed.omitted).toBe(0);

    const createSpy = vi
      .spyOn(tz, "createTimezoneActivityLog")
      .mockReturnValue(seed);

    const item = corpus("timezone-corpus", "Timezone review corpus");
    hostMocks.listCorpora.mockResolvedValue([item]);
    const unresolvedState = {
      corpusId: item.id,
      eventRevision: 4,
      declarations: {},
      sources: [
        {
          source: "app/server.log",
          unresolvedLocalRecords: 12,
          resolvedLocalRecords: 0,
          explicitWallClockRecords: 0,
          otherOrderOnlyRecords: 0,
        },
      ],
    };
    const resolvedState = {
      corpusId: item.id,
      eventRevision: 5,
      declarations: {
        "app/server.log": {
          source: "app/server.log",
          ianaZone: "America/Chicago",
          basis: "user_declared",
          declaredAt: 1_700_000_000,
          appliedRevision: 5,
        },
      },
      sources: [
        {
          source: "app/server.log",
          unresolvedLocalRecords: 0,
          resolvedLocalRecords: 12,
          explicitWallClockRecords: 0,
          otherOrderOnlyRecords: 0,
        },
      ],
    };
    let stateRead = 0;
    hostMocks.loadTimezoneState.mockImplementation(async () => {
      const states = [unresolvedState, resolvedState];
      return states[Math.min(stateRead++, states.length - 1)];
    });

    try {
      render(<LogPane />);
      fireEvent.click(
        await screen.findByRole("button", {
          name: corpusButtonName(item.name),
        }),
      );
      const status = await screen.findByTestId("log-timezone-status");
      fireEvent.click(
        within(status).getByRole("button", { name: "Review 1 source" }),
      );
      fireEvent.click(
        within(status).getByRole("button", { name: "Resolve time…" }),
      );
      const dialog = await screen.findByRole("dialog", {
        name: "Review timezone",
      });
      fireEvent.click(
        within(dialog).getByRole("radio", { name: /Use an IANA timezone/ }),
      );
      fireEvent.change(
        within(dialog).getByRole("combobox", { name: /^IANA timezone/ }),
        { target: { value: "America/Chicago" } },
      );
      fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
      expect(await screen.findByText("12 records resolved")).toBeTruthy();
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Apply declaration" }),
      );
      await waitFor(() => expect(hostMocks.applyTimezone).toHaveBeenCalled());

      // 65th event dropped oldest → omitted >= 1; LogPane merged ledger discloses it.
      await waitFor(() => {
        const region = screen.getByTestId("log-pane-activity");
        expect(region.textContent).toMatch(/Live trace/i);
      });
      // Expand the live-trace details if present
      const summary = screen.getByText(/Live trace/i);
      const details = summary.closest("details");
      if (details && !details.open) {
        fireEvent.click(summary);
      }
      await waitFor(() => {
        const note = screen.getByTestId("activity-omitted-note");
        expect(note.textContent).toMatch(/omitted/i);
        expect(note.textContent).toMatch(/64-entry retention bound/i);
        // At least one intermediate update omitted (the 65th push).
        expect(note.textContent).toMatch(/\d+ intermediate/);
      });
    } finally {
      createSpy.mockRestore();
    }
  });

  it("restores, applies, and clears revision-bound source timezone declarations", async () => {
    const { saveActivityMode } = await import("../../lib/activity/prefs");
    saveActivityMode("compact");
    const item = corpus("timezone-corpus", "Timezone review corpus");
    hostMocks.listCorpora.mockResolvedValue([item]);
    const unresolvedState = {
      corpusId: item.id,
      eventRevision: 4,
      declarations: {},
      sources: [
        {
          source: "app/server.log",
          unresolvedLocalRecords: 12,
          resolvedLocalRecords: 0,
          explicitWallClockRecords: 0,
          otherOrderOnlyRecords: 0,
        },
      ],
    };
    const resolvedState = {
      corpusId: item.id,
      eventRevision: 5,
      declarations: {
        "app/server.log": {
          source: "app/server.log",
          ianaZone: "America/Chicago",
          basis: "user_declared",
          declaredAt: 1_700_000_000,
          appliedRevision: 5,
        },
      },
      sources: [
        {
          source: "app/server.log",
          unresolvedLocalRecords: 0,
          resolvedLocalRecords: 12,
          explicitWallClockRecords: 0,
          otherOrderOnlyRecords: 0,
        },
      ],
    };
    let stateRead = 0;
    hostMocks.loadTimezoneState.mockImplementation(async () => {
      const states = [unresolvedState, resolvedState, unresolvedState];
      return states[Math.min(stateRead++, states.length - 1)];
    });

    render(<LogPane />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: corpusButtonName(item.name),
      }),
    );

    const status = await screen.findByTestId("log-timezone-status");
    expect(status.textContent).toContain("12 records remain order-only");
    fireEvent.click(
      within(status).getByRole("button", { name: "Review 1 source" }),
    );
    fireEvent.click(
      within(status).getByRole("button", { name: "Resolve time…" }),
    );

    let dialog = await screen.findByRole("dialog", {
      name: "Review timezone",
    });
    fireEvent.click(
      within(dialog).getByRole("radio", { name: /Use an IANA timezone/ }),
    );
    fireEvent.change(
      within(dialog).getByRole("combobox", { name: /^IANA timezone/ }),
      { target: { value: "America/Chicago" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    expect(await screen.findByText("12 records resolved")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Apply declaration" }),
    );

    await waitFor(() =>
      expect(hostMocks.applyTimezone).toHaveBeenCalledWith({
        corpusId: item.id,
        expectedRevision: 4,
        source: "app/server.log",
        ianaZone: "America/Chicago",
        previewToken: "timezone-preview",
      }),
    );
    // Real LogPane applyTimezone path → recordTimezoneActivity → live trace.
    await waitFor(() => {
      const region = screen.getByTestId("log-pane-activity");
      expect(region.textContent).toMatch(/Timezone applied/i);
    });

    const restored = await screen.findByTestId("log-timezone-status");
    expect(restored.textContent).toContain("America/Chicago is active");
    fireEvent.click(
      within(restored).getByRole("button", { name: "Review timezone…" }),
    );

    dialog = await screen.findByRole("dialog", { name: "Review timezone" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove declaration…" }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Remove and use order-only",
      }),
    );
    await waitFor(() =>
      expect(hostMocks.clearTimezone).toHaveBeenCalledWith({
        corpusId: item.id,
        expectedRevision: 5,
        source: "app/server.log",
        appliedRevision: 5,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("log-timezone-status").textContent).toContain(
        "12 records remain order-only",
      ),
    );
    expect(hostMocks.loadTimezoneState).toHaveBeenCalledTimes(3);
  });

  it("keeps the newly selected corpus time state when an older apply finishes late", async () => {
    const first = corpus("timezone-corpus", "First timezone corpus");
    const second = corpus("second-timezone-corpus", "Second timezone corpus");
    hostMocks.listCorpora.mockResolvedValue([first, second]);
    const secondState = deferred<{
      corpusId: string;
      eventRevision: number;
      declarations: Record<string, never>;
      sources: Array<{
        source: string;
        unresolvedLocalRecords: number;
        resolvedLocalRecords: number;
        explicitWallClockRecords: number;
        otherOrderOnlyRecords: number;
      }>;
    }>();
    hostMocks.loadTimezoneState.mockImplementation(async (corpusId: string) => {
      if (corpusId === second.id) return secondState.promise;
      return {
        corpusId,
        eventRevision: 4,
        declarations: {},
        sources: [
          {
            source: "app/server.log",
            unresolvedLocalRecords: 12,
            resolvedLocalRecords: 0,
            explicitWallClockRecords: 0,
            otherOrderOnlyRecords: 0,
          },
        ],
      };
    });
    const lateApply = deferred<{
      revision: number;
      previousRevision: number;
      changedEvents: number;
      eventCount: number;
      tsMin: number | null;
      tsMax: number | null;
    }>();
    hostMocks.applyTimezone.mockReturnValueOnce(lateApply.promise);

    render(<LogPane />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: corpusButtonName(first.name),
      }),
    );
    let status = await screen.findByTestId("log-timezone-status");
    fireEvent.click(
      within(status).getByRole("button", { name: "Review 1 source" }),
    );
    fireEvent.click(
      within(status).getByRole("button", { name: "Resolve time…" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Review timezone",
    });
    fireEvent.click(
      within(dialog).getByRole("radio", { name: /Use an IANA timezone/ }),
    );
    fireEvent.change(
      within(dialog).getByRole("combobox", { name: /^IANA timezone/ }),
      { target: { value: "America/Chicago" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    await screen.findByText("12 records resolved");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Apply declaration" }),
    );
    await waitFor(() => expect(hostMocks.applyTimezone).toHaveBeenCalled());

    fireEvent.click(
      screen.getByRole("button", { name: corpusButtonName(second.name) }),
    );
    expect(
      await screen.findByRole("heading", { name: second.name }),
    ).toBeTruthy();

    await act(async () => {
      lateApply.resolve({
        revision: 5,
        previousRevision: 4,
        changedEvents: 12,
        eventCount: 12,
        tsMin: 1_700_000_000,
        tsMax: 1_700_000_120,
      });
      await lateApply.promise;
    });
    await act(async () => {
      secondState.resolve({
        corpusId: second.id,
        eventRevision: 9,
        declarations: {},
        sources: [
          {
            source: "constructor",
            unresolvedLocalRecords: 3,
            resolvedLocalRecords: 0,
            explicitWallClockRecords: 0,
            otherOrderOnlyRecords: 0,
          },
        ],
      });
      await secondState.promise;
    });

    status = await screen.findByTestId("log-timezone-status");
    fireEvent.click(
      within(status).getByRole("button", { name: "Review 1 source" }),
    );
    expect(within(status).getByText("constructor")).toBeTruthy();
    expect(
      within(status).getByRole("button", { name: "Resolve time…" }),
    ).toBeTruthy();
    expect(within(status).queryByText(/is active/)).toBeNull();
    expect(
      hostMocks.loadTimezoneState.mock.calls.filter(
        ([corpusId]) => corpusId === first.id,
      ),
    ).toHaveLength(1);
  });
});

describe("in-app Explorer embed chrome (#851)", () => {
  async function enterEmbed() {
    hostMocks.listCorpora.mockResolvedValue([corpus("c-embed", "Embed corpus")]);
    render(<LogPane />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: corpusButtonName("Embed corpus"),
      }),
    );
    const open = (await screen.findByTestId(
      "open-log-explorer-in-app",
    )) as HTMLButtonElement;
    await waitFor(() => expect(open.disabled).toBe(false));
    fireEvent.click(open);
    await screen.findByTestId("log-pane-in-app-explorer");
  }

  it("opens with a bounded chrome row — reachable Close, no floating overlay", async () => {
    await enterEmbed();
    expect(screen.getByTestId("stub-log-explorer").textContent).toBe("c-embed");

    const chrome = screen.getByRole("group", {
      name: "In-app Explorer controls",
    });
    const close = within(chrome).getByRole("button", {
      name: "Close Explorer",
    });
    // In-flow chrome button: keyboard reachable, never absolutely floated
    // over the Explorer's own toolbar (the pre-repair inline-styled overlay).
    expect(close.getAttribute("style")).toBeNull();
    close.focus();
    expect(document.activeElement).toBe(close);

    fireEvent.click(close);
    await waitFor(() =>
      expect(screen.queryByTestId("log-pane-in-app-explorer")).toBeNull(),
    );
    expect(await screen.findByTestId("open-log-explorer-in-app")).toBeTruthy();
  });

  it("moves to a dedicated window on success and closes the embed", async () => {
    vi.mocked(hostOpenLogExplorer).mockResolvedValue(undefined as never);
    await enterEmbed();
    fireEvent.click(screen.getByTestId("embed-open-window"));
    await waitFor(() =>
      expect(screen.queryByTestId("log-pane-in-app-explorer")).toBeNull(),
    );
    expect(hostOpenLogExplorer).toHaveBeenCalledWith("c-embed");
    expect(screen.getByText("Opened Log Explorer window")).toBeTruthy();
  });

  it("stays in the fallback embed when the window open fails, and says why", async () => {
    vi.mocked(hostOpenLogExplorer).mockRejectedValue(new Error("no display"));
    await enterEmbed();
    fireEvent.click(screen.getByTestId("embed-open-window"));
    const note = await screen.findByTestId("embed-note");
    expect(note.getAttribute("role")).toBe("status");
    expect(note.textContent).toContain("Multi-window open failed");
    expect(screen.getByTestId("log-pane-in-app-explorer")).toBeTruthy();
    expect(screen.getByTestId("stub-log-explorer")).toBeTruthy();
  });
});

describe("LogPane reviewed-import progress ownership (defect: duplicated panel)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMemoryStorage();
    hostMocks.listCorpora.mockResolvedValue([]);
    hostMocks.listTemplates.mockResolvedValue([]);
    hostMocks.clusterProblems.mockResolvedValue([]);
    hostMocks.openDirectory.mockResolvedValue("/incidents/checkout-outage");
    hostMocks.getFailedIngestDiagnostic.mockResolvedValue(null);
    hostMocks.loadTimezoneState.mockImplementation(async (corpusId: string) => ({
      corpusId,
      eventRevision: 0,
      declarations: {},
      sources: [],
    }));
  });

  async function openReviewedImportToRunning() {
    localStorage.setItem("cd-activity-inspector-mode", "compact");
    let capturedProgressCallback:
      | ((progress: {
          operation_id?: string | null;
          correlation_id?: string | null;
          kind: string;
          phase: string;
          message: string;
          fraction: number | null;
          lines_processed: number | null;
          files_processed: number | null;
          bytes_processed: number | null;
          templates: number | null;
          cancellable: boolean;
        }) => void)
      | undefined;
    hostMocks.listenProgress.mockImplementation(async (callback) => {
      capturedProgressCallback = callback;
      return () => {};
    });
    engineMocks.client = createMockEngineClient({ manualFlush: true });
    const cancelSpy = vi.spyOn(engineMocks.client.import, "cancel");
    const runSpy = vi.spyOn(engineMocks.client.import, "run");

    render(<LogPane />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Import with review…" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose folder…" }),
    );
    await screen.findByText(/Looking at what/);
    await waitFor(() => engineMocks.client!.flush());
    await screen.findByRole("region", { name: "Ready to import" });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /I understand and want to proceed/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    // run() emits "starting"/"scan" synchronously, then parks (manualFlush) —
    // the preflight region is gone once the reducer sees RUN_STARTED.
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Ready to import" }),
      ).toBeNull(),
    );

    await waitFor(() =>
      expect(capturedProgressCallback).toBeTypeOf("function"),
    );
    const correlationId = runSpy.mock.calls[0]?.[0].correlationId;
    expect(correlationId).toMatch(/^import:/);
    // The host's process-progress stream is shared: the exact same event
    // LogPane's own listener receives for this reviewed import, regardless
    // of ImportFlow's separate engine-events subscription.
    act(() => {
      capturedProgressCallback!({
        operation_id: "host-reviewed-import",
        correlation_id: correlationId,
        kind: "log_ingest",
        phase: "starting",
        message: "starting reviewed import",
        fraction: null,
        lines_processed: null,
        files_processed: null,
        bytes_processed: 4096,
        templates: null,
        cancellable: true,
      });
      capturedProgressCallback!({
        operation_id: "host-reviewed-import",
        correlation_id: correlationId,
        kind: "log_ingest",
        phase: "stream",
        message: "parsing and templating lines",
        fraction: 0.5,
        lines_processed: 500,
        files_processed: 1,
        bytes_processed: 4096,
        templates: 2,
        cancellable: true,
      });
    });

    return {
      cancelSpy,
      correlationId,
      publishProgress: capturedProgressCallback!,
    };
  }

  /**
   * Same setup as `openReviewedImportToRunning`, but returns immediately
   * after `import.run` is invoked and its correlation id is known — before
   * the host's `verify_import_plan` re-verification would ever emit its
   * first `process-progress` event. (#900)
   */
  async function openReviewedImportBeforeFirstProgress() {
    localStorage.setItem("cd-activity-inspector-mode", "compact");
    hostMocks.listenProgress.mockImplementation(async () => () => {});
    engineMocks.client = createMockEngineClient({ manualFlush: true });
    const cancelSpy = vi.spyOn(engineMocks.client.import, "cancel");
    const runSpy = vi.spyOn(engineMocks.client.import, "run");

    render(<LogPane />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Import with review…" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose folder…" }),
    );
    await screen.findByText(/Looking at what/);
    await waitFor(() => engineMocks.client!.flush());
    await screen.findByRole("region", { name: "Ready to import" });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /I understand and want to proceed/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Ready to import" }),
      ).toBeNull(),
    );
    await waitFor(() => expect(runSpy).toHaveBeenCalledTimes(1));
    const correlationId = runSpy.mock.calls[0]?.[0].correlationId as string;
    expect(correlationId).toMatch(/^import:/);

    return { cancelSpy, runSpy, correlationId };
  }

  it("shows a single pending progress panel and invocation-scoped Cancel before the host's first progress event (#900)", async () => {
    const { correlationId } = await openReviewedImportBeforeFirstProgress();

    // No `process-progress` event has been observed yet — `verify_import_plan`
    // re-verifies the plan synchronously before `run_log_ingest` emits
    // anything. The single owning panel must already exist, not appear only
    // once the first event lands.
    expect(document.querySelectorAll(".process-progress")).toHaveLength(1);
    const cancelButtons = screen.getAllByRole("button", {
      name: "Cancel ingest",
    });
    expect(cancelButtons).toHaveLength(1);
    expect((cancelButtons[0] as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(cancelButtons[0]!);
    await waitFor(() =>
      expect(hostMocks.cancelIngest).toHaveBeenCalledTimes(1),
    );
    // Scoped to this invocation's own correlation id, not a bare global
    // cancel that could hit an unrelated import.
    expect(hostMocks.cancelIngest).toHaveBeenCalledWith(correlationId);
  });

  it("cancelling before the first progress event publishes no corpus and leaves exactly one panel/cancel control", async () => {
    await openReviewedImportBeforeFirstProgress();
    hostMocks.cancelIngest.mockImplementationOnce(() =>
      engineMocks.client!.import.cancel(),
    );

    expect(document.querySelectorAll(".process-progress")).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel ingest" }),
    );
    await waitFor(() => expect(hostMocks.cancelIngest).toHaveBeenCalledOnce());
    await act(async () => {
      engineMocks.client!.flush();
    });

    expect(
      await screen.findByText(/Import cancelled\. Nothing was published/i),
    ).toBeTruthy();
    // Exactly one panel and one (now-disabled) cancel control remain — no
    // duplicate, no orphaned second element.
    expect(document.querySelectorAll(".process-progress")).toHaveLength(1);
    expect(
      screen.getAllByTestId("cancel-log-ingest"),
    ).toHaveLength(1);
    expect(loadCorpusImportActivity("mock-corpus-0001").events).toEqual([]);
    expect(
      localStorage.getItem("contextdesk.importActivity.v1:mock-corpus-0001"),
    ).toBeNull();
  });

  it("shows exactly one progress panel for a reviewed import in flight", async () => {
    await openReviewedImportToRunning();
    expect(document.querySelectorAll(".process-progress")).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "Cancel ingest" }),
    ).toHaveLength(1);
    const activity = screen.getByTestId("log-pane-activity");
    expect(activity.textContent).toContain("Import started");
    expect(activity.textContent).toContain(
      "Reading, parsing, normalizing, and indexing",
    );
    expect(activity.textContent).toContain("500 events");
    expect(activity.textContent).toContain("1 file");
    // The normal progress panel may show the host's prose; persisted Activity
    // is intentionally built from typed counters and phases only.
    expect(activity.textContent).not.toContain("parsing and templating lines");

    engineMocks.client!.flush();
    await screen.findByRole("region", { name: "Import finished" });
    await waitFor(() =>
      expect(loadCorpusImportActivity("mock-corpus-0001").events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: "Corpus published — Explorer can refresh" }),
        ]),
      ),
    );
  });

  it("ignores interleaved progress owned by a different invocation", async () => {
    const { publishProgress } = await openReviewedImportToRunning();
    const activity = screen.getByTestId("log-pane-activity");
    const before = activity.textContent;

    act(() => {
      publishProgress({
        operation_id: "host-foreign-reanalysis",
        correlation_id: "reanalyze:foreign-corpus",
        kind: "log_ingest",
        phase: "completed",
        message: "foreign operation completed",
        fraction: 1,
        lines_processed: 999_999,
        files_processed: 999,
        bytes_processed: 999_999,
        templates: 999,
        cancellable: false,
      });
    });

    expect(document.querySelectorAll(".process-progress")).toHaveLength(1);
    expect(activity.textContent).toBe(before);
    expect(activity.textContent).not.toContain("999,999");
    expect(activity.textContent).not.toContain("foreign operation");
  });

  it("wires cancellation to the single owning panel — LogPane's, not a duplicate", async () => {
    const { cancelSpy } = await openReviewedImportToRunning();

    fireEvent.click(screen.getByRole("button", { name: "Cancel ingest" }));
    await waitFor(() =>
      expect(hostMocks.cancelIngest).toHaveBeenCalledTimes(1),
    );
    // No second, orphaned cancel path through ImportFlow's own (now absent)
    // panel — it never called the engine client's cancel directly.
    expect(cancelSpy).not.toHaveBeenCalled();

    // Let the parked mock run settle so nothing is left dangling; the point
    // above (single command, single caller) already stands either way.
    engineMocks.client!.flush();
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Import finished" }),
      ).not.toBeNull(),
    );
  });

  it("records a real reviewed cancellation without publishing a corpus Activity bridge", async () => {
    const { cancelSpy } = await openReviewedImportToRunning();
    hostMocks.cancelIngest.mockImplementationOnce(() =>
      engineMocks.client!.import.cancel(),
    );

    expect(document.querySelectorAll(".process-progress")).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: "Cancel ingest" }),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel ingest" }));
    await waitFor(() => expect(cancelSpy).toHaveBeenCalledOnce());
    await act(async () => {
      engineMocks.client!.flush();
    });

    expect(
      await screen.findByText(/Import cancelled\. Nothing was published/i),
    ).toBeTruthy();
    expect(screen.getByTestId("log-pane-activity").textContent).toContain(
      "Import cancelled — nothing published",
    );
    expect(loadCorpusImportActivity("mock-corpus-0001").events).toEqual([]);
    expect(
      localStorage.getItem(
        "contextdesk.importActivity.v1:mock-corpus-0001",
      ),
    ).toBeNull();
  });
});

describe("LogPane time-revision refresh signalling (#875)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hostMocks.listCorpora.mockResolvedValue([]);
    hostMocks.listTemplates.mockResolvedValue([]);
    hostMocks.clusterProblems.mockResolvedValue([]);
    hostMocks.openDirectory.mockResolvedValue("/incidents/checkout-outage");
    hostMocks.listenProgress.mockResolvedValue(() => {});
    hostMocks.getFailedIngestDiagnostic.mockResolvedValue(null);
    hostMocks.loadTimezoneState.mockImplementation(async (corpusId: string) => ({
      corpusId,
      eventRevision: 0,
      declarations: {},
      sources: [],
    }));
  });

  it("broadcasts once per apply and once per undo, and never re-runs the import", async () => {
    engineMocks.client = createMockEngineClient();
    const runSpy = vi.spyOn(engineMocks.client.import, "run");

    render(<LogPane />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Import with review…" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose folder…" }),
    );
    await screen.findByRole("region", { name: "Ready to import" });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /I understand and want to proceed/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByRole("region", { name: "Import finished" });
    expect(runSpy).toHaveBeenCalledTimes(1);

    const applyButton = await screen.findByRole("button", {
      name: /Apply to 2 sources/,
    });

    // TimeReviewCard's auto-preview is debounced; fake timers only while
    // driving that (no findBy/waitFor in this window — those poll on real
    // timers and would hang under vi.useFakeTimers()).
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByLabelText("IANA timezone"), {
        target: { value: "America/Chicago" },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await act(async () => {
        fireEvent.click(applyButton);
        await vi.advanceTimersByTimeAsync(10);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(screen.getByText("America/Chicago · 2 sources")).toBeTruthy();
    expect(revisionBridgeMocks.broadcast).toHaveBeenCalledTimes(1);
    expect(revisionBridgeMocks.broadcast).toHaveBeenLastCalledWith(
      "mock-corpus-0001",
    );
    // Applying reviewed timezones must never itself re-import the corpus.
    expect(runSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Undo / return to order-only" }),
    );
    await waitFor(() =>
      expect(revisionBridgeMocks.broadcast).toHaveBeenCalledTimes(2),
    );
    expect(revisionBridgeMocks.broadcast).toHaveBeenLastCalledWith(
      "mock-corpus-0001",
    );
    // Nor does undo — same read-only-refresh contract.
    expect(runSpy).toHaveBeenCalledTimes(1);
  });
});
