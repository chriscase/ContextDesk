import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useUiStrategyGovernance } from "./useUiStrategyGovernance.js";

function effective(id: "war-room" | "investigation-first", revision = 0): Response {
  return new Response(JSON.stringify({
    schemaId: "cd-collab.ui_strategy_effective.v1",
    policyRevision: 4,
    preferenceRevision: revision,
    preferredId: revision === 0 ? null : id,
    effectiveId: id,
    defaultId: "war-room",
    enabledIds: ["war-room", "investigation-first"],
    selectableIds: ["war-room", "investigation-first"],
    canSelect: true,
    source: revision === 0 ? "instance_default" : "user",
  }), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("useUiStrategyGovernance", () => {
  it("loads and explicitly saves a server-backed preference", async () => {
    const fetchStub = vi.fn(async (_input: RequestInfo, init?: RequestInit) =>
      init?.method === "PUT" ? effective("investigation-first", 1) : effective("war-room"));
    vi.stubGlobal("fetch", fetchStub);
    const { result } = renderHook(() => useUiStrategyGovernance({
      identityId: "local:alice", authorityGeneration: 1, enabled: true,
    }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      expect(await result.current.savePreference("investigation-first")).toBe(true);
    });
    expect(result.current.effective).toMatchObject({
      effectiveId: "investigation-first", preferenceRevision: 1,
    });
    const body = JSON.parse(String(fetchStub.mock.calls[1]?.[1]?.body));
    expect(body).toMatchObject({
      expectedPolicyRevision: 4,
      expectedPreferenceRevision: 0,
      strategyId: "investigation-first",
    });
  });

  it("never publishes a late response from the prior identity", async () => {
    let resolveAlice!: (value: Response) => void;
    const alice = new Promise<Response>((resolve) => { resolveAlice = resolve; });
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return calls === 1 ? alice : new Promise<Response>(() => undefined);
    }));
    const { result, rerender } = renderHook(
      (props: { identityId: string; authorityGeneration: number }) =>
        useUiStrategyGovernance({ ...props, enabled: true }),
      { initialProps: { identityId: "local:alice", authorityGeneration: 1 } },
    );
    rerender({ identityId: "local:bob", authorityGeneration: 2 });
    await act(async () => resolveAlice(effective("investigation-first", 1)));
    expect(result.current.effective.effectiveId).toBe("war-room");
    expect(result.current.status).toBe("loading");
  });

  it("fails to a War Room-only disabled selector on malformed policy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200 })));
    const { result } = renderHook(() => useUiStrategyGovernance({
      identityId: "local:alice", authorityGeneration: 1, enabled: true,
    }));
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.effective).toMatchObject({
      effectiveId: "war-room", selectableIds: [], canSelect: false,
    });
  });

  it("drops stale presentation authority and reloads after a preference conflict", async () => {
    let reads = 0;
    const fetchStub = vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response(JSON.stringify({ error: "stale_policy" }), { status: 409 });
      reads += 1;
      return reads === 1 ? effective("investigation-first", 1) : effective("war-room");
    });
    vi.stubGlobal("fetch", fetchStub);
    const { result } = renderHook(() => useUiStrategyGovernance({
      identityId: "local:alice", authorityGeneration: 1, enabled: true,
    }));
    await waitFor(() => expect(result.current.effective.effectiveId).toBe("investigation-first"));
    await act(async () => {
      expect(await result.current.savePreference("war-room")).toBe(false);
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.effective).toMatchObject({
      effectiveId: "war-room", preferredId: null, preferenceRevision: 0,
    });
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it("reloads authority after an unconfirmed preference outcome", async () => {
    let reads = 0;
    const fetchStub = vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
      if (init?.method === "PUT") throw new Error("response lost");
      reads += 1;
      return reads === 1 ? effective("investigation-first", 1) : effective("war-room");
    });
    vi.stubGlobal("fetch", fetchStub);
    const { result } = renderHook(() => useUiStrategyGovernance({
      identityId: "local:alice", authorityGeneration: 1, enabled: true,
    }));
    await waitFor(() => expect(result.current.effective.effectiveId).toBe("investigation-first"));
    await act(async () => {
      expect(await result.current.savePreference("war-room")).toBe(false);
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.effective.effectiveId).toBe("war-room");
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });
});
