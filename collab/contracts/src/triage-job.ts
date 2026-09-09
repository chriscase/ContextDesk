import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import { PRIVACY_CLASSES } from "./case.js";
// The lifecycle vocabulary and its rules live in a dependency-free leaf module
// so a browser bundle can take them without the schema machinery, which
// transitively reaches Node built-ins. Re-exported here so every existing
// importer of this module is unaffected.
import {
  TRIAGE_CANDIDATE_STATUSES,
  TRIAGE_JOB_STATUSES,
  type TriageCandidateStatus,
  type TriageJobStatus,
} from "./triage-lifecycle.js";

export {
  TRIAGE_CANDIDATE_STATUSES,
  TRIAGE_JOB_STATUSES,
  TRIAGE_PRODUCING_CANDIDATE_STATUSES,
  TRIAGE_SETTLED_CANDIDATE_STATUSES,
  isTriageProducingStatus,
  isTriageSettledStatus,
  resolveTriageJobStatus,
  triageJobExecutionState,
  triageLanePhaseCounts,
} from "./triage-lifecycle.js";
export type {
  TriageCandidateStatus,
  TriageJobExecutionState,
  TriageJobStatus,
  TriageLanePhaseCountsV1,
} from "./triage-lifecycle.js";

export const TRIAGE_JOB_REQUEST_SCHEMA_ID = "cd-collab.triage_job_request.v1" as const;
export const TRIAGE_JOB_SCHEMA_ID = "cd-collab.triage_job.v1" as const;
export const TRIAGE_JOB_LIST_SCHEMA_ID = "cd-collab.triage_job_list.v1" as const;
export const TRIAGE_JOB_SHARE_SAFE_SCHEMA_ID = "cd-collab.triage_job_share_safe.v1" as const;
export const TRIAGE_JOB_CAPABILITIES_SCHEMA_ID = "cd-collab.triage_job_capabilities.v1" as const;
export const TRIAGE_JOB_RERUN_REQUEST_SCHEMA_ID =
  "cd-collab.triage_job_rerun_request.v1" as const;
export const TRIAGE_JOB_RERUN_SUCCESS_SCHEMA_ID =
  "cd-collab.triage_job_rerun_success.v1" as const;
export const TRIAGE_JOB_RERUN_REFUSED_SCHEMA_ID =
  "cd-collab.triage_job_rerun_refused.v1" as const;

export const TRIAGE_JOB_RERUN_REFUSALS = [
  "case_archived",
  "parent_not_terminal",
  "parent_request_changed",
  "target_snapshot_changed",
  "target_not_forward_descendant",
  "snapshot_lineage_invalid",
  "active_equivalent_exists",
  "execution_configuration_unavailable",
  "idempotency_intent_mismatch",
] as const;
export type TriageJobRerunRefusal =
  (typeof TRIAGE_JOB_RERUN_REFUSALS)[number];

export const TRIAGE_JOB_RERUN_IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const TRIAGE_JOB_RERUN_IDEMPOTENCY_KEY_MAX_LENGTH = 128;
export const TRIAGE_JOB_RERUN_REFUSAL_DETAIL_MAX_LENGTH = 600;
export const TRIAGE_JOB_RERUN_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const TRIAGE_JOB_RERUN_SHA256_RE = /^[0-9a-f]{64}$/;
export const TRIAGE_JOB_RERUN_IDEMPOTENCY_KEY_RE =
  /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;

/** Existing authority checked by the future strict rerun route before domain reads. */
export const TRIAGE_JOB_RERUN_AUTHORITY = Object.freeze({
  rerun: "run:strategies",
} as const);

/** Durable success-replay rules reserved for the strict server operation. */
export const TRIAGE_JOB_RERUN_IDEMPOTENCY = Object.freeze({
  lookupKey: Object.freeze([
    "caseId",
    "actorIdentityId",
    "idempotencyKey",
  ] as const),
  intentFields: Object.freeze([
    "caseId",
    "fromJobId",
    "targetSnapshotId",
    "expectedFromRequestFingerprint",
    "expectedTargetSnapshotFingerprint",
  ] as const),
  excludesFromIntent: Object.freeze(["idempotencyKey"] as const),
  replayBefore: Object.freeze([
    "archive",
    "parent_terminal_state",
    "snapshot_lineage",
    "execution_configuration",
    "cas",
  ] as const),
  persist: "successful_reruns_only" as const,
  uncertainOutcome: "freeze_exact_payload_and_idempotency_key_before_retry" as const,
});

