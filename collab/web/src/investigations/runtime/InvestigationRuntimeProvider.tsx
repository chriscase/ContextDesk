import type {
  InvestigationCollectionPageV1,
  InvestigationCollectionQueryV1,
} from "@cd-collab/contracts/investigation-collection";
import type {
  ArtifactV1,
  CaseV1,
  ContributionV1,
  EvidenceUploadSuccessV1,
  InvestigationLifecycleActionSuccessV1,
  InvestigationLifecycleV1,
  InvestigationCoordinationActionSuccessV1,
  InvestigationCoordinationV1,
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
  useCreateContribution,
  useCreateInvestigation,
  useEvidencePreview,
  useArtifactAnnotations,
  useCreateArtifactAnnotation,
  useCreateArtifactAnnotationsBulk,
  useInvestigationList,
  useInvestigationCoordination,
  useLifecycleAction,
  useUpdateSituation,
  useUploadEvidence,
  type CreateContributionCommand,
  type CreateArtifactAnnotationCommand,
  type CreateArtifactAnnotationsBulkCommand,
  type PreviewEvidenceCommand,
  type InvestigationCoordinationCommand,
  type UpdateSituationCommand,
  type UploadEvidenceCommand,
} from "./controllers/index.js";
import { useInvestigationCollectionQuery } from "./controllers/use-investigation-list.js";
import {
  investigationGateway,
  investigationAnnotationGateway,
  investigationBulkAnnotationGateway,
  investigationCollectionQueryGateway,
  investigationCoordinationGateway,
  investigationWriteGateway,
  snapshotInvestigationCollectionQueryInput,
  type CreateInvestigationInput,
  type InvestigationCollectionQueryInput,
  type InvestigationGateway,
  type EvidencePreviewValue,
} from "./gateway.js";
import type {
  ArtifactAnnotationBulkResultV1,
  ArtifactAnnotationV1,
} from "./annotation-contract.js";
import { deepFreezeDto } from "./deep-freeze.js";
import type {
  CommandOutcome,
  MutationState,
  ResourceState,
} from "./types.js";

export type InvestigationCreateInput = CreateInvestigationInput;
export type InvestigationEvidenceUploadCommand = UploadEvidenceCommand;
export type InvestigationEvidencePreviewCommand = PreviewEvidenceCommand;
export type InvestigationContributionCommand = CreateContributionCommand;
export type InvestigationArtifactAnnotationCommand = CreateArtifactAnnotationCommand;
export type InvestigationArtifactAnnotationsBulkCommand = CreateArtifactAnnotationsBulkCommand;
export type InvestigationSituationCommand = UpdateSituationCommand;
export type InvestigationCoordinationActionCommand = InvestigationCoordinationCommand;

export interface InvestigationRuntimeResources {
  readonly investigations: ResourceState<readonly CaseV1[]>;
  readonly investigationCollection: ResourceState<InvestigationCollectionPageV1>;
  readonly investigationCollectionQuery: InvestigationCollectionQueryV1 | null;
  readonly investigation: ResourceState<CaseV1>;
  readonly evidence: ResourceState<readonly ArtifactV1[]>;
  readonly contributions: ResourceState<readonly ContributionV1[]>;
  readonly lifecycle: ResourceState<InvestigationLifecycleV1>;
  readonly coordination: ResourceState<InvestigationCoordinationV1>;
  readonly artifactAnnotations: ResourceState<readonly ArtifactAnnotationV1[]>;
}

export interface InvestigationRuntimeMutations {
  readonly create: MutationState<CaseV1>;
  readonly uploadEvidence: MutationState<EvidenceUploadSuccessV1>;
  readonly createContribution: MutationState<ContributionV1>;
  readonly updateSituation: MutationState<CaseV1>;
  readonly lifecycle: MutationState<InvestigationLifecycleActionSuccessV1>;
  readonly coordination: MutationState<InvestigationCoordinationActionSuccessV1>;
  readonly createArtifactAnnotation: MutationState<ArtifactAnnotationV1>;
  readonly createArtifactAnnotations: MutationState<ArtifactAnnotationBulkResultV1>;
}

