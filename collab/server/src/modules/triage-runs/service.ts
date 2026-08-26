import { createHash, randomUUID } from "node:crypto";
import {
  TRIAGE_JOB_SCHEMA_ID,
  TRIAGE_JOB_CAPABILITIES_SCHEMA_ID,
  TRIAGE_EVIDENCE_BUDGET_ERROR_CODE,
  TRIAGE_EXECUTABLE_MAX_CANDIDATES,
  TRIAGE_MAX_EVIDENCE_AGGREGATE_BYTES,
  TRIAGE_MAX_EVIDENCE_ITEM_BYTES,
  TRIAGE_MAX_PROGRESS_EVENTS,
  TRIAGE_MIN_GATEWAY_CANDIDATES,
  TRIAGE_PROGRESS_EVENTS_PER_LANE,
  checkTriageCandidateCapacity,
  checkTriageEvidenceBudget,
  triageEvidenceBudgetExplanation,
  snapshotFairness,
  snapshotFingerprint,
  snapshotFingerprintDigest,
  snapshotItemContentHash,
  resolveTriageJobStatus,
  type CaseV1,
  type TriageJobMode,
  type TriageJobCapabilitiesV1,
  type SnapshotV1,
  type TriageCandidateRunV1,
  type TriageCandidateSpecV1,
  type TriageJobRequestV1,
  type TriageJobStatus,
  type TriageJobV1,
  type TriageEvidenceBudgetFailureV1,
  type AppRole,
} from "@cd-collab/contracts";
import type { RecoveryAuthResult, RecoveryInactiveReason } from "../authz/index.js";
import type { AuditStore } from "../audit/index.js";
import type { Actor, CaseService } from "../cases/index.js";
import type { OverviewJobQuery, OverviewListedJob, TriageJobStore } from "./store.js";
import {
  laterLeaseExpiresAt,
  MemoryTriageJobStore,
  triageRunningLeaseExpired,
  triageWorkerHoldsLiveLease,
} from "./store.js";
import type { TriageProfileOption } from "./profiles.js";
import { ModelPurposePolicyConflictError, ModelPurposePolicyService } from "../model-policy/index.js";

export type TriageRecoveryAuthorization = (
  requester: { id: string; username: string },
) => Promise<RecoveryAuthResult>;

export type RecoveryRefusalReason =
  | "requester_not_member"
  | "requester_suspended"
  | "requester_disabled"
  | "requester_historical"
  | "requester_inactive"
  | "requester_run_revoked"
  | "requester_private_read_revoked"
  | "requester_unauthorized"
  | "recovery_authorization_unavailable";

// Capacity and evidence bounds are not written here. They come from the one
// canonical module the launcher also reads, so an advertised limit and an
// enforced limit cannot drift apart again.
const DEFAULT_GATEWAY_CONCURRENCY = 2;
const MAX_GATEWAY_CONCURRENCY = 4;
const DEFAULT_WORKER_LEASE_MS = 60_000;
const WORKER_HEARTBEAT_MS = 20_000;
const AGREEMENT_NOTICE = "Agreement is not proof of correctness." as const;

function evaluateSameSnapshot(snapshot: SnapshotV1): boolean | null {
  const claimed = snapshotFingerprintDigest(snapshot.fingerprint);
  if (!claimed) return null;
  if (snapshot.fairnessClass !== "same_snapshot") return null;
  if (snapshotFairness(snapshot.evidence) !== "same_snapshot") return null;
  if (!snapshot.evidence.every((item) => snapshotItemContentHash(item) !== null)) return null;
  const actual = snapshotFingerprintDigest(
    snapshotFingerprint({
      parentSnapshotId: snapshot.parentSnapshotId,
      evidence: snapshot.evidence,
      visibility: snapshot.visibility,
      protocolVersion: snapshot.protocolVersion,
    }),
  );
  if (!actual) return null;
  return actual === claimed;
}

export class TriageRunNotFoundError extends Error {
  constructor() {
    super("triage job not found");
    this.name = "TriageRunNotFoundError";
  }
}

export class TriageRunConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriageRunConflictError";
  }
}

/**
 * The frozen evidence for this run is larger than the host will send.
 *
 * Distinct from every other runner failure on purpose. This one is decided
 * entirely on the host, before a byte reaches a gateway, and it is not
 * transient: the same run retried is refused again for the same reason. It
 * used to collapse into a generic runner error, which told the operator only
 * that something broke somewhere and invited exactly the retry that cannot
 * work. The bound and the actual size travel with it so the run record can say
 * what to trim without re-deriving anything.
 */
export class TriageEvidenceBudgetExceededError extends Error {
  constructor(readonly failure: TriageEvidenceBudgetFailureV1) {
    super(triageEvidenceBudgetExplanation(failure));
    this.name = "TriageEvidenceBudgetExceededError";
  }
}

export interface TriageExecutionContext {
  jobId: string;
  mode: TriageJobMode;
  snapshot: SnapshotV1;
  strategyId: string;
  question: string;
  taskFingerprint: string;
  policyFingerprint: string | null;
  evidence: TriageExecutionEvidence[];
  candidate: TriageCandidateSpecV1;
}

export interface TriageExecutionEvidence {
  evidenceId: string;
  ordinal: number;
  contentHash: string | null;
  mediaType: string | null;
  privacyClass: "owner_only" | "share_safe";
  byteLength: number | null;
  contentBase64: string | null;
}

export interface TriageRunExecutor {
  execute(
    context: TriageExecutionContext,
    signal: AbortSignal,
  ): Promise<TriageCandidateRunV1>;
}

export interface TriageBatchExecutionContext {
  jobId: string;
  requestedBy: string;
  createdAt: string;
  case: CaseV1;
  snapshot: SnapshotV1;
  request: TriageJobRequestV1;
  evidence: TriageExecutionEvidence[];
  /** Called when the host admits a lane to bounded execution. */
  onCandidateStarted?: (candidateId: string) => void | Promise<void>;
  /** Called only for a host-validated, durably persisted lane. */
  onCandidate?: (result: TriageCandidateRunV1) => void | Promise<void>;
}

