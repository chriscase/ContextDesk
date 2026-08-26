import { checkObject, f, type ObjectShape } from "./parse.js";
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
import {
  TRIAGE_EVIDENCE_BUDGET_ERROR_CODE,
  type TriageEvidenceBudgetFailureV1,
} from "./triage-capacity.js";

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
  /**
   * Last durable lane movement — admission or settlement — and nothing else.
   *
   * Deliberately not `updatedAt`, which a lease heartbeat also bumps: a frozen
   * gateway keeps its worker heartbeating while no lane moves, so only a field
   * the heartbeat does not touch can tell a slow run from a stuck one. Omitted
   * by records written before this field existed.
   */
  lastProgressAt?: string | null;
  /**
   * Structured reason this run was refused or stopped, when one is known well
   * enough to name. Facts only; operator-facing text is rendered from them, so
   * no host or provider string is ever carried here.
   */
  failure?: TriageEvidenceBudgetFailureV1 | null;
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

/**
 * What the host can actually do, stated so an operator is never offered a
 * setting the host will later refuse.
 *
 * `gatewayMaxCandidates` is the executable ceiling, derived from the canonical
 * progress-event formula rather than written down beside it; the two used to
 * be independent numbers that disagreed, and a run inside the advertised
 * ceiling but outside the executable one was accepted and then killed.
 */
export interface TriageJobCapabilitiesV1 {
  schemaId: typeof TRIAGE_JOB_CAPABILITIES_SCHEMA_ID;
  syntheticAvailable: boolean;
  gatewayAvailable: boolean;
  gatewayMinCandidates: number;
  /** Executable, not merely acceptable: every count up to this one can run. */
  gatewayMaxCandidates: number;
  profileCatalogConfigured: boolean;
  profileCount: number;
  /** Durable progress events one lane emits; the basis of the run budget. */
  progressEventsPerLane: number;
  /** Progress events the largest advertised run is permitted to emit. */
  maxProgressEvents: number;
  maxEvidenceItemBytes: number;
  maxEvidenceAggregateBytes: number;
  /** True only where a cancel request durably stops further provider work. */
  cancellationSupported: boolean;
  retrySemantics: "explicit_rerun_idempotent";
  /** The host does not measure these; a reader must not be shown a guess. */
  usageAvailable: boolean;
  costAvailable: boolean;
  /** Plain-words list of what this deployment simply cannot report. */
  unavailable: string[];
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

const failureShape: ObjectShape = {
  code: f.req(f.en(TRIAGE_EVIDENCE_BUDGET_ERROR_CODE)),
  scope: f.req(f.en("item", "aggregate")),
  allowedBytes: f.req(f.u64),
  actualBytes: f.req(f.u64),
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
  lastProgressAt: f.optNul(f.str),
  failure: f.optNul(f.obj(failureShape)),
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
  progressEventsPerLane: f.req(f.u64),
  maxProgressEvents: f.req(f.u64),
  maxEvidenceItemBytes: f.req(f.u64),
  maxEvidenceAggregateBytes: f.req(f.u64),
  cancellationSupported: f.req(f.bool),
  retrySemantics: f.req(f.en("explicit_rerun_idempotent")),
  usageAvailable: f.req(f.bool),
  costAvailable: f.req(f.bool),
  unavailable: f.req(f.arr(f.str)),
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
