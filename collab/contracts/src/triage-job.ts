import { createHash } from "node:crypto";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import { PRIVACY_CLASSES } from "./case.js";

export const TRIAGE_JOB_REQUEST_SCHEMA_ID = "cd-collab.triage_job_request.v1" as const;
export const TRIAGE_JOB_CREATE_REQUEST_SCHEMA_ID = "cd-collab.triage_job_create_request.v1" as const;
export const TRIAGE_JOB_SCHEMA_ID = "cd-collab.triage_job.v1" as const;
export const TRIAGE_JOB_LIST_SCHEMA_ID = "cd-collab.triage_job_list.v1" as const;
export const TRIAGE_JOB_SHARE_SAFE_SCHEMA_ID = "cd-collab.triage_job_share_safe.v1" as const;
export const TRIAGE_JOB_CAPABILITIES_SCHEMA_ID = "cd-collab.triage_job_capabilities.v1" as const;

export const TRIAGE_JOB_MODES = ["deterministic_mock", "gateway"] as const;
export type TriageJobMode = (typeof TRIAGE_JOB_MODES)[number];

export const TRIAGE_JOB_STATUSES = [
  "queued",
  "running",
  "completed",
  "partial",
  "failed",
  "timed_out",
  "cancelled",
] as const;
export type TriageJobStatus = (typeof TRIAGE_JOB_STATUSES)[number];

export const TRIAGE_CANDIDATE_STATUSES = TRIAGE_JOB_STATUSES;
export type TriageCandidateStatus = TriageJobStatus;

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
  candidates: TriageCandidateSpecV1[];
}

/** HTTP create body for copying execution inputs onto a new frozen snapshot. */
export interface TriageFromJobRequestV1 {
  schemaId: typeof TRIAGE_JOB_CREATE_REQUEST_SCHEMA_ID;
  fromJobId: string;
  snapshotId: string;
  mode: TriageJobMode;
}

/** Versioned HTTP create union. The stable job-request parser remains v1-compatible. */
export type TriageJobCreateRequestV1 = TriageJobRequestV1 | TriageFromJobRequestV1;

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
  candidates: f.req(f.arr(f.obj(candidateSpecShape))),
};

const fromJobRequestShape: ObjectShape = {
  schemaId: f.req(f.en(TRIAGE_JOB_CREATE_REQUEST_SCHEMA_ID)),
  fromJobId: f.req(f.str),
  snapshotId: f.req(f.str),
  mode: f.req(f.en(...TRIAGE_JOB_MODES)),
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
  parentJobId: f.optNul(f.str),
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

export function isTriageFromJobRequest(
  request: TriageJobCreateRequestV1,
): request is TriageFromJobRequestV1 {
  return request.schemaId === TRIAGE_JOB_CREATE_REQUEST_SCHEMA_ID;
}

export function parseTriageJobRequest(raw: unknown): TriageJobRequestV1 {
  checkObject("$", requestShape, raw);
  return raw as TriageJobRequestV1;
}

export function parseTriageJobCreateRequest(raw: unknown): TriageJobCreateRequestV1 {
  if (
    raw
    && typeof raw === "object"
    && !Array.isArray(raw)
    && (raw as { schemaId?: unknown }).schemaId === TRIAGE_JOB_CREATE_REQUEST_SCHEMA_ID
  ) {
    checkObject("$", fromJobRequestShape, raw);
    return raw as TriageFromJobRequestV1;
  }
  return parseTriageJobRequest(raw);
}

/**
 * Candidates must be fingerprinted with an explicit field order. PostgreSQL
 * jsonb reorders object keys; spreading the row back into JSON.stringify would
 * otherwise change the digest after createOrReturn/get round-trips.
 */
function canonicalTriageCandidateSpec(
  candidate: TriageCandidateSpecV1,
): TriageCandidateSpecV1 {
  return {
    candidateId: candidate.candidateId,
    role: candidate.role,
    provider: candidate.provider,
    profileId: candidate.profileId,
    model: candidate.model,
    version: candidate.version,
  };
}

export function triageJobRequestFingerprint(
  snapshotFingerprint: string,
  request: TriageJobRequestV1,
): string {
  const candidates = [...request.candidates]
    .map(canonicalTriageCandidateSpec)
    .sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  return createHash("sha256").update(
    JSON.stringify({
      snapshotFingerprint,
      mode: request.mode,
      concurrency: request.concurrency ?? null,
      strategyId: request.strategyId,
      question: request.question,
      policyFingerprint: request.policyFingerprint,
      taskFingerprint: request.taskFingerprint,
      candidates,
    }),
    "utf8",
  ).digest("hex");
}

export function parseTriageJob(raw: unknown): TriageJobV1 {
  checkObject("$", jobShape, raw);
  const job = raw as TriageJobV1;
  parseTriageJobRequest(job.request);
  const sha256Hex = /^[a-f0-9]{64}$/;
  if (!sha256Hex.test(job.snapshotFingerprint)) {
    throw new ContractViolation(
      "$.snapshotFingerprint",
      "expected a lowercase SHA-256 hex digest",
    );
  }
  if (!sha256Hex.test(job.requestFingerprint)) {
    throw new ContractViolation(
      "$.requestFingerprint",
      "expected a lowercase SHA-256 hex digest",
    );
  }
  if (job.request.snapshotId !== job.snapshotId) {
    throw new ContractViolation(
      "$.request.snapshotId",
      "must match the persisted job snapshotId",
    );
  }
  const expectedRequestFingerprint = triageJobRequestFingerprint(
    job.snapshotFingerprint,
    job.request,
  );
  if (job.requestFingerprint !== expectedRequestFingerprint) {
    throw new ContractViolation(
      "$.requestFingerprint",
      "must match the canonical triage request fingerprint",
    );
  }
  if (typeof job.parentJobId === "string") {
    if (!job.parentJobId.trim()) {
      throw new ContractViolation("$.parentJobId", "must not be empty when present");
    }
    if (job.parentJobId === job.id) {
      throw new ContractViolation("$.parentJobId", "must not reference the job itself");
    }
  }
  return job;
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
