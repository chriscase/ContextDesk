import {
  INVESTIGATION_COORDINATION_ACTION_SUCCESS_SCHEMA_ID,
  INVESTIGATION_COORDINATION_SCHEMA_ID,
  type InvestigationCoordinationActionSuccessV1,
  type InvestigationCoordinationV1,
} from "@cd-collab/contracts/investigation-runtime";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvestigationCoordinationGateway } from "../gateway.js";
import { createDeferred } from "../testkit/promises.js";
import {
  useInvestigationCoordination,
  type InvestigationCoordinationCommand,
  type UseInvestigationCoordinationOptions,
} from "./use-investigation-coordination.js";

const CASE_ID = "case-coordination-runtime";
const ACTOR_ID = "identity-alice";
const actor = { identityId: ACTOR_ID, username: "alice" } as const;

afterEach(() => cleanup());

function coordination(revision = 2): InvestigationCoordinationV1 {
  return {
    schemaId: INVESTIGATION_COORDINATION_SCHEMA_ID,
    investigationId: CASE_ID,
    coordinator: null,
    revision,
    updatedAt: "2026-02-03T20:00:00.000Z",
    updatedBy: actor,
    archived: false,
  };
}

function claimSuccess(previousRevision = 2): InvestigationCoordinationActionSuccessV1 {
  return {
    schemaId: INVESTIGATION_COORDINATION_ACTION_SUCCESS_SCHEMA_ID,
    investigationId: CASE_ID,
    action: "claim_self",
    targetIdentityId: null,
    previousRevision,
    previousCoordinator: null,
    applied: {
      ...coordination(previousRevision + 1),
      coordinator: actor,
      updatedBy: actor,
    },
  };
}

function gateway(
  overrides: Partial<InvestigationCoordinationGateway> = {},
): InvestigationCoordinationGateway {
  return {
    getCoordination: vi.fn(async () => ({ ok: true as const, value: coordination() })),
    applyCoordinationAction: vi.fn(async () => ({ ok: true as const, value: claimSuccess() })),
    ...overrides,
  };
}

function options(
  transport: InvestigationCoordinationGateway,
  overrides: Partial<UseInvestigationCoordinationOptions> = {},
): UseInvestigationCoordinationOptions {
  return {
    gateway: transport,
    identityKey: "alice-session",
    authorityKey: "alice-authority-v1",
    actorIdentityId: ACTOR_ID,
    investigationId: CASE_ID,
    active: true,
    canRead: true,
    canCoordinateSelf: true,
    canCoordinateParticipants: false,
    readOnly: false,
    onScopeDenied: vi.fn(),
    ...overrides,
  };
}

