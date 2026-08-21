/**
 * Hermetic converter: stored/replay triage run artifacts → strategy_package.v1.
 *
 * Projects share-safe bench-compare / recorded-run envelopes into the Experiment
 * Lab import surface. Never invents gold, cost, usage, prompts, or provider calls.
 * Ambiguous structure stays unknown. DeepSeek lane labels are rejected.
 */

import { ContractViolation } from "./parse.js";
import {
  AGREEMENT_NOT_CORRECTNESS,
  CANDIDATE_ROLES,
  EXPERIMENT_PACKAGE_SCHEMA_ID,
  type CandidateRole,
  type ExperimentCandidateV1,
  type ExperimentPackageV1,
  type ExperimentRunStatus,
} from "./experiment.js";
import {
  INTERACTION_TRACE_SCHEMA_ID,
  STRATEGY_PACKAGE_SCHEMA_ID,
  TRACE_UNKNOWN_STAYS_UNKNOWN,
  boundExcerpt,
  parseInteractionTrace,
  parseStrategyPackage,
  sha256Hex,
  type InteractionEventV1,
  type InteractionTraceV1,
  type StrategyPackageV1,
} from "./trace.js";

export const BENCH_RUN_ARTIFACT_SCHEMA_ID = "cd-collab.bench_run_artifact.v1" as const;
export const BENCH_COMPARE_CLI_SCHEMA_ID = "contextdesk.cli.bench_compare.v1" as const;

export const BENCH_ARTIFACT_NO_GOLD =
  "Hermetic bench-artifact import never invents a gold reference." as const;
export const BENCH_ARTIFACT_NO_PROVIDER =
  "Hermetic bench-artifact import performs no provider calls." as const;
export const BENCH_ARTIFACT_UNKNOWN_COST_USAGE =
  "Cost and usage stay unknown unless the share-safe projection already proved them; this converter never invents either." as const;

/** Synthetic employer-lane labels allowed in hermetic fixtures (examples, not an allowlist). */
export const SYNTHETIC_EMPLOYER_LANE_LABELS = [
  "qwen-3.6-27b",
  "gpt-oss-120b",
  "ministral-3-14b-instruct-2512",
] as const;

const REJECTED_MODEL_LABEL = /deepseek/i;

export interface ShareSafeRunProjectionV1 {
  privacy: "share_safe";
  benchRunId: string;
  sdkRunId: string;
  taskFingerprint: string;
  snapshotFingerprint: string;
  status: string;
  acceptedEvidenceIds: string[];
  rootCauseEstablished: boolean | null;
  reasonCodes: string[];
  configuredRoleSlots: number | null;
  completedRoleSlots: number | null;
  usage: "unknown";
  cost: "unknown";
  answerIncluded: false;
  rawOutputIncluded: false;
}

export interface BenchArtifactLaneV1 {
  candidateId: string;
  modelLabel: string;
  role: CandidateRole;
  shareSafe: ShareSafeRunProjectionV1;
}

export interface BenchRunArtifactV1 {
  schemaId: typeof BENCH_RUN_ARTIFACT_SCHEMA_ID;
  privacyClass: "share_safe";
  packageId: string;
  createdAt: string;
  taskFingerprint: string;
  snapshotFingerprint: string;
  lanes: BenchArtifactLaneV1[];
  notes: string[];
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractViolation(path, "expected object");
  }
  return value as Record<string, unknown>;
}

function strField(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function numField(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function assertNoDeepSeek(path: string, modelLabel: string): void {
  if (REJECTED_MODEL_LABEL.test(modelLabel)) {
    throw new ContractViolation(path, "DeepSeek model labels are rejected for this import path");
  }
}

function mapRunStatus(status: string): ExperimentRunStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "partial":
      return "partial";
    case "timed_out":
    case "timeout":
      return "timeout";
    default:
      return "partial";
  }
}