/** Context callers must bind around parsed wire responses. */
export const TRIAGE_JOB_RERUN_RESPONSE_CONTEXT = Object.freeze({
  case: "response_case_equals_request_case_equals_route_case",
  parent: "response_from_job_equals_request_from_job_equals_route_from_job",
  target: "response_target_snapshot_equals_request_target_snapshot",
  successJob: "applied_case_parent_and_snapshot_equal_response_context",
} as const);

export const TRIAGE_JOB_MODES = ["deterministic_mock", "gateway"] as const;
export type TriageJobMode = (typeof TRIAGE_JOB_MODES)[number];


export interface TriageCandidateSpecV1 {
  candidateId: string;
  role: string;
  provider: string;
  /** Host-owned provider profile identity; never a credential. */
  profileId: string | null;
  model: string;
  version: string | null;
}

export interface TriageJobRequestV1 {
  schemaId: typeof TRIAGE_JOB_REQUEST_SCHEMA_ID;
  snapshotId: string;
  mode: TriageJobMode;
  strategyId: string;
  question: string;
  policyFingerprint: string | null;
  taskFingerprint: string;
  /** Gateway lane concurrency; omitted means the host default (2). */
  concurrency?: number;
  /** Optional lineage reference for an intentional rerun of a prior job. */
  parentJobId?: string;
  candidates: TriageCandidateSpecV1[];
}

export interface TriageCandidateRunV1 extends TriageCandidateSpecV1 {
  status: TriageCandidateStatus;
  /** Host-owned durable benchmark/run identity when a live bridge produced one. */
  benchmarkRunId: string | null;
  outputHash: string | null;
  summary: string | null;
  evidenceRefs: string[];
  unknowns: string[];
  usageStatus: "unknown";
  costStatus: "unknown";
  errorCode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  privacyClass: (typeof PRIVACY_CLASSES)[number];
}

export interface TriageJobV1 {
  schemaId: typeof TRIAGE_JOB_SCHEMA_ID;
  id: string;
  caseId: string;
  snapshotId: string;
  snapshotFingerprint: string;
  requestFingerprint: string;
  cancellationId: string;
  /** Present on newly-created jobs; optional for backwards-compatible stored jobs. */
  parentJobId?: string | null;
  request: TriageJobRequestV1;
  status: TriageJobStatus;
  candidates: TriageCandidateRunV1[];
  /** True only after the host proves the exact snapshot; null is unknown. */
  sameSnapshot: boolean | null;
  agreementNotice: "Agreement is not proof of correctness.";
  requestedBy: string;
  requestedByUsername: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  stoppedReason: string | null;
  /** Internal durable worker ownership; omitted by legacy records. */
  workerId?: string | null;
  /** Internal lease expiry; omitted by legacy records. */
  leaseExpiresAt?: string | null;
}

export interface TriageJobShareSafeCandidateV1 {
  candidateId: string;
  role: string;
  status: TriageCandidateStatus;
  evidenceCount: number;
  unknownCount: number;
  usageStatus: "unknown";
  costStatus: "unknown";
}

