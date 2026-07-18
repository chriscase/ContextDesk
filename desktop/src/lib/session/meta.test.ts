import { describe, expect, it } from "vitest";
import { formatMsgMetaFooter, snapshotMessageMeta } from "./meta";
import type { AppSetupState } from "../preflight";

const setup: AppSetupState = {
  dataDirWritable: true,
  workspaceName: null,
  workspaceRoots: [],
  providerLabel: "Ollama (local)",
  providerKind: "ollama",
  chatModel: "mistral",
  baseUrl: "http://127.0.0.1:11434",
  hasApiKey: false,
  localOnly: true,
  ollamaReachable: null,
  remoteReachable: null,
  confluence: { enabled: false, baseUrl: "", spaces: "", hasToken: false },
  x: { enabled: false, hasToken: false },
  webResearchEnabled: false,
};

describe("formatMsgMetaFooter (#146)", () => {
  it("labels unconfirmed as requested:", () => {
    const s = formatMsgMetaFooter({
      model: "mistral",
      host_confirmed: false,
      requested_model: "mistral",
    });
    expect(s.startsWith("requested:")).toBe(true);
  });

  it("shows host-confirmed model without requested prefix", () => {
    const s = formatMsgMetaFooter({
      model: "llama3.2",
      host_confirmed: true,
    });
    expect(s).toContain("llama3.2");
    expect(s.includes("requested:")).toBe(false);
  });
});

describe("snapshotMessageMeta (#146)", () => {
  it("captures requested model from session", () => {
    const m = snapshotMessageMeta({
      sessionModel: "mistral",
      sessionProvider: null,
      modelOptions: [
        {
          id: "mistral",
          selection_key: "ollama::mistral",
          label: "mistral",
          provider_id: "ollama",
          provider_label: "Ollama",
          group: "Local",
          is_default: true,
        },
      ],
      defaultModelKey: "ollama::mistral",
      setup,
    });
    expect(m.model).toBe("mistral");
    expect(m.host_confirmed).toBe(false);
    expect(m.requested_model).toBe("mistral");
  });
});