export interface TriageBatchRunExecutor {
  executeBatch(
    context: TriageBatchExecutionContext,
    signal: AbortSignal,
  ): Promise<TriageCandidateRunV1[]>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requestFingerprint(snapshotFingerprint: string, request: TriageJobRequestV1): string {
  const candidates = [...request.candidates]
    .sort((a, b) => a.candidateId.localeCompare(b.candidateId))
    .map((candidate) => ({ ...candidate }));
  return sha256(
    JSON.stringify({
      snapshotFingerprint,
      mode: request.mode,
      concurrency: request.concurrency ?? null,
      strategyId: request.strategyId,
      question: request.question,
      policyFingerprint: request.policyFingerprint,
      taskFingerprint: request.taskFingerprint,
      candidates: candidates.map((candidate) => ({ ...candidate, profileId: candidate.profileId })),
    }),
  );
}

function emptyCandidate(spec: TriageCandidateSpecV1): TriageCandidateRunV1 {
  return {
    ...spec,
    status: "queued",
    benchmarkRunId: null,
    outputHash: null,
    summary: null,
    evidenceRefs: [],
    unknowns: [],
    usageStatus: "unknown",
    costStatus: "unknown",
    errorCode: null,
    startedAt: null,
    finishedAt: null,
    privacyClass: "owner_only",
  };
}

function now(): string {
  return new Date().toISOString();
}

function isTerminal(status: TriageJobStatus): boolean {
  return status === "completed" || status === "partial" || status === "failed" || status === "timed_out" || status === "cancelled";
}

/**
 * An in-flight attempt that is indistinguishable from this one, if any.
 *
 * A slow gateway gives the operator no visible progress for minutes, so the
 * natural reaction — reload, launch again — silently doubles the provider work
 * against the same frozen snapshot and leaves two records competing to answer
 * one question.
 *
 * Attempt identity is the request fingerprint *and* the declared lineage, not
 * the fingerprint alone. An explicit rerun names its parent, which makes it an
 * informed second attempt rather than an accidental repeat; two submissions
 * that declare the same lineage (or none) are the accident this guards. A job
 * whose worker lease has already expired is excluded: that one is headed for
 * stale-run recovery and must not block a genuine retry.
 */
function activeDuplicateJob(
  jobs: readonly TriageJobV1[],
  attempt: { requestFingerprint: string; parentJobId: string | null },
  nowMs: number,
): TriageJobV1 | null {
  return jobs.find((job) =>
    job.requestFingerprint === attempt.requestFingerprint
    && (job.parentJobId ?? null) === attempt.parentJobId
    && !isTerminal(job.status)
    && !triageRunningLeaseExpired(job, nowMs),
  ) ?? null;
}

function snapshotRequiresPrivateRead(snapshot: SnapshotV1): boolean {
  return snapshot.visibility === "owner_only"
    || snapshot.evidence.some((item) => item.privacyClass === "owner_only");
}

function inactiveRecoveryReason(reason: RecoveryInactiveReason): RecoveryRefusalReason {
  switch (reason) {
    case "suspended":
      return "requester_suspended";
    case "disabled":
      return "requester_disabled";
    case "imported_historical":
      return "requester_historical";
    case "missing_profile":
      return "requester_inactive";
  }
}

function recoveryRefusalCopy(reason: RecoveryRefusalReason): { unknown: string } {
  switch (reason) {
    case "requester_not_member":
      return { unknown: "requester is no longer a case member" };
    case "requester_suspended":
      return { unknown: "requester is suspended" };
    case "requester_disabled":
      return { unknown: "requester is disabled" };
    case "requester_historical":
      return { unknown: "requester is an imported historical identity" };
    case "requester_inactive":
      return { unknown: "requester is not an active authorized profile" };
    case "requester_run_revoked":
      return { unknown: "requester is no longer permitted to run strategies" };
    case "requester_private_read_revoked":
      return { unknown: "requester is no longer permitted to read private evidence" };
    case "requester_unauthorized":
      return { unknown: "requester is no longer authorized to recover this job" };
    case "recovery_authorization_unavailable":
      return { unknown: "recovery authorization store is unavailable" };
  }
}

/**
 * One lifecycle rule, shared with the contracts package and the web reader.
 *
 * The rule this delegation replaced reported `partial` for a run in which no
 * lane produced anything — a slow or unreliable gateway that timed one lane out
 * and errored another read as "partial results", and the reader was offered a
 * review of results that did not exist.
 */
function terminalStatus(candidates: TriageCandidateRunV1[], cancelled: boolean): TriageJobStatus {
  return resolveTriageJobStatus(candidates, cancelled);
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("execution cancelled"));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** A deterministic, provider-free executor for demos and contract tests. */
export class DeterministicMockTriageExecutor implements TriageRunExecutor {
  async execute(
    context: TriageExecutionContext,
    signal: AbortSignal,
  ): Promise<TriageCandidateRunV1> {
    const startedAt = now();
    await waitFor(5, signal);
    // This executor proves orchestration only. It deliberately reads no
    // evidence bytes and contacts no model, so it must never fabricate a
    // citation merely because an item was present in the frozen snapshot.
    const evidenceRefs: string[] = [];
    const outputHash = sha256(
      `${context.snapshot.fingerprint}:${context.candidate.candidateId}:${context.candidate.role}:${context.candidate.model}`,
    );
    return {
      ...context.candidate,
      status: "completed",
      benchmarkRunId: null,
      outputHash,
      summary: "Provider-free simulation completed. It did not run the named model or inspect the frozen evidence.",
      evidenceRefs,
      unknowns: [
        "evidence analysis not performed",
        "live model output not produced",
        "provider usage",
        "cost",
      ],
      usageStatus: "unknown",
      costStatus: "unknown",
      errorCode: null,
      startedAt,
      finishedAt: now(),
      privacyClass: "owner_only",
    };
  }
}

export class TriageRunService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly workerId: string;
  private readonly workerLeaseMs: number;

