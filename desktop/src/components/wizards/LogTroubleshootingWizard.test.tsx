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
  discoveredFiles: 3,
  excludedFiles: 0,
  failedFiles: 0,
  ignoredFiles: 0,
  exclusionCounts: {},
  exclusionExamples: [],
  partial: false,
  sourceBytes: 2_048,
  corpusBytes: 1_024,
  levelCounts: { error: 20, warn: 5, info: 1_175 },
  tsMin: 1_700_000_000,
  tsMax: 1_700_000_300,
  formatCounts: { json: 1_200 },
  confidence: {
    corpusTimeQuality: "wall",
    counts: {
      wall: 1,
      orderOnly: 0,
      mixed: 0,
      matched: 1,
      ambiguous: 0,
      unknown: 0,
      unresolved: 0,
    },
    sources: [
      {
        source: "api/events.jsonl",
        lines: 1_200,
        formatId: "json",
        formatVersion: 1,
        outcome: "matched",
        runnerUpMargin: 100,
        producerHint: null,
        timeQuality: "wall",
        unresolvedReasons: [],
        timestampPrefixSamples: [],
      },
    ],
  },
  embedding: {
    state: "partial",
    modelId: "local-onnx-default",
    embeddedTemplates: 8,
    totalTemplates: 12,
    reason: "template_cap_or_backend_failure",
    updatedAt: 1_700_000_301,
  },
  phaseTimings: {
    discoverReadMs: 12,
    parseFrameMs: 340,
    templateAnalysisMs: 890,
    persistIndexMs: 410,
    optionalEmbeddingMs: 55,
    validationMs: 8,
    publicationMs: 4,
    totalMs: 1_720,
    embeddingDeferred: false,
  },
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

async function reachConfirmationForRaw(
  mode: "corpus" | "session_context" | "both" = "corpus",
) {
  await reachSourceStep();
  fireEvent.click(screen.getByRole("button", { name: "Choose directory…" }));
  await screen.findByText("incident-logs");
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: "How to use logs" });
  if (mode === "session_context") {
    fireEvent.click(
      screen.getByRole("radio", { name: /Session context only/ }),
    );
  } else if (mode === "both") {
    const both = screen.getByRole("radio", { name: /Both/ });
    fireEvent.click(both);
    expect(both.closest("label")?.textContent).toContain(
      "limited to 200 files / 50 MiB",
    );
  }
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

function expectRichStatsHero(options?: { requirePhaseTimings?: boolean }) {
  const hero = screen.getByTestId("wizard-ingest-stats");
  expect(within(hero).getByText("1,200")).toBeTruthy();
  expect(within(hero).getByText("12")).toBeTruthy();
  expect(within(hero).getByText("100 avg. events/template")).toBeTruthy();
  expect(within(hero).getAllByText("3")).toHaveLength(2);
  expect(within(hero).getByText("2.0 KB")).toBeTruthy();
  expect(within(hero).getByText("1.0 KB")).toBeTruthy();
  expect(within(hero).getByText("8")).toBeTruthy();
  expect(within(hero).getByText("Semantic · partial")).toBeTruthy();
  expect(within(hero).getByText("error 20")).toBeTruthy();
  expect(within(hero).getByText("warn 5")).toBeTruthy();
  expect(
    within(hero).getByText("connection refused to upstream <*>"),
  ).toBeTruthy();
  // SoftWrite raw ingest carries phaseTimings; package reload from corpus
  // summary does not persist operation timings (#824).
  if (options?.requirePhaseTimings) {
    const phases = within(hero).getByTestId("wizard-ingest-phase-timings");
    expect(within(phases).getByText("Template analysis")).toBeTruthy();
    expect(within(phases).getByText("890 ms")).toBeTruthy();
    expect(within(phases).getByText("1,720 ms")).toBeTruthy();
    expect(within(phases).getByText("Discover / read")).toBeTruthy();
    expect(within(phases).getByText("Parse / frame")).toBeTruthy();
    expect(within(phases).getByText("Persist / index")).toBeTruthy();
    expect(within(phases).getByText("Optional embedding")).toBeTruthy();
    expect(within(phases).getByText("Validation")).toBeTruthy();
    expect(within(phases).getByText("Publication")).toBeTruthy();
  }
}