function collectEvidenceIds(raw: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const sdkResult = raw.sdk_result ?? raw.sdkResult;
  if (sdkResult && typeof sdkResult === "object" && !Array.isArray(sdkResult)) {
    const accepted = (sdkResult as Record<string, unknown>).accepted_evidence_ids
      ?? (sdkResult as Record<string, unknown>).acceptedEvidenceIds;
    if (Array.isArray(accepted)) {
      for (const id of accepted) {
        if (typeof id === "string" && id.trim()) ids.add(id.trim());
      }
    }
  }
  const top = raw.accepted_evidence_ids ?? raw.acceptedEvidenceIds;
  if (Array.isArray(top)) {
    for (const id of top) {
      if (typeof id === "string" && id.trim()) ids.add(id.trim());
    }
  }
  return [...ids].sort();
}

function collectReasonCodes(raw: Record<string, unknown>): string[] {
  const codes = new Set<string>();
  const top = raw.reason_codes ?? raw.reasonCodes;
  if (Array.isArray(top)) {
    for (const code of top) {
      if (typeof code === "string" && code.trim()) codes.add(code.trim());
    }
  }
  const sdkResult = raw.sdk_result ?? raw.sdkResult;
  if (sdkResult && typeof sdkResult === "object" && !Array.isArray(sdkResult)) {
    const nested = (sdkResult as Record<string, unknown>).reason_codes
      ?? (sdkResult as Record<string, unknown>).reasonCodes;
    if (Array.isArray(nested)) {
      for (const code of nested) {
        if (typeof code === "string" && code.trim()) codes.add(code.trim());
      }
    }
  }
  return [...codes].sort();
}

function rootCauseFlag(raw: Record<string, unknown>): boolean | null {
  if (typeof raw.root_cause_established === "boolean") return raw.root_cause_established;
  if (typeof raw.rootCauseEstablished === "boolean") return raw.rootCauseEstablished;
  const sdkResult = raw.sdk_result ?? raw.sdkResult;
  if (sdkResult && typeof sdkResult === "object" && !Array.isArray(sdkResult)) {
    const reconciliation =
      (sdkResult as Record<string, unknown>).reconciliation;
    if (reconciliation && typeof reconciliation === "object" && !Array.isArray(reconciliation)) {
      const flag = (reconciliation as Record<string, unknown>).root_cause_established
        ?? (reconciliation as Record<string, unknown>).rootCauseEstablished;
      if (typeof flag === "boolean") return flag;
    }
  }
  return null;
}

/** Parse one adapter share-safe projection (camelCase or snake_case). */
export function parseShareSafeRunProjection(
  raw: unknown,
  path = "$.shareSafe",
): ShareSafeRunProjectionV1 {
  const record = asRecord(raw, path);
  const privacy = strField(record, "privacy");
  if (privacy !== "share_safe") {
    throw new ContractViolation(`${path}.privacy`, "must be share_safe");
  }
  const benchRunId = strField(record, "bench_run_id", "benchRunId");
  const sdkRunId = strField(record, "sdk_run_id", "sdkRunId");
  const taskFingerprint = strField(record, "task_fingerprint", "taskFingerprint");
  const snapshotFingerprint = strField(record, "snapshot_fingerprint", "snapshotFingerprint");
  const status = strField(record, "status");
  if (!benchRunId || !sdkRunId || !taskFingerprint || !snapshotFingerprint || !status) {
    throw new ContractViolation(path, "missing required share-safe identity fields");
  }
  if (record.answer_included === true || record.answerIncluded === true) {
    throw new ContractViolation(`${path}.answerIncluded`, "share-safe answer content is refused");
  }
  if (record.raw_output_included === true || record.rawOutputIncluded === true) {
    throw new ContractViolation(`${path}.rawOutputIncluded`, "share-safe raw output is refused");
  }
  const usage = strField(record, "usage") ?? "unknown";
  const cost = strField(record, "cost") ?? "unknown";
  if (usage !== "unknown" || cost !== "unknown") {
    throw new ContractViolation(
      path,
      "converter refuses share-safe rows that invent observed cost or usage",
    );
  }
  return {
    privacy: "share_safe",
    benchRunId,
    sdkRunId,
    taskFingerprint,
    snapshotFingerprint,
    status,
    acceptedEvidenceIds: collectEvidenceIds(record),
    rootCauseEstablished: rootCauseFlag(record),
    reasonCodes: collectReasonCodes(record),
    configuredRoleSlots: numField(record, "configured_role_slots", "configuredRoleSlots"),
    completedRoleSlots: numField(record, "completed_role_slots", "completedRoleSlots"),
    usage: "unknown",
    cost: "unknown",
    answerIncluded: false,
    rawOutputIncluded: false,
  };
}

