import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  TriageCandidateRunV1,
} from "@cd-collab/contracts";
import type {
  TriageBatchExecutionContext,
  TriageBatchRunExecutor,
} from "./service.js";

const RUNNER_SCHEMA_ID = "cd-collab.triage_run_request.v1" as const;
const RESULT_SCHEMA_ID = "cd-collab.triage_run_result.v1" as const;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_PROGRESS_EVENTS = 16;
const MAX_PROGRESS_LINE_BYTES = 16 * 1024;
const MAX_SAFE_SUMMARY_CHARS = 2_048;
const PROGRESS_EVENT_PREFIX = "contextdesk.collab_triage_progress ";
const PROGRESS_SCHEMA_ID = "cd-collab.triage_run_progress.v1";
const FORCE_KILL_GRACE_MS = 1_000;
const TERMINAL_STATUSES = new Set<TriageCandidateRunV1["status"]>([
  "completed",
  "partial",
  "failed",
  "timed_out",
  "cancelled",
]);
const SAFE_ERROR_CODES = new Set([
  "policy_preflight_rejected",
  "provider_error",
  "provider_failed",
  "provider_rate_limited",
  "provider_unavailable",
  "provider_call_budget_exhausted",
  "deadline",
  "deadline_exceeded",
  "cancelled",
  "replay_invalid",
  "packet_proof_observer_failed",
  "root_cause_not_established",
  "no_authoritative_answer",
  "malformed_proposal",
  "host_validation_unconfigured",
  // Host-owned lifecycle fallbacks emitted by collab-triage-run. These are
  // bounded classifications, not provider text, and must survive the bridge
  // instead of being flattened into an unrelated generic gateway failure.
  "live_run_failed",
  "live_run_stopped",
  "cancel_requested",
  "gateway_runner_error",
]);

interface RunnerRequest {
  schemaId: "cd-collab.triage_run_request.v1";
  jobId: string;
  case: {
    caseId: string;
    title: string;
    reportedProblem: {
      summary: string;
      reportedAt: string | null;
      reporter: string | null;
      symptoms: string[];
    };
    createdAt: string;
  };
  snapshot: {
    snapshotId: string;
    fingerprint: string;
    capturedAt: string;
    capturedBy: string;
    parentSnapshotId: string | null;
    visibility: string;
    protocolVersion: string;
    evidence: Array<{
      evidenceId: string;
      ordinal: number;
      contentHash: string | null;
      expectedHash: string | null;
      verificationStatus: string | null;
      privacyClass: string;
    }>;
  };
  taskFingerprint: string;
  concurrency?: number;
  question: string;
  strategyId: string;
  policyFingerprint: string | null;
  requestedBy: string;
  createdAt: string;
  candidates: Array<{
    candidateId: string;
    role: string;
    provider: string;
    profileId: string;
    modelId: string;
    version: string | null;
    build: string | null;
    cancellationId: string;
  }>;
  evidence: Array<{
    itemId: string;
    bytesBase64: string;
    captureTime: string;
    reference: string;
    capturedFrom: string;
    mediaType: string;
    format: string;
    visibleToStrategies: boolean;
  }>;
}

interface CliEnvelope {
  ok?: boolean;
  data?: unknown;
  error?: { kind?: unknown; message?: unknown };
}

function terminalStatus(raw: unknown): TriageCandidateRunV1["status"] {
  if (typeof raw !== "string") throw new Error("gateway runner returned a non-string status");
  const value = raw.toLowerCase().replaceAll("-", "_") as TriageCandidateRunV1["status"];
  if (!TERMINAL_STATUSES.has(value)) {
    throw new Error("gateway runner returned a non-terminal or unknown status");
  }
  return value;
}

function resultRows(data: unknown): unknown[] {
  if (typeof data !== "object" || data === null) return [];
  const body = data as { candidates?: unknown; runs?: unknown };
  if (Array.isArray(body.candidates)) return body.candidates;
  if (Array.isArray(body.runs)) return body.runs;
  return [];
}

