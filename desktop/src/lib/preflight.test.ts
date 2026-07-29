import { describe, expect, it } from "vitest";
import { runClientPreflight, type AppSetupState } from "./preflight";

function baseSetup(over: Partial<AppSetupState> = {}): AppSetupState {
  return {
    dataDirWritable: true,
    workspaceName: "Workspace",
    workspaceRoots: ["/tmp/ws"],
    providerLabel: null,
    providerKind: "none",
    chatModel: "",
    baseUrl: "",
    hasApiKey: false,
    ollamaReachable: null,
    remoteReachable: null,
    confluence: { enabled: false, baseUrl: "", spaces: "", hasToken: false },
    ...over,
  };
}

describe("runClientPreflight anthropic", () => {
  it("passes provider.active when Anthropic is selected", () => {
    const report = runClientPreflight(
      baseSetup({
        providerKind: "anthropic",
        providerLabel: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        chatModel: "claude-sonnet-4-20250514",
        hasApiKey: true,
      }),
    );
    const active = report.items.find((i) => i.id === "provider.active");
    expect(active?.level).toBe("pass");
    expect(active?.detail).toContain("Anthropic");
  });

  it("provider.model detail includes Suggested-for and Basis name-hint honesty", () => {
    const report = runClientPreflight(
      baseSetup({
        providerKind: "anthropic",
        providerLabel: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        chatModel: "claude-sonnet-4-20250514",
        hasApiKey: true,
      }),
    );
    const model = report.items.find((i) => i.id === "provider.model");
    expect(model?.level).toBe("pass");
    expect(model?.detail).toMatch(/Model: claude-sonnet-4-20250514/);
    expect(model?.detail).toMatch(/Suggested for:/);
    expect(model?.detail).toMatch(/Basis: Name hint/);
    expect(model?.detail).toMatch(/not measured capability/i);
  });

  it("provider.model for embedding-shaped id still passes but labels specialty", () => {
    const report = runClientPreflight(
      baseSetup({
        providerKind: "ollama",
        providerLabel: "Ollama",
        baseUrl: "http://127.0.0.1:11434",
        chatModel: "bge-m3",
        ollamaReachable: true,
      }),
    );
    const model = report.items.find((i) => i.id === "provider.model");
    expect(model?.detail).toMatch(/embedding/);
    expect(model?.detail).toMatch(/Basis: Name hint/);
  });

  it("fails provider.key when Anthropic has no key (not silently healthy)", () => {
    const report = runClientPreflight(
      baseSetup({
        providerKind: "anthropic",
        providerLabel: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        chatModel: "claude-sonnet-4-20250514",
        hasApiKey: false,
      }),
    );
    const key = report.items.find((i) => i.id === "provider.key");
    expect(key?.level).toBe("fail");
    const url = report.items.find((i) => i.id === "provider.url");
    expect(url?.level).toBe("pass");
  });

  it("fails provider.url when Anthropic base is empty", () => {
    const report = runClientPreflight(
      baseSetup({
        providerKind: "anthropic",
        providerLabel: "Anthropic",
        baseUrl: "",
        chatModel: "claude-test",
        hasApiKey: true,
      }),
    );
    const url = report.items.find((i) => i.id === "provider.url");
    expect(url?.level).toBe("fail");
  });
});
