import {
  INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID,
  type CaseV1,
  type ContributionV1,
  type InvestigationLifecycleActionSuccessV1,
} from "@cd-collab/contracts/investigation-runtime";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayResult, InvestigationGateway } from "./gateway.js";
import {
  InvestigationRuntimeGatewayHarness,
  InvestigationRuntimeProvider,
  type InvestigationRuntime,
  type InvestigationRuntimeIdentity,
  type InvestigationRuntimeProviderProps,
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
import { createDeferred, type Deferred } from "./testkit/promises.js";

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
    createContribution: vi.fn(() => unexpected<ContributionV1>()),
    updateSituation: vi.fn(() => unexpected<CaseV1>()),
    getLifecycle: vi.fn(async () => succeeded(makeArchiveAllowedLifecycle())),
    applyLifecycleAction: vi.fn(() => unexpected<never>()),
    ...overrides,
  };
}

/**
 * Runtime V1 offers strategies no transport prop, so every mount pairs the
 * public provider with the internal harness that supplies its gateway.
 */
function ProviderUnderTest({
  gateway,
  ...props
}: InvestigationRuntimeProviderProps & { readonly gateway: InvestigationGateway }) {
  return (
    <InvestigationRuntimeGatewayHarness gateway={gateway}>
      <InvestigationRuntimeProvider {...props} />
    </InvestigationRuntimeGatewayHarness>
  );
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
      <ProviderUnderTest {...common}>
        <RuntimeProbe label="strategy one" />
      </ProviderUnderTest>,
    );

    await waitFor(() => {
      expect(currentRuntime().resources.investigations.status).toBe("ready");
      expect(currentRuntime().resources.lifecycle.status).toBe("ready");
    });
    const createCommand = currentRuntime().commands.createInvestigation;
    const uploadCommand = currentRuntime().commands.uploadEvidence;
    const lifecycleCommand = currentRuntime().commands.applyLifecycle;

    view.rerender(
      <ProviderUnderTest {...common}>
        <RuntimeProbe label="strategy two" />
      </ProviderUnderTest>,
    );

    expect(screen.getByText("strategy two")).toBeTruthy();
    expect(gateway.listInvestigations).toHaveBeenCalledTimes(1);
    expect(gateway.getInvestigation).toHaveBeenCalledTimes(1);
    expect(gateway.listEvidence).toHaveBeenCalledTimes(1);
    expect(gateway.listContributions).toHaveBeenCalledTimes(1);
    expect(gateway.getLifecycle).toHaveBeenCalledTimes(1);
    expect(gateway.createInvestigation).not.toHaveBeenCalled();
    expect(gateway.uploadEvidence).not.toHaveBeenCalled();
    expect(gateway.createContribution).not.toHaveBeenCalled();
    expect(gateway.updateSituation).not.toHaveBeenCalled();
    expect(gateway.applyLifecycleAction).not.toHaveBeenCalled();
    expect(currentRuntime().commands.createInvestigation).toBe(createCommand);
    expect(currentRuntime().commands.uploadEvidence).toBe(uploadCommand);
    expect(currentRuntime().commands.applyLifecycle).toBe(lifecycleCommand);
  });

  it("deep-freezes shared runtime DTOs so one strategy cannot contaminate the next", async () => {
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
      <ProviderUnderTest {...common}>
        <RuntimeProbe label="strategy one" />
      </ProviderUnderTest>,
    );
    await waitFor(() => expect(currentRuntime().resources.investigation.status).toBe("ready"));

    const firstRuntime = currentRuntime();
    expect(Object.isFrozen(firstRuntime)).toBe(true);
    expect(Object.isFrozen(firstRuntime.resources)).toBe(true);
    expect(Object.isFrozen(firstRuntime.refresh)).toBe(true);
    expect(Object.isFrozen(firstRuntime.commands)).toBe(true);
    expect(Object.isFrozen(firstRuntime.refresh.investigations)).toBe(true);
    expect(Object.isFrozen(firstRuntime.refresh.activeInvestigation)).toBe(true);
    expect(Object.isFrozen(firstRuntime.commands.uploadEvidence)).toBe(true);
    expect(Object.isFrozen(firstRuntime.commands.applyLifecycle)).toBe(true);
    if (firstRuntime.resources.investigation.status !== "ready") {
      throw new Error("expected a ready investigation");
    }
    const investigation = firstRuntime.resources.investigation.value;
    expect(Object.isFrozen(investigation)).toBe(true);
    expect(Object.isFrozen(investigation.openQuestions)).toBe(true);
    expect(Object.isFrozen(investigation.investigationContext)).toBe(true);
    const investigations = firstRuntime.resources.investigations;
    const evidence = firstRuntime.resources.evidence;
    const contributions = firstRuntime.resources.contributions;
    const lifecycle = firstRuntime.resources.lifecycle;
    expect(investigations.status).toBe("ready");
    expect(evidence.status).toBe("ready");
    expect(contributions.status).toBe("ready");
    expect(lifecycle.status).toBe("ready");
    if (investigations.status === "ready") {
      expect(Object.isFrozen(investigations.value)).toBe(true);
      expect(Object.isFrozen(investigations.value[0])).toBe(true);
      expect(() => {
        (investigations.value as CaseV1[]).push(makeSparseImportedCase());
      }).toThrow();
    }
    if (evidence.status === "ready") {
      expect(Object.isFrozen(evidence.value)).toBe(true);
      expect(Object.isFrozen(evidence.value[0])).toBe(true);
      expect(() => {
        (evidence.value[0] as { filename: string | null }).filename = "contaminated.log";
      }).toThrow();
    }
    if (contributions.status === "ready") {
      expect(Object.isFrozen(contributions.value)).toBe(true);
      expect(Object.isFrozen(contributions.value[0])).toBe(true);
      expect(() => {
        (contributions.value[0] as { body: string | null }).body = "contaminated";
      }).toThrow();
    }
    if (lifecycle.status === "ready") {
      expect(Object.isFrozen(lifecycle.value.archive)).toBe(true);
      expect(Object.isFrozen(lifecycle.value.restore)).toBe(true);
      expect(Object.isFrozen(lifecycle.value.deletion.alternatives)).toBe(true);
      expect(() => {
        (lifecycle.value.deletion.alternatives as string[]).push("delete");
      }).toThrow();
    }
    expect(() => {
      (investigation.openQuestions as string[]).push("Injected by strategy one");
    }).toThrow();
    expect(() => {
      (firstRuntime.capabilities as { canRead: boolean }).canRead = false;
    }).toThrow();

    view.rerender(
      <ProviderUnderTest {...common}>
        <RuntimeProbe label="strategy two" />
      </ProviderUnderTest>,
    );
    expect(screen.getByText("strategy two")).toBeTruthy();
    const second = currentRuntime().resources.investigation;
    expect(second.status).toBe("ready");
    if (second.status === "ready") {
      expect(second.value.openQuestions).not.toContain("Injected by strategy one");
    }
  });

  it("exposes create only at the null-focus investigations origin", async () => {
    const gateway = makeGateway();
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
      <ProviderUnderTest {...common} focusCaseId={null}>
        <RuntimeProbe />
      </ProviderUnderTest>,
    );
    expect(currentRuntime().commands.createInvestigation).not.toBeNull();

    view.rerender(
      <ProviderUnderTest
        {...common}
        focusCaseId={RUNTIME_FIXTURE_IDS.populatedCase}
      >
        <RuntimeProbe />
      </ProviderUnderTest>,
    );
    expect(currentRuntime().commands.createInvestigation).toBeNull();
  });

  it("does no transport work and exposes no commands without read authority", async () => {
    const gateway = makeGateway();
    render(
      <ProviderUnderTest
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
      </ProviderUnderTest>,
    );

    await act(async () => undefined);
    expect(currentRuntime().resources.investigations).toEqual({ status: "idle" });
    expect(currentRuntime().resources.investigation).toEqual({ status: "idle" });
    expect(currentRuntime().commands).toEqual({
      createInvestigation: null,
      uploadEvidence: null,
      createContribution: null,
      updateSituation: null,
      applyLifecycle: null,
    });
    expect(gateway.listInvestigations).not.toHaveBeenCalled();
    expect(gateway.getInvestigation).not.toHaveBeenCalled();
    expect(gateway.listEvidence).not.toHaveBeenCalled();
    expect(gateway.listContributions).not.toHaveBeenCalled();
    expect(gateway.getLifecycle).not.toHaveBeenCalled();
    expect(gateway.createInvestigation).not.toHaveBeenCalled();
    expect(gateway.uploadEvidence).not.toHaveBeenCalled();
    expect(gateway.createContribution).not.toHaveBeenCalled();
    expect(gateway.updateSituation).not.toHaveBeenCalled();
    expect(gateway.applyLifecycleAction).not.toHaveBeenCalled();
  });

  it("keeps reads available but removes every mutation command in read-only mode", async () => {
    const gateway = makeGateway();
    render(
      <ProviderUnderTest
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
      </ProviderUnderTest>,
    );

    await waitFor(() => expect(currentRuntime().resources.investigation.status).toBe("ready"));
    expect(currentRuntime().capabilities).toEqual({
      canRead: true,
      canCreate: false,
      canUpload: false,
      canContribute: false,
      canEditSituation: false,
      canManageLifecycle: false,
    });
    expect(currentRuntime().commands).toEqual({
      createInvestigation: null,
      uploadEvidence: null,
      createContribution: null,
      updateSituation: null,
      applyLifecycle: null,
    });
    expect(gateway.createInvestigation).not.toHaveBeenCalled();
    expect(gateway.uploadEvidence).not.toHaveBeenCalled();
    expect(gateway.createContribution).not.toHaveBeenCalled();
    expect(gateway.updateSituation).not.toHaveBeenCalled();
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
      <ProviderUnderTest
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
      </ProviderUnderTest>,
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
      <ProviderUnderTest
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
      </ProviderUnderTest>,
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
      <ProviderUnderTest {...common} focusCaseId={null}>
        <RuntimeProbe />
      </ProviderUnderTest>,
    );
    await waitFor(() => expect(currentRuntime().resources.investigations.status).toBe("ready"));

    view.rerender(
      <ProviderUnderTest {...common} focusCaseId={created.id}>
        <RuntimeProbe />
      </ProviderUnderTest>,
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
      <ProviderUnderTest {...common} focusCaseId={null}>
        <RuntimeProbe />
      </ProviderUnderTest>,
    );
    await waitFor(() => expect(currentRuntime().resources.investigations.status).toBe("ready"));

    view.rerender(
      <ProviderUnderTest {...common} focusCaseId={created.id}>
        <RuntimeProbe />
      </ProviderUnderTest>,
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
      <ProviderUnderTest
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
      </ProviderUnderTest>,
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
      <ProviderUnderTest
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
      </ProviderUnderTest>,
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
      <ProviderUnderTest
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
      </ProviderUnderTest>,
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
    const uploadMutation = currentRuntime().mutations.uploadEvidence;
    if (uploadMutation.status === "succeeded") {
      expect(Object.isFrozen(uploadMutation.value)).toBe(true);
      expect(Object.isFrozen(uploadMutation.value.artifact)).toBe(true);
      expect(Object.isFrozen(uploadMutation.value.summary)).toBe(true);
      expect(() => {
        (uploadMutation.value.summary as { body: string | null }).body = "contaminated";
      }).toThrow();
    }
    expect(gateway.listEvidence).toHaveBeenCalledTimes(2);
    expect(gateway.listContributions).toHaveBeenCalledTimes(2);
    expect(gateway.listInvestigations).toHaveBeenCalledTimes(2);
  });

  it("publishes a contribution before refreshing only the active contribution lane", async () => {
    const written = makeContributionList().contributions[1];
    if (written === undefined) throw new Error("expected a seeded contribution");
    const created = { ...written, id: "contribution-newly-written" };
    const contributionRefresh = createDeferred<GatewayResult<readonly ContributionV1[]>>();
    let contributionCalls = 0;
    const gateway = makeGateway({
      listContributions: vi.fn(() => {
        contributionCalls += 1;
        return contributionCalls === 1
          ? Promise.resolve(succeeded([]))
          : contributionRefresh.promise;
      }),
      createContribution: vi.fn(async () => succeeded(created)),
    });
    render(
      <ProviderUnderTest
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
      </ProviderUnderTest>,
    );
    await waitFor(() => expect(currentRuntime().resources.investigation.status).toBe("ready"));

    await act(async () => {
      await currentRuntime().commands.createContribution?.({
        kind: "hypothesis",
        body: "Queue time rises after the rollout.",
        hypothesisLinks: [{ kind: "artifact", id: RUNTIME_FIXTURE_IDS.evidence }],
        idempotencyKey: "hypothesis-ui-20260830-003",
      });
    });

    expect(gateway.createContribution).toHaveBeenCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      {
        kind: "hypothesis",
        body: "Queue time rises after the rollout.",
        hypothesisLinks: [{ kind: "artifact", id: RUNTIME_FIXTURE_IDS.evidence }],
        idempotencyKey: "hypothesis-ui-20260830-003",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(currentRuntime().resources.contributions).toEqual({
      status: "loading",
      previous: [created],
    });
    expect(currentRuntime().mutations.createContribution).toEqual({
      status: "succeeded",
      value: created,
    });
    const mutation = currentRuntime().mutations.createContribution;
    if (mutation.status === "succeeded") {
      expect(Object.isFrozen(mutation.value)).toBe(true);
      expect(() => {
        (mutation.value as { body: string | null }).body = "contaminated";
      }).toThrow();
    }
    expect(gateway.listContributions).toHaveBeenCalledTimes(2);
    // A contribution is not evidence and does not change the collection.
    expect(gateway.listEvidence).toHaveBeenCalledTimes(1);
    expect(gateway.listInvestigations).toHaveBeenCalledTimes(1);
  });

  it("publishes a situation revision into the case and collection lanes", async () => {
    const current = makePopulatedCase();
    const revised: CaseV1 = {
      ...current,
      impact: "Checkouts now fail before payment confirmation.",
      situationVersion: current.situationVersion + 1,
    };
    const investigationRefresh = createDeferred<GatewayResult<CaseV1>>();
    const listRefresh = createDeferred<GatewayResult<readonly CaseV1[]>>();
    let investigationCalls = 0;
    let listCalls = 0;
    const gateway = makeGateway({
      listInvestigations: vi.fn(() => {
        listCalls += 1;
        return listCalls === 1
          ? Promise.resolve(succeeded(makeCaseList().cases))
          : listRefresh.promise;
      }),
      getInvestigation: vi.fn(() => {
        investigationCalls += 1;
        return investigationCalls === 1
          ? Promise.resolve(succeeded(current))
          : investigationRefresh.promise;
      }),
      updateSituation: vi.fn(async () => succeeded(revised)),
    });
    render(
      <ProviderUnderTest
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
      </ProviderUnderTest>,
    );
    await waitFor(() => expect(currentRuntime().resources.investigation.status).toBe("ready"));

    await act(async () => {
      await currentRuntime().commands.updateSituation?.({
        impact: "Checkouts now fail before payment confirmation.",
      });
    });

    expect(gateway.updateSituation).toHaveBeenCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      {
        impact: "Checkouts now fail before payment confirmation.",
        expectedVersion: current.situationVersion,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(currentRuntime().resources.investigation).toEqual({
      status: "loading",
      previous: revised,
    });
    expect(currentRuntime().resources.investigations.status).toBe("loading");
    expect(currentRuntime().mutations.updateSituation).toEqual({
      status: "succeeded",
      value: revised,
    });
    expect(gateway.getInvestigation).toHaveBeenCalledTimes(2);
    expect(gateway.listInvestigations).toHaveBeenCalledTimes(2);
  });

  it("re-reads rather than resending after a situation version conflict", async () => {
    const current = makePopulatedCase();
    const advanced: CaseV1 = { ...current, situationVersion: current.situationVersion + 3 };
    let investigationCalls = 0;
    const gateway = makeGateway({
      getInvestigation: vi.fn(async () => {
        investigationCalls += 1;
        return succeeded(investigationCalls === 1 ? current : advanced);
      }),
      updateSituation: vi.fn(async (): Promise<GatewayResult<CaseV1>> => ({
        ok: false,
        error: { kind: "conflict", status: 409 },
      })),
    });
    render(
      <ProviderUnderTest
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
      </ProviderUnderTest>,
    );
    await waitFor(() => expect(currentRuntime().resources.investigation.status).toBe("ready"));

    await act(async () => {
      await expect(currentRuntime().commands.updateSituation?.({ impact: "x" }))
        .resolves.toEqual({ status: "failed", error: { kind: "conflict", status: 409 } });
    });
    await waitFor(() => expect(currentRuntime().resources.investigation).toEqual({
      status: "ready",
      value: advanced,
    }));

    expect(gateway.updateSituation).toHaveBeenCalledTimes(1);
    expect(gateway.listInvestigations).toHaveBeenCalledTimes(2);
    expect(currentRuntime().mutations.updateSituation).toEqual({
      status: "failed",
      error: { kind: "conflict", status: 409 },
    });

    // The next attempt uses the version the server actually holds.
    await act(async () => {
      await currentRuntime().commands.updateSituation?.({ impact: "y" });
    });
    expect(gateway.updateSituation).toHaveBeenLastCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { impact: "y", expectedVersion: advanced.situationVersion },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("atomically clears the active scope when a contribution proves lost access", async () => {
    const gateway = makeGateway({
      createContribution: vi.fn(async (): Promise<GatewayResult<ContributionV1>> => ({
        ok: false,
        error: { kind: "auth_lost", status: 403 },
      })),
    });
    render(
      <ProviderUnderTest
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
      </ProviderUnderTest>,
    );
    await waitFor(() => expect(currentRuntime().resources.investigation.status).toBe("ready"));

    await act(async () => {
      await expect(currentRuntime().commands.createContribution?.({
        kind: "note",
        body: "x",
      })).resolves.toEqual({ status: "failed", error: { kind: "auth_lost", status: 403 } });
    });

    const denied = { status: "failed", error: { kind: "auth_lost", status: 403 } };
    expect(currentRuntime().resources.investigation).toEqual(denied);
    expect(currentRuntime().resources.contributions).toEqual(denied);
    expect(currentRuntime().resources.evidence).toEqual(denied);
    expect(currentRuntime().resources.lifecycle).toEqual(denied);
    expect(currentRuntime().commands.createContribution).toBeNull();
    expect(currentRuntime().commands.updateSituation).toBeNull();
    expect(currentRuntime().commands.uploadEvidence).toBeNull();
    expect(currentRuntime().commands.applyLifecycle).toBeNull();
  });

  it("offers neither write seam before the active case has been read", async () => {
    const investigation = createDeferred<GatewayResult<CaseV1>>();
    const gateway = makeGateway({ getInvestigation: vi.fn(() => investigation.promise) });
    render(
      <ProviderUnderTest
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
      </ProviderUnderTest>,
    );

    await waitFor(() => expect(currentRuntime().resources.investigation.status).toBe("loading"));
    expect(currentRuntime().commands.createContribution).toBeNull();
    expect(currentRuntime().commands.updateSituation).toBeNull();

    await act(async () => {
      investigation.resolve(succeeded(makePopulatedCase()));
    });
    await waitFor(() => expect(currentRuntime().resources.investigation.status).toBe("ready"));
    expect(currentRuntime().commands.createContribution).not.toBeNull();
    expect(currentRuntime().commands.updateSituation).not.toBeNull();
    expect(gateway.createContribution).not.toHaveBeenCalled();
    expect(gateway.updateSituation).not.toHaveBeenCalled();
  });

  it("revokes a retained contribution callback while the active case is revalidating", async () => {
    const investigation = makePopulatedCase();
    const refreshed = createDeferred<GatewayResult<CaseV1>>();
    let reads = 0;
    const gateway = makeGateway({
      getInvestigation: vi.fn(() => {
        reads += 1;
        return reads === 1 ? Promise.resolve(succeeded(investigation)) : refreshed.promise;
      }),
    });
    render(
      <ProviderUnderTest
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
      </ProviderUnderTest>,
    );
    await waitFor(() => expect(currentRuntime().resources.investigation.status).toBe("ready"));
    const retained = currentRuntime().commands.createContribution;
    expect(retained).not.toBeNull();

    act(() => currentRuntime().refresh.investigation());
    await waitFor(() => expect(currentRuntime().resources.investigation.status).toBe("loading"));
    await act(async () => {
      await expect(retained?.({
        kind: "hypothesis",
        body: "must not write while loading",
        hypothesisLinks: [{ kind: "artifact", id: RUNTIME_FIXTURE_IDS.evidence }],
      }))
        .resolves.toEqual({ status: "ignored", reason: "not_ready" });
    });
    expect(gateway.createContribution).not.toHaveBeenCalled();

    await act(async () => refreshed.resolve(succeeded(investigation)));
    await waitFor(() => expect(currentRuntime().resources.investigation.status).toBe("ready"));
  });

  it("withholds both write seams from a reader who may not write", async () => {
    const gateway = makeGateway();
    render(
      <ProviderUnderTest
        identityKey="viewer"
        authorityKey="viewer-authority-v1"
        capabilities={["investigation:read", "run:strategies"]}
        readOnly={false}
        active
        focusCaseId={RUNTIME_FIXTURE_IDS.populatedCase}
        isInvestigationLocation
        onOpenCreated={vi.fn()}
        gateway={gateway}
      >
        <RuntimeProbe />
      </ProviderUnderTest>,
    );
    await waitFor(() => expect(currentRuntime().resources.investigation.status).toBe("ready"));

    expect(currentRuntime().capabilities).toEqual({
      canRead: true,
      canCreate: false,
      canUpload: false,
      canContribute: false,
      canEditSituation: false,
      canManageLifecycle: true,
    });
    expect(currentRuntime().commands.createContribution).toBeNull();
    expect(currentRuntime().commands.updateSituation).toBeNull();
    expect(currentRuntime().mutations.createContribution).toEqual({ status: "idle" });
    expect(currentRuntime().mutations.updateSituation).toEqual({ status: "idle" });
    expect(gateway.createContribution).not.toHaveBeenCalled();
    expect(gateway.updateSituation).not.toHaveBeenCalled();
  });

  it("withholds an evidence-linked contribution in static read-only mode", async () => {
    const gateway = makeGateway();
    render(
      <ProviderUnderTest
        identityKey="lead"
        authorityKey="lead-authority-read-only"
        capabilities={FULL_CAPABILITIES}
        readOnly
        active
        focusCaseId={RUNTIME_FIXTURE_IDS.populatedCase}
        isInvestigationLocation
        onOpenCreated={vi.fn()}
        gateway={gateway}
      >
        <RuntimeProbe />
      </ProviderUnderTest>,
    );
    await waitFor(() => expect(currentRuntime().resources.investigation.status).toBe("ready"));

    expect(currentRuntime().commands.createContribution).toBeNull();
    expect(currentRuntime().mutations.createContribution).toEqual({ status: "idle" });
    expect(gateway.createContribution).not.toHaveBeenCalled();
  });

  it("fails a write closed as unavailable when the transport omits the seam", async () => {
    // A gateway written before the V1.1 seams stays a complete transport. The
    // runtime must report the missing capability, never treat it as a success.
    const gateway = makeGateway();
    delete gateway.createContribution;
    delete gateway.updateSituation;
    render(
      <ProviderUnderTest
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
      </ProviderUnderTest>,
    );
    await waitFor(() => expect(currentRuntime().resources.investigation.status).toBe("ready"));

    const unavailable = { status: "failed", error: { kind: "unavailable", status: 503 } };
    // Authority is still projected truthfully: the commands exist, and it is
    // the write itself that reports the absent capability.
    expect(currentRuntime().capabilities.canContribute).toBe(true);
    expect(currentRuntime().capabilities.canEditSituation).toBe(true);
    expect(currentRuntime().commands.createContribution).not.toBeNull();
    expect(currentRuntime().commands.updateSituation).not.toBeNull();

    await act(async () => {
      await expect(currentRuntime().commands.createContribution?.({
        kind: "note",
        body: "x",
      })).resolves.toEqual(unavailable);
    });
    await act(async () => {
      await expect(currentRuntime().commands.updateSituation?.({ impact: "x" }))
        .resolves.toEqual(unavailable);
    });

    expect(currentRuntime().mutations.createContribution).toEqual(unavailable);
    expect(currentRuntime().mutations.updateSituation).toEqual(unavailable);
    expect(currentRuntime().resources.contributions.status).toBe("ready");
    expect(currentRuntime().resources.investigation.status).toBe("ready");
    expect(gateway.listContributions).toHaveBeenCalledTimes(1);
    expect(gateway.getInvestigation).toHaveBeenCalledTimes(1);
    expect(gateway.listInvestigations).toHaveBeenCalledTimes(1);
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
      <ProviderUnderTest
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
      </ProviderUnderTest>,
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
    const lifecycleMutation = currentRuntime().mutations.lifecycle;
    if (lifecycleMutation.status === "succeeded") {
      expect(Object.isFrozen(lifecycleMutation.value)).toBe(true);
      expect(Object.isFrozen(lifecycleMutation.value.case)).toBe(true);
      expect(() => {
        (lifecycleMutation.value.case as { title: string }).title = "contaminated";
      }).toThrow();
    }

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
      <ProviderUnderTest
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
      </ProviderUnderTest>,
    );
    await waitFor(() => expect(currentRuntime().resources.lifecycle.status).toBe("ready"));
    let changedOutcome: Awaited<ReturnType<NonNullable<InvestigationRuntime["commands"]["applyLifecycle"]>>> | undefined;
    await act(async () => {
      changedOutcome = await currentRuntime().commands.applyLifecycle?.("archive");
    });
    expect(currentRuntime().resources.lifecycle).toEqual({ status: "ready", value: changed });
    expect(Object.isFrozen(changed)).toBe(true);
    expect(Object.isFrozen(changed.archive)).toBe(true);
    expect(Object.isFrozen(changed.restore)).toBe(true);
    expect(changedOutcome).toMatchObject({
      status: "failed",
      error: { kind: "lifecycle_changed", current: changed },
    });
    const outcome = changedOutcome;
    if (outcome === undefined || outcome.status !== "failed"
      || outcome.error.kind !== "lifecycle_changed") {
      throw new Error("expected a lifecycle-changed command outcome");
    }
    const current = outcome.error.current;
    expect(Object.isFrozen(current)).toBe(true);
    expect(() => {
      (current as { legalHold: boolean }).legalHold = true;
    }).toThrow();
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
          <ProviderUnderTest
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
          </ProviderUnderTest>
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
      createContribution: null,
      updateSituation: null,
      applyLifecycle: null,
    });
    await waitFor(() => expect(currentRuntime().resources.investigations.status).toBe("ready"));
    // One initial read, one freshness read for the case transition, and one
    // newly scoped read for each authority/identity transition.
    expect(gateway.listInvestigations).toHaveBeenCalledTimes(4);
  });

  describe("authenticated identity projection", () => {
    const LEAD: InvestigationRuntimeIdentity = Object.freeze({
      id: "identity-lead-1",
      username: "lead",
      displayName: "Lead Investigator",
    });
    // Deliberately unlike every identity field: identityKey is an opaque
    // fencing token, and nothing may be read back out of it.
    const FENCING_KEY = "authority-scope-9f3a";

    it("projects exactly the sanitized identity the shell hands it", async () => {
      render(
        <ProviderUnderTest
          identityKey={FENCING_KEY}
          identity={LEAD}
          authorityKey="lead-authority-v1"
          capabilities={FULL_CAPABILITIES}
          readOnly={false}
          active
          focusCaseId={null}
          isInvestigationLocation
          onOpenCreated={vi.fn()}
          gateway={makeGateway()}
        >
          <RuntimeProbe />
        </ProviderUnderTest>,
      );
      await waitFor(() => expect(currentRuntime().resources.investigations.status).toBe("ready"));

      expect(currentRuntime().identity).toEqual({
        id: "identity-lead-1",
        username: "lead",
        displayName: "Lead Investigator",
      });
      expect(Object.keys(currentRuntime().identity).sort()).toEqual([
        "displayName",
        "id",
        "username",
      ]);
      expect(Object.values(currentRuntime().identity)).not.toContain(FENCING_KEY);
    });

    it("publishes the anonymous identity, not the fencing key, without a shell session", async () => {
      render(
        <ProviderUnderTest
          identityKey={FENCING_KEY}
          authorityKey="lead-authority-v1"
          capabilities={FULL_CAPABILITIES}
          readOnly={false}
          active
          focusCaseId={null}
          isInvestigationLocation
          onOpenCreated={vi.fn()}
          gateway={makeGateway()}
        >
          <RuntimeProbe />
        </ProviderUnderTest>,
      );
      await waitFor(() => expect(currentRuntime().resources.investigations.status).toBe("ready"));

      expect(currentRuntime().identity).toEqual({ id: "", username: "", displayName: "" });
    });

    it("deep-freezes the identity with the rest of the runtime graph", async () => {
      render(
        <ProviderUnderTest
          identityKey="identity-lead-1"
          identity={LEAD}
          authorityKey="lead-authority-v1"
          capabilities={FULL_CAPABILITIES}
          readOnly={false}
          active
          focusCaseId={RUNTIME_FIXTURE_IDS.populatedCase}
          isInvestigationLocation
          onOpenCreated={vi.fn()}
          gateway={makeGateway()}
        >
          <RuntimeProbe />
        </ProviderUnderTest>,
      );
      await waitFor(() => expect(currentRuntime().resources.investigation.status).toBe("ready"));

      const runtime = currentRuntime();
      expect(Object.isFrozen(runtime)).toBe(true);
      expect(Object.isFrozen(runtime.identity)).toBe(true);
      expect(() => {
        (runtime.identity as { displayName: string }).displayName = "Impersonated Lead";
      }).toThrow();
      expect(() => {
        (runtime.identity as unknown as Record<string, unknown>)["roles"] = ["admin"];
      }).toThrow();
      expect(runtime.identity.displayName).toBe("Lead Investigator");
      // The frozen identity does not come at the cost of the rest of the graph.
      expect(Object.isFrozen(runtime.capabilities)).toBe(true);
      expect(Object.isFrozen(runtime.resources)).toBe(true);
      expect(Object.isFrozen(runtime.mutations)).toBe(true);
      expect(Object.isFrozen(runtime.refresh)).toBe(true);
      expect(Object.isFrozen(runtime.commands)).toBe(true);
    });

    it("drops roles, capabilities, and private material an over-sharing shell attaches", async () => {
      const overSharing = {
        ...LEAD,
        roles: ["admin"],
        capabilities: ["investigation:write", "admin:users"],
        sessionToken: "cd-session-secret",
      } as InvestigationRuntimeIdentity;
      render(
        <ProviderUnderTest
          identityKey="identity-lead-1"
          identity={overSharing}
          authorityKey="lead-authority-v1"
          capabilities={["investigation:read"]}
          readOnly={false}
          active
          focusCaseId={null}
          isInvestigationLocation
          onOpenCreated={vi.fn()}
          gateway={makeGateway()}
        >
          <RuntimeProbe />
        </ProviderUnderTest>,
      );
      await waitFor(() => expect(currentRuntime().resources.investigations.status).toBe("ready"));

      const runtime = currentRuntime();
      expect(Object.keys(runtime.identity).sort()).toEqual(["displayName", "id", "username"]);
      expect("roles" in runtime.identity).toBe(false);
      expect("capabilities" in runtime.identity).toBe(false);
      expect("sessionToken" in runtime.identity).toBe(false);
      expect(JSON.stringify(runtime)).not.toContain("cd-session-secret");
      // Whatever the shell attached grants nothing: authority still comes only
      // from the capability projection.
      expect(runtime.capabilities).toEqual({
        canRead: true,
        canCreate: false,
        canUpload: false,
        canContribute: false,
        canEditSituation: false,
        canManageLifecycle: false,
      });
      expect(runtime.commands).toEqual({
        createInvestigation: null,
        uploadEvidence: null,
        createContribution: null,
        updateSituation: null,
        applyLifecycle: null,
      });
    });

    it("republishes a renamed display name without re-fencing or granting capability", async () => {
      const gateway = makeGateway();
      // Stable across mounts so that the display name is the only thing that
      // changes between renders.
      const onOpenCreated = vi.fn();
      const capabilities = ["investigation:read"] as const;
      const mount = (displayName: string) => (
        <ProviderUnderTest
          identityKey="identity-lead-1"
          identity={{ id: LEAD.id, username: LEAD.username, displayName }}
          authorityKey="lead-authority-v1"
          capabilities={capabilities}
          readOnly={false}
          active
          focusCaseId={RUNTIME_FIXTURE_IDS.populatedCase}
          isInvestigationLocation
          onOpenCreated={onOpenCreated}
          gateway={gateway}
        >
          <RuntimeProbe />
        </ProviderUnderTest>
      );
      const view = render(mount("Lead Investigator"));
      await waitFor(() => expect(currentRuntime().resources.investigation.status).toBe("ready"));
      const before = currentRuntime();

      // An unrelated re-render hands the provider a fresh session object. The
      // projection is keyed on the field values, so the published identity has
      // to be the very same frozen object rather than an equal copy.
      view.rerender(mount("Lead Investigator"));
      expect(currentRuntime().identity).toBe(before.identity);

      view.rerender(mount("Lead Investigator (on call)"));
      await waitFor(() =>
        expect(currentRuntime().identity.displayName).toBe("Lead Investigator (on call)"));

      const after = currentRuntime();
      expect(after.identity).toEqual({
        id: "identity-lead-1",
        username: "lead",
        displayName: "Lead Investigator (on call)",
      });
      // A descriptive rename is not an authority event and not a scope change:
      // the projected authority and every published lane survive untouched.
      expect(after.capabilities).toBe(before.capabilities);
      expect(after.resources.investigations).toBe(before.resources.investigations);
      expect(after.resources.investigation).toBe(before.resources.investigation);
      expect(after.commands.createInvestigation).toBeNull();
      expect(after.commands.uploadEvidence).toBeNull();
      expect(after.commands.applyLifecycle).toBeNull();
      expect(gateway.listInvestigations).toHaveBeenCalledTimes(1);
      expect(gateway.getInvestigation).toHaveBeenCalledTimes(1);
    });

    it("publishes only the new identity when the authenticated person changes", async () => {
      const listReads: Array<{
        readonly signal: AbortSignal;
        readonly deferred: Deferred<GatewayResult<readonly CaseV1[]>>;
      }> = [];
      const gateway = makeGateway({
        listInvestigations: vi.fn(({ signal }) => {
          const deferred = createDeferred<GatewayResult<readonly CaseV1[]>>();
          listReads.push({ signal, deferred });
          return deferred.promise;
        }),
      });
      const ANALYST: InvestigationRuntimeIdentity = Object.freeze({
        id: "identity-analyst-2",
        username: "analyst",
        displayName: "Second Analyst",
      });
      function Harness() {
        const [identity, setIdentity] = useState(LEAD);
        return (
          <>
            <button type="button" onClick={() => setIdentity(ANALYST)}>
              reauthenticate
            </button>
            <ProviderUnderTest
              identityKey={identity.id}
              identity={identity}
              authorityKey={`${identity.id}-authority-v1`}
              capabilities={FULL_CAPABILITIES}
              readOnly={false}
              active
              focusCaseId={null}
              isInvestigationLocation
              onOpenCreated={vi.fn()}
              gateway={gateway}
            >
              <RuntimeProbe />
            </ProviderUnderTest>
          </>
        );
      }
      render(<Harness />);
      await waitFor(() => expect(listReads).toHaveLength(1));
      expect(currentRuntime().identity).toEqual(LEAD);

      act(() => screen.getByRole("button", { name: "reauthenticate" }).click());
      await waitFor(() => expect(listReads).toHaveLength(2));

      // Only the new identity is published, and nothing of the old one is kept.
      expect(currentRuntime().identity).toEqual(ANALYST);
      expect(Object.values(currentRuntime().identity)).not.toContain(LEAD.id);
      expect(Object.values(currentRuntime().identity)).not.toContain(LEAD.username);
      expect(Object.values(currentRuntime().identity)).not.toContain(LEAD.displayName);
      expect(listReads[0]!.signal.aborted).toBe(true);
      expect(currentRuntime().resources.investigations).toEqual({ status: "loading" });

      // The previous identity's read finishes late. Existing fencing must keep
      // it from publishing into the newly signed-in runtime.
      await act(async () => {
        listReads[0]!.deferred.resolve(succeeded(makeCaseList().cases));
        await listReads[0]!.deferred.promise;
      });
      expect(currentRuntime().resources.investigations).toEqual({ status: "loading" });
      expect(currentRuntime().identity).toEqual(ANALYST);

      // The new identity's own read still publishes normally.
      await act(async () => {
        listReads[1]!.deferred.resolve(succeeded(makeCaseList().cases));
        await listReads[1]!.deferred.promise;
      });
      await waitFor(() =>
        expect(currentRuntime().resources.investigations.status).toBe("ready"));
      expect(currentRuntime().identity).toEqual(ANALYST);
    });

    it("still publishes the identity in static read-only mode without granting anything", async () => {
      render(
        <ProviderUnderTest
          identityKey="identity-lead-1"
          identity={LEAD}
          authorityKey="lead-authority-read-only"
          capabilities={FULL_CAPABILITIES}
          readOnly
          active
          focusCaseId={null}
          isInvestigationLocation
          onOpenCreated={vi.fn()}
          gateway={makeGateway()}
        >
          <RuntimeProbe />
        </ProviderUnderTest>,
      );
      await waitFor(() => expect(currentRuntime().resources.investigations.status).toBe("ready"));

      const runtime = currentRuntime();
      expect(runtime.identity).toEqual(LEAD);
      expect(Object.isFrozen(runtime.identity)).toBe(true);
      // Knowing who is signed in is not permission to act as them.
      expect(runtime.capabilities).toEqual({
        canRead: true,
        canCreate: false,
        canUpload: false,
        canContribute: false,
        canEditSituation: false,
        canManageLifecycle: false,
      });
      expect(runtime.commands).toEqual({
        createInvestigation: null,
        uploadEvidence: null,
        createContribution: null,
        updateSituation: null,
        applyLifecycle: null,
      });
    });

    it("offers a strategy no identity outside the shared provider", () => {
      function IdentityProbe() {
        const { identity } = useInvestigationRuntime();
        return <div>{identity.username}</div>;
      }
      expect(() => render(<IdentityProbe />)).toThrow(
        "useInvestigationRuntime must be used within InvestigationRuntimeProvider",
      );
    });
  });
});
