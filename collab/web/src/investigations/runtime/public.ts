/**
 * The sole investigation-behavior import surface for UI strategies.
 * Transport, protected fetch, controller internals, and route construction are
 * deliberately absent.
 */
export {
  InvestigationRuntimeProvider,
  useInvestigationRuntime,
  type InvestigationCreateInput,
  type InvestigationEvidenceUploadCommand,
  type InvestigationRuntime,
  type InvestigationRuntimeCommands,
  type InvestigationRuntimeIdentity,
  type InvestigationRuntimeMutations,
  type InvestigationRuntimeProviderProps,
  type InvestigationRuntimeRefresh,
  type InvestigationRuntimeResources,
} from "./InvestigationRuntimeProvider.js";
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
  ContributionV1,
  EvidenceUploadSuccessV1,
  InvestigationLifecycleActionSuccessV1,
  InvestigationLifecycleV1,
  LifecycleAction,
  PrivacyClass,
} from "@cd-collab/contracts/investigation-runtime";
