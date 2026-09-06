import {
  PERMANENT_UNKNOWN_SOURCE_ID,
  SOURCE_LIST_SCHEMA_ID,
  SOURCE_MUTATION_REFUSED_SCHEMA_ID,
  SOURCE_MUTATION_SUCCESS_SCHEMA_ID,
  SOURCE_SCHEMA_ID,
  type SourceMutationAction,
  type SourceMutationRefusedV1,
  type SourceMutationSuccessV1,
  type SourceV1,
} from "@cd-collab/contracts/source-catalog";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SourceCatalogFailure,
  SourceCatalogGateway,
  SourceCatalogResult,
} from "./gateway.js";
import {
  SOURCE_CATALOG_CHANGED_EVENT,
  useSourceCatalog,
  type SourceCreateIntent,
} from "./use-source-catalog.js";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";

function source(overrides: Partial<SourceV1> = {}): SourceV1 {
  return {
    schemaId: SOURCE_SCHEMA_ID,
    id: SOURCE_ID,
    name: "Synthetic assistant",
    kind: "external-tool",
    description: "Synthetic fixture",
    lifecycle: "active",
    identityId: null,
    createdAt: "2026-09-05T12:00:00.000Z",
    createdBy: "attr:creator",
    revision: 1,
    ...overrides,
  };
}

function success(
  action: SourceMutationAction,
  applied: SourceV1 & { revision: number },
  replayed = false,
): SourceMutationSuccessV1 {
  const previousRevision = action === "create" ? 0 : applied.revision - 1;
  return {
    schemaId: SOURCE_MUTATION_SUCCESS_SCHEMA_ID,
    action,
    sourceId: applied.id,
    expectedRevision: previousRevision,
    previousRevision,
    appliedRevision: applied.revision,
    replayed,
    applied,
  };
}

function refused(
  action: SourceMutationAction,
  reason: SourceMutationRefusedV1["reason"],
  current: SourceV1 | null,
  expectedRevision: number,
): SourceMutationRefusedV1 {
  return {
    schemaId: SOURCE_MUTATION_REFUSED_SCHEMA_ID,
    error: "source_catalog_refused",
    action,
    sourceId: current?.id ?? SOURCE_ID,
    expectedRevision,
    reason,
    detail: "The source changed before this action was applied.",
    current,
  };
}

function ok<T>(value: T): SourceCatalogResult<T> {
  return { ok: true, value } as SourceCatalogResult<T>;
}

