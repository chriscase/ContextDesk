import type {
  ExternalRunJudgmentListV1,
  ExternalRunJudgmentSuccessV1,
} from "@cd-collab/contracts/external-run-judgment";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GatewayResult,
  InvestigationExternalRunJudgmentGateway,
} from "../gateway.js";
import {
  makeExternalRunJudgmentList,
  makeExternalRunJudgmentSuccess,
  RUNTIME_JUDGMENT_FIXTURE_IDS,
} from "../testkit/fixtures.js";
import { createDeferred } from "../testkit/promises.js";
import {
  useExternalRunJudgments,
  type ExternalRunJudgmentCommand,
  type UseExternalRunJudgmentsOptions,
} from "./use-external-run-judgments.js";

const { caseId: CASE_ID, runId: RUN_ID } = RUNTIME_JUDGMENT_FIXTURE_IDS;

afterEach(() => cleanup());

function transport(
  overrides: Partial<InvestigationExternalRunJudgmentGateway> = {},
): InvestigationExternalRunJudgmentGateway {
  return {
    listExternalRunJudgments: vi.fn(async () => ({
      ok: true as const,
      value: makeExternalRunJudgmentList(),
    })),
    createExternalRunJudgment: vi.fn(async () => ({
      ok: true as const,
      value: makeExternalRunJudgmentSuccess(),
    })),
    ...overrides,
  };
}

function options(
  gateway: InvestigationExternalRunJudgmentGateway,
  overrides: Partial<UseExternalRunJudgmentsOptions> = {},
): UseExternalRunJudgmentsOptions {
  return {
    gateway,
    identityKey: "identity-v1",
    authorityKey: "authority-v1",
    investigationId: CASE_ID,
    active: true,
    canRead: true,
    canRecordRunJudgment: true,
    readOnly: false,
    onScopeDenied: vi.fn(),
    ...overrides,
  };
}

function command(overrides: Partial<ExternalRunJudgmentCommand> = {}): ExternalRunJudgmentCommand {
  return {
    runId: RUN_ID,
    judgment: "insufficient_evidence",
    links: [],
    rationale: "A human must compare the output with recorded evidence.",
    idempotencyKey: "judgment-controller-0001",
    ...overrides,
  };
}

