import { describe, expect, it, vi } from "vitest";
import {
  publishTurnActivityUpdate,
  subscribeTurnActivityUpdate,
} from "./turnActivityUpdateBridge";

describe("turn activity update bridge", () => {
  it("delivers the exact owning session and stops after unsubscribe", () => {
    const listener = vi.fn();
    const stop = subscribeTurnActivityUpdate(listener);
    publishTurnActivityUpdate({ sessionId: "session-a" });
    stop();
    publishTurnActivityUpdate({ sessionId: "session-b" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ sessionId: "session-a" });
  });

  it("carries a retirement update distinctly from an ordinary one", () => {
    const listener = vi.fn();
    const stop = subscribeTurnActivityUpdate(listener);
    publishTurnActivityUpdate({ sessionId: "session-a", retired: true });
    expect(listener).toHaveBeenCalledWith({
      sessionId: "session-a",
      retired: true,
    });
    stop();
  });

  it("delivers one update once across same-window and Tauri (item 2)", async () => {
    // This is the exact gap item 2 asked to close: a permission decision
    // resolved in one Tauri window must reach a Chat pane open in another.
    // Same pattern already proven for import activity in
    // `importActivityBridge.test.ts`.
    const received = vi.fn();
    let tauriHandler:
      | ((event: { payload: unknown }) => void)
      | undefined;
    const unsubscribe = subscribeTurnActivityUpdate(received, async (_name, handler) => {
      tauriHandler = handler;
      return () => undefined;
    });
    await vi.waitFor(() => expect(tauriHandler).toBeTypeOf("function"));

    await publishTurnActivityUpdate({ sessionId: "session-a" }, async (_name, payload) => {
      // Simulate the cross-webview delivery a real Tauri emit would give a
      // DIFFERENT window's listener — the same-window CustomEvent from this
      // call has already fired synchronously before this callback runs.
      tauriHandler?.({ payload });
    });

    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith({ sessionId: "session-a" });
    unsubscribe();
  });

  it("ignores a malformed or missing-session cross-webview payload", async () => {
    const received = vi.fn();
    let tauriHandler: ((event: { payload: unknown }) => void) | undefined;
    const unsubscribe = subscribeTurnActivityUpdate(received, async (_name, handler) => {
      tauriHandler = handler;
      return () => undefined;
    });
    await vi.waitFor(() => expect(tauriHandler).toBeTypeOf("function"));

    tauriHandler?.({ payload: { sessionId: "" } });
    tauriHandler?.({ payload: { notSessionId: "session-a" } });
    tauriHandler?.({ payload: null });
    expect(received).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("does not deliver the same eventId twice to one subscriber", async () => {
    const received = vi.fn();
    let tauriHandler: ((event: { payload: unknown }) => void) | undefined;
    const unsubscribe = subscribeTurnActivityUpdate(received, async (_name, handler) => {
      tauriHandler = handler;
      return () => undefined;
    });
    await vi.waitFor(() => expect(tauriHandler).toBeTypeOf("function"));

    const payload = { sessionId: "session-a", eventId: "sender:1" };
    tauriHandler?.({ payload });
    tauriHandler?.({ payload }); // A retried/duplicate delivery.
    expect(received).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
