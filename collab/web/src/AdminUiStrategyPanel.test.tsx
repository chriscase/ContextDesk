import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminUiStrategyPanel } from "./AdminUiStrategyPanel.js";

const HASH = `sha256:${"0".repeat(64)}`;

function policy(revision = 0) {
  return {
    schemaId: "cd-collab.ui_strategy_policy.v1",
    revision,
    fingerprint: HASH,
    updatedAt: "2026-09-01T00:00:00.000Z",
    updatedBy: revision === 0 ? "system-default" : "local:admin",
    instance: {
      enabledIds: ["war-room", "investigation-first", "keystone"],
      visibleIds: ["war-room", "investigation-first", "keystone"],
      defaultId: "war-room",
      selectionMode: "free",
      approvedIds: ["war-room", "investigation-first", "keystone"],
    },
    roleRules: [],
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AdminUiStrategyPanel", () => {
  it("enables and publishes Beacon only through an explicit revision-checked save", async () => {
    const fetchStub = vi.fn(async (_input: RequestInfo, init?: RequestInit) =>
      init?.method === "PUT"
        ? new Response(JSON.stringify({
            ...policy(1),
            instance: {
              ...policy(1).instance,
              enabledIds: ["war-room", "investigation-first", "keystone", "beacon"],
              visibleIds: ["war-room", "investigation-first", "keystone", "beacon"],
              approvedIds: ["war-room", "investigation-first", "keystone", "beacon"],
            },
          }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify(policy()), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchStub);
    render(<AdminUiStrategyPanel />);
    const beacon = await screen.findByRole("heading", { name: "Beacon" });
    const card = beacon.closest("article")!;
    fireEvent.click(card.querySelector<HTMLInputElement>("input[type=checkbox]")!);
    const visible = card.querySelectorAll<HTMLInputElement>("input[type=checkbox]")[1]!;
    fireEvent.click(visible);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Save rollout policy" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("revision 1"));
    const body = JSON.parse(String(fetchStub.mock.calls[1]?.[1]?.body));
    expect(body).toMatchObject({
      schemaId: "cd-collab.ui_strategy_policy_update.v1",
      expectedRevision: 0,
      instance: {
        enabledIds: ["war-room", "investigation-first", "keystone", "beacon"],
        visibleIds: ["war-room", "investigation-first", "keystone", "beacon"],
        approvedIds: ["war-room", "investigation-first", "keystone", "beacon"],
      },
      roleRules: [],
    });
  });

  it("refuses to replace a stale policy and keeps the draft visible", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo, init?: RequestInit) =>
      init?.method === "PUT"
        ? new Response(JSON.stringify({ error: "stale_policy" }), { status: 409 })
        : new Response(JSON.stringify(policy()), { status: 200 })));
    render(<AdminUiStrategyPanel />);
    await screen.findByRole("heading", { name: "Beacon" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable Beacon" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rollout policy" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Another administrator changed this policy");
    expect(screen.getByText("Policy revision 0", { exact: false })).toBeTruthy();
  });

  it("inherits the instance subset and prunes hidden role approvals and disabled defaults", async () => {
    const restricted = {
      ...policy(3),
      instance: {
        ...policy(3).instance,
        selectionMode: "approved_subset",
        approvedIds: ["war-room", "investigation-first"],
      },
      roleRules: [{
        role: "contributor",
        approvedIds: ["war-room", "investigation-first", "keystone"],
        defaultId: "keystone",
      }],
    };
    let submitted: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
      if (init?.method === "PUT") {
        submitted = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          ...restricted,
          revision: 4,
          instance: submitted.instance,
          roleRules: submitted.roleRules,
        }), { status: 200 });
      }
      return new Response(JSON.stringify(restricted), { status: 200 });
    }));
    render(<AdminUiStrategyPanel />);
    await screen.findByRole("heading", { name: "Keystone" });
    expect((within(screen.getByRole("group", { name: "Viewer override" })).getByRole("checkbox", { name: "Keystone" }) as HTMLInputElement).checked).toBe(false);
    expect((within(screen.getByRole("group", { name: "Contributor override" })).getByRole("checkbox", { name: "Keystone" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show Keystone in selector" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable Keystone" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rollout policy" }));
    await waitFor(() => expect(submitted).not.toBeNull());
    expect(submitted).toMatchObject({
      expectedRevision: 3,
      instance: {
        enabledIds: ["war-room", "investigation-first"],
        visibleIds: ["war-room", "investigation-first"],
      },
      roleRules: [{
        role: "contributor",
        approvedIds: ["war-room", "investigation-first"],
        defaultId: null,
      }],
    });
  });
});
