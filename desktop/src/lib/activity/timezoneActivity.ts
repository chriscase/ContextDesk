/**
 * Typed ContextDesk activity for corpus timezone review apply/undo.
 * Does not replace TimeReviewCard or the import ledger — pure event inputs
 * for the shared activity log / rail.
 *
 * Accumulation is **bounded**: LogPane routes apply/undo/fail through
 * {@link recordTimezoneActivity} so a long review session cannot grow an
 * unbounded array. Oldest rows drop with an honest `omitted` count.
 */
import {
  appendActivity,
  createActivityLog,
  type ActivityLogState,
} from "./activityLog";
import {
  determinismForOrigin,
  ACTIVITY_LANE_GROUP,
  type ActivityEventInput,
} from "./types";

export type TimezoneActivityOutcome =
  | "applied"
  | "undone"
  | "failed"
  | "cancelled";

/** Process-local cap for timezone apply/undo rows on the Logs pane. */
export const TIMEZONE_ACTIVITY_CAP = 64;

export function createTimezoneActivityLog(
  cap: number = TIMEZONE_ACTIVITY_CAP,
): ActivityLogState {
  return createActivityLog(cap);
}

export function timezoneActivityEvent(args: {
  corpusId: string;
  correlationId: string;
  outcome: TimezoneActivityOutcome;
  sourceCount?: number;
  zone?: string | null;
  seq?: number;
}): ActivityEventInput {
  const origin =
    args.outcome === "applied" || args.outcome === "undone"
      ? ("user_decision" as const)
      : args.outcome === "cancelled"
        ? ("user_decision" as const)
        : ("deterministic_host" as const);
  const label =
    args.outcome === "applied"
      ? "Timezone applied to source group"
      : args.outcome === "undone"
        ? "Timezone apply undone"
        : args.outcome === "cancelled"
          ? "Timezone review cancelled"
          : "Timezone apply failed";
  const detailParts: string[] = [];
  if (args.zone) detailParts.push(`zone=${args.zone}`);
  if (args.sourceCount != null)
    detailParts.push(`${args.sourceCount} source(s)`);
  return {
    correlationId: args.correlationId,
    operationId: `${args.correlationId}:timezone:${args.outcome}`,
    origin,
    determinism: determinismForOrigin(origin),
    phase: "completed",
    status:
      args.outcome === "failed"
        ? "failed"
        : args.outcome === "cancelled"
          ? "cancelled"
          : "ok",
    clock: { kind: "sequence", seq: args.seq ?? 0 },
    label,
    detail: detailParts.length > 0 ? detailParts.join(" · ") : undefined,
    scope: {
      kind: "log_corpus",
      id: args.corpusId,
      label: "Log corpus",
    },
    privacy: "metadata",
    evidence: [],
    laneGroup: ACTIVITY_LANE_GROUP,
    corpusId: args.corpusId,
  };
}

/**
 * The LogPane apply/clear path: append one timezone event onto a **bounded**
 * shared activity log (same ring-buffer math as import live trace).
 */
export function recordTimezoneActivity(
  log: ActivityLogState,
  args: {
    corpusId: string;
    outcome: TimezoneActivityOutcome;
    zone?: string | null;
    sourceCount?: number;
  },
): ActivityLogState {
  return appendActivity(
    log,
    timezoneActivityEvent({
      corpusId: args.corpusId,
      correlationId: `import:${args.corpusId}:tz`,
      outcome: args.outcome,
      zone: args.zone,
      sourceCount: args.sourceCount,
      seq: log.entries.length + log.omitted,
    }),
  );
}
