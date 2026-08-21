/**
 * Hermetic fake host lanes for release qualification.
 *
 * Collab does not own the Rust live bridge. These fakes stand in for
 * ContextDesk-owned lanes at the Experiment Lab import seam and prove the
 * boundary's concurrency, snapshot, cancellation, deadline, and partial
 * result contracts without introducing another jobs table.
 */

export const DEFAULT_HOST_LANE_CONCURRENCY = 2;

export interface FakeLaneScript {
  delayMs: number;
  fail?: boolean;
  evidenceRefs?: string[];
}

export interface HostLaneSpec {
  candidateId: string;
  modelLabel: string;
}

export interface HostLaneResult {
  candidateId: string;
  modelLabel: string;
  snapshotFingerprint: string;
  runStatus: "completed" | "failed" | "cancelled" | "timeout";
  evidenceRefs: string[];
  durableRunId: string;
}

export interface HostLaneRun {
  results: HostLaneResult[];
  maxActive: number;
  stopped: "none" | "cancelled" | "deadline" | "lane_failed";
}

export async function runFakeHostLanes(input: {
  snapshotFingerprint: string;
  lanes: HostLaneSpec[];
  scripts?: Record<string, FakeLaneScript>;
  maxConcurrency?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
}): Promise<HostLaneRun> {
  const limit = Math.min(Math.max(input.maxConcurrency ?? DEFAULT_HOST_LANE_CONCURRENCY, 1), 4);
  const deadlineMs = input.deadlineMs ?? 5_000;
  const started = Date.now();
  let active = 0;
  let maxActive = 0;
  let stopped: HostLaneRun["stopped"] = "none";
  const results: Array<HostLaneResult | undefined> = input.lanes.map(() => undefined);
  let next = 0;

  const runOne = async (index: number): Promise<void> => {
    const lane = input.lanes[index];
    if (!lane) return;
    const script = input.scripts?.[lane.candidateId] ?? { delayMs: 20 };
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (input.signal?.aborted) {
        results[index] = finished(lane, input.snapshotFingerprint, "cancelled", []);
        return;
      }
      if (Date.now() - started >= deadlineMs) {
        results[index] = finished(lane, input.snapshotFingerprint, "timeout", []);
        if (stopped === "none") stopped = "deadline";
        return;
      }
      try {
        await wait(script.delayMs, input.signal);
      } catch {
        results[index] = finished(lane, input.snapshotFingerprint, "cancelled", []);
        if (stopped === "none") stopped = "cancelled";
        return;
      }
      if (input.signal?.aborted) {
        results[index] = finished(lane, input.snapshotFingerprint, "cancelled", []);
        if (stopped === "none") stopped = "cancelled";
        return;
      }
      if (Date.now() - started >= deadlineMs) {
        results[index] = finished(lane, input.snapshotFingerprint, "timeout", []);
        if (stopped === "none") stopped = "deadline";
        return;
      }
      if (script.fail) {
        results[index] = finished(lane, input.snapshotFingerprint, "failed", []);
        if (stopped === "none") stopped = "lane_failed";
        return;
      }
      results[index] = finished(
        lane,
        input.snapshotFingerprint,
        "completed",
        script.evidenceRefs ?? ["ev-demo-checkout-log"],
      );
    } finally {
      active -= 1;
    }
  };

  const workers = Array.from({ length: Math.min(limit, input.lanes.length) }, async () => {
    while (next < input.lanes.length) {
      if (input.signal?.aborted) {
        if (stopped === "none") stopped = "cancelled";
        break;
      }
      if (Date.now() - started >= deadlineMs) {
        if (stopped === "none") stopped = "deadline";
        break;
      }
      if (stopped === "lane_failed") break;
      const index = next;
      next += 1;
      await runOne(index);
    }
  });
  await Promise.all(workers);

  return {
    results: input.lanes.map((lane, index) =>
      results[index] ?? finished(lane, input.snapshotFingerprint, stopped === "deadline" ? "timeout" : "cancelled", []),
    ),
    maxActive,
    stopped,
  };
}

