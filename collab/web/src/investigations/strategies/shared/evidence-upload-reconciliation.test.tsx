import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useEvidenceUploadReconciliation, type FrozenUploadIntent, type ReconciliationUploadResult } from "./evidence-upload-reconciliation.js";
const file = new File(["original-bytes"], "original.log", { type: "text/plain" });
const intent: FrozenUploadIntent = { file, summary: "original summary", kind: "log", privacyClass: "owner_only", clientTime: "2026-09-26T00:00:00Z", sourceId: "synthetic-source" };
const unknown = (generation: number): ReconciliationUploadResult => ({ status: "failed", error: { kind: "unavailable", reason: "commit_outcome_unknown" }, evidenceReadGeneration: generation });
function setup(upload = vi.fn<(value: FrozenUploadIntent) => Promise<ReconciliationUploadResult>>().mockResolvedValue(unknown(1))) {
  const refresh = vi.fn(() => 2);
  const initialProps = { scopeKey: "A", canReadPrivate: true, canSubmit: true, readCompletion: { requested: 0, succeeded: 0, failed: -1 } };
  const hook = renderHook((props) => useEvidenceUploadReconciliation({ ...props, upload, refreshEvidence: refresh }), { initialProps });
  return { ...hook, upload, refresh, initialProps };
}
async function submit(view: ReturnType<typeof setup>, next = intent, source: "form" | "retry" = "form") {
  await act(async () => { await view.result.current.submit(next, source); });
}
describe("useEvidenceUploadReconciliation", () => {
  it("freezes caller metadata and original File while a new causal read unlocks retry", async () => {
    const view = setup();
    const caller = { ...intent };
    await submit(view, caller);
    caller.summary = "changed"; caller.privacyClass = "share_safe"; caller.clientTime = "changed"; caller.sourceId = "changed";
    expect(view.result.current.intent?.summary).toBe("original summary");
    expect(view.result.current.intent?.file).toBe(file);
    expect(view.result.current.readyToRetry).toBe(false);
    view.rerender({ ...view.initialProps, readCompletion: { requested: 1, succeeded: 1, failed: -1 } });
    expect(view.result.current.readyToRetry).toBe(true);
    view.upload.mockResolvedValueOnce({ status: "succeeded" });
    await submit(view, { ...intent, file: new File(["edited"], "edited.log"), summary: "edited", privacyClass: "share_safe" }, "retry");
    expect(view.upload.mock.calls[1]?.[0]).toEqual(intent);
    expect(view.result.current.intent).toBeNull();
  });
  it("never unlocks from a pre-failure completion or another allocated ready snapshot", async () => {
    const view = setup(); await submit(view);
    view.rerender({ ...view.initialProps, readCompletion: { requested: 1, succeeded: 0, failed: -1 } });
    expect(view.result.current.phase).toBe("refreshing");
    await submit(view, intent, "retry"); await submit(view);
    expect(view.upload).toHaveBeenCalledTimes(1);
  });
  it("keeps the frozen intent through a failed read then accepts a successful empty or unchanged inventory", async () => {
    const view = setup(); await submit(view);
    view.rerender({ ...view.initialProps, readCompletion: { requested: 1, succeeded: 0, failed: 1 } });
    expect(view.result.current.phase).toBe("refresh_failed");
    expect(view.result.current.intent?.file).toBe(file);
    act(() => view.result.current.refreshAgain());
    expect(view.refresh).toHaveBeenCalledTimes(1);
    view.rerender({ ...view.initialProps, readCompletion: { requested: 2, succeeded: 2, failed: -1 } });
    expect(view.result.current.phase).toBe("review");
    expect(view.upload).toHaveBeenCalledTimes(1);
  });
  it("accepts a qualifying read that finishes immediately before upload outcome publication", async () => {
    const view = setup();
    view.rerender({ ...view.initialProps, readCompletion: { requested: 1, succeeded: 1, failed: -1 } });
    await submit(view);
    expect(view.result.current.readyToRetry).toBe(true);
    expect(view.refresh).not.toHaveBeenCalled();
  });
  it("a repeated unknown creates a new barrier that the previous read cannot satisfy", async () => {
    const view = setup(); await submit(view);
    view.rerender({ ...view.initialProps, readCompletion: { requested: 1, succeeded: 1, failed: -1 } });
    view.upload.mockResolvedValueOnce(unknown(2));
    await submit(view, intent, "retry");
    expect(view.result.current.readyToRetry).toBe(false);
    expect(view.result.current.phase).toBe("refreshing");
    await submit(view, intent, "retry");
    expect(view.upload).toHaveBeenCalledTimes(2);
  });
  it.each(["B", "A-denied", "A-private-revoked", "A-archived"])("drops obsolete callbacks on %s and A-B-A reuse", async (scopeKey) => {
    const view = setup(); await submit(view);
    view.rerender({ ...view.initialProps, readCompletion: { requested: 1, succeeded: 1, failed: -1 } });
    const old = view.result.current;
    view.rerender({ ...view.initialProps, scopeKey });
    expect(view.result.current.intent).toBeNull();
    view.rerender(view.initialProps);
    await act(async () => { await old.submit(intent, "retry"); old.refreshAgain(); old.finish(); await old.submit(intent, "form"); });
    expect(view.upload).toHaveBeenCalledTimes(1);
    expect(view.refresh).not.toHaveBeenCalled();
    expect(view.result.current.intent).toBeNull();
  });
  it("discards obsolete in-flight results and releases File on unmount", async () => {
    let resolve!: (value: ReconciliationUploadResult) => void;
    const view = setup(vi.fn(() => new Promise<ReconciliationUploadResult>((done) => { resolve = done; })));
    const old = view.result.current;
    let task: Promise<unknown> | undefined;
    act(() => { task = old.submit(intent, "form"); });
    view.rerender({ ...view.initialProps, scopeKey: "B" });
    await act(async () => { resolve(unknown(1)); await task; });
    expect(view.result.current.intent).toBeNull();
    view.unmount();
    await old.submit(intent, "form"); old.refreshAgain();
    expect(view.upload).toHaveBeenCalledTimes(1);
    expect(view.refresh).not.toHaveBeenCalled();
  });
  it("guards double-submit before rerender and blocks direct submission while unresolved", async () => {
    let resolve!: (value: ReconciliationUploadResult) => void;
    const view = setup(vi.fn(() => new Promise<ReconciliationUploadResult>((done) => { resolve = done; })));
    await act(async () => {
      const action = view.result.current.submit;
      const one = action(intent, "form"); const two = action(intent, "form");
      resolve(unknown(1)); await one; await two;
    });
    await submit(view);
    expect(view.upload).toHaveBeenCalledTimes(1);
  });
  it.each([{ kind: "unavailable", reason: "storage_unavailable" }, { kind: "unexpected", reason: "commit_outcome_unknown" }])("does not reconcile ordinary failure %j", async (error) => {
    const view = setup(vi.fn().mockResolvedValue({ status: "failed", error })); await submit(view);
    expect(view.result.current.phase).toBe("ordinary_failure");
    expect(view.result.current.intent).toBeNull();
    expect(view.refresh).not.toHaveBeenCalled();
  });
  it("requires human-review readiness for local finish and never compensates with a write", async () => {
    const view = setup(); await submit(view);
    act(() => view.result.current.finish()); expect(view.result.current.intent).not.toBeNull();
    view.rerender({ ...view.initialProps, readCompletion: { requested: 1, succeeded: 1, failed: -1 } });
    act(() => view.result.current.finish()); expect(view.result.current.intent).toBeNull();
    expect(view.upload).toHaveBeenCalledTimes(1);
  });
  it("read-only and private-revoked actions fail closed without broadening the draft", async () => {
    const view = setup(); await submit(view);
    view.rerender({ ...view.initialProps, canReadPrivate: false, canSubmit: false, readCompletion: { requested: 1, succeeded: 1, failed: -1 } });
    await submit(view, { ...intent, privacyClass: "share_safe" }, "retry");
    expect(view.upload).toHaveBeenCalledTimes(1);
    expect(view.result.current.readyToRetry).toBe(false);
    expect(view.result.current.intent?.privacyClass).toBe("owner_only");
  });
});
