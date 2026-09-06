import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  InvestigationCoordinationGateway,
} from "../gateway.js";
import { makeOperationsQueuePage, makePopulatedCase } from "../testkit/fixtures.js";
import { useNamedCoordinationParticipant } from "./use-named-coordination-participant.js";
import {
  INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID,
  type InvestigationOperationsQueuePageV1,
  type InvestigationOperationsQueueQueryV1,
} from "@cd-collab/contracts/investigation-operations-queue";
import type { InvestigationCoordinationActionSuccessV1 } from "@cd-collab/contracts/investigation-runtime";

const ASSIGN_TARGET = "identity-ravi";

const success = (
  page: InvestigationOperationsQueuePageV1,
  action: "assign_participant" | "release_participant" = "assign_participant",
  targetIdentityId: string = ASSIGN_TARGET,
): InvestigationCoordinationActionSuccessV1 => ({
  schemaId: "cd-collab.investigation_coordination_action_success.v1",
  investigationId: page.items[0]!.investigation.id,
  action,
  targetIdentityId,
  previousRevision: page.items[0]!.coordination.revision,
  previousCoordinator: page.items[0]!.coordination.coordinator,
  applied: page.items[0]!.coordination,
});

function queueQuery(
  coordinationScope: "all_visible" | "mine" | "unassigned" = "all_visible",
): InvestigationOperationsQueueQueryV1 {
  return {
    schemaId: INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID,
    q: "",
    status: [],
    includeArchived: false,
    entityId: null,
    impactIdentity: null,
    contributorId: null,
    recordedFrom: null,
    recordedTo: null,
    cursor: null,
    limit: 20,
    coordinationScope,
  };
}

function options(
  page: InvestigationOperationsQueuePageV1,
  gateway: InvestigationCoordinationGateway,
  query: InvestigationOperationsQueueQueryV1 = queueQuery(),
  requestGeneration = 1,
) {
  return {
    gateway,
    identityKey: "alice-session",
    authorityKey: "authority-v1",
    actorIdentityId: "identity-alice",
    canRead: true,
    canCoordinateParticipants: true,
    readOnly: false,
    queue: { status: "ready" as const, value: page },
    query,
    requestGeneration,
    onRefreshQueue: vi.fn(),
    onScopeDenied: vi.fn(),
  };
}

function pageWithCoordinatorOutsideParticipants(): InvestigationOperationsQueuePageV1 {
  const page = makeOperationsQueuePage();
  const populated = makePopulatedCase();
  return makeOperationsQueuePage({
    items: [
      {
        investigation: {
          ...populated,
          participants: populated.participants.filter(
            (participant) => participant.identityId !== "identity-alice",
          ),
        },
        coordination: page.items[0]!.coordination,
      },
      page.items[1],
    ],
  });
}