export interface InvestigationRuntimeRefresh {
  readonly investigations: () => void;
  readonly investigationCollection: () => void;
  readonly investigation: () => void;
  readonly evidence: () => void;
  readonly contributions: () => void;
  readonly lifecycle: () => void;
  readonly coordination: () => void;
  readonly artifactAnnotations: () => Promise<void>;
  readonly activeInvestigation: () => void;
}

export interface InvestigationRuntimeCommands {
  readonly createInvestigation: ((
    input: InvestigationCreateInput,
  ) => Promise<CommandOutcome<CaseV1>>) | null;
  readonly uploadEvidence: ((
    command: InvestigationEvidenceUploadCommand,
  ) => Promise<CommandOutcome<EvidenceUploadSuccessV1>>) | null;
  readonly createContribution: ((
    command: InvestigationContributionCommand,
  ) => Promise<CommandOutcome<ContributionV1>>) | null;
  readonly updateSituation: ((
    command: InvestigationSituationCommand,
  ) => Promise<CommandOutcome<CaseV1>>) | null;
  readonly applyLifecycle: ((
    action: LifecycleAction,
  ) => Promise<CommandOutcome<InvestigationLifecycleActionSuccessV1>>) | null;
  readonly applyCoordinationAction: ((
    command: InvestigationCoordinationActionCommand,
  ) => Promise<CommandOutcome<InvestigationCoordinationActionSuccessV1>>) | null;
  readonly createArtifactAnnotation: ((
    command: InvestigationArtifactAnnotationCommand,
  ) => Promise<CommandOutcome<ArtifactAnnotationV1>>) | null;
  readonly createArtifactAnnotations: ((
    command: InvestigationArtifactAnnotationsBulkCommand,
  ) => Promise<CommandOutcome<ArtifactAnnotationBulkResultV1>>) | null;
  /** Additive collection-query command; omit it only in pre-query snapshots. */
  readonly queryInvestigations?: ((
    input: InvestigationCollectionQueryInput,
  ) => void) | null;
}

/** Read-only evidence inspection keeps its bounded command separate from writes. */
export interface InvestigationRuntimeEvidencePreview {
  readonly state: MutationState<EvidencePreviewValue>;
  readonly preview: (
    command: InvestigationEvidencePreviewCommand,
  ) => Promise<CommandOutcome<EvidencePreviewValue>>;
  readonly clear: () => void;
}

/**
 * The signed-in person, as a strategy is allowed to see them.
 *
 * It exists so a presentation can key browser-local drafts to whoever is
 * signed in instead of inferring that from record data. It is descriptive
 * only: `capabilities` and the server's own checks remain the sole
 * authorization source, and request fencing keeps using `identityKey`.
 */
export interface InvestigationRuntimeIdentity {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
}

/**
 * Published when the shell projects no authenticated session. The empty
 * strings are deliberate: the runtime neither invents a person nor reads one
 * out of `identityKey`.
 */
const ANONYMOUS_IDENTITY: InvestigationRuntimeIdentity = Object.freeze({
  id: "",
  username: "",
  displayName: "",
});

let nextPresentationScopeId = 0;

function createPresentationScopeKey(): string {
  nextPresentationScopeId += 1;
  return `investigation-presentation-scope-${nextPresentationScopeId.toString(36)}`;
}

