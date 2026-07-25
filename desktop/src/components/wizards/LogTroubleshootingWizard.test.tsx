import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LogCorpusSummaryDto,
  LogIngestReportDto,
} from "../../lib/host";
import { LogTroubleshootingWizard } from "./LogTroubleshootingWizard";

const hostMocks = vi.hoisted(() => ({
  getCorpus: vi.fn(),
  importPackage: vi.fn(),
  ingestPath: vi.fn(),
  listenProgress: vi.fn(),
  importSessionContext: vi.fn(),
  setActiveCorpus: vi.fn(),
}));

const dialogMocks = vi.hoisted(() => ({
  openDirectory: vi.fn(),
  openFile: vi.fn(),
}));

vi.mock("../../lib/host", () => ({
  hostGetLogCorpus: hostMocks.getCorpus,
  hostImportLogCorpusPackagePath: hostMocks.importPackage,
  hostIngestLogPath: hostMocks.ingestPath,
  hostListenProcessProgress: hostMocks.listenProgress,
  hostSessionContextImportPath: hostMocks.importSessionContext,
  hostSetActiveLogCorpus: hostMocks.setActiveCorpus,
}));

vi.mock("../../lib/dialogs", () => ({
  openDirectoryDialog: dialogMocks.openDirectory,
  openFileDialog: dialogMocks.openFile,
}));

const richReport: LogIngestReportDto = {
  corpusId: "local-corpus-raw-123",
  lines: 1_200,
  templates: 12,
  reductionRatio: 100,
  embedded: 8,
  files: 3,
  sourceBytes: 2_048,
  corpusBytes: 1_024,
  levelCounts: { error: 20, warn: 5, info: 1_175 },
  tsMin: 1_700_000_000,
  tsMax: 1_700_000_300,
  formatCounts: { json: 1_200 },
  topTemplates: [
    {
      id: 7,
      pattern: "connection refused to upstream <*>",
      count: 20,
      severity: 5,
    },
  ],
};

function renderWizard() {
  const onComplete = vi.fn();
  render(
    <LogTroubleshootingWizard
      sessionId="session-product-path"
      onComplete={onComplete}
      onCancel={vi.fn()}
    />,
  );
  return { onComplete };
}

async function reachSourceStep() {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: "Choose source" });
}

async function reachConfirmationForRaw() {
  await reachSourceStep();
  fireEvent.click(screen.getByRole("button", { name: "Choose directory…" }));
  await screen.findByText("incident-logs");
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: "How to use logs" });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: "Confirm SoftWrite" });
}

async function reachConfirmationForPackage() {
  await reachSourceStep();
  fireEvent.click(screen.getByTestId("wizard-import-package"));
  await screen.findByText("peer-analysis.cdlog.zip");
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: "How to use logs" });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: "Confirm SoftWrite" });
}

async function acceptSoftWriteAndWaitForRun(
  expectedHostCall: ReturnType<typeof vi.fn>,
) {
  const continueButton = screen.getByRole("button", {
    name: "Continue",
  }) as HTMLButtonElement;
  expect(continueButton.disabled).toBe(true);
  fireEvent.click(continueButton);
  expect(expectedHostCall).not.toHaveBeenCalled();

  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /I understand and want to proceed/,
    }),
  );
  expect(continueButton.disabled).toBe(false);
  fireEvent.click(continueButton);
  await waitFor(() => expect(expectedHostCall).toHaveBeenCalledTimes(1));
}

function expectRichStatsHero() {
  const hero = screen.getByTestId("wizard-ingest-stats");
  expect(within(hero).getByText("1,200")).toBeTruthy();
  expect(within(hero).getByText("12")).toBeTruthy();
  expect(within(hero).getByText("100.0×")).toBeTruthy();
  expect(within(hero).getByText("3")).toBeTruthy();
  expect(within(hero).getByText("2.0 KB")).toBeTruthy();
  expect(within(hero).getByText("1.0 KB")).toBeTruthy();
  expect(within(hero).getByText("8")).toBeTruthy();
  expect(within(hero).getByText("error 20")).toBeTruthy();
  expect(within(hero).getByText("warn 5")).toBeTruthy();
  expect(
    within(hero).getByText("connection refused to upstream <*>"),
  ).toBeTruthy();
}

beforeEach(() => {
  vi.clearAllMocks();
  hostMocks.listenProgress.mockResolvedValue(() => {});
  hostMocks.setActiveCorpus.mockResolvedValue(null);
  hostMocks.importSessionContext.mockResolvedValue(null);
  dialogMocks.openDirectory.mockResolvedValue("/tmp/incident-logs");
  dialogMocks.openFile.mockResolvedValue("/tmp/peer-analysis.cdlog.zip");
});

afterEach(() => {
  cleanup();
});

