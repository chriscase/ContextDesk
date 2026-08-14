/**
 * Deterministic mock engine adapter.
 *
 * Every response is a pure function of the constructor scenario and the
 * requests made so far — no clocks, no randomness — so conformance runs and
 * component tests replay byte-identically. The mock enforces the same
 * refusals the trusted core does (zero-importable, stale revisions, stale
 * preview tokens) with the core's own message shapes, so UI code exercised
 * against it meets the real engine's edges.
 */
import {
  parseCompiledTriagePolicyV2,
  parseTriageCancellationV1,
  parseTriageReplayV1,
  parseTriageRequestV2,
  parseTriageRoleQualificationResultV1,
  type CompiledTriagePolicyV2,
  type TriageRoleQualificationRequestV1,
  type TriageRoleQualificationResultV1,
  type TriageReplayV1,
  type WireImportPreviewPlan,
  type WireImportPreviewReport,
  type WireProcessProgress,
} from "@contextdesk/contracts";
import {
  EngineError,
  type EngineClient,
  type EventRevisionReport,
  type ImportRunReport,
  type ImportRunRequest,
  type TimezoneApplyRequest,
  type TimezonePreview,
  type TimezoneState,
  type TriageRunOptions,
  type TriageService,
  type Unsubscribe,
} from "./engine";

/** Fixed declaration timestamp the mock stamps (2026-07-01T00:00:00Z). */
export const MOCK_DECLARED_AT_UNIX_SECS = 1_782_864_000;

/** Scenario knobs; every field has a deterministic default. */
export type MockScenario = {
  /** Preview returned for any path. Defaults to [`defaultMockPreview`]. */
  preview?: WireImportPreviewReport;
  /** Fail the next run with this message (once). */
  failNextRun?: string;
  /** Delay resolution until [`MockEngineClient.flush`] is called. */
  manualFlush?: boolean;
  /**
   * Park once more between the non-cancellable publish emission and
   * completion, mirroring the host's deliberately uncancellable atomic
   * commit window. Cancellation requested inside this window is ignored,
   * exactly as the real engine ignores it.
   */
  parkBeforeCompletion?: boolean;
  /** Optional host-shaped triage script. Absence means explicitly unsupported. */
  triage?: MockTriageScenario;
};

/** Rust-contract-shaped provider-free triage responses for deterministic tests. */
export type MockTriageScenario = {
  /** Exact host preflight result; the mock never recompiles it. */
  preflight: CompiledTriagePolicyV2;
  /** Exact normal run replay. */
  replay: TriageReplayV1;
  /** Exact cancellation replay used when abort/cancel wins. */
  cancelledReplay?: TriageReplayV1;
  /** Park a run before event delivery until `flush()` or `cancel()` is called. */
  manualFlush?: boolean;
  /** Optional exact-role qualification result returned by `triage.qualify`. */
  roleQualification?: TriageRoleQualificationResultV1;
};

/** The default deterministic preview: one of every ledger state. */
export function defaultMockPreview(): WireImportPreviewReport {
  const items = [
    {
      identity: "api/api-gateway.log",
      basename: "api-gateway.log",
      status: "ready" as const,
      role: "log" as const,
      selected: true,
      bytes: 50_331_648,
      reasons: ["strong_format_match" as const],
      formatId: "date-level-logger-thread-record",
      formatVersion: 1,
    },
    {
      identity: "api/payments.jsonl",
      basename: "payments.jsonl",
      status: "ready" as const,
      role: "log" as const,
      selected: true,
      bytes: 117_440_512,
      reasons: ["strong_format_match" as const],
      formatId: "json-object-line",
      formatVersion: 1,
    },
    {
      identity: "support.zip!/host-a.zip!/logs/app.log",
      basename: "app.log",
      status: "review" as const,
      role: "log" as const,
      selected: true,
      bytes: 9_437_184,
      reasons: ["ambiguous_format_match" as const],
    },
    {
      identity: "logs/console-fallback.log",
      basename: "console-fallback.log",
      status: "raw_fallback" as const,
      role: "log" as const,
      selected: true,
      bytes: 14_336,
      reasons: ["no_structured_match" as const],
    },
    {
      identity: "metrics/gateway-metrics.json",
      basename: "gateway-metrics.json",
      status: "supporting" as const,
      role: "operational_metrics" as const,
      selected: false,
      bytes: 2_202_009,
      reasons: ["metrics_document" as const],
    },
    {
      identity: ".DS_Store",
      basename: ".DS_Store",
      status: "ignored" as const,
      role: "unknown" as const,
      selected: false,
      bytes: 6_148,
      reasons: ["hidden" as const],
    },
    {
      identity: "dumps/core.dump",
      basename: "core.dump",
      status: "unsupported" as const,
      role: "unknown" as const,
      selected: false,
      bytes: 222_298_112,
      reasons: ["binary_content" as const],
    },
    {
      identity: "support.zip!/host-a.zip!/inner.zip!/deep.log",
      basename: "deep.log",
      status: "blocked" as const,
      role: "unknown" as const,
      selected: false,
      bytes: 0,
      reasons: ["archive_depth_exceeded" as const],
    },
  ];
  return {
    schemaVersion: 1,
    sourceKind: "directory",
    items,
    counts: {
      total: items.length,
      selected: items.filter((item) => item.selected).length,
      ready: 2,
      review: 1,
      rawFallback: 1,
      supporting: 1,
      ignored: 1,
      unsupported: 1,
      blocked: 1,
    },
    truncated: false,
  };
}

