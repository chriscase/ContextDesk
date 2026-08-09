import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostExportHandbookDocument,
  hostClearFailedLogIngestDiagnostic,
  hostClearCapabilityQualification,
  hostGetFailedLogIngestDiagnostic,
  hostGetCapabilityQualification,
  hostGetHandbookPage,
  hostInstallDemoLogCorpus,
  hostLogCountEvents,
  hostOpenEngineeringHandbook,
  hostResolveHandbookLink,
  hostLogQueryEventRows,
  hostLogQueryEventOriginal,
  hostLogSharedTimelineSummary,
  hostLogSourceCatalog,
  hostPrepareLogDiagnosticReport,
  hostReleaseLogDiagnosticReport,
  hostSaveLogDiagnosticReport,
  hostStartCapabilityQualification,
  modelSelectionKey,
  normalizeProviderKind,
  parseModelSelectionKey,
  profileIdForKind,
} from "./host";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

beforeEach(() => {
  invokeMock.mockReset();
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ =
    {};
});

describe("capability qualification credential boundary", () => {
  it("sends a draft key only for an explicit live start", async () => {
    invokeMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce({ readiness: "verified" });
    const args = {
      profileId: "work",
      modelId: "private-chat",
      baseUrl: "https://gateway.example.test/v1",
      apiKey: "draft-key",
    };

    await hostGetCapabilityQualification(args);
    await hostClearCapabilityQualification(args);
    await hostStartCapabilityQualification(args);

    expect(invokeMock.mock.calls).toEqual([
      [
        "get_capability_qualification",
        {
          req: {
            profile_id: "work",
            model_id: "private-chat",
            base_url: "https://gateway.example.test/v1",
          },
        },
      ],
      [
        "clear_capability_qualification",
        {
          req: {
            profile_id: "work",
            model_id: "private-chat",
            base_url: "https://gateway.example.test/v1",
          },
        },
      ],
      [
        "start_capability_qualification",
        {
          req: {
            profile_id: "work",
            model_id: "private-chat",
            base_url: "https://gateway.example.test/v1",
            api_key: "draft-key",
          },
        },
      ],
    ]);
  });
});

