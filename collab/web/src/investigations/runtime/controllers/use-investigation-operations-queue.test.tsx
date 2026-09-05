import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  GatewayResult,
  InvestigationOperationsQueueGateway,
  InvestigationOperationsQueueQueryInput,
} from "../gateway.js";
import { makeOperationsQueuePage } from "../testkit/fixtures.js";
import { createDeferred } from "../testkit/promises.js";
import { useInvestigationOperationsQueue } from "./use-investigation-operations-queue.js";
import type { InvestigationOperationsQueuePageV1 } from "@cd-collab/contracts/investigation-operations-queue";

const OPAQUE_CURSOR = "eyJzZXJ2ZXJPd25lZCI6dHJ1ZX0";

function gatewayWith(
  queryOperationsQueue: InvestigationOperationsQueueGateway["queryOperationsQueue"],
): InvestigationOperationsQueueGateway {
  return { queryOperationsQueue };
}

function singleRowPage(index: 0 | 1, overrides: Record<string, unknown> = {}) {
  const full = makeOperationsQueuePage();
  return makeOperationsQueuePage({
    items: [full.items[index]],
    coordinationScopeCounts: full.coordinationScopeCounts,
    ...overrides,
  });
}

describe("useInvestigationOperationsQueue", () => {
  it("stays idle while disabled or until a query is explicitly supplied", () => {
    const queryOperationsQueue = vi.fn(async () => ({
      ok: true as const,
      value: makeOperationsQueuePage(),
    }));
    const gateway = gatewayWith(queryOperationsQueue);
    const { result, rerender } = renderHook(
      ({ enabled, query }) => useInvestigationOperationsQueue({
        gateway,
        enabled,
        identityKey: "alice",
        authorityKey: "viewer:v1",
        query,
      }),
      { initialProps: { enabled: true, query: null as InvestigationOperationsQueueQueryInput | null } },
    );

    expect(result.current.page).toEqual({ status: "idle" });
    rerender({ enabled: false, query: { coordinationScope: "mine" } });
    expect(result.current.page).toEqual({ status: "idle" });
    expect(queryOperationsQueue).not.toHaveBeenCalled();
  });

  it("fails malformed input without transport work", async () => {
    const queryOperationsQueue = vi.fn(async () => ({
      ok: true as const,
      value: makeOperationsQueuePage(),
    }));
    const gateway = gatewayWith(queryOperationsQueue);
    const { result } = renderHook(() => useInvestigationOperationsQueue({
      gateway,
      enabled: true,
      identityKey: "alice",
      authorityKey: "viewer:v1",
      query: { limit: 101 },
    }));

    await waitFor(() => expect(result.current.page).toEqual({
      status: "failed",
      error: { kind: "protocol", reason: "contract" },
    }));
    expect(result.current.query).toBeNull();
    expect(queryOperationsQueue).not.toHaveBeenCalled();
  });

  it("fences a late response after query and coordination-scope changes", async () => {
    const first = createDeferred<GatewayResult<InvestigationOperationsQueuePageV1>>();
    const second = createDeferred<GatewayResult<InvestigationOperationsQueuePageV1>>();
    const requests: InvestigationOperationsQueueQueryInput[] = [];
    const deferred = [first, second];
    const gateway = gatewayWith((query) => {
      requests.push(query);
      return deferred[requests.length - 1]!.promise;
    });
    const { result, rerender } = renderHook(
      ({ query }) => useInvestigationOperationsQueue({
        gateway,
        enabled: true,
        identityKey: "alice",
        authorityKey: "viewer:v1",
        query,
      }),
      { initialProps: { query: { q: "checkout", coordinationScope: "mine" } as InvestigationOperationsQueueQueryInput } },
    );
    await waitFor(() => expect(requests).toHaveLength(1));

    rerender({ query: { q: "inventory", coordinationScope: "unassigned" } });
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => first.resolve({ ok: true, value: makeOperationsQueuePage() }));
    expect(result.current.page).toEqual({ status: "loading" });

    const next = singleRowPage(1);
    await act(async () => second.resolve({ ok: true, value: next }));
    expect(result.current.page).toEqual({ status: "ready", value: next });
    expect(result.current.query).toMatchObject({
      q: "inventory",
      coordinationScope: "unassigned",
    });
  });

  it.each([
    ["identity", { identityKey: "bob", authorityKey: "viewer:v1" }],
    ["authority", { identityKey: "alice", authorityKey: "viewer:v2" }],
  ] as const)("aborts and clears on a %s change", async (_label, nextScope) => {
    const requests: Array<{
      signal: AbortSignal;
      deferred: ReturnType<typeof createDeferred<GatewayResult<InvestigationOperationsQueuePageV1>>>;
    }> = [];
    const gateway = gatewayWith((_query, { signal }) => {
      const deferred = createDeferred<GatewayResult<InvestigationOperationsQueuePageV1>>();
      requests.push({ signal, deferred });
      return deferred.promise;
    });
    const { result, rerender } = renderHook(
      ({ identityKey, authorityKey }) => useInvestigationOperationsQueue({
        gateway,
        enabled: true,
        identityKey,
        authorityKey,
        query: { coordinationScope: "mine" },
      }),
      { initialProps: { identityKey: "alice", authorityKey: "viewer:v1" } },
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => requests[0]!.deferred.resolve({
      ok: true,
      value: makeOperationsQueuePage(),
    }));
    expect(result.current.page.status).toBe("ready");

    rerender(nextScope);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(result.current.page).toEqual({ status: "loading" });
  });

  it("accumulates cursor pages in server order and keeps only newest server metadata", async () => {
    const firstPage = singleRowPage(0, { nextCursor: OPAQUE_CURSOR });
    const secondPage = singleRowPage(1, {
      nextCursor: null,
      hiddenArchivedCount: 3,
      facets: {
        ...makeOperationsQueuePage().facets,
        contributor: { top: [{ key: "identity-alice", count: 7 }], otherCount: 2 },
      },
      coordinationScopeCounts: { allVisible: 8, mine: 5, unassigned: 2 },
    });
    const responses = [firstPage, secondPage];
    const requests: InvestigationOperationsQueueQueryInput[] = [];
    const gateway = gatewayWith(async (query) => {
      requests.push(query);
      return { ok: true, value: responses[requests.length - 1]! };
    });
    const { result, rerender } = renderHook(
      ({ query }) => useInvestigationOperationsQueue({
        gateway,
        enabled: true,
        identityKey: "alice",
        authorityKey: "viewer:v1",
        query,
      }),
      { initialProps: { query: { q: "checkout", coordinationScope: "all_visible" } as InvestigationOperationsQueueQueryInput } },
    );
    await waitFor(() => expect(result.current.page).toEqual({ status: "ready", value: firstPage }));

    rerender({ query: {
      q: "checkout",
      coordinationScope: "all_visible",
      cursor: OPAQUE_CURSOR,
    } });
    await waitFor(() => expect(result.current.page.status).toBe("ready"));
    expect(requests[1]?.cursor).toBe(OPAQUE_CURSOR);
    if (result.current.page.status !== "ready") throw new Error("expected ready queue");
    expect(result.current.page.value.items).toEqual([
      firstPage.items[0],
      secondPage.items[0],
    ]);
    expect(result.current.page.value.coordinationScopeCounts).toEqual(
      secondPage.coordinationScopeCounts,
    );
    expect(result.current.page.value.facets).toEqual(secondPage.facets);
    expect(result.current.page.value.hiddenArchivedCount).toBe(3);
    expect(result.current.page.value.nextCursor).toBeNull();
  });

  it("retains prior data for ordinary failure but clears it permanently on auth loss", async () => {
    const page = makeOperationsQueuePage();
    const responses: Array<GatewayResult<InvestigationOperationsQueuePageV1>> = [
      { ok: true, value: page },
      { ok: false, error: { kind: "network" } },
      { ok: false, error: { kind: "auth_lost", status: 403 } },
      { ok: false, error: { kind: "network" } },
    ];
    const gateway = gatewayWith(async () => responses.shift()!);
    const { result } = renderHook(() => useInvestigationOperationsQueue({
      gateway,
      enabled: true,
      identityKey: "alice",
      authorityKey: "viewer:v1",
      query: { coordinationScope: "mine" },
    }));
    await waitFor(() => expect(result.current.page).toEqual({ status: "ready", value: page }));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.page).toEqual({
      status: "failed",
      error: { kind: "network" },
      previous: page,
    }));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.page).toEqual({
      status: "failed",
      error: { kind: "auth_lost", status: 403 },
    }));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.page).toEqual({
      status: "failed",
      error: { kind: "network" },
    }));
  });

  it("never republishes accumulated rows after a concealed not-found response", async () => {
    const page = makeOperationsQueuePage();
    const retry = createDeferred<GatewayResult<InvestigationOperationsQueuePageV1>>();
    const responses: Array<
      GatewayResult<InvestigationOperationsQueuePageV1>
      | Promise<GatewayResult<InvestigationOperationsQueuePageV1>>
    > = [
      { ok: true, value: page },
      { ok: false, error: { kind: "not_found", status: 404 } },
      retry.promise,
    ];
    const gateway = gatewayWith(async () => responses.shift()!);
    const { result } = renderHook(() => useInvestigationOperationsQueue({
      gateway,
      enabled: true,
      identityKey: "alice",
      authorityKey: "viewer:v1",
      query: { coordinationScope: "mine" },
    }));
    await waitFor(() => expect(result.current.page).toEqual({ status: "ready", value: page }));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.page).toEqual({
      status: "failed",
      error: { kind: "not_found", status: 404 },
    }));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.page).toEqual({ status: "loading" }));
    act(() => retry.resolve({ ok: false, error: { kind: "network" } }));
    await waitFor(() => expect(result.current.page).toEqual({
      status: "failed",
      error: { kind: "network" },
    }));
  });

  it("aborts StrictMode work on unmount and never publishes the late completion", async () => {
    const requests: Array<{
      signal: AbortSignal;
      deferred: ReturnType<typeof createDeferred<GatewayResult<InvestigationOperationsQueuePageV1>>>;
    }> = [];
    const gateway = gatewayWith((_query, { signal }) => {
      const deferred = createDeferred<GatewayResult<InvestigationOperationsQueuePageV1>>();
      requests.push({ signal, deferred });
      return deferred.promise;
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );
    const first = renderHook(() => useInvestigationOperationsQueue({
      gateway,
      enabled: true,
      identityKey: "alice",
      authorityKey: "viewer:v1",
      query: { coordinationScope: "mine" },
    }), { wrapper });
    await waitFor(() => expect(requests).toHaveLength(1));
    first.unmount();
    expect(requests[0]!.signal.aborted).toBe(true);
    await act(async () => requests[0]!.deferred.resolve({
      ok: true,
      value: makeOperationsQueuePage(),
    }));
  });
});
