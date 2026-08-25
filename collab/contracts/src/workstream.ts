import { checkObject, f, type ObjectShape } from "./parse.js";
import { PRIVACY_CLASSES } from "./case.js";
import {
  TRIAGE_JOB_STATUSES,
  type TriageJobStatus,
  type TriageJobV1,
} from "./triage-job.js";

export const WORKSTREAM_VIEW_SCHEMA_ID = "cd-collab.workstream_view.v1" as const;
export const WORKSTREAM_LIST_SCHEMA_ID = "cd-collab.workstream_list.v1" as const;

export const WORKSTREAM_AGREEMENT_NOTICE =
  "Agreement is not proof of correctness." as const;

/**
 * How an investigative workstream was carried out.
 *
 * A workstream is a unit of investigative work, not a model button. The War
 * Room must stay able to represent a person working a question by hand, a
 * scripted pipeline, work performed elsewhere and imported, and a host-run
 * diagnostic — so this list is deliberately wider than the model lanes the
 * current runner happens to execute. Nothing here ranks or scores a kind.
 */
export const WORKSTREAM_OPERATOR_KINDS = [
  "ai_assisted",
  "human",
  "programmatic",
  "external_import",
  "host_run",
  "unknown",
] as const;
export type WorkstreamOperatorKind = (typeof WORKSTREAM_OPERATOR_KINDS)[number];

/** Lifecycle a reader can act on, collapsed from the recorded run status. */
export const WORKSTREAM_LIFECYCLES = ["queued", "running", "settled"] as const;
export type WorkstreamLifecycle = (typeof WORKSTREAM_LIFECYCLES)[number];

/** One recorded, timestamped step in a workstream's own history. */
export interface WorkstreamActivityEntryV1 {
  /** Recorded instant, or null when the record does not carry one. */
  at: string | null;
  /** Human sentence describing what happened. Never an identifier. */
  label: string;
  /** Who or what performed it, already resolved to a display name. */
  actor: string;
  /** Extra recorded context, or null when nothing further was recorded. */
  detail: string | null;
}

/** A piece of evidence this workstream actually cited. */
export interface WorkstreamEvidenceCitationV1 {
  /** Raw identifier — preserved for machine exports and technical details. */
  evidenceId: string;
  /** Human label: the filename when recorded, otherwise the artifact kind. */
  label: string;
  kind: string;
  /** Recorded summary of why the evidence is in the investigation. */
  summary: string | null;
  /** True only when the frozen snapshot this run was bound to contains it. */
  inFrozenSnapshot: boolean;
  /** Recorded verification state, or "not recorded" — never inferred. */
  verification: string;
  /** Whether the case still resolves this reference to a registered artifact. */
  resolved: boolean;
}

/**
 * Every raw identifier the readable view deliberately keeps out of primary UI.
 * The client shows these only in an explicitly expanded Technical details area
 * and machine exports keep them verbatim.
 */
export interface WorkstreamTechnicalV1 {
  workstreamKey: string;
  runId: string;
  candidateId: string;
  snapshotId: string;
  snapshotFingerprint: string;
  requestFingerprint: string;
  taskFingerprint: string;
  strategyId: string;
  modelId: string;
  modelVersion: string | null;
  provider: string;
  profileId: string | null;
  outputHash: string | null;
  benchmarkRunId: string | null;
  parentRunId: string | null;
  errorCode: string | null;
  privacyClass: (typeof PRIVACY_CLASSES)[number];
}

export interface WorkstreamInputsV1 {
  /** The exact question this workstream was asked. */
  question: string;
  /** Stable human name for the frozen snapshot, e.g. "Frozen evidence set 1". */
  snapshotLabel: string;
  /** Items in the frozen snapshot the workstream was bound to. */
  snapshotEvidenceCount: number;
  /** When the snapshot was frozen, or null when the record has no timestamp. */
  snapshotFrozenAt: string | null;
  /**
   * Whether the host proved this workstream ran against the exact frozen
   * snapshot. `null` is unknown and must never be presented as proven.
   */
  sameSnapshot: boolean | null;
  /** Human sentence restating `sameSnapshot` without asserting more. */
  snapshotProofLabel: string;
}

