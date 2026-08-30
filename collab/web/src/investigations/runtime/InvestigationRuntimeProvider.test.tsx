import {
  INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID,
  type CaseV1,
  type InvestigationLifecycleActionSuccessV1,
} from "@cd-collab/contracts/investigation-runtime";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayResult, InvestigationGateway } from "./gateway.js";
import {
  InvestigationRuntimeProvider,
  type InvestigationRuntime,
  useInvestigationRuntime,
} from "./InvestigationRuntimeProvider.js";
import {
  makeArchiveAllowedLifecycle,
  makeArchiveRefusedLifecycle,
  makeCaseList,
  makeContributionList,
  makeEvidenceList,
  makeEvidenceUploadSuccess,
  makePopulatedCase,
  makeSparseImportedCase,
  RUNTIME_FIXTURE_IDS,
} from "./testkit/fixtures.js";
import { createDeferred } from "./testkit/promises.js";

const FULL_CAPABILITIES = [
  "investigation:read",
  "investigation:write",
  "run:strategies",
] as const;

const unexpected = async <T,>(): Promise<GatewayResult<T>> => ({
  ok: false,
  error: { kind: "unexpected" },
});

function succeeded<T>(value: T): GatewayResult<T> {
  return { ok: true, value };
}

function makeGateway(overrides: Partial<InvestigationGateway> = {}): InvestigationGateway {
  return {
    listInvestigations: vi.fn(async () => succeeded(makeCaseList().cases)),
    getInvestigation: vi.fn(async () => succeeded(makePopulatedCase())),
    createInvestigation: vi.fn(() => unexpected<CaseV1>()),
    listEvidence: vi.fn(async () => succeeded(makeEvidenceList().artifacts)),
    listContributions: vi.fn(async () => succeeded(makeContributionList().contributions)),
    uploadEvidence: vi.fn(() => unexpected<never>()),
    getLifecycle: vi.fn(async () => succeeded(makeArchiveAllowedLifecycle())),
    applyLifecycleAction: vi.fn(() => unexpected<never>()),
    ...overrides,
  };
}

let observedRuntime: InvestigationRuntime | null = null;

afterEach(() => {
  cleanup();
  observedRuntime = null;
});

function RuntimeProbe({ label = "probe" }: { readonly label?: string }) {
  observedRuntime = useInvestigationRuntime();
  return <div>{label}</div>;
}

function currentRuntime(): InvestigationRuntime {
  if (observedRuntime === null) throw new Error("runtime probe has not rendered");
  return observedRuntime;
}

