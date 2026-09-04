import {
  INVESTIGATION_ACTIVITY_ITEM_SCHEMA_ID,
  INVESTIGATION_ACTIVITY_NOTICES,
  INVESTIGATION_ACTIVITY_PAGE_SCHEMA_ID,
  INVESTIGATION_RESOURCE_LOCATOR_SCHEMA_ID,
  INVESTIGATION_RESOURCE_RESOLVE_SCHEMA_ID,
  type InvestigationActivityItemV1,
  type InvestigationActivityPageV1,
  type InvestigationResourceResolveV1,
} from "@cd-collab/contracts/investigation-activity";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OverviewGateway, OverviewGatewayResult } from "./gateway.js";
import { useActivityCenter } from "./use-activity-center.js";

afterEach(cleanup);
const CASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function item(seed: string): InvestigationActivityItemV1 {
  const pathname = `/investigations/${CASE_ID}/situation`;
  return {
    schemaId: INVESTIGATION_ACTIVITY_ITEM_SCHEMA_ID,
    activityId: seed.repeat(64).slice(0, 64), occurredAt: "2026-09-03T12:00:00.000Z",
    orderTieBreak: 1, actorId: "actor", actorLabel: "Avery", investigationId: CASE_ID,
    investigationTitle: "Gateway resets", activityKind: "investigation_updated", summary: "updated the investigation",
    locator: { schemaId: INVESTIGATION_RESOURCE_LOCATOR_SCHEMA_ID, version: 1,
      installationId: "inst-syntheticnorth", investigationId: CASE_ID,
      kind: "investigation", resourceId: CASE_ID, pathname },
    resolvedRoute: pathname, provenanceClass: "human", privacyVisibility: "member",
    revision: null, sourceEventId: `${CASE_ID}:1`, humanFinding: true,
  };
}

function page(items: InvestigationActivityItemV1[], nextCursor: string | null): InvestigationActivityPageV1 {
  return { schemaId: INVESTIGATION_ACTIVITY_PAGE_SCHEMA_ID, items, nextCursor,
    notices: [...INVESTIGATION_ACTIVITY_NOTICES] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function gateway(listActivity: OverviewGateway["listActivity"]): OverviewGateway {
  return {
    listActivity,
    listInvestigations: vi.fn(async () => ({ ok: true as const, value: [] })),
    resolve: vi.fn(async () => ({ ok: false as const, error: { kind: "not_found" as const } })),
  };
}

describe("useActivityCenter", () => {
  it("drops a stale continuation and reloads page one without mixing windows", async () => {
    const listActivity = vi.fn<OverviewGateway["listActivity"]>()
      .mockResolvedValueOnce({ ok: true, value: page([item("a")], "opaque_cursor") })
      .mockResolvedValueOnce({ ok: false, error: { kind: "stale_cursor" } })
      .mockResolvedValueOnce({ ok: true, value: page([item("b")], null) });
    const sharedGateway = gateway(listActivity);
    const { result } = renderHook(() => useActivityCenter({
      enabled: true, identityKey: "alice", authorityKey: "viewer", filter: {},
      gateway: sharedGateway,
    }));
    await waitFor(() => expect(result.current.activity.status).toBe("ready"));
    act(() => result.current.loadMore());
    await waitFor(() => {
      expect(result.current.activity).toEqual({ status: "ready", items: [item("b")] });
    });
    expect(listActivity).toHaveBeenNthCalledWith(2, { filter: {}, cursor: "opaque_cursor" }, expect.any(AbortSignal));
    expect(listActivity).toHaveBeenNthCalledWith(3, { filter: {} }, expect.any(AbortSignal));
  });

  it("clears prior identity data synchronously and ignores its late response", async () => {
    const second = deferred<OverviewGatewayResult<InvestigationActivityPageV1>>();
    const listActivity = vi.fn<OverviewGateway["listActivity"]>()
      .mockResolvedValueOnce({ ok: true, value: page([item("a")], null) })
      .mockImplementationOnce(() => second.promise);
    const sharedGateway = gateway(listActivity);
    const { result, rerender } = renderHook(({ identityKey }) => useActivityCenter({
      enabled: true, identityKey, authorityKey: "viewer", filter: {}, gateway: sharedGateway,
    }), { initialProps: { identityKey: "alice" } });
    await waitFor(() => expect(result.current.activity.status).toBe("ready"));
    rerender({ identityKey: "bob" });
    expect(result.current.activity).toEqual({ status: "loading" });
    await act(async () => second.resolve({ ok: true, value: page([item("b")], null) }));
    expect(result.current.activity).toEqual({ status: "ready", items: [item("b")] });
  });

  it("aborts continuation reads when its request scope changes", async () => {
    const continuation = deferred<OverviewGatewayResult<InvestigationActivityPageV1>>();
    let continuationSignal: AbortSignal | undefined;
    const listActivity = vi.fn<OverviewGateway["listActivity"]>()
      .mockResolvedValueOnce({ ok: true, value: page([item("a")], "opaque_cursor") })
      .mockImplementationOnce((_request, signal) => {
        continuationSignal = signal;
        return continuation.promise;
      })
      .mockResolvedValueOnce({ ok: true, value: page([item("b")], null) });
    const sharedGateway = gateway(listActivity);
    const { result, rerender } = renderHook(({ identityKey }) => useActivityCenter({
      enabled: true, identityKey, authorityKey: "viewer", filter: {}, gateway: sharedGateway,
    }), { initialProps: { identityKey: "alice" } });
    await waitFor(() => expect(result.current.activity.status).toBe("ready"));
    act(() => result.current.loadMore());
    await waitFor(() => expect(continuationSignal).toBeDefined());

    rerender({ identityKey: "bob" });

    expect(continuationSignal?.aborted).toBe(true);
    await act(async () => continuation.resolve({ ok: true, value: page([item("c")], null) }));
    await waitFor(() => expect(result.current.activity).toEqual({ status: "ready", items: [item("b")] }));
  });

  it("aborts and suppresses a pending locator resolution after unmount", async () => {
    const resolution = deferred<OverviewGatewayResult<InvestigationResourceResolveV1>>();
    let resolveSignal: AbortSignal | undefined;
    const sharedGateway = gateway(vi.fn<OverviewGateway["listActivity"]>(async () => ({ ok: true, value: page([], null) })));
    sharedGateway.resolve = vi.fn((_locator, signal) => {
      resolveSignal = signal;
      return resolution.promise;
    });
    const { result, unmount } = renderHook(() => useActivityCenter({
      enabled: true, identityKey: "alice", authorityKey: "viewer", filter: {}, gateway: sharedGateway,
    }));
    await waitFor(() => expect(result.current.activity.status).toBe("ready"));
    const pending = result.current.open(item("a").locator);

    unmount();

    expect(resolveSignal?.aborted).toBe(true);
    resolution.resolve({
      ok: true,
      value: {
        schemaId: INVESTIGATION_RESOURCE_RESOLVE_SCHEMA_ID,
        locator: item("a").locator,
        resourceKind: "investigation",
        resourceLabel: "Gateway resets",
        investigationTitle: "Gateway resets",
        revision: null,
        authorized: true,
      },
    });
    await expect(pending).resolves.toBeNull();
  });
});
