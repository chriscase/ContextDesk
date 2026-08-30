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
  CONTRIBUTION_LIST_SCHEMA_ID,
  CONTRIBUTION_SCHEMA_ID,
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
export type {
  InvestigationLifecycleActionSuccessV1,
  InvestigationLifecycleExpectedV1,
  InvestigationLifecycleV1,
  LifecycleAction,
  LifecycleRefusal,
} from "./investigation-lifecycle.js";
