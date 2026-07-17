import { describe, expect, it } from "vitest";
import {
  modelSelectionKey,
  normalizeProviderKind,
  parseModelSelectionKey,
  profileIdForKind,
} from "./host";

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
    expect(normalizeProviderKind("openai_compatible")).toBe("openai_compatible");
    expect(normalizeProviderKind("openai-compatible")).toBe("openai_compatible");
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
