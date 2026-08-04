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
  hostOperationId: string | null;
  sourceKind: ImportRunInput["sourceKind"];
  events: ActivityEventInput[];
  nextSequence: number;
  lastElapsedMs: number | null;
  terminal: boolean;
  omittedUpdates: number;
};

export const IMPORT_ACTIVITY_EVENT_CAP = 16;

type ImportProgressPhase = ProcessProgressDto["phase"];

function finiteNonnegative(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function safeCount(value: number | null | undefined): number | null {
  return finiteNonnegative(value);
}

// Pinned locale, not the host default: an unpinned `toLocaleString()` reads
// the OS/runtime locale, and a German/French/Windows-style locale groups
// thousands with "." instead of ",". These strings are persisted, broadcast
// cross-webview, and re-validated by `SAFE_IMPORT_DETAIL_PART`
// (`importActivityBridge.ts`), which only allows `[\d,]` — an unpinned
// locale would make that regex fail closed and silently drop legitimate
// progress on a non-US-locale desktop, not merely render a different comma.
const IMPORT_COUNT_FORMAT = new Intl.NumberFormat("en-US");

function countLabel(value: number, singular: string, plural = `${singular}s`) {
  return `${IMPORT_COUNT_FORMAT.format(value)} ${value === 1 ? singular : plural}`;
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
  if (bytes != null) parts.push(`${IMPORT_COUNT_FORMAT.format(bytes)} bytes read`);
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

function validHostOperationId(value: string | null | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9:_-]+$/.test(value)
  );
}

function invocationStart(correlationId: string): ActivityEventInput {
  return {
    correlationId,
    operationId: `${correlationId}:request`,
    origin: "user_decision",
    determinism: determinismForOrigin("user_decision"),
    phase: "started",
    status: "pending",
    clock: { kind: "sequence", seq: 0 },
    label: "Import started",
    scope: workspaceScope(),
    privacy: "metadata",
    evidence: [],
    laneGroup: ACTIVITY_LANE_GROUP,
  };
}

function bindHostOperation(
  attempt: ImportActivityAttempt,
  hostOperationId: string,
): ImportActivityAttempt {
  const operationId = `${attempt.correlationId}:host:${hostOperationId}`;
  return {
    ...attempt,
    hostOperationId,
    events: attempt.events.map((event) => ({
      ...event,
      operationId,
    })),
  };
}

function boundedEvents(
  events: ActivityEventInput[],
  omittedUpdates: number,
): { events: ActivityEventInput[]; omittedUpdates: number } {
  if (events.length <= IMPORT_ACTIVITY_EVENT_CAP) {
    return { events, omittedUpdates };
  }
  const dropped = events.length - IMPORT_ACTIVITY_EVENT_CAP;
  return {
    events: [events[0]!, ...events.slice(-(IMPORT_ACTIVITY_EVENT_CAP - 1))],
    omittedUpdates: omittedUpdates + dropped,
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
    hostOperationId: null,
    sourceKind,
    events: [invocationStart(correlationId)],
    nextSequence: 1,
    lastElapsedMs: null,
    terminal: false,
    omittedUpdates: 0,
  };
}

/** Append one safe live observation, preserving source order. */
export function recordImportProgress(
  attempt: ImportActivityAttempt,
  progress: ProcessProgressDto,
): ImportActivityAttempt {
  if (progress.kind !== "log_ingest" || attempt.terminal) return attempt;
  const phase = normalizedPhase(progress.phase);
  const incomingOperationId = progress.operation_id;
  if (
    progress.correlation_id !== attempt.correlationId ||
    !validHostOperationId(incomingOperationId)
  ) {
    return attempt;
  }
  let active = attempt;
  if (active.hostOperationId == null) {
    // A command owner binds only to its own first host milestone. A late
    // terminal/progress row from an earlier global operation can never claim
    // a newly-started attempt.
    if (phase !== "starting") return attempt;
    active = bindHostOperation(active, incomingOperationId);
  } else if (incomingOperationId !== active.hostOperationId) {
    return attempt;
  }
  const detail = detailForProgress(progress);
  const elapsedMs = finiteNonnegative(progress.elapsed_ms);
  const previous = active.events.at(-1);
  if (phase === "starting" && previous?.phase === "started") {
    if (elapsedMs == null && detail == null) {
      return { ...active, nextSequence: active.nextSequence + 1 };
    }
    const { clock, lastElapsedMs } = clockForProgress(active, progress);
    return {
      ...active,
      events: [
        ...active.events.slice(0, -1),
        { ...previous, clock, detail: detail ?? previous.detail },
      ],
      nextSequence: active.nextSequence + 1,
      lastElapsedMs,
    };
  }

  const origin = originForPhase(phase);
  const { clock, lastElapsedMs } = clockForProgress(active, progress);
  const terminal =
    phase === "completed" || phase === "cancelled" || phase === "failed";
  const base = {
    correlationId: active.correlationId,
    operationId: `${active.correlationId}:host:${active.hostOperationId}`,
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

  const coalescePrevious =
    !terminal && previous?.phase === "progress" && previous.label === event.label;
  const nextEvents = coalescePrevious
    ? [...active.events.slice(0, -1), event]
    : [...active.events, event];
  const bounded = boundedEvents(
    nextEvents,
    active.omittedUpdates + (coalescePrevious ? 1 : 0),
  );
  return {
    ...active,
    events: bounded.events,
    omittedUpdates: bounded.omittedUpdates,
    nextSequence: active.nextSequence + 1,
    lastElapsedMs,
    terminal,
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
      operationId:
        attempt.hostOperationId == null
          ? `${attempt.correlationId}:request`
          : `${attempt.correlationId}:host:${attempt.hostOperationId}`,
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
  const bounded = boundedEvents(events, attempt.omittedUpdates);
  return {
    ...attempt,
    events: bounded.events,
    omittedUpdates: bounded.omittedUpdates,
    nextSequence: attempt.nextSequence + (last?.phase === "completed" ? 0 : 1),
    terminal: true,
  };
}