/** The shared trusted routing rule: only selectable log-role items become events. */
function eventImportable(item: WireImportPreviewReport["items"][number]): boolean {
  return item.role === "log" && item.status !== "blocked";
}

function importableLogIdentities(preview: WireImportPreviewReport): string[] {
  return preview.items.filter(eventImportable).map((item) => item.identity);
}

/** Deterministic mock plan token over the fixture inventory. */
export function mockPlanToken(preview: WireImportPreviewReport): string {
  const canonical = JSON.stringify([
    preview.schemaVersion,
    preview.sourceKind,
    preview.truncated,
    preview.items.map((item) => [item.identity, item.bytes, item.status, item.role]),
  ]);
  let hash = 0;
  for (let index = 0; index < canonical.length; index += 1) {
    hash = (hash * 31 + canonical.charCodeAt(index)) >>> 0;
  }
  return `mock-plan-${hash.toString(16).padStart(8, "0")}`;
}

/** Deterministic mock engine client. */
export class MockEngineClient implements EngineClient {
  readonly #scenario: MockScenario;
  #preview: WireImportPreviewReport;
  #listeners = new Set<(progress: WireProcessProgress) => void>();
  #running = false;
  #cancelRequested = false;
  #failNextRun: string | undefined;
  #pendingFlush: (() => void)[] = [];
  #triageScenario: MockTriageScenario | undefined;
  #triageListeners = new Set<(event: TriageReplayV1["events"][number]) => void>();
  #triageRunning: { runId: string; cancellationId: string } | undefined;
  #triageCancelRequested = false;
  readonly triage: TriageService;
  /** Mutable timezone corpus states keyed by corpus id. */
  #corpora = new Map<
    string,
    { revision: number; declarations: Record<string, TimezoneState["declarations"][string]> }
  >();

  constructor(scenario: MockScenario = {}) {
    this.#scenario = scenario;
    this.#preview = scenario.preview ?? defaultMockPreview();
    this.#failNextRun = scenario.failNextRun;
    this.#triageScenario = scenario.triage
      ? {
          preflight: parseCompiledTriagePolicyV2(
            structuredClone(scenario.triage.preflight),
          ),
          replay: parseTriageReplayV1(structuredClone(scenario.triage.replay)),
          cancelledReplay: scenario.triage.cancelledReplay
            ? parseTriageReplayV1(structuredClone(scenario.triage.cancelledReplay))
            : undefined,
          roleQualification: scenario.triage.roleQualification
            ? parseTriageRoleQualificationResultV1(
                structuredClone(scenario.triage.roleQualification),
              )
            : undefined,
          manualFlush: scenario.triage.manualFlush,
        }
      : undefined;
    this.triage = this.#createTriageService();
  }

  /** Resolve any operation parked by `manualFlush`. */
  flush(): void {
    const pending = this.#pendingFlush;
    this.#pendingFlush = [];
    for (const resume of pending) resume();
  }

  #park(): Promise<void> {
    if (!this.#scenario.manualFlush) return Promise.resolve();
    return this.#parkAlways();
  }