function expectExactImportConfidence() {
  const confidence = screen.getByTestId("log-import-confidence");
  expect(confidence.textContent).toContain(
    "1 exact wall-clock source · all source formats matched",
  );
  expect(within(confidence).queryByRole("button", { name: /Review/ })).toBeNull();
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
    expect(hostMocks.importSessionContext).not.toHaveBeenCalled();
    expect(await screen.findByText(/Import finished/)).toBeTruthy();
    expectRichStatsHero({ requirePhaseTimings: true });
    expectExactImportConfidence();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Help: Events per template",
      }),
    );
    const groupingHelp = await screen.findByRole("dialog", {
      name: "Events per template",
    });
    expect(groupingHelp.textContent).toContain(
      "structurally similar—not necessarily identical—events",
    );
    expect(groupingHelp.textContent).toContain(
      "Every original redacted event remains",
    );
    fireEvent.click(
      within(groupingHelp).getByRole("button", { name: "Close help" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Ready" });
    expect(screen.getByText("local-corpus-raw-123")).toBeTruthy();
    expectRichStatsHero({ requirePhaseTimings: true });
    expectExactImportConfidence();

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    const outcome = onComplete.mock.calls[0][0];
    expect(outcome.corpusId).toBe("local-corpus-raw-123");
    expect(outcome.composerSeed).toContain(
      'corpus="local-corpus-raw-123"',
    );
    expect(outcome.composerSeed).toContain(
      "1,200 events grouped into 12 learned templates · 100 avg. events/template",
    );
  });

  it("keeps a successful corpus when Both mode skips an oversized chat pack", async () => {
    hostMocks.ingestPath.mockResolvedValue(richReport);
    hostMocks.importSessionContext.mockRejectedValue(
      new Error(
        "policy denied: session context max_files (200) at /Users/example/private-token.log",
      ),
    );
    const { onComplete } = renderWizard();

    await reachConfirmationForRaw("both");
    await acceptSoftWriteAndWaitForRun(hostMocks.ingestPath);

    await waitFor(() =>
      expect(hostMocks.importSessionContext).toHaveBeenCalledWith(
        "session-product-path",
        "/tmp/incident-logs",
      ),
    );
    expect(await screen.findByText(/Import finished/)).toBeTruthy();
    const warning = screen.getByText(/Analysis corpus ready. Chat pack skipped/);
    expect(warning.textContent).toContain("200-file or 50 MiB safety limit");
    expect(warning.textContent).not.toContain("/Users/example");
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Ready" });
    expect(
      screen.getByText(/Analysis corpus ready. Chat pack skipped/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    const outcome = onComplete.mock.calls[0][0];
    expect(outcome.corpusId).toBe("local-corpus-raw-123");
    expect(outcome.composerSeed).toContain(
      'corpus="local-corpus-raw-123"',
    );
  });

  it("keeps a session-context-only attachment failure fatal and safe", async () => {
    hostMocks.importSessionContext.mockRejectedValue(
      new Error("EISDIR: /Users/example/private-token.log is a directory"),
    );
    const { onComplete } = renderWizard();

    await reachConfirmationForRaw("session_context");
    await acceptSoftWriteAndWaitForRun(hostMocks.importSessionContext);

    expect(hostMocks.ingestPath).not.toHaveBeenCalled();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "A directory cannot be attached as one session chat-pack file",
    );
    expect(alert.textContent).not.toContain("/Users/example");
    expect(screen.queryByText(/Import finished/)).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("renders an honest partial-ingest result with bounded exclusion reasons", async () => {
    hostMocks.ingestPath.mockResolvedValue({
      ...richReport,
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
    } satisfies LogIngestReportDto);
    renderWizard();

    await reachConfirmationForRaw();
    await acceptSoftWriteAndWaitForRun(hostMocks.ingestPath);

    const hero = await screen.findByTestId("wizard-ingest-stats");
    expect(hero.textContent).toContain("1/5 files imported");
    expect(hero.textContent).toContain(
      "partial: 2 excluded, 1 failed, 1 ignored",
    );
    const partial = within(hero).getByTestId("ingest-partial");
    expect(partial.textContent).toContain("not a complete copy");
    expect(within(partial).getByText("binary: binary.log")).toBeTruthy();
    expect(within(partial).getByText("too_large: oversized.log")).toBeTruthy();
    expect(within(partial).getByText("open_failed: unreadable.log")).toBeTruthy();
    expect(within(partial).getByText("hidden: .ignored.log")).toBeTruthy();
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
        discoveredFiles: richReport.discoveredFiles,
        excludedFiles: richReport.excludedFiles,
        failedFiles: richReport.failedFiles,
        ignoredFiles: richReport.ignoredFiles,
        exclusionCounts: richReport.exclusionCounts,
        exclusionExamples: richReport.exclusionExamples,
        partial: richReport.partial,
        sourceBytes: richReport.sourceBytes,
        corpusBytes: richReport.corpusBytes,
        levelCounts: richReport.levelCounts,
        tsMin: richReport.tsMin,
        tsMax: richReport.tsMax,
        formatCounts: richReport.formatCounts,
      },
      topTemplates: richReport.topTemplates,
      embedding: richReport.embedding,
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

  it("shows a readable classified rejection instead of [object Object]", async () => {
    hostMocks.ingestPath.mockRejectedValue({
      message: "zip open: missing end record [member=bundles/inner.zip]",
      outcome: { class: "rejected", published: false },
    });
    renderWizard();
    await reachConfirmationForRaw();
    await acceptSoftWriteAndWaitForRun(hostMocks.ingestPath);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Import rejected: zip open: missing end record",
    );
    expect(alert.textContent).not.toContain("[object Object]");
    expect(alert.textContent).not.toContain("[member=");
    expect(screen.queryByText("Import finished")).toBeNull();
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
