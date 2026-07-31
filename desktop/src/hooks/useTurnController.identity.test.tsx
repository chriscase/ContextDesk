/**
 * Turn identity under concurrency.
 *
 * `busy` and the streaming transcript are app-global, but a turn belongs to one
 * conversation. These cover the ways that ownership used to be lost: stopping
 * after a chat switch, answering a permission prompt after a chat switch, a
 * cancelled turn's late deltas landing on a replacement turn, and two sends
 * dispatched inside one frame.
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Dispatch, SetStateAction } from "react";
import type { EventDto } from "../lib/host";
import type { AppSetupState } from "../lib/preflight";
import { newSession, type ChatSession } from "../lib/session";
import { useTurnController } from "./useTurnController";

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
  confluence: { enabled: false, baseUrl: "", spaces: "", hasToken: false },
};

type Harness = ReturnType<typeof mountTwoChats>;

/** Two open chats, A active, with a controllable in-flight turn. */
function mountTwoChats() {
  const a = newSession("Chat A");
  const b = newSession("Chat B");
  let sessions: ChatSession[] = [a, b];
  const setSessions: Dispatch<SetStateAction<ChatSession[]>> = (update) => {
    sessions = typeof update === "function" ? update(sessions) : update;
  };

  let activeId = a.id;
  const rendered = renderHook(() =>
    useTurnController({
      sessionId: activeId,
      resolvedSessionId: activeId,
      sessions,
      setSessions,
      ensureActiveSession: () => sessions.find((s) => s.id === activeId) ?? a,
      setup,
      modelOptions: [],
      defaultModelKey: "",
      preflightBlocking: false,
      onNeedPreflight: vi.fn(),
      persistSession: vi.fn(async (session: ChatSession) => session),
      upgradeTitleWithLlm: vi.fn(async () => undefined),
      pinScrollToEnd: vi.fn(),
      refreshMemory: vi.fn(async () => undefined),
      setSourcePath: vi.fn(),
      setSourceContent: vi.fn(),
      setPaneChat: vi.fn(),
    }),
  );

  return {
    a,
    b,
    rendered,
    get sessions() {
      return sessions;
    },
    /** Simulate the user selecting the other chat while a turn runs. */
    switchTo(id: string) {
      activeId = id;
      rendered.rerender();
    },
    session(id: string) {
      const found = sessions.find((s) => s.id === id);
      if (!found) throw new Error(`no session ${id}`);
      return found;
    },
  };
}

function streaming(h: Harness, id: string): boolean {
  return h.session(id).messages.some((m) => m.streaming === true);
}

/** An agentTurn that emits partial text then blocks until released. */
function pendingTurn() {
  let release!: () => void;
  let emit!: (ev: EventDto) => void;
  const started = new Promise<void>((resolveStarted) => {
    host.agentTurn.mockImplementation(async (...args: unknown[]) => {
      const onEvent = args[5] as (ev: EventDto) => void;
      emit = onEvent;
      onEvent({ kind: "text_delta", payload: { text: "partial " } });
      resolveStarted();
      await new Promise<void>((r) => {
        release = r;
      });
      return [];
    });
  });
  return {
    started,
    emitLate: (ev: EventDto) => emit(ev),
    finish: () => release(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  host.hostCancelTurn.mockResolvedValue(undefined);
  host.completePermission.mockResolvedValue([]);
});

describe("stop targets the conversation that owns the turn", () => {
  it("cancels the streaming chat, not the one the user switched to", async () => {
    const h = mountTwoChats();
    const turn = pendingTurn();

    let pending!: Promise<boolean>;
    await act(async () => {
      pending = h.rendered.result.current.startTurn("Investigate A");
      await turn.started;
    });

    // User switches to the other chat mid-stream; `busy` is global so the
    // composer over there still shows Stop.
    h.switchTo(h.b.id);
    await act(async () => {
      h.rendered.result.current.stopTurn();
    });

    expect(host.hostCancelTurn).toHaveBeenCalledTimes(1);
    expect(host.hostCancelTurn).toHaveBeenCalledWith(h.a.id);
    expect(streaming(h, h.a.id)).toBe(false);
    expect(h.session(h.b.id).messages).toHaveLength(0);

    turn.finish();
    await act(async () => {
      await pending;
    });
  });
});

describe("late events from a retired turn", () => {
  it("cannot re-mark a stopped bubble as streaming after a new send", async () => {
    const h = mountTwoChats();
    const first = pendingTurn();

    let firstPending!: Promise<boolean>;
    await act(async () => {
      firstPending = h.rendered.result.current.startTurn("First");
      await first.started;
    });

    await act(async () => {
      h.rendered.result.current.stopTurn();
    });
    expect(streaming(h, h.a.id)).toBe(false);

    // A replacement turn starts while the cancelled host call is still draining.
    const second = pendingTurn();
    let secondPending!: Promise<boolean>;
    await act(async () => {
      secondPending = h.rendered.result.current.startTurn("Second");
      await second.started;
    });

    // The stopped turn's buffered delta arrives late.
    await act(async () => {
      first.emitLate({ kind: "text_delta", payload: { text: "zombie" } });
    });

    const revived = h
      .session(h.a.id)
      .messages.filter((m) => m.content.includes("zombie"));
    expect(revived).toHaveLength(0);

    first.finish();
    second.finish();
    await act(async () => {
      await Promise.all([firstPending, secondPending]);
    });
  });
});

describe("double send in one frame", () => {
  it("starts exactly one turn and rejects the second so the draft survives", async () => {
    const h = mountTwoChats();
    const turn = pendingTurn();

    let firstResult!: Promise<boolean>;
    let secondResult!: Promise<boolean>;
    await act(async () => {
      // Both dispatched before React can flush `busy` to the composer.
      firstResult = h.rendered.result.current.startTurn("Same frame");
      secondResult = h.rendered.result.current.startTurn("Same frame");
      await turn.started;
    });

    expect(host.agentTurn).toHaveBeenCalledTimes(1);
    // Rejection is the signal the composer uses to restore the draft.
    await expect(secondResult).resolves.toBe(false);

    const users = h.session(h.a.id).messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);

    turn.finish();
    await act(async () => {
      await firstResult;
    });
  });
});