export interface WorkstreamRerunV1 {
  isRerun: boolean;
  /** Route key of the workstream this one reran, when it is in this case. */
  parentKey: string | null;
  /** Human sentence. Says "not a rerun" rather than leaving a blank. */
  note: string;
}

export interface WorkstreamViewV1 {
  schemaId: typeof WORKSTREAM_VIEW_SCHEMA_ID;
  /** Stable, URL-safe route identity: `${runId}:${candidateId}`. */
  key: string;
  caseId: string;
  /** Human label, e.g. "Reviewer workstream — qwen-3.6-27b". */
  label: string;
  /** What this workstream was set up to find out, in plain language. */
  purpose: string;
  operatorKind: WorkstreamOperatorKind;
  /** Human sentence naming who or what performed the work. */
  operatorLabel: string;
  /** The person accountable for the workstream — who requested the run. */
  assignedTo: string;
  /** Readable strategy name derived from the recorded strategy identifier. */
  strategyLabel: string;
  /** The investigative role this workstream played, e.g. "reviewer". */
  role: string;
  inputs: WorkstreamInputsV1;
  statusCode: TriageJobStatus;
  lifecycle: WorkstreamLifecycle;
  /** Short human status, e.g. "Completed" or "Stopped — timed out". */
  statusLabel: string;
  /** One sentence a reader can act on. */
  statusDetail: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** What the workstream reported, or null when it recorded no summary. */
  findings: string | null;
  /** Plain-language outcome. Never a verdict and never a correctness claim. */
  outcome: string;
  evidenceCited: WorkstreamEvidenceCitationV1[];
  /** Readable unknowns, e.g. "pool saturation window". */
  unknowns: string[];
  activity: WorkstreamActivityEntryV1[];
  rerun: WorkstreamRerunV1;
  agreementNotice: typeof WORKSTREAM_AGREEMENT_NOTICE;
  technical: WorkstreamTechnicalV1;
}

export interface WorkstreamListV1 {
  schemaId: typeof WORKSTREAM_LIST_SCHEMA_ID;
  caseId: string;
  workstreams: WorkstreamViewV1[];
}

const activityShape: ObjectShape = {
  at: f.nul(f.str),
  label: f.req(f.nstr),
  actor: f.req(f.nstr),
  detail: f.nul(f.str),
};

const citationShape: ObjectShape = {
  evidenceId: f.req(f.nstr),
  label: f.req(f.nstr),
  kind: f.req(f.nstr),
  summary: f.nul(f.str),
  inFrozenSnapshot: f.req(f.bool),
  verification: f.req(f.nstr),
  resolved: f.req(f.bool),
};

