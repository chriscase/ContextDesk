import { describe, expect, it } from "vitest";
import type { ProcessProgressDto } from "../../components/wizards/types";
import type { ImportRunInput } from "./types";
import {
  beginImportActivityAttempt,
  recordImportProgress,
  settleImportActivityAttempt,
} from "./importProgressActivity";

const progress = (
  phase: ProcessProgressDto["phase"],
  overrides: Partial<ProcessProgressDto> = {},
): ProcessProgressDto => ({
  operation_id: "host-test-operation",
  correlation_id: "import:test",
  kind: "log_ingest",
  phase,
  message: "host message deliberately ignored",
  fraction: null,
  lines_processed: null,
  files_processed: null,
  bytes_processed: null,
  templates: null,
  cancellable: phase !== "publish",
  elapsed_ms: null,
  phase_elapsed_ms: null,
  ...overrides,
});

const completedRun = (): ImportRunInput => ({
  startedAtMs: 1_000,
  endedAtMs: 2_000,
  outcome: "completed",
  sourceKind: "zip",
  report: {
    corpusId: "corpus-a",
    lines: 12_345,
    templates: 42,
    reductionRatio: 2,
    embedded: 0,
    files: 7,
    discoveredFiles: 8,
    excludedFiles: 1,
    failedFiles: 0,
    ignoredFiles: 0,
    exclusionCounts: { unsupported: 1 },
    exclusionExamples: ["private-name.xml"],
    partial: false,
    sourceBytes: 10_000,
    corpusBytes: 5_000,
    tsMin: null,
    tsMax: null,
    formatCounts: { generic: 7 },
    embedding: { state: "keyword_only", modelId: null },
  },
});

