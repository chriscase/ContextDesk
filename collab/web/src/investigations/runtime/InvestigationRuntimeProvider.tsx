import type {
  ArtifactV1,
  CaseV1,
  ContributionV1,
  EvidenceUploadSuccessV1,
  InvestigationLifecycleActionSuccessV1,
  InvestigationLifecycleV1,
  LifecycleAction,
} from "@cd-collab/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
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

function authorityEpoch(
  capabilities: InvestigationRuntimeCapabilities,
  readOnly: boolean,
): string {
  return [
    readOnly ? "read-only" : "interactive",
    capabilities.canRead ? "read" : "no-read",
    capabilities.canCreate ? "create" : "no-create",
    capabilities.canUpload ? "upload" : "no-upload",
    capabilities.canManageLifecycle ? "lifecycle" : "no-lifecycle",
  ].join(":");
}

/**
 * Mounts browser orchestration above replaceable strategy presentations.
 * Canonical location and identity remain shell-owned inputs.
 */
export function InvestigationRuntimeProvider({
  identityKey,
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
  const authorityKey = authorityEpoch(capabilities, readOnly);
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
  const activeInvestigation = useActiveInvestigation({
    gateway,
    investigationId: activeCaseId,
    active: active && capabilities.canRead,
    identityKey,
    authorityKey,
  });

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
    investigationId: activeCaseId,
    canUpload,
    readOnly,
    onUploaded: activeInvestigation.publishEvidence,
    onRefreshEvidence: refreshEvidenceFor,
    onRefreshInvestigations: investigationList.refresh,
  });
  const lifecycleValue = activeInvestigation.lifecycle.status === "ready"
    ? activeInvestigation.lifecycle.value
    : activeInvestigation.lifecycle.status === "loading"
      ? activeInvestigation.lifecycle.previous ?? null
      : activeInvestigation.lifecycle.status === "failed"
        ? activeInvestigation.lifecycle.previous ?? null
        : null;
  const lifecycleController = useLifecycleAction({
    gateway,
    identityKey,
    authorityKey,
    investigationId: activeCaseId,
    lifecycle: lifecycleValue,
    canManageLifecycle,
    readOnly,
    onInvestigationPublished: publishInvestigation,
    onLifecyclePublished: activeInvestigation.publishLifecycle,
    onRefreshInvestigation: refreshInvestigationFor,
    onRefreshInvestigations: investigationList.refresh,
    onRefreshLifecycle: refreshLifecycleFor,
  });

  const value = useMemo<InvestigationRuntime>(() => ({
    capabilities,
    resources: {
      investigations: investigationList.investigations,
      investigation: activeInvestigation.investigation,
      evidence: activeInvestigation.evidence,
      contributions: activeInvestigation.contributions,
      lifecycle: activeInvestigation.lifecycle,
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
        ? createController.create
        : null,
      uploadEvidence: canUpload && activeCaseId !== null ? uploadController.upload : null,
      applyLifecycle: canManageLifecycle && activeCaseId !== null
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