function evidenceEvents(
  candidateId: string,
  evidenceIds: string[],
  parentEventId: string,
  startSequence: number,
): InteractionEventV1[] {
  return evidenceIds.map((evidenceRef, index) => {
    const sequence = startSequence + index;
    const excerpt = boundExcerpt(`Accepted evidence ${evidenceRef}`);
    return {
      eventId: `evt-${candidateId}-evidence-${index + 1}`,
      sequence,
      kind: "evidence_anchor" as const,
      actor: "assistant" as const,
      role: "evidence",
      parentEventId: index === 0 ? parentEventId : `evt-${candidateId}-evidence-${index}`,
      evidenceRefs: [evidenceRef],
      observedAt: { status: "unknown" as const },
      excerpt,
      excerptHash: excerpt ? sha256Hex(excerpt) : null,
      unknowns: ["timestamp"],
    };
  });
}

/** Project one share-safe run into a programmatic interaction_trace.v1. */
export function shareSafeRunToInteractionTrace(
  lane: BenchArtifactLaneV1,
  createdAt: string,
): InteractionTraceV1 {
  const { candidateId, shareSafe } = lane;
  const unknowns = ["question", "raw answer", "tools", "usage", "cost", "timestamp"];
  const questionId = `evt-${candidateId}-question`;
  const events: InteractionEventV1[] = [
    {
      eventId: questionId,
      sequence: 1,
      kind: "question",
      actor: "human",
      role: null,
      parentEventId: null,
      evidenceRefs: [],
      observedAt: { status: "unknown" },
      excerpt: null,
      excerptHash: null,
      unknowns: ["text", "timestamp"],
    },
  ];

  const evidence = evidenceEvents(candidateId, shareSafe.acceptedEvidenceIds, questionId, 2);
  events.push(...evidence);

  let nextSequence = events.length + 1;
  let parentId = events[events.length - 1]?.eventId ?? questionId;
  if (shareSafe.rootCauseEstablished === true) {
    const excerpt = boundExcerpt("Share-safe projection reported root_cause_established=true.");
    events.push({
      eventId: `evt-${candidateId}-hypothesis`,
      sequence: nextSequence,
      kind: "hypothesis",
      actor: "assistant",
      role: "cause",
      parentEventId: parentId,
      evidenceRefs: [...shareSafe.acceptedEvidenceIds],
      observedAt: { status: "unknown" },
      excerpt,
      excerptHash: excerpt ? sha256Hex(excerpt) : null,
      unknowns: ["timestamp", "raw answer"],
    });
    parentId = `evt-${candidateId}-hypothesis`;
    nextSequence += 1;
  } else if (shareSafe.rootCauseEstablished === null) {
    unknowns.push("root_cause");
  }

  const reasonExcerpt = shareSafe.reasonCodes.length
    ? boundExcerpt(`Reason codes: ${shareSafe.reasonCodes.join(", ")}`)
    : null;
  events.push({
    eventId: `evt-${candidateId}-status`,
    sequence: nextSequence,
    kind: "recommendation",
    actor: "assistant",
    role: null,
    parentEventId: parentId,
    evidenceRefs: [...shareSafe.acceptedEvidenceIds],
    observedAt: { status: "unknown" },
    excerpt: reasonExcerpt ?? boundExcerpt(`Terminal status: ${shareSafe.status}`),
    excerptHash: sha256Hex(reasonExcerpt ?? shareSafe.status),
    unknowns: ["timestamp", "raw answer"],
  });

  const evidenceSteps = shareSafe.acceptedEvidenceIds.length;
  return parseInteractionTrace({
    schemaId: INTERACTION_TRACE_SCHEMA_ID,
    traceId: `trace-${candidateId}-${sha256Hex(shareSafe.benchRunId).slice(0, 12)}`,
    candidateId,
    sourceKind: "programmatic",
    completeness: "partial",
    privacyClass: "share_safe",
    rawHash: sha256Hex(shareSafe.sdkRunId),
    events,
    efficiency: {
      turnCount: { status: "unknown" },
      evidenceAcquisitionSteps:
        evidenceSteps > 0
          ? { status: "observed", count: evidenceSteps }
          : { status: "unknown" },
      latency: { status: "unknown" },
      cost: { status: "unknown" },
      providerCalls:
        shareSafe.completedRoleSlots != null
          ? { status: "observed", count: shareSafe.completedRoleSlots }
          : { status: "unknown" },
    },
    unknowns,
    notes: [
      TRACE_UNKNOWN_STAYS_UNKNOWN,
      BENCH_ARTIFACT_NO_PROVIDER,
      BENCH_ARTIFACT_UNKNOWN_COST_USAGE,
      "Projected from a share-safe bench run; task text and raw answers remain host-owned.",
    ],
    createdAt,
  });
}