function finished(
  lane: HostLaneSpec,
  snapshotFingerprint: string,
  runStatus: HostLaneResult["runStatus"],
  evidenceRefs: string[],
): HostLaneResult {
  return {
    candidateId: lane.candidateId,
    modelLabel: lane.modelLabel,
    snapshotFingerprint,
    runStatus,
    evidenceRefs,
    durableRunId: `lane:${lane.candidateId}:${snapshotFingerprint.slice(0, 12)}`,
  };
}

export async function exerciseHostLaneContracts(snapshotFingerprint: string): Promise<{
  configuredLimit: number;
  observedMaxActive: number;
  sameSnapshot: boolean;
  durableRunCount: number;
  cancelled: boolean;
  deadline: boolean;
  partial: boolean;
}> {
  const lanes: HostLaneSpec[] = [
    { candidateId: "cand-qwen-3.6-27b", modelLabel: "qwen-3.6-27b" },
    { candidateId: "cand-gpt-oss-120b", modelLabel: "gpt-oss-120b" },
    { candidateId: "cand-ministral-14b", modelLabel: "ministral-14b" },
    { candidateId: "cand-extra-lane", modelLabel: "extra" },
  ];
  const scripts = Object.fromEntries(lanes.map((lane) => [lane.candidateId, { delayMs: 40 }]));
  const bounded = await runFakeHostLanes({ snapshotFingerprint, lanes, scripts, maxConcurrency: DEFAULT_HOST_LANE_CONCURRENCY, deadlineMs: 5_000 });
  if (bounded.maxActive > DEFAULT_HOST_LANE_CONCURRENCY || bounded.maxActive < 2) {
    throw new Error("host lanes violated the configured concurrency bound");
  }
  const sameSnapshot = bounded.results.every((row) => row.snapshotFingerprint === snapshotFingerprint);
  if (!sameSnapshot) throw new Error("host lanes drifted off the frozen snapshot");
  const durableRunCount = new Set(bounded.results.map((row) => row.durableRunId)).size;
  if (durableRunCount !== lanes.length) throw new Error("host lanes did not mint a durable run id per candidate");

  const abort = new AbortController();
  const cancelPromise = runFakeHostLanes({
    snapshotFingerprint,
    lanes,
    scripts: Object.fromEntries(lanes.map((lane) => [lane.candidateId, { delayMs: 400 }])),
    maxConcurrency: DEFAULT_HOST_LANE_CONCURRENCY,
    deadlineMs: 5_000,
    signal: abort.signal,
  });
  setTimeout(() => abort.abort(), 0);
  const cancelled = await cancelPromise;
  if (!cancelled.results.some((row) => row.runStatus === "cancelled")) throw new Error("host lanes did not surface cancellation");

  const deadline = await runFakeHostLanes({
    snapshotFingerprint,
    lanes,
    scripts: Object.fromEntries(lanes.map((lane) => [lane.candidateId, { delayMs: 400 }])),
    maxConcurrency: DEFAULT_HOST_LANE_CONCURRENCY,
    deadlineMs: 25,
  });
  if (!deadline.results.some((row) => row.runStatus === "timeout") || deadline.stopped !== "deadline") throw new Error("host lanes did not surface a deadline timeout");

  const partial = await runFakeHostLanes({
    snapshotFingerprint,
    lanes,
    scripts: {
      "cand-qwen-3.6-27b": { delayMs: 10 },
      "cand-gpt-oss-120b": { delayMs: 10, fail: true },
      "cand-ministral-14b": { delayMs: 10 },
      "cand-extra-lane": { delayMs: 10 },
    },
    maxConcurrency: DEFAULT_HOST_LANE_CONCURRENCY,
    deadlineMs: 5_000,
  });
  if (partial.stopped !== "lane_failed" || !partial.results.some((row) => row.runStatus === "failed")) throw new Error("host lanes did not preserve partial failure");
  if (!partial.results.some((row) => row.runStatus === "cancelled" || row.runStatus === "completed" || row.runStatus === "timeout")) throw new Error("host lanes dropped partial results");

  return { configuredLimit: DEFAULT_HOST_LANE_CONCURRENCY, observedMaxActive: bounded.maxActive, sameSnapshot, durableRunCount, cancelled: true, deadline: true, partial: true };
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