  constructor(
    private readonly deps: {
      cases: CaseService;
      audit: AuditStore;
      jobs: TriageJobStore;
      executor?: TriageRunExecutor;
      gatewayExecutor?: TriageBatchRunExecutor;
      profiles?: TriageProfileOption[];
      modelPolicy?: ModelPurposePolicyService;
      workerId?: string;
      workerLeaseMs?: number;
      /** Live requester re-resolution. Never a cached session role list. */
      recoveryAuthorization?: TriageRecoveryAuthorization;
    },
  ) {
    this.workerId = deps.workerId?.trim() || `triage-worker:${randomUUID()}`;
    this.workerLeaseMs =
      Number.isSafeInteger(deps.workerLeaseMs) &&
      (deps.workerLeaseMs as number) >= WORKER_HEARTBEAT_MS * 2
        ? (deps.workerLeaseMs as number)
        : DEFAULT_WORKER_LEASE_MS;
  }

  private async withJobAtomic<T>(operation: () => Promise<T>): Promise<T> {
    const memory = this.deps.jobs instanceof MemoryTriageJobStore ? this.deps.jobs : null;
    return this.deps.cases.withAtomic(async () => {
      const snapshot = memory ? await Promise.resolve(memory.capture()) : undefined;
      try {
        return await operation();
      } catch (error) {
        if (memory && snapshot !== undefined) {
          await Promise.resolve(memory.restore(snapshot));
        }
        throw error;
      }
    });
  }

  private async persistJobFinished(
    job: Pick<TriageJobV1, "id" | "caseId" | "requestedBy" | "requestedByUsername" | "requestFingerprint">,
    status: TriageJobStatus,
    audit: { action: string; target: string; outcome: "success" | "failure" },
  ): Promise<void> {
    await this.deps.cases.appendDomainTimeline(job.caseId, {
      kind: "triage_job_finished",
      actor: { id: job.requestedBy, username: job.requestedByUsername },
      targetId: job.id,
      clientTime: null,
      payload: { status, requestFingerprint: job.requestFingerprint },
    });
    await this.deps.audit.append({
      identity: job.requestedBy,
      action: audit.action,
      target: audit.target,
      origin: "triage-runner",
      outcome: audit.outcome,
    });
  }

  /**
   * Settles a run this worker owns as failed, naming the reason where the host
   * actually knows one.
   *
   * Every preparation failure used to land here as `runner_error`, which is
   * accurate about the layer and useless about the cause. A host-decided
   * refusal the operator can act on — the evidence budget being the one the
   * host can name exactly — keeps its own code and carries its numbers into
   * the durable record.
   */
  private async failOwnedRunningJob(jobId: string, cause?: unknown): Promise<void> {
    const failed = await this.deps.jobs.get(jobId);
    if (
      !failed
      || isTerminal(failed.status)
      || !triageWorkerHoldsLiveLease(failed, this.workerId, Date.now())
    ) return;
    const budget = cause instanceof TriageEvidenceBudgetExceededError ? cause.failure : null;
    const errorCode = budget ? TRIAGE_EVIDENCE_BUDGET_ERROR_CODE : "runner_error";
    const unknowns = budget
      ? ["result", "evidence was never sent to a provider"]
      : ["runner preparation"];
    const finishedAt = now();
    const next: TriageJobV1 = {
      ...failed,
      status: "failed",
      candidates: failed.candidates.map((candidate) =>
        candidate.status === "queued" || candidate.status === "running"
          ? {
              ...candidate,
              status: "failed",
              benchmarkRunId: candidate.benchmarkRunId,
              outputHash: null,
              summary: null,
              evidenceRefs: [],
              unknowns: [...unknowns],
              errorCode,
              finishedAt,
            }
          : candidate,
      ),
      finishedAt,
      updatedAt: finishedAt,
      lastProgressAt: finishedAt,
      stoppedReason: errorCode,
      // Facts only. The operator-facing sentence is rendered from these by the
      // shared contract, so no host or provider string is stored here.
      failure: budget,
      leaseExpiresAt: null,
    };
    try {
      await this.withJobAtomic(async () => {
        await this.deps.jobs.update(next);
        await this.persistJobFinished(failed, "failed", {
          action: "triage_job_finish",
          target: `${failed.id}:${errorCode}`,
          outcome: "failure",
        });
      });
    } catch {
      // Leave the job running so stale-lease recovery can record the terminal state.
    }
  }

  /** Safe profile metadata only; no endpoint, credential, or secret is returned. */
  listProfiles(): TriageProfileOption[] {
    return (this.deps.profiles ?? []).map((profile) => ({ ...profile }));
  }

  /** Safe execution metadata for the War-Room launcher; never exposes host paths or secrets. */
  capabilities(): TriageJobCapabilitiesV1 {
    const profileCount = this.deps.profiles?.length ?? 0;
    return {
      schemaId: TRIAGE_JOB_CAPABILITIES_SCHEMA_ID,
      syntheticAvailable: true,
      gatewayAvailable: Boolean(this.deps.gatewayExecutor),
      gatewayMinCandidates: TRIAGE_MIN_GATEWAY_CANDIDATES,
      // The executable ceiling, not the advertised one. They are the same
      // number only because both now come from the canonical formula.
      gatewayMaxCandidates: TRIAGE_EXECUTABLE_MAX_CANDIDATES,
      profileCatalogConfigured: profileCount > 0,
      profileCount,
      progressEventsPerLane: TRIAGE_PROGRESS_EVENTS_PER_LANE,
      maxProgressEvents: TRIAGE_MAX_PROGRESS_EVENTS,
      maxEvidenceItemBytes: TRIAGE_MAX_EVIDENCE_ITEM_BYTES,
      maxEvidenceAggregateBytes: TRIAGE_MAX_EVIDENCE_AGGREGATE_BYTES,
      // A cancel request is durable and stops further dispatch in every mode
      // this server runs; an in-flight provider call it cannot recall is
      // reported as an uncertain outcome rather than as a clean stop.
      cancellationSupported: true,
      retrySemantics: "explicit_rerun_idempotent",
      // This host measures neither. Saying so is the only honest answer; a
      // zero or an estimate would read as a measurement.
      usageAvailable: false,
      costAvailable: false,
      unavailable: [
        "provider token usage is not reported by this host",
        "provider cost is not reported by this host",
      ],
    };
  }

  async list(caseId: string, actor: Actor, isAdmin: boolean): Promise<TriageJobV1[]> {
    if (!(await this.deps.cases.getCase(caseId, actor, isAdmin))) return [];
    return this.deps.jobs.listByCase(caseId);
  }

