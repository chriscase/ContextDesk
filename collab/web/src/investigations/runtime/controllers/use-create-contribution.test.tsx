import type { ContributionV1 } from "@cd-collab/contracts/investigation-runtime";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayResult, InvestigationWriteGateway } from "../gateway.js";
import {
  makeContributionList,
  RUNTIME_FIXTURE_IDS,
} from "../testkit/fixtures.js";
import { createDeferred } from "../testkit/promises.js";
import {
  useCreateContribution,
  type UseCreateContributionOptions,
} from "./use-create-contribution.js";

afterEach(() => cleanup());

function contribution(): ContributionV1 {
  const found = makeContributionList().contributions.find(
    ({ id }) => id === RUNTIME_FIXTURE_IDS.note,
  );
  if (found === undefined) throw new Error("the note contribution fixture is missing");
  return found;
}

/**
 * The write seam is its own contract, so a controller double states both
 * members outright instead of asserting a read gateway it does not implement.
 */
function gatewayWithCreate(
  createContribution: InvestigationWriteGateway["createContribution"],
): InvestigationWriteGateway {
  return { createContribution, updateSituation: unexpectedWrite };
}

const unexpectedWrite = vi.fn(async () => ({
  ok: false as const,
  error: { kind: "unexpected" as const },
}));

function options(
  overrides: Partial<UseCreateContributionOptions> = {},
): UseCreateContributionOptions {
  return {
    gateway: gatewayWithCreate(vi.fn()),
    identityKey: "alice",
    authorityKey: "writer-v1",
    investigationId: RUNTIME_FIXTURE_IDS.populatedCase,
    canContribute: true,
    readOnly: false,
    onContributed: vi.fn(),
    onRefreshContributions: vi.fn(),
    onScopeDenied: vi.fn(),
    ...overrides,
  };
}

