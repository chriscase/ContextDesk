import {
  INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID,
  type InvestigationLifecycleActionSuccessV1,
} from "@cd-collab/contracts/investigation-runtime";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvestigationGateway } from "../gateway.js";
import {
  makeArchiveAllowedLifecycle,
  makePopulatedCase,
  RUNTIME_FIXTURE_IDS,
} from "../testkit/fixtures.js";
import { createDeferred } from "../testkit/promises.js";
import {
  useLifecycleAction,
  type UseLifecycleActionOptions,
} from "./use-lifecycle-action.js";

afterEach(() => cleanup());

function archiveSuccess(): InvestigationLifecycleActionSuccessV1 {
  const investigation = { ...makePopulatedCase(), status: "archived" as const };
  return {
    schemaId: INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID,
    investigationId: investigation.id,
    action: "archive",
    previousStatus: "monitoring",
    appliedStatus: "archived",
    case: investigation,
  };
}

function gatewayWithLifecycle(
  applyLifecycleAction: InvestigationGateway["applyLifecycleAction"],
): InvestigationGateway {
  return { applyLifecycleAction } as InvestigationGateway;
}

function options(
  overrides: Partial<UseLifecycleActionOptions> = {},
): UseLifecycleActionOptions {
  return {
    gateway: gatewayWithLifecycle(vi.fn()),
    identityKey: "alice",
    authorityKey: "lead-v1",
    investigationId: RUNTIME_FIXTURE_IDS.populatedCase,
    lifecycle: makeArchiveAllowedLifecycle(),
    canManageLifecycle: true,
    readOnly: false,
    onInvestigationPublished: vi.fn(),
    onLifecyclePublished: vi.fn(),
    onRefreshInvestigation: vi.fn(),
    onRefreshInvestigations: vi.fn(),
    onRefreshLifecycle: vi.fn(),
    onScopeDenied: vi.fn(),
    ...overrides,
  };
}

