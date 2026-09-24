import {
  INVESTIGATION_ACTIVITY_ITEM_SCHEMA_ID,
  INVESTIGATION_ACTIVITY_NOTICES,
  INVESTIGATION_ACTIVITY_PAGE_SCHEMA_ID,
  INVESTIGATION_RESOURCE_LOCATOR_SCHEMA_ID,
  INVESTIGATION_RESOURCE_RESOLVE_SCHEMA_ID,
  type InvestigationActivityFilterV1,
  type InvestigationActivityItemV1,
  type InvestigationActivityPageV1,
  type InvestigationResourceLocatorV1,
  type InvestigationResourceResolveV1,
} from "@cd-collab/contracts/investigation-activity";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaseV1 } from "@cd-collab/contracts/investigation-runtime";
import type { OverviewGateway, OverviewGatewayResult } from "./gateway.js";
import { useActivityCenter, type ActivityCenterController } from "./use-activity-center.js";

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

  it("clears investigation counts when identity changes before the new read settles", async () => {
    const nextCases = deferred<OverviewGatewayResult<readonly CaseV1[]>>();
    const sharedGateway = gateway(vi.fn<OverviewGateway["listActivity"]>(async () => ({ ok: true, value: page([], null) })));
    sharedGateway.listInvestigations = vi.fn<OverviewGateway["listInvestigations"]>()
      .mockResolvedValueOnce({ ok: true, value: [{ id: CASE_ID } as CaseV1] })
      .mockImplementationOnce(() => nextCases.promise);
    const { result, rerender } = renderHook(({ identityKey }) => useActivityCenter({
      enabled: true, identityKey, authorityKey: "viewer", filter: {}, gateway: sharedGateway,
    }), { initialProps: { identityKey: "alice" } });
    await waitFor(() => expect(result.current.investigations).toHaveLength(1));

    rerender({ identityKey: "bob" });

    expect(result.current.investigations).toEqual([]);
    expect(result.current.investigationsLoading).toBe(true);
    await act(async () => nextCases.resolve({ ok: true, value: [] }));
  });

  it("keeps page one when a failed continuation is retried successfully", async () => {
    const listActivity = vi.fn<OverviewGateway["listActivity"]>()
      .mockResolvedValueOnce({ ok: true, value: page([item("a")], "opaque_cursor") })
      .mockResolvedValueOnce({ ok: false, error: { kind: "network" } })
      .mockResolvedValueOnce({ ok: true, value: page([item("b")], null) });
    const sharedGateway = gateway(listActivity);
    const { result } = renderHook(() => useActivityCenter({
      enabled: true, identityKey: "alice", authorityKey: "viewer", filter: {}, gateway: sharedGateway,
    }));
    await waitFor(() => expect(result.current.activity.status).toBe("ready"));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.activity.status).toBe("failed"));

    act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.activity).toEqual({ status: "ready", items: [item("a"), item("b")] }));
  });

  it("conceals the previous scope on the render before effects and ignores stored callbacks", async () => {
    const listActivity = vi.fn<OverviewGateway["listActivity"]>()
      .mockResolvedValue({ ok: true, value: page([item("a")], "opaque_cursor") });
    const sharedGateway = gateway(listActivity);
    const paints: ActivityCenterController[] = [];
    const stored = {
      loadMore: () => undefined as void,
      open: (_locator: InvestigationResourceLocatorV1) => Promise.resolve(null as string | null),
    };
    function Probe({
      identityKey,
      authorityKey,
      enabled,
      filter,
      releaseStored,
    }: {
      readonly identityKey: string;
      readonly authorityKey: string;
      readonly enabled: boolean;
      readonly filter: InvestigationActivityFilterV1;
      readonly releaseStored: boolean;
    }) {
      const controller = useActivityCenter({
        enabled, identityKey, authorityKey, filter, gateway: sharedGateway,
      });
      paints.push(controller);
      if (!releaseStored) {
        stored.loadMore = controller.loadMore;
        stored.open = controller.open;
      }
      useLayoutEffect(() => {
        if (!releaseStored) return;
        stored.loadMore();
        void stored.open(item("a").locator);
      });
      return null;
    }
    const rendered = render(
      <Probe identityKey="alice" authorityKey="viewer" enabled filter={{}} releaseStored={false} />,
    );
    await waitFor(() => expect(paints.some((paint) => paint.activity.status === "ready")).toBe(true));
    const callsBefore = listActivity.mock.calls.length;
    const mark = paints.length;
    rendered.rerender(
      <Probe identityKey="bob" authorityKey="editor" enabled filter={{ activityKind: "handoff_recorded" }} releaseStored />,
    );
    expect(paints[mark]?.activity).toEqual({ status: "loading" });
    expect(paints[mark]?.nextCursor).toBeNull();
    expect(paints[mark]?.loadingMore).toBe(false);
    expect(paints[mark]?.openFailure).toBeNull();
    expect(paints[mark]?.investigations).toEqual([]);
    expect(listActivity.mock.calls.length).toBe(callsBefore + 1);
    expect(listActivity.mock.calls.at(-1)?.[0]).toEqual({ filter: { activityKind: "handoff_recorded" } });
    expect(sharedGateway.resolve).not.toHaveBeenCalled();
    await waitFor(() => expect(paints.at(-1)?.activity).toEqual({ status: "ready", items: [item("a")] }));
    const callsAfterReady = listActivity.mock.calls.length;
    stored.loadMore();
    await act(async () => { await stored.open(item("a").locator); });
    expect(listActivity.mock.calls.length).toBe(callsAfterReady);
    expect(listActivity.mock.calls.some((call) => call[0].cursor === "opaque_cursor")).toBe(false);
    expect(sharedGateway.resolve).not.toHaveBeenCalled();
  });

  it("issues no reads when the center starts disabled and hides rows when read is removed", async () => {
    const listActivity = vi.fn<OverviewGateway["listActivity"]>(async () => ({ ok: true, value: page([item("a")], "opaque_cursor") }));
    const sharedGateway = gateway(listActivity);
    const disabled = renderHook(() => useActivityCenter({
      enabled: false, identityKey: "alice", authorityKey: "viewer", filter: {}, gateway: sharedGateway,
    }));
    await act(async () => undefined);
    expect(listActivity).not.toHaveBeenCalled();
    expect(sharedGateway.listInvestigations).not.toHaveBeenCalled();
    expect(sharedGateway.resolve).not.toHaveBeenCalled();
    expect(disabled.result.current.activity).toEqual({ status: "idle" });
    expect(disabled.result.current.loadingMore).toBe(false);
    expect(disabled.result.current.nextCursor).toBeNull();

    const paints: ActivityCenterController[] = [];
    function Probe({ enabled }: { readonly enabled: boolean }) {
      const controller = useActivityCenter({
        enabled, identityKey: "alice", authorityKey: "viewer", filter: {}, gateway: sharedGateway,
      });
      paints.push(controller);
      return null;
    }
    const shown = render(<Probe enabled />);
    await waitFor(() => expect(paints.some((paint) => paint.activity.status === "ready")).toBe(true));
    const mark = paints.length;
    shown.rerender(<Probe enabled={false} />);
    expect(paints[mark]?.activity).toEqual({ status: "idle" });
    expect(paints[mark]?.nextCursor).toBeNull();
    expect(paints[mark]?.openFailure).toBeNull();
    expect(paints[mark]?.investigationsLoading).toBe(false);
  });

  it("keeps prior rows while a same-scope refresh is loading and drops the continuation cursor", async () => {
    const listActivity = vi.fn<OverviewGateway["listActivity"]>()
      .mockResolvedValueOnce({ ok: true, value: page([item("a")], "opaque_cursor") })
      .mockResolvedValueOnce({ ok: false, error: { kind: "network" } });
    const sharedGateway = gateway(listActivity);
    const paints: ActivityCenterController[] = [];
    let refresh = () => undefined as void;
    function Probe() {
      const controller = useActivityCenter({
        enabled: true, identityKey: "alice", authorityKey: "viewer", filter: { activityKind: "investigation_updated" }, gateway: sharedGateway,
      });
      refresh = controller.refresh;
      paints.push(controller);
      return null;
    }
    render(<Probe />);
    await waitFor(() => expect(paints.some((paint) => paint.activity.status === "ready")).toBe(true));
    const mark = paints.length;
    act(() => refresh());
    expect(paints[mark]?.activity).toEqual({ status: "loading", previous: [item("a")] });
    expect(paints[mark]?.nextCursor).toBeNull();
    expect(paints[mark]?.loadingMore).toBe(false);
    await waitFor(() => expect(paints.at(-1)?.activity.status).toBe("failed"));
    const failed = paints.at(-1)?.activity;
    expect(failed?.status === "failed" && failed.previous).toEqual([item("a")]);
    expect(listActivity.mock.calls.at(-1)?.[0]).toEqual({ filter: { activityKind: "investigation_updated" } });
  });

  it("does not navigate when an in-flight open settles on the replacement render", async () => {
    const pending = deferred<OverviewGatewayResult<InvestigationResourceResolveV1>>();
    const listActivity = vi.fn<OverviewGateway["listActivity"]>(async () => ({ ok: true, value: page([item("a")], null) }));
    const sharedGateway = gateway(listActivity);
    sharedGateway.resolve = vi.fn(() => pending.promise);
    let open = (_locator: InvestigationResourceLocatorV1) => Promise.resolve(null as string | null);
    const paints: ActivityCenterController[] = [];
    function Probe({ identityKey }: { readonly identityKey: string }) {
      const controller = useActivityCenter({
        enabled: true, identityKey, authorityKey: "viewer", filter: {}, gateway: sharedGateway,
      });
      open = controller.open;
      paints.push(controller);
      useLayoutEffect(() => {
        if (identityKey !== "bob") return;
        pending.resolve({
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
      });
      return null;
    }
    const view = render(<Probe identityKey="alice" />);
    await waitFor(() => expect(listActivity).toHaveBeenCalled());
    const pendingOpen = open(item("a").locator);
    await waitFor(() => expect(sharedGateway.resolve).toHaveBeenCalledTimes(1));
    view.rerender(<Probe identityKey="bob" />);
    await expect(pendingOpen).resolves.toBeNull();
    expect(paints.at(-1)?.openFailure).toBeNull();
  });

  it.each([
    ["identity", { identityKey: "bob", authorityKey: "viewer", filter: {} satisfies InvestigationActivityFilterV1 }],
    ["authority", { identityKey: "alice", authorityKey: "editor", filter: {} satisfies InvestigationActivityFilterV1 }],
    ["filter", { identityKey: "alice", authorityKey: "viewer", filter: { activityKind: "handoff_recorded" } satisfies InvestigationActivityFilterV1 }],
  ])("conceals a %s change before effects", async (_label, next) => {
    const listActivity = vi.fn<OverviewGateway["listActivity"]>()
      .mockResolvedValue({ ok: true, value: page([item("a")], "opaque_cursor") });
    const sharedGateway = gateway(listActivity);
    const paints: ActivityCenterController[] = [];
    function Probe(props: { readonly identityKey: string; readonly authorityKey: string; readonly filter: InvestigationActivityFilterV1 }) {
      const controller = useActivityCenter({ enabled: true, ...props, gateway: sharedGateway });
      paints.push(controller);
      return null;
    }
    const rendered = render(<Probe identityKey="alice" authorityKey="viewer" filter={{}} />);
    await waitFor(() => expect(paints.some((paint) => paint.activity.status === "ready")).toBe(true));
    const mark = paints.length;
    rendered.rerender(<Probe {...next} />);
    expect(paints[mark]?.activity).toEqual({ status: "loading" });
    expect(paints[mark]?.nextCursor).toBeNull();
    expect(paints[mark]?.loadingMore).toBe(false);
    expect(paints[mark]?.openFailure).toBeNull();
    expect(paints[mark]?.investigations).toEqual([]);
  });

  it("does not let a captured refresh resurrect the previous filter", async () => {
    const listActivity = vi.fn<OverviewGateway["listActivity"]>()
      .mockResolvedValue({ ok: true, value: page([item("a")], null) });
    const sharedGateway = gateway(listActivity);
    let refresh = () => undefined as void;
    function Probe({ filter }: { readonly filter: InvestigationActivityFilterV1 }) {
      const controller = useActivityCenter({
        enabled: true, identityKey: "alice", authorityKey: "viewer", filter, gateway: sharedGateway,
      });
      refresh = controller.refresh;
      return null;
    }
    const rendered = render(<Probe filter={{}} />);
    await waitFor(() => expect(listActivity).toHaveBeenCalledTimes(1));
    const captured = refresh;
    rendered.rerender(<Probe filter={{ activityKind: "handoff_recorded" }} />);
    await waitFor(() => expect(listActivity.mock.calls.at(-1)?.[0]).toEqual({ filter: { activityKind: "handoff_recorded" } }));
    const calls = listActivity.mock.calls.length;
    act(() => captured());
    await waitFor(() => expect(listActivity.mock.calls.length).toBe(calls + 1));
    expect(listActivity.mock.calls.at(-1)?.[0]).toEqual({ filter: { activityKind: "handoff_recorded" } });
    expect(listActivity.mock.calls.some((call) => call[0].cursor)).toBe(false);
  });

  it.each([
    ["success", { ok: true as const, value: page([item("a")], "old_cursor") }],
    ["failure", { ok: false as const, error: { kind: "network" as const } }],
  ])("ignores a late %s from the previous scope", async (_label, lateResult) => {
    const late = deferred<OverviewGatewayResult<InvestigationActivityPageV1>>();
    const listActivity = vi.fn<OverviewGateway["listActivity"]>()
      .mockImplementationOnce(() => late.promise)
      .mockResolvedValueOnce({ ok: true, value: page([item("b")], "new_cursor") });
    const sharedGateway = gateway(listActivity);
    const { result, rerender } = renderHook(({ identityKey }) => useActivityCenter({
      enabled: true, identityKey, authorityKey: "viewer", filter: {}, gateway: sharedGateway,
    }), { initialProps: { identityKey: "alice" } });
    await waitFor(() => expect(listActivity).toHaveBeenCalledTimes(1));
    rerender({ identityKey: "bob" });
    await waitFor(() => expect(result.current.activity).toEqual({ status: "ready", items: [item("b")] }));
    await act(async () => late.resolve(lateResult));
    expect(result.current.activity).toEqual({ status: "ready", items: [item("b")] });
    expect(result.current.nextCursor).toBe("new_cursor");
    expect(result.current.openFailure).toBeNull();
  });

  it("reports a first-load failure without retained rows and retries the current filter", async () => {
    const listActivity = vi.fn<OverviewGateway["listActivity"]>()
      .mockResolvedValueOnce({ ok: false, error: { kind: "network" } })
      .mockResolvedValueOnce({ ok: false, error: { kind: "protocol" } })
      .mockResolvedValueOnce({ ok: true, value: page([item("a")], null) });
    const sharedGateway = gateway(listActivity);
    const filter = { activityKind: "investigation_updated" } satisfies InvestigationActivityFilterV1;
    const { result } = renderHook(() => useActivityCenter({
      enabled: true, identityKey: "alice", authorityKey: "viewer", filter, gateway: sharedGateway,
    }));
    await waitFor(() => expect(result.current.activity).toEqual({ status: "failed", error: { kind: "network" } }));
    expect(result.current.nextCursor).toBeNull();
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.activity).toEqual({ status: "failed", error: { kind: "protocol" } }));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.activity).toEqual({ status: "ready", items: [item("a")] }));
    expect(listActivity.mock.calls.every((call) => call[0].filter?.activityKind === "investigation_updated" && call[0].cursor === undefined)).toBe(true);
  });
});
