import { createHash, randomUUID } from "node:crypto";
import {
  TRIAGE_JOB_SCHEMA_ID,
  TRIAGE_JOB_CAPABILITIES_SCHEMA_ID,
  type CaseV1,
  type TriageJobMode,
  type TriageJobCapabilitiesV1,
  type SnapshotV1,
  type TriageCandidateRunV1,
  type TriageCandidateSpecV1,
  type TriageJobRequestV1,
  type TriageJobStatus,
  type TriageJobV1,
} from "@cd-collab/contracts";
import type { AuditStore } from "../audit/index.js";
import type { Actor, CaseService } from "../cases/index.js";
import type { TriageJobStore } from "./store.js";
import type { TriageProfileOption } from "./profiles.js";

const MAX_CANDIDATES = 16;
const MIN_GATEWAY_CANDIDATES = 2;
const DEFAULT_GATEWAY_CONCURRENCY = 2;
const MAX_GATEWAY_CONCURRENCY = 4;
const MAX_GATEWAY_EVIDENCE_ITEM_BYTES = 4 * 1024 * 1024;
const MAX_GATEWAY_EVIDENCE_AGGREGATE_BYTES = 8 * 1024 * 1024;
const DEFAULT_WORKER_LEASE_MS = 60_000;
const WORKER_HEARTBEAT_MS = 20_000;
const AGREEMENT_NOTICE = "Agreement is not proof of correctness." as const;

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

