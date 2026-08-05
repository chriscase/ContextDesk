/**
 * THE SEAM: build one `ActivityTurn` from (a) the host's live
 * `TurnActivityRecord`, when the backend recorded one, and (b) what the
 * renderer itself observed for that message — tool calls, citations, and the
 * search trail already folded into `ChatMsg` by `applyEventsToMessage`.
 *
 * This replaces the earlier draft that filled context categories, budget, and
 * request rounds from `fixtures.ts` and tagged each with `source: "fixture"`.
 * Production no longer imports fixtures at all (a test pins that). The rule
 * now is simple: **a fact the host did not report is `null`, and the UI shows
 * it as unknown.** An inspector that invents the thing it is inspecting is
 * worse than no inspector.
 *
 * Host-free: `record` is passed in already decoded by
 * `src/lib/engine/turnActivity.ts`.
 */
import type { ChatMsg } from "../turn";
import {
  ACTIVITY_LANE_GROUP,
  determinismForOrigin,
  type ActivityCitation,
  type ActivityEvent,
  type ActivityTurn,
  type DeveloperDetailEvent,
  type HostTurnActivityRecord,
} from "./types";
import {
  activityEventsFromRecord,
  requestRoundsFromRecord,
  summaryFromRecord,
} from "./turnRecord";
import { settleTurnLifecycle } from "./turnLifecycle";

export type BuildActivityTurnOptions = {
  /** The host's record for this turn, when one exists. */
  record?: HostTurnActivityRecord | null;
  /** Wall-clock turn duration if the caller tracked it; null when unknown. */
  elapsedMs?: number | null;
  developerDetail?: DeveloperDetailEvent[];
};

/**
 * Events the renderer observed directly.
 *
 * These carry a **sequence** clock, not elapsed or wall: the transcript fold
 * preserves order but records no timing, and inventing either would be the
 * fabrication this lane exists to prevent.
 */
function observedEvents(msg: ChatMsg): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  let seq = 0;
  const next = () => ({ kind: "sequence" as const, seq: seq++ });
  const scope = { kind: "conversation" as const, id: null, label: "Conversation" };
  const common = {
    correlationId: msg.id,
    scope,
    laneGroup: ACTIVITY_LANE_GROUP,
    phase: "completed" as const,
    evidence: [],
  };

  for (const step of msg.trail ?? []) {
    events.push({
      ...common,
      id: `search:${msg.id}:${step}`,
      operationId: `search:${step}`,
      origin: "repeatable_heuristic",
      determinism: determinismForOrigin("repeatable_heuristic"),
      status: "ok",
      clock: next(),
      label: "Search step",
      detail: step,
      privacy: "metadata",
    });
  }

  for (const t of msg.tools ?? []) {
    const summary = (t.summary || "").trim().toLowerCase();
    if (summary === "awaiting permission") {
      events.push({
        ...common,
        id: `perm:${msg.id}:${t.id}`,
        operationId: `tool:${t.id}`,
        origin: "client_evidence",
        determinism: determinismForOrigin("client_evidence"),
        // The prompt was raised; whether it was answered is not knowable
        // from this row, so the status stays pending rather than claiming ok.
        status: "pending",
        phase: "started",
        clock: next(),
        label: `Permission requested · ${t.name}`,
        detail: t.detail,
        privacy: "metadata",
      });
      continue;
    }
    events.push({
      ...common,
      id: `tool:${msg.id}:${t.id}`,
      operationId: `tool:${t.id}`,
      // Without a host record the only fact this layer knows is that the
      // renderer observed a tool row. It cannot infer connector/write
      // authority from a name pattern.
      origin: "client_evidence",
      determinism: determinismForOrigin("client_evidence"),
      status: t.ok === false ? "failed" : "ok",
      clock: next(),
      label: `Tool · ${t.name}`,
      detail: t.summary || t.detail,
      privacy: "metadata",
    });
  }

  for (const c of msg.citations ?? []) {
    events.push({
      ...common,
      id: `cite:${msg.id}:${c.id}`,
      operationId: `cite:${c.id}`,
      origin: "client_evidence",
      determinism: determinismForOrigin("client_evidence"),
      status: "ok",
      clock: next(),
      label: `Citation · ${c.title || c.label}`,
      detail: c.id,
      privacy: "metadata",
      evidence: [{ kind: "citation", id: c.id }],
    });
  }
  return events;
}

