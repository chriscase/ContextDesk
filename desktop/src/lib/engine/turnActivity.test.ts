import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTurnActivity, forgetSessionActivity } from "./turnActivity";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function withTauriHost() {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  invoke.mockReset();
});

describe("the live activity seam", () => {
  it("asks the host for the record keyed by (session, message)", async () => {
    withTauriHost();
    invoke.mockResolvedValue({ version: 1, turn_id: "s1::m1" });
    const record = await fetchTurnActivity("s1", "m1");
    expect(invoke).toHaveBeenCalledWith("get_turn_activity", {
      sessionId: "s1",
      messageId: "m1",
    });
    expect(record).toEqual({ version: 1, turn_id: "s1::m1" });
  });

  it("returns null — not a fabricated record — when the host has none", async () => {
    withTauriHost();
    invoke.mockResolvedValue(null);
    expect(await fetchTurnActivity("s1", "m1")).toBeNull();
  });

  it("returns null rather than throwing when the command fails", async () => {
    // A missing explanation must never take the transcript down with it.
    withTauriHost();
    invoke.mockRejectedValue(new Error("no such command"));
    await expect(fetchTurnActivity("s1", "m1")).resolves.toBeNull();
  });

  it("makes no IPC call at all outside a Tauri host (browser preview)", async () => {
    expect(await fetchTurnActivity("s1", "m1")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("makes no IPC call for an incomplete key", async () => {
    withTauriHost();
    expect(await fetchTurnActivity("", "m1")).toBeNull();
    expect(await fetchTurnActivity("s1", "")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("forwards session deletion so explanations go with the chat", async () => {
    withTauriHost();
    invoke.mockResolvedValue(undefined);
    await forgetSessionActivity("s1");
    expect(invoke).toHaveBeenCalledWith("forget_session_activity", {
      sessionId: "s1",
    });
  });

  it("swallows a deletion failure — the store is bounded anyway", async () => {
    withTauriHost();
    invoke.mockRejectedValue(new Error("gone"));
    await expect(forgetSessionActivity("s1")).resolves.toBeUndefined();
  });
});
