import { useLayoutEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EvidenceUploadReconciliationForm, type EvidenceUploadReconciliationFormProps } from "./EvidenceUploadReconciliationForm.js";
import type { useEvidenceUploadReconciliation } from "./evidence-upload-reconciliation.js";
type Recovery = ReturnType<typeof useEvidenceUploadReconciliation>;
const observed = vi.hoisted(() => ({ current: null as Recovery | null, passiveCleanups: 0, commands: 0, publications: 0 }));
// Observe the actual hook in the actual form; invoke only during replacement layout,
// never from render or by dispatching an event on a detached DOM node.
vi.mock("./evidence-upload-reconciliation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./evidence-upload-reconciliation.js")>();
  const { useEffect } = await import("react");
  return { ...actual, useEvidenceUploadReconciliation: function useObservedRecovery(options: Parameters<typeof actual.useEvidenceUploadReconciliation>[0]) {
    const recovery = actual.useEvidenceUploadReconciliation(options); observed.current = recovery;
    useEffect(() => () => { observed.passiveCleanups += 1; }, []);
    return recovery;
  } };
});
beforeEach(() => { observed.current = null; observed.passiveCleanups = 0; observed.commands = 0; observed.publications = 0; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function LayoutProbe({ probe }: { readonly probe?: () => void }) {
  useLayoutEffect(() => { probe?.(); }, [probe]); return null;
}
function Host({ props, shown = true, probe }: { readonly props: EvidenceUploadReconciliationFormProps; readonly shown?: boolean; readonly probe?: () => void }) {
  return <>{shown ? <EvidenceUploadReconciliationForm {...props} /> : null}<LayoutProbe {...(probe ? { probe } : {})} /></>;
}
const original = new File(["synthetic original bytes"], "original.log", { type: "text/plain" });
function initial(variant: EvidenceUploadReconciliationFormProps["variant"]): EvidenceUploadReconciliationFormProps {
  return { variant, scopeKey: "A:alice:private:open", canRead: true, canUpload: true, canReadPrivate: true,
    readCompletion: { requested: 0, succeeded: 0, failed: -1 }, refreshEvidence: vi.fn(() => 2),
    upload: vi.fn(async () => ({ status: "failed" as const, error: { kind: "unavailable", reason: "commit_outcome_unknown" }, evidenceReadGeneration: 1 })) };
}
function fill() {
  const form = document.querySelector<HTMLFormElement>(".evidence-reconciliation")!;
  fireEvent.change(form.elements.namedItem("file") as HTMLInputElement, { target: { files: [original] } });
  fireEvent.change(form.elements.namedItem("summary") as HTMLInputElement, { target: { value: "  original annotation  " } });
  fireEvent.change(form.elements.namedItem("kind") as HTMLSelectElement, { target: { value: "log" } }); return form;
}
const transitions = ["B", "upload revoked", "private revoked", "read revoked", "removed"] as const;
describe.each(["investigation-first", "beacon"] as const)("%s actual keyed recovery composition", (variant) => {
  describe.each(["retry", "refresh"] as const)("captured %s action", (action) => {
    it.each(transitions)("revokes A during %s replacement layout before passive cleanup and on A-B-A", async (transition) => {
      const props = initial(variant); const view = render(<Host props={props} />);
      await act(async () => fireEvent.submit(fill()));
      const ready = { ...props, readCompletion: { requested: 1, succeeded: 1, failed: -1 } }; view.rerender(<Host props={ready} />);
      expect(screen.getByRole("button", { name: "Retry original upload" }).hasAttribute("disabled")).toBe(false);
      const captured = observed.current!; const intent = captured.intent!; expect(intent.file).toBe(original);
      const pending: Promise<unknown>[] = []; const witness: number[] = [];
      function invoke() { witness.push(observed.passiveCleanups); if (action === "retry") pending.push(captured.submit(intent, "retry")); else captured.refreshAgain(); }
      const before = observed.passiveCleanups;
      const changed = { ...ready, scopeKey: `A:${transition}`, ...(transition === "upload revoked" ? { canUpload: false } : {}), ...(transition === "private revoked" ? { canReadPrivate: false } : {}), ...(transition === "read revoked" ? { canRead: false } : {}) };
      view.rerender(<Host props={changed} shown={transition !== "removed"} probe={invoke} />);
      expect(witness[0]).toBe(before); // exact pre-passive window
      await act(async () => { await Promise.all(pending); });
      expect(props.upload).toHaveBeenCalledTimes(1); expect(props.refreshEvidence).not.toHaveBeenCalled();
      const beforeReturn = observed.passiveCleanups; view.rerender(<Host props={ready} probe={() => invoke()} />);
      expect(witness[1]).toBe(beforeReturn); await act(async () => { await Promise.all(pending); });
      expect(props.upload).toHaveBeenCalledTimes(1); expect(props.refreshEvidence).not.toHaveBeenCalled(); expect(observed.current?.intent).toBeNull();
    });
  });
  it.each(["explicit", "external"] as const)("announces one ordinary retry failure through %s inventory refresh without changing frozen intent", async (refreshSource) => {
    const props = initial(variant); const view = render(<Host props={props} />); await act(async () => fireEvent.submit(fill()));
    view.rerender(<Host props={{ ...props, readCompletion: { requested: 1, succeeded: 1, failed: -1 } }} />);
    vi.mocked(props.upload!).mockResolvedValueOnce({ status: "failed", error: { kind: "unavailable", reason: "storage_unavailable" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry original upload" })));
    const ids = Array.from(document.querySelectorAll<HTMLElement>("[id]")).map((node) => node.id); expect(new Set(ids).size).toBe(ids.length);
    const failure = screen.getByRole("alert"); expect(failure.textContent).toContain("No success has been confirmed"); expect(document.activeElement).toBe(failure);
    const form = document.querySelector<HTMLFormElement>(".evidence-reconciliation")!;
    expect((form.elements.namedItem("file") as HTMLInputElement).getAttribute("aria-describedby")).toBe(failure.id);
    expect((form.elements.namedItem("summary") as HTMLInputElement).getAttribute("aria-describedby")).toBe(failure.id);
    expect(observed.current?.intent).toMatchObject({ file: original, summary: "  original annotation  ", kind: "log", privacyClass: "owner_only" });
    const calls = vi.mocked(props.upload!).mock.calls; expect(calls).toHaveLength(2); expect(calls[1]?.[0]).toBe(calls[0]?.[0]); expect(props.refreshEvidence).not.toHaveBeenCalled();
    const frozen = observed.current!.intent;
    function assertNotice(phaseText: string) {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>("[id]"));
      expect(nodes).toHaveLength(1); expect(new Set(nodes.map((node) => node.id)).size).toBe(nodes.length);
      const notice = screen.getByRole("alert"); expect(notice.textContent).toContain("No success has been confirmed");
      expect(notice.textContent).toContain(phaseText); expect(document.activeElement).toBe(notice);
      for (const name of ["file", "summary"]) expect((form.elements.namedItem(name) as HTMLInputElement).getAttribute("aria-describedby")).toBe(notice.id);
      expect(observed.current!.intent).toBe(frozen); expect(frozen!.file).toBe(original); expect(calls).toHaveLength(2);
    }
    if (refreshSource === "explicit") fireEvent.click(screen.getByRole("button", { name: "Refresh inventory" }));
    view.rerender(<Host props={{ ...props, readCompletion: { requested: 2, succeeded: 1, failed: -1 } }} />);
    assertNotice("while the inventory refreshes"); expect(screen.queryByRole("button", { name: "Retry original upload" })).toBeNull();
    view.rerender(<Host props={{ ...props, readCompletion: { requested: 2, succeeded: 1, failed: 2 } }} />);
    assertNotice("The inventory refresh failed");
    view.rerender(<Host props={{ ...props, readCompletion: { requested: 3, succeeded: 1, failed: 2 } }} />);
    assertNotice("while the inventory refreshes");
    view.rerender(<Host props={{ ...props, readCompletion: { requested: 3, succeeded: 3, failed: 2 } }} />);
    assertNotice("Review the refreshed inventory"); expect(screen.getByRole("button", { name: "Retry original upload" }).hasAttribute("disabled")).toBe(false);
    expect(props.refreshEvidence).toHaveBeenCalledTimes(refreshSource === "explicit" ? 1 : 0);
    vi.mocked(props.upload!).mockResolvedValueOnce({ status: "succeeded" }); await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry original upload" })));
    expect(calls).toHaveLength(3); expect(calls[2]?.[0]).toBe(calls[0]?.[0]); expect(screen.getByRole("status").textContent).toContain("Evidence added");
  });
});


// Instrument the real controller, without replacing its readiness, preparation,
// request fencing or publication behavior. The production HTTP upload gateway
// below reaches a fetch boundary; only that boundary is stubbed (no live server).
vi.mock("../../runtime/controllers/use-upload-evidence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runtime/controllers/use-upload-evidence.js")>();
  const { useCallback } = await import("react");
  return { ...actual, useUploadEvidence: function useObservedUpload(options: Parameters<typeof actual.useUploadEvidence>[0]) {
    const controller = actual.useUploadEvidence({ ...options, onUploaded: (...args) => { observed.publications += 1; options.onUploaded(...args); } });
    const upload = useCallback((...args: Parameters<typeof controller.upload>) => { observed.commands += 1; return controller.upload(...args); }, [controller.upload]);
    return { ...controller, upload };
  } };
});
import { InvestigationRuntimeProvider, useInvestigationRuntime } from "../../runtime/public.js";
import { InvestigationRuntimeGatewayHarness, createDeferred, createInvestigationGatewayDouble, gatewayOk, makeArchiveAllowedLifecycle, makePopulatedCase, makeEvidenceUploadSuccess, RUNTIME_FIXTURE_IDS, type InvestigationGateway } from "../../runtime/testkit/index.js";
import { investigationGateway } from "../../runtime/gateway.js";
import { InvestigationFirstStrategy } from "../investigation-first/InvestigationFirstStrategy.js";
import { BeaconStrategy } from "../beacon/BeaconStrategy.js";
let runtime: ReturnType<typeof useInvestigationRuntime>;
function CaptureRuntime() { runtime = useInvestigationRuntime(); return null; }
const open = () => undefined;
function RuntimeHost({ gateway, variant, transition = "A", probe }: { readonly gateway: InvestigationGateway; readonly variant: "investigation-first" | "beacon"; readonly transition?: string; readonly probe?: () => void }) {
  const focusCaseId = transition === "B" ? RUNTIME_FIXTURE_IDS.sparseCase : RUNTIME_FIXTURE_IDS.populatedCase;
  const capabilities = transition === "read revoked" ? [] : transition === "upload revoked" ? ["investigation:read"] : transition === "private revoked" ? ["investigation:read", "investigation:write"] : ["investigation:read", "investigation:write", "evidence:private:read"];
  const Strategy = variant === "beacon" ? BeaconStrategy : InvestigationFirstStrategy;
  return <InvestigationRuntimeGatewayHarness gateway={gateway}><InvestigationRuntimeProvider identityKey="alice" identity={{ id: "alice", username: "alice", displayName: "Alice" }} authorityKey={transition === "A" || transition === "B" || transition === "removed" ? "lead" : transition} capabilities={capabilities} readOnly={false} active focusCaseId={focusCaseId} isInvestigationLocation onOpenCreated={open}>
    <CaptureRuntime />{transition !== "removed" ? <Strategy view="investigations" focusCaseId={focusCaseId} stage="situation" onOpenCase={open} onNavigateInvestigation={open} onExitFocus={open} /> : null}<LayoutProbe {...(probe ? { probe } : {})} />
  </InvestigationRuntimeProvider></InvestigationRuntimeGatewayHarness>;
}
function actualGateway() {
  return createInvestigationGatewayDouble({ getInvestigation: vi.fn(async (id) => gatewayOk({ ...makePopulatedCase(), id })), getLifecycle: vi.fn(async (id) => gatewayOk({ ...makeArchiveAllowedLifecycle(), investigationId: id })), uploadEvidenceStream: investigationGateway.uploadEvidenceStream! });
}
describe.each(["investigation-first", "beacon"] as const)("%s production Runtime stale action effects", (variant) => {
  it.each(transitions)("blocks obsolete form action before command, HTTP gateway request and publication during %s", async (transition) => {
    const reply = createDeferred<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ error: "commit_outcome_unknown" }), { status: 503, headers: { "content-type": "application/json" } })).mockReturnValue(reply.promise);
    vi.stubGlobal("fetch", fetch); const gateway = actualGateway();
    const view = render(<RuntimeHost gateway={gateway} variant={variant} />);
    await waitFor(() => expect(runtime.resources.lifecycle.status).toBe("ready"));
    await act(async () => fireEvent.submit(fill()));
    await screen.findByRole("button", { name: "Retry original upload" });
    const captured = observed.current!; const intent = captured.intent!;
    expect(observed.commands).toBe(1); expect(fetch).toHaveBeenCalledTimes(1); expect(observed.publications).toBe(0);
    let task: Promise<unknown> | undefined; let effects: Record<string, number> | undefined;
    view.rerender(<RuntimeHost gateway={gateway} variant={variant} transition={transition} probe={() => {
      task = captured.submit(intent, "retry");
      effects = { obsoleteFormActions: 1, reachedUploadCommand: observed.commands - 1, httpGatewayRequests: fetch.mock.calls.length - 1, publishedResults: observed.publications };
    }} />);
    await act(async () => { reply.resolve(new Response(JSON.stringify(makeEvidenceUploadSuccess()), { status: 200, headers: { "content-type": "application/json" } })); await task; });
    console.info("S3-IR-01 causal effects", JSON.stringify({ variant, transition, ...effects, eventualPublishedResults: observed.publications }));
    expect(effects, JSON.stringify({ variant, transition, ...effects, eventualPublishedResults: observed.publications })).toEqual({ obsoleteFormActions: 1, reachedUploadCommand: 0, httpGatewayRequests: 0, publishedResults: 0 });
    expect(fetch).toHaveBeenCalledTimes(1); expect(observed.publications).toBe(0);
    expect(document.querySelector(".evidence-reconciliation")?.textContent ?? "").not.toContain("Evidence added to the inventory");
  });
  it("drops the eventual result of an already-dispatched legitimate upload after scope replacement", async () => {
    const reply = createDeferred<Response>(); const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(reply.promise); vi.stubGlobal("fetch", fetch);
    const gateway = actualGateway(); const view = render(<RuntimeHost gateway={gateway} variant={variant} />);
    await waitFor(() => expect(runtime.resources.lifecycle.status).toBe("ready"));
    act(() => fireEvent.submit(fill())); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(observed.commands).toBe(1);
    view.rerender(<RuntimeHost gateway={gateway} variant={variant} transition="B" />);
    await act(async () => reply.resolve(new Response(JSON.stringify(makeEvidenceUploadSuccess()), { status: 200, headers: { "content-type": "application/json" } })));
    expect(fetch).toHaveBeenCalledTimes(1); expect(observed.publications).toBe(0);
    expect(document.querySelector(".evidence-reconciliation")?.textContent ?? "").not.toContain("Evidence added to the inventory");
  });
});
