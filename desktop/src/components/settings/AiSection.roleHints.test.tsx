/**
 * AiSection model discovery + role-hint defaults (#723).
 * Drives the real AiSection with mocked host list_models.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useState } from "react";
import type { AppSetupState } from "../../lib/preflight";
import { AiSection } from "./AiSection";

const listModels = vi.fn();

vi.mock("../../lib/host", async () => {
  const actual = await vi.importActual<typeof import("../../lib/host")>(
    "../../lib/host",
  );
  return {
    ...actual,
    hostListModelsForDraft: (...args: unknown[]) => listModels(...args),
    hostSetProviderToolsEnabled: vi.fn(),
  };
});

function baseDraft(over: Partial<AppSetupState> = {}): AppSetupState {
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

function Harness({ initial }: { initial: AppSetupState }) {
  const [draft, setDraft] = useState(initial);
  return (
    <div>
      <div data-testid="chat-model-value">{draft.chatModel}</div>
      <AiSection
        baseId="test-ai"
        draft={draft}
        setDraft={setDraft}
        candidates={[]}
        apiKeyDraft=""
        setApiKeyDraft={vi.fn()}
        probeNote={null}
        remoteUrlCheck={{}}
        urlError={null}
        recheck={vi.fn()}
        checking={false}
      />
    </div>
  );
}

describe("AiSection role-hint defaults (#723)", () => {
  beforeEach(() => {
    listModels.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it("does not overwrite a non-empty chatModel on rediscover", async () => {
    listModels.mockResolvedValue(["grok-3", "bge-m3", "mistral"]);
    render(
      <Harness
        initial={baseDraft({ chatModel: "user-chosen-private-id" })}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await waitFor(() => expect(listModels).toHaveBeenCalled());
    expect(screen.getByTestId("chat-model-value").textContent).toBe(
      "user-chosen-private-id",
    );
  });

  it("auto-fills only ordinary chat defaults, never specialty-only inventory", async () => {
    listModels.mockResolvedValue(["bge-m3", "qwen3-reranker-0.6b", "grok-3"]);
    render(<Harness initial={baseDraft({ chatModel: "" })} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await waitFor(() =>
      expect(screen.getByTestId("chat-model-value").textContent).toBe("grok-3"),
    );

    listModels.mockResolvedValue(["bge-m3", "qwen3-reranker-0.6b"]);
    // Remount with empty model + specialty-only list
    const { unmount } = render(
      <Harness initial={baseDraft({ chatModel: "" })} />,
    );
    unmount();
    render(<Harness initial={baseDraft({ chatModel: "" })} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await waitFor(() => expect(listModels).toHaveBeenCalled());
    // Specialty-only: leave empty for explicit user choice
    expect(screen.getAllByTestId("chat-model-value").at(-1)?.textContent).toBe(
      "",
    );
  });

  it("shows Suggested-for hint for the current chat model", async () => {
    listModels.mockResolvedValue(["grok-3", "bge-m3"]);
    render(
      <Harness initial={baseDraft({ chatModel: "bge-m3" })} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await waitFor(() =>
      expect(screen.getByTestId("model-role-hint").textContent).toMatch(
        /embedding/,
      ),
    );
    expect(screen.getByTestId("model-role-hint").textContent).toMatch(
      /Basis: Name hint/,
    );
  });

  it("shows exactly one role hint for a custom model id", async () => {
    listModels.mockResolvedValue(["grok-3", "bge-m3"]);
    render(
      <Harness initial={baseDraft({ chatModel: "corp-private-deployment" })} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await waitFor(() => expect(listModels).toHaveBeenCalled());

    const hints = screen.getAllByTestId("model-role-hint");
    expect(hints).toHaveLength(1);
    expect(hints[0]?.textContent).toContain("Unqualified");
  });
});
