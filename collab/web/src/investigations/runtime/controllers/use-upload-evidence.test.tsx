import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvestigationGateway } from "../gateway.js";
import {
  makeEvidenceUploadSuccess,
  RUNTIME_FIXTURE_IDS,
} from "../testkit/fixtures.js";
import { createDeferred } from "../testkit/promises.js";
import {
  useUploadEvidence,
  type UseUploadEvidenceOptions,
} from "./use-upload-evidence.js";

afterEach(() => cleanup());

function gatewayWithUpload(
  uploadEvidence: InvestigationGateway["uploadEvidence"],
): InvestigationGateway {
  return { uploadEvidence } as InvestigationGateway;
}

function options(
  overrides: Partial<UseUploadEvidenceOptions> = {},
): UseUploadEvidenceOptions {
  return {
    gateway: gatewayWithUpload(vi.fn()),
    identityKey: "alice",
    authorityKey: "writer-v1",
    investigationId: RUNTIME_FIXTURE_IDS.populatedCase,
    canUpload: true,
    readOnly: false,
    onUploaded: vi.fn(),
    onRefreshEvidence: vi.fn(),
    onRefreshInvestigations: vi.fn(),
    onScopeDenied: vi.fn(),
    ...overrides,
  };
}

describe("useUploadEvidence", () => {
  it("prepares a browser file and publishes authoritative artifact and summary", async () => {
    const success = makeEvidenceUploadSuccess();
    const uploadEvidence = vi.fn(async () => ({ ok: true as const, value: success }));
    const opts = options({ gateway: gatewayWithUpload(uploadEvidence) });
    const { result } = renderHook(() => useUploadEvidence(opts));

    await act(async () => {
      await expect(result.current.upload({
        file: new File(["hello"], " evidence.txt ", { type: "text/plain" }),
        summary: "  Useful excerpt  ",
        kind: "log",
      })).resolves.toEqual({ status: "succeeded", value: success });
    });

    expect(uploadEvidence).toHaveBeenCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      expect.objectContaining({
        kind: "log",
        summary: "Useful excerpt",
        filename: "evidence.txt",
        mediaType: "text/plain",
        contentBase64: "aGVsbG8=",
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(opts.onUploaded).toHaveBeenCalledWith(success.artifact, success.summary);
    expect(opts.onRefreshEvidence).toHaveBeenCalledWith(RUNTIME_FIXTURE_IDS.populatedCase);
    expect(opts.onRefreshInvestigations).toHaveBeenCalledOnce();
  });

  it("fails closed without authority or an active case and bounds input failures", async () => {
    const uploadEvidence = vi.fn();
    const base = options({ gateway: gatewayWithUpload(uploadEvidence), canUpload: false });
    const { result, rerender } = renderHook(
      ({ value }: { value: UseUploadEvidenceOptions }) => useUploadEvidence(value),
      { initialProps: { value: base } },
    );

    await expect(result.current.upload({ file: new Blob(["x"]), summary: "x" })).resolves.toEqual({
      status: "ignored",
      reason: "not_ready",
    });
    rerender({ value: { ...base, canUpload: true, investigationId: null } });
    await expect(result.current.upload({ file: new Blob(["x"]), summary: "x" })).resolves.toEqual({
      status: "ignored",
      reason: "not_ready",
    });
    rerender({
      value: { ...base, canUpload: true, investigationId: RUNTIME_FIXTURE_IDS.populatedCase, readOnly: true },
    });
    await expect(result.current.upload({ file: new Blob(["x"]), summary: "x" })).resolves.toEqual({
      status: "ignored",
      reason: "not_ready",
    });
    rerender({ value: { ...base, canUpload: true } });
    await act(async () => {
      await expect(result.current.upload({ file: undefined, summary: "x" })).resolves.toEqual({
        status: "failed",
        error: { kind: "input", field: "file", reason: "required" },
      });
    });
    expect(uploadEvidence).not.toHaveBeenCalled();
  });

  it("allows only one upload in flight", async () => {
    const deferred = createDeferred<Awaited<ReturnType<InvestigationGateway["uploadEvidence"]>>>();
    const gateway = gatewayWithUpload(vi.fn(() => deferred.promise));
    const { result } = renderHook(() => useUploadEvidence(options({ gateway })));

    let first!: ReturnType<typeof result.current.upload>;
    await act(async () => {
      first = result.current.upload({ file: new Blob(["first"]), summary: "First" });
      await Promise.resolve();
    });
    await expect(result.current.upload({ file: new Blob(["second"]), summary: "Second" }))
      .resolves.toEqual({ status: "ignored", reason: "busy" });
    await act(async () => {
      deferred.resolve({ ok: true, value: makeEvidenceUploadSuccess() });
      await first;
    });
  });

  it("stops before transport when the active case changes during file conversion", async () => {
    const read = createDeferred<ArrayBuffer>();
    const file = new Blob(["late"]);
    Object.defineProperty(file, "arrayBuffer", { value: () => read.promise });
    const uploadEvidence = vi.fn();
    const first = options({ gateway: gatewayWithUpload(uploadEvidence) });
    const { result, rerender } = renderHook(
      ({ value }: { value: UseUploadEvidenceOptions }) => useUploadEvidence(value),
      { initialProps: { value: first } },
    );

    let pending!: ReturnType<typeof result.current.upload>;
    act(() => {
      pending = result.current.upload({ file, summary: "Late" });
    });
    rerender({ value: { ...first, investigationId: "case-other" } });
    let outcome;
    await act(async () => {
      read.resolve(new TextEncoder().encode("late").buffer);
      outcome = await pending;
    });
    expect(outcome).toEqual({ status: "ignored", reason: "stale" });
    expect(uploadEvidence).not.toHaveBeenCalled();
  });

  it("cannot publish or refresh a late case A response after switching to case B", async () => {
    const deferred = createDeferred<Awaited<ReturnType<InvestigationGateway["uploadEvidence"]>>>();
    let observedSignal: AbortSignal | undefined;
    const gateway = gatewayWithUpload(vi.fn((_id, _input, request) => {
      observedSignal = request.signal;
      return deferred.promise;
    }));
    const first = options({ gateway });
    const { result, rerender } = renderHook(
      ({ value }: { value: UseUploadEvidenceOptions }) => useUploadEvidence(value),
      { initialProps: { value: first } },
    );

    let pending!: ReturnType<typeof result.current.upload>;
    await act(async () => {
      pending = result.current.upload({ file: new Blob(["late"]), summary: "Late" });
      await Promise.resolve();
    });
    await waitFor(() => expect(observedSignal).toBeDefined());
    rerender({ value: { ...first, investigationId: "case-other" } });
    expect(observedSignal?.aborted).toBe(true);
    let outcome;
    await act(async () => {
      deferred.resolve({ ok: true, value: makeEvidenceUploadSuccess() });
      outcome = await pending;
    });

    expect(outcome).toEqual({ status: "ignored", reason: "stale" });
    expect(first.onUploaded).not.toHaveBeenCalled();
    expect(first.onRefreshEvidence).not.toHaveBeenCalled();
    expect(first.onRefreshInvestigations).not.toHaveBeenCalled();
  });

  it("does not expose case A completion during the first render of case B", async () => {
    const success = makeEvidenceUploadSuccess();
    const gateway = gatewayWithUpload(vi.fn(async () => ({ ok: true as const, value: success })));
    const first = options({ gateway });
    const renderedStates: Array<ReturnType<typeof useUploadEvidence>["state"]> = [];
    const { result, rerender } = renderHook(
      ({ value }: { value: UseUploadEvidenceOptions }) => {
        const controller = useUploadEvidence(value);
        renderedStates.push(controller.state);
        return controller;
      },
      { initialProps: { value: first } },
    );

    await act(async () => {
      await result.current.upload({ file: new Blob(["case-a"]), summary: "Case A" });
    });
    expect(result.current.state).toEqual({ status: "succeeded", value: success });

    renderedStates.length = 0;
    rerender({ value: { ...first, investigationId: "case-b" } });
    expect(renderedStates[0]).toEqual({ status: "idle" });
    expect(result.current.state).toEqual({ status: "idle" });
  });
});