/** Tool names the renderer actually saw run (not merely offered). */
function toolsRun(msg: ChatMsg): string[] {
  return (msg.tools ?? [])
    .filter((t) => (t.summary || "").trim().toLowerCase() !== "awaiting permission")
    .map((t) => t.name);
}

/** Build one renderer-owned view from an authoritative host record when one exists. */
export function buildActivityTurn(
  msg: ChatMsg,
  opts: BuildActivityTurnOptions = {},
): ActivityTurn {
  const record = opts.record ?? null;
  const observed = record ? [] : observedEvents(msg);
  const citations: ActivityCitation[] = (msg.citations ?? []).map((c) => ({
    id: c.id,
    label: c.label,
    title: c.title,
  }));
  const ran = toolsRun(msg);

  const hostEvents = record ? activityEventsFromRecord(record) : [];
  const rounds = record ? requestRoundsFromRecord(record) : [];
  const recordSummary = record ? summaryFromRecord(record) : null;

  // One settle for every surface: host terminal status beats a stale
  // streaming flag so the drawer title cannot say "(streaming…)" after cancel.
  const lifecycle = settleTurnLifecycle({
    streaming: msg.streaming,
    content: msg.content,
    recordStatus: recordSummary?.status ?? record?.status ?? null,
  });

  // Grounding is a statement about the delivered answer, so it is only
  // knowable once the turn has settled. A live turn is `null`, not false.
  const grounded = lifecycle.live
    ? null
    : record
      ? record.status === "withheld"
        ? false
        : citations.length > 0
      : citations.length > 0
        ? true
        : null;

  return {
    turnId: msg.id,
    label: lifecycle.titleLabel,
    summary: {
      modelRounds: recordSummary?.modelRounds ?? null,
      toolCalls: record
        ? new Set(
            record.events
              .filter(
                (event) =>
                  event.operation_id.startsWith("tool-") &&
                  event.phase === "completed" &&
                  event.status !== "pending",
              )
              .map((event) => event.operation_id),
          ).size
        : ran.length > 0
          ? ran.length
          : msg.tools?.length
            ? 0
            : null,
      contextUsedChars: recordSummary?.contextUsedChars ?? null,
      grounded,
      // Prefer settled lifecycle status so pending never outlives a terminal
      // host record when the summary field is missing for any reason.
      status: lifecycle.status ?? recordSummary?.status ?? null,
    },
    budget: {
      usedChars: recordSummary?.contextUsedChars ?? null,
      // The host does not report a per-model ceiling on the record, so there
      // is no honest total to draw a progress bar against.
      totalChars: null,
      truncationNote:
        record && record.events.some((e) => e.context?.messages_capped)
          ? "Some prompt messages were longer than the trace retains, so the captured context is a prefix."
          : null,
    },
    requestRounds: rounds,
    // A host record is authoritative and already includes the live stream.
    // Renderer-observed rows are a fallback only, never appended duplicates.
    events: [...hostEvents, ...observed],
    citations,
    permissions: record
      ? record.events
          .filter((event) => event.origin === "user_decision")
          .map((event) => ({
            id: event.operation_id,
            toolName: event.label.replace(/^Permission (?:allowed|denied):\s*/, ""),
            target: "target not retained",
            decision: event.detail?.replace(/^decision=/, "") ?? null,
          }))
      : [],
    elapsedMs: opts.elapsedMs ?? record?.total_elapsed_ms ?? null,
    liveRecord: record != null,
    droppedEvents: record?.dropped_events ?? 0,
    contractVersion: record?.version ?? null,
    developerDetail: [...(opts.developerDetail ?? [])].sort(
      (left, right) => left.seq - right.seq,
    ),
  };
}
