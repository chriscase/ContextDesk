import type {
  ArtifactV1,
  CaseV1,
  ContributionV1,
  EvidenceUploadSuccessV1,
  InvestigationLifecycleActionSuccessV1,
  InvestigationLifecycleV1,
  LifecycleAction,
} from "@cd-collab/contracts/investigation-runtime";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  projectInvestigationCapabilities,
  type InvestigationRuntimeCapabilities,
} from "./capabilities.js";
import {
  useActiveInvestigation,
  useCreateInvestigation,
  useInvestigationList,
  useLifecycleAction,
  useUploadEvidence,
  type UploadEvidenceCommand,
} from "./controllers/index.js";
import {
  investigationGateway,
  type CreateInvestigationInput,
  type InvestigationGateway,
} from "./gateway.js";
import { deepFreezeDto } from "./deep-freeze.js";
import type {
  CommandOutcome,
  MutationState,
  ResourceState,
} from "./types.js";

export type InvestigationCreateInput = CreateInvestigationInput;
export type InvestigationEvidenceUploadCommand = UploadEvidenceCommand;

export interface InvestigationRuntimeResources {
  readonly investigations: ResourceState<readonly CaseV1[]>;
  readonly investigation: ResourceState<CaseV1>;
  readonly evidence: ResourceState<readonly ArtifactV1[]>;
  readonly contributions: ResourceState<readonly ContributionV1[]>;
  readonly lifecycle: ResourceState<InvestigationLifecycleV1>;
}

export interface InvestigationRuntimeMutations {
  readonly create: MutationState<CaseV1>;
  readonly uploadEvidence: MutationState<EvidenceUploadSuccessV1>;
  readonly lifecycle: MutationState<InvestigationLifecycleActionSuccessV1>;
}

export interface InvestigationRuntimeRefresh {
  readonly investigations: () => void;
  readonly investigation: () => void;
  readonly evidence: () => void;
  readonly contributions: () => void;
  readonly lifecycle: () => void;
  readonly activeInvestigation: () => void;
}

export interface InvestigationRuntimeCommands {
  readonly createInvestigation: ((
    input: InvestigationCreateInput,
  ) => Promise<CommandOutcome<CaseV1>>) | null;
  readonly uploadEvidence: ((
    command: InvestigationEvidenceUploadCommand,
  ) => Promise<CommandOutcome<EvidenceUploadSuccessV1>>) | null;
  readonly applyLifecycle: ((
    action: LifecycleAction,
  ) => Promise<CommandOutcome<InvestigationLifecycleActionSuccessV1>>) | null;
}

/** The complete presentation-safe Runtime V1 surface. */
export interface InvestigationRuntime {
  readonly capabilities: InvestigationRuntimeCapabilities;
  readonly resources: InvestigationRuntimeResources;
  readonly mutations: InvestigationRuntimeMutations;
  readonly refresh: InvestigationRuntimeRefresh;
  readonly commands: InvestigationRuntimeCommands;
}

export interface InvestigationRuntimeProviderProps {
  readonly identityKey: string;
  /**
   * Opaque shell-owned authorization snapshot. Rotate it whenever roles,
   * grants, case-access scope, static mode, or the authenticated session is
   * re-evaluated, even when the projected Runtime V1 booleans stay the same.
   */
  readonly authorityKey: string;
  readonly capabilities: readonly string[];
  readonly readOnly: boolean;
  /** True only while the shell's canonical location is in the investigation area. */
  readonly active: boolean;
  readonly focusCaseId: string | null;
  readonly isInvestigationLocation: boolean;
  readonly onOpenCreated: (investigationId: string) => void;
  /** Test-only transport injection. Production callers should omit it. */
  readonly gateway?: InvestigationGateway;
  readonly children: ReactNode;
}

const InvestigationRuntimeContext = createContext<InvestigationRuntime | null>(null);

/**
 * Mounts browser orchestration above replaceable strategy presentations.
 * Canonical location and identity remain shell-owned inputs.
 */