describe("split Log Explorer event queries", () => {
  it("exposes bounded rows and exact counts as independent host requests", async () => {
    invokeMock
      .mockResolvedValueOnce({
        events: [],
        nextCursor: 42,
        nextTs: 1_700_000_000,
        timeQuality: "wall",
      })
      .mockResolvedValueOnce({ totalMatched: 250_000 });

    await expect(
      hostLogQueryEventRows("corpus-1", {
        levels: ["error"],
        afterSeq: 7,
        afterTs: 1_699_999_999,
        limit: 100,
      }),
    ).resolves.toMatchObject({
      nextCursor: 42,
      timeQuality: "wall",
    });
    await expect(
      hostLogCountEvents("corpus-1", {
        levels: ["error"],
        afterSeq: 7,
        afterTs: 1_699_999_999,
        limit: 100,
      }),
    ).resolves.toEqual({ totalMatched: 250_000 });

    expect(invokeMock).toHaveBeenNthCalledWith(1, "log_query_event_rows", {
      corpusId: "corpus-1",
      query: {
        levels: ["error"],
        afterSeq: 7,
        afterTs: 1_699_999_999,
        limit: 100,
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "log_count_events", {
      corpusId: "corpus-1",
      query: {
        levels: ["error"],
        afterSeq: 7,
        afterTs: 1_699_999_999,
        limit: 100,
      },
    });
  });

  it("returns honest empty split results outside the desktop host", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object })
      .__TAURI_INTERNALS__;

    await expect(hostLogQueryEventRows("corpus-1")).resolves.toEqual({
      events: [],
      nextCursor: null,
      timeQuality: "order_only",
    });
    await expect(hostLogCountEvents("corpus-1")).resolves.toEqual({
      totalMatched: 0,
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("hostLogSharedTimelineSummary", () => {
  it("sends one bounded shared-axis request with exact lane scopes", async () => {
    invokeMock.mockResolvedValue({
      timeQuality: "wall",
      spanFrom: 1,
      spanTo: 2,
      bucketWidth: 1,
      bucketCount: 1,
      totalMatched: 1,
      buckets: [{ index: 0, start: 1, end: 2 }],
      counts: [1],
      severitySeries: [],
      lanes: [],
    });

    await hostLogSharedTimelineSummary(
      "corpus-1",
      { levels: ["error"] },
      [{ sources: ["api.log", "worker.log"] }],
      96,
    );
    expect(invokeMock).toHaveBeenCalledWith("log_shared_timeline_summary", {
      corpusId: "corpus-1",
      query: {
        filter: { levels: ["error"] },
        lanes: [{ sources: ["api.log", "worker.log"] }],
        maxBuckets: 96,
      },
    });
  });

  it("preserves explicit all-sources and large specific-source lane scopes", async () => {
    invokeMock.mockResolvedValue({
      timeQuality: "wall",
      spanFrom: 1,
      spanTo: 2,
      bucketWidth: 1,
      bucketCount: 1,
      totalMatched: 1,
      buckets: [{ index: 0, start: 1, end: 2 }],
      counts: [1],
      severitySeries: [],
      lanes: [],
    });
    const sources = Array.from(
      { length: 241 },
      (_, index) => `region-${index + 1}/application.log`,
    );

    await hostLogSharedTimelineSummary(
      "corpus-241",
      { levels: ["error"] },
      [{ sources: [], allSources: true }, { sources }],
      96,
    );

    expect(invokeMock).toHaveBeenCalledWith("log_shared_timeline_summary", {
      corpusId: "corpus-241",
      query: {
        filter: { levels: ["error"] },
        lanes: [{ sources: [], allSources: true }, { sources }],
        maxBuckets: 96,
      },
    });
    expect(
      invokeMock.mock.calls[0]?.[1]?.query?.lanes?.[1]?.sources,
    ).toHaveLength(241);
  });
});

describe("hostLogSourceCatalog", () => {
  it("uses the dedicated corpus-scoped paginated source command", async () => {
    invokeMock.mockResolvedValue({
      sources: [
        {
          source: "region-b/application.log",
          eventCount: 7,
        },
      ],
      nextCursor: "region-b/application.log",
      totalMatched: 241,
    });

    await expect(
      hostLogSourceCatalog("corpus-1", {
        search: "APPLICATION",
        cursor: "region-a/application.log",
        limit: 40,
      }),
    ).resolves.toMatchObject({
      sources: [{ source: "region-b/application.log", eventCount: 7 }],
      totalMatched: 241,
    });
    expect(invokeMock).toHaveBeenCalledWith("log_source_catalog", {
      corpusId: "corpus-1",
      query: {
        search: "APPLICATION",
        cursor: "region-a/application.log",
        limit: 40,
      },
    });
  });

  it("returns an honest empty catalog outside the desktop host", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object })
      .__TAURI_INTERNALS__;

    await expect(hostLogSourceCatalog("corpus-1")).resolves.toEqual({
      sources: [],
      nextCursor: null,
      totalMatched: 0,
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("preserves distinct full paths with the same basename", async () => {
    invokeMock.mockResolvedValue({
      sources: [
        { source: "cluster-a/runtime.log", eventCount: 3 },
        { source: "cluster-b/runtime.log", eventCount: 4 },
      ],
      nextCursor: "cluster-b/runtime.log",
      totalMatched: 203,
    });

    await expect(
      hostLogSourceCatalog("corpus-2", {
        cursor: "cluster-0/runtime.log",
        limit: 2,
      }),
    ).resolves.toEqual({
      sources: [
        { source: "cluster-a/runtime.log", eventCount: 3 },
        { source: "cluster-b/runtime.log", eventCount: 4 },
      ],
      nextCursor: "cluster-b/runtime.log",
      totalMatched: 203,
    });
  });
});

describe("hostSaveLogDiagnosticReport", () => {
  it("prepares a strict manifest and saves only by opaque id and format", async () => {
    const manifest = {
      schemaVersion: 1 as const,
      generatedAt: "2026-07-29T12:34:56.000Z",
      privacy: {
        redacted: true as const,
        reviewRequired: true as const,
        excluded: [],
      },
      application: {
        version: "0.1.0",
        channel: "dev",
        gitSha: null,
        os: "macOS",
      },
      corpus: null,
      failedIngest: null,
      activeView: null,
      currentStatus: null,
      userNote: null,
    };
    invokeMock.mockResolvedValueOnce({
      reportId: "cdlogdiag-0000000000000001-0000000000000001",
      markdown: "# host rendered",
      json: "{}",
    });
    await expect(hostPrepareLogDiagnosticReport(manifest)).resolves.toEqual({
      reportId: "cdlogdiag-0000000000000001-0000000000000001",
      markdown: "# host rendered",
      json: "{}",
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      "prepare_log_diagnostic_report",
      { request: { manifest } },
    );

    invokeMock.mockResolvedValue({ status: "saved" });

    await expect(
      hostSaveLogDiagnosticReport(
        "cdlogdiag-0000000000000001-0000000000000001",
        "markdown",
      ),
    ).resolves.toEqual({ status: "saved" });

    expect(invokeMock).toHaveBeenCalledWith("save_log_diagnostic_report", {
      request: {
        reportId: "cdlogdiag-0000000000000001-0000000000000001",
        format: "markdown",
      },
    });
    const ipcArgs = JSON.stringify(invokeMock.mock.calls.at(-1)?.[1]);
    expect(ipcArgs).not.toContain("path");
    expect(ipcArgs).not.toContain("overwrite");
    expect(ipcArgs).not.toContain("content");

    invokeMock.mockResolvedValueOnce(true);
    await expect(
      hostReleaseLogDiagnosticReport(
        "cdlogdiag-0000000000000001-0000000000000001",
      ),
    ).resolves.toBe(true);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "release_log_diagnostic_report",
      {
        request: {
          reportId: "cdlogdiag-0000000000000001-0000000000000001",
        },
      },
    );
  });
});

describe("failed-ingest diagnostic host boundary", () => {
  it("reads and explicitly clears only the one transient host DTO", async () => {
    invokeMock
      .mockResolvedValueOnce({
        schemaVersion: 1,
        reasonCode: "no_safe_events",
        redacted: true,
      })
      .mockResolvedValueOnce(true);

    await hostGetFailedLogIngestDiagnostic();
    await hostClearFailedLogIngestDiagnostic();

    expect(invokeMock.mock.calls).toEqual([
      ["get_failed_log_ingest_diagnostic", undefined],
      ["clear_failed_log_ingest_diagnostic", undefined],
    ]);
  });
});

describe("first-run demo corpus host boundary", () => {
  it("invokes only the narrow packaged-demo command in Tauri", async () => {
    invokeMock.mockResolvedValue({
      status: "installed",
      demoIdentity: "contextdesk.demo.logs.seven-day-25k.behavior-scale.v1",
      corpusId: "demo-corpus",
      corpusName: "Demo · seven-day performance triage",
      events: 25_000,
      detail: "installed",
      retryable: false,
    });

    const result = await hostInstallDemoLogCorpus();

    expect(result.status).toBe("installed");
    expect(result.events).toBe(25_000);
    expect(invokeMock).toHaveBeenCalledWith(
      "install_demo_log_corpus",
      undefined,
    );
  });

  it("is honest in browser rendering and never claims an install", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object })
      .__TAURI_INTERNALS__;

    const result = await hostInstallDemoLogCorpus();

    expect(result).toMatchObject({
      status: "unavailable",
      corpusId: null,
      events: null,
      retryable: false,
    });
    expect(result.detail).toContain("installed desktop app");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("profileIdForKind", () => {
  it("maps known kinds to stable keychain profile ids", () => {
    expect(profileIdForKind("ollama")).toBe("ollama-local");
    expect(profileIdForKind("openai_compatible")).toBe("openai-compatible");
    expect(profileIdForKind("anthropic")).toBe("anthropic");
    expect(profileIdForKind("xai_grok_build")).toBe("xai-grok-build");
  });

  it("passes through unknown kinds", () => {
    expect(profileIdForKind("custom")).toBe("custom");
  });
});

describe("normalizeProviderKind", () => {
  it("normalizes ollama and openai_compatible", () => {
    expect(normalizeProviderKind("ollama")).toBe("ollama");
    expect(normalizeProviderKind("openai_compatible")).toBe(
      "openai_compatible",
    );
    expect(normalizeProviderKind("openai-compatible")).toBe(
      "openai_compatible",
    );
  });

  it("keeps anthropic (does not collapse to none)", () => {
    expect(normalizeProviderKind("anthropic")).toBe("anthropic");
    expect(normalizeProviderKind("Anthropic")).toBe("anthropic");
  });

  it("maps grok / xai aliases to xai_grok_build", () => {
    expect(normalizeProviderKind("xai_grok_build")).toBe("xai_grok_build");
    expect(normalizeProviderKind("xai-grok-build")).toBe("xai_grok_build");
    expect(normalizeProviderKind("xaigrokbuild")).toBe("xai_grok_build");
    expect(normalizeProviderKind("grok")).toBe("xai_grok_build");
    expect(normalizeProviderKind("xai")).toBe("xai_grok_build");
  });

  it("returns none for unknown", () => {
    expect(normalizeProviderKind("something-else")).toBe("none");
    expect(normalizeProviderKind("")).toBe("none");
  });
});

describe("modelSelectionKey / parseModelSelectionKey", () => {
  it("round-trips provider and model", () => {
    const key = modelSelectionKey("ollama-local", "mistral");
    expect(key).toMatch(/^cd\.model\.v1:/);
    expect(parseModelSelectionKey(key)).toEqual({
      providerId: "ollama-local",
      modelId: "mistral",
    });
  });

  it("keeps modelId that contains :: after the first separator", () => {
    const key = modelSelectionKey("prov", "org/model::variant");
    expect(key).toMatch(/^cd\.model\.v1:/);
    expect(parseModelSelectionKey(key)).toEqual({
      providerId: "prov",
      modelId: "org/model::variant",
    });
  });

  it("treats keys without :: as model-only", () => {
    expect(parseModelSelectionKey("mistral")).toEqual({
      providerId: null,
      modelId: "mistral",
    });
  });
});

describe("hostLogQueryEventOriginal", () => {
  it("uses a separate per-event IPC request with no ordinary page arguments", async () => {
    invokeMock.mockResolvedValue({
      state: "available",
      label: "Original (redacted)",
      text: "source",
      sourceByteCount: 6,
      redactedCharCount: 6,
      storedCharCount: 6,
      truncated: false,
      encodingNormalized: false,
      redactionApplied: false,
    });

    await expect(
      hostLogQueryEventOriginal("corpus-1", 42),
    ).resolves.toMatchObject({
      state: "available",
      text: "source",
    });
    expect(invokeMock).toHaveBeenCalledWith("log_query_event_original", {
      corpusId: "corpus-1",
      seq: 42,
    });
  });

  it("refuses to imply an original representation outside the desktop host", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object })
      .__TAURI_INTERNALS__;
    await expect(hostLogQueryEventOriginal("corpus-1", 42)).rejects.toThrow(
      "requires the desktop app",
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("engineering handbook host boundary (#683)", () => {
  it("opens one host-owned window and reads or resolves only through host commands", async () => {
    invokeMock
      .mockResolvedValueOnce("engineering-handbook")
      .mockResolvedValueOnce({
        id: "docs/design/PROVEN_METHODS.md",
        title: "Proven methods handbook",
        body: "# Proven methods handbook",
      })
      .mockResolvedValueOnce({
        kind: "internal",
        pageId: "docs/design/LOG_EXPLORER.md",
      });

    await expect(hostOpenEngineeringHandbook()).resolves.toBe(
      "engineering-handbook",
    );
    await hostGetHandbookPage("docs/design/PROVEN_METHODS.md");
    await hostResolveHandbookLink(
      "docs/design/PROVEN_METHODS.md",
      "LOG_EXPLORER.md",
    );
    invokeMock.mockResolvedValueOnce(4096);
    await hostExportHandbookDocument({
      path: "/tmp/handbook.html",
      scope: "complete",
      format: "html",
      renderedHtml:
        '<!doctype html><html data-contextdesk-handbook-export="1"></html>',
    });

    expect(invokeMock.mock.calls).toEqual([
      ["open_engineering_handbook", undefined],
      ["get_handbook_page", { id: "docs/design/PROVEN_METHODS.md" }],
      [
        "resolve_handbook_link",
        {
          fromPageId: "docs/design/PROVEN_METHODS.md",
          target: "LOG_EXPLORER.md",
        },
      ],
      [
        "export_handbook_document",
        {
          path: "/tmp/handbook.html",
          scope: "complete",
          format: "html",
          pageId: null,
          renderedHtml:
            '<!doctype html><html data-contextdesk-handbook-export="1"></html>',
        },
      ],
    ]);
  });
});