export interface TriageJobShareSafeV1 {
  schemaId: typeof TRIAGE_JOB_SHARE_SAFE_SCHEMA_ID;
  jobId: string;
  caseId: string;
  snapshotFingerprint: string;
  requestFingerprint: string;
  status: TriageJobStatus;
  candidates: TriageJobShareSafeCandidateV1[];
  sameSnapshot: boolean | null;
  agreementNotice: "Agreement is not proof of correctness.";
  cancellationRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TriageJobListV1 {
  schemaId: typeof TRIAGE_JOB_LIST_SCHEMA_ID;
  caseId: string;
  jobs: TriageJobV1[];
}

export interface TriageJobCapabilitiesV1 {
  schemaId: typeof TRIAGE_JOB_CAPABILITIES_SCHEMA_ID;
  syntheticAvailable: boolean;
  gatewayAvailable: boolean;
  gatewayMinCandidates: number;
  gatewayMaxCandidates: number;
  profileCatalogConfigured: boolean;
  profileCount: number;
}

export interface TriageJobRerunRequestV1 {
  schemaId: typeof TRIAGE_JOB_RERUN_REQUEST_SCHEMA_ID;
  caseId: string;
  fromJobId: string;
  targetSnapshotId: string;
  expectedFromRequestFingerprint: string;
  expectedTargetSnapshotFingerprint: string;
  idempotencyKey: string;
}

export interface TriageJobRerunResponseContextV1 {
  caseId: string;
  fromJobId: string;
  targetSnapshotId: string;
}

export interface TriageJobRerunSuccessV1 {
  schemaId: typeof TRIAGE_JOB_RERUN_SUCCESS_SCHEMA_ID;
  caseId: string;
  fromJobId: string;
  targetSnapshotId: string;
  applied: TriageJobV1;
  replayed: boolean;
}

export interface TriageJobRerunRefusedV1 {
  schemaId: typeof TRIAGE_JOB_RERUN_REFUSED_SCHEMA_ID;
  error: "triage_job_rerun_refused";
  caseId: string;
  fromJobId: string;
  targetSnapshotId: string;
  reason: TriageJobRerunRefusal;
  detail: string;
}

const candidateSpecShape: ObjectShape = {
  candidateId: f.req(f.str),
  role: f.req(f.str),
  provider: f.req(f.str),
  profileId: f.nul(f.str),
  model: f.req(f.str),
  version: f.nul(f.str),
};

const requestShape: ObjectShape = {
  schemaId: f.req(f.en(TRIAGE_JOB_REQUEST_SCHEMA_ID)),
  snapshotId: f.req(f.str),
  mode: f.req(f.en(...TRIAGE_JOB_MODES)),
  strategyId: f.req(f.str),
  question: f.req(f.str),
  policyFingerprint: f.nul(f.str),
  taskFingerprint: f.req(f.str),
  concurrency: f.opt(f.u64),
  parentJobId: f.opt(f.str),
  candidates: f.req(f.arr(f.obj(candidateSpecShape))),
};

const candidateRunShape: ObjectShape = {
  ...candidateSpecShape,
  status: f.req(f.en(...TRIAGE_CANDIDATE_STATUSES)),
  benchmarkRunId: f.nul(f.str),
  outputHash: f.nul(f.str),
  summary: f.nul(f.str),
  evidenceRefs: f.req(f.arr(f.str)),
  unknowns: f.req(f.arr(f.str)),
  usageStatus: f.req(f.en("unknown")),
  costStatus: f.req(f.en("unknown")),
  errorCode: f.nul(f.str),
  startedAt: f.nul(f.str),
  finishedAt: f.nul(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
};

const jobShape: ObjectShape = {
  schemaId: f.req(f.en(TRIAGE_JOB_SCHEMA_ID)),
  id: f.req(f.str),
  caseId: f.req(f.str),
  snapshotId: f.req(f.str),
  snapshotFingerprint: f.req(f.str),
  requestFingerprint: f.req(f.str),
  cancellationId: f.req(f.str),
  parentJobId: f.opt(f.str),
  request: f.req(f.obj(requestShape)),
  status: f.req(f.en(...TRIAGE_JOB_STATUSES)),
  candidates: f.req(f.arr(f.obj(candidateRunShape))),
  sameSnapshot: f.nul(f.bool),
  agreementNotice: f.req(f.en("Agreement is not proof of correctness.")),
  requestedBy: f.req(f.str),
  requestedByUsername: f.req(f.str),
  createdAt: f.req(f.str),
  updatedAt: f.req(f.str),
  startedAt: f.nul(f.str),
  finishedAt: f.nul(f.str),
  cancelRequestedAt: f.nul(f.str),
  stoppedReason: f.nul(f.str),
  workerId: f.optNul(f.str),
  leaseExpiresAt: f.optNul(f.str),
};

const jobListShape: ObjectShape = {
  schemaId: f.req(f.en(TRIAGE_JOB_LIST_SCHEMA_ID)),
  caseId: f.req(f.str),
  jobs: f.req(f.arr(f.obj(jobShape))),
};

const capabilitiesShape: ObjectShape = {
  schemaId: f.req(f.en(TRIAGE_JOB_CAPABILITIES_SCHEMA_ID)),
  syntheticAvailable: f.req(f.bool),
  gatewayAvailable: f.req(f.bool),
  gatewayMinCandidates: f.req(f.u64),
  gatewayMaxCandidates: f.req(f.u64),
  profileCatalogConfigured: f.req(f.bool),
  profileCount: f.req(f.u64),
};

const shareSafeCandidateShape: ObjectShape = {
  candidateId: f.req(f.str),
  role: f.req(f.str),
  status: f.req(f.en(...TRIAGE_CANDIDATE_STATUSES)),
  evidenceCount: f.req(f.u64),
  unknownCount: f.req(f.u64),
  usageStatus: f.req(f.en("unknown")),
  costStatus: f.req(f.en("unknown")),
};

const shareSafeShape: ObjectShape = {
  schemaId: f.req(f.en(TRIAGE_JOB_SHARE_SAFE_SCHEMA_ID)),
  jobId: f.req(f.str),
  caseId: f.req(f.str),
  snapshotFingerprint: f.req(f.str),
  requestFingerprint: f.req(f.str),
  status: f.req(f.en(...TRIAGE_JOB_STATUSES)),
  candidates: f.req(f.arr(f.obj(shareSafeCandidateShape))),
  sameSnapshot: f.nul(f.bool),
  agreementNotice: f.req(f.en("Agreement is not proof of correctness.")),
  cancellationRequested: f.req(f.bool),
  createdAt: f.req(f.str),
  startedAt: f.nul(f.str),
  finishedAt: f.nul(f.str),
};

const rerunRequestShape: ObjectShape = {
  schemaId: f.req(f.en(TRIAGE_JOB_RERUN_REQUEST_SCHEMA_ID)),
  caseId: f.req(f.nstr),
  fromJobId: f.req(f.nstr),
  targetSnapshotId: f.req(f.nstr),
  expectedFromRequestFingerprint: f.req(f.nstr),
  expectedTargetSnapshotFingerprint: f.req(f.nstr),
  idempotencyKey: f.req(f.nstr),
};

const rerunResponseContextShape: ObjectShape = {
  caseId: f.req(f.nstr),
  fromJobId: f.req(f.nstr),
  targetSnapshotId: f.req(f.nstr),
};

const rerunSuccessShape: ObjectShape = {
  schemaId: f.req(f.en(TRIAGE_JOB_RERUN_SUCCESS_SCHEMA_ID)),
  caseId: f.req(f.nstr),
  fromJobId: f.req(f.nstr),
  targetSnapshotId: f.req(f.nstr),
  applied: f.req(f.obj(jobShape)),
  replayed: f.req(f.bool),
};

const rerunRefusedShape: ObjectShape = {
  schemaId: f.req(f.en(TRIAGE_JOB_RERUN_REFUSED_SCHEMA_ID)),
  error: f.req(f.en("triage_job_rerun_refused")),
  caseId: f.req(f.nstr),
  fromJobId: f.req(f.nstr),
  targetSnapshotId: f.req(f.nstr),
  reason: f.req(f.en(...TRIAGE_JOB_RERUN_REFUSALS)),
  detail: f.req(f.nstr),
};

function requireRerunUuid(value: string, path: string): string {
  if (!TRIAGE_JOB_RERUN_UUID_RE.test(value)) {
    throw new ContractViolation(path, "expected a canonical lower-case RFC 4122 UUID");
  }
  return value;
}

function requireRerunFingerprint(value: string, path: string): string {
  if (!TRIAGE_JOB_RERUN_SHA256_RE.test(value)) {
    throw new ContractViolation(path, "expected a lower-case SHA-256 fingerprint");
  }
  return value;
}

function requireRerunIdempotencyKey(value: string): string {
  if (!TRIAGE_JOB_RERUN_IDEMPOTENCY_KEY_RE.test(value)) {
    throw new ContractViolation("$.idempotencyKey", "must be 8..128 safe characters");
  }
  return value;
}

function hasRerunUnsafeCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
    if (code >= 0x200b && code <= 0x200f) return true;
    if (code >= 0x2028 && code <= 0x202f) return true;
    if (code >= 0x2060 && code <= 0x206f) return true;
    if (code === 0xfeff) return true;
  }
  return false;
}

