import {
  INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID,
  parseInvestigationCollectionPage,
  type InvestigationCollectionPageV1,
} from "@cd-collab/contracts/investigation-collection";
import type { CaseV1 } from "@cd-collab/contracts/investigation-runtime";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  GatewayResult,
  InvestigationCollectionQueryGateway,
  InvestigationCollectionQueryInput,
  InvestigationGateway,
} from "../gateway.js";
import {
  makeCaseList,
  makePopulatedCase,
  makeSparseImportedCase,
} from "../testkit/fixtures.js";
import { createDeferred } from "../testkit/promises.js";
import {
  useInvestigationCollectionQuery,
  useInvestigationList,
} from "./use-investigation-list.js";

afterEach(cleanup);

const failedUnexpected = async <T,>(): Promise<GatewayResult<T>> => ({
  ok: false,
  error: { kind: "unexpected" },
});

function gatewayWith(
  listInvestigations: InvestigationGateway["listInvestigations"],
): InvestigationGateway {
  return {
    listInvestigations,
    getInvestigation: () => failedUnexpected(),
    createInvestigation: () => failedUnexpected(),
    listEvidence: () => failedUnexpected(),
    listContributions: () => failedUnexpected(),
    uploadEvidence: () => failedUnexpected(),
    getLifecycle: () => failedUnexpected(),
    applyLifecycleAction: () => failedUnexpected(),
  };
}