function agreementFromLanes(
  candidates: ExperimentCandidateV1[],
  traces: InteractionTraceV1[],
  notes: string[],
): ExperimentPackageV1["agreement"] {
  const refs = new Map<string, string[]>();
  for (const trace of traces) {
    for (const ref of new Set(trace.events.flatMap((event) => event.evidenceRefs))) {
      const owners = refs.get(ref) ?? [];
      owners.push(trace.candidateId);
      refs.set(ref, owners);
    }
  }
  const sharedAnchors = [...refs.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([evidenceRef, candidateIds]) => ({
      evidenceRef,
      role: "evidence",
      candidateIds: [...candidateIds].sort(),
    }));
  const candidateSpecific = candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    evidenceRefs: [...refs.entries()]
      .filter(([, owners]) => owners.length === 1 && owners[0] === candidate.candidateId)
      .map(([evidenceRef]) => evidenceRef)
      .sort(),
  }));
  return {
    sharedAnchors,
    candidateSpecific,
    roleConflicts: [],
    notes: [AGREEMENT_NOT_CORRECTNESS, BENCH_ARTIFACT_NO_GOLD, ...notes],
  };
}

function resolveShareSafeForLane(
  laneRaw: Record<string, unknown>,
  index: number,
  embedded: ShareSafeRunProjectionV1[],
  path: string,
): ShareSafeRunProjectionV1 {
  if ("shareSafe" in laneRaw || "share_safe" in laneRaw) {
    return parseShareSafeRunProjection(laneRaw.shareSafe ?? laneRaw.share_safe, `${path}.shareSafe`);
  }
  const benchRunId = strField(laneRaw, "benchRunId", "bench_run_id");
  if (benchRunId) {
    const match = embedded.find((row) => row.benchRunId === benchRunId);
    if (!match) {
      throw new ContractViolation(`${path}.benchRunId`, "unknown bench run id");
    }
    return match;
  }
  const shareSafeIndex = numField(laneRaw, "shareSafeIndex", "share_safe_index");
  if (shareSafeIndex != null) {
    const match = embedded[shareSafeIndex];
    if (!match) {
      throw new ContractViolation(`${path}.shareSafeIndex`, "index out of range");
    }
    return match;
  }
  if (embedded[index]) return embedded[index];
  throw new ContractViolation(path, "lane must include shareSafe, benchRunId, or shareSafeIndex");
}

