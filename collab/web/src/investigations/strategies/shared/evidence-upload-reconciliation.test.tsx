import { act, render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  useEvidenceUploadReconciliation,
  type FrozenUploadIntent,
  type ReconciliationUploadResult,
} from "./evidence-upload-reconciliation.js";

const file = new File(["original-bytes"], "original.log", { type: "text/plain" });
const intent: FrozenUploadIntent = {
  file,
  summary: "original summary",
  kind: "log",
  privacyClass: "owner_only",
};

function host(upload: (value: FrozenUploadIntent) => Promise<ReconciliationUploadResult>) {
  const paints: Array<ReturnType<typeof useEvidenceUploadReconciliation>> = [];
  let refresh = vi.fn();
  function Probe(props: { readonly scopeKey: string; readonly signature: string; readonly canReadPrivate?: boolean }) {
    const controller = useEvidenceUploadReconciliation({
      scopeKey: props.scopeKey,
      canReadPrivate: props.canReadPrivate ?? true,
      evidenceSignature: props.signature,
      upload,
      refreshEvidence: () => refresh(),
    });
    paints.push(controller);
    useLayoutEffect(() => undefined);
    return null;
  }
  return { Probe, paints, setRefresh(next: () => void) { refresh = vi.fn(next); } };
}

describe("useEvidenceUploadReconciliation", () => {
  it("freezes the original file and waits for a later inventory read", async () => {
    const calls: FrozenUploadIntent[] = [];
    const upload = vi.fn(async (value: FrozenUploadIntent) => {
      calls.push(value);
      return { status: "failed" as const, error: { reason: "commit_outcome_unknown" } };
    });
    const view = host(upload);
    const rendered = render(<view.Probe scopeKey="alice" signature="available|settled|1" />);
    await act(async () => {
      await view.paints.at(-1)?.submit(intent, "form");
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(view.paints.at(-1)?.readyToRetry).toBe(false);
    expect(view.paints.at(-1)?.intent?.file).toBe(file);
    rendered.rerender(<view.Probe scopeKey="alice" signature="available|settled|1" />);
    expect(view.paints.at(-1)?.readyToRetry).toBe(false);
    rendered.rerender(<view.Probe scopeKey="alice" signature="available|loading|1" />);
    rendered.rerender(<view.Probe scopeKey="alice" signature="available|settled|2" />);
    expect(view.paints.at(-1)?.phase).toBe("review");
    expect(view.paints.at(-1)?.readyToRetry).toBe(true);
    const replacement = new File(["edited"], "edited.log", { type: "text/plain" });
    upload.mockResolvedValueOnce({ status: "succeeded" } as ReconciliationUploadResult);
    await act(async () => {
      await view.paints.at(-1)?.submit({ ...intent, file: replacement, summary: "changed", privacyClass: "share_safe" }, "retry");
    });
    expect(calls.at(-1)?.file).toBe(file);
    expect(calls.at(-1)?.summary).toBe("original summary");
    expect(calls.at(-1)?.privacyClass).toBe("owner_only");
  });

  it("conceals a frozen intent on the render that changes scope and does not revive it", async () => {
    const upload = vi.fn(async () => ({ status: "failed" as const, error: { reason: "commit_outcome_unknown" } }));
    const view = host(upload);
    const rendered = render(<view.Probe scopeKey="A" signature="available|settled|0" />);
    await act(async () => {
      await view.paints.at(-1)?.submit(intent, "form");
    });
    const mark = view.paints.length;
    rendered.rerender(<view.Probe scopeKey="B" signature="available|settled|0" />);
    expect(view.paints[mark]?.concealed).toBe(true);
    expect(view.paints[mark]?.intent).toBeNull();
    rendered.rerender(<view.Probe scopeKey="A" signature="available|settled|0" />);
    expect(view.paints.at(-1)?.intent).toBeNull();
    expect(view.paints.at(-1)?.phase).toBe("editing");
  });

  it("does not start a second upload while one submission is in flight", async () => {
    let release: (value: ReconciliationUploadResult) => void = () => undefined;
    const upload = vi.fn(() => new Promise<ReconciliationUploadResult>((resolve) => { release = resolve; }));
    const view = host(upload);
    render(<view.Probe scopeKey="alice" signature="available|settled|0" />);
    const first = view.paints.at(-1)?.submit(intent, "form");
    const second = view.paints.at(-1)?.submit(intent, "form");
    await act(async () => { release({ status: "failed", error: { reason: "storage_unavailable" } }); await first; await second; });
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