describe("useInvestigationList", () => {
  it("does not load while disabled and clears an enabled scope immediately", async () => {
    const requests: Array<{
      signal: AbortSignal;
      deferred: ReturnType<typeof createDeferred<GatewayResult<readonly CaseV1[]>>>;
    }> = [];
    const gateway = gatewayWith(({ signal }) => {
      const deferred = createDeferred<GatewayResult<readonly CaseV1[]>>();
      requests.push({ signal, deferred });
      return deferred.promise;
    });
    const { result, rerender } = renderHook(
      ({ enabled }) => useInvestigationList({
        gateway,
        enabled,
        identityKey: "alice",
        authorityKey: "interactive:viewer",
      }),
      { initialProps: { enabled: false } },
    );

    expect(result.current.investigations).toEqual({ status: "idle" });
    expect(requests).toHaveLength(0);

    rerender({ enabled: true });
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(result.current.investigations).toEqual({ status: "loading" });

    rerender({ enabled: false });
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(result.current.investigations).toEqual({ status: "idle" });
    await act(async () => {
      requests[0]!.deferred.resolve({ ok: true, value: makeCaseList().cases });
    });
    expect(result.current.investigations).toEqual({ status: "idle" });
  });

  it("merges a server-confirmed create by id without mutating the published list", async () => {
    const original = makeCaseList().cases;
    const created = { ...makeSparseImportedCase(), id: "case-created" };
    const replacement = { ...created, title: "Authoritative replacement" };
    const gateway = gatewayWith(async () => ({ ok: true, value: original }));
    const { result } = renderHook(() => useInvestigationList({
      gateway,
      enabled: true,
      identityKey: "alice",
      authorityKey: "interactive:contributor",
    }));
    await waitFor(() => expect(result.current.investigations.status).toBe("ready"));
    expect(result.current.latestRequestGeneration).toBe(1);
    expect(result.current.successfulSnapshotGeneration).toBe(1);

    act(() => result.current.publishInvestigation(created));
    expect(result.current.investigations).toEqual({
      status: "ready",
      value: [created, ...original],
    });
    expect(result.current.successfulSnapshotGeneration).toBe(1);
    expect(original).toEqual(makeCaseList().cases);

    act(() => result.current.publishInvestigation(replacement));
    expect(result.current.investigations.status).toBe("ready");
    if (result.current.investigations.status !== "ready") throw new Error("expected ready");
    expect(result.current.investigations.value).toHaveLength(original.length + 1);
    expect(result.current.investigations.value[0]).toEqual(replacement);
  });

  it("merges publication into previous data without concealing loading or refresh failure", async () => {
    const refresh = createDeferred<GatewayResult<readonly CaseV1[]>>();
    let requestCount = 0;
    const original = makeCaseList().cases;
    const created = { ...makeSparseImportedCase(), id: "case-created-during-refresh" };
    const gateway = gatewayWith(() => {
      requestCount += 1;
      return requestCount === 1
        ? Promise.resolve({ ok: true, value: original })
        : refresh.promise;
    });
    const { result } = renderHook(() => useInvestigationList({
      gateway,
      enabled: true,
      identityKey: "alice",
      authorityKey: "interactive:contributor",
    }));
    await waitFor(() => expect(result.current.investigations.status).toBe("ready"));

    act(() => result.current.refresh());
    expect(result.current.investigations.status).toBe("loading");
    act(() => result.current.publishInvestigation(created));
    expect(result.current.investigations).toEqual({
      status: "loading",
      previous: [created, ...original],
    });

    await act(async () => {
      refresh.resolve({ ok: false, error: { kind: "network" } });
    });
    expect(result.current.investigations).toEqual({
      status: "failed",
      error: { kind: "network" },
      previous: [created, ...original],
    });
    expect(result.current.successfulSnapshotGeneration).toBe(1);
  });

  it("does not make a pre-focus in-flight request fresh when it completes after the transition", async () => {
    const beforeFocus = createDeferred<GatewayResult<readonly CaseV1[]>>();
    const afterFocus = createDeferred<GatewayResult<readonly CaseV1[]>>();
    const requests = [beforeFocus, afterFocus];
    let requestIndex = 0;
    const focused = { ...makeSparseImportedCase(), id: "case-focused-after-request-start" };
    const gateway = gatewayWith(() => requests[requestIndex++]!.promise);
    const { result } = renderHook(() => useInvestigationList({
      gateway,
      enabled: true,
      identityKey: "alice",
      authorityKey: "interactive:viewer",
    }));
    await waitFor(() => expect(result.current.latestRequestGeneration).toBe(1));

    // Model a route transition while request 1 is already in flight. Its later
    // success remains generation 1 and therefore cannot validate this focus.
    const focusBaseline = result.current.latestRequestGeneration;
    await act(async () => {
      beforeFocus.resolve({ ok: true, value: makeCaseList().cases });
    });
    expect(result.current.successfulSnapshotGeneration).toBe(focusBaseline);
    expect(result.current.successfulSnapshotGeneration > focusBaseline).toBe(false);

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.latestRequestGeneration).toBe(2));
    await act(async () => {
      afterFocus.resolve({ ok: true, value: [focused, ...makeCaseList().cases] });
    });
    expect(result.current.successfulSnapshotGeneration).toBe(2);
    expect(result.current.successfulSnapshotGeneration > focusBaseline).toBe(true);
  });

  it("ignores publication before data exists and from a stale identity callback", async () => {
    const requests: Array<ReturnType<typeof createDeferred<GatewayResult<readonly CaseV1[]>>>> = [];
    const gateway = gatewayWith(() => {
      const deferred = createDeferred<GatewayResult<readonly CaseV1[]>>();
      requests.push(deferred);
      return deferred.promise;
    });
    const initialProps = { identityKey: "alice", authorityKey: "interactive:viewer" };
    const { result, rerender } = renderHook(
      (props) => useInvestigationList({ gateway, enabled: true, ...props }),
      { initialProps },
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    const stalePublish = result.current.publishInvestigation;
    act(() => stalePublish(makePopulatedCase()));
    expect(result.current.investigations).toEqual({ status: "loading" });

    rerender({ ...initialProps, identityKey: "bob" });
    await waitFor(() => expect(requests).toHaveLength(2));
    act(() => stalePublish(makePopulatedCase()));
    expect(result.current.investigations).toEqual({ status: "loading" });
  });

  it("contains an unexpected gateway rejection as a bounded failure", async () => {
    const gateway = gatewayWith(() => Promise.reject(new Error("private rejection")));
    const { result } = renderHook(() => useInvestigationList({
      gateway,
      enabled: true,
      identityKey: "alice",
      authorityKey: "interactive:viewer",
    }));

    await waitFor(() => expect(result.current.investigations).toEqual({
      status: "failed",
      error: { kind: "unexpected" },
    }));
    expect(JSON.stringify(result.current.investigations)).not.toContain("private rejection");
  });

  it("keeps the published collection visible when a same-scope refresh fails", async () => {
    const first = createDeferred<GatewayResult<readonly CaseV1[]>>();
    const refresh = createDeferred<GatewayResult<readonly CaseV1[]>>();
    const requests = [first, refresh];
    let requestIndex = 0;
    const gateway = gatewayWith(() => requests[requestIndex++]!.promise);
    const { result } = renderHook(() => useInvestigationList({
      gateway,
      enabled: true,
      identityKey: "alice",
      authorityKey: "interactive:viewer",
    }));

    expect(result.current.investigations).toEqual({ status: "loading" });
    await act(async () => {
      first.resolve({ ok: true, value: makeCaseList().cases });
    });
    const published = makeCaseList().cases;
    expect(result.current.investigations).toEqual({ status: "ready", value: published });

    act(() => result.current.refresh());
    expect(result.current.investigations).toEqual({ status: "loading", previous: published });
    await act(async () => {
      refresh.resolve({ ok: false, error: { kind: "network" } });
    });
    expect(result.current.investigations).toEqual({
      status: "failed",
      error: { kind: "network" },
      previous: published,
    });
  });

  it.each([
    ["identity", { identityKey: "bob", authorityKey: "interactive:viewer" }],
    ["authority", { identityKey: "alice", authorityKey: "static:viewer" }],
  ] as const)("clears and aborts on a %s scope change", async (_label, nextScope) => {
    const requests: Array<{
      signal: AbortSignal;
      deferred: ReturnType<typeof createDeferred<GatewayResult<readonly CaseV1[]>>>;
    }> = [];
    const gateway = gatewayWith(({ signal }) => {
      const deferred = createDeferred<GatewayResult<readonly CaseV1[]>>();
      requests.push({ signal, deferred });
      return deferred.promise;
    });
    const { result, rerender } = renderHook(
      ({ identityKey, authorityKey }) => useInvestigationList({
        gateway,
        enabled: true,
        identityKey,
        authorityKey,
      }),
      { initialProps: { identityKey: "alice", authorityKey: "interactive:viewer" } },
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => {
      requests[0]!.deferred.resolve({ ok: true, value: [makePopulatedCase()] });
    });
    expect(result.current.investigations.status).toBe("ready");

    rerender(nextScope);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(result.current.investigations).toEqual({ status: "loading" });

    await act(async () => {
      requests[1]!.deferred.resolve({ ok: true, value: [makeSparseImportedCase()] });
    });
    expect(result.current.investigations).toEqual({
      status: "ready",
      value: [makeSparseImportedCase()],
    });
  });

  it("aborts setup cleanly when a StrictMode tree is remounted", async () => {
    const requests: Array<{
      signal: AbortSignal;
      deferred: ReturnType<typeof createDeferred<GatewayResult<readonly CaseV1[]>>>;
    }> = [];
    const gateway = gatewayWith(({ signal }) => {
      const deferred = createDeferred<GatewayResult<readonly CaseV1[]>>();
      requests.push({ signal, deferred });
      return deferred.promise;
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );
    const firstMount = renderHook(() => useInvestigationList({
      gateway,
      enabled: true,
      identityKey: "alice",
      authorityKey: "interactive:viewer",
    }), { wrapper });
    await waitFor(() => expect(requests).toHaveLength(1));
    firstMount.unmount();
    expect(requests[0]!.signal.aborted).toBe(true);
    const secondMount = renderHook(() => useInvestigationList({
      gateway,
      enabled: true,
      identityKey: "alice",
      authorityKey: "interactive:viewer",
    }), { wrapper });
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => {
      requests[0]!.deferred.resolve({ ok: true, value: [makePopulatedCase()] });
    });
    expect(secondMount.result.current.investigations).toEqual({ status: "loading" });
    await act(async () => {
      requests[1]!.deferred.resolve({ ok: true, value: [makeSparseImportedCase()] });
    });
    expect(secondMount.result.current.investigations).toEqual({
      status: "ready",
      value: [makeSparseImportedCase()],
    });
  });
});

