import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  InvestigationCoordinationGateway,
} from "../gateway.js";
import { makeOperationsQueuePage } from "../testkit/fixtures.js";
import { useNamedCoordinationSelf } from "./use-named-coordination-self.js";
import {
  INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID,
  type InvestigationOperationsQueuePageV1,
  type InvestigationOperationsQueueQueryV1,
} from "@cd-collab/contracts/investigation-operations-queue";
import type { InvestigationCoordinationActionSuccessV1 } from "@cd-collab/contracts/investigation-runtime";

const success = (page: InvestigationOperationsQueuePageV1): InvestigationCoordinationActionSuccessV1 => ({
  schemaId: "cd-collab.investigation_coordination_action_success.v1",
  investigationId: page.items[0]!.investigation.id,
  action: "claim_self",
  targetIdentityId: null,
  previousRevision: 0,
  previousCoordinator: null,
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
    canCoordinateSelf: true,
    readOnly: false,
    queue: { status: "ready" as const, value: page },
    query,
    requestGeneration,
    onRefreshQueue: vi.fn(),
    onScopeDenied: vi.fn(),
  };
}

describe("useNamedCoordinationSelf", () => {
  it("derives the row revision and writes without a per-row GET", async () => {
    const page = makeOperationsQueuePage();
    const applyCoordinationAction = vi.fn(async () => ({ ok: true as const, value: success(page) }));
    const getCoordination = vi.fn();
    const gateway: InvestigationCoordinationGateway = { getCoordination, applyCoordinationAction };
    const refresh = vi.fn();
    const { result } = renderHook(() => useNamedCoordinationSelf({
      ...options(page, gateway),
      onRefreshQueue: refresh,
    }));

    let outcome;
    await act(async () => {
      outcome = await result.current.apply({
        investigationId: page.items[0]!.investigation.id,
        action: "claim_self",
        idempotencyKey: "named-claim-1",
      });
    });
    expect(outcome).toMatchObject({ status: "succeeded" });
    expect(getCoordination).not.toHaveBeenCalled();
    expect(applyCoordinationAction).toHaveBeenCalledWith(
      page.items[0]!.investigation.id,
      expect.objectContaining({
        action: "claim_self",
        expectedRevision: page.items[0]!.coordination.revision,
        idempotencyKey: "named-claim-1",
      }),
      expect.objectContaining({ actorIdentityId: "identity-alice" }),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("fails closed for a row that is not in the current page", async () => {
    const page = makeOperationsQueuePage();
    const applyCoordinationAction = vi.fn();
    const { result } = renderHook(() => useNamedCoordinationSelf({
      ...options(page, {
        getCoordination: vi.fn(),
        applyCoordinationAction,
      }),
    }));
    let outcome;
    await act(async () => {
      outcome = await result.current.apply({
        investigationId: "missing-investigation",
        action: "release_self",
        idempotencyKey: "missing-1",
      });
    });
    expect(outcome).toEqual({ status: "ignored", reason: "not_ready" });
    expect(applyCoordinationAction).not.toHaveBeenCalled();
  });

  it("fails closed for read-only or unauthorized callers", async () => {
    const page = makeOperationsQueuePage();
    const applyCoordinationAction = vi.fn();
    const gateway: InvestigationCoordinationGateway = {
      getCoordination: vi.fn(),
      applyCoordinationAction,
    };
    const { result, rerender } = renderHook(
      ({ readOnly, canCoordinateSelf }) => useNamedCoordinationSelf({
        ...options(page, gateway),
        readOnly,
        canCoordinateSelf,
      }),
      { initialProps: { readOnly: true, canCoordinateSelf: true } },
    );
    const command = {
      investigationId: page.items[0]!.investigation.id,
      action: "claim_self" as const,
      idempotencyKey: "gated-1",
    };
    await act(async () => expect(await result.current.apply(command)).toEqual({
      status: "ignored",
      reason: "not_ready",
    }));
    rerender({ readOnly: false, canCoordinateSelf: false });
    await act(async () => expect(await result.current.apply(command)).toEqual({
      status: "ignored",
      reason: "not_ready",
    }));
    expect(applyCoordinationAction).not.toHaveBeenCalled();
  });

  it("retries an unknown outcome with the frozen payload, then drops it after scope change", async () => {
    const page = makeOperationsQueuePage();
    const applyCoordinationAction = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { kind: "unavailable" as const, reason: "commit_outcome_unknown" as const },
      })
      .mockResolvedValueOnce({ ok: true as const, value: success(page) });
    const { result, rerender } = renderHook(
      ({ requestGeneration, canRead }) => useNamedCoordinationSelf({
        ...options(page, {
          getCoordination: vi.fn(),
          applyCoordinationAction,
        }, queueQuery("mine"), requestGeneration),
        canRead,
      }),
      { initialProps: { requestGeneration: 1, canRead: true } },
    );
    const command = {
      investigationId: page.items[0]!.investigation.id,
      action: "claim_self" as const,
      idempotencyKey: "unknown-1",
      clientTime: "2026-09-06T15:00:00Z",
    };
    await act(async () => expect(await result.current.apply(command)).toMatchObject({ status: "failed" }));
    await act(async () => expect(await result.current.apply(command)).toMatchObject({ status: "succeeded" }));
    expect(applyCoordinationAction).toHaveBeenCalledTimes(2);
    expect(applyCoordinationAction.mock.calls[0]?.[1]).toEqual(applyCoordinationAction.mock.calls[1]?.[1]);
    rerender({ requestGeneration: 2, canRead: false });
    await waitFor(() => expect(result.current.state).toEqual({ status: "idle" }));
    await act(async () => expect(await result.current.apply(command)).toEqual({ status: "ignored", reason: "not_ready" }));
  });
});