describe("LogTroubleshootingWizard product path", () => {
  it("requires SoftWrite, renders rich raw-ingest stats on run and ready, and seeds the real corpus", async () => {
    hostMocks.ingestPath.mockResolvedValue(richReport);
    const { onComplete } = renderWizard();

    await reachConfirmationForRaw();
    expect(hostMocks.ingestPath).not.toHaveBeenCalled();
    await acceptSoftWriteAndWaitForRun(hostMocks.ingestPath);

    expect(hostMocks.ingestPath).toHaveBeenCalledWith(
      "/tmp/incident-logs",
      "incident",
    );
    expect(hostMocks.setActiveCorpus).toHaveBeenCalledWith(
      "local-corpus-raw-123",
    );
    expect(await screen.findByText(/Import finished/)).toBeTruthy();
    expectRichStatsHero();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Ready" });
    expect(screen.getByText("local-corpus-raw-123")).toBeTruthy();
    expectRichStatsHero();

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    const outcome = onComplete.mock.calls[0][0];
    expect(outcome.corpusId).toBe("local-corpus-raw-123");
    expect(outcome.composerSeed).toContain(
      'corpus="local-corpus-raw-123"',
    );
    expect(outcome.composerSeed).toContain(
      "1,200 lines → 12 templates (100.0× reduction)",
    );
  });

  it("imports a package only after confirmation and renders reloaded persisted stats under the new local id", async () => {
    hostMocks.importPackage.mockResolvedValue({
      corpusId: "local-import-456",
      name: "Imported incident",
      originCorpusId: "peer-origin-999",
    });
    const persisted: LogCorpusSummaryDto = {
      id: "local-import-456",
      name: "Imported incident",
      eventCount: 1_200,
      templateCount: 12,
      engine: "duckdb",
      createdAt: 1_700_000_000,
      sourceLabel: "import:peer-origin-999",
      stats: {
        files: richReport.files,
        lines: richReport.lines,
        templates: richReport.templates,
        reductionRatio: richReport.reductionRatio,
        embedded: richReport.embedded,
        sourceBytes: richReport.sourceBytes,
        corpusBytes: richReport.corpusBytes,
        levelCounts: richReport.levelCounts,
        tsMin: richReport.tsMin,
        tsMax: richReport.tsMax,
        formatCounts: richReport.formatCounts,
      },
      topTemplates: richReport.topTemplates,
    };
    hostMocks.getCorpus.mockResolvedValue(persisted);
    const { onComplete } = renderWizard();

    await reachConfirmationForPackage();
    expect(hostMocks.importPackage).not.toHaveBeenCalled();
    await acceptSoftWriteAndWaitForRun(hostMocks.importPackage);

    expect(hostMocks.importPackage).toHaveBeenCalledWith(
      "/tmp/peer-analysis.cdlog.zip",
    );
    expect(hostMocks.setActiveCorpus).toHaveBeenCalledWith("local-import-456");
    expect(hostMocks.getCorpus).toHaveBeenCalledWith("local-import-456");
    expect(await screen.findByText(/Import finished/)).toBeTruthy();
    expectRichStatsHero();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Ready" });
    expect(screen.getByText("local-import-456")).toBeTruthy();
    expectRichStatsHero();

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    const outcome = onComplete.mock.calls[0][0];
    expect(outcome.corpusId).toBe("local-import-456");
    expect(outcome.composerSeed).toContain('corpus="local-import-456"');
    expect(outcome.composerSeed).not.toContain("peer-origin-999");
    expect(outcome.composerSeed).not.toContain("peer-analysis.cdlog.zip");
  });

  it("imports a legacy package without fabricating missing statistics", async () => {
    hostMocks.importPackage.mockResolvedValue({
      corpusId: "local-legacy-789",
      name: "Legacy incident",
      originCorpusId: "legacy-origin",
    });
    hostMocks.getCorpus.mockResolvedValue({
      id: "local-legacy-789",
      name: "Legacy incident",
      eventCount: 42,
      templateCount: 0,
      engine: "duckdb",
      createdAt: 1_600_000_000,
      sourceLabel: null,
      stats: null,
      topTemplates: [],
    } satisfies LogCorpusSummaryDto);
    const { onComplete } = renderWizard();

    await reachConfirmationForPackage();
    await acceptSoftWriteAndWaitForRun(hostMocks.importPackage);
    expect(await screen.findByText(/Import finished/)).toBeTruthy();
    expect(screen.queryByTestId("wizard-ingest-stats")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Ready" });
    expect(screen.getByText("local-legacy-789")).toBeTruthy();
    expect(screen.queryByTestId("wizard-ingest-stats")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    const outcome = onComplete.mock.calls[0][0];
    expect(outcome.corpusId).toBe("local-legacy-789");
    expect(outcome.composerSeed).toContain('corpus="local-legacy-789"');
    expect(outcome.composerSeed).not.toContain("Ingest summary:");
    expect(outcome.composerSeed).not.toContain("42 lines");
  });

  it.each([
    "unsupported package format contextdesk.log_corpus.v99; upgrade ContextDesk",
    "package payload hash mismatch",
    "package import failed while opening the archive",
  ])(
    "keeps package failure visible and never completes: %s",
    async (message) => {
      hostMocks.importPackage.mockRejectedValue(new Error(message));
      const { onComplete } = renderWizard();

      await reachConfirmationForPackage();
      await acceptSoftWriteAndWaitForRun(hostMocks.importPackage);

      expect((await screen.findByRole("alert")).textContent).toContain(message);
      expect(screen.queryByText(/Import finished/)).toBeNull();
      expect(onComplete).not.toHaveBeenCalled();
      expect(hostMocks.setActiveCorpus).not.toHaveBeenCalled();
      expect(hostMocks.getCorpus).not.toHaveBeenCalled();
    },
  );
});