export function InvestigationRuntimeProvider({
  identityKey,
  authorityKey,
  capabilities: rawCapabilities,
  readOnly,
  active,
  focusCaseId,
  isInvestigationLocation,
  onOpenCreated,
  gateway = investigationGateway,
  children,
}: InvestigationRuntimeProviderProps) {
  const projected = projectInvestigationCapabilities(rawCapabilities, readOnly);
  const capabilities = useMemo<InvestigationRuntimeCapabilities>(() => Object.freeze({
    canRead: projected.canRead,
    canCreate: projected.canCreate,
    canUpload: projected.canUpload,
    canManageLifecycle: projected.canManageLifecycle,
  }), [
    projected.canCreate,
    projected.canManageLifecycle,
    projected.canRead,
    projected.canUpload,
  ]);
  const canCreate = capabilities.canRead && capabilities.canCreate;
  const canUpload = capabilities.canRead && capabilities.canUpload;
  const canManageLifecycle = capabilities.canRead && capabilities.canManageLifecycle;
  const activeCaseId = active && capabilities.canRead ? focusCaseId : null;

  const investigationList = useInvestigationList({
    gateway,
    enabled: capabilities.canRead,
    identityKey,
    authorityKey,
  });
  const listSnapshotRef = useRef({
    latestRequestGeneration: investigationList.latestRequestGeneration,
    status: investigationList.investigations.status,
  });
  listSnapshotRef.current = {
    latestRequestGeneration: investigationList.latestRequestGeneration,
    status: investigationList.investigations.status,
  };
  const [activeListValidation, setActiveListValidation] = useState<{
    readonly investigationId: string;
    readonly baselineGeneration: number;
  } | null>(null);
  const activeInvestigation = useActiveInvestigation({
    gateway,
    investigationId: activeCaseId,
    active: active && capabilities.canRead,
    identityKey,
    authorityKey,
  });
  useEffect(() => {
    if (activeCaseId === null) {
      setActiveListValidation(null);
      return;
    }
    const snapshot = listSnapshotRef.current;
    setActiveListValidation({
      investigationId: activeCaseId,
      baselineGeneration: snapshot.latestRequestGeneration,
    });
    // A settled collection predates this route transition. Refresh it before
    // treating omission as authoritative. The initial idle collection already
    // has a request scheduled by its controller, so it needs no duplicate read.
    if (snapshot.status !== "idle") investigationList.refresh();
  }, [
    activeCaseId,
    authorityKey,
    identityKey,
    investigationList.refresh,
  ]);
  const activeListIsFresh = activeCaseId !== null
    && activeListValidation?.investigationId === activeCaseId
    && investigationList.successfulSnapshotGeneration
      > activeListValidation.baselineGeneration;
  const activeMissingFromAuthoritativeList = activeListIsFresh
    && investigationList.investigations.status === "ready"
    && !investigationList.investigations.value.some(({ id }) => id === activeCaseId);
  const activeScopeUnavailable = activeInvestigation.scopeDenied
    || activeMissingFromAuthoritativeList;
  useEffect(() => {
    if (activeMissingFromAuthoritativeList && activeCaseId !== null) {
      activeInvestigation.denyScope(activeCaseId, { kind: "not_found", status: 404 });
    }
  }, [
    activeCaseId,
    activeInvestigation.denyScope,
    activeMissingFromAuthoritativeList,
  ]);

  const publishInvestigation = useCallback((investigation: CaseV1) => {
    investigationList.publishInvestigation(investigation);
    activeInvestigation.publishInvestigation(investigation);
  }, [activeInvestigation.publishInvestigation, investigationList.publishInvestigation]);

  const publishCreated = useCallback((investigation: CaseV1) => {
    publishInvestigation(investigation);
    investigationList.refresh();
  }, [investigationList.refresh, publishInvestigation]);

  const refreshEvidenceFor = useCallback((investigationId: string) => {
    if (activeCaseId === investigationId) {
      activeInvestigation.refreshEvidence();
      activeInvestigation.refreshContributions();
    }
  }, [
    activeCaseId,
    activeInvestigation.refreshContributions,
    activeInvestigation.refreshEvidence,
  ]);
  const refreshInvestigationFor = useCallback((investigationId: string) => {
    if (activeCaseId === investigationId) {
      activeInvestigation.refreshInvestigation();
    }
  }, [activeCaseId, activeInvestigation.refreshInvestigation]);
  const refreshLifecycleFor = useCallback((investigationId: string) => {
    if (activeCaseId === investigationId) {
      activeInvestigation.refreshLifecycle();
    }
  }, [activeCaseId, activeInvestigation.refreshLifecycle]);

  const createController = useCreateInvestigation({
    gateway,
    identityKey,
    authorityKey,
    canCreate,
    readOnly,
    isInvestigationLocation,
    locationInvestigationId: focusCaseId,
    onCreated: publishCreated,
    onOpenCreated,
  });
  const uploadController = useUploadEvidence({
    gateway,
    identityKey,
    authorityKey,
    investigationId: activeScopeUnavailable ? null : activeCaseId,
    canUpload: canUpload && !activeScopeUnavailable,
    readOnly,
    onUploaded: activeInvestigation.publishEvidence,
    onRefreshEvidence: refreshEvidenceFor,
    onRefreshInvestigations: investigationList.refresh,
    onScopeDenied: activeInvestigation.denyScope,
  });
  const lifecycleValue = activeScopeUnavailable
    ? null
    : activeInvestigation.lifecycle.status === "ready"
    ? activeInvestigation.lifecycle.value
    : null;
  const lifecycleController = useLifecycleAction({
    gateway,
    identityKey,
    authorityKey,
    investigationId: activeScopeUnavailable ? null : activeCaseId,
    lifecycle: lifecycleValue,
    canManageLifecycle: canManageLifecycle && !activeScopeUnavailable,
    readOnly,
    onInvestigationPublished: publishInvestigation,
    onLifecyclePublished: activeInvestigation.publishLifecycle,
    onRefreshInvestigation: refreshInvestigationFor,
    onRefreshInvestigations: investigationList.refresh,
    onRefreshLifecycle: refreshLifecycleFor,
    onScopeDenied: activeInvestigation.denyScope,
  });

  const value = useMemo<InvestigationRuntime>(() => deepFreezeDto({
    capabilities,
    resources: {
      investigations: investigationList.investigations,
      investigation: activeMissingFromAuthoritativeList
        ? { status: "failed", error: { kind: "not_found", status: 404 } }
        : activeInvestigation.investigation,
      evidence: activeMissingFromAuthoritativeList
        ? { status: "failed", error: { kind: "not_found", status: 404 } }
        : activeInvestigation.evidence,
      contributions: activeMissingFromAuthoritativeList
        ? { status: "failed", error: { kind: "not_found", status: 404 } }
        : activeInvestigation.contributions,
      lifecycle: activeMissingFromAuthoritativeList
        ? { status: "failed", error: { kind: "not_found", status: 404 } }
        : activeInvestigation.lifecycle,
    },
    mutations: {
      create: createController.state,
      uploadEvidence: uploadController.state,
      lifecycle: lifecycleController.state,
    },
    refresh: {
      investigations: investigationList.refresh,
      investigation: activeInvestigation.refreshInvestigation,
      evidence: activeInvestigation.refreshEvidence,
      contributions: activeInvestigation.refreshContributions,
      lifecycle: activeInvestigation.refreshLifecycle,
      activeInvestigation: activeInvestigation.refreshAll,
    },
    commands: {
      createInvestigation: canCreate && active && isInvestigationLocation
        && focusCaseId === null
        ? createController.create
        : null,
      uploadEvidence: canUpload
        && activeCaseId !== null
        && activeInvestigation.investigation.status === "ready"
        && !activeScopeUnavailable
        ? uploadController.upload
        : null,
      applyLifecycle: canManageLifecycle && activeCaseId !== null
        && lifecycleValue !== null
        && !activeScopeUnavailable
        ? lifecycleController.apply
        : null,
    },
  }), [
    activeInvestigation.contributions,
    activeInvestigation.evidence,
    activeInvestigation.investigation,
    activeInvestigation.lifecycle,
    activeInvestigation.refreshAll,
    activeInvestigation.refreshContributions,
    activeInvestigation.refreshEvidence,
    activeInvestigation.refreshInvestigation,
    activeInvestigation.refreshLifecycle,
    activeInvestigation.scopeDenied,
    activeMissingFromAuthoritativeList,
    activeScopeUnavailable,
    active,
    activeCaseId,
    canCreate,
    canManageLifecycle,
    canUpload,
    capabilities,
    createController.create,
    createController.state,
    investigationList.investigations,
    investigationList.refresh,
    isInvestigationLocation,
    lifecycleController.apply,
    lifecycleController.state,
    uploadController.state,
    uploadController.upload,
  ]);

  return (
    <InvestigationRuntimeContext.Provider value={value}>
      {children}
    </InvestigationRuntimeContext.Provider>
  );
}

/** Strategies must be mounted beneath the shared runtime provider. */
export function useInvestigationRuntime(): InvestigationRuntime {
  const runtime = useContext(InvestigationRuntimeContext);
  if (runtime === null) {
    throw new Error("useInvestigationRuntime must be used within InvestigationRuntimeProvider");
  }
  return runtime;
}
