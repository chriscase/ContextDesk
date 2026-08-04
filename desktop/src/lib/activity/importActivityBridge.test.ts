import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEventInput, ImportRunInput } from "./types";
import {
  IMPORT_ACTIVITY_CHANGED_EVENT,
  forgetCorpusImportActivity,
  loadCorpusImportActivity,
  publishImportRunActivity,
  subscribeImportRunActivity,
} from "./importActivityBridge";
import {
  beginImportActivityAttempt,
  recordImportProgress,
  settleImportActivityAttempt,
} from "./importProgressActivity";

function completedRun(corpusId = "corpus-a"): ImportRunInput {
  return {
    startedAtMs: 1_000,
    endedAtMs: 2_500,
    outcome: "completed",
    sourceKind: "zip",
    report: {
      corpusId,
      lines: 120,
      templates: 12,
      reductionRatio: 10,
      embedded: 0,
      files: 2,
      discoveredFiles: 3,
      excludedFiles: 1,
      failedFiles: 0,
      ignoredFiles: 0,
      exclusionCounts: { unsupported: 1 },
      exclusionExamples: ["ignored-markup.xml"],
      partial: false,
      sourceBytes: 4_000,
      corpusBytes: 2_000,
      tsMin: null,
      tsMax: null,
      formatCounts: { wildfly: 2 },
      embedding: { state: "keyword_only", modelId: null },
      confidence: {
        corpusTimeQuality: "order_only",
        counts: {
          wall: 0,
          orderOnly: 120,
          mixed: 0,
          matched: 2,
          ambiguous: 0,
          unknown: 0,
          unresolved: 120,
        },
        sources: [
          {
            source: "/sensitive/tenant-a/runtime.log",
            lines: 120,
            formatId: "wildfly",
            outcome: "matched",
            timeQuality: "order_only",
          },
        ],
      },
    },
  };
}

function liveEvents(run: ImportRunInput) {
  let attempt = beginImportActivityAttempt("import:bridge-test", run.sourceKind);
  for (const [phase, elapsedMs] of [
    ["starting", 0],
    ["scan", 10],
    ["stream", 20],
    ["validate", 30],
    ["publish", 40],
    [run.outcome === "completed" ? "completed" : run.outcome, 50],
  ] as const) {
    attempt = recordImportProgress(attempt, {
      operation_id: "host-bridge-test",
      correlation_id: "import:bridge-test",
      kind: "log_ingest",
      phase,
      message: "/sensitive/tenant-a/runtime.log",
      fraction: null,
      lines_processed: phase === "stream" ? 120 : null,
      files_processed: phase === "scan" ? 2 : null,
      bytes_processed: null,
      templates: phase === "stream" ? 12 : null,
      cancellable: phase !== "publish",
      elapsed_ms: elapsedMs,
      phase_elapsed_ms: null,
    });
  }
  return settleImportActivityAttempt(attempt, run).events;
}

beforeEach(() => {
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
});