const technicalShape: ObjectShape = {
  workstreamKey: f.req(f.nstr),
  runId: f.req(f.nstr),
  candidateId: f.req(f.nstr),
  snapshotId: f.req(f.str),
  snapshotFingerprint: f.req(f.str),
  requestFingerprint: f.req(f.str),
  taskFingerprint: f.req(f.str),
  strategyId: f.req(f.str),
  modelId: f.req(f.str),
  modelVersion: f.nul(f.str),
  provider: f.req(f.str),
  profileId: f.nul(f.str),
  outputHash: f.nul(f.str),
  benchmarkRunId: f.nul(f.str),
  parentRunId: f.nul(f.str),
  errorCode: f.nul(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
};

const inputsShape: ObjectShape = {
  question: f.req(f.str),
  snapshotLabel: f.req(f.nstr),
  snapshotEvidenceCount: f.req(f.u64),
  snapshotFrozenAt: f.nul(f.str),
  sameSnapshot: f.nul(f.bool),
  snapshotProofLabel: f.req(f.nstr),
};

const rerunShape: ObjectShape = {
  isRerun: f.req(f.bool),
  parentKey: f.nul(f.str),
  note: f.req(f.nstr),
};

const viewShape: ObjectShape = {
  schemaId: f.req(f.en(WORKSTREAM_VIEW_SCHEMA_ID)),
  key: f.req(f.nstr),
  caseId: f.req(f.nstr),
  label: f.req(f.nstr),
  purpose: f.req(f.nstr),
  operatorKind: f.req(f.en(...WORKSTREAM_OPERATOR_KINDS)),
  operatorLabel: f.req(f.nstr),
  assignedTo: f.req(f.nstr),
  strategyLabel: f.req(f.nstr),
  role: f.req(f.nstr),
  inputs: f.req(f.obj(inputsShape)),
  statusCode: f.req(f.en(...TRIAGE_JOB_STATUSES)),
  lifecycle: f.req(f.en(...WORKSTREAM_LIFECYCLES)),
  statusLabel: f.req(f.nstr),
  statusDetail: f.req(f.nstr),
  startedAt: f.nul(f.str),
  finishedAt: f.nul(f.str),
  findings: f.nul(f.str),
  outcome: f.req(f.nstr),
  evidenceCited: f.req(f.arr(f.obj(citationShape))),
  unknowns: f.req(f.arr(f.str)),
  activity: f.req(f.arr(f.obj(activityShape))),
  rerun: f.req(f.obj(rerunShape)),
  agreementNotice: f.req(f.en(WORKSTREAM_AGREEMENT_NOTICE)),
  technical: f.req(f.obj(technicalShape)),
};

const listShape: ObjectShape = {
  schemaId: f.req(f.en(WORKSTREAM_LIST_SCHEMA_ID)),
  caseId: f.req(f.nstr),
  workstreams: f.req(f.arr(f.obj(viewShape))),
};

export function parseWorkstreamView(raw: unknown): WorkstreamViewV1 {
  checkObject("$", viewShape, raw);
  return raw as WorkstreamViewV1;
}

export function parseWorkstreamList(raw: unknown): WorkstreamListV1 {
  checkObject("$", listShape, raw);
  return raw as WorkstreamListV1;
}

/** Route identity for a workstream. Stable across reloads and shareable. */
export function workstreamKey(runId: string, candidateId: string): string {
  return `${runId}:${candidateId}`;
}

// ————— Readable projection —————
// Everything below restates facts already recorded on the run, the case
// evidence, and the case timeline. Nothing infers a cause, ranks a lane, or
// upgrades an unknown into a claim.

const STATUS_LABELS: Record<TriageJobStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  partial: "Completed with gaps",
  failed: "Stopped — failed",
  timed_out: "Stopped — timed out",
  cancelled: "Stopped — cancelled",
};

const STATUS_DETAILS: Record<TriageJobStatus, string> = {
  queued: "Waiting to start. Nothing has been recorded for this workstream yet.",
  running: "In progress. Findings and cited evidence appear as they are recorded.",
  completed: "Finished and recorded its findings. Read them against the evidence yourself.",
  partial:
    "Finished but did not record everything it was asked for. Treat the gaps below as open.",
  failed: "Stopped before finishing. Its partial record is kept exactly as it was left.",
  timed_out: "Ran out of time before finishing. Anything unrecorded stays unknown.",
  cancelled: "A person cancelled this workstream. Nothing further was recorded.",
};

function lifecycleOf(status: TriageJobStatus): WorkstreamLifecycle {
  if (status === "queued") return "queued";
  if (status === "running") return "running";
  return "settled";
}

/**
 * Human name for a recorded role. Unrecognised roles are surfaced as written
 * rather than dropped — a deployment may record roles this build never saw.
 */
function roleLabel(role: string): string {
  const trimmed = role.trim();
  if (!trimmed) return "Workstream";
  if (trimmed === "single") return "Sole workstream";
  return `${trimmed.slice(0, 1).toUpperCase()}${trimmed.slice(1)} workstream`;
}

/**
 * Classify how the work was performed from the recorded provider. Anything
 * unrecognised stays "unknown" instead of being asserted as a model lane.
 */