function parseLane(
  raw: unknown,
  index: number,
  embedded: ShareSafeRunProjectionV1[],
  path: string,
): BenchArtifactLaneV1 {
  const record = asRecord(raw, path);
  const candidateId = strField(record, "candidateId", "candidate_id");
  const modelLabel = strField(record, "modelLabel", "model_label");
  if (!candidateId || !modelLabel) {
    throw new ContractViolation(path, "candidateId and modelLabel are required");
  }
  assertNoDeepSeek(`${path}.modelLabel`, modelLabel);
  const roleRaw = strField(record, "role") ?? "single";
  if (!(CANDIDATE_ROLES as readonly string[]).includes(roleRaw)) {
    throw new ContractViolation(`${path}.role`, `expected one of ${CANDIDATE_ROLES.join(", ")}`);
  }
  return {
    candidateId,
    modelLabel,
    role: roleRaw as CandidateRole,
    shareSafe: resolveShareSafeForLane(record, index, embedded, path),
  };
}

function parseEmbeddedShareSafe(raw: unknown, path: string): ShareSafeRunProjectionV1[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new ContractViolation(path, "expected array");
  }
  return raw.map((item, index) => parseShareSafeRunProjection(item, `${path}[${index}]`));
}

function toLabFingerprint(
  value: string,
  prefix: "task" | "snap",
  path: string,
): string {
  const normalized = value.trim().toLowerCase();
  const digest = normalized.replace(/^(?:task|snap|tkf|snf)-/, "");
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new ContractViolation(path, `${prefix} fingerprint must contain a SHA-256 digest`);
  }
  return `${prefix}-${digest}`;
}

/**
 * Normalize a bench-run artifact or a bench-compare CLI JSON + lanes overlay
 * into the typed import document.
 */
export function parseBenchRunArtifact(raw: unknown): BenchRunArtifactV1 {
  const record = asRecord(raw, "$");
  const schemaId = strField(record, "schemaId", "schema_id");
  if (
    schemaId !== BENCH_RUN_ARTIFACT_SCHEMA_ID &&
    schemaId !== BENCH_COMPARE_CLI_SCHEMA_ID
  ) {
    throw new ContractViolation(
      "$.schemaId",
      `expected ${BENCH_RUN_ARTIFACT_SCHEMA_ID} or ${BENCH_COMPARE_CLI_SCHEMA_ID}`,
    );
  }

  const embedded = parseEmbeddedShareSafe(
    record.shareSafe ?? record.share_safe,
    "$.shareSafe",
  );
  const lanesRaw = record.lanes;
  if (!Array.isArray(lanesRaw) || lanesRaw.length < 1) {
    throw new ContractViolation("$.lanes", "at least one lane is required");
  }
  const lanes = lanesRaw.map((lane, index) => parseLane(lane, index, embedded, `$.lanes[${index}]`));
  const candidateIds = new Set<string>();
  for (const [index, lane] of lanes.entries()) {
    if (candidateIds.has(lane.candidateId)) {
      throw new ContractViolation(`$.lanes[${index}].candidateId`, "duplicate candidateId");
    }
    candidateIds.add(lane.candidateId);
  }

  const taskFingerprint = toLabFingerprint(
    strField(record, "taskFingerprint", "task_fingerprint") ?? lanes[0]!.shareSafe.taskFingerprint,
    "task",
    "$.taskFingerprint",
  );
  const snapshotFingerprint = toLabFingerprint(
    strField(record, "snapshotFingerprint", "snapshot_fingerprint")
      ?? lanes[0]!.shareSafe.snapshotFingerprint,
    "snap",
    "$.snapshotFingerprint",
  );
  for (const [index, lane] of lanes.entries()) {
    const laneTask = toLabFingerprint(
      lane.shareSafe.taskFingerprint,
      "task",
      `$.lanes[${index}].shareSafe.taskFingerprint`,
    );
    const laneSnap = toLabFingerprint(
      lane.shareSafe.snapshotFingerprint,
      "snap",
      `$.lanes[${index}].shareSafe.snapshotFingerprint`,
    );
    if (laneTask !== taskFingerprint) {
      throw new ContractViolation(
        `$.lanes[${index}].shareSafe.taskFingerprint`,
        "all lanes must share one task fingerprint",
      );
    }
    if (laneSnap !== snapshotFingerprint) {
      throw new ContractViolation(
        `$.lanes[${index}].shareSafe.snapshotFingerprint`,
        "all lanes must share one snapshot fingerprint",
      );
    }
  }

  const packageId =
    strField(record, "packageId", "package_id")
    ?? `pkg-bench-${sha256Hex(lanes.map((lane) => lane.shareSafe.benchRunId).join("|")).slice(0, 16)}`;
  const createdAt =
    strField(record, "createdAt", "created_at") ?? "1970-01-01T00:00:00.000Z";
  const privacy = strField(record, "privacyClass", "privacy") ?? "share_safe";
  // Bench-compare CLI payloads are owner-only overall; only the embedded
  // share_safe projections are admitted into the Lab strategy package.
  if (schemaId === BENCH_RUN_ARTIFACT_SCHEMA_ID && privacy !== "share_safe") {
    throw new ContractViolation("$.privacyClass", "bench-run artifacts must be share_safe");
  }

  const notes = Array.isArray(record.notes)
    ? record.notes.filter((note): note is string => typeof note === "string" && note.trim().length > 0)
    : [];

  return {
    schemaId: BENCH_RUN_ARTIFACT_SCHEMA_ID,
    privacyClass: "share_safe",
    packageId,
    createdAt,
    taskFingerprint,
    snapshotFingerprint,
    lanes,
    notes,
  };
}