function terminalStatus(candidates: TriageCandidateRunV1[], cancelled: boolean): TriageJobStatus {
  const statuses = candidates.map((candidate) => candidate.status);
  const completed = statuses.filter((status) => status === "completed").length;
  const partial = statuses.filter((status) => status === "partial").length;
  const failed = statuses.filter((status) => status === "failed").length;
  const timedOut = statuses.filter((status) => status === "timed_out").length;
  const cancelledCount = statuses.filter((status) => status === "cancelled").length;
  if (cancelled && completed === 0 && partial === 0 && failed === 0 && timedOut === 0) return "cancelled";
  if (cancelled) return "partial";
  if (completed === statuses.length) return "completed";
  if (partial > 0 || completed > 0 || failed > 0 && timedOut > 0) return "partial";
  if (timedOut === statuses.length) return "timed_out";
  if (failed === statuses.length) return "failed";
  if (cancelledCount === statuses.length) return "cancelled";
  return "partial";
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
    const evidenceRefs = context.snapshot.evidence.map((item) => item.evidenceId);
    const outputHash = sha256(
      `${context.snapshot.fingerprint}:${context.candidate.candidateId}:${context.candidate.role}:${context.candidate.model}`,
    );
    return {
      ...context.candidate,
      status: "completed",
      benchmarkRunId: null,
      outputHash,
      summary: `Synthetic ${context.candidate.role} result: inspect the ${evidenceRefs.length} frozen evidence item(s) before changing the mitigation.`,
      evidenceRefs,
      unknowns: ["provider usage", "cost", "live model output"],
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
      workerId?: string;
      workerLeaseMs?: number;
    },
  ) {
    this.workerId = deps.workerId?.trim() || `triage-worker:${randomUUID()}`;
    this.workerLeaseMs =
      Number.isSafeInteger(deps.workerLeaseMs) &&
      (deps.workerLeaseMs as number) >= WORKER_HEARTBEAT_MS * 2
        ? (deps.workerLeaseMs as number)
        : DEFAULT_WORKER_LEASE_MS;
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
      gatewayMinCandidates: MIN_GATEWAY_CANDIDATES,
      gatewayMaxCandidates: MAX_CANDIDATES,
      profileCatalogConfigured: profileCount > 0,
      profileCount,
    };
  }

  async list(caseId: string, actor: Actor, isAdmin: boolean): Promise<TriageJobV1[]> {
    if (!(await this.deps.cases.getCase(caseId, actor, isAdmin))) return [];
    return this.deps.jobs.listByCase(caseId);
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
      const actor = { id: job.requestedBy, username: job.requestedByUsername };
      // This is an internal continuation of an already-authorized durable
      // job. Reconstructing the original actor's current membership here
      // would incorrectly strand jobs created by an administrator whose
      // case access is not represented as a participant row.
      queueMicrotask(() => {
        void this.execute(job.id, actor, true);
      });
    }
    for (const job of staleRunning) {
      const actor = { id: job.requestedBy, username: job.requestedByUsername };
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
          stoppedReason: "worker_lease_expired",
        leaseExpiresAt: null,
      };
      if (!(await this.deps.jobs.recoverStale(recovered, finishedAt))) continue;
        await this.deps.audit.append({
          identity: actor.id,
          action: "triage_job_recovered",
          target: `${job.id}:worker_lease_expired`,
          origin: "triage-runner",
          outcome: "success",
        });
    }
  }

  async create(
    caseId: string,
    actor: Actor,
    request: TriageJobRequestV1,
    origin: string,
    isAdmin: boolean,
  ): Promise<TriageJobV1> {
    if (!(await this.deps.cases.getCase(caseId, actor, isAdmin))) {
      throw new TriageRunNotFoundError();
    }
    if (request.mode === "gateway" && !this.deps.gatewayExecutor) {
      throw new TriageRunConflictError("gateway execution is not configured in this server");
    }
    if (request.candidates.length < 1 || request.candidates.length > MAX_CANDIDATES) {
      throw new TriageRunConflictError(`candidate count must be between 1 and ${MAX_CANDIDATES}`);
    }
    if (request.mode === "gateway" && request.candidates.length < MIN_GATEWAY_CANDIDATES) {
      throw new TriageRunConflictError(`gateway comparisons require at least ${MIN_GATEWAY_CANDIDATES} candidate lanes`);
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
    const normalizedRequest: TriageJobRequestV1 = request.mode === "gateway"
      ? { ...request, concurrency: gatewayConcurrency }
      : request;
    const ids = new Set<string>();
    for (const candidate of request.candidates) {
      if (!candidate.candidateId || !candidate.role || !candidate.provider || !candidate.model) {
        throw new TriageRunConflictError("candidate id, role, provider, and model are required");
      }
      if (request.mode === "gateway" && !candidate.profileId) {
        throw new TriageRunConflictError("gateway candidates require a provider profile id");
      }
      if (
        request.mode === "gateway"
        && this.deps.profiles && this.deps.profiles.length > 0
        && !this.deps.profiles.some((profile) => profile.id === candidate.profileId)
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
    };
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
    queueMicrotask(() => {
      void this.execute(job.id, actor, isAdmin);
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
    const job = await this.get(caseId, jobId, actor, isAdmin);
    if (!job) throw new TriageRunNotFoundError();
    if (isTerminal(job.status)) return job;
    const requestedAt = now();
    const cancelledCandidates = job.candidates.map((candidate) =>
      candidate.status === "queued" || candidate.status === "running"
        ? {
            ...candidate,
            status: "cancelled" as const,
            errorCode: "cancel_requested",
            finishedAt: requestedAt,
          }
        : candidate,
    );
    const cancelledStatus = terminalStatus(cancelledCandidates, true);
    const cancelled = {
      ...job,
      cancelRequestedAt: job.cancelRequestedAt ?? requestedAt,
      status: cancelledStatus,
      candidates: cancelledCandidates,
      finishedAt: requestedAt,
      stoppedReason: "cancel_requested",
      updatedAt: requestedAt,
      leaseExpiresAt: null,
    };
    await this.deps.jobs.update(cancelled);
    this.controllers.get(jobId)?.abort();
    await this.deps.cases.appendDomainTimeline(caseId, {
      kind: "triage_job_cancel_requested",
      actor,
      targetId: jobId,
      clientTime: null,
      payload: { cancellationId: job.cancellationId },
    });
    await this.deps.audit.append({
      identity: actor.id,
      action: "triage_job_cancel",
      target: jobId,
      origin,
      outcome: "success",
    });
    return cancelled;
  }

  private async execute(jobId: string, actor: Actor, isAdmin: boolean): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    let leaseTimer: ReturnType<typeof setInterval> | undefined;
    let leaseLost = false;
    try {
      const startedAt = now();
      const leaseExpiresAt = new Date(Date.now() + this.workerLeaseMs).toISOString();
      const job = await this.deps.jobs.claimQueued(
        jobId,
        startedAt,
        this.workerId,
        leaseExpiresAt,
      );
      if (!job) return;
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
      await this.deps.cases.appendDomainTimeline(job.caseId, {
        kind: "triage_job_started",
        actor: { id: job.requestedBy, username: job.requestedByUsername },
        targetId: job.id,
        clientTime: null,
        payload: { snapshotId: job.snapshotId, requestFingerprint: job.requestFingerprint },
      });
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
        ? await this.materializeEvidence(job.caseId, snapshot, actor, isAdmin, true)
        : await this.materializeEvidence(job.caseId, snapshot, actor, isAdmin, false);
      const persistCandidate = async (result: TriageCandidateRunV1): Promise<void> => {
        if (leaseLost) return;
        const latest = await this.deps.jobs.get(currentJob.id);
        if (latest) currentJob = latest;
        // Cancellation and terminal recovery are authoritative. A progress
        // callback may already be in flight when the operator cancels the
        // job; it must never resurrect a terminal job or overwrite a lane
        // that has already settled.
        if (isTerminal(currentJob.status) || currentJob.workerId !== this.workerId) return;
        const index = currentJob.request.candidates.findIndex((candidate) => candidate.candidateId === result.candidateId);
        if (index < 0) throw new Error("gateway returned an unknown candidate id");
        const existing = currentJob.candidates[index];
        if (existing && ["completed", "partial", "failed", "timed_out", "cancelled"].includes(existing.status)) return;
        currentJob = {
          ...currentJob,
          candidates: currentJob.candidates.map((candidate, candidateIndex) => candidateIndex === index ? result : candidate),
          cancelRequestedAt: currentJob.cancelRequestedAt ?? (controller.signal.aborted ? now() : null),
          updatedAt: now(),
        };
        await this.deps.jobs.update(currentJob);
        await this.deps.cases.appendDomainTimeline(currentJob.caseId, {
          kind: "triage_candidate_finished",
          actor: { id: currentJob.requestedBy, username: currentJob.requestedByUsername },
          targetId: `${currentJob.id}:${result.candidateId}`,
          clientTime: null,
          payload: {
            status: result.status,
            outputHash: result.outputHash,
            evidenceCount: result.evidenceRefs.length,
          },
        });
      };
      const persistCandidateStarted = async (candidateId: string): Promise<void> => {
        if (leaseLost) return;
        const latest = await this.deps.jobs.get(currentJob.id);
        if (latest) currentJob = latest;
        if (isTerminal(currentJob.status) || currentJob.workerId !== this.workerId) return;
        const index = currentJob.request.candidates.findIndex((candidate) => candidate.candidateId === candidateId);
        if (index < 0) throw new Error("gateway returned an unknown started candidate id");
        const existing = currentJob.candidates[index];
        if (!existing || ["completed", "partial", "failed", "timed_out", "cancelled"].includes(existing.status)) return;
        if (existing.status === "running") return;
        const startedAt = existing.startedAt ?? now();
        currentJob = {
          ...currentJob,
          candidates: currentJob.candidates.map((candidate, candidateIndex) => candidateIndex === index
            ? { ...candidate, status: "running" as const, startedAt }
            : candidate),
          updatedAt: now(),
        };
        await this.deps.jobs.update(currentJob);
        await this.deps.cases.appendDomainTimeline(currentJob.caseId, {
          kind: "triage_candidate_started",
          actor: { id: currentJob.requestedBy, username: currentJob.requestedByUsername },
          targetId: `${currentJob.id}:${candidateId}`,
          clientTime: null,
          payload: { startedAt },
        });
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
          currentJob = { ...currentJob, sameSnapshot: true, updatedAt: now() };
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
        currentJob = { ...currentJob, sameSnapshot: true, updatedAt: now() };
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
      if (!isTerminal(currentJob.status)) {
        const finishedAt = now();
        const finalStatus = terminalStatus(currentJob.candidates, currentJob.cancelRequestedAt !== null);
        currentJob = {
          ...currentJob,
          status: finalStatus,
          finishedAt,
          updatedAt: finishedAt,
          stoppedReason: currentJob.cancelRequestedAt !== null ? "cancel_requested" : null,
          leaseExpiresAt: null,
        };
        await this.deps.jobs.update(currentJob);
        await this.deps.cases.appendDomainTimeline(currentJob.caseId, {
          kind: "triage_job_finished",
          actor: { id: job.requestedBy, username: job.requestedByUsername },
          targetId: currentJob.id,
          clientTime: null,
          payload: { status: finalStatus, requestFingerprint: currentJob.requestFingerprint },
        });
        await this.deps.audit.append({
          identity: currentJob.requestedBy,
          action: "triage_job_finish",
          target: `${job.id}:${finalStatus}`,
          origin: "triage-runner",
          outcome: "success",
        });
      }
    } catch {
      const failed = await this.deps.jobs.get(jobId);
      if (failed && !isTerminal(failed.status)) {
        const finishedAt = now();
        await this.deps.jobs.update({
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
                  unknowns: ["runner preparation"],
                  errorCode: "runner_error",
                  finishedAt,
                }
              : candidate,
          ),
          finishedAt,
          updatedAt: finishedAt,
          stoppedReason: "runner_error",
          leaseExpiresAt: null,
        });
      }
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
    requireContent: boolean,
  ): Promise<TriageExecutionEvidence[]> {
    const evidence: TriageExecutionEvidence[] = [];
    let aggregateBytes = 0;
    for (const item of snapshot.evidence) {
      const artifact = await this.deps.cases.getArtifact(caseId, item.evidenceId);
      if (!artifact) throw new Error("snapshot evidence disappeared before execution");
      const bytes = await this.deps.cases.getArtifactBytes(caseId, item.evidenceId, actor, isAdmin);
      if (requireContent && item.contentHash && !bytes) {
        throw new Error("snapshot evidence content is unavailable to the gateway runner");
      }
      if (bytes && requireContent) {
        if (bytes.byteLength > MAX_GATEWAY_EVIDENCE_ITEM_BYTES) {
          throw new Error("gateway evidence item exceeds the bounded size");
        }
        aggregateBytes += bytes.byteLength;
        if (aggregateBytes > MAX_GATEWAY_EVIDENCE_AGGREGATE_BYTES) {
          throw new Error("gateway evidence exceeds the aggregate bound");
        }
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
