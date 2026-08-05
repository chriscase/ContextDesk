import { act, renderHook, waitFor } from "@testing-library/react";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Dispatch, SetStateAction } from "react";
import type { EventDto } from "../lib/host";
import type { AppSetupState } from "../lib/preflight";
import {
  newSession,
  type ChatSession,
} from "../lib/session";
import {
  classifyCompletedCitation,
  useTurnController,
} from "./useTurnController";

const host = vi.hoisted(() => ({
  agentTurn: vi.fn(),
  completePermission: vi.fn(),
  hostCancelTurn: vi.fn(),
  hostReadFile: vi.fn(),
}));

vi.mock("../lib/host", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/host")>();
  return {
    ...original,
    agentTurn: host.agentTurn,
    completePermission: host.completePermission,
    hostCancelTurn: host.hostCancelTurn,
    hostReadFile: host.hostReadFile,
  };
});

const setup: AppSetupState = {
  dataDirWritable: true,
  workspaceName: "Test",
  workspaceRoots: ["/workspace"],
  providerLabel: "Test provider",
  providerKind: "openai_compatible",
  chatModel: "test-model",
  baseUrl: "https://example.invalid/v1",
  hasApiKey: true,
  ollamaReachable: null,
  remoteReachable: true,
  confluence: {
    enabled: false,
    baseUrl: "",
    spaces: "",
    hasToken: false,
  },
};

function completedTurnWithCitation(citationId: string) {
  host.agentTurn.mockImplementation(
    async (...args: unknown[]): Promise<EventDto[]> => {
      const onEvent = args[5] as ((event: EventDto) => void) | undefined;
      const events: EventDto[] = [
        {
          kind: "citation",
          payload: {
            source_id: citationId,
            label: citationId,
          },
        },
        { kind: "turn_completed", payload: {} },
      ];
      events.forEach((event) => onEvent?.(event));
      return events;
    },
  );
}

function renderCompletedTurn(citationId: string) {
  const initial = newSession("Routing test");
  let sessions: ChatSession[] = [initial];
  const setSessions: Dispatch<SetStateAction<ChatSession[]>> = (update) => {
    sessions =
      typeof update === "function" ? update(sessions) : update;
  };
  const setSourcePath = vi.fn();
  const setSourceContent = vi.fn();
  completedTurnWithCitation(citationId);

  const rendered = renderHook(() =>
    useTurnController({
      sessionId: initial.id,
      resolvedSessionId: initial.id,
      sessions,
      setSessions,
      ensureActiveSession: () => initial,
      setup,
      modelOptions: [],
      defaultModelKey: "",
      preflightBlocking: false,
      onNeedPreflight: vi.fn(),
      persistSession: vi.fn(async (session) => session),
      upgradeTitleWithLlm: vi.fn(async () => undefined),
      pinScrollToEnd: vi.fn(),
      refreshMemory: vi.fn(async () => undefined),
      refreshChatModels: vi.fn(async () => undefined),
      setSourcePath,
      setSourceContent,
      setPaneChat: vi.fn(),
    }),
  );

  return {
    ...rendered,
    setSourcePath,
    setSourceContent,
  };
}

async function finishTurn(citationId: string) {
  const harness = renderCompletedTurn(citationId);
  await act(async () => {
    await harness.result.current.startTurn("Investigate this.");
  });
  return harness;
}

describe("useTurnController completed citation routing (#701)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    host.hostReadFile.mockResolvedValue("file body");
  });

  it("forwards explicit one-turn selection without inventing it for ordinary sends", async () => {
    const selected = renderCompletedTurn("help://log-analysis-pipeline#pipeline");
    await act(async () => {
      await selected.result.current.startTurn(
        "Use this context.",
        "  CONTROLLER_SELECTION_TOKEN_2M7Q  ",
      );
    });
    expect(host.agentTurn.mock.calls[0]?.[9]).toEqual(
      expect.objectContaining({
        userSelection: "CONTROLLER_SELECTION_TOKEN_2M7Q",
      }),
    );

    host.agentTurn.mockClear();
    const ordinary = renderCompletedTurn("help://log-analysis-pipeline#pipeline");
    await act(async () => {
      await ordinary.result.current.startTurn("Ordinary turn.");
    });
    expect(host.agentTurn.mock.calls[0]?.[9]).not.toHaveProperty(
      "userSelection",
    );
  });

  it.each(["log_template:7", "log_event:42"])(
    "keeps governed evidence %s out of the workspace file reader",
    async (citationId) => {
      const { result, setSourcePath, setSourceContent } =
        await finishTurn(citationId);

      expect(host.hostReadFile).not.toHaveBeenCalled();
      expect(setSourcePath).not.toHaveBeenCalled();
      expect(setSourceContent).not.toHaveBeenCalledWith(
        expect.stringContaining("Could not read file"),
      );
      expect(result.current.agentError).toBeNull();
    },
  );

  it("keeps canonical Help citations on their existing click-routed path", async () => {
    const { result, setSourcePath, setSourceContent } = await finishTurn(
      "help://log-analysis-pipeline#pipeline",
    );

    expect(host.hostReadFile).not.toHaveBeenCalled();
    expect(setSourcePath).not.toHaveBeenCalled();
    expect(setSourceContent).not.toHaveBeenCalled();
    expect(result.current.agentError).toBeNull();
  });

  it("preserves automatic loading for ordinary file citations", async () => {
    const { setSourcePath, setSourceContent } = await finishTurn(
      "/workspace/logs/service.log",
    );

    expect(setSourcePath).toHaveBeenCalledWith(
      "/workspace/logs/service.log",
    );
    expect(host.hostReadFile).toHaveBeenCalledWith(
      "/workspace/logs/service.log",
    );
    await waitFor(() =>
      expect(setSourceContent).toHaveBeenCalledWith("file body"),
    );
  });

  it.each([
    "help://../secret",
    "log_template:",
    "log_event:42/../../secret",
    "unknown://resource",
  ])("fails closed and visibly for malformed or unknown locator %s", async (id) => {
    const { result, setSourcePath, setSourceContent } = await finishTurn(id);

    expect(host.hostReadFile).not.toHaveBeenCalled();
    expect(setSourcePath).not.toHaveBeenCalled();
    expect(setSourceContent).not.toHaveBeenCalled();
    expect(result.current.agentError).toMatch(
      /unsupported or malformed citation/i,
    );
  });
});

describe("classifyCompletedCitation", () => {
  it("recognizes only canonical governed and in-app locator forms", () => {
    expect(classifyCompletedCitation("help://log-explorer#lanes")).toBe(
      "help",
    );
    // Non-u64 legacy forms fail closed (never file I/O); only digits are "log".
    expect(classifyCompletedCitation("log_template:template-17")).toBe(
      "invalid",
    );
    expect(classifyCompletedCitation("log_event:event_42")).toBe("invalid");
    expect(classifyCompletedCitation("log_event:42")).toBe("log");
    expect(classifyCompletedCitation("log_template:7")).toBe("log");
    expect(classifyCompletedCitation("https://example.com/evidence")).toBe(
      "deferred",
    );
    expect(classifyCompletedCitation("memory:note-1")).toBe("deferred");
    expect(classifyCompletedCitation("custom:opaque")).toBe("invalid");
    expect(classifyCompletedCitation("relative/path.md")).toBe("file");
    expect(classifyCompletedCitation("C:\\workspace\\notes.md")).toBe("file");
  });
});
