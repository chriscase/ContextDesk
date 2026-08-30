import type { CaseV1 } from "@cd-collab/contracts";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  GatewayResult,
  InvestigationGateway,
} from "../gateway.js";
import {
  makeCaseList,
  makePopulatedCase,
  makeSparseImportedCase,
} from "../testkit/fixtures.js";
import { createDeferred } from "../testkit/promises.js";
import { useInvestigationList } from "./use-investigation-list.js";

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

    act(() => result.current.publishInvestigation(created));
    expect(result.current.investigations).toEqual({
      status: "ready",
      value: [created, ...original],
    });
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
