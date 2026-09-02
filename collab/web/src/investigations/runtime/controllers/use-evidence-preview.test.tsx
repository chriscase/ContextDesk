import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvidencePreviewValue, InvestigationGateway } from "../gateway.js";
import { createDeferred } from "../testkit/promises.js";
import { RUNTIME_FIXTURE_IDS } from "../testkit/fixtures.js";
import { useEvidencePreview, type UseEvidencePreviewOptions } from "./use-evidence-preview.js";

afterEach(() => cleanup());

function options(overrides: Partial<UseEvidencePreviewOptions> = {}): UseEvidencePreviewOptions {
  return {
    gateway: { previewEvidence: vi.fn() } as unknown as InvestigationGateway,
    identityKey: "alice",
    authorityKey: "authority-v1",
    investigationId: RUNTIME_FIXTURE_IDS.populatedCase,
    canRead: true,
    ...overrides,
  };
}

function preview(artifactId = RUNTIME_FIXTURE_IDS.evidence): EvidencePreviewValue {
  return { artifactId, text: "a bounded preview", truncated: false, etag: '"v1"' };
}

function gatewayWithPreview(
  previewEvidence: NonNullable<InvestigationGateway["previewEvidence"]>,
): InvestigationGateway {
  return { previewEvidence } as unknown as InvestigationGateway;
}

describe("useEvidencePreview", () => {
  it("publishes an authorized preview and caches its ETag", async () => {
    const previewEvidence = vi.fn(async () => ({ ok: true as const, value: preview() }));
    const { result } = renderHook(() => useEvidencePreview(options({ gateway: gatewayWithPreview(previewEvidence) })));
    await act(async () => {
      await expect(result.current.preview({ artifactId: RUNTIME_FIXTURE_IDS.evidence })).resolves.toEqual({
        status: "succeeded",
        value: preview(),
      });
    });
    expect(result.current.state).toEqual({ status: "succeeded", value: preview() });
    expect(previewEvidence).toHaveBeenCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      RUNTIME_FIXTURE_IDS.evidence,
      {},
      { signal: expect.any(AbortSignal) },
    );
    act(() => result.current.clear());
    expect(result.current.state).toEqual({ status: "idle" });
  });

  it("reuses a cached preview after a not-modified response", async () => {
    const previewEvidence = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: preview() })
      .mockResolvedValueOnce({ ok: true as const, value: { ...preview(), text: "", notModified: true as const } });
    const { result } = renderHook(() => useEvidencePreview(options({ gateway: gatewayWithPreview(previewEvidence) })));
    await act(async () => { await result.current.preview({ artifactId: RUNTIME_FIXTURE_IDS.evidence }); });
    act(() => result.current.clear());
    await act(async () => {
      await expect(result.current.preview({ artifactId: RUNTIME_FIXTURE_IDS.evidence })).resolves.toEqual({
        status: "succeeded",
        value: preview(),
      });
    });
    expect(previewEvidence.mock.calls[1]?.[2]).toEqual({ ifNoneMatch: '"v1"' });
  });

  it("does not publish a late response after the investigation changes", async () => {
    const deferred = createDeferred<Awaited<ReturnType<NonNullable<InvestigationGateway["previewEvidence"]>>>>();
    const previewEvidence = vi.fn(() => deferred.promise);
    const first = options({ gateway: gatewayWithPreview(previewEvidence) });
    const { result, rerender } = renderHook(
      ({ value }: { value: UseEvidencePreviewOptions }) => useEvidencePreview(value),
      { initialProps: { value: first } },
    );
    let pending!: ReturnType<typeof result.current.preview>;
    act(() => { pending = result.current.preview({ artifactId: RUNTIME_FIXTURE_IDS.evidence }); });
    rerender({ value: { ...first, investigationId: "case-other" } });
    await act(async () => {
      deferred.resolve({ ok: true, value: preview() });
      await expect(pending).resolves.toEqual({ status: "ignored", reason: "stale" });
    });
    await waitFor(() => expect(result.current.state).toEqual({ status: "idle" }));
  });
});