  async listOverviewJobs(
    scope: { actorId: string; isAdmin: boolean },
    statuses: TriageJobStatus[],
    limit: number,
    visibility: OverviewJobQuery["visibility"],
  ): Promise<OverviewListedJob[]> {
    return this.deps.jobs.listOverviewJobs({
      actorId: scope.actorId,
      isAdmin: scope.isAdmin,
      statuses,
      limit,
      visibility,
    });
  }

  async get(
    caseId: string,
    jobId: string,
    actor: Actor,
    isAdmin: boolean,
  ): Promise<TriageJobV1 | null> {
    if (!(await this.deps.cases.getCase(caseId, actor, isAdmin))) return null;
    const job = await this.deps.jobs.get(jobId);
    return job?.caseId === caseId ? job : null;
  }

  /** Recover process-local work after a server restart without hiding its state. */
  async recoverPending(): Promise<void> {
    const queued = await this.deps.jobs.listByStatuses(["queued"]);
    const staleRunning = await this.deps.jobs.listStaleRunning(now());
    for (const job of queued) {
      const decision = await this.authorizeRecoveredQueuedJob(job);
      if (decision.kind === "denied") {
        await this.refuseUnauthorizedPendingJob(job, decision.reason);
        continue;
      }
      queueMicrotask(() => {
        void this.resumeRecoveredQueuedJob(job.id);
      });
    }
    for (const job of staleRunning) {
      const finishedAt = now();
        const recoveredCandidates = job.candidates.map((candidate) =>
          candidate.status === "queued" || candidate.status === "running"
            ? {
                ...candidate,
                status: "failed" as const,
                outputHash: null,
                summary: null,
                evidenceRefs: [],
                unknowns: ["worker lease expired before completion"],
                errorCode: "worker_lease_expired",
                finishedAt,
              }
            : candidate,
        );
        const recovered: TriageJobV1 = {
          ...job,
          status: terminalStatus(recoveredCandidates, false),
          candidates: recoveredCandidates,
          finishedAt,
          updatedAt: finishedAt,
          lastProgressAt: finishedAt,
          stoppedReason: "worker_lease_expired",
        leaseExpiresAt: null,
      };
      const recoveredOk = await this.withJobAtomic(async () => {
        if (!(await this.deps.jobs.recoverStale(recovered, finishedAt))) return false;
        await this.persistJobFinished(job, recovered.status, {
          action: "triage_job_recovered",
          target: `${job.id}:worker_lease_expired`,
          outcome: "success",
        });
        return true;
      });
      if (!recoveredOk) continue;
    }
  }

  private async resumeRecoveredQueuedJob(jobId: string): Promise<void> {
    const latest = await this.deps.jobs.get(jobId);
    if (!latest || latest.status !== "queued") return;
    const decision = await this.authorizeRecoveredQueuedJob(latest);
    if (decision.kind === "denied") {
      await this.refuseUnauthorizedPendingJob(latest, decision.reason);
      return;
    }
    await this.execute(jobId, decision.actor, decision.isAdmin, decision.canReadPrivate);
  }

  private async authorizeRecoveredQueuedJob(
    job: TriageJobV1,
  ): Promise<
    | { kind: "ok"; actor: Actor; isAdmin: boolean; canReadPrivate: boolean }
    | { kind: "denied"; reason: RecoveryRefusalReason }
  > {
    const authorizer = this.deps.recoveryAuthorization;
    if (!authorizer) {
      return { kind: "denied", reason: "recovery_authorization_unavailable" };
    }
    let resolved: RecoveryAuthResult;
    try {
      resolved = await authorizer({
        id: job.requestedBy,
        username: job.requestedByUsername,
      });
    } catch {
      return { kind: "denied", reason: "recovery_authorization_unavailable" };
    }
    if (resolved.kind === "unavailable") {
      return { kind: "denied", reason: "recovery_authorization_unavailable" };
    }
    if (resolved.kind === "inactive") {
      return { kind: "denied", reason: inactiveRecoveryReason(resolved.reason) };
    }

    try {
      const caseRow = await this.deps.cases.getCase(job.caseId, resolved.actor, resolved.isAdmin);
      if (!caseRow) {
        return {
          kind: "denied",
          reason: resolved.isAdmin ? "requester_unauthorized" : "requester_not_member",
        };
      }
      if (!resolved.has("run:strategies")) {
        return { kind: "denied", reason: "requester_run_revoked" };
      }
      const snapshot = (await this.deps.cases.listSnapshots(
        job.caseId,
        resolved.actor,
        resolved.isAdmin,
      )).find((item) => item.id === job.snapshotId);
      if (!snapshot) {
        return { kind: "denied", reason: "requester_unauthorized" };
      }
      const canReadPrivate = resolved.has("evidence:private:read");
      if (snapshotRequiresPrivateRead(snapshot) && !canReadPrivate) {
        return { kind: "denied", reason: "requester_private_read_revoked" };
      }
      return {
        kind: "ok",
        actor: resolved.actor,
        isAdmin: resolved.isAdmin,
        canReadPrivate,
      };
    } catch {
      return { kind: "denied", reason: "recovery_authorization_unavailable" };
    }
  }

  private async refuseUnauthorizedPendingJob(
    job: TriageJobV1,
    reason: RecoveryRefusalReason = "requester_not_member",
  ): Promise<void> {
    const finishedAt = now();
    const copy = recoveryRefusalCopy(reason);
    const refusedCandidates = job.candidates.map((candidate) =>
      candidate.status === "queued" || candidate.status === "running"
        ? {
            ...candidate,
            status: "failed" as const,
            outputHash: null,
            summary: null,
            evidenceRefs: [],
            unknowns: [copy.unknown],
            errorCode: reason,
            finishedAt,
          }
        : candidate,
    );
    try {
      await this.withJobAtomic(async () => {
        await this.deps.jobs.update({
          ...job,
          status: "failed",
          candidates: refusedCandidates,
          finishedAt,
          updatedAt: finishedAt,
          lastProgressAt: finishedAt,
          stoppedReason: reason,
          leaseExpiresAt: null,
        });
        await this.persistJobFinished(job, "failed", {
          action: "triage_job_recovered",
          target: `${job.id}:${reason}`,
          outcome: "failure",
        });
      });
    } catch {
      return;
    }
  }