/** Convert a parsed bench-run artifact into a share-safe strategy_package.v1. */
export function convertBenchRunArtifactToStrategyPackage(
  artifact: BenchRunArtifactV1,
): StrategyPackageV1 {
  const candidates: ExperimentCandidateV1[] = artifact.lanes.map((lane) => ({
    candidateId: lane.candidateId,
    modelLabel: lane.modelLabel,
    role: lane.role,
    runStatus: mapRunStatus(lane.shareSafe.status),
    observedLatency: { status: "unknown" },
    cost: { status: "unknown" },
    usage: { status: "unknown" },
    helpfulnessState: "unreviewed",
    goldState: "unknown",
  }));
  const traces = artifact.lanes.map((lane) =>
    shareSafeRunToInteractionTrace(lane, artifact.createdAt),
  );
  const notes = [
    BENCH_ARTIFACT_NO_PROVIDER,
    BENCH_ARTIFACT_UNKNOWN_COST_USAGE,
    ...artifact.notes,
  ];
  const experiment: ExperimentPackageV1 = {
    schemaId: EXPERIMENT_PACKAGE_SCHEMA_ID,
    packageId: artifact.packageId,
    privacyClass: "share_safe",
    taskFingerprint: artifact.taskFingerprint,
    snapshotFingerprint: artifact.snapshotFingerprint,
    candidates,
    agreement: agreementFromLanes(candidates, traces, notes),
  };
  return parseStrategyPackage({
    schemaId: STRATEGY_PACKAGE_SCHEMA_ID,
    privacyClass: "share_safe",
    experiment,
    traces,
  });
}

/** Parse + convert in one step for Experiment Lab import. */
export function convertBenchArtifactImport(raw: unknown): StrategyPackageV1 {
  return convertBenchRunArtifactToStrategyPackage(parseBenchRunArtifact(raw));
}

export function isBenchArtifactSchemaId(schemaId: unknown): boolean {
  return (
    schemaId === BENCH_RUN_ARTIFACT_SCHEMA_ID || schemaId === BENCH_COMPARE_CLI_SCHEMA_ID
  );
}