/** The complete presentation-safe Runtime V1 surface. */
export interface InvestigationRuntime {
  /**
   * Opaque reset/fencing key for presentation-local transient state. It
   * changes with the shell's identity or authority epoch, but contains
   * neither shell key and stays stable across ordinary resource updates.
   * It grants no authority and must never be parsed or used as permission.
   */
  readonly presentationScopeKey: string;
  /** Descriptive only. Never consult it to decide what a strategy may do. */
  readonly identity: InvestigationRuntimeIdentity;
  readonly capabilities: InvestigationRuntimeCapabilities;
  readonly resources: InvestigationRuntimeResources;
  readonly mutations: InvestigationRuntimeMutations;
  readonly evidencePreview: InvestigationRuntimeEvidencePreview;
  readonly refresh: InvestigationRuntimeRefresh;
  readonly commands: InvestigationRuntimeCommands;
}

export interface InvestigationRuntimeProviderProps {
  readonly identityKey: string;
  /**
   * The already sanitized authenticated identity from the shell session,
   * carrying nothing but the three descriptive fields. Omit it where the
   * shell projects no session; the runtime then publishes the anonymous
   * identity. It grants no authority and never participates in fencing.
   */
  readonly identity?: InvestigationRuntimeIdentity;
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
  readonly children: ReactNode;
}

const InvestigationRuntimeContext = createContext<InvestigationRuntime | null>(null);
const InjectedGatewayContext = createContext<InvestigationGateway | null>(null);

/**
 * The only transport seam, reserved for the runtime's own tests and the runtime
 * testkit. It is deliberately absent from `runtime/public.ts`, and strategies
 * may import nothing else, so a presentation layer can neither name nor inject
 * transport. Production mounts no harness and always resolves the real gateway.
 *
 * @internal
 */
export function InvestigationRuntimeGatewayHarness({
  gateway,
  children,
}: {
  readonly gateway: InvestigationGateway;
  readonly children: ReactNode;
}) {
  return (
    <InjectedGatewayContext.Provider value={gateway}>
      {children}
    </InjectedGatewayContext.Provider>
  );
}

/**
 * Mounts browser orchestration above replaceable strategy presentations.
 * Canonical location and identity remain shell-owned inputs.
 */