describe("useExternalRunJudgments", () => {
  it("does no work until a run is explicitly queried and retains same-scope previous data", async () => {
    const refresh = createDeferred<GatewayResult<ExternalRunJudgmentListV1>>();
    const list = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: makeExternalRunJudgmentList() })
      .mockImplementationOnce(() => refresh.promise);
    const gateway = transport({ listExternalRunJudgments: list });
    const { result } = renderHook(() => useExternalRunJudgments(options(gateway)));
    expect(result.current.judgments).toEqual({ status: "idle" });
    expect(list).not.toHaveBeenCalled();
    act(() => result.current.query(RUN_ID));
    await waitFor(() => expect(result.current.judgments.status).toBe("ready"));
    expect(list).toHaveBeenCalledWith(CASE_ID, RUN_ID, { signal: expect.any(AbortSignal) });
    act(() => result.current.refresh());
    expect(result.current.judgments).toMatchObject({
      status: "loading",
      previous: makeExternalRunJudgmentList(),
    });
    await act(async () => refresh.resolve({ ok: false, error: { kind: "network" } }));
    await waitFor(() => expect(result.current.judgments.status).toBe("failed"));
    expect(result.current.judgments).toMatchObject({
      status: "failed",
      error: { kind: "network" },
      previous: makeExternalRunJudgmentList(),
    });
  });

  it("makes zero reads and writes when reading is denied", async () => {
    const gateway = transport();
    const { result } = renderHook(() => useExternalRunJudgments(options(gateway, {
      canRead: false,
    })));
    act(() => result.current.query(RUN_ID));
    expect(result.current.judgments).toEqual({ status: "idle" });
    await expect(result.current.create(command())).resolves.toEqual({
      status: "ignored",
      reason: "not_ready",
    });
    expect(gateway.listExternalRunJudgments).not.toHaveBeenCalled();
    expect(gateway.createExternalRunJudgment).not.toHaveBeenCalled();
  });

  it("allows reads but no write in viewer and static read-only modes", async () => {
    for (const restricted of [
      { canRecordRunJudgment: false },
      { readOnly: true },
    ]) {
      const gateway = transport();
      const { result, unmount } = renderHook(() => useExternalRunJudgments(options(
        gateway,
        restricted,
      )));
      act(() => result.current.query(RUN_ID));
      await waitFor(() => expect(result.current.judgments.status).toBe("ready"));
      await expect(result.current.create(command())).resolves.toEqual({
        status: "ignored",
        reason: "not_ready",
      });
      expect(gateway.createExternalRunJudgment).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("derives the sequence, merges fresh and replay success, and publishes frozen state", async () => {
    const gateway = transport();
    const { result } = renderHook(() => useExternalRunJudgments(options(gateway)));
    act(() => result.current.query(RUN_ID));
    await waitFor(() => expect(result.current.judgments.status).toBe("ready"));
    let outcome!: Awaited<ReturnType<typeof result.current.create>>;
    await act(async () => {
      outcome = await result.current.create(command());
    });
    expect(outcome.status).toBe("succeeded");
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(gateway.createExternalRunJudgment).toHaveBeenCalledWith(
      CASE_ID,
      RUN_ID,
      expect.objectContaining({ expectedSequence: 0 }),
      { signal: expect.any(AbortSignal) },
    );
    expect(result.current.judgments).toMatchObject({
      status: "ready",
      value: { judgments: [{ seq: 1 }] },
    });
    expect(result.current.judgments.status).toBe("ready");
    if (result.current.judgments.status === "ready") {
      expect(Object.isFrozen(result.current.judgments.value)).toBe(true);
      expect(Object.isFrozen(result.current.judgments.value.judgments)).toBe(true);
    }
  });

  it("refreshes on CAS conflict without posting again", async () => {
    const create = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "judgment_conflict" as const,
        status: 409 as const,
        caseId: CASE_ID,
        runId: RUN_ID,
        expectedSequence: 0,
        currentSequence: 1,
      },
    }));
    const gateway = transport({ createExternalRunJudgment: create });
    const { result } = renderHook(() => useExternalRunJudgments(options(gateway)));
    act(() => result.current.query(RUN_ID));
    await waitFor(() => expect(result.current.judgments.status).toBe("ready"));
    await act(async () => void await result.current.create(command()));
    await waitFor(() => expect(gateway.listExternalRunJudgments).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenCalledOnce();
  });

  it("replays a 503 unknown outcome with the exact frozen request and rejects key reuse", async () => {
    const unknown = {
      ok: false as const,
      error: { kind: "unavailable" as const, status: 503 as const, reason: "commit_outcome_unknown" as const },
    };
    const create = vi.fn()
      .mockResolvedValueOnce(unknown)
      .mockResolvedValueOnce({ ok: true, value: makeExternalRunJudgmentSuccess({ replayed: true }) });
    const gateway = transport({ createExternalRunJudgment: create });
    const { result } = renderHook(() => useExternalRunJudgments(options(gateway)));
    act(() => result.current.query(RUN_ID));
    await waitFor(() => expect(result.current.judgments.status).toBe("ready"));
    await act(async () => void await result.current.create(command()));
    const frozenRequest = create.mock.calls[0]?.[2];
    expect(Object.isFrozen(frozenRequest)).toBe(true);
    act(() => result.current.query(RUN_ID));
    expect(create).toHaveBeenCalledOnce();
    await act(async () => {
      await expect(result.current.create(command({ rationale: "changed" }))).resolves.toEqual({
        status: "failed",
        error: { kind: "input", field: "idempotencyKey", reason: "intent_mismatch" },
      });
    });
    expect(create).toHaveBeenCalledOnce();
    await act(async () => void await result.current.create(command()));
    expect(create.mock.calls[1]?.[2]).toBe(frozenRequest);
  });

  it("fences identity, authority, run, and unmount completions", async () => {
    const deferred = createDeferred<{ ok: true; value: ExternalRunJudgmentListV1 }>();
    const list = vi.fn(() => deferred.promise);
    const gateway = transport({ listExternalRunJudgments: list });
    const base = options(gateway);
    const { result, rerender, unmount } = renderHook(
      ({ value }) => useExternalRunJudgments(value),
      { initialProps: { value: base } },
    );
    act(() => result.current.query(RUN_ID));
    await waitFor(() => expect(list).toHaveBeenCalledOnce());
    rerender({ value: { ...base, authorityKey: "authority-v2" } });
    await act(async () => deferred.resolve({ ok: true, value: makeExternalRunJudgmentList() }));
    expect(result.current.judgments).toEqual({ status: "idle" });
    unmount();
  });

  it("drops stale reads when the explicitly queried run changes", async () => {
    const otherRunId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const reads = [
      createDeferred<GatewayResult<ExternalRunJudgmentListV1>>(),
      createDeferred<GatewayResult<ExternalRunJudgmentListV1>>(),
    ];
    const list = vi.fn((_caseId: string, _runId: string) => reads[list.mock.calls.length - 1]!.promise);
    const gateway = transport({ listExternalRunJudgments: list });
    const { result } = renderHook(() => useExternalRunJudgments(options(gateway)));
    act(() => result.current.query(RUN_ID));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    act(() => result.current.query(otherRunId));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await act(async () => reads[0]!.resolve({
      ok: true,
      value: makeExternalRunJudgmentList(),
    }));
    expect(result.current.runId).toBe(otherRunId);
    expect(result.current.judgments).toEqual({ status: "loading" });
    await act(async () => reads[1]!.resolve({
      ok: true,
      value: makeExternalRunJudgmentList({ runId: otherRunId }),
    }));
    await waitFor(() => expect(result.current.judgments.status).toBe("ready"));
    expect(result.current.judgments).toMatchObject({
      status: "ready",
      value: { runId: otherRunId },
    });
  });

  it("drops an in-flight write after authority change or unmount", async () => {
    for (const invalidate of ["authority", "unmount"] as const) {
      const deferred = createDeferred<GatewayResult<ExternalRunJudgmentSuccessV1>>();
      const create = vi.fn(() => deferred.promise);
      const gateway = transport({ createExternalRunJudgment: create });
      const base = options(gateway);
      const { result, rerender, unmount } = renderHook(
        ({ value }) => useExternalRunJudgments(value),
        { initialProps: { value: base } },
      );
      act(() => result.current.query(RUN_ID));
      await waitFor(() => expect(result.current.judgments.status).toBe("ready"));
      let pending!: ReturnType<typeof result.current.create>;
      act(() => {
        pending = result.current.create(command());
      });
      await waitFor(() => expect(create).toHaveBeenCalledOnce());
      if (invalidate === "authority") {
        rerender({ value: { ...base, authorityKey: "authority-v2" } });
      } else {
        unmount();
      }
      await act(async () => deferred.resolve({
        ok: true,
        value: makeExternalRunJudgmentSuccess(),
      }));
      await expect(pending).resolves.toEqual({ status: "ignored", reason: "stale" });
      if (invalidate === "authority") {
        expect(result.current.state).toEqual({ status: "idle" });
        unmount();
      }
    }
  });

  it("keeps run-local 404 local and only tears down the parent on global auth loss", async () => {
    const denied = vi.fn();
    const list = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { kind: "not_found", status: 404 } })
      .mockResolvedValueOnce({ ok: false, error: { kind: "auth_lost", status: 403 } });
    const gateway = transport({ listExternalRunJudgments: list });
    const { result } = renderHook(() => useExternalRunJudgments(options(gateway, {
      onScopeDenied: denied,
    })));
    act(() => result.current.query(RUN_ID));
    await waitFor(() => expect(result.current.judgments.status).toBe("failed"));
    expect(denied).not.toHaveBeenCalled();
    act(() => result.current.refresh());
    await waitFor(() => expect(denied).toHaveBeenCalledWith(
      CASE_ID,
      { kind: "auth_lost", status: 403 },
    ));
  });
});