  async create(
    caseId: string,
    actor: Actor,
    request: TriageJobRequestV1,
    origin: string,
    isAdmin: boolean,
    canReadPrivate: boolean,
    roles: readonly AppRole[] = isAdmin ? ["admin"] : ["case-lead"],
  ): Promise<TriageJobV1> {
    if (!(await this.deps.cases.getCase(caseId, actor, isAdmin))) {
      throw new TriageRunNotFoundError();
    }
    if (request.mode === "gateway" && !this.deps.gatewayExecutor) {
      throw new TriageRunConflictError("gateway execution is not configured in this server");
    }
    // One capacity decision, taken before any side effect: no job row, no
    // timeline entry, no audit record, and no provider work exists yet. A run
    // the host cannot carry to completion is refused here rather than accepted
    // and killed once it is already spending.
    const capacity = checkTriageCandidateCapacity({
      laneCount: request.candidates.length,
      gateway: request.mode === "gateway",
    });
    if (!capacity.admitted) {
      throw new TriageRunConflictError(capacity.message ?? "candidate capacity refused");
    }
    const gatewayConcurrency = request.concurrency ?? DEFAULT_GATEWAY_CONCURRENCY;
    if (
      request.mode === "gateway"
      && (!Number.isSafeInteger(gatewayConcurrency) || gatewayConcurrency < 1 || gatewayConcurrency > MAX_GATEWAY_CONCURRENCY)
    ) {
      throw new TriageRunConflictError(`gateway concurrency must be between 1 and ${MAX_GATEWAY_CONCURRENCY}`);
    }
    if (request.mode !== "gateway" && request.concurrency !== undefined) {
      throw new TriageRunConflictError("concurrency is only configurable for gateway comparisons");
    }
    let normalizedRequest: TriageJobRequestV1 = request.mode === "gateway"
      ? { ...request, concurrency: gatewayConcurrency }
      : request;
    const ids = new Set<string>();
    for (const candidate of request.candidates) {
      if (!candidate.candidateId || !candidate.role || !candidate.provider || !candidate.model) {
        throw new TriageRunConflictError("candidate id, role, provider, and model are required");
      }
      if (
        [candidate.candidateId, candidate.model, candidate.provider, candidate.profileId ?? "", candidate.version ?? ""]
          .some((value) => /deepseek/i.test(value))
      ) {
        throw new TriageRunConflictError("DeepSeek lanes are not permitted in this deployment");
      }
      if (request.mode === "gateway" && !candidate.profileId) {
        throw new TriageRunConflictError("gateway candidates require a provider profile id");
      }
      if (
        request.mode === "gateway"
        && this.deps.profiles && this.deps.profiles.length > 0
        && !this.deps.profiles.some((profile) =>
          (profile.profileId ?? profile.id) === candidate.profileId
          && (!profile.modelId || profile.modelId === candidate.model),
        )
      ) {
        throw new TriageRunConflictError(`unknown gateway profile for candidate ${candidate.candidateId}`);
      }
      if (ids.has(candidate.candidateId)) {
        throw new TriageRunConflictError("candidate ids must be unique");
      }
      ids.add(candidate.candidateId);
    }
    const snapshot = (await this.deps.cases.listSnapshots(caseId, actor, isAdmin)).find(
      (item) => item.id === request.snapshotId,
    );
    if (!snapshot) throw new TriageRunConflictError("snapshot not found for case");
    if (this.deps.modelPolicy) {
      try {
        const policy = await this.deps.modelPolicy.authorize({
          request: normalizedRequest,
          snapshot,
          roles,
          isAdmin,
        });
        normalizedRequest = { ...normalizedRequest, policyFingerprint: policy.fingerprint };
      } catch (error) {
        if (error instanceof ModelPurposePolicyConflictError) {
          throw new TriageRunConflictError(error.message);
        }
        throw new TriageRunConflictError("model-purpose policy could not be verified");
      }
    }
    if (request.parentJobId) {
      const parent = await this.deps.jobs.get(request.parentJobId);
      if (!parent || parent.caseId !== caseId) {
        throw new TriageRunConflictError("parent triage job not found for case");
      }
    }
    const createdAt = now();
    const job: TriageJobV1 = {
      schemaId: TRIAGE_JOB_SCHEMA_ID,
      id: randomUUID(),
      caseId,
      snapshotId: snapshot.id,
      snapshotFingerprint: snapshot.fingerprint,
      request: {
        ...normalizedRequest,
        candidates: normalizedRequest.candidates.map((candidate) => ({ ...candidate })),
      },
      requestFingerprint: requestFingerprint(snapshot.fingerprint, normalizedRequest),
      cancellationId: randomUUID(),
      ...(normalizedRequest.parentJobId ? { parentJobId: normalizedRequest.parentJobId } : {}),
      status: "queued",
      candidates: normalizedRequest.candidates.map(emptyCandidate),
      sameSnapshot: null,
      agreementNotice: AGREEMENT_NOTICE,
      requestedBy: actor.id,
      requestedByUsername: actor.username,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      finishedAt: null,
      cancelRequestedAt: null,
      stoppedReason: null,
      lastProgressAt: null,
      failure: null,
    };
    await this.withJobAtomic(async () => {
      // Checked inside the same atomic section as the insert so two launches
      // racing on a slow gateway cannot both pass the check and both spend.
      const duplicate = activeDuplicateJob(
        await this.deps.jobs.listByCase(caseId),
        { requestFingerprint: job.requestFingerprint, parentJobId: job.parentJobId ?? null },
        Date.now(),
      );
      if (duplicate) {
        throw new TriageRunConflictError(
          `an identical run is already ${duplicate.status} on this snapshot (run ${duplicate.id}); open or cancel it instead of starting a second one`,
        );
      }
      await this.deps.jobs.insert(job);
      await this.deps.cases.appendDomainTimeline(caseId, {
        kind: "triage_job_created",
        actor,
        targetId: job.id,
        clientTime: null,
        payload: {
          snapshotId: job.snapshotId,
          snapshotFingerprint: job.snapshotFingerprint,
          requestFingerprint: job.requestFingerprint,
          candidateCount: job.candidates.length,
          mode: job.request.mode,
          ...(job.parentJobId ? { parentJobId: job.parentJobId } : {}),
        },
      });
      await this.deps.audit.append({
        identity: actor.id,
        action: "triage_job_create",
        target: job.id,
        origin,
        outcome: "success",
      });
    });
    queueMicrotask(() => {
      void this.execute(job.id, actor, isAdmin, canReadPrivate);
    });
    return job;
  }