export function InvestigationRuntimeProvider({
  identityKey,
  identity: sessionIdentity = ANONYMOUS_IDENTITY,
  authorityKey,
  capabilities: rawCapabilities,
  readOnly,
  active,
  focusCaseId,
  isInvestigationLocation,
  onOpenCreated,
  children,
}: InvestigationRuntimeProviderProps) {
  const gateway = useContext(InjectedGatewayContext) ?? investigationGateway;
  const presentationScopeRef = useRef<{
    readonly identityKey: string;
    readonly authorityKey: string;
    readonly publicKey: string;
  } | null>(null);
  if (
    presentationScopeRef.current === null
    || presentationScopeRef.current.identityKey !== identityKey
    || presentationScopeRef.current.authorityKey !== authorityKey
  ) {
    presentationScopeRef.current = {
      identityKey,
      authorityKey,
      publicKey: createPresentationScopeKey(),
    };
  }
  const presentationScopeKey = presentationScopeRef.current.publicKey;
  // Production binds the concrete POST/PATCH methods. A transport without them
  // resolves to the fail-closed seam, so a write reports `unavailable` instead
  // of appearing to succeed.
  const writeGateway = useMemo(() => investigationWriteGateway(gateway), [gateway]);
  const annotationGateway = useMemo(() => investigationAnnotationGateway(gateway), [gateway]);
  const bulkAnnotationGateway = useMemo(
    () => investigationBulkAnnotationGateway(gateway),
    [gateway],
  );
  const collectionQueryGateway = useMemo(
    () => investigationCollectionQueryGateway(gateway),
    [gateway],
  );
  const coordinationGateway = useMemo(
    () => investigationCoordinationGateway(gateway),
    [gateway],
  );
  const [collectionQueryInput, setCollectionQueryInput] =
    useState<InvestigationCollectionQueryInput | null>(null);
  const requestInvestigationCollection = useCallback((input: InvestigationCollectionQueryInput) => {
    setCollectionQueryInput(snapshotInvestigationCollectionQueryInput(input));
  }, []);
  const projected = projectInvestigationCapabilities(rawCapabilities, readOnly);
  const capabilities = useMemo<InvestigationRuntimeCapabilities>(() => Object.freeze({
    canRead: projected.canRead,
    canReadPrivate: projected.canReadPrivate,
    canCreate: projected.canCreate,
    canUpload: projected.canUpload,
    canContribute: projected.canContribute,
    canEditSituation: projected.canEditSituation,
    canManageLifecycle: projected.canManageLifecycle,
    canCoordinateSelf: projected.canCoordinateSelf,
    canCoordinateParticipants: projected.canCoordinateParticipants,
  }), [
    projected.canContribute,
    projected.canCoordinateParticipants,
    projected.canCoordinateSelf,
    projected.canCreate,
    projected.canEditSituation,
    projected.canManageLifecycle,
    projected.canRead,
    projected.canReadPrivate,
    projected.canUpload,
  ]);
  // Narrowed field by field so that whatever else the shell's session object
  // happens to carry — roles, grants, tokens — cannot reach a strategy, and so
  // that a descriptive-only change such as a new display name republishes the
  // identity without disturbing any request scope.
  const identity = useMemo<InvestigationRuntimeIdentity>(() => Object.freeze({
    id: sessionIdentity.id,
    username: sessionIdentity.username,
    displayName: sessionIdentity.displayName,
  }), [sessionIdentity.displayName, sessionIdentity.id, sessionIdentity.username]);
  const canCreate = capabilities.canRead && capabilities.canCreate;
  const canUpload = capabilities.canRead && capabilities.canUpload;
  const canContribute = capabilities.canRead && capabilities.canContribute;
  const canEditSituation = capabilities.canRead && capabilities.canEditSituation;
  const canManageLifecycle = capabilities.canRead && capabilities.canManageLifecycle;
  const canCoordinateSelf = capabilities.canRead && capabilities.canCoordinateSelf;
  const canCoordinateParticipants =
    capabilities.canRead && capabilities.canCoordinateParticipants;
  const activeCaseId = active && capabilities.canRead ? focusCaseId : null;

  const investigationList = useInvestigationList({
    gateway,
    enabled: capabilities.canRead,
    identityKey,
    authorityKey,
  });
  const investigationCollection = useInvestigationCollectionQuery({
    gateway: collectionQueryGateway,
    enabled: capabilities.canRead && collectionQueryInput !== null,
    identityKey,
    authorityKey,
    query: collectionQueryInput,
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
  const refreshContributionsFor = useCallback((investigationId: string) => {
    if (activeCaseId === investigationId) {
      activeInvestigation.refreshContributions();
    }
  }, [activeCaseId, activeInvestigation.refreshContributions]);
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

  // A write callback must be revocable at the controller boundary, not only
  // hidden from the published command object. During a refresh the active
  // case may still be the same id while its authoritative record is loading;
  // expose no writable scope until that record is ready again.
  const activeReadyCaseId =
    activeScopeUnavailable || activeInvestigation.investigation.status !== "ready"
      ? null
      : activeCaseId;

  const artifactAnnotationsController = useArtifactAnnotations({
    gateway: annotationGateway,
    identityKey,
    authorityKey,
    investigationId: activeScopeUnavailable ? null : activeCaseId,
    active: active && capabilities.canRead,
    canRead: capabilities.canRead && !activeScopeUnavailable,
    onScopeDenied: activeInvestigation.denyScope,
  });
  const refreshArtifactAnnotationsFor = useCallback((investigationId: string) => {
    if (activeCaseId === investigationId) {
      artifactAnnotationsController.refresh();
    }
  }, [activeCaseId, artifactAnnotationsController.refresh]);
  const artifactAnnotationController = useCreateArtifactAnnotation({
    gateway: annotationGateway,
    identityKey,
    authorityKey,
    investigationId: activeReadyCaseId,
    canAnnotate: canContribute && !activeScopeUnavailable,
    readOnly,
    onCreated: artifactAnnotationsController.publish,
    onRefresh: refreshArtifactAnnotationsFor,
    onScopeDenied: activeInvestigation.denyScope,
  });
  const artifactAnnotationsBulkController = useCreateArtifactAnnotationsBulk({
    gateway: bulkAnnotationGateway,
    identityKey,
    authorityKey,
    investigationId: activeReadyCaseId,
    canAnnotate: canContribute && !activeScopeUnavailable,
    readOnly,
    onCreated: (result) => {
      // A bulk acknowledgement is one transport operation. Publishing its
      // confirmed rows locally may iterate the bounded result, but it never
      // schedules one request per target.
      for (const item of result.items) {
        if (item.outcome !== "not_found") {
          artifactAnnotationsController.publish(item.annotation);
        }
      }
    },
    onRefresh: refreshArtifactAnnotationsFor,
    onScopeDenied: activeInvestigation.denyScope,
  });
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
  const previewController = useEvidencePreview({
    gateway,
    identityKey,
    authorityKey,
    investigationId: activeScopeUnavailable ? null : activeCaseId,
    canRead: capabilities.canRead && !activeScopeUnavailable,
  });
  const contributionController = useCreateContribution({
    gateway: writeGateway,
    identityKey,
    authorityKey,
    investigationId: activeReadyCaseId,
    canContribute: canContribute && !activeScopeUnavailable,
    readOnly,
    onContributed: activeInvestigation.publishContribution,
    onRefreshContributions: refreshContributionsFor,
    onScopeDenied: activeInvestigation.denyScope,
  });
  const situationCase = activeScopeUnavailable
    ? null
    : activeInvestigation.investigation.status === "ready"
    ? activeInvestigation.investigation.value
    : null;
  const situationController = useUpdateSituation({
    gateway: writeGateway,
    identityKey,
    authorityKey,
    investigationId: activeScopeUnavailable ? null : activeCaseId,
    investigation: situationCase,
    canEditSituation: canEditSituation && !activeScopeUnavailable,
    readOnly,
    onInvestigationPublished: publishInvestigation,
    onRefreshInvestigation: refreshInvestigationFor,
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
  const coordinationController = useInvestigationCoordination({
    gateway: coordinationGateway,
    identityKey,
    authorityKey,
    actorIdentityId: identity.id,
    investigationId: activeScopeUnavailable ? null : activeCaseId,
    active: active && capabilities.canRead,
    canRead: capabilities.canRead && !activeScopeUnavailable,
    canCoordinateSelf: canCoordinateSelf && !activeScopeUnavailable,
    canCoordinateParticipants: canCoordinateParticipants && !activeScopeUnavailable,
    readOnly,
    onScopeDenied: activeInvestigation.denyScope,
  });
  const refreshAll = useCallback(() => {
    activeInvestigation.refreshAll();
    coordinationController.refresh();
    artifactAnnotationsController.refresh();
  }, [
    activeInvestigation.refreshAll,
    artifactAnnotationsController.refresh,
    coordinationController.refresh,
  ]);

  const value = useMemo<InvestigationRuntime>(() => deepFreezeDto({
    presentationScopeKey,
    identity,
    capabilities,
    resources: {
      investigations: investigationList.investigations,
      investigationCollection: investigationCollection.page,
      investigationCollectionQuery: investigationCollection.query,
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
      coordination: activeMissingFromAuthoritativeList
        ? { status: "failed", error: { kind: "not_found", status: 404 } }
        : coordinationController.coordination,
      artifactAnnotations: activeMissingFromAuthoritativeList
        ? { status: "failed", error: { kind: "not_found", status: 404 } }
        : artifactAnnotationsController.annotations,
    },
    mutations: {
      create: createController.state,
      uploadEvidence: uploadController.state,
      createContribution: contributionController.state,
      updateSituation: situationController.state,
      lifecycle: lifecycleController.state,
      coordination: coordinationController.state,
      createArtifactAnnotation: artifactAnnotationController.state,
      createArtifactAnnotations: artifactAnnotationsBulkController.state,
    },
    evidencePreview: {
      state: previewController.state,
      preview: previewController.preview,
      clear: previewController.clear,
    },
    refresh: {
      investigations: investigationList.refresh,
      investigationCollection: investigationCollection.refresh,
      investigation: activeInvestigation.refreshInvestigation,
      evidence: activeInvestigation.refreshEvidence,
      contributions: activeInvestigation.refreshContributions,
      lifecycle: activeInvestigation.refreshLifecycle,
      coordination: coordinationController.refresh,
      artifactAnnotations: artifactAnnotationsController.refresh,
      activeInvestigation: refreshAll,
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
      createContribution: canContribute
        && activeCaseId !== null
        && activeInvestigation.investigation.status === "ready"
        && !activeScopeUnavailable
        ? contributionController.create
        : null,
      updateSituation: canEditSituation
        && activeCaseId !== null
        && situationCase !== null
        && !activeScopeUnavailable
        ? situationController.update
        : null,
      applyLifecycle: canManageLifecycle && activeCaseId !== null
        && lifecycleValue !== null
        && !activeScopeUnavailable
        ? lifecycleController.apply
        : null,
      applyCoordinationAction: (canCoordinateSelf || canCoordinateParticipants)
        && activeReadyCaseId !== null
        && identity.id.length > 0
        && coordinationController.coordination.status === "ready"
        && !activeScopeUnavailable
        ? coordinationController.apply
        : null,
      createArtifactAnnotation: canContribute
        && activeReadyCaseId !== null
        && !activeScopeUnavailable
        ? artifactAnnotationController.create
        : null,
      createArtifactAnnotations: canContribute
        && activeReadyCaseId !== null
        && !activeScopeUnavailable
        ? artifactAnnotationsBulkController.create
        : null,
      queryInvestigations: capabilities.canRead ? requestInvestigationCollection : null,
    },
  }), [
    activeReadyCaseId,
    activeInvestigation.contributions,
    activeInvestigation.evidence,
    activeInvestigation.investigation,
    activeInvestigation.lifecycle,
    activeInvestigation.refreshAll,
    activeInvestigation.refreshContributions,
    activeInvestigation.refreshEvidence,
    activeInvestigation.refreshInvestigation,
    activeInvestigation.refreshLifecycle,
    artifactAnnotationsController.annotations,
    artifactAnnotationsController.refresh,
    activeInvestigation.scopeDenied,
    activeMissingFromAuthoritativeList,
    activeScopeUnavailable,
    active,
    activeCaseId,
    canContribute,
    canCoordinateParticipants,
    canCoordinateSelf,
    canCreate,
    canEditSituation,
    canManageLifecycle,
    canUpload,
    capabilities,
    contributionController.create,
    contributionController.state,
    createController.create,
    createController.state,
    artifactAnnotationController.create,
    artifactAnnotationController.state,
    artifactAnnotationsBulkController.create,
    artifactAnnotationsBulkController.state,
    identity,
    investigationCollection.page,
    investigationCollection.query,
    investigationCollection.refresh,
    investigationList.investigations,
    investigationList.refresh,
    requestInvestigationCollection,
    isInvestigationLocation,
    lifecycleController.apply,
    lifecycleController.state,
    coordinationController.apply,
    coordinationController.coordination,
    coordinationController.refresh,
    coordinationController.state,
    situationCase,
    situationController.state,
    situationController.update,
    uploadController.state,
    uploadController.upload,
    refreshAll,
    gateway.previewEvidence,
    previewController.clear,
    previewController.preview,
    previewController.state,
    presentationScopeKey,
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
