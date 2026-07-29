import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostExportHandbookDocument,
  hostClearFailedLogIngestDiagnostic,
  hostGetFailedLogIngestDiagnostic,
  hostGetHandbookPage,
  hostOpenEngineeringHandbook,
  hostResolveHandbookLink,
  hostLogQueryEventOriginal,
  hostLogSharedTimelineSummary,
  hostSaveLogDiagnosticReport,
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
});

describe("hostSaveLogDiagnosticReport", () => {
  it("sends only the selected path, explicit format, and bounded report content", async () => {
    invokeMock.mockResolvedValue(undefined);

    await hostSaveLogDiagnosticReport(
      "/tmp/contextdesk-diagnostic.md",
      "markdown",
      "# redacted diagnostic",
      true,
    );

    expect(invokeMock).toHaveBeenCalledWith("save_log_diagnostic_report", {
      path: "/tmp/contextdesk-diagnostic.md",
      format: "markdown",
      content: "# redacted diagnostic",
      overwriteConfirmed: true,
    });
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
    expect(key).toBe("ollama-local::mistral");
    expect(parseModelSelectionKey(key)).toEqual({
      providerId: "ollama-local",
      modelId: "mistral",
    });
  });

  it("keeps modelId that contains :: after the first separator", () => {
    const key = modelSelectionKey("prov", "org/model::variant");
    expect(key).toBe("prov::org/model::variant");
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
