/**
 * Truthful, payload-free Activity projection of the live log-ingest progress
 * stream. The visible ProcessProgressPanel remains the owner of the host's
 * human progress message and cancel action. This projection deliberately uses
 * only typed phase/counter fields: progress messages can contain a basename,
 * while Activity is persisted and bridged across Explorer webviews.
 */
import type { ProcessProgressDto } from "../../components/wizards/types";
import {
  ACTIVITY_LANE_GROUP,
  determinismForOrigin,
  type ActivityClock,
  type ActivityEventInput,
  type ActivityOrigin,
  type ImportRunInput,
} from "./types";

export type ImportActivityAttempt = {
  correlationId: string;
  sourceKind: ImportRunInput["sourceKind"];
  events: ActivityEventInput[];
  nextSequence: number;
  lastElapsedMs: number | null;
  terminal: boolean;
  lastSignature: string | null;
};

type ImportProgressPhase = ProcessProgressDto["phase"];

function finiteNonnegative(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function safeCount(value: number | null | undefined): number | null {
  return finiteNonnegative(value);
}

function countLabel(value: number, singular: string, plural = `${singular}s`) {
  return `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
}

function normalizedPhase(phase: ImportProgressPhase): ImportProgressPhase {
  return phase === "parse" ||
    phase === "template" ||
    phase === "redact" ||
    phase === "store"
    ? "stream"
    : phase;
}

function phaseLabel(phase: ImportProgressPhase): string {
  switch (normalizedPhase(phase)) {
    case "starting":
      return "Import started";
    case "scan":
      return "Discovering and reading sources";
    case "stream":
      return "Reading, parsing, normalizing, and indexing";
    case "embed":
      return "Running optional local embedding";
    case "validate":
      return "Validating staged corpus";
    case "publish":
      return "Publishing corpus atomically";
    case "completed":
      return "Corpus published";
    case "cancelled":
      return "Import cancelled — nothing published";
    case "failed":
      return "Import failed — nothing published";
    // Session-context phases cannot belong to a log_ingest update, but keep a
    // truthful generic label for compatibility with an older/malformed host.
    case "read":
    case "extract":
    case "write":
      return "Import processing";
    default:
      return "Import processing";
  }
}

function originForPhase(
  phase: ImportProgressPhase,
): Exclude<ActivityOrigin, "external_connector"> {
  switch (normalizedPhase(phase)) {
    case "starting":
      return "user_decision";
    case "embed":
      return "probabilistic_model";
    case "publish":
    case "completed":
      return "governed_write";
    default:
      return "deterministic_host";
  }
}

function detailForProgress(progress: ProcessProgressDto): string | undefined {
  const parts: string[] = [];
  const files = safeCount(progress.files_processed);
  const lines = safeCount(progress.lines_processed);
  const templates = safeCount(progress.templates);
  const bytes = safeCount(progress.bytes_processed);
  const fraction =
    progress.fraction != null && Number.isFinite(progress.fraction)
      ? Math.max(0, Math.min(1, progress.fraction))
      : null;
  if (files != null) parts.push(countLabel(files, "file"));
  if (lines != null) parts.push(countLabel(lines, "event"));
  if (templates != null) parts.push(countLabel(templates, "template"));
  if (bytes != null) parts.push(`${bytes.toLocaleString()} bytes read`);
  if (fraction != null) parts.push(`${Math.round(fraction * 100)}%`);
  const priorPhaseMs = finiteNonnegative(progress.phase_elapsed_ms);
  if (priorPhaseMs != null) parts.push(`prior displayed phase ${priorPhaseMs} ms`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function clockForProgress(
  attempt: ImportActivityAttempt,
  progress: ProcessProgressDto,
): { clock: ActivityClock; lastElapsedMs: number | null } {
  const elapsedMs = finiteNonnegative(progress.elapsed_ms);
  if (
    elapsedMs != null &&
    (attempt.lastElapsedMs == null || elapsedMs >= attempt.lastElapsedMs)
  ) {
    return { clock: { kind: "elapsed", elapsedMs }, lastElapsedMs: elapsedMs };
  }
  return {
    clock: { kind: "sequence", seq: attempt.nextSequence },
    lastElapsedMs: attempt.lastElapsedMs,
  };
}

function workspaceScope() {
  return {
    kind: "workspace" as const,
    id: null,
    label: "Selected log source",
  };
}

export function beginImportActivityAttempt(
  correlationId: string,
  sourceKind: ImportRunInput["sourceKind"],
): ImportActivityAttempt {
  if (!correlationId.startsWith("import:") || correlationId.length > 512) {
    throw new Error("invalid import activity correlation id");
  }
  return {
    correlationId,
    sourceKind,
    events: [],
    nextSequence: 0,
    lastElapsedMs: null,
    terminal: false,
    lastSignature: null,
  };
}

/** Append one safe live observation, preserving source order. */
export function recordImportProgress(
  attempt: ImportActivityAttempt,
  progress: ProcessProgressDto,
): ImportActivityAttempt {
  if (progress.kind !== "log_ingest" || attempt.terminal) return attempt;
  const phase = normalizedPhase(progress.phase);
  const detail = detailForProgress(progress);
  const elapsedMs = finiteNonnegative(progress.elapsed_ms);
  const signature = JSON.stringify([
    phase,
    detail ?? null,
    elapsedMs,
    progress.cancellable,
  ]);
  const previous = attempt.events.at(-1);
  if (phase === "starting" && previous?.phase === "started") {
    if (elapsedMs == null && detail == null) {
      return { ...attempt, lastSignature: signature };
    }
    const { clock, lastElapsedMs } = clockForProgress(attempt, progress);
    return {
      ...attempt,
      events: [
        ...attempt.events.slice(0, -1),
        { ...previous, clock, detail: detail ?? previous.detail },
      ],
      lastElapsedMs,
      lastSignature: signature,
    };
  }
  // Core can intentionally emit a canonical terminal after a lower layer
  // noticed the same cancellation. Retain one causal terminal row.
  if (signature === attempt.lastSignature) return attempt;

  const origin = originForPhase(phase);
  const { clock, lastElapsedMs } = clockForProgress(attempt, progress);
  const terminal =
    phase === "completed" || phase === "cancelled" || phase === "failed";
  const base = {
    correlationId: attempt.correlationId,
    operationId: `${attempt.correlationId}:ingest`,
    origin,
    determinism: determinismForOrigin(origin),
    phase:
      phase === "starting"
        ? ("started" as const)
        : terminal
          ? ("completed" as const)
          : ("progress" as const),
    status:
      phase === "completed"
        ? ("ok" as const)
        : phase === "cancelled"
          ? ("cancelled" as const)
          : phase === "failed"
            ? ("failed" as const)
            : ("pending" as const),
    clock,
    label: phaseLabel(phase),
    detail,
    scope: workspaceScope(),
    privacy: "metadata" as const,
    evidence: [],
    laneGroup: ACTIVITY_LANE_GROUP,
  };
  const event: ActivityEventInput =
    origin === "probabilistic_model"
      ? {
          ...base,
          origin,
          hook: {
            trigger: "import → optional local embedding phase",
            dataScope: "learned templates of the selected import only",
          },
        }
      : { ...base, origin };

  return {
    ...attempt,
    events: [...attempt.events, event],
    nextSequence: attempt.nextSequence + 1,
    lastElapsedMs,
    terminal,
    lastSignature: signature,
  };
}

function terminalLabel(run: ImportRunInput): string {
  if (run.outcome === "completed") return "Corpus published";
  if (run.outcome === "cancelled") {
    return "Import cancelled — nothing published";
  }
  return "Import failed — nothing published";
}

function terminalDetail(run: ImportRunInput): string {
  if (run.outcome === "completed" && run.report) {
    return [
      countLabel(run.report.lines, "event"),
      countLabel(run.report.templates, "template"),
      countLabel(run.report.files, "file"),
    ].join(" · ");
  }
  return "No corpus was published.";
}

/**
 * Reconcile the live stream with the actual command result. No wall time is
 * invented: when a host terminal progress update was observed, its measured
 * elapsed clock is retained; otherwise the command result is order-only.
 */
export function settleImportActivityAttempt(
  attempt: ImportActivityAttempt,
  run: ImportRunInput,
): ImportActivityAttempt {
  const corpusId = run.report?.corpusId ?? null;
  const scope = corpusId
    ? {
        kind: "log_corpus" as const,
        id: corpusId,
        label: `Log corpus ${corpusId}`,
      }
    : workspaceScope();
  const status =
    run.outcome === "completed"
      ? ("ok" as const)
      : run.outcome === "cancelled"
        ? ("cancelled" as const)
        : ("failed" as const);
  const origin =
    run.outcome === "completed"
      ? ("governed_write" as const)
      : ("deterministic_host" as const);
  const events: ActivityEventInput[] = attempt.events.map(
    (event): ActivityEventInput => ({
      ...event,
      scope,
      corpusId: corpusId ?? undefined,
    }),
  );
  const lastIndex = events.length - 1;
  const last = events[lastIndex];
  if (last?.phase === "completed") {
    events[lastIndex] = {
      ...last,
      origin,
      determinism: determinismForOrigin(origin),
      status,
      label: terminalLabel(run),
      detail: terminalDetail(run),
      scope,
      corpusId: corpusId ?? undefined,
    } as ActivityEventInput;
  } else {
    events.push({
      correlationId: attempt.correlationId,
      operationId: `${attempt.correlationId}:ingest`,
      origin,
      determinism: determinismForOrigin(origin),
      phase: "completed",
      status,
      clock: { kind: "sequence", seq: attempt.nextSequence },
      label: terminalLabel(run),
      detail: terminalDetail(run),
      scope,
      privacy: "metadata",
      evidence: [],
      laneGroup: ACTIVITY_LANE_GROUP,
      corpusId: corpusId ?? undefined,
    });
  }
  return {
    ...attempt,
    events,
    nextSequence: attempt.nextSequence + (last?.phase === "completed" ? 0 : 1),
    terminal: true,
  };
}
