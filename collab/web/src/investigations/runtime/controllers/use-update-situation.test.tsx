import type { CaseV1 } from "@cd-collab/contracts/investigation-runtime";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayResult, InvestigationWriteGateway } from "../gateway.js";
import { makePopulatedCase, RUNTIME_FIXTURE_IDS } from "../testkit/fixtures.js";
import { createDeferred } from "../testkit/promises.js";
import {
  useUpdateSituation,
  type UseUpdateSituationOptions,
} from "./use-update-situation.js";

afterEach(() => cleanup());

function revised(): CaseV1 {
  const current = makePopulatedCase();
  return {
    ...current,
    impact: "Checkouts now fail before payment confirmation.",
    situationVersion: current.situationVersion + 1,
  };
}

/**
 * The write seam is its own contract, so a controller double states both
 * members outright instead of asserting a read gateway it does not implement.
 */
function gatewayWithUpdate(
  updateSituation: InvestigationWriteGateway["updateSituation"],
): InvestigationWriteGateway {
  return { updateSituation, createContribution: unexpectedWrite };
}

const unexpectedWrite = vi.fn(async () => ({
  ok: false as const,
  error: { kind: "unexpected" as const },
}));

function options(
  overrides: Partial<UseUpdateSituationOptions> = {},
): UseUpdateSituationOptions {
  return {
    gateway: gatewayWithUpdate(vi.fn()),
    identityKey: "alice",
    authorityKey: "writer-v1",
    investigationId: RUNTIME_FIXTURE_IDS.populatedCase,
    investigation: makePopulatedCase(),
    canEditSituation: true,
    readOnly: false,
    onInvestigationPublished: vi.fn(),
    onRefreshInvestigation: vi.fn(),
    onRefreshInvestigations: vi.fn(),
    onScopeDenied: vi.fn(),
    ...overrides,
  };
}