export function operatorKindFor(provider: string, model: string): WorkstreamOperatorKind {
  // The recorded provider names the executor, so it decides first; the model
  // identifier only refines an otherwise unrecognised provider.
  const executor = provider.trim().toLowerCase();
  if (/import|external|pasted/.test(executor)) return "external_import";
  if (/^host\b|\bhost$|diagnostic/.test(executor)) return "host_run";
  if (/^human\b|analyst|operator/.test(executor)) return "human";
  const value = `${executor} ${model}`.toLowerCase();
  if (/import|external|pasted|chat-operator/.test(value)) return "external_import";
  if (/\bhuman\b|\banalyst\b/.test(value)) return "human";
  if (/programmatic|agent|script|pipeline/.test(value)) return "programmatic";
  if (/synthetic|gateway|openai|anthropic|ollama|model/.test(value)) return "ai_assisted";
  return "unknown";
}

const OPERATOR_LABELS: Record<WorkstreamOperatorKind, string> = {
  ai_assisted: "AI-assisted workstream — output is analysis, never a human finding",
  human: "Human workstream — recorded by a person on the investigation",
  programmatic: "Programmatic workstream — a scripted investigation path",
  external_import: "Imported workstream — performed elsewhere and recorded here",
  host_run: "Host-run workstream — executed by the War Room host",
  unknown: "Workstream — how it was performed is not recorded",
};

/** Turn `contextdesk.strategy-paths.synthetic-demo` into readable words. */
export function strategyLabelFor(strategyId: string): string {
  const trimmed = strategyId.trim();
  if (!trimmed) return "Strategy not recorded";
  const tail = trimmed.split(".").filter(Boolean).slice(1).join(" ") || trimmed;
  const words = tail.replace(/[-_]+/g, " ").trim();
  if (!words) return trimmed;
  return `${words.slice(0, 1).toUpperCase()}${words.slice(1)} strategy`;
}