describe("permission replies stay with the requesting chat", () => {
  it("routes an approved write and its result to the chat that asked", async () => {
    const h = mountTwoChats();
    let emit!: (ev: EventDto) => void;
    let release!: () => void;
    const asked = new Promise<void>((resolveAsked) => {
      host.agentTurn.mockImplementation(async (...args: unknown[]) => {
        emit = args[5] as (ev: EventDto) => void;
        emit({
          kind: "permission_required",
          payload: {
            request_id: "req-1",
            tool_name: "save_memory",
            side_effect: "SoftWrite",
            target: "memory/note.md",
            preview: "draft",
            arguments: { content: "hello" },
          },
        });
        resolveAsked();
        await new Promise<void>((r) => {
          release = r;
        });
        return [];
      });
    });

    let pending!: Promise<boolean>;
    await act(async () => {
      pending = h.rendered.result.current.startTurn("Remember this");
      await asked;
    });
    expect(h.rendered.result.current.permission).not.toBeNull();

    host.completePermission.mockResolvedValue([
      { kind: "tool", payload: { name: "save_memory", ok: true } },
    ]);

    // User wanders to the other chat before approving.
    h.switchTo(h.b.id);
    await act(async () => {
      await h.rendered.result.current.respondPermission("allow_once");
    });

    const [, , , , , forwardedSession] = host.completePermission.mock.calls[0]!;
    expect(forwardedSession).toBe(h.a.id);
    expect(h.session(h.b.id).messages).toHaveLength(0);
    expect(h.session(h.a.id).messages.length).toBeGreaterThan(1);

    release();
    await act(async () => {
      await pending;
    });
  });

  it("reports a failed write in the thread instead of a global app error", async () => {
    const h = mountTwoChats();
    let release!: () => void;
    const asked = new Promise<void>((resolveAsked) => {
      host.agentTurn.mockImplementation(async (...args: unknown[]) => {
        const onEvent = args[5] as (ev: EventDto) => void;
        onEvent({
          kind: "permission_required",
          payload: {
            request_id: "req-2",
            tool_name: "save_memory",
            side_effect: "SoftWrite",
            target: "memory/note.md",
            preview: "draft",
            arguments: {},
          },
        });
        resolveAsked();
        await new Promise<void>((r) => {
          release = r;
        });
        return [];
      });
    });

    let pending!: Promise<boolean>;
    await act(async () => {
      pending = h.rendered.result.current.startTurn("Write something");
      await asked;
    });

    host.completePermission.mockRejectedValue(
      new Error("save_memory requires body_markdown or content"),
    );

    await act(async () => {
      await h.rendered.result.current.respondPermission("allow_once");
    });

    expect(h.rendered.result.current.agentError).toBeNull();
    const last = h.session(h.a.id).messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.content).toContain("save_memory was not completed");
    expect(last.content).toContain("Nothing was written");
    // The prompt must be gone, not left dangling over the thread.
    expect(h.rendered.result.current.permission).toBeNull();

    release();
    await act(async () => {
      await pending;
    });
  });
});

describe("host-persisted terminal turns", () => {
  it("hands the host this transcript's ids so it cannot duplicate the turn", async () => {
    const h = mountTwoChats();
    host.agentTurn.mockResolvedValue([]);

    await act(async () => {
      await h.rendered.result.current.startTurn("Anything");
    });

    const call = host.agentTurn.mock.calls[0]!;
    const transcriptIds = call[9] as {
      userMessageId?: string | null;
      assistantMessageId?: string | null;
    };
    const messages = h.session(h.a.id).messages;
    expect(transcriptIds.userMessageId).toBe(
      messages.find((m) => m.role === "user")!.id,
    );
    expect(transcriptIds.assistantMessageId).toBe(
      messages.find((m) => m.role === "assistant")!.id,
    );
  });
});