function requireRerunDetail(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length === 0 ||
    normalized.length > TRIAGE_JOB_RERUN_REFUSAL_DETAIL_MAX_LENGTH ||
    hasRerunUnsafeCharacters(normalized)
  ) {
    throw new ContractViolation(
      "$.detail",
      `must be safe text of 1..${TRIAGE_JOB_RERUN_REFUSAL_DETAIL_MAX_LENGTH} characters`,
    );
  }
  return normalized;
}

function deepFrozenCopy<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => deepFrozenCopy(item))) as T;
  }
  if (typeof value === "object" && value !== null) {
    const copy = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, deepFrozenCopy(item)]),
    );
    return Object.freeze(copy) as T;
  }
  return value;
}

function parseRerunResponseContext(
  raw: unknown,
): TriageJobRerunResponseContextV1 {
  checkObject("$context", rerunResponseContextShape, raw);
  const context = raw as TriageJobRerunResponseContextV1;
  return {
    caseId: requireRerunUuid(context.caseId, "$context.caseId"),
    fromJobId: requireRerunUuid(context.fromJobId, "$context.fromJobId"),
    targetSnapshotId: requireRerunUuid(
      context.targetSnapshotId,
      "$context.targetSnapshotId",
    ),
  };
}

function assertRerunContextIdentity(
  value: TriageJobRerunResponseContextV1,
  context: TriageJobRerunResponseContextV1,
): void {
  if (value.caseId !== context.caseId) {
    throw new ContractViolation("$.caseId", "must match the trusted response context");
  }
  if (value.fromJobId !== context.fromJobId) {
    throw new ContractViolation("$.fromJobId", "must match the trusted response context");
  }
  if (value.targetSnapshotId !== context.targetSnapshotId) {
    throw new ContractViolation(
      "$.targetSnapshotId",
      "must match the trusted response context",
    );
  }
}

