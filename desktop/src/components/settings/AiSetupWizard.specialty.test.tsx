/**
 * Wizard specialty/unknown inventory must remain Apply-confirmable (#723).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AppSetupState } from "../../lib/preflight";
import { AiSetupWizard } from "./AiSetupWizard";

const probe = vi.fn();

vi.mock("../../lib/host", async () => {
  const actual = await vi.importActual<typeof import("../../lib/host")>(
    "../../lib/host",
  );
  return {
    ...actual,
    hostProbeAiGateway: (...args: unknown[]) => probe(...args),
    hostListModelsForDraft: vi.fn(),
  };
});

function draft(over: Partial<AppSetupState> = {}): AppSetupState {
  return {
    dataDirWritable: true,
    workspaceName: "Workspace",
    workspaceRoots: ["/tmp/ws"],
    providerLabel: "Ollama",
    providerKind: "ollama",
    chatModel: "",
    baseUrl: "http://127.0.0.1:11434",
    hasApiKey: false,
    ollamaReachable: true,
    remoteReachable: null,
    confluence: { enabled: false, baseUrl: "", spaces: "", hasToken: false },
    ...over,
  };
}

describe("AiSetupWizard specialty inventory (#723)", () => {
  beforeEach(() => {
    probe.mockReset();
  });

  it("specialty-only single model sets pickedModel so Apply can confirm it", async () => {
    probe.mockResolvedValue({
      ok: true,
      flavor: "ollama",
      base_url: "http://127.0.0.1:11434",
      effective_base_url: "http://127.0.0.1:11434",
      models: [{ id: "bge-m3", kind: "embedding", source: "ollama" }],
      chat_candidates: [],
      embed_candidates: [{ id: "bge-m3", kind: "embedding", source: "ollama" }],
      notes: [],
      errors: [],
      local_ollama_reachable: true,
      local_ollama_models: [],
    });

    const onApplyAndSave = vi.fn();
    render(
      <AiSetupWizard
        baseId="wiz"
        draft={draft()}
        setDraft={vi.fn()}
        apiKeyDraft=""
        setApiKeyDraft={vi.fn()}
        candidates={[]}
        onApplyAndSave={onApplyAndSave}
      />,
    );

    // Start path is ollama; open configure if needed, then Discover options.
    const ollamaPath = screen.queryByRole("button", { name: /Ollama/i });
    if (ollamaPath) {
      fireEvent.click(ollamaPath);
    }
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /Discover options/i }),
      );
    });

    await waitFor(() => expect(probe).toHaveBeenCalled());

    // Select should show bge-m3 and Apply must be enabled with that id bound.
    await waitFor(() => {
      const select = screen.getByLabelText(/Chat model/i) as HTMLSelectElement;
      expect(select.value).toBe("bge-m3");
    });

    const apply = screen.getByRole("button", {
      name: /Apply & Save/i,
    }) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    await waitFor(() => expect(onApplyAndSave).toHaveBeenCalled());
    const payload = onApplyAndSave.mock.calls[0]?.[0] as {
      setup: { chatModel: string };
    };
    expect(payload.setup.chatModel).toBe("bge-m3");
  });
});