function field(row: unknown, ...names: string[]): unknown {
  if (typeof row !== "object" || row === null) return undefined;
  for (const name of names) {
    if (name in row) return (row as Record<string, unknown>)[name];
  }
  return undefined;
}

function stringField(row: unknown, ...names: string[]): string | null {
  const value = field(row, ...names);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArrayField(row: unknown, ...names: string[]): string[] {
  const value = field(row, ...names);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("gateway runner returned an invalid string array");
  }
  return value as string[];
}

function safeErrorCode(row: unknown, status: TriageCandidateRunV1["status"]): string | null {
  if (status === "completed") return null;
  const value = stringField(row, "errorCode", "error_code");
  return value && SAFE_ERROR_CODES.has(value) ? value : "gateway_error";
}

/** Accept only the host's bounded structured projection, never arbitrary raw output. */
function safeSummary(row: unknown, runId: string): string {
  const fallback = `Live gateway result recorded as ${runId}.`;
  const value = stringField(row, "summary");
  if (!value || value.length > MAX_SAFE_SUMMARY_CHARS || value.includes("\0")) return fallback;
  const lower = value.toLowerCase();
  if (
    lower.includes("bearer ") ||
    lower.includes("ai-gateway.vercel.sh") ||
    lower.includes("apikey") ||
    lower.includes("api_key") ||
    lower.includes("authorization")
  ) return fallback;
  return value.trim() || fallback;
}

function mapCandidateRow(
  row: unknown,
  spec: TriageBatchExecutionContext["request"]["candidates"][number],
  authorizedEvidence: Set<string>,
): TriageCandidateRunV1 {
  const status = terminalStatus(field(row, "status"));
  const runId = stringField(row, "runId", "run_id");
  const outputHash = stringField(row, "outputHash", "output_hash");
  if ((status === "completed" || status === "partial") && (!runId || !outputHash)) {
    throw new Error("gateway runner omitted durable identity for a successful result");
  }
  const evidenceRefs = stringArrayField(row, "evidenceRefs", "evidence_refs");
  if (evidenceRefs.some((reference) => !authorizedEvidence.has(reference))) {
    throw new Error("gateway runner returned evidence outside the authorized snapshot");
  }
  return {
    ...spec,
    status,
    benchmarkRunId: runId,
    outputHash,
    // Only the host's bounded structured claim projection crosses this
    // boundary. The raw provider answer remains host-owned.
    summary: runId ? safeSummary(row, runId) : null,
    evidenceRefs,
    unknowns: ["gateway usage and cost were not normalized"],
    usageStatus: "unknown",
    costStatus: "unknown",
    errorCode: safeErrorCode(row, status),
    startedAt: stringField(row, "startedAt", "started_at"),
    // A host response without timing remains unknown; never manufacture a
    // timestamp at the server boundary.
    finishedAt: stringField(row, "finishedAt", "finished_at"),
    privacyClass: "owner_only",
  };
}

function mapResults(
  data: unknown,
  context: TriageBatchExecutionContext,
): TriageCandidateRunV1[] {
  const rows = resultRows(data);
  if (rows.length !== context.request.candidates.length) {
    throw new Error("gateway runner returned an incomplete candidate set");
  }
  const authorizedEvidence = new Set(context.evidence.map((item) => item.evidenceId));
  const rowsByCandidateId = new Map<string, unknown>();
  for (const row of rows) {
    const candidateId = stringField(row, "candidateId", "candidate_id");
    if (!candidateId || rowsByCandidateId.has(candidateId)) {
      throw new Error("gateway runner returned invalid candidate identities");
    }
    rowsByCandidateId.set(candidateId, row);
  }
  return context.request.candidates.map((spec, index) => {
    const row = rowsByCandidateId.get(spec.candidateId);
    if (!row) throw new Error(`gateway runner omitted candidate ${index + 1}`);
    return mapCandidateRow(row, spec, authorizedEvidence);
  });
}