const OPAQUE_COLLECTION_CURSOR = "eyJzZXJ2ZXJPd25lZCI6dHJ1ZX0";

function collectionPage(
  overrides: Record<string, unknown> = {},
): InvestigationCollectionPageV1 {
  return parseInvestigationCollectionPage({
    schemaId: INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID,
    items: makeCaseList().cases,
    nextCursor: null,
    hiddenArchivedCount: 0,
    facets: {
      status: { top: [], otherCount: 0 },
      entity: { top: [], otherCount: 0 },
      impactIdentity: { top: [], otherCount: 0 },
      contributor: { top: [], otherCount: 0 },
    },
    ...overrides,
  });
}

function queryGatewayWith(
  queryInvestigations: InvestigationCollectionQueryGateway["queryInvestigations"],
): InvestigationCollectionQueryGateway {
  return { queryInvestigations };
}

describe("useInvestigationCollectionQuery", () => {
  it("does not load while disabled or without a query", async () => {
    const queryInvestigations = async () => ({
      ok: true as const,
      value: collectionPage(),
    });
    const gateway = queryGatewayWith(queryInvestigations);
    const { result, rerender } = renderHook(
      ({ enabled, query }) => useInvestigationCollectionQuery({
        gateway,
        enabled,
        identityKey: "alice",
        authorityKey: "interactive:viewer",
        query,
      }),
      { initialProps: { enabled: false, query: null as InvestigationCollectionQueryInput | null } },
    );

    expect(result.current.page).toEqual({ status: "idle" });
    expect(result.current.query).toBeNull();

    rerender({ enabled: true, query: null });
    expect(result.current.page).toEqual({ status: "idle" });

    rerender({ enabled: false, query: { q: "checkout" } });
    expect(result.current.page).toEqual({ status: "idle" });
  });

  it("retains previous confirmed data while refreshing and stays failed after a failed refresh", async () => {
    const first = collectionPage({ hiddenArchivedCount: 1 });
    const refresh = createDeferred<GatewayResult<InvestigationCollectionPageV1>>();
    let requestCount = 0;
    const gateway = queryGatewayWith(() => {
      requestCount += 1;
      return requestCount === 1 ? Promise.resolve({ ok: true, value: first }) : refresh.promise;
    });
    const { result } = renderHook(() => useInvestigationCollectionQuery({
      gateway,
      enabled: true,
      identityKey: "alice",
      authorityKey: "interactive:viewer",
      query: { q: "checkout" },
    }));

    await waitFor(() => expect(result.current.page.status).toBe("ready"));
    expect(result.current.page).toEqual({ status: "ready", value: first });
    expect(result.current.query?.q).toBe("checkout");

    act(() => result.current.refresh());
    expect(result.current.page).toEqual({ status: "loading", previous: first });

    await act(async () => {
      refresh.resolve({ ok: false, error: { kind: "network" } });
    });
    expect(result.current.page).toEqual({
      status: "failed",
      error: { kind: "network" },
      previous: first,
    });
    expect(result.current.page.status).not.toBe("ready");
    expect(result.current.successfulSnapshotGeneration).toBe(1);
  });

  it("keeps a failed first page failed instead of looking empty", async () => {
    const gateway = queryGatewayWith(async () => ({
      ok: false,
      error: { kind: "unavailable", status: 503 },
    }));
    const { result } = renderHook(() => useInvestigationCollectionQuery({
      gateway,
      enabled: true,
      identityKey: "alice",
      authorityKey: "interactive:viewer",
      query: { q: "checkout" },
    }));

    await waitFor(() => expect(result.current.page).toEqual({
      status: "failed",
      error: { kind: "unavailable", status: 503 },
    }));
    expect(result.current.page).not.toEqual({ status: "ready", value: expect.anything() });
    expect(result.current.query?.q).toBe("checkout");
  });

  it("does not publish a stale query response after a filter transition", async () => {
    const first = createDeferred<GatewayResult<InvestigationCollectionPageV1>>();
    const second = createDeferred<GatewayResult<InvestigationCollectionPageV1>>();
    const requests: InvestigationCollectionQueryInput[] = [];
    const pages = [first, second];
    let requestIndex = 0;
    const gateway = queryGatewayWith((query) => {
      requests.push(query);
      return pages[requestIndex++]!.promise;
    });
    const { result, rerender } = renderHook(
      ({ query }) => useInvestigationCollectionQuery({
        gateway,
        enabled: true,
        identityKey: "alice",
        authorityKey: "interactive:viewer",
        query,
      }),
      { initialProps: { query: { q: "checkout" } as InvestigationCollectionQueryInput } },
    );
    await waitFor(() => expect(requests).toHaveLength(1));

    rerender({ query: { q: "inventory" } });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(result.current.page).toEqual({ status: "loading" });

    await act(async () => {
      first.resolve({ ok: true, value: collectionPage({ hiddenArchivedCount: 4 }) });
    });
    expect(result.current.page).toEqual({ status: "loading" });
    expect(result.current.query?.q).toBe("inventory");

    const nextPage = collectionPage({
      items: [makeSparseImportedCase()],
      hiddenArchivedCount: 0,
    });
    await act(async () => {
      second.resolve({ ok: true, value: nextPage });
    });
    expect(result.current.page).toEqual({ status: "ready", value: nextPage });
    expect(result.current.query?.q).toBe("inventory");
  });

  it.each([
    ["identity", { identityKey: "bob", authorityKey: "interactive:viewer" }],
    ["authority", { identityKey: "alice", authorityKey: "static:viewer" }],
  ] as const)("clears and aborts on a %s scope change", async (_label, nextScope) => {
    const requests: Array<{
      signal: AbortSignal;
      deferred: ReturnType<typeof createDeferred<GatewayResult<InvestigationCollectionPageV1>>>;
    }> = [];
    const gateway = queryGatewayWith((_query, { signal }) => {
      const deferred = createDeferred<GatewayResult<InvestigationCollectionPageV1>>();
      requests.push({ signal, deferred });
      return deferred.promise;
    });
    const { result, rerender } = renderHook(
      ({ identityKey, authorityKey }) => useInvestigationCollectionQuery({
        gateway,
        enabled: true,
        identityKey,
        authorityKey,
        query: { q: "checkout" },
      }),
      { initialProps: { identityKey: "alice", authorityKey: "interactive:viewer" } },
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => {
      requests[0]!.deferred.resolve({ ok: true, value: collectionPage() });
    });
    expect(result.current.page.status).toBe("ready");

    rerender(nextScope);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(result.current.page).toEqual({ status: "loading" });

    const nextPage = collectionPage({ items: [makeSparseImportedCase()] });
    await act(async () => {
      requests[1]!.deferred.resolve({ ok: true, value: nextPage });
    });
    expect(result.current.page).toEqual({ status: "ready", value: nextPage });
  });

  it("accumulates cursor continuation in server order and keeps the prior page recoverable", async () => {
    const firstItem = makePopulatedCase();
    const secondItem = makeSparseImportedCase();
    const firstPage = collectionPage({ items: [firstItem], nextCursor: OPAQUE_COLLECTION_CURSOR });
    const secondPage = collectionPage({
      items: [secondItem],
      nextCursor: null,
      hiddenArchivedCount: 3,
      facets: {
        status: { top: [{ key: "monitoring", count: 7 }], otherCount: 2 },
        entity: { top: [], otherCount: 0 },
        impactIdentity: { top: [], otherCount: 0 },
        contributor: { top: [], otherCount: 0 },
      },
    });
    const first = createDeferred<GatewayResult<InvestigationCollectionPageV1>>();
    const second = createDeferred<GatewayResult<InvestigationCollectionPageV1>>();
    const requests: InvestigationCollectionQueryInput[] = [];
    const pages = [first, second];
    let requestIndex = 0;
    const gateway = queryGatewayWith((query) => {
      requests.push(query);
      return pages[requestIndex++]!.promise;
    });
    const { result, rerender } = renderHook(
      ({ query }) => useInvestigationCollectionQuery({
        gateway,
        enabled: true,
        identityKey: "alice",
        authorityKey: "interactive:viewer",
        query,
      }),
      { initialProps: { query: { q: "checkout" } as InvestigationCollectionQueryInput } },
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => {
      first.resolve({ ok: true, value: firstPage });
    });
    expect(result.current.page).toEqual({ status: "ready", value: firstPage });

    rerender({ query: { q: "checkout", cursor: firstPage.nextCursor } });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]?.cursor).toBe(OPAQUE_COLLECTION_CURSOR);
    expect(result.current.page).toEqual({ status: "loading", previous: firstPage });

    await act(async () => {
      second.resolve({ ok: true, value: secondPage });
    });
    expect(result.current.page).toEqual({
      status: "ready",
      value: { ...secondPage, items: [firstItem, secondItem] },
    });
    if (result.current.page.status !== "ready") throw new Error("expected accumulated page");
    expect(result.current.page.value.hiddenArchivedCount).toBe(3);
    expect(result.current.page.value.facets.status).toEqual({
      top: [{ key: "monitoring", count: 7 }],
      otherCount: 2,
    });
    expect(result.current.query?.cursor).toBe(OPAQUE_COLLECTION_CURSOR);
  });

  it("retains the accumulated page when cursor continuation fails", async () => {
    const firstPage = collectionPage({ items: [makePopulatedCase()], nextCursor: OPAQUE_COLLECTION_CURSOR });
    const gateway = queryGatewayWith(async (query) => query.cursor === null || query.cursor === undefined
      ? { ok: true, value: firstPage }
      : { ok: false, error: { kind: "unavailable", status: 503 } });
    const { result, rerender } = renderHook(
      ({ query }) => useInvestigationCollectionQuery({
        gateway,
        enabled: true,
        identityKey: "alice",
        authorityKey: "interactive:viewer",
        query,
      }),
      { initialProps: { query: { q: "checkout" } as InvestigationCollectionQueryInput } },
    );
    await waitFor(() => expect(result.current.page).toEqual({ status: "ready", value: firstPage }));

    rerender({ query: { q: "checkout", cursor: OPAQUE_COLLECTION_CURSOR } });
    await waitFor(() => expect(result.current.page).toEqual({
      status: "failed",
      error: { kind: "unavailable", status: 503 },
      previous: firstPage,
    }));
  });

  it("fails a malformed query without calling the gateway", async () => {
    let calls = 0;
    const gateway = queryGatewayWith(async () => {
      calls += 1;
      return { ok: true, value: collectionPage() };
    });
    const { result } = renderHook(() => useInvestigationCollectionQuery({
      gateway,
      enabled: true,
      identityKey: "alice",
      authorityKey: "interactive:viewer",
      query: { limit: 101 },
    }));

    await waitFor(() => expect(result.current.page).toEqual({
      status: "failed",
      error: { kind: "protocol", reason: "contract" },
    }));
    expect(calls).toBe(0);
    expect(result.current.query).toBeNull();
  });

  it("aborts setup cleanly when a StrictMode tree is remounted", async () => {
    const requests: Array<{
      signal: AbortSignal;
      deferred: ReturnType<typeof createDeferred<GatewayResult<InvestigationCollectionPageV1>>>;
    }> = [];
    const gateway = queryGatewayWith((_query, { signal }) => {
      const deferred = createDeferred<GatewayResult<InvestigationCollectionPageV1>>();
      requests.push({ signal, deferred });
      return deferred.promise;
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );
    const firstMount = renderHook(() => useInvestigationCollectionQuery({
      gateway,
      enabled: true,
      identityKey: "alice",
      authorityKey: "interactive:viewer",
      query: { q: "checkout" },
    }), { wrapper });
    await waitFor(() => expect(requests).toHaveLength(1));
    firstMount.unmount();
    expect(requests[0]!.signal.aborted).toBe(true);
    const secondMount = renderHook(() => useInvestigationCollectionQuery({
      gateway,
      enabled: true,
      identityKey: "alice",
      authorityKey: "interactive:viewer",
      query: { q: "checkout" },
    }), { wrapper });
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => {
      requests[0]!.deferred.resolve({ ok: true, value: collectionPage() });
    });
    expect(secondMount.result.current.page).toEqual({ status: "loading" });
    const nextPage = collectionPage({ items: [makeSparseImportedCase()] });
    await act(async () => {
      requests[1]!.deferred.resolve({ ok: true, value: nextPage });
    });
    expect(secondMount.result.current.page).toEqual({ status: "ready", value: nextPage });
  });
});
