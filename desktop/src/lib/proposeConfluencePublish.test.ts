import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue([
    {
      kind: "permission_required",
      payload: {
        request_id: "req-pub",
        tool_name: "confluence_update_page",
        risk: "remote",
      },
    },
  ]);
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ =
    {};
});

describe("hostProposeConfluencePublish DTO", () => {
  it("invokes propose_confluence_publish with Tauri camelCase args", async () => {
    const { hostProposeConfluencePublish } = await import("./host");

    const events = await hostProposeConfluencePublish({
      harvestId: "01900000-0000-7000-8000-000000000001",
      bodyStorageOverride: "<p>pasted</p>",
      title: "Updated title",
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("propose_confluence_publish", {
      harvestId: "01900000-0000-7000-8000-000000000001",
      bodyStorageOverride: "<p>pasted</p>",
      title: "Updated title",
    });
    expect(events[0]?.kind).toBe("permission_required");
  });

  it("passes null for omitted override/title", async () => {
    const { hostProposeConfluencePublish } = await import("./host");

    await hostProposeConfluencePublish({
      harvestId: "01900000-0000-7000-8000-000000000002",
    });

    expect(invoke).toHaveBeenCalledWith("propose_confluence_publish", {
      harvestId: "01900000-0000-7000-8000-000000000002",
      bodyStorageOverride: null,
      title: null,
    });
  });

  it("throws when not in Tauri", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object })
      .__TAURI_INTERNALS__;
    const { hostProposeConfluencePublish } = await import("./host");
    await expect(
      hostProposeConfluencePublish({ harvestId: "x" }),
    ).rejects.toThrow(/Tauri host/);
  });
});