describe("useLifecycleAction", () => {
  it("derives the expected tuple and publishes then refreshes every resource on success", async () => {
    const success = archiveSuccess();
    const applyLifecycleAction = vi.fn(async () => ({ ok: true as const, value: success }));
    const opts = options({ gateway: gatewayWithLifecycle(applyLifecycleAction) });
    const { result } = renderHook(() => useLifecycleAction(opts));

    await act(async () => {
      await expect(result.current.apply("archive")).resolves.toEqual({
        status: "succeeded",
        value: success,
      });
    });

    expect(applyLifecycleAction).toHaveBeenCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      {
        action: "archive",
        expected: { status: "monitoring", legalHold: false, restoreTarget: "monitoring" },
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(opts.onInvestigationPublished).toHaveBeenCalledWith(success.case);
    expect(opts.onRefreshInvestigation).toHaveBeenCalledWith(RUNTIME_FIXTURE_IDS.populatedCase);
    expect(opts.onRefreshInvestigations).toHaveBeenCalledOnce();
    expect(opts.onRefreshLifecycle).toHaveBeenCalledWith(RUNTIME_FIXTURE_IDS.populatedCase);
  });

  it("does not retry a lifecycle-changed response and refreshes case plus list", async () => {
    const applyLifecycleAction = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "lifecycle_changed" as const,
        status: 409 as const,
        investigationId: RUNTIME_FIXTURE_IDS.populatedCase,
        action: "archive" as const,
        current: makeArchiveAllowedLifecycle(),
      },
    }));
    const opts = options({ gateway: gatewayWithLifecycle(applyLifecycleAction) });
    const { result } = renderHook(() => useLifecycleAction(opts));

    let outcome;
    await act(async () => {
      outcome = await result.current.apply("archive");
    });
    expect(outcome).toMatchObject({ status: "failed", error: { kind: "lifecycle_changed" } });
    expect(applyLifecycleAction).toHaveBeenCalledOnce();
    expect(opts.onRefreshInvestigation).toHaveBeenCalledOnce();
    expect(opts.onRefreshInvestigations).toHaveBeenCalledOnce();
    expect(opts.onLifecyclePublished).toHaveBeenCalledWith(
      expect.objectContaining({ investigationId: RUNTIME_FIXTURE_IDS.populatedCase }),
    );
    expect(opts.onRefreshLifecycle).not.toHaveBeenCalled();
    expect(opts.onInvestigationPublished).not.toHaveBeenCalled();
  });

  it("does not retry a refusal and refreshes lifecycle only", async () => {
    const applyLifecycleAction = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "lifecycle_refused" as const,
        status: 409 as const,
        action: "archive" as const,
        reason: "legal_hold" as const,
        detail: "Clear the legal hold before archiving.",
      },
    }));
    const opts = options({ gateway: gatewayWithLifecycle(applyLifecycleAction) });
    const { result } = renderHook(() => useLifecycleAction(opts));

    await act(async () => {
      await result.current.apply("archive");
    });
    expect(applyLifecycleAction).toHaveBeenCalledOnce();
    expect(opts.onRefreshLifecycle).toHaveBeenCalledWith(RUNTIME_FIXTURE_IDS.populatedCase);
    expect(opts.onRefreshInvestigation).not.toHaveBeenCalled();
    expect(opts.onRefreshInvestigations).not.toHaveBeenCalled();
  });

  it("fails closed for read-only, missing authority, and mismatched lifecycle identity", async () => {
    const applyLifecycleAction = vi.fn();
    const base = options({
      gateway: gatewayWithLifecycle(applyLifecycleAction),
      canManageLifecycle: false,
    });
    const { result, rerender } = renderHook(
      ({ value }: { value: UseLifecycleActionOptions }) => useLifecycleAction(value),
      { initialProps: { value: base } },
    );

    await expect(result.current.apply("archive")).resolves.toEqual({
      status: "ignored",
      reason: "not_ready",
    });
    rerender({ value: { ...base, canManageLifecycle: true, readOnly: true } });
    await expect(result.current.apply("archive")).resolves.toEqual({
      status: "ignored",
      reason: "not_ready",
    });
    rerender({
      value: {
        ...base,
        canManageLifecycle: true,
        lifecycle: { ...makeArchiveAllowedLifecycle(), investigationId: "case-other" },
      },
    });
    await expect(result.current.apply("archive")).resolves.toEqual({
      status: "ignored",
      reason: "not_ready",
    });
    expect(applyLifecycleAction).not.toHaveBeenCalled();
  });

  it("returns busy for a second action and suppresses a stale authority completion", async () => {
    const deferred = createDeferred<Awaited<ReturnType<InvestigationGateway["applyLifecycleAction"]>>>();
    let observedSignal: AbortSignal | undefined;
    const gateway = gatewayWithLifecycle(vi.fn((_id, _input, request) => {
      observedSignal = request.signal;
      return deferred.promise;
    }));
    const first = options({ gateway });
    const { result, rerender } = renderHook(
      ({ value }: { value: UseLifecycleActionOptions }) => useLifecycleAction(value),
      { initialProps: { value: first } },
    );

    let pending!: ReturnType<typeof result.current.apply>;
    act(() => {
      pending = result.current.apply("archive");
    });
    await expect(result.current.apply("restore")).resolves.toEqual({
      status: "ignored",
      reason: "busy",
    });
    rerender({ value: { ...first, authorityKey: "lead-v2" } });
    expect(observedSignal?.aborted).toBe(true);
    let outcome;
    await act(async () => {
      deferred.resolve({ ok: true, value: archiveSuccess() });
      outcome = await pending;
    });
    expect(outcome).toEqual({ status: "ignored", reason: "stale" });
    expect(first.onInvestigationPublished).not.toHaveBeenCalled();
    expect(first.onLifecyclePublished).not.toHaveBeenCalled();
    expect(first.onRefreshInvestigation).not.toHaveBeenCalled();
    expect(first.onRefreshInvestigations).not.toHaveBeenCalled();
    expect(first.onRefreshLifecycle).not.toHaveBeenCalled();
  });

  it("does not expose case A failure during the first render of case B", async () => {
    const applyLifecycleAction = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "lifecycle_refused" as const,
        status: 409 as const,
        action: "archive" as const,
        reason: "legal_hold" as const,
        detail: "Clear the legal hold before archiving.",
      },
    }));
    const first = options({ gateway: gatewayWithLifecycle(applyLifecycleAction) });
    const renderedStates: Array<ReturnType<typeof useLifecycleAction>["state"]> = [];
    const { result, rerender } = renderHook(
      ({ value }: { value: UseLifecycleActionOptions }) => {
        const controller = useLifecycleAction(value);
        renderedStates.push(controller.state);
        return controller;
      },
      { initialProps: { value: first } },
    );

    await act(async () => {
      await result.current.apply("archive");
    });
    expect(result.current.state).toMatchObject({
      status: "failed",
      error: { kind: "lifecycle_refused" },
    });

    renderedStates.length = 0;
    rerender({
      value: {
        ...first,
        investigationId: "case-b",
        lifecycle: { ...makeArchiveAllowedLifecycle(), investigationId: "case-b" },
      },
    });
    expect(renderedStates[0]).toEqual({ status: "idle" });
    expect(result.current.state).toEqual({ status: "idle" });
  });
});