/**
 * Parse one strict rerun intent. The future server resolves every executable
 * field from the recorded parent job; callers supply only identities and CAS
 * fingerprints. Hashing and authorization deliberately remain server-side.
 */
export function parseTriageJobRerunRequest(
  raw: unknown,
): TriageJobRerunRequestV1 {
  checkObject("$", rerunRequestShape, raw);
  const request = raw as TriageJobRerunRequestV1;
  return deepFrozenCopy({
    schemaId: TRIAGE_JOB_RERUN_REQUEST_SCHEMA_ID,
    caseId: requireRerunUuid(request.caseId, "$.caseId"),
    fromJobId: requireRerunUuid(request.fromJobId, "$.fromJobId"),
    targetSnapshotId: requireRerunUuid(
      request.targetSnapshotId,
      "$.targetSnapshotId",
    ),
    expectedFromRequestFingerprint: requireRerunFingerprint(
      request.expectedFromRequestFingerprint,
      "$.expectedFromRequestFingerprint",
    ),
    expectedTargetSnapshotFingerprint: requireRerunFingerprint(
      request.expectedTargetSnapshotFingerprint,
      "$.expectedTargetSnapshotFingerprint",
    ),
    idempotencyKey: requireRerunIdempotencyKey(request.idempotencyKey),
  });
}

/**
 * Parse a strict success and bind its complete job projection to trusted route
 * and request context. The returned tree is a detached deeply frozen copy.
 */