describe("useNamedCoordinationParticipant", () => {
  it("derives the row revision and writes without a per-row GET", async () => {
    const page = makeOperationsQueuePage();
    const applyCoordinationAction = vi.fn(async () => ({ ok: true as const, value: success(page) }));
    const getCoordination = vi.fn();
    const gateway: InvestigationCoordinationGateway = { getCoordination, applyCoordinationAction };
    const refresh = vi.fn();
    const { result } = renderHook(() => useNamedCoordinationParticipant({
      ...options(page, gateway),
      onRefreshQueue: refresh,
    }));

    let outcome;
    await act(async () => {
      outcome = await result.current.apply({
        investigationId: page.items[0]!.investigation.id,
        action: "assign_participant",
        targetIdentityId: ASSIGN_TARGET,
        idempotencyKey: "named-assign-1",
      });
    });
    expect(outcome).toMatchObject({ status: "succeeded" });
    expect(getCoordination).not.toHaveBeenCalled();
    expect(applyCoordinationAction).toHaveBeenCalledWith(
      page.items[0]!.investigation.id,
      expect.objectContaining({
        action: "assign_participant",
        targetIdentityId: ASSIGN_TARGET,
        expectedRevision: page.items[0]!.coordination.revision,
        idempotencyKey: "named-assign-1",
      }),
      expect.objectContaining({ actorIdentityId: "identity-alice" }),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("assigns a recorded visible participant from the joined row", async () => {
    const page = makeOperationsQueuePage();
    const applyCoordinationAction = vi.fn(async () => ({ ok: true as const, value: success(page) }));
    const { result } = renderHook(() => useNamedCoordinationParticipant({
      ...options(page, { getCoordination: vi.fn(), applyCoordinationAction }),
    }));
    expect(page.items[0]!.investigation.participants.map((participant) => participant.identityId))
      .toContain(ASSIGN_TARGET);

    await act(async () => {
      expect(await result.current.apply({
        investigationId: page.items[0]!.investigation.id,
        action: "assign_participant",
        targetIdentityId: ASSIGN_TARGET,
        idempotencyKey: "named-assign-recorded",
      })).toMatchObject({ status: "succeeded" });
    });
    expect(applyCoordinationAction).toHaveBeenCalledOnce();
  });

  it("fails closed for an unlisted assign without a POST", async () => {
    const page = makeOperationsQueuePage();
    const applyCoordinationAction = vi.fn();
    const { result } = renderHook(() => useNamedCoordinationParticipant({
      ...options(page, { getCoordination: vi.fn(), applyCoordinationAction }),
    }));
    let outcome;
    await act(async () => {
      outcome = await result.current.apply({
        investigationId: page.items[0]!.investigation.id,
        action: "assign_participant",
        targetIdentityId: "identity-eve",
        idempotencyKey: "named-assign-unlisted",
      });
    });
    expect(outcome).toEqual({ status: "ignored", reason: "not_ready" });
    expect(applyCoordinationAction).not.toHaveBeenCalled();
  });

  it("releases the recorded coordinator even when they are absent from participants", async () => {
    const page = pageWithCoordinatorOutsideParticipants();
    const row = page.items[0]!;
    expect(row.coordination.coordinator?.identityId).toBe("identity-alice");
    expect(row.investigation.participants.map((participant) => participant.identityId))
      .not.toContain("identity-alice");
    const applyCoordinationAction = vi.fn(async () => ({
      ok: true as const,
      value: success(page, "release_participant", "identity-alice"),
    }));
    const { result } = renderHook(() => useNamedCoordinationParticipant({
      ...options(page, { getCoordination: vi.fn(), applyCoordinationAction }),
    }));

    await act(async () => {
      expect(await result.current.apply({
        investigationId: row.investigation.id,
        action: "release_participant",
        targetIdentityId: "identity-alice",
        idempotencyKey: "named-release-ineligible-holder",
      })).toMatchObject({ status: "succeeded" });
    });
    expect(applyCoordinationAction).toHaveBeenCalledOnce();
  });

  it("fails closed when releasing someone who is not the visible coordinator", async () => {
    const page = makeOperationsQueuePage();
    const applyCoordinationAction = vi.fn();
    const { result } = renderHook(() => useNamedCoordinationParticipant({
      ...options(page, { getCoordination: vi.fn(), applyCoordinationAction }),
    }));
    let outcome;
    await act(async () => {
      outcome = await result.current.apply({
        investigationId: page.items[0]!.investigation.id,
        action: "release_participant",
        targetIdentityId: ASSIGN_TARGET,
        idempotencyKey: "named-release-non-coordinator",
      });
    });
    expect(outcome).toEqual({ status: "ignored", reason: "not_ready" });
    expect(applyCoordinationAction).not.toHaveBeenCalled();
  });

  it("fails closed for a row that is not in the current page", async () => {
    const page = makeOperationsQueuePage();
    const applyCoordinationAction = vi.fn();
    const { result } = renderHook(() => useNamedCoordinationParticipant({
      ...options(page, { getCoordination: vi.fn(), applyCoordinationAction }),
    }));
    let outcome;
    await act(async () => {
      outcome = await result.current.apply({
        investigationId: "missing-investigation",
        action: "assign_participant",
        targetIdentityId: ASSIGN_TARGET,
        idempotencyKey: "missing-1",
      });
    });
    expect(outcome).toEqual({ status: "ignored", reason: "not_ready" });
    expect(applyCoordinationAction).not.toHaveBeenCalled();
  });

  it("fails closed for missing identity, read-only, or unauthorized callers", async () => {
    const page = makeOperationsQueuePage();
    const applyCoordinationAction = vi.fn();
    const gateway: InvestigationCoordinationGateway = {
      getCoordination: vi.fn(),
      applyCoordinationAction,
    };
    const command = {
      investigationId: page.items[0]!.investigation.id,
      action: "assign_participant" as const,
      targetIdentityId: ASSIGN_TARGET,
      idempotencyKey: "gated-1",
    };
    const { result, rerender } = renderHook(
      ({ readOnly, canCoordinateParticipants, canRead, actorIdentityId }) =>
        useNamedCoordinationParticipant({
          ...options(page, gateway),
          readOnly,
          canCoordinateParticipants,
          canRead,
          actorIdentityId,
        }),
      {
        initialProps: {
          readOnly: true,
          canCoordinateParticipants: true,
          canRead: true,
          actorIdentityId: "identity-alice",
        },
      },
    );
    await act(async () => expect(await result.current.apply(command)).toEqual({
      status: "ignored",
      reason: "not_ready",
    }));
    rerender({
      readOnly: false,
      canCoordinateParticipants: false,
      canRead: true,
      actorIdentityId: "identity-alice",
    });
    await act(async () => expect(await result.current.apply(command)).toEqual({
      status: "ignored",
      reason: "not_ready",
    }));
    rerender({
      readOnly: false,
      canCoordinateParticipants: true,
      canRead: false,
      actorIdentityId: "identity-alice",
    });
    await act(async () => expect(await result.current.apply(command)).toEqual({
      status: "ignored",
      reason: "not_ready",
    }));
    rerender({
      readOnly: false,
      canCoordinateParticipants: true,
      canRead: true,
      actorIdentityId: "",
    });
    await act(async () => expect(await result.current.apply(command)).toEqual({
      status: "ignored",
      reason: "not_ready",
    }));
    expect(applyCoordinationAction).not.toHaveBeenCalled();
  });

  it("retries an unknown outcome with the frozen payload and key", async () => {
    const page = makeOperationsQueuePage();
    const applyCoordinationAction = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { kind: "unavailable" as const, status: 503 as const, reason: "commit_outcome_unknown" as const },
      })
      .mockResolvedValueOnce({ ok: true as const, value: success(page) });
    const { result } = renderHook(() => useNamedCoordinationParticipant({
      ...options(page, { getCoordination: vi.fn(), applyCoordinationAction }),
    }));
    const command = {
      investigationId: page.items[0]!.investigation.id,
      action: "assign_participant" as const,
      targetIdentityId: ASSIGN_TARGET,
      idempotencyKey: "unknown-1",
      clientTime: "2026-09-06T15:00:00Z",
    };
    await act(async () => expect(await result.current.apply(command)).toMatchObject({ status: "failed" }));
    await act(async () => expect(await result.current.apply(command)).toMatchObject({ status: "succeeded" }));
    expect(applyCoordinationAction).toHaveBeenCalledTimes(2);
    expect(applyCoordinationAction.mock.calls[0]?.[1]).toBe(applyCoordinationAction.mock.calls[1]?.[1]);
    expect(Object.isFrozen(applyCoordinationAction.mock.calls[0]?.[1])).toBe(true);
    expect(applyCoordinationAction.mock.calls[0]?.[1]).toEqual({
      action: "assign_participant",
      targetIdentityId: ASSIGN_TARGET,
      expectedRevision: page.items[0]!.coordination.revision,
      idempotencyKey: "unknown-1",
      clientTime: "2026-09-06T15:00:00Z",
    });
  });

  it.each([
    ["identity", { identityKey: "bob-session" }],
    ["page generation", { requestGeneration: 2 }],
    ["queue scope", { query: queueQuery("mine") }],
  ] as const)("drops a retained unknown retry after a %s change", async (_label, rotation) => {
    const page = makeOperationsQueuePage();
    const applyCoordinationAction = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { kind: "unavailable" as const, status: 503 as const, reason: "commit_outcome_unknown" as const },
      })
      .mockResolvedValueOnce({ ok: true as const, value: success(page, "release_participant", "identity-alice") });
    const { result, rerender } = renderHook(
      (value) => useNamedCoordinationParticipant({
        ...options(page, { getCoordination: vi.fn(), applyCoordinationAction }, value.query, value.requestGeneration),
        identityKey: value.identityKey,
      }),
      {
        initialProps: {
          identityKey: "alice-session",
          requestGeneration: 1,
          query: queueQuery(),
        },
      },
    );
    await act(async () => expect(await result.current.apply({
      investigationId: page.items[0]!.investigation.id,
      action: "assign_participant",
      targetIdentityId: ASSIGN_TARGET,
      idempotencyKey: "unknown-scope-1",
    })).toMatchObject({ status: "failed" }));
    rerender({
      identityKey: "alice-session",
      requestGeneration: 1,
      query: queueQuery(),
      ...rotation,
    });
    await waitFor(() => expect(result.current.state).toEqual({ status: "idle" }));
    await act(async () => expect(await result.current.apply({
      investigationId: page.items[0]!.investigation.id,
      action: "release_participant",
      targetIdentityId: "identity-alice",
      idempotencyKey: "unknown-scope-1",
    })).toMatchObject({ status: "succeeded" }));
    expect(applyCoordinationAction).toHaveBeenCalledTimes(2);
    expect(applyCoordinationAction.mock.calls[1]?.[1]).not.toBe(applyCoordinationAction.mock.calls[0]?.[1]);
    expect(applyCoordinationAction.mock.calls[1]?.[1]).toMatchObject({
      action: "release_participant",
      targetIdentityId: "identity-alice",
      idempotencyKey: "unknown-scope-1",
    });
  });

  it("rejects same-key target or action mismatch locally with zero additional POSTs", async () => {
    const page = makeOperationsQueuePage();
    const applyCoordinationAction = vi.fn(async () => ({
      ok: false as const,
      error: { kind: "unavailable" as const, status: 503 as const, reason: "commit_outcome_unknown" as const },
    }));
    const { result } = renderHook(() => useNamedCoordinationParticipant({
      ...options(page, { getCoordination: vi.fn(), applyCoordinationAction }),
    }));
    const investigationId = page.items[0]!.investigation.id;
    await act(async () => {
      await result.current.apply({
        investigationId,
        action: "assign_participant",
        targetIdentityId: ASSIGN_TARGET,
        idempotencyKey: "intent-1",
      });
    });
    let targetMismatch;
    await act(async () => {
      targetMismatch = await result.current.apply({
        investigationId,
        action: "assign_participant",
        targetIdentityId: "identity-alice",
        idempotencyKey: "intent-1",
      });
    });
    expect(targetMismatch).toEqual({
      status: "failed",
      error: { kind: "input", field: "idempotencyKey", reason: "intent_mismatch" },
    });
    let actionMismatch;
    await act(async () => {
      actionMismatch = await result.current.apply({
        investigationId,
        action: "release_participant",
        targetIdentityId: "identity-alice",
        idempotencyKey: "intent-1",
      });
    });
    expect(actionMismatch).toEqual({
      status: "failed",
      error: { kind: "input", field: "idempotencyKey", reason: "intent_mismatch" },
    });
    expect(applyCoordinationAction).toHaveBeenCalledOnce();
  });

  it.each([
    ["succeeded", { ok: true as const, value: success(makeOperationsQueuePage()) }],
    ["coordination_changed", {
      ok: false as const,
      error: {
        kind: "coordination_changed" as const,
        status: 409 as const,
        investigationId: makeOperationsQueuePage().items[0]!.investigation.id,
        action: "assign_participant" as const,
        targetIdentityId: ASSIGN_TARGET,
        current: makeOperationsQueuePage().items[0]!.coordination,
      },
    }],
    ["coordination_refused", {
      ok: false as const,
      error: {
        kind: "coordination_refused" as const,
        status: 409 as const,
        investigationId: makeOperationsQueuePage().items[0]!.investigation.id,
        action: "assign_participant" as const,
        targetIdentityId: ASSIGN_TARGET,
        reason: "already_coordinator" as const,
        detail: "The investigation already has a coordinator.",
        current: makeOperationsQueuePage().items[0]!.coordination,
      },
    }],
  ])("refreshes the server-ordered queue on %s without rewriting the local row", async (_label, response) => {
    const page = makeOperationsQueuePage();
    const originalRow = page.items[0]!;
    const applyCoordinationAction = vi.fn(async () => response);
    const refresh = vi.fn();
    const { result } = renderHook(() => useNamedCoordinationParticipant({
      ...options(page, { getCoordination: vi.fn(), applyCoordinationAction }),
      onRefreshQueue: refresh,
    }));
    await act(async () => {
      await result.current.apply({
        investigationId: originalRow.investigation.id,
        action: "assign_participant",
        targetIdentityId: ASSIGN_TARGET,
        idempotencyKey: `refresh-${_label}`,
      });
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(page.items[0]).toBe(originalRow);
    expect(page.items[0]!.coordination.revision).toBe(originalRow.coordination.revision);
  });

  it.each([
    ["401", { kind: "auth_lost" as const, status: 401 as const }],
    ["403", { kind: "auth_lost" as const, status: 403 as const }],
  ])("reports auth-loss on apply %s", async (_status, error) => {
    const page = makeOperationsQueuePage();
    const onScopeDenied = vi.fn();
    const applyCoordinationAction = vi.fn(async () => ({ ok: false as const, error }));
    const refresh = vi.fn();
    const { result } = renderHook(() => useNamedCoordinationParticipant({
      ...options(page, { getCoordination: vi.fn(), applyCoordinationAction }),
      onRefreshQueue: refresh,
      onScopeDenied,
    }));
    let outcome;
    await act(async () => {
      outcome = await result.current.apply({
        investigationId: page.items[0]!.investigation.id,
        action: "assign_participant",
        targetIdentityId: ASSIGN_TARGET,
        idempotencyKey: `auth-${_status}`,
      });
    });
    expect(outcome).toEqual({ status: "failed", error });
    expect(onScopeDenied).toHaveBeenCalledWith(page.items[0]!.investigation.id, error);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("conceals apply 404 without invalidating the session", async () => {
    const page = makeOperationsQueuePage();
    const onScopeDenied = vi.fn();
    const error = { kind: "not_found" as const, status: 404 as const };
    const applyCoordinationAction = vi.fn(async () => ({ ok: false as const, error }));
    const refresh = vi.fn();
    const { result } = renderHook(() => useNamedCoordinationParticipant({
      ...options(page, { getCoordination: vi.fn(), applyCoordinationAction }),
      onRefreshQueue: refresh,
      onScopeDenied,
    }));
    let outcome;
    await act(async () => {
      outcome = await result.current.apply({
        investigationId: page.items[0]!.investigation.id,
        action: "assign_participant",
        targetIdentityId: ASSIGN_TARGET,
        idempotencyKey: "conceal-404",
      });
    });
    expect(outcome).toEqual({ status: "failed", error });
    expect(onScopeDenied).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => {
      expect(await result.current.apply({
        investigationId: page.items[0]!.investigation.id,
        action: "assign_participant",
        targetIdentityId: ASSIGN_TARGET,
        idempotencyKey: "after-404",
      })).toEqual({ status: "failed", error });
    });
    expect(applyCoordinationAction).toHaveBeenCalledTimes(2);
    expect(onScopeDenied).not.toHaveBeenCalled();
  });
});
