/**
 * Product path: trash/delete must retire session activity (belt-and-suspenders
 * with the host command that also retires the durable journal).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

describe("host session delete retires activity", () => {
  beforeEach(() => {
    invoke.mockReset();
    (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ =
      {};
  });

  it("hostTrashChatSession invokes trash then forget_session_activity", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "trash_chat_session") return { id: "s-trash" };
      return undefined;
    });
    const { hostTrashChatSession } = await import("./host");
    await hostTrashChatSession("s-trash");
    const cmds = invoke.mock.calls.map((c) => c[0]);
    expect(cmds).toContain("trash_chat_session");
    expect(cmds).toContain("forget_session_activity");
    const forgetCall = invoke.mock.calls.find(
      (c) => c[0] === "forget_session_activity",
    );
    expect(forgetCall?.[1]).toEqual({ sessionId: "s-trash" });
  });

  it("hostDeleteChatSession invokes delete then forget_session_activity", async () => {
    invoke.mockImplementation(async () => undefined);
    // Fresh module to avoid cached isTauri if any
    const { hostDeleteChatSession } = await import("./host");
    await hostDeleteChatSession("s-del");
    const cmds = invoke.mock.calls.map((c) => c[0]);
    expect(cmds).toContain("delete_chat_session");
    expect(cmds).toContain("forget_session_activity");
  });
});