export function parseTriageJobRerunSuccess(
  raw: unknown,
  rawContext: unknown,
): TriageJobRerunSuccessV1 {
  checkObject("$", rerunSuccessShape, raw);
  const success = raw as TriageJobRerunSuccessV1;
  const context = parseRerunResponseContext(rawContext);
  const identity = {
    caseId: requireRerunUuid(success.caseId, "$.caseId"),
    fromJobId: requireRerunUuid(success.fromJobId, "$.fromJobId"),
    targetSnapshotId: requireRerunUuid(
      success.targetSnapshotId,
      "$.targetSnapshotId",
    ),
  };
  assertRerunContextIdentity(identity, context);
  const applied = parseTriageJob(success.applied);
  requireRerunUuid(applied.id, "$.applied.id");
  requireRerunUuid(applied.cancellationId, "$.applied.cancellationId");
  requireRerunFingerprint(
    applied.snapshotFingerprint,
    "$.applied.snapshotFingerprint",
  );
  requireRerunFingerprint(
    applied.requestFingerprint,
    "$.applied.requestFingerprint",
  );
  if (applied.caseId !== identity.caseId) {
    throw new ContractViolation("$.applied.caseId", "must match root caseId");
  }
  if (applied.id === identity.fromJobId) {
    throw new ContractViolation(
      "$.applied.id",
      "strict rerun job must differ from root fromJobId",
    );
  }
  if (
    applied.snapshotId !== identity.targetSnapshotId ||
    applied.request.snapshotId !== identity.targetSnapshotId
  ) {
    throw new ContractViolation(
      "$.applied.snapshotId",
      "job and request snapshotId must match root targetSnapshotId",
    );
  }
  if (
    applied.parentJobId !== identity.fromJobId ||
    applied.request.parentJobId !== identity.fromJobId
  ) {
    throw new ContractViolation(
      "$.applied.parentJobId",
      "job and request parentJobId must match root fromJobId",
    );
  }
  return deepFrozenCopy({
    schemaId: TRIAGE_JOB_RERUN_SUCCESS_SCHEMA_ID,
    ...identity,
    applied,
    replayed: success.replayed,
  });
}

/** Parse a bounded refusal and bind it to trusted route/request context. */
export function parseTriageJobRerunRefused(
  raw: unknown,
  rawContext: unknown,
): TriageJobRerunRefusedV1 {
  checkObject("$", rerunRefusedShape, raw);
  const refused = raw as TriageJobRerunRefusedV1;
  const context = parseRerunResponseContext(rawContext);
  const identity = {
    caseId: requireRerunUuid(refused.caseId, "$.caseId"),
    fromJobId: requireRerunUuid(refused.fromJobId, "$.fromJobId"),
    targetSnapshotId: requireRerunUuid(
      refused.targetSnapshotId,
      "$.targetSnapshotId",
    ),
  };
  assertRerunContextIdentity(identity, context);
  return deepFrozenCopy({
    schemaId: TRIAGE_JOB_RERUN_REFUSED_SCHEMA_ID,
    error: "triage_job_rerun_refused",
    ...identity,
    reason: refused.reason,
    detail: requireRerunDetail(refused.detail),
  });
}

export function parseTriageJobRequest(raw: unknown): TriageJobRequestV1 {
  checkObject("$", requestShape, raw);
  return raw as TriageJobRequestV1;
}

export function parseTriageJob(raw: unknown): TriageJobV1 {
  checkObject("$", jobShape, raw);
  return raw as TriageJobV1;
}

export function parseTriageJobList(raw: unknown): TriageJobListV1 {
  checkObject("$", jobListShape, raw);
  return raw as TriageJobListV1;
}

export function parseTriageJobCapabilities(raw: unknown): TriageJobCapabilitiesV1 {
  checkObject("$", capabilitiesShape, raw);
  return raw as TriageJobCapabilitiesV1;
}

export function parseTriageJobShareSafe(raw: unknown): TriageJobShareSafeV1 {
  checkObject("$", shareSafeShape, raw);
  return raw as TriageJobShareSafeV1;
}

export function projectTriageJobShareSafe(job: TriageJobV1): TriageJobShareSafeV1 {
  return {
    schemaId: TRIAGE_JOB_SHARE_SAFE_SCHEMA_ID,
    jobId: job.id,
    caseId: job.caseId,
    snapshotFingerprint: job.snapshotFingerprint,
    requestFingerprint: job.requestFingerprint,
    status: job.status,
    candidates: job.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      role: candidate.role,
      status: candidate.status,
      evidenceCount: candidate.evidenceRefs.length,
      unknownCount: candidate.unknowns.length,
      usageStatus: "unknown",
      costStatus: "unknown",
    })),
    sameSnapshot: job.sameSnapshot,
    agreementNotice: "Agreement is not proof of correctness.",
    cancellationRequested: job.cancelRequestedAt !== null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}
