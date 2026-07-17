import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

// isTauri reads window.__TAURI_INTERNALS__
beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue([]);
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ =
    {};
});

describe("completePermission DTO", () => {
  it("builds complete_permission_cmd for deny / allow_once / allow_session_path", async () => {
    const { completePermission } = await import("./host");

    for (const decision of [
      "deny",
      "allow_once",
      "allow_session_path",
    ] as const) {
      invoke.mockClear();
      await completePermission(
        "req-1",
        decision,
        "save_memory",
        { title: "t", body_markdown: "b" },
        decision === "allow_once" ? "WRITE" : undefined,
        "sess-1",
      );
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("complete_permission_cmd", {
        req: {
          request_id: "req-1",
          decision,
          typed: decision === "allow_once" ? "WRITE" : null,
          tool_name: "save_memory",
          arguments: { title: "t", body_markdown: "b" },
          session_id: "sess-1",
        },
      });
    }
  });

  it("throws when not in Tauri (isTauri false path)", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object })
      .__TAURI_INTERNALS__;
    // Re-import won't re-evaluate isTauri if module cached — call after clearing
    const { completePermission } = await import("./host");
    // Force re-check: isTauri is a function that reads window each call
    await expect(
      completePermission("r", "deny", "save_memory", {}),
    ).rejects.toThrow(/Tauri host/);
  });
});
