/**
 * Authoritative turn lifecycle settle for every Activity surface.
 *
 * One function of (message streaming flag + host record status) decides whether
 * a turn is still live. Drawer title, compact line, dock, grounded summary, and
 * CLI projection must all consume this — never a parallel `isStreaming` that
 * outlives a terminal host status (the packaged-GUI bug: technical detail said
 * `cancelled` while the title still read "(streaming…)").
 */
import type { ActivityStatus } from "./types";

/** Statuses that mean the turn has finished once and for all. */
export const TERMINAL_ACTIVITY_STATUSES: ReadonlySet<ActivityStatus> = new Set([
  "ok",
  "failed",
  "cancelled",
  "withheld",
]);

export function isTerminalActivityStatus(
  status: ActivityStatus | null | undefined,
): status is "ok" | "failed" | "cancelled" | "withheld" {
  return status != null && TERMINAL_ACTIVITY_STATUSES.has(status);
}

export type TurnLifecycleInput = {
  /** Renderer transcript flag — may lag or stay true after cancel races. */
  streaming?: boolean;
  content?: string | null;
  /** Host `TurnActivityRecord.status` when a live record exists. */
  recordStatus?: ActivityStatus | null;
};

export type TurnLifecycle = {
  /** Surfaces may show live/streaming chrome only when this is true. */
  live: boolean;
  /** Effective status for labels; never `pending` once the host settled. */
  status: ActivityStatus | null;
  /**
   * Drawer / dock title. Never "(streaming…)" once the turn is terminal,
   * even when the assistant bubble has empty content.
   */
  titleLabel: string;
  /** One short word for compact / summary lines. */
  statusPhrase: string | null;
};

function shortLabel(text: string, max = 64): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Host terminal status wins over a stale `streaming: true` flag. A turn with
 * no host record is live only while the renderer still marks it streaming.
 */
export function isTurnLive(input: TurnLifecycleInput): boolean {
  if (isTerminalActivityStatus(input.recordStatus)) return false;
  return Boolean(input.streaming);
}

/** Human phrase for a status; null when unknown/not applicable. */
export function activityStatusPhrase(
  status: ActivityStatus | null | undefined,
): string | null {
  switch (status) {
    case "ok":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "withheld":
      return "answer withheld";
    case "pending":
      return "in progress";
    default:
      return null;
  }
}

/**
 * Empty-content titles when the turn is no longer live. Never invent success
 * when status is unknown — prefer "(no content)" over a false "completed".
 */
function emptyTerminalTitle(
  status: ActivityStatus | null | undefined,
): string {
  switch (status) {
    case "cancelled":
      return "(cancelled)";
    case "failed":
      return "(failed)";
    case "withheld":
      return "(answer withheld)";
    case "ok":
      return "(completed)";
    default:
      return "(no content)";
  }
}

/**
 * Single settle used by `buildActivityTurn` and any surface that needs a title
 * without reconstructing the full turn.
 */
export function settleTurnLifecycle(input: TurnLifecycleInput): TurnLifecycle {
  const live = isTurnLive(input);
  const status: ActivityStatus | null = isTerminalActivityStatus(
    input.recordStatus,
  )
    ? input.recordStatus
    : live
      ? "pending"
      : (input.recordStatus ?? null);

  const contentLabel = shortLabel(input.content ?? "");
  let titleLabel: string;
  if (contentLabel) {
    titleLabel = contentLabel;
  } else if (live) {
    titleLabel = "(streaming…)";
  } else {
    titleLabel = emptyTerminalTitle(status);
  }

  return {
    live,
    status,
    titleLabel,
    statusPhrase: activityStatusPhrase(status),
  };
}

/**
 * Gate for late stream / activity mutations after a terminal settle.
 * Returning false means the event must not resurrect live chrome or flip
 * status back to pending/streaming.
 */
export function acceptLifecycleMutation(args: {
  currentStatus: ActivityStatus | null | undefined;
  /** Proposed status after applying a late host/tool/provider event. */
  nextStatus: ActivityStatus | null | undefined;
  /** True when the turn was already settled once (host activity_settled). */
  settled: boolean;
}): { accept: boolean; reason: "accepted" | "late_after_terminal" } {
  if (
    args.settled &&
    isTerminalActivityStatus(args.currentStatus) &&
    !isTerminalActivityStatus(args.nextStatus)
  ) {
    return { accept: false, reason: "late_after_terminal" };
  }
  if (
    args.settled &&
    isTerminalActivityStatus(args.currentStatus) &&
    isTerminalActivityStatus(args.nextStatus) &&
    args.currentStatus !== args.nextStatus
  ) {
    // Exactly one terminal transition: a second terminal code after settle
    // is late noise (e.g. cancel then a delayed provider "stop").
    return { accept: false, reason: "late_after_terminal" };
  }
  return { accept: true, reason: "accepted" };
}

/**
 * Merge a cached host record with a late fetch. Terminal records never go
 * back to pending; late non-terminal payloads are discarded.
 */
export function mergeSettledActivityRecord<
  T extends { status: ActivityStatus },
>(current: T | null | undefined, incoming: T | null | undefined): T | null {
  if (incoming == null) return current ?? null;
  if (current == null) return incoming;
  const gate = acceptLifecycleMutation({
    currentStatus: current.status,
    nextStatus: incoming.status,
    settled: isTerminalActivityStatus(current.status),
  });
  if (!gate.accept) return current;
  return incoming;
}
