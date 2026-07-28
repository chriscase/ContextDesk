import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostLogQueryEventOriginal,
  hostLogSharedTimelineSummary,
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