type ProgressEvent =
  | { kind: "started"; candidateId: string }
  | { kind: "persisted"; candidate: TriageCandidateRunV1 };

function mapProgressEvent(
  raw: unknown,
  context: TriageBatchExecutionContext,
): ProgressEvent {
  const action = field(raw, "action");
  if (
    field(raw, "schemaId", "schema_id") !== PROGRESS_SCHEMA_ID
    || (action !== "candidate_started" && action !== "candidate_persisted")
    || stringField(raw, "jobId", "job_id") !== context.jobId
    || stringField(raw, "caseId", "case_id") !== context.case.id
    || stringField(raw, "collabSnapshotId", "collab_snapshot_id") !== context.snapshot.id
    || stringField(raw, "collabSnapshotFingerprint", "collab_snapshot_fingerprint") !== context.snapshot.fingerprint
  ) {
    throw new Error("gateway runner returned invalid progress identity");
  }
  if (action === "candidate_started") {
    const candidateId = stringField(raw, "candidateId", "candidate_id");
    if (!candidateId || !context.request.candidates.some((candidate) => candidate.candidateId === candidateId)) {
      throw new Error("gateway runner returned an unknown started candidate");
    }
    return { kind: "started", candidateId };
  }
  const row = field(raw, "candidate");
  const candidateId = stringField(row, "candidateId", "candidate_id");
  const spec = context.request.candidates.find((candidate) => candidate.candidateId === candidateId);
  if (!spec) throw new Error("gateway runner returned an unknown progress candidate");
  const authorizedEvidence = new Set(context.evidence.map((item) => item.evidenceId));
  return { kind: "persisted", candidate: mapCandidateRow(row, spec, authorizedEvidence) };
}

export interface RustBridgeTriageExecutorOptions {
  command: string;
  /** Immutable arguments placed before ContextDesk's generated CLI arguments. */
  prefixArgs?: readonly string[];
  library?: string;
  timeoutMs?: number;
  dataDir?: string;
}

/** Runs the existing Rust host bridge without putting credentials in Node or Postgres. */
export class RustBridgeTriageExecutor implements TriageBatchRunExecutor {
  private readonly options: Readonly<RustBridgeTriageExecutorOptions>;

  constructor(options: RustBridgeTriageExecutorOptions) {
    this.options = {
      ...options,
      prefixArgs: Object.freeze([...(options.prefixArgs ?? [])]),
    };
  }

