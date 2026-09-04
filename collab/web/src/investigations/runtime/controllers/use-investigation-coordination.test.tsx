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
    await act(async () => {
      await expect(result.current.apply(command)).resolves.toEqual({
        status: "succeeded",
        value: claimSuccess(),
      });
    });
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
    await expect(result.current.apply({
      action: "claim_self",
      idempotencyKey: "coord-controller-0002",
    })).resolves.toEqual({ status: "ignored", reason: "not_ready" });

    rerender({ value: { ...base, canCoordinateSelf: true, canCoordinateParticipants: false } });
    await waitFor(() => expect(result.current.coordination.status).toBe("ready"));
    await expect(result.current.apply({
      action: "assign_participant",
      targetIdentityId: "identity-bob",
      idempotencyKey: "coord-controller-0003",
    })).resolves.toEqual({ status: "ignored", reason: "not_ready" });
    expect(transport.applyCoordinationAction).not.toHaveBeenCalled();
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
    await act(async () => {
      await result.current.apply(command);
    });
    expect(apply).toHaveBeenCalledOnce();
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

  it("denies the parent case scope when a coordination read conceals access loss", async () => {
    const onScopeDenied = vi.fn();
    const transport = gateway({
      getCoordination: vi.fn(async () => ({
        ok: false as const,
        error: { kind: "not_found" as const, status: 404 as const },
      })),
    });
    const { result } = renderHook(() => useInvestigationCoordination(options(transport, {
      onScopeDenied,
    })));
    await waitFor(() => expect(result.current.coordination.status).toBe("failed"));
    expect(onScopeDenied).toHaveBeenCalledOnce();
    expect(onScopeDenied).toHaveBeenCalledWith(
      CASE_ID,
      { kind: "not_found", status: 404 },
    );
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
      pending.resolve({ ok: true, value: claimSuccess() });
      outcome = await action;
    });
    expect(outcome).toEqual({ status: "ignored", reason: "stale" });
    expect(result.current.state).toEqual({ status: "idle" });
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
    pending.resolve({ ok: true, value: claimSuccess() });
    await expect(action).resolves.toEqual({ status: "ignored", reason: "stale" });
  });
});