describe("useUpdateSituation", () => {
  it("derives expectedVersion from the published case and publishes the server answer", async () => {
    const updated = revised();
    const updateSituation = vi.fn(async () => ({ ok: true as const, value: updated }));
    const opts = options({ gateway: gatewayWithUpdate(updateSituation) });
    const { result } = renderHook(() => useUpdateSituation(opts));

    await act(async () => {
      await expect(result.current.update({
        impact: "Checkouts now fail before payment confirmation.",
        openQuestions: ["Are retries amplifying the affected requests?"],
        clientTime: "2026-02-03T20:15:00.000Z",
      })).resolves.toEqual({ status: "succeeded", value: updated });
    });

    expect(updateSituation).toHaveBeenCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      {
        impact: "Checkouts now fail before payment confirmation.",
        openQuestions: ["Are retries amplifying the affected requests?"],
        expectedVersion: makePopulatedCase().situationVersion,
        clientTime: "2026-02-03T20:15:00.000Z",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(opts.onInvestigationPublished).toHaveBeenCalledWith(updated);
    expect(opts.onRefreshInvestigation).toHaveBeenCalledWith(RUNTIME_FIXTURE_IDS.populatedCase);
    expect(opts.onRefreshInvestigations).toHaveBeenCalledOnce();
    expect(result.current.state).toEqual({ status: "succeeded", value: updated });
  });

  it("sends only the fields the caller supplied, including an explicit context erasure", async () => {
    const updateSituation = vi.fn(async () => ({ ok: true as const, value: revised() }));
    const { result } = renderHook(() => useUpdateSituation(
      options({ gateway: gatewayWithUpdate(updateSituation) }),
    ));

    await act(async () => {
      await result.current.update({ scope: "", investigationContext: null });
    });

    expect(updateSituation).toHaveBeenCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { scope: "", investigationContext: null, expectedVersion: 4 },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("writes nothing without authority, an active case, a published case, or a field", async () => {
    const updateSituation = vi.fn();
    const base = options({
      gateway: gatewayWithUpdate(updateSituation),
      canEditSituation: false,
    });
    const { result, rerender } = renderHook(
      ({ value }: { value: UseUpdateSituationOptions }) => useUpdateSituation(value),
      { initialProps: { value: base } },
    );
    const ignored = { status: "ignored", reason: "not_ready" };

    await expect(result.current.update({ impact: "x" })).resolves.toEqual(ignored);
    rerender({ value: { ...base, canEditSituation: true, investigationId: null } });
    await expect(result.current.update({ impact: "x" })).resolves.toEqual(ignored);
    rerender({ value: { ...base, canEditSituation: true, readOnly: true } });
    await expect(result.current.update({ impact: "x" })).resolves.toEqual(ignored);
    rerender({ value: { ...base, canEditSituation: true, investigation: null } });
    await expect(result.current.update({ impact: "x" })).resolves.toEqual(ignored);
    rerender({ value: { ...base, canEditSituation: true } });
    await expect(result.current.update({})).resolves.toEqual(ignored);
    expect(updateSituation).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ status: "idle" });
  });

  it("refuses to edit with a version belonging to another case", async () => {
    const updateSituation = vi.fn();
    const { result } = renderHook(() => useUpdateSituation(options({
      gateway: gatewayWithUpdate(updateSituation),
      investigation: { ...makePopulatedCase(), id: "case-other" },
    })));

    await expect(result.current.update({ impact: "x" })).resolves.toEqual({
      status: "ignored",
      reason: "not_ready",
    });
    expect(updateSituation).not.toHaveBeenCalled();
  });

  it("re-reads instead of resending when the server reports a version conflict", async () => {
    const updateSituation = vi.fn(async (): Promise<GatewayResult<CaseV1>> => ({
      ok: false,
      error: { kind: "conflict", status: 409 },
    }));
    const opts = options({ gateway: gatewayWithUpdate(updateSituation) });
    const { result } = renderHook(() => useUpdateSituation(opts));

    await act(async () => {
      await expect(result.current.update({ impact: "x" })).resolves.toEqual({
        status: "failed",
        error: { kind: "conflict", status: 409 },
      });
    });

    expect(updateSituation).toHaveBeenCalledOnce();
    expect(opts.onRefreshInvestigation).toHaveBeenCalledWith(RUNTIME_FIXTURE_IDS.populatedCase);
    expect(opts.onRefreshInvestigations).toHaveBeenCalledOnce();
    expect(opts.onInvestigationPublished).not.toHaveBeenCalled();
    expect(opts.onScopeDenied).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({
      status: "failed",
      error: { kind: "conflict", status: 409 },
    });
  });

  it("denies the active scope and refreshes nothing when a write proves lost access", async () => {
    const updateSituation = vi.fn();
    updateSituation.mockResolvedValueOnce({ ok: false, error: { kind: "auth_lost", status: 401 } });
    updateSituation.mockResolvedValueOnce({ ok: false, error: { kind: "not_found", status: 404 } });
    const opts = options({ gateway: gatewayWithUpdate(updateSituation) });
    const { result } = renderHook(() => useUpdateSituation(opts));

    await act(async () => {
      await expect(result.current.update({ impact: "x" })).resolves.toEqual({
        status: "failed",
        error: { kind: "auth_lost", status: 401 },
      });
    });
    await act(async () => {
      await expect(result.current.update({ impact: "x" })).resolves.toEqual({
        status: "failed",
        error: { kind: "not_found", status: 404 },
      });
    });

    expect(opts.onScopeDenied).toHaveBeenNthCalledWith(
      1,
      RUNTIME_FIXTURE_IDS.populatedCase,
      { kind: "auth_lost", status: 401 },
    );
    expect(opts.onScopeDenied).toHaveBeenNthCalledWith(
      2,
      RUNTIME_FIXTURE_IDS.populatedCase,
      { kind: "not_found", status: 404 },
    );
    expect(opts.onRefreshInvestigation).not.toHaveBeenCalled();
    expect(opts.onRefreshInvestigations).not.toHaveBeenCalled();
    expect(opts.onInvestigationPublished).not.toHaveBeenCalled();
  });

  it("allows only one situation revision in flight", async () => {
    const deferred = createDeferred<GatewayResult<CaseV1>>();
    const gateway = gatewayWithUpdate(vi.fn(() => deferred.promise));
    const { result } = renderHook(() => useUpdateSituation(options({ gateway })));

    let first!: ReturnType<typeof result.current.update>;
    await act(async () => {
      first = result.current.update({ impact: "first" });
      await Promise.resolve();
    });
    await expect(result.current.update({ impact: "second" })).resolves.toEqual({
      status: "ignored",
      reason: "busy",
    });
    await act(async () => {
      deferred.resolve({ ok: true, value: revised() });
      await first;
    });
  });

  it("aborts and cannot publish or refresh a late case A answer after moving to case B", async () => {
    const deferred = createDeferred<GatewayResult<CaseV1>>();
    let observedSignal: AbortSignal | undefined;
    const gateway = gatewayWithUpdate(vi.fn((_id, _input, request) => {
      observedSignal = request.signal;
      return deferred.promise;
    }));
    const first = options({ gateway });
    const { result, rerender } = renderHook(
      ({ value }: { value: UseUpdateSituationOptions }) => useUpdateSituation(value),
      { initialProps: { value: first } },
    );

    let pending!: ReturnType<typeof result.current.update>;
    await act(async () => {
      pending = result.current.update({ impact: "late" });
      await Promise.resolve();
    });
    await waitFor(() => expect(observedSignal).toBeDefined());
    rerender({ value: { ...first, investigationId: "case-other" } });
    expect(observedSignal?.aborted).toBe(true);

    let outcome;
    await act(async () => {
      deferred.resolve({ ok: true, value: revised() });
      outcome = await pending;
    });

    expect(outcome).toEqual({ status: "ignored", reason: "stale" });
    expect(first.onInvestigationPublished).not.toHaveBeenCalled();
    expect(first.onRefreshInvestigation).not.toHaveBeenCalled();
    expect(first.onRefreshInvestigations).not.toHaveBeenCalled();
  });

  it.each([
    ["identity", { identityKey: "mallory" }],
    ["authority", { authorityKey: "writer-v2" }],
    ["capability", { canEditSituation: false }],
    ["read-only", { readOnly: true }],
  ] as const)(
    "suppresses a completion whose %s changed while the revision was in flight",
    async (_label, change) => {
      const deferred = createDeferred<GatewayResult<CaseV1>>();
      const gateway = gatewayWithUpdate(vi.fn(() => deferred.promise));
      const first = options({ gateway });
      const { result, rerender } = renderHook(
        ({ value }: { value: UseUpdateSituationOptions }) => useUpdateSituation(value),
        { initialProps: { value: first } },
      );

      let pending!: ReturnType<typeof result.current.update>;
      await act(async () => {
        pending = result.current.update({ impact: "late" });
        await Promise.resolve();
      });
      rerender({ value: { ...first, ...change } });

      let outcome;
      await act(async () => {
        deferred.resolve({ ok: true, value: revised() });
        outcome = await pending;
      });

      expect(outcome).toEqual({ status: "ignored", reason: "stale" });
      expect(first.onInvestigationPublished).not.toHaveBeenCalled();
      expect(result.current.state).toEqual({ status: "idle" });
    },
  );

  it("suppresses a conflict refresh for a scope the caller has already left", async () => {
    const deferred = createDeferred<GatewayResult<CaseV1>>();
    const first = options({ gateway: gatewayWithUpdate(vi.fn(() => deferred.promise)) });
    const { result, rerender } = renderHook(
      ({ value }: { value: UseUpdateSituationOptions }) => useUpdateSituation(value),
      { initialProps: { value: first } },
    );

    let pending!: ReturnType<typeof result.current.update>;
    await act(async () => {
      pending = result.current.update({ impact: "late" });
      await Promise.resolve();
    });
    rerender({ value: { ...first, investigationId: "case-other" } });

    let outcome;
    await act(async () => {
      deferred.resolve({ ok: false, error: { kind: "conflict", status: 409 } });
      outcome = await pending;
    });

    expect(outcome).toEqual({ status: "ignored", reason: "stale" });
    expect(first.onRefreshInvestigation).not.toHaveBeenCalled();
    expect(first.onRefreshInvestigations).not.toHaveBeenCalled();
  });

  it("does not resolve or publish after the controller unmounts", async () => {
    const deferred = createDeferred<GatewayResult<CaseV1>>();
    const opts = options({ gateway: gatewayWithUpdate(vi.fn(() => deferred.promise)) });
    const { result, unmount } = renderHook(() => useUpdateSituation(opts));

    let pending!: ReturnType<typeof result.current.update>;
    await act(async () => {
      pending = result.current.update({ impact: "late" });
      await Promise.resolve();
    });
    unmount();

    let outcome;
    await act(async () => {
      deferred.resolve({ ok: true, value: revised() });
      outcome = await pending;
    });

    expect(outcome).toEqual({ status: "ignored", reason: "stale" });
    expect(opts.onInvestigationPublished).not.toHaveBeenCalled();
  });

  it("bounds a thrown transport rejection without publishing its detail", async () => {
    const secret = "private transport detail";
    const opts = options({
      gateway: gatewayWithUpdate(vi.fn(() => Promise.reject(new Error(secret)))),
    });
    const { result } = renderHook(() => useUpdateSituation(opts));

    let outcome;
    await act(async () => {
      outcome = await result.current.update({ impact: "x" });
    });

    expect(outcome).toEqual({ status: "failed", error: { kind: "unexpected" } });
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(opts.onInvestigationPublished).not.toHaveBeenCalled();
  });

  it("does not expose case A completion during the first render of case B", async () => {
    const updated = revised();
    const gateway = gatewayWithUpdate(vi.fn(async () => ({ ok: true as const, value: updated })));
    const first = options({ gateway });
    const renderedStates: Array<ReturnType<typeof useUpdateSituation>["state"]> = [];
    const { result, rerender } = renderHook(
      ({ value }: { value: UseUpdateSituationOptions }) => {
        const controller = useUpdateSituation(value);
        renderedStates.push(controller.state);
        return controller;
      },
      { initialProps: { value: first } },
    );

    await act(async () => {
      await result.current.update({ impact: "case A" });
    });
    expect(result.current.state).toEqual({ status: "succeeded", value: updated });

    renderedStates.length = 0;
    rerender({ value: { ...first, investigationId: "case-b" } });
    expect(renderedStates[0]).toEqual({ status: "idle" });
    expect(result.current.state).toEqual({ status: "idle" });
  });
});