function fail<T>(error: SourceCatalogFailure): SourceCatalogResult<T> {
  return { ok: false, error };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function gatewayWith(overrides: Partial<SourceCatalogGateway> = {}): SourceCatalogGateway {
  return {
    list: vi.fn(async () => ok({ schemaId: SOURCE_LIST_SCHEMA_ID, sources: [source()] })),
    create: vi.fn(async () => fail<SourceMutationSuccessV1>({ kind: "unexpected" })),
    retire: vi.fn(async () => fail<SourceMutationSuccessV1>({ kind: "unexpected" })),
    restore: vi.fn(async () => fail<SourceMutationSuccessV1>({ kind: "unexpected" })),
    ...overrides,
  };
}

function options(gateway: SourceCatalogGateway, overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    canWrite: true,
    identityKey: "alice",
    authorityKey: "catalog-writer-v1",
    gateway,
    keyFactory: () => "source-key-0001",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useSourceCatalog", () => {
  it("gates all reads and writes while disabled", async () => {
    const gateway = gatewayWith();
    const { result } = renderHook(() => useSourceCatalog(options(gateway, {
      enabled: false,
    })));

    expect(result.current.resource).toEqual({ status: "idle" });
    await expect(result.current.actions.create({
      name: "Assistant",
      kind: "external-tool",
    })).resolves.toEqual({ status: "ignored", reason: "not_ready" });
    await expect(result.current.actions.retire(SOURCE_ID)).resolves.toEqual({
      status: "ignored",
      reason: "not_ready",
    });
    expect(gateway.list).not.toHaveBeenCalled();
    expect(gateway.create).not.toHaveBeenCalled();
    expect(gateway.retire).not.toHaveBeenCalled();
  });

  it("keeps same-scope rows through loading and refresh failure", async () => {
    const refresh = deferred<SourceCatalogResult<{ schemaId: typeof SOURCE_LIST_SCHEMA_ID; sources: SourceV1[] }>>();
    const list = vi.fn()
      .mockResolvedValueOnce(ok({ schemaId: SOURCE_LIST_SCHEMA_ID, sources: [source()] }))
      .mockReturnValueOnce(refresh.promise);
    const gateway = gatewayWith({ list });
    const { result } = renderHook(() => useSourceCatalog(options(gateway)));

    await waitFor(() => expect(result.current.resource.status).toBe("ready"));
    const published = result.current.resource;
    expect(Object.isFrozen(published)).toBe(true);
    if (published.status !== "ready") throw new Error("expected ready");
    expect(Object.isFrozen(published.value)).toBe(true);
    expect(Object.isFrozen(published.value[0])).toBe(true);

    act(() => result.current.actions.refresh());
    await waitFor(() => expect(result.current.resource.status).toBe("loading"));
    expect(result.current.resource).toMatchObject({ previous: [{ id: SOURCE_ID }] });
    await act(async () => refresh.resolve({ ok: false, error: { kind: "network" } }));
    expect(result.current.resource).toMatchObject({
      status: "failed",
      error: { kind: "network" },
      previous: [{ id: SOURCE_ID }],
    });
  });

  it("retains an authoritative empty result across a same-scope refresh", async () => {
    const refresh = deferred<SourceCatalogResult<{
      schemaId: typeof SOURCE_LIST_SCHEMA_ID;
      sources: SourceV1[];
    }>>();
    const list = vi.fn()
      .mockResolvedValueOnce(ok({ schemaId: SOURCE_LIST_SCHEMA_ID, sources: [] }))
      .mockReturnValueOnce(refresh.promise);
    const gateway = gatewayWith({ list });
    const { result } = renderHook(() => useSourceCatalog(options(gateway)));
    await waitFor(() => expect(result.current.resource).toEqual({
      status: "ready",
      value: [],
    }));

    act(() => result.current.actions.refresh());
    await waitFor(() => expect(result.current.resource).toEqual({
      status: "loading",
      previous: [],
    }));
    await act(async () => refresh.resolve({ ok: false, error: { kind: "network" } }));
    expect(result.current.resource).toEqual({
      status: "failed",
      error: { kind: "network" },
      previous: [],
    });
  });

  it("aborts and suppresses a stale read across identity and authority changes", async () => {
    const first = deferred<SourceCatalogResult<{ schemaId: typeof SOURCE_LIST_SCHEMA_ID; sources: SourceV1[] }>>();
    const second = deferred<SourceCatalogResult<{ schemaId: typeof SOURCE_LIST_SCHEMA_ID; sources: SourceV1[] }>>();
    const signals: AbortSignal[] = [];
    const list = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? first.promise : second.promise;
    });
    const gateway = gatewayWith({ list });
    const { result, rerender } = renderHook(
      ({ identityKey, authorityKey }) => useSourceCatalog(options(gateway, {
        identityKey,
        authorityKey,
      })),
      { initialProps: { identityKey: "alice", authorityKey: "writer-a" } },
    );
    await waitFor(() => expect(signals).toHaveLength(1));

    rerender({ identityKey: "bob", authorityKey: "writer-b" });
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]!.aborted).toBe(true);
    await act(async () => first.resolve(ok({
      schemaId: SOURCE_LIST_SCHEMA_ID,
      sources: [source({ name: "Alice only" })],
    })));
    expect(result.current.resource.status).toBe("loading");
    await act(async () => second.resolve(ok({
      schemaId: SOURCE_LIST_SCHEMA_ID,
      sources: [source({ name: "Bob only" })],
    })));
    expect(result.current.resource).toMatchObject({
      status: "ready",
      value: [{ name: "Bob only" }],
    });
  });

  it("normalizes and freezes a create attempt, publishes success, refreshes, and emits once", async () => {
    const created = source({ name: "New assistant", description: null, revision: 1 });
    const requests: unknown[] = [];
    const gateway = gatewayWith({
      create: vi.fn(async (request) => {
        requests.push(request);
        return ok(success("create", created as SourceV1 & { revision: number }));
      }),
    });
    const changed = vi.fn();
    window.addEventListener(SOURCE_CATALOG_CHANGED_EVENT, changed);
    const { result } = renderHook(() => useSourceCatalog(options(gateway)));
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    const outcome = await act(async () => result.current.actions.create({
      name: "  New assistant  ",
      kind: "external-tool",
      description: "   ",
    }));
    expect(outcome.status).toBe("succeeded");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      name: "New assistant",
      description: null,
      identityId: null,
      expectedRevision: 0,
      idempotencyKey: "source-key-0001",
    });
    expect(Object.isFrozen(requests[0])).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(gateway.list).toHaveBeenCalledTimes(2));
    expect(Object.isFrozen(result.current.mutation)).toBe(true);
    window.removeEventListener(SOURCE_CATALOG_CHANGED_EVENT, changed);
  });

  it("prevents writes without canWrite, including additive lifecycle calls", async () => {
    const gateway = gatewayWith();
    const { result } = renderHook(() => useSourceCatalog(options(gateway, {
      canWrite: false,
    })));
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    await expect(result.current.actions.create({
      name: "Blocked",
      kind: "human",
    })).resolves.toEqual({ status: "ignored", reason: "not_ready" });
    await expect(result.current.actions.retire(SOURCE_ID)).resolves.toEqual({
      status: "ignored",
      reason: "not_ready",
    });
    expect(gateway.create).not.toHaveBeenCalled();
    expect(gateway.retire).not.toHaveBeenCalled();
    expect(result.current.mutation).toEqual({ status: "idle" });
  });

  it("keeps legacy and permanent Unknown rows nonmutable", async () => {
    const legacy = source();
    delete legacy.revision;
    const gateway = gatewayWith({
      list: vi.fn(async () => ok({
        schemaId: SOURCE_LIST_SCHEMA_ID,
        sources: [
          legacy,
          source({ id: PERMANENT_UNKNOWN_SOURCE_ID, name: "Unknown", revision: 7 }),
        ],
      })),
    });
    const { result } = renderHook(() => useSourceCatalog(options(gateway)));
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    await expect(result.current.actions.retire(SOURCE_ID)).resolves.toEqual({
      status: "ignored",
      reason: "not_ready",
    });
    await expect(
      result.current.actions.retire(PERMANENT_UNKNOWN_SOURCE_ID),
    ).resolves.toEqual({ status: "ignored", reason: "not_ready" });
    expect(gateway.retire).not.toHaveBeenCalled();
  });

  it("uses authoritative revisions for retire and restore", async () => {
    const retired = source({ lifecycle: "retired", revision: 2 });
    const restored = source({ lifecycle: "active", revision: 3 });
    let current = source();
    const retire = vi.fn(async () => {
      current = retired;
      return ok(success("retire", retired as SourceV1 & { revision: number }));
    });
    const restore = vi.fn(async () => {
      current = restored;
      return ok(success("restore", restored as SourceV1 & { revision: number }));
    });
    const gateway = gatewayWith({
      list: vi.fn(async () => ok({ schemaId: SOURCE_LIST_SCHEMA_ID, sources: [current] })),
      retire,
      restore,
    });
    let key = 0;
    const { result } = renderHook(() => useSourceCatalog(options(gateway, {
      keyFactory: () => `source-key-000${++key}`,
    })));
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    await act(async () => result.current.actions.retire(SOURCE_ID));
    expect(retire).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: SOURCE_ID,
      expectedRevision: 1,
      idempotencyKey: "source-key-0001",
    }), expect.any(AbortSignal));
    await waitFor(() => expect(result.current.resource).toMatchObject({
      value: [{ lifecycle: "retired", revision: 2 }],
    }));
    await act(async () => result.current.actions.restore(SOURCE_ID));
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: SOURCE_ID,
      expectedRevision: 2,
      idempotencyKey: "source-key-0002",
    }), expect.any(AbortSignal));
  });

  it("does not let an older refresh overwrite a mutation result", async () => {
    const staleRefresh = deferred<SourceCatalogResult<{
      schemaId: typeof SOURCE_LIST_SCHEMA_ID;
      sources: SourceV1[];
    }>>();
    const refreshed = source({ lifecycle: "retired", revision: 2 });
    const signals: AbortSignal[] = [];
    let call = 0;
    const list = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      call += 1;
      if (call === 1) return Promise.resolve(ok({
        schemaId: SOURCE_LIST_SCHEMA_ID,
        sources: [source()],
      }));
      if (call === 2) return staleRefresh.promise;
      return Promise.resolve(ok({ schemaId: SOURCE_LIST_SCHEMA_ID, sources: [refreshed] }));
    });
    const gateway = gatewayWith({
      list,
      retire: vi.fn(async () => ok(success(
        "retire",
        refreshed as SourceV1 & { revision: number },
      ))),
    });
    const { result } = renderHook(() => useSourceCatalog(options(gateway)));
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));
    act(() => result.current.actions.refresh());
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    await act(async () => result.current.actions.retire(SOURCE_ID));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    expect(signals[1]!.aborted).toBe(true);
    await act(async () => staleRefresh.resolve(ok({
      schemaId: SOURCE_LIST_SCHEMA_ID,
      sources: [source({ name: "Stale active row" })],
    })));
    expect(result.current.resource).toMatchObject({
      status: "ready",
      value: [{ lifecycle: "retired", revision: 2 }],
    });
  });

  it.each(["network", "commit_outcome_unknown"] as const)(
    "freezes an exact %s unknown-outcome retry and emits only after confirmation",
    async (kind) => {
      const applied = source({ lifecycle: "retired", revision: 2 });
      const attempts: unknown[] = [];
      const retire = vi.fn(async (request) => {
        attempts.push(request);
        return attempts.length === 1
          ? { ok: false as const, error: kind === "network"
              ? { kind: "network" as const }
              : { kind: "commit_outcome_unknown" as const, status: 503 as const } }
          : ok(success("retire", applied as SourceV1 & { revision: number }, true));
      });
      const gateway = gatewayWith({ retire });
      const changed = vi.fn();
      window.addEventListener(SOURCE_CATALOG_CHANGED_EVENT, changed);
      const keyFactory = vi.fn(() => "source-uncertain-0001");
      const { result } = renderHook(() => useSourceCatalog(options(gateway, { keyFactory })));
      await waitFor(() => expect(result.current.resource.status).toBe("ready"));

      await expect(act(async () => result.current.actions.retire(SOURCE_ID))).resolves.toEqual({
        status: "outcome_unknown",
      });
      await waitFor(() => expect(result.current.mutation).toEqual({
        status: "outcome_unknown",
        action: "retire",
        sourceId: SOURCE_ID,
      }));
      expect(changed).not.toHaveBeenCalled();
      await expect(result.current.actions.restore(SOURCE_ID)).resolves.toEqual({
        status: "ignored",
        reason: "busy",
      });

      await act(async () => result.current.actions.retryUnknown());
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toBe(attempts[0]);
      expect(keyFactory).toHaveBeenCalledTimes(1);
      expect(changed).toHaveBeenCalledTimes(1);
      window.removeEventListener(SOURCE_CATALOG_CHANGED_EVENT, changed);
    },
  );

  it("reconciles an expected-revision refusal and requires a new explicit intent", async () => {
    const current = source({ revision: 2 });
    const retired = source({ lifecycle: "retired", revision: 3 });
    let listed = source();
    const requests: Array<{ expectedRevision: number; idempotencyKey: string }> = [];
    const retire = vi.fn(async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        listed = current;
        return {
            ok: false as const,
            error: {
              kind: "refused" as const,
              status: 409 as const,
              refusal: refused("retire", "expected_revision_mismatch", current, 1),
            },
          };
      }
      listed = retired;
      return ok(success("retire", retired as SourceV1 & { revision: number }));
    });
    let key = 0;
    const gateway = gatewayWith({
      list: vi.fn(async () => ok({ schemaId: SOURCE_LIST_SCHEMA_ID, sources: [listed] })),
      retire,
    });
    const changed = vi.fn();
    window.addEventListener(SOURCE_CATALOG_CHANGED_EVENT, changed);
    const { result } = renderHook(() => useSourceCatalog(options(gateway, {
      keyFactory: () => `source-conflict-000${++key}`,
    })));
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    const first = await act(async () => result.current.actions.retire(SOURCE_ID));
    expect(first.status).toBe("refused");
    expect(retire).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
    expect(result.current.resource).toMatchObject({
      value: [{ id: SOURCE_ID, revision: 2, lifecycle: "active" }],
    });

    await act(async () => result.current.actions.retire(SOURCE_ID));
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      expectedRevision: 1,
      idempotencyKey: "source-conflict-0001",
    });
    expect(requests[1]).toMatchObject({
      expectedRevision: 2,
      idempotencyKey: "source-conflict-0002",
    });
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener(SOURCE_CATALOG_CHANGED_EVENT, changed);
  });

  it("removes a row when a typed source-not-found refusal has no current row", async () => {
    let present = true;
    const gateway = gatewayWith({
      list: vi.fn(async () => ok({
        schemaId: SOURCE_LIST_SCHEMA_ID,
        sources: present ? [source()] : [],
      })),
      retire: vi.fn(async () => {
        present = false;
        return fail<SourceMutationSuccessV1>({
          kind: "refused",
          status: 409,
          refusal: refused("retire", "source_not_found", null, 1),
        });
      }),
    });
    const { result } = renderHook(() => useSourceCatalog(options(gateway)));
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));
    await act(async () => result.current.actions.retire(SOURCE_ID));
    await waitFor(() => expect(result.current.resource).toEqual({ status: "ready", value: [] }));
  });

  it("contains auth loss outside panel-local failure and retry state", async () => {
    const gateway = gatewayWith({
      retire: vi.fn(async () =>
        fail<SourceMutationSuccessV1>({ kind: "auth_lost", status: 403 })),
    });
    const { result } = renderHook(() => useSourceCatalog(options(gateway)));
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    await expect(act(async () => result.current.actions.retire(SOURCE_ID))).resolves.toEqual({
      status: "ignored",
      reason: "auth_lost",
    });
    expect(result.current.mutation).toEqual({ status: "idle" });
    await expect(result.current.actions.retryUnknown()).resolves.toEqual({
      status: "ignored",
      reason: "not_ready",
    });
  });

  it("contains read auth loss outside a panel-local failed resource", async () => {
    const pending = deferred<SourceCatalogResult<{
      schemaId: typeof SOURCE_LIST_SCHEMA_ID;
      sources: SourceV1[];
    }>>();
    const gateway = gatewayWith({ list: vi.fn(() => pending.promise) });
    const { result } = renderHook(() => useSourceCatalog(options(gateway)));
    await waitFor(() => expect(result.current.resource.status).toBe("loading"));

    await act(async () => pending.resolve({
      ok: false,
      error: { kind: "auth_lost", status: 401 },
    }));
    expect(result.current.resource).toEqual({ status: "idle" });
  });

  it("allows only one active mutation", async () => {
    const pending = deferred<SourceCatalogResult<SourceMutationSuccessV1>>();
    const gateway = gatewayWith({ retire: vi.fn(() => pending.promise) });
    const { result } = renderHook(() => useSourceCatalog(options(gateway)));
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    let completion!: Promise<unknown>;
    act(() => {
      completion = result.current.actions.retire(SOURCE_ID);
    });
    await waitFor(() => expect(result.current.mutation.status).toBe("running"));
    await expect(result.current.actions.create({
      name: "Concurrent source",
      kind: "human",
    })).resolves.toEqual({ status: "ignored", reason: "busy" });
    expect(gateway.create).not.toHaveBeenCalled();

    await act(async () => pending.resolve(ok(success(
      "retire",
      source({ lifecycle: "retired", revision: 2 }) as SourceV1 & { revision: number },
    ))));
    await completion;
  });

  it("aborts and suppresses mutation completion after authority revocation", async () => {
    const pending = deferred<SourceCatalogResult<SourceMutationSuccessV1>>();
    let signal: AbortSignal | undefined;
    const gateway = gatewayWith({
      retire: vi.fn((_request, requestSignal) => {
        signal = requestSignal;
        return pending.promise;
      }),
    });
    const changed = vi.fn();
    window.addEventListener(SOURCE_CATALOG_CHANGED_EVENT, changed);
    const { result, rerender } = renderHook(
      ({ canWrite, authorityKey }) => useSourceCatalog(options(gateway, {
        canWrite,
        authorityKey,
      })),
      { initialProps: { canWrite: true, authorityKey: "writer" } },
    );
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));
    let completion!: Promise<unknown>;
    act(() => {
      completion = result.current.actions.retire(SOURCE_ID);
    });
    await waitFor(() => expect(result.current.mutation.status).toBe("running"));

    rerender({ canWrite: false, authorityKey: "viewer" });
    await waitFor(() => expect(signal?.aborted).toBe(true));
    await act(async () => pending.resolve(ok(success(
      "retire",
      source({ lifecycle: "retired", revision: 2 }) as SourceV1 & { revision: number },
    ))));
    await expect(completion).resolves.toEqual({ status: "ignored", reason: "stale" });
    expect(result.current.mutation).toEqual({ status: "idle" });
    expect(changed).not.toHaveBeenCalled();
    window.removeEventListener(SOURCE_CATALOG_CHANGED_EVENT, changed);
  });

  it("aborts active reads and mutations on unmount", async () => {
    const read = deferred<SourceCatalogResult<{
      schemaId: typeof SOURCE_LIST_SCHEMA_ID;
      sources: SourceV1[];
    }>>();
    let readSignal: AbortSignal | undefined;
    const readGateway = gatewayWith({
      list: vi.fn((signal) => {
        readSignal = signal;
        return read.promise;
      }),
    });
    const readHook = renderHook(() => useSourceCatalog(options(readGateway)));
    await waitFor(() => expect(readSignal).toBeDefined());
    readHook.unmount();
    expect(readSignal?.aborted).toBe(true);

    let mutationSignal: AbortSignal | undefined;
    const mutation = deferred<SourceCatalogResult<SourceMutationSuccessV1>>();
    const mutationGateway = gatewayWith({
      retire: vi.fn((_request, signal) => {
        mutationSignal = signal;
        return mutation.promise;
      }),
    });
    const mutationHook = renderHook(() => useSourceCatalog(options(mutationGateway)));
    await waitFor(() => expect(mutationHook.result.current.resource.status).toBe("ready"));
    act(() => {
      void mutationHook.result.current.actions.retire(SOURCE_ID);
    });
    await waitFor(() => expect(mutationSignal).toBeDefined());
    mutationHook.unmount();
    expect(mutationSignal?.aborted).toBe(true);
  });

  it("fails malformed local intent without transport and keeps actions stable", async () => {
    const gateway = gatewayWith();
    const { result, rerender } = renderHook(() => useSourceCatalog(options(gateway)));
    const actions = result.current.actions;
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    const outcome = await act(async () => result.current.actions.create({
      name: "   ",
      kind: "human",
    }));
    expect(outcome).toEqual({ status: "failed", error: { kind: "invalid_request" } });
    expect(gateway.create).not.toHaveBeenCalled();
    expect(result.current.mutation).toEqual({
      status: "failed",
      action: "create",
      error: { kind: "invalid_request" },
    });
    rerender();
    expect(result.current.actions).toBe(actions);
    expect(Object.isFrozen(result.current.actions)).toBe(true);
    act(() => result.current.actions.dismissMutation());
    expect(result.current.mutation).toEqual({ status: "idle" });
  });

  it("publishes bounded create and lifecycle failures when request-key generation throws", async () => {
    const gateway = gatewayWith();
    const { result } = renderHook(() => useSourceCatalog(options(gateway, {
      keyFactory: () => {
        throw new Error("private key source failure");
      },
    })));
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));

    await expect(act(async () => result.current.actions.create({
      name: "Assistant",
      kind: "external-tool",
    }))).resolves.toEqual({ status: "failed", error: { kind: "unexpected" } });
    await waitFor(() => expect(result.current.mutation).toEqual({
      status: "failed",
      action: "create",
      error: { kind: "unexpected" },
    }));
    act(() => result.current.actions.dismissMutation());

    await expect(act(async () => result.current.actions.retire(SOURCE_ID))).resolves.toEqual({
      status: "failed",
      error: { kind: "unexpected" },
    });
    await waitFor(() => expect(result.current.mutation).toEqual({
      status: "failed",
      action: "retire",
      error: { kind: "unexpected" },
    }));
    expect(gateway.create).not.toHaveBeenCalled();
    expect(gateway.retire).not.toHaveBeenCalled();
    expect(JSON.stringify(result.current.mutation)).not.toContain("private key source failure");
  });

  it("contains hostile create getters without transport", async () => {
    const gateway = gatewayWith();
    const { result } = renderHook(() => useSourceCatalog(options(gateway)));
    await waitFor(() => expect(result.current.resource.status).toBe("ready"));
    const hostile: SourceCreateIntent = Object.defineProperty({
      name: "Hostile",
      kind: "human" as const,
    }, "description", {
      get() {
        throw new Error("private getter failure");
      },
    });

    await expect(act(async () => result.current.actions.create(hostile))).resolves.toEqual({
      status: "failed",
      error: { kind: "unexpected" },
    });
    expect(gateway.create).not.toHaveBeenCalled();
    expect(JSON.stringify(result.current.mutation)).not.toContain("private getter failure");
  });
});