describe("live import Activity projection", () => {
  it("rejects foreign and identifier-free global progress", () => {
    const attempt = beginImportActivityAttempt("import:owned", "zip");
    const foreign = recordImportProgress(
      attempt,
      progress("starting", {
        correlation_id: "reanalyze:foreign",
        operation_id: "host-foreign",
      }),
    );
    const missing = recordImportProgress(
      attempt,
      progress("starting", {
        correlation_id: null,
        operation_id: null,
      }),
    );

    expect(foreign).toBe(attempt);
    expect(missing).toBe(attempt);
    expect(attempt.hostOperationId).toBeNull();
    expect(attempt.events).toHaveLength(1);
  });

  it("coalesces and bounds ten thousand hostile updates with disclosure", () => {
    let attempt = beginImportActivityAttempt("import:flood", "directory");
    attempt = recordImportProgress(
      attempt,
      progress("starting", { correlation_id: "import:flood", elapsed_ms: 0 }),
    );
    for (let index = 0; index < 10_000; index += 1) {
      attempt = recordImportProgress(
        attempt,
        progress(index % 2 === 0 ? "scan" : "stream", {
          correlation_id: "import:flood",
          elapsed_ms: index + 1,
          lines_processed: index,
        }),
      );
    }

    expect(attempt.events).toHaveLength(16);
    expect(attempt.events[0]?.label).toBe("Import started");
    expect(attempt.events.at(-1)?.detail).toContain("9,999 events");
    expect(attempt.omittedUpdates).toBe(9_985);
    expect(attempt.nextSequence).toBe(10_002);
  });

  it("keeps one start row when the host enriches the invocation observation", () => {
    let attempt = beginImportActivityAttempt("import:start", "zip");
    attempt = recordImportProgress(
      attempt,
      progress("starting", { correlation_id: "import:start" }),
    );
    attempt = recordImportProgress(
      attempt,
      progress("starting", {
        correlation_id: "import:start",
        elapsed_ms: 0,
      }),
    );

    expect(attempt.events).toHaveLength(1);
    expect(attempt.events[0]).toMatchObject({
      label: "Import started",
      origin: "user_decision",
      clock: { kind: "elapsed", elapsedMs: 0 },
    });
  });

  it("preserves causal host order and measured elapsed clocks", () => {
    let attempt = beginImportActivityAttempt("import:one", "zip");
    for (const [phase, elapsedMs] of [
      ["starting", 0],
      ["scan", 8],
      ["stream", 21],
      ["validate", 34],
      ["publish", 55],
      ["completed", 89],
    ] as const) {
      attempt = recordImportProgress(
        attempt,
        progress(phase, {
          correlation_id: "import:one",
          elapsed_ms: elapsedMs,
        }),
      );
    }
    const events = settleImportActivityAttempt(attempt, completedRun()).events;

    expect(events.map((event) => event.label)).toEqual([
      "Import started",
      "Archive discovery and source scan",
      "Reading, parsing, normalizing, and indexing",
      "Safety limits and staged corpus validation",
      "Publishing corpus atomically",
      "Corpus published — Explorer can refresh",
    ]);
    expect(events.map((event) => event.clock)).toEqual(
      [0, 8, 21, 34, 55, 89].map((elapsedMs) => ({
        kind: "elapsed",
        elapsedMs,
      })),
    );
    expect(new Set(events.map((event) => event.correlationId))).toEqual(
      new Set(["import:one"]),
    );
    expect(new Set(events.map((event) => event.operationId))).toEqual(
      new Set(["import:one:host:host-test-operation"]),
    );
    expect(events.every((event) => event.corpusId === "corpus-a")).toBe(true);
  });

  it("does not settle a classified partial run as a complete publish", () => {
    let attempt = beginImportActivityAttempt("import:partial", "file");
    attempt = recordImportProgress(
      attempt,
      progress("completed", {
        correlation_id: "import:partial",
        elapsed_ms: 40,
      }),
    );
    const settled = settleImportActivityAttempt(attempt, {
      ...completedRun(),
      outcome: "partial",
      report: {
        ...completedRun().report!,
        partial: false,
        outcome: { class: "partial" },
      },
    });
    const last = settled.events.at(-1);
    expect(last?.label).toBe("Corpus published with defects (PARTIAL)");
    expect(last?.label).not.toContain("Explorer can refresh");
    expect(last?.status).toBe("ok");
    expect(last?.detail).toContain("event");
  });

  it("uses causal sequence when measured elapsed time is absent or regresses", () => {
    let attempt = beginImportActivityAttempt("import:sequence", "directory");
    attempt = recordImportProgress(
      attempt,
      progress("starting", {
        correlation_id: "import:sequence",
        elapsed_ms: 10,
      }),
    );
    attempt = recordImportProgress(
      attempt,
      progress("scan", { correlation_id: "import:sequence" }),
    );
    attempt = recordImportProgress(
      attempt,
      progress("stream", {
        correlation_id: "import:sequence",
        elapsed_ms: 5,
      }),
    );

    expect(attempt.events.map((event) => event.clock)).toEqual([
      { kind: "elapsed", elapsedMs: 10 },
      { kind: "sequence", seq: 2 },
      { kind: "sequence", seq: 3 },
    ]);
    expect(JSON.stringify(attempt.events)).not.toContain('"kind":"wall"');
  });

  it("never copies host messages, paths, source names, or report examples", () => {
    let attempt = beginImportActivityAttempt("import:private", "file");
    attempt = recordImportProgress(
      attempt,
      progress("starting", { correlation_id: "import:private" }),
    );
    attempt = recordImportProgress(
      attempt,
      progress("stream", {
        correlation_id: "import:private",
        message:
          "Reading /private/synthetic/XYZ_Server-secret.log",
        lines_processed: 120,
        files_processed: 2,
        templates: 9,
        bytes_processed: 4_096,
        fraction: 0.5,
      }),
    );
    const serialized = JSON.stringify(
      settleImportActivityAttempt(attempt, completedRun()).events,
    );

    expect(serialized).not.toContain("/private/synthetic");
    expect(serialized).not.toContain("XYZ_Server");
    expect(serialized).not.toContain("private-name.xml");
    expect(serialized).toContain("120 events");
    expect(serialized).toContain("2 files");
    expect(serialized).toContain("9 templates");
    expect(serialized).toContain("50%");
  });

  it("discloses optional embedding as model work", () => {
    let attempt = beginImportActivityAttempt("import:embed", "zip");
    attempt = recordImportProgress(
      attempt,
      progress("starting", { correlation_id: "import:embed" }),
    );
    attempt = recordImportProgress(
      attempt,
      progress("embed", { correlation_id: "import:embed" }),
    );
    const event = attempt.events.find(
      (candidate) => candidate.origin === "probabilistic_model",
    )!;

    expect(event.origin).toBe("probabilistic_model");
    if (event.origin !== "probabilistic_model") {
      throw new Error("expected model activity");
    }
    expect(event.hook).toEqual({
      trigger: "import → optional local embedding phase",
      dataScope: "learned templates of the selected import only",
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "records %s explicitly and says that nothing was published",
    (outcome) => {
      const run: ImportRunInput = {
        startedAtMs: 1,
        endedAtMs: 2,
        outcome,
        sourceKind: "directory",
        diagnostic: {
          reasonCode: "private/path/error",
          summary: "/sensitive/source.log could not be read",
          cancelled: outcome === "cancelled",
          evidence: {
            scanCounts: {
              binary: 0,
              empty: 0,
              hidden: 0,
              oversized: 0,
              readFailed: 1,
              parseFailed: 0,
            },
            omittedEntries: 0,
          },
        },
      };
      const settled = settleImportActivityAttempt(
        beginImportActivityAttempt(`import:${outcome}`, "directory"),
        run,
      );
      const terminal = settled.events.at(-1)!;

      expect(terminal.status).toBe(outcome);
      expect(terminal.label).toContain("nothing published");
      expect(terminal.clock.kind).toBe("sequence");
      expect(JSON.stringify(terminal)).not.toContain("sensitive");
      expect(JSON.stringify(terminal)).not.toContain("private/path/error");
    },
  );

  it("retains the host terminal clock while reconciling the actual result", () => {
    let attempt = beginImportActivityAttempt("import:terminal", "zip");
    attempt = recordImportProgress(
      attempt,
      progress("starting", {
        correlation_id: "import:terminal",
        elapsed_ms: 0,
      }),
    );
    attempt = recordImportProgress(
      attempt,
      progress("completed", {
        correlation_id: "import:terminal",
        elapsed_ms: 77,
      }),
    );
    const terminal = settleImportActivityAttempt(
      attempt,
      completedRun(),
    ).events.at(-1)!;

    expect(terminal.clock).toEqual({ kind: "elapsed", elapsedMs: 77 });
    expect(terminal.detail).toBe("12,345 events · 42 templates · 7 files");
  });
});

describe("redact phase label is secrets/credentials only", () => {
  it('labels the redact host phase exactly "Safety redaction of secrets and credentials"', () => {
    let attempt = beginImportActivityAttempt("import:redact-label", "zip");
    attempt = recordImportProgress(
      attempt,
      progress("starting", {
        correlation_id: "import:redact-label",
        operation_id: "host-redact-op",
      }),
    );
    attempt = recordImportProgress(
      attempt,
      progress("redact", {
        correlation_id: "import:redact-label",
        operation_id: "host-redact-op",
        elapsed_ms: 12,
      }),
    );
    const redact = attempt.events.find((e) =>
      e.label.toLowerCase().includes("redaction"),
    );
    expect(redact).toBeDefined();
    expect(redact!.label).toBe("Safety redaction of secrets and credentials");
    expect(redact!.label.toLowerCase()).not.toContain("pii");
    expect(JSON.stringify(attempt.events)).not.toMatch(/\bPII\b/i);
  });
});