describe("useInvestigationCoordination", () => {
  it("loads coordination and derives expectedRevision for one explicit action", async () => {
    const transport = gateway();
    const opts = options(transport);
    const { result } = renderHook(() => useInvestigationCoordination(opts));
    await waitFor(() => expect(result.current.coordination.status).toBe("ready"));

    const command = {
      action: "claim_self" as const,
      idempotencyKey: "coord-controller-0001",
      clientTime: "2026-02-03T20:01:00.000Z",
    };
    let outcome!: Awaited<ReturnType<typeof result.current.apply>>;
    await act(async () => {
      outcome = await result.current.apply(command);
    });
    expect(outcome).toEqual({ status: "succeeded", value: claimSuccess() });
    expect(Object.isFrozen(outcome)).toBe(true);
    if (outcome.status !== "succeeded") throw new Error("expected success");
    expect(Object.isFrozen(outcome.value)).toBe(true);
    const applied = outcome.value.applied;
    expect(Object.isFrozen(applied)).toBe(true);
    expect(() => {
      (applied as { revision: number }).revision = 99;
    }).toThrow(TypeError);
    expect(transport.applyCoordinationAction).toHaveBeenCalledOnce();
    expect(transport.applyCoordinationAction).toHaveBeenCalledWith(
      CASE_ID,
      { ...command, expectedRevision: 2 },
      { actorIdentityId: ACTOR_ID, signal: expect.any(AbortSignal) },
    );
    expect(result.current.coordination).toEqual({
      status: "ready",
      value: claimSuccess().applied,
    });
  });

  it("enforces the exact self and participant capability gates", async () => {
    const transport = gateway();
    const base = options(transport, { canCoordinateSelf: false });
    const { result, rerender } = renderHook(
      ({ value }: { value: UseInvestigationCoordinationOptions }) =>
        useInvestigationCoordination(value),
      { initialProps: { value: base } },
    );
    await waitFor(() => expect(result.current.coordination.status).toBe("ready"));
    const ignored = await result.current.apply({
      action: "claim_self",
      idempotencyKey: "coord-controller-0002",
    });
    expect(ignored).toEqual({ status: "ignored", reason: "not_ready" });
    expect(Object.isFrozen(ignored)).toBe(true);

    rerender({ value: { ...base, canCoordinateSelf: true, canCoordinateParticipants: false } });
    await waitFor(() => expect(result.current.coordination.status).toBe("ready"));
    await expect(result.current.apply({
      action: "assign_participant",
      targetIdentityId: "identity-bob",
      idempotencyKey: "coord-controller-0003",
    })).resolves.toEqual({ status: "ignored", reason: "not_ready" });
    expect(transport.applyCoordinationAction).not.toHaveBeenCalled();
  });

  it.each([
    ["claim_self", { action: "claim_self", idempotencyKey: "coord-matrix-claim" }, true, false],
    ["release_self", { action: "release_self", idempotencyKey: "coord-matrix-release" }, true, false],
    ["assign_participant", {
      action: "assign_participant",
      targetIdentityId: "identity-bob",
      idempotencyKey: "coord-matrix-assign",
    }, false, true],
    ["release_participant", {
      action: "release_participant",
      targetIdentityId: "identity-bob",
      idempotencyKey: "coord-matrix-release-participant",
    }, false, true],
  ] as const)("sends the %s action through its exact capability lane", async (
    _action,
    command,
    canCoordinateSelf,
    canCoordinateParticipants,
  ) => {
    const applyCoordinationAction = vi.fn<
      InvestigationCoordinationGateway["applyCoordinationAction"]
    >(async () => ({ ok: false, error: { kind: "network" } }));
    const transport = gateway({ applyCoordinationAction });
    const { result } = renderHook(() => useInvestigationCoordination(options(transport, {
      canCoordinateSelf,
      canCoordinateParticipants,
    })));
    await waitFor(() => expect(result.current.coordination.status).toBe("ready"));
    await act(async () => {
      await result.current.apply(command as InvestigationCoordinationCommand);
    });
    expect(applyCoordinationAction).toHaveBeenCalledOnce();
    expect(applyCoordinationAction.mock.calls[0]?.[1]).toMatchObject(command);
  });

  it("retains an unknown intent privately and only retries its exact payload explicitly", async () => {
    let current = coordination(2);
    const apply = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "unavailable", status: 503, reason: "commit_outcome_unknown" },
      })
      .mockResolvedValueOnce({ ok: true, value: claimSuccess(2) });
    const transport = gateway({
      getCoordination: vi.fn(async () => ({ ok: true as const, value: current })),
      applyCoordinationAction: apply,
    });
    const { result } = renderHook(() => useInvestigationCoordination(options(transport, {
      canCoordinateParticipants: true,
    })));
    await waitFor(() => expect(result.current.coordination.status).toBe("ready"));
    const command = {
      action: "claim_self" as const,
      idempotencyKey: "coord-controller-0004",
      clientTime: "2026-02-03T20:02:00.000Z",
    };
    let unavailable!: Awaited<ReturnType<typeof result.current.apply>>;
    await act(async () => {
      unavailable = await result.current.apply(command);
    });
    expect(apply).toHaveBeenCalledOnce();
    expect(Object.isFrozen(unavailable)).toBe(true);
    if (unavailable.status !== "failed") throw new Error("expected failure");
    const unavailableError = unavailable.error;
    expect(Object.isFrozen(unavailableError)).toBe(true);
    expect(() => {
      (unavailableError as { reason?: string }).reason = "rewritten";
    }).toThrow(TypeError);
    expect(Object.isFrozen(apply.mock.calls[0]?.[1])).toBe(true);
    expect(JSON.stringify(result.current.state)).not.toContain("expectedRevision");
    expect(JSON.stringify(result.current.state)).not.toContain(command.idempotencyKey);

    current = coordination(8);
    act(() => result.current.refresh());
    await waitFor(() => {
      expect(result.current.coordination).toMatchObject({
        status: "ready",
        value: { revision: 8 },
      });
    });
    await act(async () => {
      await result.current.apply(command);
    });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[1]?.[1]).toBe(apply.mock.calls[0]?.[1]);
    expect(apply.mock.calls[1]?.[1]).toEqual({ ...command, expectedRevision: 2 });
  });

  it("rejects same-key different intent locally with zero additional calls", async () => {
    const apply = vi.fn<InvestigationCoordinationGateway["applyCoordinationAction"]>(async () => ({
      ok: false as const,
      error: {
        kind: "unavailable" as const,
        status: 503 as const,
        reason: "commit_outcome_unknown" as const,
      },
    }));
    const transport = gateway({ applyCoordinationAction: apply });
    const { result } = renderHook(() => useInvestigationCoordination(options(transport, {
      canCoordinateParticipants: true,
    })));
    await waitFor(() => expect(result.current.coordination.status).toBe("ready"));
    await act(async () => {
      await result.current.apply({
        action: "claim_self",
        idempotencyKey: "coord-controller-0005",
      });
    });
    let outcome;
    await act(async () => {
      outcome = await result.current.apply({
        action: "assign_participant",
        targetIdentityId: "identity-bob",
        idempotencyKey: "coord-controller-0005",
      });
    });
    expect(outcome).toEqual({
      status: "failed",
      error: { kind: "input", field: "idempotencyKey", reason: "intent_mismatch" },
    });
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen((outcome as unknown as { error: object }).error)).toBe(true);
    expect(apply).toHaveBeenCalledOnce();
  });

  it("uses the latest ready revision when a new key starts a new intent", async () => {
    let current = coordination(2);
    const apply = vi.fn<InvestigationCoordinationGateway["applyCoordinationAction"]>(async () => ({
      ok: false as const,
      error: {
        kind: "unavailable" as const,
        status: 503 as const,
        reason: "commit_outcome_unknown" as const,
      },
    }));
    const transport = gateway({
      getCoordination: vi.fn(async () => ({ ok: true as const, value: current })),
      applyCoordinationAction: apply,
    });
    const { result } = renderHook(() => useInvestigationCoordination(options(transport, {
      canCoordinateParticipants: true,
    })));
    await waitFor(() => expect(result.current.coordination.status).toBe("ready"));
    await act(async () => {
      await result.current.apply({
        action: "claim_self",
        idempotencyKey: "coord-controller-old-key",
      });
    });

    current = coordination(8);
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.coordination).toMatchObject({
      status: "ready",
      value: { revision: 8 },
    }));
    await act(async () => {
      await result.current.apply({
        action: "assign_participant",
        targetIdentityId: " identity-bob ",
        idempotencyKey: "coord-controller-new-key",
      });
    });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[1]?.[1]).toEqual({
      action: "assign_participant",
      targetIdentityId: "identity-bob",
      expectedRevision: 8,
      idempotencyKey: "coord-controller-new-key",
    });
  });

  it.each([
    ["changed", {
      kind: "coordination_changed" as const,
      status: 409 as const,
      investigationId: CASE_ID,
      action: "claim_self" as const,
      targetIdentityId: null,
      current: coordination(7),
    }],
    ["refused", {
      kind: "coordination_refused" as const,
      status: 409 as const,
      investigationId: CASE_ID,
      action: "claim_self" as const,
      targetIdentityId: null,
      reason: "actor_not_eligible" as const,
      detail: "The actor is no longer eligible.",
      current: coordination(7),
    }],
  ])("publishes trusted coordination_%s current and derives the next revision", async (
    _kind,
    error,
  ) => {
    const applyCoordinationAction = vi.fn<
      InvestigationCoordinationGateway["applyCoordinationAction"]
    >()
      .mockResolvedValueOnce({ ok: false, error })
      .mockResolvedValueOnce({ ok: false, error: { kind: "network" } });
    const transport = gateway({ applyCoordinationAction });
    const { result } = renderHook(() => useInvestigationCoordination(options(transport)));
    await waitFor(() => expect(result.current.coordination.status).toBe("ready"));

    await act(async () => {
      await result.current.apply({
        action: "claim_self",
        idempotencyKey: `coord-current-${_kind}-1`,
      });
    });
    expect(result.current.coordination).toEqual({
      status: "ready",
      value: error.current,
    });
    expect(result.current.state).toEqual({ status: "failed", error });

    await act(async () => {
      await result.current.apply({
        action: "claim_self",
        idempotencyKey: `coord-current-${_kind}-2`,
      });
    });
    expect(applyCoordinationAction.mock.calls[1]?.[1]).toMatchObject({ expectedRevision: 7 });
  });

  it("allows only one transport action while an apply is busy", async () => {
    const pending = createDeferred<Awaited<ReturnType<
      InvestigationCoordinationGateway["applyCoordinationAction"]
    >>>();
    const applyCoordinationAction = vi.fn<
      InvestigationCoordinationGateway["applyCoordinationAction"]
    >(() => pending.promise);
    const transport = gateway({ applyCoordinationAction });
    const { result } = renderHook(() => useInvestigationCoordination(options(transport)));
    await waitFor(() => expect(result.current.coordination.status).toBe("ready"));

    let first!: ReturnType<typeof result.current.apply>;
    act(() => {
      first = result.current.apply({
        action: "claim_self",
        idempotencyKey: "coord-busy-first",
      });
    });
    const busy = await result.current.apply({
      action: "claim_self",
      idempotencyKey: "coord-busy-second",
    });
    expect(busy).toEqual({ status: "ignored", reason: "busy" });
    expect(Object.isFrozen(busy)).toBe(true);
    expect(applyCoordinationAction).toHaveBeenCalledOnce();

    pending.resolve({ ok: true, value: claimSuccess() });
    await act(async () => first);
    expect(applyCoordinationAction).toHaveBeenCalledOnce();
  });

  it("does not let an older delayed GET overwrite a newer POST projection", async () => {
    const delayedGet = createDeferred<Awaited<ReturnType<
      InvestigationCoordinationGateway["getCoordination"]
    >>>();
    const delayedPost = createDeferred<Awaited<ReturnType<
      InvestigationCoordinationGateway["applyCoordinationAction"]
    >>>();
    const getCoordination = vi.fn<InvestigationCoordinationGateway["getCoordination"]>()
      .mockResolvedValueOnce({ ok: true, value: coordination(2) })
      .mockImplementationOnce(() => delayedGet.promise);
    const applyCoordinationAction = vi.fn<
      InvestigationCoordinationGateway["applyCoordinationAction"]
    >()
      .mockImplementationOnce(() => delayedPost.promise)
      .mockResolvedValueOnce({ ok: false, error: { kind: "network" } });
    const transport = gateway({ getCoordination, applyCoordinationAction });
    const { result } = renderHook(() => useInvestigationCoordination(options(transport)));
    await waitFor(() => expect(result.current.coordination).toMatchObject({
      status: "ready",
      value: { revision: 2 },
    }));

    let first!: ReturnType<typeof result.current.apply>;
    act(() => {
      first = result.current.apply({
        action: "claim_self",
        idempotencyKey: "coord-order-post-newer",
      });
      result.current.refresh();
    });
    await waitFor(() => expect(getCoordination).toHaveBeenCalledTimes(2));
    expect(applyCoordinationAction).toHaveBeenCalledOnce();

    await act(async () => {
      delayedPost.resolve({ ok: true, value: claimSuccess(2) });
      await first;
    });
    expect(result.current.coordination).toMatchObject({
      status: "ready",
      value: { revision: 3 },
    });

    await act(async () => {
      delayedGet.resolve({ ok: true, value: coordination(2) });
      await delayedGet.promise;
    });
    expect(result.current.coordination).toMatchObject({
      status: "ready",
      value: { revision: 3 },
    });

    await act(async () => {
      await result.current.apply({
        action: "release_self",
        idempotencyKey: "coord-order-after-post",
      });
    });
    expect(applyCoordinationAction.mock.calls[1]?.[1]).toMatchObject({
      expectedRevision: 3,
    });
  });

  it.each(["network", "unexpected"] as const)(
    "ignores a delayed stale %s GET failure after a newer POST projection",
    async (failureKind) => {
      const delayedGet = createDeferred<Awaited<ReturnType<
        InvestigationCoordinationGateway["getCoordination"]
      >>>();
      const delayedPost = createDeferred<Awaited<ReturnType<
        InvestigationCoordinationGateway["applyCoordinationAction"]
      >>>();
      const getCoordination = vi.fn<InvestigationCoordinationGateway["getCoordination"]>()
        .mockResolvedValueOnce({ ok: true, value: coordination(2) })
        .mockImplementationOnce(() => delayedGet.promise);
      const applyCoordinationAction = vi.fn<
        InvestigationCoordinationGateway["applyCoordinationAction"]
      >()
        .mockImplementationOnce(() => delayedPost.promise)
        .mockResolvedValueOnce({ ok: false, error: { kind: "network" } });
      const transport = gateway({ getCoordination, applyCoordinationAction });
      const { result } = renderHook(() => useInvestigationCoordination(options(transport)));
      await waitFor(() => expect(result.current.coordination.status).toBe("ready"));

      let first!: ReturnType<typeof result.current.apply>;
      act(() => {
        first = result.current.apply({
          action: "claim_self",
          idempotencyKey: `coord-stale-${failureKind}-post`,
        });
        result.current.refresh();
      });
      await waitFor(() => expect(getCoordination).toHaveBeenCalledTimes(2));
      await act(async () => {
        delayedPost.resolve({ ok: true, value: claimSuccess(2) });
        await first;
      });
      expect(result.current.coordination).toMatchObject({
        status: "ready",
        value: { revision: 3 },
      });

      await act(async () => {
        if (failureKind === "network") {
          delayedGet.resolve({ ok: false, error: { kind: "network" } });
          await delayedGet.promise;
        } else {
          delayedGet.reject(new Error("stale transport rejection"));
          await delayedGet.promise.catch(() => undefined);
        }
      });
      expect(result.current.coordination).toMatchObject({
        status: "ready",
        value: { revision: 3 },
      });

      await act(async () => {
        await result.current.apply({
          action: "release_self",
          idempotencyKey: `coord-stale-${failureKind}-next`,
        });
      });
      expect(applyCoordinationAction.mock.calls[1]?.[1]).toMatchObject({
        expectedRevision: 3,
      });
    },
  );

  it.each([
    ["401", { kind: "auth_lost" as const, status: 401 as const }],
    ["403", { kind: "auth_lost" as const, status: 403 as const }],
    ["404", { kind: "not_found" as const, status: 404 as const }],
  ])("honors delayed terminal GET %s after a newer POST projection", async (_status, error) => {
    const delayedGet = createDeferred<Awaited<ReturnType<
      InvestigationCoordinationGateway["getCoordination"]
    >>>();
    const delayedPost = createDeferred<Awaited<ReturnType<
      InvestigationCoordinationGateway["applyCoordinationAction"]
    >>>();
    const onScopeDenied = vi.fn();
    const getCoordination = vi.fn<InvestigationCoordinationGateway["getCoordination"]>()
      .mockResolvedValueOnce({ ok: true, value: coordination(2) })
      .mockImplementationOnce(() => delayedGet.promise);
    const applyCoordinationAction = vi.fn<
      InvestigationCoordinationGateway["applyCoordinationAction"]
    >(() => delayedPost.promise);
    const transport = gateway({ getCoordination, applyCoordinationAction });
    const { result } = renderHook(() => useInvestigationCoordination(options(transport, {
      onScopeDenied,
    })));
    await waitFor(() => expect(result.current.coordination.status).toBe("ready"));

    let first!: ReturnType<typeof result.current.apply>;
    act(() => {
      first = result.current.apply({
        action: "claim_self",
        idempotencyKey: `coord-terminal-delayed-${_status}`,
      });
      result.current.refresh();
    });
    await waitFor(() => expect(getCoordination).toHaveBeenCalledTimes(2));
    await act(async () => {
      delayedPost.resolve({ ok: true, value: claimSuccess(2) });
      await first;
    });
    expect(result.current.coordination).toMatchObject({
      status: "ready",
      value: { revision: 3 },
    });

    await act(async () => {
      delayedGet.resolve({ ok: false, error });
      await delayedGet.promise;
    });
    expect(onScopeDenied).toHaveBeenCalledWith(CASE_ID, error);
    expect(result.current.coordination).toEqual({ status: "failed", error });
    const afterTerminal = await result.current.apply({
      action: "release_self",
      idempotencyKey: `coord-terminal-after-${_status}`,
    });
    expect(afterTerminal).toEqual({ status: "ignored", reason: "not_ready" });
    expect(applyCoordinationAction).toHaveBeenCalledOnce();
  });

  it("keeps a newer GET projection when an older successful POST finishes later", async () => {
    const delayedPost = createDeferred<Awaited<ReturnType<
      InvestigationCoordinationGateway["applyCoordinationAction"]
    >>>();
    const getCoordination = vi.fn<InvestigationCoordinationGateway["getCoordination"]>()
      .mockResolvedValueOnce({ ok: true, value: coordination(1) })
      .mockResolvedValueOnce({ ok: true, value: coordination(3) });
    const applyCoordinationAction = vi.fn<
      InvestigationCoordinationGateway["applyCoordinationAction"]
    >()
      .mockImplementationOnce(() => delayedPost.promise)
      .mockResolvedValueOnce({ ok: false, error: { kind: "network" } });
    const transport = gateway({ getCoordination, applyCoordinationAction });
    const { result } = renderHook(() => useInvestigationCoordination(options(transport)));
    await waitFor(() => expect(result.current.coordination).toMatchObject({
      status: "ready",
      value: { revision: 1 },
    }));

    let first!: ReturnType<typeof result.current.apply>;
    act(() => {
      first = result.current.apply({
        action: "claim_self",
        idempotencyKey: "coord-order-post-older",
      });
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.coordination).toMatchObject({
      status: "ready",
      value: { revision: 3 },
    }));
    expect(applyCoordinationAction).toHaveBeenCalledOnce();

    const staleSuccess = claimSuccess(1);
    let outcome!: Awaited<typeof first>;
    await act(async () => {
      delayedPost.resolve({ ok: true, value: staleSuccess });
      outcome = await first;
    });
    expect(outcome).toEqual({ status: "succeeded", value: staleSuccess });
    expect(result.current.state).toEqual({ status: "succeeded", value: staleSuccess });
    expect(result.current.coordination).toMatchObject({
      status: "ready",
      value: { revision: 3 },
    });

    await act(async () => {
      await result.current.apply({
        action: "claim_self",
        idempotencyKey: "coord-order-after-get",
      });
    });
    expect(applyCoordinationAction.mock.calls[1]?.[1]).toMatchObject({
      expectedRevision: 3,
    });
  });

  it("keeps mutation conflict current truthful without regressing a newer GET", async () => {
    const delayedPost = createDeferred<Awaited<ReturnType<
      InvestigationCoordinationGateway["applyCoordinationAction"]
    >>>();
    const getCoordination = vi.fn<InvestigationCoordinationGateway["getCoordination"]>()
      .mockResolvedValueOnce({ ok: true, value: coordination(1) })
      .mockResolvedValueOnce({ ok: true, value: coordination(3) });
    const applyCoordinationAction = vi.fn<
      InvestigationCoordinationGateway["applyCoordinationAction"]
    >()
      .mockImplementationOnce(() => delayedPost.promise)
      .mockResolvedValueOnce({ ok: false, error: { kind: "network" } });
    const transport = gateway({ getCoordination, applyCoordinationAction });
    const { result } = renderHook(() => useInvestigationCoordination(options(transport)));
    await waitFor(() => expect(result.current.coordination.status).toBe("ready"));

    let first!: ReturnType<typeof result.current.apply>;
    act(() => {
      first = result.current.apply({
        action: "claim_self",
        idempotencyKey: "coord-order-conflict-older",
      });
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.coordination).toMatchObject({
      status: "ready",
      value: { revision: 3 },
    }));

    const staleConflict = {
      kind: "coordination_changed" as const,
      status: 409 as const,
      investigationId: CASE_ID,
      action: "claim_self" as const,
      targetIdentityId: null,
      current: coordination(2),
    };
    await act(async () => {
      delayedPost.resolve({ ok: false, error: staleConflict });
      await first;
    });
    expect(result.current.state).toEqual({ status: "failed", error: staleConflict });
    expect(result.current.coordination).toMatchObject({
      status: "ready",
      value: { revision: 3 },
    });

    await act(async () => {
      await result.current.apply({
        action: "claim_self",
        idempotencyKey: "coord-order-after-conflict",
      });
    });
    expect(applyCoordinationAction.mock.calls[1]?.[1]).toMatchObject({
      expectedRevision: 3,
    });
  });

  it.each([
    ["401", { kind: "auth_lost" as const, status: 401 as const }],
    ["403", { kind: "auth_lost" as const, status: 403 as const }],
    ["404", { kind: "not_found" as const, status: 404 as const }],
  ])("denies parent scope on apply %s without retaining an unknown intent", async (
    _status,
    error,
  ) => {
    const onScopeDenied = vi.fn();
    const applyCoordinationAction = vi.fn<
      InvestigationCoordinationGateway["applyCoordinationAction"]
    >(async () => ({ ok: false, error }));
    const transport = gateway({ applyCoordinationAction });
    const { result } = renderHook(() => useInvestigationCoordination(options(transport, {
      canCoordinateParticipants: true,
      onScopeDenied,
    })));
    await waitFor(() => expect(result.current.coordination.status).toBe("ready"));

    let firstOutcome!: Awaited<ReturnType<typeof result.current.apply>>;
    await act(async () => {
      firstOutcome = await result.current.apply({
        action: "claim_self",
        idempotencyKey: `coord-terminal-${_status}`,
      });
    });
    expect(firstOutcome).toEqual({ status: "failed", error });
    expect(onScopeDenied).toHaveBeenCalledWith(CASE_ID, error);

    let secondOutcome!: Awaited<ReturnType<typeof result.current.apply>>;
    await act(async () => {
      secondOutcome = await result.current.apply({
        action: "assign_participant",
        targetIdentityId: "identity-bob",
        idempotencyKey: `coord-terminal-${_status}`,
      });
    });
    expect(secondOutcome).toEqual({ status: "failed", error });
    expect(applyCoordinationAction).toHaveBeenCalledTimes(2);
  });

  it("preserves the ready value through a refresh failure and subsequent retry", async () => {
    const retry = createDeferred<Awaited<ReturnType<InvestigationCoordinationGateway["getCoordination"]>>>();
    const getCoordination = vi.fn<InvestigationCoordinationGateway["getCoordination"]>()
      .mockResolvedValueOnce({ ok: true, value: coordination(2) })
      .mockResolvedValueOnce({ ok: false, error: { kind: "network" } })
      .mockImplementationOnce(() => retry.promise);
    const transport = gateway({
      getCoordination,
    });
    const { result } = renderHook(() => useInvestigationCoordination(options(transport)));
    await waitFor(() => expect(result.current.coordination).toEqual({
      status: "ready",
      value: coordination(2),
    }));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.coordination).toEqual({
      status: "failed",
      error: { kind: "network" },
      previous: coordination(2),
    }));
    act(() => result.current.refresh());
    expect(result.current.coordination).toEqual({
      status: "loading",
      previous: coordination(2),
    });
    retry.resolve({ ok: true, value: coordination(3) });
    await waitFor(() => expect(result.current.coordination).toEqual({
      status: "ready",
      value: coordination(3),
    }));
  });

  it("preserves the ready value when refresh rejects and carries it into retry", async () => {
    const retry = createDeferred<Awaited<ReturnType<InvestigationCoordinationGateway["getCoordination"]>>>();
    const getCoordination = vi.fn<InvestigationCoordinationGateway["getCoordination"]>()
      .mockResolvedValueOnce({ ok: true, value: coordination(2) })
      .mockRejectedValueOnce(new Error("transport detail must stay bounded"))
      .mockImplementationOnce(() => retry.promise);
    const transport = gateway({
      getCoordination,
    });
    const { result } = renderHook(() => useInvestigationCoordination(options(transport)));
    await waitFor(() => expect(result.current.coordination.status).toBe("ready"));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.coordination).toEqual({
      status: "failed",
      error: { kind: "unexpected" },
      previous: coordination(2),
    }));
    act(() => result.current.refresh());
    expect(result.current.coordination).toEqual({
      status: "loading",
      previous: coordination(2),
    });
    retry.resolve({ ok: true, value: coordination(4) });
    await waitFor(() => expect(result.current.coordination).toEqual({
      status: "ready",
      value: coordination(4),
    }));
  });

  it("settles a stale refresh to its higher loading previous value", async () => {
    const initial = coordination(3);
    const stale = coordination(2);
    const refresh = createDeferred<Awaited<ReturnType<
      InvestigationCoordinationGateway["getCoordination"]
    >>>();
    const getCoordination = vi.fn<InvestigationCoordinationGateway["getCoordination"]>()
      .mockResolvedValueOnce({ ok: true, value: initial })
      .mockImplementationOnce(() => refresh.promise);
    const applyCoordinationAction = vi.fn<
      InvestigationCoordinationGateway["applyCoordinationAction"]
    >();
    const transport = gateway({ getCoordination, applyCoordinationAction });
    const { result } = renderHook(() => useInvestigationCoordination(options(transport)));
    await waitFor(() => expect(result.current.coordination).toEqual({
      status: "ready",
      value: initial,
    }));

    act(() => result.current.refresh());
    expect(result.current.coordination).toEqual({ status: "loading", previous: initial });
    await act(async () => {
      refresh.resolve({ ok: true, value: stale });
      await refresh.promise;
    });
    expect(result.current.coordination).toEqual({ status: "ready", value: initial });
    expect(applyCoordinationAction).not.toHaveBeenCalled();
  });

  it("accepts an equal-revision authoritative refresh candidate", async () => {
    const initial = coordination(3);
    const equal = {
      ...coordination(3),
      updatedAt: "2026-02-03T21:00:00.000Z",
    };
    const getCoordination = vi.fn<InvestigationCoordinationGateway["getCoordination"]>()
      .mockResolvedValueOnce({ ok: true, value: initial })
      .mockResolvedValueOnce({ ok: true, value: equal });
    const transport = gateway({ getCoordination });
    const { result } = renderHook(() => useInvestigationCoordination(options(transport)));
    await waitFor(() => expect(result.current.coordination.status).toBe("ready"));

    act(() => result.current.refresh());
    await waitFor(() => {
      expect(result.current.coordination.status).toBe("ready");
      if (result.current.coordination.status === "ready") {
        expect(result.current.coordination.value).toBe(equal);
      }
    });
  });

  it.each([
    ["401", { kind: "auth_lost" as const, status: 401 as const }],
    ["403", { kind: "auth_lost" as const, status: 403 as const }],
    ["404", { kind: "not_found" as const, status: 404 as const }],
  ])("drops the ready value when a terminal %s refresh denies scope", async (_status, error) => {
    const onScopeDenied = vi.fn();
    const getCoordination = vi.fn<InvestigationCoordinationGateway["getCoordination"]>()
      .mockResolvedValueOnce({ ok: true, value: coordination(2) })
      .mockResolvedValueOnce({ ok: false, error });
    const transport = gateway({
      getCoordination,
    });
    const { result } = renderHook(() => useInvestigationCoordination(options(transport, {
      onScopeDenied,
    })));
    await waitFor(() => expect(result.current.coordination.status).toBe("ready"));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.coordination).toEqual({
      status: "failed",
      error,
    }));
    expect(onScopeDenied).toHaveBeenCalledOnce();
    expect(onScopeDenied).toHaveBeenCalledWith(CASE_ID, error);
  });

  it.each([
    ["identity key", (value: UseInvestigationCoordinationOptions) => ({
      ...value,
      identityKey: "bob-session",
    })],
    ["authority", (value: UseInvestigationCoordinationOptions) => ({
      ...value,
      authorityKey: "alice-authority-v2",
    })],
    ["actor identity", (value: UseInvestigationCoordinationOptions) => ({
      ...value,
      actorIdentityId: "identity-bob",
    })],
    ["case", (value: UseInvestigationCoordinationOptions) => ({
      ...value,
      investigationId: "case-coordination-other",
    })],
    ["read-only mode", (value: UseInvestigationCoordinationOptions) => ({
      ...value,
      readOnly: true,
    })],
    ["capability", (value: UseInvestigationCoordinationOptions) => ({
      ...value,
      canCoordinateSelf: false,
    })],
    ["active state", (value: UseInvestigationCoordinationOptions) => ({
      ...value,
      active: false,
    })],
    ["read authority", (value: UseInvestigationCoordinationOptions) => ({
      ...value,
      canRead: false,
    })],
  ])("aborts and suppresses stale action publication across a %s change", async (_label, rotate) => {
    const pending = createDeferred<Awaited<ReturnType<InvestigationCoordinationGateway["applyCoordinationAction"]>>>();
    let signal: AbortSignal | undefined;
    const transport = gateway({
      applyCoordinationAction: vi.fn((_id, _input, request) => {
        signal = request.signal;
        return pending.promise;
      }),
    });
    const first = options(transport);
    const { result, rerender } = renderHook(
      ({ value }: { value: UseInvestigationCoordinationOptions }) =>
        useInvestigationCoordination(value),
      { initialProps: { value: first } },
    );
    await waitFor(() => expect(result.current.coordination.status).toBe("ready"));
    let action!: ReturnType<typeof result.current.apply>;
    act(() => {
      action = result.current.apply({
        action: "claim_self",
        idempotencyKey: "coord-controller-0006",
      });
    });
    rerender({ value: rotate(first) });
    expect(signal?.aborted).toBe(true);
    let outcome;
    await act(async () => {
      pending.resolve({
        ok: false,
        error: { kind: "unavailable", status: 503, reason: "commit_outcome_unknown" },
      });
      outcome = await action;
    });
    expect(outcome).toEqual({ status: "ignored", reason: "stale" });
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(result.current.state).toEqual({ status: "idle" });
  });

  it("does not retain an unknown intent from an action made stale by read-authority loss", async () => {
    const pending = createDeferred<Awaited<ReturnType<
      InvestigationCoordinationGateway["applyCoordinationAction"]
    >>>();
    let signal: AbortSignal | undefined;
    const applyCoordinationAction = vi.fn<
      InvestigationCoordinationGateway["applyCoordinationAction"]
    >()
      .mockImplementationOnce((_id, _input, request) => {
        signal = request.signal;
        return pending.promise;
      })
      .mockResolvedValueOnce({ ok: false, error: { kind: "network" } });
    const transport = gateway({ applyCoordinationAction });
    const firstOptions = options(transport, { canCoordinateParticipants: true });
    const { result, rerender } = renderHook(
      ({ value }: { value: UseInvestigationCoordinationOptions }) =>
        useInvestigationCoordination(value),
      { initialProps: { value: firstOptions } },
    );
    await waitFor(() => expect(result.current.coordination.status).toBe("ready"));

    const key = "coord-read-loss-unknown";
    let first!: ReturnType<typeof result.current.apply>;
    act(() => {
      first = result.current.apply({ action: "claim_self", idempotencyKey: key });
    });
    rerender({ value: { ...firstOptions, canRead: false } });
    expect(signal?.aborted).toBe(true);
    const whileDenied = await result.current.apply({
      action: "claim_self",
      idempotencyKey: "coord-read-loss-denied",
    });
    expect(whileDenied).toEqual({ status: "ignored", reason: "not_ready" });
    expect(Object.isFrozen(whileDenied)).toBe(true);

    pending.resolve({
      ok: false,
      error: { kind: "unavailable", status: 503, reason: "commit_outcome_unknown" },
    });
    await expect(first).resolves.toEqual({ status: "ignored", reason: "stale" });

    rerender({ value: firstOptions });
    await waitFor(() => expect(result.current.coordination.status).toBe("ready"));
    let retry!: Awaited<ReturnType<typeof result.current.apply>>;
    await act(async () => {
      retry = await result.current.apply({
        action: "assign_participant",
        targetIdentityId: "identity-bob",
        idempotencyKey: key,
      });
    });
    expect(retry).toEqual({ status: "failed", error: { kind: "network" } });
    expect(applyCoordinationAction).toHaveBeenCalledTimes(2);
  });

  it("aborts and suppresses action publication after unmount", async () => {
    const pending = createDeferred<Awaited<ReturnType<InvestigationCoordinationGateway["applyCoordinationAction"]>>>();
    let signal: AbortSignal | undefined;
    const transport = gateway({
      applyCoordinationAction: vi.fn((_id, _input, request) => {
        signal = request.signal;
        return pending.promise;
      }),
    });
    const { result, unmount } = renderHook(() =>
      useInvestigationCoordination(options(transport))
    );
    await waitFor(() => expect(result.current.coordination.status).toBe("ready"));
    let action!: ReturnType<typeof result.current.apply>;
    act(() => {
      action = result.current.apply({
        action: "claim_self",
        idempotencyKey: "coord-controller-unmount-0001",
      });
    });
    unmount();
    expect(signal?.aborted).toBe(true);
    pending.resolve({
      ok: false,
      error: { kind: "unavailable", status: 503, reason: "commit_outcome_unknown" },
    });
    const outcome = await action;
    expect(outcome).toEqual({ status: "ignored", reason: "stale" });
    expect(Object.isFrozen(outcome)).toBe(true);
  });
});