  #parkAlways(): Promise<void> {
    return new Promise((resolve) => {
      this.#pendingFlush.push(resolve);
    });
  }

  #emit(progress: WireProcessProgress): void {
    for (const listener of this.#listeners) listener(progress);
  }

  #phase(
    phase: WireProcessProgress["phase"],
    message: string,
    cancellable: boolean,
    extra: Partial<WireProcessProgress> = {},
  ): WireProcessProgress {
    return {
      kind: "log_ingest",
      phase,
      message,
      cancellable,
      fraction: null,
      lines_processed: null,
      files_processed: null,
      bytes_processed: null,
      templates: null,
      ...extra,
    } satisfies WireProcessProgress;
  }

  readonly import = {
    preview: async (_path: string): Promise<WireImportPreviewPlan> => {
      await this.#park();
      return {
        report: structuredClone(this.#preview),
        planToken: mockPlanToken(this.#preview),
        planVersion: 1,
      };
    },
    run: async (request: ImportRunRequest): Promise<ImportRunReport> => {
      if (this.#running) {
        throw new EngineError("conflict", "a log import is already running");
      }
      if (request.planVersion !== 1) {
        throw new EngineError(
          "invalid",
          `import plan version ${request.planVersion} is not supported by this build (expected 1)`,
        );
      }
      if (request.planToken !== mockPlanToken(this.#preview)) {
        throw new EngineError(
          "conflict",
          "import plan is stale: the reviewed content changed on disk since the preview — review the selection again",
        );
      }
      if (request.selected.length === 0) {
        throw new EngineError(
          "invalid",
          "import plan selects nothing that would import as log events",
        );
      }
      const byIdentity = new Map(this.#preview.items.map((item) => [item.identity, item]));
      for (const identity of request.selected) {
        const item = byIdentity.get(identity);
        if (!item) {
          throw new EngineError(
            "invalid",
            `import plan selects an identity the preview does not contain: "${identity}"`,
          );
        }
        if (!eventImportable(item)) {
          throw new EngineError(
            "invalid",
            `import plan selects "${identity}" which cannot import as log events`,
          );
        }
      }
      const importable = [...new Set(request.selected)];
      if (this.#failNextRun !== undefined) {
        const message = this.#failNextRun;
        this.#failNextRun = undefined;
        this.#emit(this.#phase("failed", message, false));
        throw new EngineError("failed", message);
      }
      this.#running = true;
      this.#cancelRequested = false;
      try {
        this.#emit(this.#phase("starting", "starting ingest of import", true));
        this.#emit(this.#phase("scan", `found ${importable.length} file entr(y/ies)`, true));
        await this.#park();
        if (this.#cancelRequested) {
          this.#emit(this.#phase("cancelled", "ingest cancelled during parse", false));
          throw new EngineError("cancelled", "cancelled");
        }
        this.#emit(
          this.#phase("stream", "parsing and templating lines", true, {
            fraction: 0.5,
            files_processed: Math.floor(importable.length / 2),
          }),
        );
        this.#emit(
          this.#phase("stream", "parsing and templating lines", true, {
            fraction: 1,
            files_processed: importable.length,
          }),
        );
        this.#emit(this.#phase("validate", "validating staged corpus before publication", false));
        this.#emit(this.#phase("publish", "publishing corpus into the library (atomic)", false));
        if (this.#scenario.parkBeforeCompletion) {
          // The commit window: cancellation requests are ignored here.
          await this.#parkAlways();
        }
        this.#emit(this.#phase("completed", "corpus published", false));
      } finally {
        this.#running = false;
      }
      const corpusId = "mock-corpus-0001";
      this.#corpora.set(corpusId, { revision: 1, declarations: {} });
      // The mock's raw-fallback source deliberately has no parser-validated
      // timestamp. A `.log` suffix alone must not manufacture a timezone
      // decision; the real confidence builder likewise offers review only
      // when it retained unresolved local timestamp evidence.
      const unresolvedSources = importable.filter((identity) => {
        const item = this.#preview.items.find((candidate) => candidate.identity === identity);
        return identity.endsWith(".log") && item?.status !== "raw_fallback";
      });
      const notSelected =
        importableLogIdentities(this.#preview).length - importable.length;
      const sourceBytes = importable.reduce((total, identity) => {
        const item = this.#preview.items.find(
          (candidate) => candidate.identity === identity,
        );
        return total + (item?.bytes ?? 0);
      }, 0);
      return {
        corpusId,
        lines: importable.length * 1_000,
        templates: importable.length * 10,
        reductionRatio: importable.length > 0 ? 100 : 0,
        embedded: 0,
        files: importable.length,
        discoveredFiles: this.#preview.counts.total,
        excludedFiles: this.#preview.counts.blocked,
        failedFiles: 0,
        ignoredFiles: this.#preview.counts.ignored + notSelected,
        exclusionCounts: notSelected > 0 ? { not_selected: notSelected } : {},
        exclusionExamples: [],
        partial: false,
        sourceBytes,
        corpusBytes: sourceBytes,
        tsMin: null,
        tsMax: null,
        formatCounts:
          importable.length > 0
            ? { "date-level-logger-thread-record": importable.length }
            : {},
        embedding: { state: "keyword_only", modelId: null },
        confidence: {
          corpusTimeQuality: unresolvedSources.length > 0 ? "order_only" : "wall",
          counts: {
            wall: importable.length - unresolvedSources.length,
            orderOnly: unresolvedSources.length,
            mixed: 0,
            matched: importable.length,
            ambiguous: 0,
            unknown: 0,
            unresolved: unresolvedSources.length,
          },
          sources: unresolvedSources.map((source) => ({
            source,
            lines: 1_000,
            formatId: "date-level-logger-thread-record",
            formatVersion: 1,
            outcome: "matched" as const,
            timeQuality: "order_only" as const,
            unresolvedReasons: ["no_timezone" as const],
            timestampPrefixSamples: ["2026-07-28 14:02:11,532"],
          })),
        },
      };
    },
    cancel: async (): Promise<boolean> => {
      const wasRunning = this.#running;
      this.#cancelRequested = true;
      this.flush();
      return wasRunning;
    },
  };

  readonly time = {
    state: async (corpusId: string): Promise<TimezoneState> => {
      const corpus = this.#corpus(corpusId);
      const declared = new Set(Object.keys(corpus.declarations));
      const sources = importableLogIdentities(this.#preview)
        .filter((identity) => identity.endsWith(".log"))
        .map((source) => ({
          source,
          unresolvedLocalRecords: declared.has(source) ? 0 : 1_000,
          resolvedLocalRecords: declared.has(source) ? 1_000 : 0,
          explicitWallClockRecords: 0,
          otherOrderOnlyRecords: 0,
        }));
      return {
        corpusId,
        eventRevision: corpus.revision,
        declarations: structuredClone(corpus.declarations),
        sources,
      };
    },
    preview: async (
      corpusId: string,
      eventRevision: number,
      source: string,
      ianaZone: string,
    ): Promise<TimezonePreview> => {
      const corpus = this.#corpus(corpusId);
      if (eventRevision !== corpus.revision) {
        throw new EngineError(
          "conflict",
          `stale timezone preview: expected revision ${eventRevision}, current ${corpus.revision}`,
        );
      }
      await this.#park();
      return {
        corpusId,
        eventRevision,
        source,
        ianaZone,
        previewToken: `mock-fp:${source}:${ianaZone}:${eventRevision}`,
        affectedRecords: 1_000,
        existingWallClockRecords: 0,
        firstResolvedTs: 1_753_700_531,
        lastResolvedTs: 1_753_704_131,
        dstGapRecords: 0,
        dstFoldAmbiguities: 0,
        unchangedOrderOnlyRecords: 0,
        unsupportedTimestampRecords: 0,
        zoneAbbreviationMismatchRecords: 0,
        outOfRangeRecords: 0,
        precision: "whole_second",
      };
    },
    applyMany: async (
      corpusId: string,
      expectedRevision: number,
      requests: TimezoneApplyRequest[],
    ): Promise<EventRevisionReport> => {
      const corpus = this.#corpus(corpusId);
      if (requests.length === 0) {
        throw new EngineError("invalid", "timezone apply requires at least one source");
      }
      if (expectedRevision !== corpus.revision) {
        throw new EngineError(
          "conflict",
          `stale timezone apply: expected revision ${expectedRevision}, current ${corpus.revision}`,
        );
      }
      for (const request of requests) {
        const expected = `mock-fp:${request.source}:${request.ianaTimezone}:${expectedRevision}`;
        if (request.previewToken !== expected) {
          throw new EngineError(
            "conflict",
            `timezone preview token no longer matches source "${request.source}", its zone, or the corpus revision`,
          );
        }
      }
      const revision = corpus.revision + 1;
      for (const request of requests) {
        corpus.declarations[request.source] = {
          source: request.source,
          ianaZone: request.ianaTimezone,
          basis: "user_declared",
          declaredAt: MOCK_DECLARED_AT_UNIX_SECS,
          appliedRevision: revision,
        };
      }
      corpus.revision = revision;
      return {
        revision,
        previousRevision: revision - 1,
        changedEvents: requests.length * 1_000,
        eventCount: 4_000,
        tsMin: 1_753_700_531,
        tsMax: 1_753_704_131,
      };
    },
    undo: async (corpusId: string, expectedRevision: number): Promise<EventRevisionReport> => {
      const corpus = this.#corpus(corpusId);
      if (expectedRevision !== corpus.revision) {
        throw new EngineError(
          "conflict",
          `stale event revision undo: expected revision ${expectedRevision}, current ${corpus.revision}`,
        );
      }
      const revision = corpus.revision + 1;
      const changed = Object.keys(corpus.declarations).length * 1_000;
      corpus.declarations = {};
      corpus.revision = revision;
      return {
        revision,
        previousRevision: revision - 1,
        changedEvents: changed,
        eventCount: 4_000,
        tsMin: null,
        tsMax: null,
      };
    },
  };

  readonly events = {
    onProcessProgress: (
      listener: (progress: WireProcessProgress) => void,
    ): Unsubscribe => {
      this.#listeners.add(listener);
      return () => this.#listeners.delete(listener);
    },
  };

  #createTriageService(): TriageService {
    const unsupported = (): never => {
      throw new EngineError("unsupported", "triage capability is not configured for this adapter");
    };
    return {
      capability: this.#triageScenario
        ? { supported: true, replay: true }
        : {
            supported: false,
            reason: "triage capability is not configured for this adapter",
            replay: false,
          },
      preflight: async (request) => {
        parseTriageRequestV2(structuredClone(request));
        const scenario = this.#triageScenario ?? unsupported();
        return structuredClone(scenario.preflight);
      },
      qualify: async (request: TriageRoleQualificationRequestV1) => {
        const scenario = this.#triageScenario ?? unsupported();
        if (!request.confirm) {
          throw new EngineError("invalid", "triage role qualification requires confirmation");
        }
        const configured = scenario.roleQualification;
        if (!configured) {
          throw new EngineError("unsupported", "exact-role qualification is not configured for this adapter");
        }
        if (
          request.profile_id !== configured.profile_id ||
          request.model_id !== configured.model_id ||
          JSON.stringify(request.kind) !== JSON.stringify(configured.kind)
        ) {
          throw new EngineError("conflict", "qualification identity does not match the configured scenario");
        }
        return structuredClone(configured);
      },
      run: async (request, options = {}) => {
        const parsedRequest = parseTriageRequestV2(structuredClone(request));
        const scenario = this.#triageScenario ?? unsupported();
        if (this.#triageRunning) {
          throw new EngineError("conflict", "a triage run is already running");
        }
        if (scenario.replay.run_id !== parsedRequest.run_id) {
          throw new EngineError("conflict", "triage replay run identity does not match request");
        }
        this.#triageRunning = {
          runId: parsedRequest.run_id,
          cancellationId: parsedRequest.cancellation_id,
        };
        this.#triageCancelRequested = options.signal?.aborted ?? false;
        const abort = () => {
          this.#triageCancelRequested = true;
          this.flush();
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        try {
          if (scenario.manualFlush) await this.#parkAlways();
          const selected = this.#triageCancelRequested
            ? scenario.cancelledReplay ?? unsupported()
            : scenario.replay;
          return this.#consumeTriageReplay(selected, options);
        } finally {
          options.signal?.removeEventListener("abort", abort);
          this.#triageRunning = undefined;
          this.#triageCancelRequested = false;
        }
      },
      replay: async (replay, options = {}) => {
        if (options.signal?.aborted) {
          throw new EngineError("cancelled", "triage replay consumption cancelled");
        }
        return this.#consumeTriageReplay(replay, options);
      },
      cancel: async (request) => {
        const parsed = parseTriageCancellationV1(structuredClone(request));
        const active = this.#triageRunning;
        if (
          !active ||
          active.runId !== parsed.run_id ||
          active.cancellationId !== parsed.cancellation_id
        ) {
          return false;
        }
        this.#triageCancelRequested = true;
        this.flush();
        return true;
      },
      onRunEvent: (listener) => {
        this.#triageListeners.add(listener);
        return () => this.#triageListeners.delete(listener);
      },
    };
  }

  #consumeTriageReplay(
    replay: TriageReplayV1,
    options: TriageRunOptions,
  ): TriageReplayV1["events"][number] {
    const parsed = parseTriageReplayV1(structuredClone(replay));
    for (const event of parsed.events) {
      options.onEvent?.(event);
      for (const listener of this.#triageListeners) listener(event);
    }
    return parsed.events[parsed.events.length - 1]!;
  }

  #corpus(corpusId: string): {
    revision: number;
    declarations: Record<string, TimezoneState["declarations"][string]>;
  } {
    let corpus = this.#corpora.get(corpusId);
    if (!corpus) {
      corpus = { revision: 1, declarations: {} };
      this.#corpora.set(corpusId, corpus);
    }
    return corpus;
  }
}

/** Create a deterministic mock engine client. */
export function createMockEngineClient(scenario: MockScenario = {}): MockEngineClient {
  return new MockEngineClient(scenario);
}
