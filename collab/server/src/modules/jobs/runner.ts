import type { HostConnector, HostLaneRequest, HostLaneResult } from "./connector.js";
import {
  MemoryJobStore,
  newJobId,
  payloadHash,
  type JobRow,
  type JobStore,
} from "./store.js";

export const DEFAULT_COMPARISON_CONCURRENCY = 2;
export const MAX_COMPARISON_CONCURRENCY = 4;
export const DEFAULT_LEASE_MS = 5_000;

export interface ComparisonLaneSpec {
  candidateId: string;
  modelLabel: string;
  profileAlias: string;
}

export interface ComparisonRunInput {
  snapshotFingerprint: string;
  taskFingerprint: string;
  lanes: ComparisonLaneSpec[];
  deadlineMs: number;
  maxConcurrency?: number;
}

export interface ComparisonRunResult {
  results: HostLaneResult[];
  jobs: JobRow[];
  stopped: "none" | "cancelled" | "deadline" | "lane_failed";
}

export class ComparisonJobRunner {
  constructor(
    private readonly store: JobStore,
    private readonly connector: HostConnector,
    private readonly owner: string,
    private readonly leaseMs = DEFAULT_LEASE_MS,
  ) {}

  async enqueue(input: ComparisonRunInput): Promise<JobRow[]> {
    const jobs: JobRow[] = [];
    for (const lane of input.lanes) {
      const payload = {
        candidateId: lane.candidateId,
        modelLabel: lane.modelLabel,
        profileAlias: lane.profileAlias,
        snapshotFingerprint: input.snapshotFingerprint,
        taskFingerprint: input.taskFingerprint,
        deadlineMs: input.deadlineMs,
      };
      jobs.push(
        await this.store.insert({
          id: newJobId(),
          kind: "host_triage_lane",
          leaseOwner: null,
          leaseUntil: null,
          payloadHash: payloadHash(payload),
          payload,
          result: null,
          cancelRequested: false,
        }),
      );
    }
    return jobs;
  }

  async run(input: ComparisonRunInput, signal?: AbortSignal): Promise<ComparisonRunResult> {
    const jobs = await this.enqueue(input);
    const limit = Math.min(
      Math.max(input.maxConcurrency ?? DEFAULT_COMPARISON_CONCURRENCY, 1),
      MAX_COMPARISON_CONCURRENCY,
      jobs.length,
    );
    const outcomes = new Map<string, HostLaneResult>();
    let stopped: ComparisonRunResult["stopped"] = "none";
    const deadlineAt = Date.now() + input.deadlineMs;
    const aborts = new Map<string, AbortController>();
    let admit = true;

    const stopAdmission = (reason: ComparisonRunResult["stopped"]) => {
      if (stopped === "none") stopped = reason;
      admit = false;
    };

    const onCancel = () => {
      stopAdmission("cancelled");
      for (const controller of aborts.values()) controller.abort();
    };
    signal?.addEventListener("abort", onCancel, { once: true });

    const worker = async (slot: number): Promise<void> => {
      const owner = `${this.owner}:${slot}`;
      while (admit) {
        if (signal?.aborted) {
          stopAdmission("cancelled");
          break;
        }
        if (Date.now() >= deadlineAt) {
          stopAdmission("deadline");
          for (const controller of aborts.values()) controller.abort();
          break;
        }
        const leased = await this.store.acquire(owner, this.leaseMs);
        if (!leased) break;
        if (!admit) {
          await this.store.requestCancel(leased.id);
          try {
            await this.store.fail(leased.id, owner, { note: stopped });
          } catch {
            // lease may already have been released
          }
          break;
        }
        const controller = new AbortController();
        aborts.set(leased.id, controller);
        const result = await this.execute(leased, input, owner, controller.signal);
        aborts.delete(leased.id);
        outcomes.set(result.candidateId, result);
        if (result.runStatus === "failed") {
          stopAdmission("lane_failed");
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: limit }, (_, slot) => worker(slot)));
    } finally {
      signal?.removeEventListener("abort", onCancel);
    }

    if (Date.now() >= deadlineAt && stopped === "none") stopAdmission("deadline");
    if (signal?.aborted && stopped === "none") stopAdmission("cancelled");

    for (const job of jobs) {
      const latest = await this.store.get(job.id);
      if (latest?.status === "queued") await this.store.requestCancel(job.id);
    }

    const results = input.lanes.map((lane) => {
      const found = outcomes.get(lane.candidateId);
      return (
        found ?? {
          candidateId: lane.candidateId,
          runStatus: "cancelled" as const,
          evidenceRefs: [],
          note: stopped,
        }
      );
    });
    const latestJobs: JobRow[] = [];
    for (const job of jobs) {
      latestJobs.push((await this.store.get(job.id)) ?? job);
    }
    return { results, jobs: latestJobs, stopped };
  }

  private async execute(
    job: JobRow,
    input: ComparisonRunInput,
    owner: string,
    signal: AbortSignal,
  ): Promise<HostLaneResult> {
    const request: HostLaneRequest = {
      candidateId: String(job.payload.candidateId),
      modelLabel: String(job.payload.modelLabel),
      profileAlias: String(job.payload.profileAlias),
      snapshotFingerprint: input.snapshotFingerprint,
      taskFingerprint: input.taskFingerprint,
      cancellationId: `cancel:${job.id}`,
      deadlineMs: input.deadlineMs,
    };
    const renew = setInterval(() => {
      void this.store.renew(job.id, owner, this.leaseMs);
    }, Math.max(40, Math.floor(this.leaseMs / 3)));
    try {
      const result = await this.connector.runLane(request, signal);
      if (result.runStatus === "failed" || result.runStatus === "cancelled") {
        await this.store.fail(job.id, owner, { note: result.note, status: result.runStatus });
      } else {
        await this.store.complete(job.id, owner, {
          note: result.note,
          status: result.runStatus,
        });
      }
      return result;
    } catch {
      const failed: HostLaneResult = {
        candidateId: request.candidateId,
        runStatus: signal.aborted ? "cancelled" : "failed",
        evidenceRefs: [],
        note: signal.aborted ? "cancelled" : "connector_failed",
      };
      try {
        await this.store.fail(job.id, owner, { note: failed.note });
      } catch {
        // already released
      }
      return failed;
    } finally {
      clearInterval(renew);
    }
  }
}

export function memoryRunner(
  connector: HostConnector,
  owner = "worker-a",
): ComparisonJobRunner {
  return new ComparisonJobRunner(new MemoryJobStore(), connector, owner);
}