  async cancel(
    caseId: string,
    jobId: string,
    actor: Actor,
    origin: string,
    isAdmin: boolean,
  ): Promise<TriageJobV1> {
    const seen = await this.get(caseId, jobId, actor, isAdmin);
    if (!seen) throw new TriageRunNotFoundError();
    if (isTerminal(seen.status)) return seen;
    if (triageRunningLeaseExpired(seen, Date.now())) {
      throw new TriageRunConflictError("worker lease expired");
    }
    const cancelled = await this.withJobAtomic(async () => {
      // Re-read inside the atomic section rather than cancelling the copy the
      // authorization check read.
      //
      // A worker can claim a queued run between those two points, which gives
      // the record a lease owner the earlier copy does not carry. Writing the
      // earlier copy is then rejected as a stale write, and the operator's
      // cancel disappears with an error about the job not existing while the
      // run carries on — the exact failure an operator hits when a slow
      // gateway makes them cancel the moment after launching.
      const current = await this.deps.jobs.get(jobId);
      if (!current || current.caseId !== caseId) throw new TriageRunNotFoundError();
      if (isTerminal(current.status)) return current;
      const requestedAt = now();
      const cancelledCandidates = current.candidates.map((candidate) =>
        candidate.status === "queued" || candidate.status === "running"
          ? {
              ...candidate,
              status: "cancelled" as const,
              errorCode: "cancel_requested",
              finishedAt: requestedAt,
            }
          : candidate,
      );
      const next: TriageJobV1 = {
        ...current,
        cancelRequestedAt: current.cancelRequestedAt ?? requestedAt,
        status: terminalStatus(cancelledCandidates, true),
        candidates: cancelledCandidates,
        finishedAt: requestedAt,
        stoppedReason: "cancel_requested",
        updatedAt: requestedAt,
        lastProgressAt: requestedAt,
        leaseExpiresAt: null,
      };
      await this.deps.jobs.update(next);
      await this.deps.cases.appendDomainTimeline(caseId, {
        kind: "triage_job_cancel_requested",
        actor,
        targetId: jobId,
        clientTime: null,
        payload: { cancellationId: current.cancellationId },
      });
      await this.deps.audit.append({
        identity: actor.id,
        action: "triage_job_cancel",
        target: jobId,
        origin,
        outcome: "success",
      });
      return next;
    });
    this.controllers.get(jobId)?.abort();
    return cancelled;
  }

