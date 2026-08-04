/**
 * Projection of the host's `TurnActivityRecord` (cd-core's source-agnostic
 * activity contract) into the renderer's canonical `ActivityEvent`s and turn
 * facets.
 *
 * Pure and host-free by construction: it takes the already-decoded wire shape
 * and returns renderer types. The actual IPC lives in
 * `src/lib/engine/turnActivity.ts`, the designated adapter boundary — this
 * module imports nothing from `src/lib/host`.
 *
 * Honesty rules encoded here:
 *  - Host events are placed on an **elapsed** clock, because that is exactly
 *    what the contract carries (`elapsed_ms` since turn start). They are not
 *    converted into wall-clock dates by adding a turn start time we did not
 *    measure per-event.
 *  - A field the record does not carry stays `null`. There is no default, no
 *    estimate, and no fixture.
 */
import {
  determinismForOrigin,
  ACTIVITY_LANE_GROUP,
  type ActivityEvent,
  type ActivityRequestRound,
  type ActivityTurnSummary,
  type ContextMetadata,
  type DataScope,
  type HostActivityEvent,
  type HostContextMetadata,
  type HostTurnActivityRecord,
} from "./types";

function toScope(scope: HostActivityEvent["scope"]): DataScope {
  return { kind: scope.kind, id: scope.id ?? null, label: scope.label };
}

function toContext(context: HostContextMetadata): ContextMetadata {
  return {
    round: context.round,
    messageCount: context.message_count,
    contextUsedChars: context.context_used_chars,
    messagesCapped: context.messages_capped,
    toolNames: [...context.tool_names],
    roles: context.roles.map((r) => ({
      role: r.role,
      messages: r.messages,
      chars: r.chars,
    })),
    providerLatencyMs: context.provider_latency_ms ?? null,
  };
}

/**
 * Plain-language trigger + data scope for a host event.
 *
 * The contract's `trigger` is a tagged union and its `scope` is a labelled
 * data scope; the disclosure the UI requires on every nondeterministic event
 * is built from those two rather than invented.
 */
function disclosureFor(event: HostActivityEvent): {
  trigger: string;
  dataScope: string;
} {
  const trigger = (() => {
    switch (event.trigger.trigger) {
      case "user_message":
        return "your message started this turn";
      case "host_policy":
        return "the app's own turn sequencing";
      case "model_request":
        return `the model asked for it (round ${event.trigger.round + 1})`;
      case "user_decision":
        return "you answered a prompt";
      case "retry":
        return `a retry of ${event.trigger.of_operation_id}`;
    }
  })();
  return { trigger, dataScope: event.scope.label };
}

/** One host event → one canonical renderer event. */
export function activityEventFromHost(
  event: HostActivityEvent,
  index: number,
): ActivityEvent {
  const base = {
    id: `host:${event.turn_id}:${event.seq}:${index}`,
    correlationId: event.turn_id,
    operationId: event.operation_id,
    phase: event.phase,
    status: event.status,
    // Unknown timing stays unknown. `seq` still preserves actual causality.
    clock:
      event.elapsed_ms == null
        ? ({ kind: "sequence" as const, seq: event.seq })
        : ({ kind: "elapsed" as const, elapsedMs: event.elapsed_ms }),
    label: event.label,
    detail: event.detail ?? undefined,
    scope: toScope(event.scope),
    evidence: event.evidence ? [...event.evidence] : [],
    privacy: event.privacy,
    context: event.context ? toContext(event.context) : undefined,
    laneGroup: ACTIVITY_LANE_GROUP,
    corpusId: event.scope.kind === "log_corpus" ? (event.scope.id ?? undefined) : undefined,
    // Derived, never taken from the wire: if a host ever shipped a record
    // whose determinism disagreed with its origin, the origin wins, because
    // that is the field the classification rule is defined on.
    determinism: determinismForOrigin(event.origin),
  };
  if (event.origin === "probabilistic_model" || event.origin === "external_connector") {
    return { ...base, origin: event.origin, hook: disclosureFor(event) };
  }
  return { ...base, origin: event.origin };
}

/** Every host event in the record, in `seq` order. */
export function activityEventsFromRecord(
  record: HostTurnActivityRecord,
): ActivityEvent[] {
  return [...record.events]
    .sort((a, b) => a.seq - b.seq)
    .map((event, index) => activityEventFromHost(event, index));
}

/** Provider rounds the record captured, as display rows. */
export function requestRoundsFromRecord(
  record: HostTurnActivityRecord,
): ActivityRequestRound[] {
  const events = [...record.events].sort((a, b) => a.seq - b.seq);
  return events
    .filter((event) => event.origin === "probabilistic_model" && event.context)
    .map((event) => {
      const context = event.context!;
      const nextRoundSeq = events.find(
        (candidate) =>
          candidate.seq > event.seq &&
          candidate.origin === "probabilistic_model" &&
          candidate.context != null,
      )?.seq;
      const toolsRun = events
        .filter(
          (candidate) =>
            candidate.seq > event.seq &&
            (nextRoundSeq == null || candidate.seq < nextRoundSeq) &&
            candidate.operation_id.startsWith("tool-") &&
            candidate.phase === "completed" &&
            candidate.status !== "pending",
        )
        .map((candidate) => candidate.label.replace(/^Tool\s+/, ""));
      return {
        id: `${record.turn_id}:round-${context.round}`,
        index: context.round + 1,
        toolsOffered: [...context.tool_names],
        // Shared host sequencing makes attribution causal instead of a
        // renderer guess: these completed before the next model round.
        toolsRun,
        elapsedMs: context.provider_latency_ms ?? null,
        status: event.status,
        contextUsedChars: context.context_used_chars,
        messagesCapped: context.messages_capped,
      };
    });
}

/** Turn-level facts the record establishes. */
export function summaryFromRecord(
  record: HostTurnActivityRecord,
): Pick<
  ActivityTurnSummary,
  "modelRounds" | "contextUsedChars" | "status"
> {
  const rounds = record.events.filter(
    (event) =>
      event.origin === "probabilistic_model" && event.phase === "completed",
  );
  const contextUsedChars = record.events.reduce(
    (sum, event) => sum + (event.context?.context_used_chars ?? 0),
    0,
  );
  return {
    modelRounds: rounds.length,
    // A turn that made no request has no context total to report; 0 would
    // read as "measured zero" rather than "nothing was sent".
    contextUsedChars: rounds.length > 0 ? contextUsedChars : null,
    status: record.status,
  };
}