describe("corpus import activity bridge", () => {
  it("persists and broadcasts only bounded projected metadata", async () => {
    const custom = vi.fn();
    const emit = vi.fn(async () => undefined);
    window.addEventListener(IMPORT_ACTIVITY_CHANGED_EVENT, custom);
    const run = completedRun();
    await publishImportRunActivity(run, liveEvents(run), 0, emit);
    window.removeEventListener(IMPORT_ACTIVITY_CHANGED_EVENT, custom);

    const loaded = loadCorpusImportActivity("corpus-a");
    expect(loaded.events.length).toBeGreaterThan(3);
    expect(loaded.events.every((event) => event.corpusId === "corpus-a")).toBe(
      true,
    );
    expect(
      loaded.events.some((event) => event.label === "Corpus published"),
    ).toBe(true);
    expect(JSON.stringify(loaded.events)).not.toContain("/sensitive/tenant-a");
    expect(
      localStorage.getItem("contextdesk.importActivity.v1:corpus-a"),
    ).not.toContain("runtime.log");

    expect(custom).toHaveBeenCalledOnce();
    const payload = (custom.mock.calls[0]?.[0] as CustomEvent).detail;
    expect(emit).toHaveBeenCalledWith(IMPORT_ACTIVITY_CHANGED_EVENT, payload);
  });

  it("does not persist or announce failed/cancelled attempts without a corpus", async () => {
    const custom = vi.fn();
    window.addEventListener(IMPORT_ACTIVITY_CHANGED_EVENT, custom);
    const run: ImportRunInput = {
      startedAtMs: 1,
      endedAtMs: 2,
      outcome: "failed",
      sourceKind: "file",
    };
    await publishImportRunActivity(run, liveEvents(run));
    window.removeEventListener(IMPORT_ACTIVITY_CHANGED_EVENT, custom);
    expect(custom).not.toHaveBeenCalled();
    expect(loadCorpusImportActivity("corpus-a")).toEqual({
      events: [],
      omittedUpdates: 0,
    });
  });

  it("fails closed when a caller bypasses the payload-free projector", async () => {
    const run = completedRun("corpus-forged");
    const [first, ...rest] = liveEvents(run);
    const emit = vi.fn(async () => undefined);
    await publishImportRunActivity(
      run,
      [
        {
          ...first,
          label: "Reading /private/customer/runtime.log",
          detail: "secret tenant payload",
        },
        ...rest,
      ],
      0,
      emit,
    );

    expect(loadCorpusImportActivity("corpus-forged").events).toEqual([]);
    expect(localStorage.getItem("contextdesk.importActivity.v1:corpus-forged"))
      .toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects a forged event claiming external_connector origin, even with a well-formed hook", async () => {
    // Import never talks to an external connector. A forgery that reuses a
    // real "Corpus published" label/phase/status but swaps in
    // external_connector (plus a hook shaped exactly like the legitimate
    // embedding hook, to probe whether hook-presence alone satisfied the old
    // check) must still be rejected outright — before the label table is
    // even consulted.
    const run = completedRun("corpus-connector-forged");
    const events = liveEvents(run);
    const forged: ActivityEventInput[] = events.map((event, index) =>
      index === events.length - 1
        ? ({
            ...event,
            origin: "external_connector",
            hook: {
              trigger: "import → optional local embedding phase",
              dataScope: "learned templates of the selected import only",
            },
          } as ActivityEventInput)
        : event,
    );
    const emit = vi.fn(async () => undefined);
    await publishImportRunActivity(run, forged, 0, emit);

    expect(loadCorpusImportActivity("corpus-connector-forged").events).toEqual(
      [],
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects a real label forged with a mismatched origin/status", async () => {
    // "Corpus published" is only ever emitted with origin governed_write and
    // status ok. A forgery that keeps the real label text but claims
    // deterministic_host (and drags the status along for a plausible-looking
    // but never-real combination) must fail the exact-tuple check, not just
    // the label-only check the old allowlist made.
    const run = completedRun("corpus-mismatch-forged");
    const events = liveEvents(run);
    const forged: ActivityEventInput[] = events.map((event, index) =>
      index === events.length - 1
        ? ({
            ...event,
            label: "Corpus published",
            origin: "deterministic_host",
            status: "ok",
          } as ActivityEventInput)
        : event,
    );
    const emit = vi.fn(async () => undefined);
    await publishImportRunActivity(run, forged, 0, emit);

    expect(loadCorpusImportActivity("corpus-mismatch-forged").events).toEqual(
      [],
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not persist a renderer-only trace without a host operation identity", async () => {
    const run = completedRun("corpus-unbound");
    const unbound = settleImportActivityAttempt(
      beginImportActivityAttempt("import:unbound", run.sourceKind),
      run,
    );
    const emit = vi.fn(async () => undefined);

    await publishImportRunActivity(run, unbound.events, 0, emit);

    expect(loadCorpusImportActivity("corpus-unbound").events).toEqual([]);
    expect(
      localStorage.getItem("contextdesk.importActivity.v1:corpus-unbound"),
    ).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });

  it("delivers one matching safe payload once across same-window and Tauri", async () => {
    const received = vi.fn();
    let tauriHandler:
      | ((event: {
          payload: {
            corpusId?: unknown;
            eventId?: unknown;
            events?: unknown;
            omittedUpdates?: unknown;
          };
        }) => void)
      | undefined;
    const unsubscribe = subscribeImportRunActivity(
      received,
      async (_name, handler) => {
        tauriHandler = handler;
        return () => undefined;
      },
    );
    await vi.waitFor(() => expect(tauriHandler).toBeTypeOf("function"));

    const run = completedRun();
    await publishImportRunActivity(
      run,
      liveEvents(run),
      0,
      async (_name, payload) => {
        tauriHandler?.({ payload });
      },
    );
    expect(received).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledWith(
      "corpus-a",
      expect.arrayContaining([
        expect.objectContaining({ label: "Corpus published" }),
      ]),
      0,
    );
    unsubscribe();
  });

  it("rejects malformed or cross-corpus stored activity", () => {
    localStorage.setItem(
      "contextdesk.importActivity.v1:corpus-b",
      JSON.stringify({
        version: 1,
        events: [
          {
            ...completedRun("corpus-a"),
            label: "forged",
          },
        ],
      }),
    );
    expect(loadCorpusImportActivity("corpus-b")).toEqual({
      events: [],
      omittedUpdates: 0,
    });
  });

  it("forgets only the confirmed-discard corpus", async () => {
    for (const corpusId of ["discard-me", "keep-me"]) {
      const run = completedRun(corpusId);
      await publishImportRunActivity(
        run,
        liveEvents(run),
        0,
        async () => undefined,
      );
    }
    forgetCorpusImportActivity("discard-me");

    expect(loadCorpusImportActivity("discard-me").events).toEqual([]);
    expect(loadCorpusImportActivity("keep-me").events.length).toBeGreaterThan(
      0,
    );
  });

  it("rejects forged path or log text from storage and cross-webview input", async () => {
    const run = completedRun("corpus-inbound");
    const [safe] = liveEvents(run);
    const forged = {
      ...safe,
      label: "Discovering and reading sources",
      detail: "/private/customer/runtime.log: password=secret",
      corpusId: "corpus-inbound",
    };
    localStorage.setItem(
      "contextdesk.importActivity.v1:corpus-inbound",
      JSON.stringify({ version: 1, events: [forged] }),
    );
    expect(loadCorpusImportActivity("corpus-inbound").events).toEqual([]);

    const received = vi.fn();
    let tauriHandler:
      | ((event: { payload: Record<string, unknown> }) => void)
      | undefined;
    const unsubscribe = subscribeImportRunActivity(
      received,
      async (_name, handler) => {
        tauriHandler = handler as typeof tauriHandler;
        return () => undefined;
      },
    );
    await vi.waitFor(() => expect(tauriHandler).toBeTypeOf("function"));
    tauriHandler?.({
      payload: {
        corpusId: "corpus-inbound",
        eventId: "forged:1",
        events: [forged],
      },
    });
    expect(received).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("formats large counts with pinned digit grouping that satisfies the safe detail pattern", () => {
    // Regression for a locale-dependent `.toLocaleString()`: on a
    // German/French/Windows-locale host, an unpinned formatter groups
    // thousands with "." instead of ",", which SAFE_IMPORT_DETAIL_PART's
    // `[\d,]` pattern would then reject, silently dropping legitimate
    // progress. Mutating the global locale in vitest is unreliable, so this
    // asserts the pinned formatter's exact output and that it satisfies the
    // safety pattern used to validate persisted/broadcast detail strings.
    let attempt = beginImportActivityAttempt("import:locale-test", "zip");
    attempt = recordImportProgress(attempt, {
      operation_id: "host-locale-test",
      correlation_id: "import:locale-test",
      kind: "log_ingest",
      phase: "starting",
      message: "starting",
      fraction: null,
      lines_processed: null,
      files_processed: null,
      bytes_processed: null,
      templates: null,
      cancellable: true,
      elapsed_ms: 0,
      phase_elapsed_ms: null,
    });
    attempt = recordImportProgress(attempt, {
      operation_id: "host-locale-test",
      correlation_id: "import:locale-test",
      kind: "log_ingest",
      phase: "scan",
      message: "scanning",
      fraction: null,
      lines_processed: null,
      files_processed: 12_345,
      bytes_processed: null,
      templates: null,
      cancellable: true,
      elapsed_ms: 5,
      phase_elapsed_ms: null,
    });
    const detail = attempt.events.at(-1)?.detail;
    expect(detail).toBe("12,345 files");
    expect(detail).toMatch(/^[\d,]+ files$/);

    // The byte-count variant uses the same pinned formatter.
    let byteAttempt = beginImportActivityAttempt("import:locale-bytes", "zip");
    byteAttempt = recordImportProgress(byteAttempt, {
      operation_id: "host-locale-bytes",
      correlation_id: "import:locale-bytes",
      kind: "log_ingest",
      phase: "starting",
      message: "starting",
      fraction: null,
      lines_processed: null,
      files_processed: null,
      bytes_processed: null,
      templates: null,
      cancellable: true,
      elapsed_ms: 0,
      phase_elapsed_ms: null,
    });
    byteAttempt = recordImportProgress(byteAttempt, {
      operation_id: "host-locale-bytes",
      correlation_id: "import:locale-bytes",
      kind: "log_ingest",
      phase: "scan",
      message: "scanning",
      fraction: null,
      lines_processed: null,
      files_processed: null,
      bytes_processed: 1_234_567,
      templates: null,
      cancellable: true,
      elapsed_ms: 5,
      phase_elapsed_ms: null,
    });
    const bytesDetail = byteAttempt.events.at(-1)?.detail;
    expect(bytesDetail).toBe("1,234,567 bytes read");
    expect(bytesDetail).toMatch(/^[\d,]+ bytes read$/);
  });

  it("carries a legitimate nonzero omittedUpdates through publish, broadcast, persist, and reload", async () => {
    const received = vi.fn();
    let tauriHandler:
      | ((event: { payload: Record<string, unknown> }) => void)
      | undefined;
    const unsubscribe = subscribeImportRunActivity(
      received,
      async (_name, handler) => {
        tauriHandler = handler as typeof tauriHandler;
        return () => undefined;
      },
    );
    await vi.waitFor(() => expect(tauriHandler).toBeTypeOf("function"));

    const run = completedRun("corpus-omitted");
    const emit = vi.fn(async (_name: string, payload: unknown) => {
      tauriHandler?.({ payload: payload as Record<string, unknown> });
    });
    await publishImportRunActivity(run, liveEvents(run), 7, emit);

    const stored = JSON.parse(
      localStorage.getItem("contextdesk.importActivity.v1:corpus-omitted")!,
    ) as { omittedUpdates: unknown };
    expect(stored.omittedUpdates).toBe(7);

    expect(received).toHaveBeenCalledWith(
      "corpus-omitted",
      expect.any(Array),
      7,
    );

    const reloaded = loadCorpusImportActivity("corpus-omitted");
    expect(reloaded.omittedUpdates).toBe(7);
    unsubscribe();
  });

  it("fails closed on a tampered/out-of-bounds omittedUpdates without dropping the still-valid events", async () => {
    const run = completedRun("corpus-tampered");
    await publishImportRunActivity(run, liveEvents(run), 3);
    const key = "contextdesk.importActivity.v1:corpus-tampered";
    const stored = JSON.parse(localStorage.getItem(key)!) as {
      version: number;
      events: unknown[];
      omittedUpdates: number;
    };
    expect(stored.omittedUpdates).toBe(3);

    for (const tampered of [-1, 1.5, Number.NaN, 10_000_000, "3"]) {
      localStorage.setItem(
        key,
        JSON.stringify({ ...stored, omittedUpdates: tampered }),
      );
      const reloaded = loadCorpusImportActivity("corpus-tampered");
      expect(reloaded.omittedUpdates).toBe(0);
      expect(reloaded.events.length).toBeGreaterThan(0);
    }

    const received = vi.fn();
    let tauriHandler:
      | ((event: { payload: Record<string, unknown> }) => void)
      | undefined;
    const unsubscribe = subscribeImportRunActivity(
      received,
      async (_name, handler) => {
        tauriHandler = handler as typeof tauriHandler;
        return () => undefined;
      },
    );
    await vi.waitFor(() => expect(tauriHandler).toBeTypeOf("function"));
    tauriHandler?.({
      payload: {
        corpusId: "corpus-tampered",
        eventId: "tampered-broadcast:1",
        events: stored.events,
        omittedUpdates: -3,
      },
    });
    expect(received).toHaveBeenCalledWith(
      "corpus-tampered",
      expect.any(Array),
      0,
    );
    unsubscribe();
  });
});