  private async execute(
    jobId: string,
    actor: Actor,
    isAdmin: boolean,
    canReadPrivate: boolean,
  ): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    let leaseTimer: ReturnType<typeof setInterval> | undefined;
    let leaseLost = false;
    try {
      const startedAt = now();
      const leaseExpiresAt = new Date(Date.now() + this.workerLeaseMs).toISOString();
      const claimed = await this.withJobAtomic(async () => {
        const queued = await this.deps.jobs.claimQueued(
          jobId,
          startedAt,
          this.workerId,
          leaseExpiresAt,
        );
        if (!queued) return null;
        if (!isAdmin && !(await this.deps.cases.isMemberOf(queued.caseId, queued.requestedBy))) {
          return { job: queued, started: false as const };
        }
        await this.deps.cases.appendDomainTimeline(queued.caseId, {
          kind: "triage_job_started",
          actor: { id: queued.requestedBy, username: queued.requestedByUsername },
          targetId: queued.id,
          clientTime: null,
          payload: { snapshotId: queued.snapshotId, requestFingerprint: queued.requestFingerprint },
        });
        return { job: queued, started: true as const };
      });
      if (!claimed) return;
      if (!claimed.started) {
        await this.refuseUnauthorizedPendingJob(claimed.job);
        return;
      }
      const job = claimed.job;
      let currentJob = job;
      leaseTimer = setInterval(() => {
        const nextLeaseExpiresAt = new Date(Date.now() + this.workerLeaseMs).toISOString();
        void this.deps.jobs.renewLease(jobId, this.workerId, nextLeaseExpiresAt)
          .then((renewed) => {
            if (!renewed) {
              leaseLost = true;
              controller.abort();
              return;
            }
            if (currentJob) currentJob = { ...currentJob, leaseExpiresAt: nextLeaseExpiresAt };
          })
          .catch(() => {
            leaseLost = true;
            controller.abort();
          });
      }, WORKER_HEARTBEAT_MS);
      const afterStart = await this.deps.jobs.get(jobId);
      if (!afterStart) {
        return;
      }
      if (afterStart.cancelRequestedAt !== null || afterStart.status === "cancelled") {
        const finishedAt = now();
        const cancelledCandidates = afterStart.candidates.map((candidate) =>
          candidate.status === "queued" || candidate.status === "running"
            ? {
                ...candidate,
                status: "cancelled" as const,
                errorCode: "cancel_requested",
                finishedAt,
              }
            : candidate,
        );
        await this.deps.jobs.update({
          ...afterStart,
          status: terminalStatus(cancelledCandidates, true),
          candidates: cancelledCandidates,
          finishedAt,
          updatedAt: finishedAt,
          lastProgressAt: finishedAt,
          stoppedReason: "cancel_requested",
          leaseExpiresAt: null,
        });
        return;
      }
      const snapshot = (await this.deps.cases.listSnapshots(job.caseId, actor, isAdmin)).find(
        (item) => item.id === job?.snapshotId,
      );
      if (!snapshot) throw new Error("snapshot disappeared before execution");
      const caseRow = await this.deps.cases.getCase(job.caseId, actor, isAdmin);
      if (!caseRow) throw new Error("case disappeared before execution");
      const evidence = job.request.mode === "gateway"
        ? await this.materializeEvidence(job.caseId, snapshot, actor, isAdmin, canReadPrivate, true)
        : await this.materializeEvidence(job.caseId, snapshot, actor, isAdmin, canReadPrivate, false);
      const persistCandidate = async (result: TriageCandidateRunV1): Promise<void> => {
        if (leaseLost) return;
        const latest = await this.deps.jobs.get(currentJob.id);
        if (latest) currentJob = latest;
        // Cancellation and terminal recovery are authoritative. A progress
        // callback may already be in flight when the operator cancels the
        // job; it must never resurrect a terminal job or overwrite a lane
        // that has already settled.
        if (isTerminal(currentJob.status) || currentJob.workerId !== this.workerId) return;
        if (!triageWorkerHoldsLiveLease(currentJob, this.workerId, Date.now())) return;
        const index = currentJob.request.candidates.findIndex((candidate) => candidate.candidateId === result.candidateId);
        if (index < 0) throw new Error("gateway returned an unknown candidate id");
        const existing = currentJob.candidates[index];
        if (existing && ["completed", "partial", "failed", "timed_out", "cancelled"].includes(existing.status)) return;
        const settledAt = now();
        const nextJob = {
          ...currentJob,
          candidates: currentJob.candidates.map((candidate, candidateIndex) => candidateIndex === index ? result : candidate),
          cancelRequestedAt: currentJob.cancelRequestedAt ?? (controller.signal.aborted ? settledAt : null),
          updatedAt: settledAt,
          // A settled lane is real movement. The lease heartbeat deliberately
          // does not touch this, so a gateway that answers nothing leaves it
          // standing still and the run reads as stalled rather than as busy.
          lastProgressAt: settledAt,
        };
        await this.withJobAtomic(async () => {
          await this.deps.jobs.update(nextJob);
          await this.deps.cases.appendDomainTimeline(nextJob.caseId, {
            kind: "triage_candidate_finished",
            actor: { id: nextJob.requestedBy, username: nextJob.requestedByUsername },
            targetId: `${nextJob.id}:${result.candidateId}`,
            clientTime: null,
            payload: {
              status: result.status,
              outputHash: result.outputHash,
              evidenceCount: result.evidenceRefs.length,
            },
          });
        });
        currentJob = {
          ...nextJob,
          leaseExpiresAt: laterLeaseExpiresAt(currentJob.leaseExpiresAt, nextJob.leaseExpiresAt),
        };
      };
      const persistCandidateStarted = async (candidateId: string): Promise<void> => {
        if (leaseLost) return;
        const latest = await this.deps.jobs.get(currentJob.id);
        if (latest) currentJob = latest;
        if (isTerminal(currentJob.status) || currentJob.workerId !== this.workerId) return;
        if (!triageWorkerHoldsLiveLease(currentJob, this.workerId, Date.now())) return;
        const index = currentJob.request.candidates.findIndex((candidate) => candidate.candidateId === candidateId);
        if (index < 0) throw new Error("gateway returned an unknown started candidate id");
        const existing = currentJob.candidates[index];
        if (!existing || ["completed", "partial", "failed", "timed_out", "cancelled"].includes(existing.status)) return;
        if (existing.status === "running") return;
        const startedAt = existing.startedAt ?? now();
        const admittedAt = now();
        const nextJob = {
          ...currentJob,
          candidates: currentJob.candidates.map((candidate, candidateIndex) => candidateIndex === index
            ? { ...candidate, status: "running" as const, startedAt }
            : candidate),
          updatedAt: admittedAt,
          lastProgressAt: admittedAt,
        };
        await this.withJobAtomic(async () => {
          await this.deps.jobs.update(nextJob);
          await this.deps.cases.appendDomainTimeline(nextJob.caseId, {
            kind: "triage_candidate_started",
            actor: { id: nextJob.requestedBy, username: nextJob.requestedByUsername },
            targetId: `${nextJob.id}:${candidateId}`,
            clientTime: null,
            payload: { startedAt },
          });
        });
        currentJob = {
          ...nextJob,
          leaseExpiresAt: laterLeaseExpiresAt(currentJob.leaseExpiresAt, nextJob.leaseExpiresAt),
        };
      };
      // Progress lines can arrive close together. Serialize their durable
      // updates so a slower database read cannot reorder or lose a lane.
      let recordQueue: Promise<void> = Promise.resolve();
      const recordCandidate = (result: TriageCandidateRunV1): Promise<void> => {
        const next = recordQueue.then(() => persistCandidate(result));
        recordQueue = next.catch(() => undefined);
        return next;
      };
      const recordCandidateStarted = (candidateId: string): Promise<void> => {
        const next = recordQueue.then(() => persistCandidateStarted(candidateId));
        recordQueue = next.catch(() => undefined);
        return next;
      };

      if (job.request.mode === "gateway") {
        const executor = this.deps.gatewayExecutor;
        if (!executor) throw new Error("gateway execution is not configured in this server");
        currentJob = {
          ...currentJob,
          updatedAt: now(),
        };
        await this.deps.jobs.update(currentJob);
        try {
          const progressCandidates = new Set<string>();
          const results = await executor.executeBatch({
            jobId: job.id,
            requestedBy: job.requestedBy,
            createdAt: job.createdAt,
            case: caseRow,
            snapshot,
            request: job.request,
            evidence,
            onCandidateStarted: async (candidateId) => {
              await recordCandidateStarted(candidateId);
            },
            onCandidate: async (result) => {
              progressCandidates.add(result.candidateId);
              await recordCandidate(result);
            },
          }, controller.signal);
          if (results.length !== currentJob.candidates.length) throw new Error("gateway returned an incomplete candidate set");
          currentJob = { ...currentJob, updatedAt: now() };
          await this.deps.jobs.update(currentJob);
          for (const result of results) {
            if (!progressCandidates.has(result.candidateId)) await recordCandidate(result);
          }
        } catch (error) {
          const cancelled = job.cancelRequestedAt !== null || (controller.signal.aborted && !leaseLost);
          if (leaseLost) return;
          const status = cancelled ? "cancelled" : error instanceof Error && error.message === "deadline exceeded" ? "timed_out" : "failed";
          const errorCode = cancelled
            ? "cancel_requested"
            : status === "timed_out"
              ? "deadline_exceeded"
              : error instanceof Error && error.message.includes("output overflow")
                ? "output_overflow"
                : "gateway_runner_error";
          for (const candidate of currentJob.candidates) {
            if (candidate.status === "running" || candidate.status === "queued") {
              await recordCandidate({
                ...candidate,
                status,
                outputHash: null,
                summary: null,
                evidenceRefs: [],
                unknowns: ["result"],
                errorCode,
                finishedAt: now(),
              });
            }
          }
        }
      } else {
        const executor = this.deps.executor ?? new DeterministicMockTriageExecutor();
        currentJob = { ...currentJob, updatedAt: now() };
        await this.deps.jobs.update(currentJob);
        for (let index = 0; index < job.candidates.length; index += 1) {
          if (leaseLost) return;
          currentJob = (await this.deps.jobs.get(jobId)) ?? currentJob;
          if (currentJob.cancelRequestedAt !== null || controller.signal.aborted) {
            currentJob = {
              ...currentJob,
              status: terminalStatus(currentJob.candidates, true),
              stoppedReason: "cancel_requested",
              finishedAt: now(),
              updatedAt: now(),
              candidates: currentJob.candidates.map((candidate) =>
                candidate.status === "queued"
                  ? { ...candidate, status: "cancelled", errorCode: "cancel_requested", finishedAt: now() }
                  : candidate,
              ),
            };
            break;
          }
          const candidate = currentJob.candidates[index];
          const spec = currentJob.request.candidates[index];
          if (!candidate || !spec) continue;
          const runningAt = now();
          currentJob = {
            ...currentJob,
            candidates: currentJob.candidates.map((item, candidateIndex) => candidateIndex === index ? { ...candidate, status: "running", startedAt: runningAt } : item),
            updatedAt: runningAt,
          };
          await this.deps.jobs.update(currentJob);
          let result: TriageCandidateRunV1;
          try {
            result = await executor.execute({
              jobId: currentJob.id,
              mode: currentJob.request.mode,
              snapshot,
              strategyId: currentJob.request.strategyId,
              question: currentJob.request.question,
              taskFingerprint: currentJob.request.taskFingerprint,
              policyFingerprint: currentJob.request.policyFingerprint,
              evidence,
              candidate: spec,
            }, controller.signal);
          } catch (error) {
            const cancelled = currentJob.cancelRequestedAt !== null || (controller.signal.aborted && !leaseLost);
            result = {
              ...spec,
              status: cancelled ? "cancelled" : "failed",
              benchmarkRunId: null,
              outputHash: null,
              summary: null,
              evidenceRefs: [],
              unknowns: ["result"],
              usageStatus: "unknown",
              costStatus: "unknown",
              errorCode: cancelled ? "cancel_requested" : "executor_error",
              startedAt: runningAt,
              finishedAt: now(),
              privacyClass: "owner_only",
            };
            if (!cancelled && error instanceof Error && error.message === "deadline exceeded") {
              result.status = "timed_out";
              result.errorCode = "deadline_exceeded";
            }
          }
          await recordCandidate(result);
          if (leaseLost) return;
        }
      }
      if (leaseLost) return;
      currentJob = (await this.deps.jobs.get(jobId)) ?? currentJob;
      if (!triageWorkerHoldsLiveLease(currentJob, this.workerId, Date.now())) return;
      if (!isTerminal(currentJob.status)) {
        const finishedAt = now();
        const finalStatus = terminalStatus(currentJob.candidates, currentJob.cancelRequestedAt !== null);
        const finishedJob = {
          ...currentJob,
          status: finalStatus,
          sameSnapshot: evaluateSameSnapshot(snapshot),
          finishedAt,
          updatedAt: finishedAt,
          lastProgressAt: finishedAt,
          stoppedReason: currentJob.cancelRequestedAt !== null ? "cancel_requested" : null,
          leaseExpiresAt: null,
        };
        await this.withJobAtomic(async () => {
          await this.deps.jobs.update(finishedJob);
          await this.persistJobFinished(finishedJob, finalStatus, {
            action: "triage_job_finish",
            target: `${job.id}:${finalStatus}`,
            outcome: "success",
          });
        });
        currentJob = finishedJob;
      }
    } catch (error) {
      await this.failOwnedRunningJob(jobId, error);
    } finally {
      if (leaseTimer) clearInterval(leaseTimer);
      this.controllers.delete(jobId);
    }
  }

  private async materializeEvidence(
    caseId: string,
    snapshot: SnapshotV1,
    actor: Actor,
    isAdmin: boolean,
    canReadPrivate: boolean,
    requireContent: boolean,
  ): Promise<TriageExecutionEvidence[]> {
    const evidence: TriageExecutionEvidence[] = [];
    let aggregateBytes = 0;
    for (const item of snapshot.evidence) {
      const artifact = await this.deps.cases.getArtifact(caseId, item.evidenceId);
      if (!artifact) throw new Error("snapshot evidence disappeared before execution");
      const bytes = await this.deps.cases.getArtifactBytes(
        caseId,
        item.evidenceId,
        actor,
        isAdmin,
        canReadPrivate,
      );
      if (requireContent && item.contentHash && !bytes) {
        throw new Error("snapshot evidence content is unavailable to the gateway runner");
      }
      if (bytes && requireContent) {
        const itemOverBudget = checkTriageEvidenceBudget({
          scope: "item",
          actualBytes: bytes.byteLength,
        });
        if (itemOverBudget) throw new TriageEvidenceBudgetExceededError(itemOverBudget);
        aggregateBytes += bytes.byteLength;
        const aggregateOverBudget = checkTriageEvidenceBudget({
          scope: "aggregate",
          actualBytes: aggregateBytes,
        });
        if (aggregateOverBudget) throw new TriageEvidenceBudgetExceededError(aggregateOverBudget);
        const actualHash = createHash("sha256").update(bytes).digest("hex");
        if (item.contentHash && actualHash !== item.contentHash) {
          throw new Error("snapshot evidence integrity verification failed");
        }
      }
      evidence.push({
        evidenceId: item.evidenceId,
        ordinal: item.ordinal,
        contentHash: item.contentHash,
        mediaType: artifact.mediaType,
        privacyClass: item.privacyClass,
        byteLength: bytes?.byteLength ?? artifact.byteLength,
        contentBase64: bytes ? Buffer.from(bytes).toString("base64") : null,
      });
    }
    return evidence;
  }
}
