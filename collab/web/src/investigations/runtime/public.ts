/**
 * The sole investigation-behavior import surface for UI strategies.
 * Transport, protected fetch, controller internals, and route construction are
 * deliberately absent.
 */
export {
  InvestigationRuntimeProvider,
  useInvestigationRuntime,
  type InvestigationContributionCommand,
  type InvestigationCoordinationActionCommand,
  type InvestigationArtifactAnnotationCommand,
  type InvestigationArtifactAnnotationsBulkCommand,
  type InvestigationCreateInput,
  type InvestigationEvidenceUploadCommand,
  type InvestigationEvidencePreviewCommand,
  type InvestigationRuntimeEvidencePreview,
  type InvestigationRuntime,
  type InvestigationRuntimeCommands,
  type InvestigationRuntimeIdentity,
  type InvestigationRuntimeMutations,
  type InvestigationRuntimeProviderProps,
  type InvestigationRuntimeRefresh,
  type InvestigationRuntimeResources,
  type InvestigationSituationCommand,
} from "./InvestigationRuntimeProvider.js";
export type {
  ArtifactAnnotationBulkItemV1,
  ArtifactAnnotationBulkOutcome,
  ArtifactAnnotationBulkRequestV1,
  ArtifactAnnotationBulkResultV1,
  ArtifactAnnotationListV1,
  ArtifactAnnotationV1,
} from "./annotation-contract.js";
export { MAX_ARTIFACT_ANNOTATION_BULK_IDS } from "./annotation-contract.js";
export {
  type EvidencePreviewValue,
  type InvestigationCollectionQueryInput,
  type PreviewEvidenceInput,
} from "./gateway.js";
export {
  selectEvidenceInventory,
  selectResourceView,
  type EvidenceInventoryView,
  type EvidenceWithAnnotation,
  type ResourceView,
} from "./selectors.js";
export {
  MAX_EVIDENCE_UPLOAD_BYTES,
  type CommandIgnoredReason,
  type CommandOutcome,
  type MutationState,
  type ResourceState,
} from "./types.js";
export type { InvestigationRuntimeCapabilities } from "./capabilities.js";
export type {
  ArtifactKind,
  ArtifactV1,
  CaseV1,
  ContributionKind,
  ContributionV1,
  EvidenceUploadSuccessV1,
  InvestigationLifecycleActionSuccessV1,
  InvestigationLifecycleV1,
  InvestigationCoordinationAction,
  InvestigationCoordinationActionSuccessV1,
  InvestigationCoordinationRefusal,
  InvestigationCoordinationV1,
  InvestigationCoordinatorIdentityV1,
  LifecycleAction,
  PrivacyClass,
} from "@cd-collab/contracts/investigation-runtime";
export type {
  InvestigationCollectionFacetsV1,
  InvestigationCollectionPageV1,
  InvestigationCollectionQueryV1,
  InvestigationCollectionStatusV1,
} from "@cd-collab/contracts/investigation-collection";