/** `poolSaturationWindow` / `pool_saturation_window` → `pool saturation window`. */
export function readableUnknown(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

function snapshotProofLabel(sameSnapshot: boolean | null): string {
  if (sameSnapshot === true) {
    return "Ran against the exact frozen evidence set, proven by the host.";
  }
  if (sameSnapshot === false) {
    return "Did not run against the same frozen evidence set — do not compare it as equal.";
  }
  return "Whether it ran against the exact frozen evidence set is not yet proven.";
}

function outcomeFor(
  status: TriageJobStatus,
  findings: string | null,
  citedCount: number,
  unknownCount: number,
): string {
  if (status === "queued" || status === "running") {
    return "No outcome is recorded yet.";
  }
  const evidenceClause =
    citedCount === 0
      ? "cited no evidence"
      : `cited ${citedCount} evidence item${citedCount === 1 ? "" : "s"}`;
  const unknownClause =
    unknownCount === 0
      ? "and left nothing recorded as unknown"
      : `and left ${unknownCount} thing${unknownCount === 1 ? "" : "s"} unknown`;
  if (!findings) {
    return `Recorded no written finding; it ${evidenceClause} ${unknownClause}.`;
  }
  return `Recorded a written finding; it ${evidenceClause} ${unknownClause}. Read it against the evidence before relying on it.`;
}

export interface WorkstreamEvidenceInput {
  id: string;
  kind: string;
  filename: string | null;
  summary: string | null;
  verificationStatus: string | null;
}

export interface WorkstreamSnapshotInput {
  id: string;
  createdAt: string | null;
  evidenceIds: string[];
}

export interface WorkstreamTimelineInput {
  kind: string;
  actorUsername: string;
  targetId: string | null;
  serverTime: string;
}

export interface WorkstreamProjectionInput {
  caseId: string;
  jobs: TriageJobV1[];
  evidence: WorkstreamEvidenceInput[];
  snapshots: WorkstreamSnapshotInput[];
  timeline: WorkstreamTimelineInput[];
}

/** Timeline kinds that describe a triage run's own lifecycle. */
const RUN_TIMELINE_LABELS: Record<string, string> = {
  triage_job_created: "Run queued by a person",
  triage_job_started: "Run started",
  triage_job_finished: "Run finished",
  triage_job_cancel_requested: "Cancellation requested by a person",
  triage_candidate_started: "Workstream started",
  triage_candidate_finished: "Workstream finished",
};

function activityFor(
  job: TriageJobV1,
  candidate: TriageJobV1["candidates"][number],
  timeline: WorkstreamTimelineInput[],
): WorkstreamActivityEntryV1[] {
  const host = "ContextDesk host";
  const requester = job.requestedByUsername || "a person on the investigation";
  const entries: WorkstreamActivityEntryV1[] = [
    {
      at: job.createdAt,
      label: "Run queued",
      actor: requester,
      detail: `Asked: ${job.request.question}`,
    },
  ];
  if (job.startedAt) {
    entries.push({
      at: job.startedAt,
      label: "Run started against the frozen evidence set",
      actor: host,
      detail: null,
    });
  }
  if (candidate.startedAt) {
    entries.push({
      at: candidate.startedAt,
      label: "This workstream started",
      actor: host,
      detail: null,
    });
  }
  if (job.cancelRequestedAt) {
    entries.push({
      at: job.cancelRequestedAt,
      label: "Cancellation requested",
      actor: requester,
      detail: job.stoppedReason,
    });
  }
  if (candidate.finishedAt) {
    entries.push({
      at: candidate.finishedAt,
      label: `This workstream settled as ${STATUS_LABELS[candidate.status].toLowerCase()}`,
      actor: host,
      detail: candidate.errorCode
        ? "The host recorded a stop reason; see Technical details."
        : null,
    });
  }
  // Recorded case-timeline events for this run add the actor the run record
  // alone does not carry. Only events that name this run are joined.
  for (const event of timeline) {
    if (event.targetId !== job.id) continue;
    const label = RUN_TIMELINE_LABELS[event.kind];
    if (!label) continue;
    if (event.kind === "triage_job_created" || event.kind === "triage_job_started") continue;
    entries.push({
      at: event.serverTime,
      label,
      actor: event.actorUsername || host,
      detail: null,
    });
  }
  return entries
    .filter((entry, index, all) =>
      all.findIndex((other) => other.at === entry.at && other.label === entry.label) === index,
    )
    .sort((a, b) => {
      if (a.at === b.at) return 0;
      if (!a.at) return 1;
      if (!b.at) return -1;
      return a.at < b.at ? -1 : 1;
    });
}

/**
 * Project recorded triage runs into readable, individually addressable
 * workstreams. Pure: the same recorded input always produces the same views.
 */
export function projectWorkstreams(input: WorkstreamProjectionInput): WorkstreamListV1 {
  const evidenceById = new Map(input.evidence.map((row) => [row.id, row]));
  const snapshotById = new Map(input.snapshots.map((row) => [row.id, row]));
  const snapshotOrder = new Map(input.snapshots.map((row, index) => [row.id, index + 1]));
  const jobIds = new Set(input.jobs.map((job) => job.id));
  const workstreams: WorkstreamViewV1[] = [];

  for (const job of input.jobs) {
    const snapshot = snapshotById.get(job.snapshotId) ?? null;
    const snapshotEvidence = new Set(snapshot?.evidenceIds ?? []);
    const position = snapshotOrder.get(job.snapshotId);
    const snapshotLabel = position
      ? `Frozen evidence set ${position}`
      : "Frozen evidence set (not resolvable in this view)";
    const parentRunId = job.parentJobId ?? job.request.parentJobId ?? null;

    for (const candidate of job.candidates) {
      const key = workstreamKey(job.id, candidate.candidateId);
      const simulation = job.request.mode === "deterministic_mock"
        && candidate.evidenceRefs.length === 0
        && candidate.summary?.startsWith("Provider-free simulation completed.") === true;
      const operatorKind = simulation
        ? "programmatic"
        : operatorKindFor(candidate.provider, candidate.model);
      const evidenceCited: WorkstreamEvidenceCitationV1[] = (simulation
        ? []
        : candidate.evidenceRefs).map((ref) => {
        const artifact = evidenceById.get(ref);
        return {
          evidenceId: ref,
          label: artifact?.filename?.trim() || artifact?.kind || "Evidence no longer registered",
          kind: artifact?.kind ?? "unknown",
          summary: artifact?.summary ?? null,
          inFrozenSnapshot: snapshotEvidence.has(ref),
          verification: artifact?.verificationStatus?.trim() || "not recorded",
          resolved: Boolean(artifact),
        };
      });
      const unknowns = candidate.unknowns.map(readableUnknown).filter(Boolean);
      const parentKey =
        parentRunId && jobIds.has(parentRunId)
          ? workstreamKey(parentRunId, candidate.candidateId)
          : null;
      workstreams.push({
        schemaId: WORKSTREAM_VIEW_SCHEMA_ID,
        key,
        caseId: input.caseId,
        label: simulation
          ? `${roleLabel(candidate.role).replace("workstream", "simulation")} — ${candidate.model}`
          : `${roleLabel(candidate.role)} — ${candidate.model}`,
        purpose: job.request.question,
        operatorKind,
        operatorLabel: simulation
          ? "Provider-free simulation — exercises workflow controls; it did not run the named model or analyze evidence"
          : OPERATOR_LABELS[operatorKind],
        assignedTo: job.requestedByUsername || "not recorded",
        strategyLabel: strategyLabelFor(job.request.strategyId),
        role: candidate.role,
        inputs: {
          question: job.request.question,
          snapshotLabel,
          snapshotEvidenceCount: snapshot?.evidenceIds.length ?? 0,
          snapshotFrozenAt: snapshot?.createdAt ?? null,
          sameSnapshot: job.sameSnapshot,
          snapshotProofLabel: snapshotProofLabel(job.sameSnapshot),
        },
        statusCode: candidate.status,
        lifecycle: lifecycleOf(candidate.status),
        statusLabel: STATUS_LABELS[candidate.status],
        statusDetail: simulation && candidate.status === "completed"
          ? "Simulation finished. No provider or model was contacted, and no evidence was inspected."
          : STATUS_DETAILS[candidate.status],
        startedAt: candidate.startedAt,
        finishedAt: candidate.finishedAt,
        findings: simulation ? null : candidate.summary,
        outcome: simulation && candidate.status === "completed"
          ? "Provider-free workflow simulation completed; it produced no investigative finding or evidence citation."
          : outcomeFor(
              candidate.status,
              candidate.summary,
              evidenceCited.length,
              unknowns.length,
            ),
        evidenceCited,
        unknowns,
        activity: activityFor(job, candidate, input.timeline),
        rerun: {
          isRerun: Boolean(parentRunId),
          parentKey,
          note: parentRunId
            ? parentKey
              ? "Rerun of an earlier workstream in this investigation."
              : "Recorded as a rerun; the earlier run is not in this investigation view."
            : "Not a rerun — this is the first recorded attempt.",
        },
        agreementNotice: WORKSTREAM_AGREEMENT_NOTICE,
        technical: {
          workstreamKey: key,
          runId: job.id,
          candidateId: candidate.candidateId,
          snapshotId: job.snapshotId,
          snapshotFingerprint: job.snapshotFingerprint,
          requestFingerprint: job.requestFingerprint,
          taskFingerprint: job.request.taskFingerprint,
          strategyId: job.request.strategyId,
          modelId: candidate.model,
          modelVersion: candidate.version,
          provider: candidate.provider,
          profileId: candidate.profileId,
          outputHash: candidate.outputHash,
          benchmarkRunId: candidate.benchmarkRunId,
          parentRunId,
          errorCode: candidate.errorCode,
          privacyClass: candidate.privacyClass,
        },
      });
    }
  }

  return {
    schemaId: WORKSTREAM_LIST_SCHEMA_ID,
    caseId: input.caseId,
    workstreams,
  };
}