describe("InvestigationRuntimeProvider", () => {
  it("fails loudly when a strategy consumes the runtime outside its provider", () => {
    expect(() => render(<RuntimeProbe />)).toThrow(
      "useInvestigationRuntime must be used within InvestigationRuntimeProvider",
    );
  });

  it("stays mounted across a strategy-like child switch without refetching or mutating", async () => {
    const gateway = makeGateway();
    const common = {
      identityKey: "alice",
      authorityKey: "alice-authority-v1",
      capabilities: FULL_CAPABILITIES,
      readOnly: false,
      active: true,
      focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase,
      isInvestigationLocation: true,
      onOpenCreated: vi.fn(),
      gateway,
    } as const;
    const view = render(
      <InvestigationRuntimeProvider {...common}>
        <RuntimeProbe label="strategy one" />
      </InvestigationRuntimeProvider>,
    );

    await waitFor(() => {
      expect(currentRuntime().resources.investigations.status).toBe("ready");
      expect(currentRuntime().resources.lifecycle.status).toBe("ready");
    });
    const createCommand = currentRuntime().commands.createInvestigation;
    const uploadCommand = currentRuntime().commands.uploadEvidence;
    const lifecycleCommand = currentRuntime().commands.applyLifecycle;

    view.rerender(
      <InvestigationRuntimeProvider {...common}>
        <RuntimeProbe label="strategy two" />
      </InvestigationRuntimeProvider>,
    );

    expect(screen.getByText("strategy two")).toBeTruthy();
    expect(gateway.listInvestigations).toHaveBeenCalledTimes(1);
    expect(gateway.getInvestigation).toHaveBeenCalledTimes(1);
    expect(gateway.listEvidence).toHaveBeenCalledTimes(1);
    expect(gateway.listContributions).toHaveBeenCalledTimes(1);
    expect(gateway.getLifecycle).toHaveBeenCalledTimes(1);
    expect(gateway.createInvestigation).not.toHaveBeenCalled();
    expect(gateway.uploadEvidence).not.toHaveBeenCalled();
    expect(gateway.applyLifecycleAction).not.toHaveBeenCalled();
    expect(currentRuntime().commands.createInvestigation).toBe(createCommand);
    expect(currentRuntime().commands.uploadEvidence).toBe(uploadCommand);
    expect(currentRuntime().commands.applyLifecycle).toBe(lifecycleCommand);
  });

  it("does no transport work and exposes no commands without read authority", async () => {
    const gateway = makeGateway();
    render(
      <InvestigationRuntimeProvider
        identityKey="viewer"
        authorityKey="viewer-authority-v1"
        capabilities={["investigation:write", "run:strategies"]}
        readOnly={false}
        active
        focusCaseId={RUNTIME_FIXTURE_IDS.populatedCase}
        isInvestigationLocation
        onOpenCreated={vi.fn()}
        gateway={gateway}
      >
        <RuntimeProbe />
      </InvestigationRuntimeProvider>,
    );

    await act(async () => undefined);
    expect(currentRuntime().resources.investigations).toEqual({ status: "idle" });
    expect(currentRuntime().resources.investigation).toEqual({ status: "idle" });
    expect(currentRuntime().commands).toEqual({
      createInvestigation: null,
      uploadEvidence: null,
      applyLifecycle: null,
    });
    expect(gateway.listInvestigations).not.toHaveBeenCalled();
    expect(gateway.getInvestigation).not.toHaveBeenCalled();
    expect(gateway.listEvidence).not.toHaveBeenCalled();
    expect(gateway.listContributions).not.toHaveBeenCalled();
    expect(gateway.getLifecycle).not.toHaveBeenCalled();
  });

  it("keeps reads available but removes every mutation command in read-only mode", async () => {
    const gateway = makeGateway();
    render(
      <InvestigationRuntimeProvider
        identityKey="lead"
        authorityKey="lead-authority-v1"
        capabilities={FULL_CAPABILITIES}
        readOnly
        active
        focusCaseId={RUNTIME_FIXTURE_IDS.populatedCase}
        isInvestigationLocation
        onOpenCreated={vi.fn()}
        gateway={gateway}
      >
        <RuntimeProbe />
      </InvestigationRuntimeProvider>,
    );

    await waitFor(() => expect(currentRuntime().resources.investigation.status).toBe("ready"));
    expect(currentRuntime().capabilities).toEqual({
      canRead: true,
      canCreate: false,
      canUpload: false,
      canManageLifecycle: false,
    });
    expect(currentRuntime().commands).toEqual({
      createInvestigation: null,
      uploadEvidence: null,
      applyLifecycle: null,
    });
    expect(gateway.createInvestigation).not.toHaveBeenCalled();
    expect(gateway.uploadEvidence).not.toHaveBeenCalled();
    expect(gateway.applyLifecycleAction).not.toHaveBeenCalled();
  });

  it("removes case mutation commands when any case endpoint conceals lost access", async () => {
    let evidenceReads = 0;
    const gateway = makeGateway({
      listEvidence: vi.fn(async () => {
        evidenceReads += 1;
        return evidenceReads === 1
          ? succeeded(makeEvidenceList().artifacts)
          : { ok: false, error: { kind: "not_found", status: 404 } } as const;
      }),
    });
    render(
      <InvestigationRuntimeProvider
        identityKey="lead"
        authorityKey="lead-authority-v1"
        capabilities={FULL_CAPABILITIES}
        readOnly={false}
        active
        focusCaseId={RUNTIME_FIXTURE_IDS.populatedCase}
        isInvestigationLocation
        onOpenCreated={vi.fn()}
        gateway={gateway}
      >
        <RuntimeProbe />
      </InvestigationRuntimeProvider>,
    );
    await waitFor(() => expect(currentRuntime().resources.lifecycle.status).toBe("ready"));
    expect(currentRuntime().commands.uploadEvidence).not.toBeNull();
    expect(currentRuntime().commands.applyLifecycle).not.toBeNull();

    act(() => currentRuntime().refresh.evidence());
    await waitFor(() => expect(currentRuntime().resources.investigation.status).toBe("failed"));
    expect(currentRuntime().resources.investigation).toEqual({
      status: "failed",
      error: { kind: "not_found", status: 404 },
    });
    expect(currentRuntime().resources.lifecycle).toEqual({
      status: "failed",
      error: { kind: "not_found", status: 404 },
    });
    expect(currentRuntime().commands.uploadEvidence).toBeNull();
    expect(currentRuntime().commands.applyLifecycle).toBeNull();
  });

  it("denies the active scope when an authoritative collection no longer includes it", async () => {
    let listReads = 0;
    const gateway = makeGateway({
      listInvestigations: vi.fn(async () => {
        listReads += 1;
        return succeeded(listReads === 1 ? makeCaseList().cases : []);
      }),
    });
    render(
      <InvestigationRuntimeProvider
        identityKey="lead"
        authorityKey="lead-authority-v1"
        capabilities={FULL_CAPABILITIES}
        readOnly={false}
        active
        focusCaseId={RUNTIME_FIXTURE_IDS.populatedCase}
        isInvestigationLocation
        onOpenCreated={vi.fn()}
        gateway={gateway}
      >
        <RuntimeProbe />
      </InvestigationRuntimeProvider>,
    );
    await waitFor(() => expect(currentRuntime().resources.lifecycle.status).toBe("ready"));

    act(() => currentRuntime().refresh.investigations());
    await waitFor(() => expect(currentRuntime().resources.investigation.status).toBe("failed"));
    expect(currentRuntime().resources.investigation).toEqual({
      status: "failed",
      error: { kind: "not_found", status: 404 },
    });
    expect(currentRuntime().resources.evidence).toEqual({
      status: "failed",
      error: { kind: "not_found", status: 404 },
    });
    expect(currentRuntime().commands.uploadEvidence).toBeNull();
    expect(currentRuntime().commands.applyLifecycle).toBeNull();
  });

  it("refreshes a settled list before inferring that a newly focused investigation is absent", async () => {
    const created: CaseV1 = {
      ...makeSparseImportedCase(),
      id: "case-created-outside-runtime",
      title: "Created by the reference presentation",
    };
    const refreshedList = createDeferred<GatewayResult<readonly CaseV1[]>>();
    let listReads = 0;
    const gateway = makeGateway({
      listInvestigations: vi.fn(() => {
        listReads += 1;
        return listReads === 1
          ? Promise.resolve(succeeded(makeCaseList().cases))
          : refreshedList.promise;
      }),
      getInvestigation: vi.fn(async () => succeeded(created)),
      listEvidence: vi.fn(async () => succeeded([])),
      listContributions: vi.fn(async () => succeeded([])),
      getLifecycle: vi.fn(async () => succeeded({
        ...makeArchiveAllowedLifecycle(),
        investigationId: created.id,
      })),
    });
    const common = {
      identityKey: "lead",
      authorityKey: "lead-authority-v1",
      capabilities: FULL_CAPABILITIES,
      readOnly: false,
      active: true,
      isInvestigationLocation: true,
      onOpenCreated: vi.fn(),
      gateway,
    } as const;
    const view = render(
      <InvestigationRuntimeProvider {...common} focusCaseId={null}>
        <RuntimeProbe />
      </InvestigationRuntimeProvider>,
    );
    await waitFor(() => expect(currentRuntime().resources.investigations.status).toBe("ready"));

    view.rerender(
      <InvestigationRuntimeProvider {...common} focusCaseId={created.id}>
        <RuntimeProbe />
      </InvestigationRuntimeProvider>,
    );
    await waitFor(() => expect(gateway.listInvestigations).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(currentRuntime().resources.lifecycle.status).toBe("ready"));
    expect(currentRuntime().resources.investigation).toEqual({ status: "ready", value: created });
    expect(currentRuntime().commands.applyLifecycle).not.toBeNull();

    await act(async () => {
      refreshedList.resolve(succeeded([created, ...makeCaseList().cases]));
    });
    expect(currentRuntime().resources.investigation).toEqual({ status: "ready", value: created });
    expect(currentRuntime().resources.lifecycle.status).toBe("ready");
  });

  it("does not infer absence when the post-focus collection refresh fails", async () => {
    const created: CaseV1 = {
      ...makeSparseImportedCase(),
      id: "case-focused-during-list-failure",
    };
    let listReads = 0;
    const gateway = makeGateway({
      listInvestigations: vi.fn(async () => {
        listReads += 1;
        return listReads === 1
          ? succeeded(makeCaseList().cases)
          : listReads === 2
            ? { ok: false, error: { kind: "network" } } as const
            : succeeded([created, ...makeCaseList().cases]);
      }),
      getInvestigation: vi.fn(async () => succeeded(created)),
      listEvidence: vi.fn(async () => succeeded([])),
      listContributions: vi.fn(async () => succeeded([])),
      getLifecycle: vi.fn(async () => succeeded({
        ...makeArchiveAllowedLifecycle(),
        investigationId: created.id,
      })),
    });
    const common = {
      identityKey: "lead",
      authorityKey: "lead-authority-v1",
      capabilities: FULL_CAPABILITIES,
      readOnly: false,
      active: true,
      isInvestigationLocation: true,
      onOpenCreated: vi.fn(),
      gateway,
    } as const;
    const view = render(
      <InvestigationRuntimeProvider {...common} focusCaseId={null}>
        <RuntimeProbe />
      </InvestigationRuntimeProvider>,
    );
    await waitFor(() => expect(currentRuntime().resources.investigations.status).toBe("ready"));

    view.rerender(
      <InvestigationRuntimeProvider {...common} focusCaseId={created.id}>
        <RuntimeProbe />
      </InvestigationRuntimeProvider>,
    );
    await waitFor(() => expect(currentRuntime().resources.investigations.status).toBe("failed"));
    await waitFor(() => expect(currentRuntime().resources.lifecycle.status).toBe("ready"));
    expect(currentRuntime().resources.investigation).toEqual({ status: "ready", value: created });
    expect(currentRuntime().commands.applyLifecycle).not.toBeNull();

    act(() => currentRuntime().refresh.investigations());
    await waitFor(() => expect(currentRuntime().resources.investigations.status).toBe("ready"));
    expect(currentRuntime().resources.investigation).toEqual({ status: "ready", value: created });
    expect(currentRuntime().resources.lifecycle.status).toBe("ready");
  });

  it("atomically clears the active scope when an upload mutation proves lost access", async () => {
    const gateway = makeGateway({
      uploadEvidence: vi.fn(async () => ({
        ok: false,
        error: { kind: "not_found", status: 404 },
      } as const)),
    });
    render(
      <InvestigationRuntimeProvider
        identityKey="lead"
        authorityKey="lead-authority-v1"
        capabilities={FULL_CAPABILITIES}
        readOnly={false}
        active
        focusCaseId={RUNTIME_FIXTURE_IDS.populatedCase}
        isInvestigationLocation
        onOpenCreated={vi.fn()}
        gateway={gateway}
      >
        <RuntimeProbe />
      </InvestigationRuntimeProvider>,
    );
    await waitFor(() => expect(currentRuntime().resources.lifecycle.status).toBe("ready"));

    await act(async () => {
      await currentRuntime().commands.uploadEvidence?.({
        file: new Blob(["revoked"]),
        summary: "Access changed",
      });
    });

    const denied = { status: "failed", error: { kind: "not_found", status: 404 } };
    expect(currentRuntime().resources.investigation).toEqual(denied);
    expect(currentRuntime().resources.evidence).toEqual(denied);
    expect(currentRuntime().resources.contributions).toEqual(denied);
    expect(currentRuntime().resources.lifecycle).toEqual(denied);
    expect(currentRuntime().commands.uploadEvidence).toBeNull();
    expect(currentRuntime().commands.applyLifecycle).toBeNull();
  });

  it("publishes a created investigation into the collection and opens only its server identity", async () => {
    const created: CaseV1 = {
      ...makeSparseImportedCase(),
      id: "case-server-confirmed",
      title: "Server confirmed investigation",
    };
    const onOpenCreated = vi.fn();
    const initialList = createDeferred<GatewayResult<readonly CaseV1[]>>();
    const listSignals: AbortSignal[] = [];
    let listCalls = 0;
    const gateway = makeGateway({
      createInvestigation: vi.fn(async () => succeeded(created)),
      listInvestigations: vi.fn(({ signal }) => {
        listSignals.push(signal);
        listCalls += 1;
        return listCalls === 1
          ? initialList.promise
          : Promise.resolve(succeeded([created, ...makeCaseList().cases]));
      }),
    });
    render(
      <InvestigationRuntimeProvider
        identityKey="lead"
        authorityKey="lead-authority-v1"
        capabilities={FULL_CAPABILITIES}
        readOnly={false}
        active
        focusCaseId={null}
        isInvestigationLocation
        onOpenCreated={onOpenCreated}
        gateway={gateway}
      >
        <RuntimeProbe />
      </InvestigationRuntimeProvider>,
    );
    await waitFor(() => expect(gateway.listInvestigations).toHaveBeenCalledTimes(1));
    expect(currentRuntime().resources.investigations.status).toBe("loading");

    const command = currentRuntime().commands.createInvestigation;
    expect(command).not.toBeNull();
    await act(async () => {
      await command?.({ title: "  Server confirmed investigation  " });
    });

    await waitFor(() => expect(currentRuntime().resources.investigations.status).toBe("ready"));
    expect(onOpenCreated).toHaveBeenCalledWith(created.id);
    expect(currentRuntime().resources.investigations).toEqual({
      status: "ready",
      value: [created, ...makeCaseList().cases],
    });
    expect(currentRuntime().mutations.create).toEqual({ status: "succeeded", value: created });
    expect(gateway.listInvestigations).toHaveBeenCalledTimes(2);
    expect(listSignals[0]!.aborted).toBe(true);
  });

  it("publishes an upload before refreshing the active evidence and collection lanes", async () => {
    const upload = makeEvidenceUploadSuccess();
    const evidenceRefresh = createDeferred<GatewayResult<readonly typeof upload.artifact[]>>();
    const contributionRefresh = createDeferred<GatewayResult<readonly typeof upload.summary[]>>();
    const listRefresh = createDeferred<GatewayResult<readonly CaseV1[]>>();
    let evidenceCalls = 0;
    let contributionCalls = 0;
    let listCalls = 0;
    const gateway = makeGateway({
      listInvestigations: vi.fn(() => {
        listCalls += 1;
        return listCalls === 1
          ? Promise.resolve(succeeded(makeCaseList().cases))
          : listRefresh.promise;
      }),
      listEvidence: vi.fn(() => {
        evidenceCalls += 1;
        return evidenceCalls === 1
          ? Promise.resolve(succeeded([]))
          : evidenceRefresh.promise;
      }),
      listContributions: vi.fn(() => {
        contributionCalls += 1;
        return contributionCalls === 1
          ? Promise.resolve(succeeded([]))
          : contributionRefresh.promise;
      }),
      uploadEvidence: vi.fn(async () => succeeded(upload)),
    });
    render(
      <InvestigationRuntimeProvider
        identityKey="lead"
        authorityKey="lead-authority-v1"
        capabilities={FULL_CAPABILITIES}
        readOnly={false}
        active
        focusCaseId={RUNTIME_FIXTURE_IDS.populatedCase}
        isInvestigationLocation
        onOpenCreated={vi.fn()}
        gateway={gateway}
      >
        <RuntimeProbe />
      </InvestigationRuntimeProvider>,
    );
    await waitFor(() => expect(currentRuntime().resources.evidence.status).toBe("ready"));

    await act(async () => {
      await currentRuntime().commands.uploadEvidence?.({
        file: new Blob(["x"], { type: "text/plain" }),
        summary: upload.summary.body ?? "Uploaded evidence summary",
      });
    });

    expect(currentRuntime().resources.evidence).toEqual({
      status: "loading",
      previous: [upload.artifact],
    });
    expect(currentRuntime().resources.contributions).toEqual({
      status: "loading",
      previous: [upload.summary],
    });
    expect(currentRuntime().resources.investigations.status).toBe("loading");
    expect(currentRuntime().mutations.uploadEvidence).toEqual({
      status: "succeeded",
      value: upload,
    });
    expect(gateway.listEvidence).toHaveBeenCalledTimes(2);
    expect(gateway.listContributions).toHaveBeenCalledTimes(2);
    expect(gateway.listInvestigations).toHaveBeenCalledTimes(2);
  });

  it("publishes lifecycle success and changed-state authority into the right lanes", async () => {
    const archivedCase: CaseV1 = { ...makePopulatedCase(), status: "archived" };
    const success: InvestigationLifecycleActionSuccessV1 = {
      schemaId: INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID,
      investigationId: archivedCase.id,
      action: "archive",
      previousStatus: "monitoring",
      appliedStatus: "archived",
      case: archivedCase,
    };
    const caseRefresh = createDeferred<GatewayResult<CaseV1>>();
    const listRefresh = createDeferred<GatewayResult<readonly CaseV1[]>>();
    const lifecycleRefresh = createDeferred<GatewayResult<ReturnType<typeof makeArchiveAllowedLifecycle>>>();
    let caseCalls = 0;
    let listCalls = 0;
    let lifecycleCalls = 0;
    const gateway = makeGateway({
      getInvestigation: vi.fn(() => {
        caseCalls += 1;
        return caseCalls === 1
          ? Promise.resolve(succeeded(makePopulatedCase()))
          : caseRefresh.promise;
      }),
      listInvestigations: vi.fn(() => {
        listCalls += 1;
        return listCalls === 1
          ? Promise.resolve(succeeded(makeCaseList().cases))
          : listRefresh.promise;
      }),
      getLifecycle: vi.fn(() => {
        lifecycleCalls += 1;
        return lifecycleCalls === 1
          ? Promise.resolve(succeeded(makeArchiveAllowedLifecycle()))
          : lifecycleRefresh.promise;
      }),
      applyLifecycleAction: vi.fn(async () => succeeded(success)),
    });
    const view = render(
      <InvestigationRuntimeProvider
        identityKey="lead"
        authorityKey="lead-authority-v1"
        capabilities={FULL_CAPABILITIES}
        readOnly={false}
        active
        focusCaseId={RUNTIME_FIXTURE_IDS.populatedCase}
        isInvestigationLocation
        onOpenCreated={vi.fn()}
        gateway={gateway}
      >
        <RuntimeProbe />
      </InvestigationRuntimeProvider>,
    );
    await waitFor(() => expect(currentRuntime().resources.lifecycle.status).toBe("ready"));

    await act(async () => {
      await currentRuntime().commands.applyLifecycle?.("archive");
    });

    expect(currentRuntime().resources.investigation).toEqual({
      status: "loading",
      previous: archivedCase,
    });
    expect(currentRuntime().resources.investigations).toMatchObject({
      status: "loading",
      previous: expect.arrayContaining([archivedCase]),
    });
    expect(currentRuntime().resources.lifecycle).toEqual({
      status: "loading",
      previous: makeArchiveAllowedLifecycle(),
    });
    expect(currentRuntime().commands.applyLifecycle).toBeNull();

    const changed = makeArchiveRefusedLifecycle();
    const changedGateway = makeGateway({
      applyLifecycleAction: vi.fn(async () => ({
        ok: false,
        error: {
          kind: "lifecycle_changed",
          status: 409,
          investigationId: changed.investigationId,
          action: "archive",
          current: changed,
        },
      } as const)),
    });
    view.rerender(
      <InvestigationRuntimeProvider
        identityKey="lead-2"
        authorityKey="lead-2-authority-v1"
        capabilities={FULL_CAPABILITIES}
        readOnly={false}
        active
        focusCaseId={RUNTIME_FIXTURE_IDS.populatedCase}
        isInvestigationLocation
        onOpenCreated={vi.fn()}
        gateway={changedGateway}
      >
        <RuntimeProbe />
      </InvestigationRuntimeProvider>,
    );
    await waitFor(() => expect(currentRuntime().resources.lifecycle.status).toBe("ready"));
    await act(async () => {
      await currentRuntime().commands.applyLifecycle?.("archive");
    });
    expect(currentRuntime().resources.lifecycle).toEqual({ status: "ready", value: changed });
  });

  it("fences identity and case changes while retaining the list outside investigation routes", async () => {
    const caseRequests: Array<{ id: string; signal: AbortSignal }> = [];
    const gateway = makeGateway({
      getInvestigation: vi.fn((id, { signal }) => {
        caseRequests.push({ id, signal });
        return new Promise<GatewayResult<CaseV1>>(() => undefined);
      }),
    });
    function Harness() {
      const [identityKey, setIdentityKey] = useState("lead");
      const [authorityKey, setAuthorityKey] = useState("lead-authority-v1");
      const [caseId, setCaseId] = useState<string | null>(RUNTIME_FIXTURE_IDS.populatedCase);
      const [active, setActive] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setCaseId(RUNTIME_FIXTURE_IDS.sparseCase)}>
            change case
          </button>
          <button type="button" onClick={() => setIdentityKey("other-lead")}>
            change identity
          </button>
          <button type="button" onClick={() => setAuthorityKey("lead-authority-v2")}>
            change authority
          </button>
          <button type="button" onClick={() => setActive(false)}>leave</button>
          <InvestigationRuntimeProvider
            identityKey={identityKey}
            authorityKey={authorityKey}
            capabilities={FULL_CAPABILITIES}
            readOnly={false}
            active={active}
            focusCaseId={caseId}
            isInvestigationLocation={active}
            onOpenCreated={vi.fn()}
            gateway={gateway}
          >
            <RuntimeProbe />
          </InvestigationRuntimeProvider>
        </>
      );
    }
    render(<Harness />);
    await waitFor(() => expect(caseRequests).toHaveLength(1));

    act(() => screen.getByRole("button", { name: "change case" }).click());
    await waitFor(() => expect(caseRequests).toHaveLength(2));
    expect(caseRequests[0]!.signal.aborted).toBe(true);
    expect(caseRequests[1]!.id).toBe(RUNTIME_FIXTURE_IDS.sparseCase);

    act(() => screen.getByRole("button", { name: "change authority" }).click());
    await waitFor(() => expect(caseRequests).toHaveLength(3));
    expect(caseRequests[1]!.signal.aborted).toBe(true);
    expect(caseRequests[2]!.id).toBe(RUNTIME_FIXTURE_IDS.sparseCase);
    expect(currentRuntime().resources.investigation).toEqual({ status: "loading" });

    act(() => screen.getByRole("button", { name: "change identity" }).click());
    await waitFor(() => expect(caseRequests).toHaveLength(4));
    expect(caseRequests[2]!.signal.aborted).toBe(true);
    expect(caseRequests[3]!.id).toBe(RUNTIME_FIXTURE_IDS.sparseCase);
    expect(currentRuntime().resources.investigation).toEqual({ status: "loading" });

    act(() => screen.getByRole("button", { name: "leave" }).click());
    expect(caseRequests[3]!.signal.aborted).toBe(true);
    expect(currentRuntime().resources.investigation).toEqual({ status: "idle" });
    expect(currentRuntime().commands).toEqual({
      createInvestigation: null,
      uploadEvidence: null,
      applyLifecycle: null,
    });
    await waitFor(() => expect(currentRuntime().resources.investigations.status).toBe("ready"));
    // One initial read, one freshness read for the case transition, and one
    // newly scoped read for each authority/identity transition.
    expect(gateway.listInvestigations).toHaveBeenCalledTimes(4);
  });
});