  async executeBatch(
    context: TriageBatchExecutionContext,
    signal: AbortSignal,
  ): Promise<TriageCandidateRunV1[]> {
    const request: RunnerRequest = {
      schemaId: RUNNER_SCHEMA_ID,
      jobId: context.jobId,
      case: {
        caseId: context.case.id,
        title: context.case.title,
        reportedProblem: {
          summary: context.case.title,
          reportedAt: context.case.createdAt,
          reporter: context.case.createdBy,
          symptoms: [],
        },
        createdAt: context.case.createdAt,
      },
      snapshot: {
        snapshotId: context.snapshot.id,
        fingerprint: context.snapshot.fingerprint,
        capturedAt: context.snapshot.createdAt,
        capturedBy: context.snapshot.createdBy,
        parentSnapshotId: context.snapshot.parentSnapshotId,
        visibility: context.snapshot.visibility,
        protocolVersion: context.snapshot.protocolVersion,
        evidence: context.snapshot.evidence.map((item) => ({
          evidenceId: item.evidenceId,
          ordinal: item.ordinal,
          contentHash: item.contentHash,
          expectedHash: item.expectedHash,
          verificationStatus: item.verificationStatus,
          privacyClass: item.privacyClass,
        })),
      },
      taskFingerprint: context.request.taskFingerprint,
      ...(context.request.mode === "gateway" ? { concurrency: context.request.concurrency ?? 2 } : {}),
      question: context.request.question,
      strategyId: context.request.strategyId,
      policyFingerprint: context.request.policyFingerprint,
      requestedBy: context.requestedBy,
      createdAt: context.createdAt,
      candidates: context.request.candidates.map((candidate) => {
        if (!candidate.profileId) throw new Error("gateway candidates require a provider profile id");
        return {
          candidateId: candidate.candidateId,
          role: candidate.role,
          provider: candidate.provider,
          profileId: candidate.profileId,
          modelId: candidate.model,
          version: candidate.version,
          build: null,
          cancellationId: `${context.jobId}:${candidate.candidateId}`,
        };
      }),
      evidence: context.evidence.map((item) => ({
        itemId: item.evidenceId,
        bytesBase64: item.contentBase64 ?? "",
        captureTime: context.snapshot.createdAt,
        reference: item.evidenceId,
        capturedFrom: "ContextDesk Collab",
        mediaType: item.mediaType ?? "text/plain",
        format: "raw",
        visibleToStrategies: item.contentBase64 !== null,
      })),
    };
    const bytes = Buffer.from(JSON.stringify(request), "utf8");
    if (bytes.byteLength > MAX_REQUEST_BYTES) throw new Error("gateway runner request exceeded the size bound");
    const root = await mkdtemp(join(tmpdir(), "contextdesk-collab-run-"));
    const requestPath = join(root, "request.json");
    await writeFile(requestPath, bytes, { encoding: "utf8", mode: 0o600 });
    try {
      const startedSeen = new Set<string>();
      const progressSeen = new Set<string>();
      // `--json` is a global CLI option, while `--progress-events` belongs
      // to the collab-triage-run subcommand. Keeping the two in their
      // respective argument positions matters for clap's strict parser and
      // makes the server invocation match the documented direct invocation.
      const args = ["--json"];
      if (this.options.dataDir) args.push("--data-dir", this.options.dataDir);
      args.push("collab-triage-run", "--request", requestPath, "--progress-events");
      if (this.options.library) args.push("--library", this.options.library);
      const result = await this.runProcess(args, signal, async (raw) => {
        const mapped = mapProgressEvent(raw, context);
        if (mapped.kind === "started") {
          if (startedSeen.has(mapped.candidateId)) {
            throw new Error("gateway runner returned duplicate lane admission");
          }
          startedSeen.add(mapped.candidateId);
          await context.onCandidateStarted?.(mapped.candidateId);
          return;
        }
        if (progressSeen.has(mapped.candidate.candidateId)) {
          throw new Error("gateway runner returned duplicate progress for a candidate");
        }
        progressSeen.add(mapped.candidate.candidateId);
        await context.onCandidate?.(mapped.candidate);
      });
      if (result.ok !== true) {
        const kind = typeof result.error?.kind === "string" ? result.error.kind : "runner_error";
        if (kind === "cancelled") throw new Error("cancelled");
        if (kind === "not_ready") throw new Error("deadline exceeded");
        throw new Error(`gateway runner ${kind}`);
      }
      if (typeof result.data !== "object" || result.data === null
        || stringField(result.data, "schemaId", "schema_id") !== RESULT_SCHEMA_ID
        || stringField(result.data, "action") !== "collab_triage_run"
        || stringField(result.data, "jobId", "job_id") !== context.jobId
        || stringField(result.data, "caseId", "case_id") !== context.case.id
        || stringField(result.data, "collabSnapshotId", "collab_snapshot_id") !== context.snapshot.id
        || stringField(result.data, "collabSnapshotFingerprint", "collab_snapshot_fingerprint") !== context.snapshot.fingerprint) {
        throw new Error("gateway runner returned a different snapshot identity");
      }
      if (field(result.data, "sameSnapshot", "same_snapshot") !== true) {
        throw new Error("gateway runner did not prove same-snapshot execution");
      }
      return mapResults(result.data, context);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  private runProcess(
    args: string[],
    signal: AbortSignal,
    onProgress: (raw: unknown) => void | Promise<void> = () => {},
  ): Promise<CliEnvelope> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.command, [
        ...(this.options.prefixArgs ?? []),
        ...args,
      ], {
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let overflow = false;
      let timedOut = false;
      let progressError: Error | null = null;
      let stderrRemainder = "";
      const progressTasks: Promise<void>[] = [];
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
      const clearTerminationTimers = () => {
        clearTimeout(timeout);
        if (forceKillTimer !== null) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }
      };
      const terminateProcessGroup = (signalName: NodeJS.Signals) => {
        if (typeof child.pid === "number") {
          try {
            process.kill(-child.pid, signalName);
            return;
          } catch {
            // Fall back to the direct child when a platform/runtime does not
            // expose the process group anymore.
          }
        }
        child.kill(signalName);
      };
      const interruptChild = () => {
        terminateProcessGroup("SIGINT");
        if (forceKillTimer === null) {
          forceKillTimer = setTimeout(() => {
            // SIGINT is cooperative; SIGKILL is the bounded fallback for a
            // host process that ignores cancellation or has deadlocked.
            terminateProcessGroup("SIGKILL");
          }, FORCE_KILL_GRACE_MS);
        }
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        interruptChild();
      }, this.options.timeoutMs ?? 300_000);
      const abort = () => interruptChild();
      if (signal.aborted) abort();
      signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        if (Buffer.byteLength(stdout) + chunk.byteLength > MAX_OUTPUT_BYTES) {
          overflow = true;
          interruptChild();
          return;
        }
        stdout += chunk.toString("utf8");
      });
      const inspectProgressLine = (line: string) => {
        if (!line.startsWith(PROGRESS_EVENT_PREFIX)) return;
        if (Buffer.byteLength(line, "utf8") > MAX_PROGRESS_LINE_BYTES) {
          progressError = new Error("gateway runner progress event exceeded the size bound");
          interruptChild();
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line.slice(PROGRESS_EVENT_PREFIX.length));
        } catch {
          progressError = new Error("gateway runner returned invalid progress");
          interruptChild();
          return;
        }
        const task = Promise.resolve()
          .then(() => onProgress(parsed))
          .catch((error: unknown) => {
            progressError = error instanceof Error ? error : new Error("invalid gateway progress");
            interruptChild();
          });
        progressTasks.push(task);
        if (progressTasks.length > MAX_PROGRESS_EVENTS) {
          progressError = new Error("gateway runner returned too many progress events");
          interruptChild();
        }
      };
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrRemainder += chunk.toString("utf8");
        const lines = stderrRemainder.split("\n");
        stderrRemainder = lines.pop() ?? "";
        for (const line of lines) inspectProgressLine(line.replace(/\r$/, ""));
        if (Buffer.byteLength(stderrRemainder, "utf8") > MAX_PROGRESS_LINE_BYTES) {
          stderrRemainder = "";
        }
      });
      child.once("error", () => {
        clearTerminationTimers();
        signal.removeEventListener("abort", abort);
        reject(new Error("gateway runner could not start"));
      });
      child.once("close", async (code) => {
        clearTerminationTimers();
        signal.removeEventListener("abort", abort);
        if (stderrRemainder) inspectProgressLine(stderrRemainder.replace(/\r$/, ""));
        await Promise.all(progressTasks);
        if (timedOut) {
          reject(new Error("deadline exceeded"));
          return;
        }
        if (signal.aborted) {
          reject(new Error("cancelled"));
          return;
        }
        if (overflow) {
          reject(new Error("gateway runner output overflow"));
          return;
        }
        if (progressError) {
          reject(progressError);
          return;
        }
        if (!stdout.trim()) {
          reject(new Error("gateway runner returned invalid output"));
          return;
        }
        let parsed: CliEnvelope;
        try {
          parsed = JSON.parse(stdout.trim()) as CliEnvelope;
        } catch {
          reject(new Error(code === 0 ? "gateway runner returned invalid output" : "gateway runner failed"));
          return;
        }
        resolve(parsed);
      });
    });
  }
}
