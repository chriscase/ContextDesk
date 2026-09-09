/**
 * Browser-safe contract surface for the shared investigation runtime.
 *
 * Keep this entry deliberately narrow. In particular, it must not re-export
 * the package root because that graph contains server-only hashing helpers.
 */
export { ContractViolation } from "./parse.js";

export {
  CASE_LIST_SCHEMA_ID,
  CASE_SCHEMA_ID,
  parseCase,
  parseCaseList,
} from "./case.js";
export type {
  CaseListV1,
  CaseV1,
  PrivacyClass,
} from "./case.js";

export {
  CONTRIBUTION_KINDS,
  CONTRIBUTION_LIST_SCHEMA_ID,
  CONTRIBUTION_SCHEMA_ID,
  isContributionIdempotencyKey,
  parseContribution,
  parseContributionList,
} from "./contribution.js";
export type {
  ContributionKind,
  ContributionListV1,
  ContributionV1,
} from "./contribution.js";

export {
  ARTIFACT_SCHEMA_ID,
  EVIDENCE_LIST_SCHEMA_ID,
  EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID,
  parseEvidenceList,
  parseEvidenceUploadSuccess,
} from "./artifact.js";
export type {
  ArtifactKind,
  ArtifactV1,
  EvidenceListV1,
  EvidenceUploadSuccessV1,
} from "./artifact.js";

export {
  REFERENCE_RECHECK_CHANGED_SCHEMA_ID,
  REFERENCE_RECHECK_CHANGE_REASONS,
  REFERENCE_RECHECK_IDEMPOTENCY,
  REFERENCE_RECHECK_LIMITS,
  REFERENCE_RECHECK_OUTCOMES,
  REFERENCE_RECHECK_PAGE_SCHEMA_ID,
  REFERENCE_RECHECK_REFUSED_SCHEMA_ID,
  REFERENCE_RECHECK_REFUSALS,
  REFERENCE_RECHECK_REQUEST_SCHEMA_ID,
  REFERENCE_RECHECK_RESPONSE_CONTEXT,
  REFERENCE_RECHECK_SCHEMA_ID,
  REFERENCE_RECHECK_SUCCESS_SCHEMA_ID,
  parseReferenceRecheck,
  parseReferenceRecheckChanged,
  parseReferenceRecheckPage,
  parseReferenceRecheckRefused,
  parseReferenceRecheckRequest,
  parseReferenceRecheckSuccess,
} from "./reference-recheck.js";
export type {
  ReferenceIdentityV1,
  ReferenceRecheckChangeReason,
  ReferenceRecheckChangedV1,
  ReferenceRecheckOutcome,
  ReferenceRecheckPageV1,
  ReferenceRecheckRefusal,
  ReferenceRecheckRefusedV1,
  ReferenceRecheckRequestV1,
  ReferenceRecheckSuccessV1,
  ReferenceRecheckV1,
} from "./reference-recheck.js";

export {
  PROVIDER_BOUND_REFERENCE_CONTEXT,
  PROVIDER_BOUND_REFERENCE_CREATE_SCHEMA_ID,
  PROVIDER_BOUND_REFERENCE_IDEMPOTENCY,
  PROVIDER_BOUND_REFERENCE_LIMITS,
  PROVIDER_BOUND_REFERENCE_PRIVATE_FIELDS,
  parseProviderBoundReferenceCreate,
} from "./provider-reference.js";
export type { ProviderBoundReferenceCreateV1 } from "./provider-reference.js";

export {
  INVESTIGATION_LIFECYCLE_ACTION_REFUSED_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_ACTION_REQUEST_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_CHANGED_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_SCHEMA_ID,
  parseInvestigationLifecycle,
  parseInvestigationLifecycleActionRefused,
  parseInvestigationLifecycleActionSuccess,
  parseInvestigationLifecycleChanged,
} from "./investigation-lifecycle.js";

export {
  INVESTIGATION_COORDINATION_ACTIONS,
  INVESTIGATION_COORDINATION_ACTION_REFUSED_SCHEMA_ID,
  INVESTIGATION_COORDINATION_ACTION_REQUEST_SCHEMA_ID,
  INVESTIGATION_COORDINATION_ACTION_SUCCESS_SCHEMA_ID,
  INVESTIGATION_COORDINATION_CHANGED_SCHEMA_ID,
  INVESTIGATION_COORDINATION_REFUSALS,
  INVESTIGATION_COORDINATION_SCHEMA_ID,
  parseInvestigationCoordination,
  parseInvestigationCoordinationActionRefused,
  parseInvestigationCoordinationActionRequest,
  parseInvestigationCoordinationActionSuccess,
  parseInvestigationCoordinationChanged,
} from "./investigation-coordination.js";
export type {
  InvestigationCoordinationAction,
  InvestigationCoordinationActionRefusedV1,
  InvestigationCoordinationActionRequestV1,
  InvestigationCoordinationActionSuccessV1,
  InvestigationCoordinationChangedV1,
  InvestigationCoordinationRefusal,
  InvestigationCoordinationV1,
  InvestigationCoordinatorIdentityV1,
} from "./investigation-coordination.js";
export type {
  InvestigationLifecycleActionSuccessV1,
  InvestigationLifecycleExpectedV1,
  InvestigationLifecycleV1,
  LifecycleAction,
  LifecycleRefusal,
} from "./investigation-lifecycle.js";
