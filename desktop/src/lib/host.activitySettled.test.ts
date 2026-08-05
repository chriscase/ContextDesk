import { beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeTurnActivityUpdate } from "./activity/turnActivityUpdateBridge";

/**
 * Blocker 3 (#developer-activity settle): the host must emit a real Tauri
 * event telling `ChatPane` that a settled turn's activity record is now
 * readable, so a cached placeholder ("not recorded by host" / stale-pending)
 * gets replaced without a remount. This used to only happen from
 * `completePermission`'s hand call to `publishTurnActivityUpdate`; an
 * ordinary turn settling never triggered it at all.
 *
 * This test proves the fix by driving the REAL production call path:
 * `agentTurn`'s own `Channel` callback in `host.ts`, exactly as Tauri would
 * invoke it for a real `activity_settled` EventDto — not by calling
 * `publishTurnActivityUpdate` directly and not by hand-dispatching a
 * `window.dispatchEvent(new CustomEvent(...))`. Only the outer Tauri IPC
 * transport (`invoke` / `Channel`) is mocked, because no real Tauri runtime
 * exists in a unit test; everything downstream of that boundary is the
 * genuine `host.ts` code.
 */

type CapturedChannel = {
  onmessage: (event: unknown) => void;
};

const { invokeMock, channels } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  channels: [] as CapturedChannel[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {
    onmessage: (event: unknown) => void;
    constructor(onmessage?: (event: unknown) => void) {
      this.onmessage = onmessage ?? (() => undefined);
      channels.push(this);
    }
  },
}));

beforeEach(() => {
  invokeMock.mockReset();
  channels.length = 0;
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ =
    {};
});

describe("agentTurn activity_settled (real host emit path)", () => {
  it("puts explicit selection on the Tauri request only when supplied", async () => {
    const { agentTurn } = await import("./host");
    invokeMock.mockResolvedValue(undefined);

    await agentTurn("session-a", "selected", false, null, null, undefined, null, null, false, {
      assistantMessageId: "assistant-1",
      userSelection: "DESKTOP_SELECTION_TOKEN_P4M2",
    });
    await agentTurn("session-b", "ordinary", false, null, null, undefined, null, null, false, {
      assistantMessageId: "assistant-2",
    });

    const firstReq = invokeMock.mock.calls[0]![1].req;
    const secondReq = invokeMock.mock.calls[1]![1].req;
    expect(firstReq.user_selection).toBe("DESKTOP_SELECTION_TOKEN_P4M2");
    expect(secondReq.user_selection).toBeNull();
  });

  it("republishes the turn-activity-update bridge when the host emits activity_settled for this exact session", async () => {
    const { agentTurn } = await import("./host");

    // Simulate the real host: while the `agent_turn` command is in flight,
    // it streams EventDtos through the Channel — including, once
    // `record_turn_activity` has published the settled record,
    // `{ kind: "activity_settled", payload: { session_id, message_id } }`.
    invokeMock.mockImplementation(async () => {
      const channel = channels.at(-1);
      expect(channel).toBeDefined();
      channel!.onmessage({
        kind: "activity_settled",
        payload: { session_id: "session-a", message_id: "assistant-1" },
      });
    });

    const listener = vi.fn();
    const stop = subscribeTurnActivityUpdate(listener);
    try {
      await agentTurn("session-a", "hello", false, null, null, undefined, null, null, false, {
        assistantMessageId: "assistant-1",
      });
    } finally {
      stop();
    }

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ sessionId: "session-a" });
  });

  it("does not republish for a different session, and never leaks the settle plumbing into onEvent", async () => {
    const { agentTurn } = await import("./host");

    invokeMock.mockImplementation(async () => {
      const channel = channels.at(-1);
      channel!.onmessage({
        kind: "activity_settled",
        payload: { session_id: "different-session", message_id: "assistant-1" },
      });
    });

    const listener = vi.fn();
    const stop = subscribeTurnActivityUpdate(listener);
    const onEvent = vi.fn();
    try {
      const collected = await agentTurn(
        "session-a",
        "hello",
        false,
        null,
        null,
        onEvent,
        null,
        null,
        false,
        { assistantMessageId: "assistant-1" },
      );
      // The settle signal is plumbing, not a chat event: it must not reach
      // the ordinary event batch/reducer.
      expect(collected).toEqual([]);
      expect(onEvent).not.toHaveBeenCalled();
    } finally {
      stop();
    }

    expect(listener).not.toHaveBeenCalled();
  });
});
