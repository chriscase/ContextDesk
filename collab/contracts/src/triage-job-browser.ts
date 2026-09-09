/**
 * Browser-safe triage-job contract surface.
 *
 * This entry never re-exports the package root. Its implementation graph is
 * limited to strict parsing, privacy vocabulary, and lifecycle vocabulary;
 * request hashing and durable replay stay server-owned.
 */
export { ContractViolation } from "./parse.js";

export {
  TRIAGE_CANDIDATE_STATUSES,
  TRIAGE_JOB_CAPABILITIES_SCHEMA_ID,
  TRIAGE_JOB_LIST_SCHEMA_ID,
  TRIAGE_JOB_MODES,
  TRIAGE_JOB_REQUEST_SCHEMA_ID,
  TRIAGE_JOB_RERUN_AUTHORITY,
  TRIAGE_JOB_RERUN_IDEMPOTENCY,
  TRIAGE_JOB_RERUN_IDEMPOTENCY_KEY_MAX_LENGTH,
  TRIAGE_JOB_RERUN_IDEMPOTENCY_KEY_MIN_LENGTH,
  TRIAGE_JOB_RERUN_IDEMPOTENCY_KEY_RE,
  TRIAGE_JOB_RERUN_REFUSALS,
  TRIAGE_JOB_RERUN_REFUSAL_DETAIL_MAX_LENGTH,
  TRIAGE_JOB_RERUN_REFUSED_SCHEMA_ID,
  TRIAGE_JOB_RERUN_REQUEST_SCHEMA_ID,
  TRIAGE_JOB_RERUN_RESPONSE_CONTEXT,
  TRIAGE_JOB_RERUN_SHA256_RE,
  TRIAGE_JOB_RERUN_SUCCESS_SCHEMA_ID,
  TRIAGE_JOB_RERUN_UUID_RE,
  TRIAGE_JOB_SCHEMA_ID,
  TRIAGE_JOB_SHARE_SAFE_SCHEMA_ID,
  TRIAGE_JOB_STATUSES,
  parseTriageJob,
  parseTriageJobCapabilities,
  parseTriageJobList,
  parseTriageJobRequest,
  parseTriageJobRerunRefused,
  parseTriageJobRerunRequest,
  parseTriageJobRerunSuccess,
  parseTriageJobShareSafe,
  projectTriageJobShareSafe,
} from "./triage-job.js";
export type {
  TriageCandidateRunV1,
  TriageCandidateSpecV1,
  TriageCandidateStatus,
  TriageJobCapabilitiesV1,
  TriageJobListV1,
  TriageJobMode,
  TriageJobRequestV1,
  TriageJobRerunRefusal,
  TriageJobRerunRefusedV1,
  TriageJobRerunRequestV1,
  TriageJobRerunResponseContextV1,
  TriageJobRerunSuccessV1,
  TriageJobShareSafeCandidateV1,
  TriageJobShareSafeV1,
  TriageJobStatus,
  TriageJobV1,
} from "./triage-job.js";
