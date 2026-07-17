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