describe("useCreateContribution", () => {
  it("publishes the authoritative contribution and refreshes its own case", async () => {
    const created = contribution();
    const createContribution = vi.fn(async () => ({ ok: true as const, value: created }));
    const opts = options({ gateway: gatewayWithCreate(createContribution) });
    const { result } = renderHook(() => useCreateContribution(opts));

    await act(async () => {
      await expect(result.current.create({
        kind: "hypothesis",
        body: "  Queue time rises after the rollout.  ",
        hypothesisLinks: [
          { kind: "artifact", id: RUNTIME_FIXTURE_IDS.evidence },
          { kind: "contribution", id: RUNTIME_FIXTURE_IDS.note },
        ],
        privacyClass: "share_safe",
        clientTime: "2026-02-03T20:10:00.000Z",
        sourceId: "source-human-note",
        idempotencyKey: "hypothesis-ui-20260830-001",
      })).resolves.toEqual({ status: "succeeded", value: created });
    });

    expect(createContribution).toHaveBeenCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      {
        kind: "hypothesis",
        body: "  Queue time rises after the rollout.  ",
        hypothesisLinks: [
          { kind: "artifact", id: RUNTIME_FIXTURE_IDS.evidence },
          { kind: "contribution", id: RUNTIME_FIXTURE_IDS.note },
        ],
        privacyClass: "share_safe",
        clientTime: "2026-02-03T20:10:00.000Z",
        sourceId: "source-human-note",
        idempotencyKey: "hypothesis-ui-20260830-001",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(opts.onContributed).toHaveBeenCalledWith(created);
    expect(opts.onRefreshContributions).toHaveBeenCalledWith(RUNTIME_FIXTURE_IDS.populatedCase);
    expect(result.current.state).toEqual({ status: "succeeded", value: created });
  });

  it("snapshots link identities before delegating and strips non-contract fields", async () => {
    const created = contribution();
    let observedInput: Parameters<InvestigationWriteGateway["createContribution"]>[1] | undefined;
    const createContribution = vi.fn(async (_caseId, input) => {
      observedInput = input;
      return { ok: true as const, value: created };
    });
    const opts = options({ gateway: gatewayWithCreate(createContribution) });
    const { result } = renderHook(() => useCreateContribution(opts));
    const link = {
      kind: "artifact" as const,
      id: RUNTIME_FIXTURE_IDS.evidence as string,
      privateAnnotation: "must-not-cross",
    };

    await act(async () => {
      await result.current.create({
        kind: "hypothesis",
        body: "Recorded evidence supports the queue-time hypothesis.",
        hypothesisLinks: [link],
      });
    });
    link.id = "mutated-after-write";

    expect(observedInput).toEqual({
      kind: "hypothesis",
      body: "Recorded evidence supports the queue-time hypothesis.",
      hypothesisLinks: [{ kind: "artifact", id: RUNTIME_FIXTURE_IDS.evidence }],
    });
    expect(observedInput?.hypothesisLinks?.[0]).not.toBe(link);
  });

  it.each([
    ["a non-array collection", { hypothesisLinks: "artifact" }],
    ["an invalid link kind", { hypothesisLinks: [{ kind: "case", id: "case-a" }] }],
    ["a non-string link identity", { hypothesisLinks: [{ kind: "artifact", id: 7 }] }],
  ])("fails %s closed before calling the gateway", async (_label, malformed) => {
    const createContribution = vi.fn();
    const opts = options({ gateway: gatewayWithCreate(createContribution) });
    const { result } = renderHook(() => useCreateContribution(opts));

    await act(async () => {
      await expect(result.current.create({
        kind: "hypothesis",
        body: "Malformed links must not cross the controller.",
        ...malformed,
      } as never)).resolves.toEqual({
        status: "failed",
        error: { kind: "unexpected" },
      });
    });

    expect(createContribution).not.toHaveBeenCalled();
    expect(opts.onContributed).not.toHaveBeenCalled();
    expect(opts.onRefreshContributions).not.toHaveBeenCalled();
  });

  it("contains a hostile nested link getter without publishing its detail", async () => {
    const secret = "private link getter detail";
    const link = { kind: "artifact" } as Record<string, unknown>;
    Object.defineProperty(link, "id", {
      enumerable: true,
      get: () => {
        throw new Error(secret);
      },
    });
    const createContribution = vi.fn();
    const opts = options({ gateway: gatewayWithCreate(createContribution) });
    const { result } = renderHook(() => useCreateContribution(opts));

    let outcome;
    await act(async () => {
      outcome = await result.current.create({
        kind: "hypothesis",
        body: "Hostile input",
        hypothesisLinks: [link],
      } as never);
    });

    expect(outcome).toEqual({ status: "failed", error: { kind: "unexpected" } });
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(createContribution).not.toHaveBeenCalled();
  });

  it("writes nothing without contribute authority, an active case, or outside read-only", async () => {
    const createContribution = vi.fn();
    const base = options({
      gateway: gatewayWithCreate(createContribution),
      canContribute: false,
    });
    const { result, rerender } = renderHook(
      ({ value }: { value: UseCreateContributionOptions }) => useCreateContribution(value),
      { initialProps: { value: base } },
    );

    await expect(result.current.create({
      kind: "hypothesis",
      body: "x",
      hypothesisLinks: [{ kind: "artifact", id: RUNTIME_FIXTURE_IDS.evidence }],
    })).resolves.toEqual({
      status: "ignored",
      reason: "not_ready",
    });
    rerender({ value: { ...base, canContribute: true, investigationId: null } });
    await expect(result.current.create({
      kind: "hypothesis",
      body: "x",
      hypothesisLinks: [{ kind: "artifact", id: RUNTIME_FIXTURE_IDS.evidence }],
    })).resolves.toEqual({
      status: "ignored",
      reason: "not_ready",
    });
    rerender({ value: { ...base, canContribute: true, readOnly: true } });
    await expect(result.current.create({
      kind: "hypothesis",
      body: "x",
      hypothesisLinks: [{ kind: "artifact", id: RUNTIME_FIXTURE_IDS.evidence }],
    })).resolves.toEqual({
      status: "ignored",
      reason: "not_ready",
    });
    expect(createContribution).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ status: "idle" });
  });

  it("denies the active scope and never publishes when a write proves lost access", async () => {
    const authLost: GatewayResult<ContributionV1> = {
      ok: false,
      error: { kind: "auth_lost", status: 403 },
    };
    const notFound: GatewayResult<ContributionV1> = {
      ok: false,
      error: { kind: "not_found", status: 404 },
    };
    const createContribution = vi.fn();
    createContribution.mockResolvedValueOnce(authLost);
    createContribution.mockResolvedValueOnce(notFound);
    const opts = options({ gateway: gatewayWithCreate(createContribution) });
    const { result } = renderHook(() => useCreateContribution(opts));

    await act(async () => {
      await expect(result.current.create({ kind: "note", body: "x" })).resolves.toEqual({
        status: "failed",
        error: { kind: "auth_lost", status: 403 },
      });
    });
    await act(async () => {
      await expect(result.current.create({ kind: "note", body: "x" })).resolves.toEqual({
        status: "failed",
        error: { kind: "not_found", status: 404 },
      });
    });

    expect(opts.onScopeDenied).toHaveBeenNthCalledWith(
      1,
      RUNTIME_FIXTURE_IDS.populatedCase,
      { kind: "auth_lost", status: 403 },
    );
    expect(opts.onScopeDenied).toHaveBeenNthCalledWith(
      2,
      RUNTIME_FIXTURE_IDS.populatedCase,
      { kind: "not_found", status: 404 },
    );
    expect(opts.onContributed).not.toHaveBeenCalled();
    expect(opts.onRefreshContributions).not.toHaveBeenCalled();
  });

  it("does not refresh after an ordinary bounded failure", async () => {
    const createContribution = vi.fn(async (): Promise<GatewayResult<ContributionV1>> => ({
      ok: false,
      error: { kind: "validation", status: 400 },
    }));
    const opts = options({ gateway: gatewayWithCreate(createContribution) });
    const { result } = renderHook(() => useCreateContribution(opts));

    await act(async () => {
      await expect(result.current.create({ kind: "hypothesis", body: "x" })).resolves.toEqual({
        status: "failed",
        error: { kind: "validation", status: 400 },
      });
    });

    expect(opts.onScopeDenied).not.toHaveBeenCalled();
    expect(opts.onRefreshContributions).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({
      status: "failed",
      error: { kind: "validation", status: 400 },
    });
  });

  it("allows only one contribution in flight", async () => {
    const deferred = createDeferred<GatewayResult<ContributionV1>>();
    const gateway = gatewayWithCreate(vi.fn(() => deferred.promise));
    const { result } = renderHook(() => useCreateContribution(options({ gateway })));

    let first!: ReturnType<typeof result.current.create>;
    await act(async () => {
      first = result.current.create({ kind: "note", body: "first" });
      await Promise.resolve();
    });
    await expect(result.current.create({ kind: "note", body: "second" })).resolves.toEqual({
      status: "ignored",
      reason: "busy",
    });
    await act(async () => {
      deferred.resolve({ ok: true, value: contribution() });
      await first;
    });
  });

  it("aborts and cannot publish a late case A answer after moving to case B", async () => {
    const deferred = createDeferred<GatewayResult<ContributionV1>>();
    let observedSignal: AbortSignal | undefined;
    const gateway = gatewayWithCreate(vi.fn((_id, _input, request) => {
      observedSignal = request.signal;
      return deferred.promise;
    }));
    const first = options({ gateway });
    const { result, rerender } = renderHook(
      ({ value }: { value: UseCreateContributionOptions }) => useCreateContribution(value),
      { initialProps: { value: first } },
    );

    let pending!: ReturnType<typeof result.current.create>;
    await act(async () => {
      pending = result.current.create({
        kind: "hypothesis",
        body: "late",
        hypothesisLinks: [{ kind: "artifact", id: RUNTIME_FIXTURE_IDS.evidence }],
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(observedSignal).toBeDefined());
    rerender({ value: { ...first, investigationId: "case-other" } });
    expect(observedSignal?.aborted).toBe(true);

    let outcome;
    await act(async () => {
      deferred.resolve({ ok: true, value: contribution() });
      outcome = await pending;
    });

    expect(outcome).toEqual({ status: "ignored", reason: "stale" });
    expect(first.onContributed).not.toHaveBeenCalled();
    expect(first.onRefreshContributions).not.toHaveBeenCalled();
    expect(first.onScopeDenied).not.toHaveBeenCalled();
  });

  it.each([
    ["identity", { identityKey: "mallory" }],
    ["authority", { authorityKey: "writer-v2" }],
    ["capability", { canContribute: false }],
    ["read-only", { readOnly: true }],
  ] as const)(
    "suppresses a completion whose %s changed while the write was in flight",
    async (_label, change) => {
      const deferred = createDeferred<GatewayResult<ContributionV1>>();
      const gateway = gatewayWithCreate(vi.fn(() => deferred.promise));
      const first = options({ gateway });
      const { result, rerender } = renderHook(
        ({ value }: { value: UseCreateContributionOptions }) => useCreateContribution(value),
        { initialProps: { value: first } },
      );

      let pending!: ReturnType<typeof result.current.create>;
      await act(async () => {
        pending = result.current.create({
          kind: "hypothesis",
          body: "late",
          hypothesisLinks: [{ kind: "artifact", id: RUNTIME_FIXTURE_IDS.evidence }],
        });
        await Promise.resolve();
      });
      rerender({ value: { ...first, ...change } });

      let outcome;
      await act(async () => {
        deferred.resolve({ ok: true, value: contribution() });
        outcome = await pending;
      });

      expect(outcome).toEqual({ status: "ignored", reason: "stale" });
      expect(first.onContributed).not.toHaveBeenCalled();
      expect(result.current.state).toEqual({ status: "idle" });
    },
  );

  it("does not resolve or publish after the controller unmounts", async () => {
    const deferred = createDeferred<GatewayResult<ContributionV1>>();
    const opts = options({ gateway: gatewayWithCreate(vi.fn(() => deferred.promise)) });
    const { result, unmount } = renderHook(() => useCreateContribution(opts));

    let pending!: ReturnType<typeof result.current.create>;
    await act(async () => {
      pending = result.current.create({
        kind: "hypothesis",
        body: "late",
        hypothesisLinks: [{ kind: "artifact", id: RUNTIME_FIXTURE_IDS.evidence }],
      });
      await Promise.resolve();
    });
    unmount();

    let outcome;
    await act(async () => {
      deferred.resolve({ ok: true, value: contribution() });
      outcome = await pending;
    });

    expect(outcome).toEqual({ status: "ignored", reason: "stale" });
    expect(opts.onContributed).not.toHaveBeenCalled();
  });

  it("bounds a thrown transport rejection without publishing its detail", async () => {
    const secret = "private transport detail";
    const opts = options({
      gateway: gatewayWithCreate(vi.fn(() => Promise.reject(new Error(secret)))),
    });
    const { result } = renderHook(() => useCreateContribution(opts));

    let outcome;
    await act(async () => {
      outcome = await result.current.create({ kind: "note", body: "x" });
    });

    expect(outcome).toEqual({ status: "failed", error: { kind: "unexpected" } });
    expect(JSON.stringify(outcome)).not.toContain(secret);
    expect(opts.onContributed).not.toHaveBeenCalled();
  });

  it("does not expose case A completion during the first render of case B", async () => {
    const created = contribution();
    const gateway = gatewayWithCreate(vi.fn(async () => ({ ok: true as const, value: created })));
    const first = options({ gateway });
    const renderedStates: Array<ReturnType<typeof useCreateContribution>["state"]> = [];
    const { result, rerender } = renderHook(
      ({ value }: { value: UseCreateContributionOptions }) => {
        const controller = useCreateContribution(value);
        renderedStates.push(controller.state);
        return controller;
      },
      { initialProps: { value: first } },
    );

    await act(async () => {
      await result.current.create({ kind: "note", body: "case A" });
    });
    expect(result.current.state).toEqual({ status: "succeeded", value: created });

    renderedStates.length = 0;
    rerender({ value: { ...first, investigationId: "case-b" } });
    expect(renderedStates[0]).toEqual({ status: "idle" });
    expect(result.current.state).toEqual({ status: "idle" });
  });
});
