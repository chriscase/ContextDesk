/**
 * Dual-lane time alignment — the rule that decides whether the customer
 * evidence lanes and the ContextDesk activity lanes may share one visual
 * axis, and what a reader is told when they may not.
 *
 * The product requirement this encodes: **never invent calendar time.** Two
 * distinct ways that could happen, both prevented here:
 *
 * 1. The corpus itself has no calendar time. An `order_only` corpus carries
 *    ordering and nothing else; drawing its events against dates would be
 *    fabrication. `mixed` is no better for a shared axis — part of the
 *    corpus would be truthfully placed and part invented, which is worse
 *    than plainly saying the alignment is approximate.
 * 2. The ContextDesk side has no calendar time. Activity captured as elapsed
 *    or sequence has no wall placement of its own; projecting it onto the
 *    customer's dates would assert a correspondence nobody measured.
 *
 * When either side falls short, the two groups render on separate tracks and
 * the ContextDesk track is explicitly labelled as causal/approximate. That is
 * a real, useful view — it still shows what happened in what order relative
 * to the investigation — it simply refuses to call it wall-clock.
 */
import {
  isWallClock,
  type ActivityEvent,
  type ClientIncidentClock,
} from "./types";

/** How the two lane groups are being drawn right now. */
export type DualLaneAlignment =
  /**
   * Both sides carry wall-clock evidence: one shared axis, real dates, and
   * a ContextDesk event drawn at date X really did happen at date X.
   */
  | {
      kind: "shared_wall_clock";
      /** Inclusive domain covering both groups, in epoch ms. */
      domain: { startMs: number; endMs: number };
      label: string;
    }
  /**
   * At least one side lacks calendar time. Two tracks; ContextDesk events
   * are ordered causally against the investigation, not dated.
   */
  | {
      kind: "separate_tracks";
      /** Why a shared axis was refused — shown to the reader verbatim. */
      reason: string;
      label: string;
    };

/** Does this corpus carry genuine calendar time for every event? */
export function corpusHasWallClock(clock: ClientIncidentClock): boolean {
  return (
    clock.timeQuality === "wall" &&
    clock.tsMinMs != null &&
    clock.tsMaxMs != null
  );
}

/**
 * Wall-clock extent of the ContextDesk events, or null when none of them
 * carry calendar time.
 *
 * Deliberately requires EVERY event to be wall-clock. A partially-dated set
 * drawn on a dated axis would silently place the undated members somewhere,
 * and "somewhere" is exactly the invention this module exists to prevent.
 */
export function activityWallExtent(
  events: readonly ActivityEvent[],
): { startMs: number; endMs: number } | null {
  if (events.length === 0) return null;
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    if (!isWallClock(event.clock)) return null;
    startMs = Math.min(startMs, event.clock.atMs);
    endMs = Math.max(endMs, event.clock.atMs);
  }
  return { startMs, endMs };
}

/**
 * Decide how to draw the two groups together.
 *
 * `activityEvents` is the ContextDesk group; `clientClock` describes the
 * customer group. Neither is mutated, and this function is the only place
 * the "may we share an axis" question is answered, so a new surface cannot
 * accidentally answer it differently.
 */
export function resolveDualLaneAlignment(
  clientClock: ClientIncidentClock,
  activityEvents: readonly ActivityEvent[],
): DualLaneAlignment {
  if (!corpusHasWallClock(clientClock)) {
    return {
      kind: "separate_tracks",
      reason:
        clientClock.timeQuality === "order_only"
          ? "This evidence is order-only — it carries no calendar time, so there is no shared axis to place ContextDesk activity on."
          : clientClock.timeQuality === "mixed"
            ? "This evidence has mixed time quality — only part of it is calendar time, so a shared axis would place the rest at invented dates."
            : "This corpus reported no event time range, so there is no shared axis to align against.",
      label: "Approximate — ordered by cause, not by clock",
    };
  }
  const extent = activityWallExtent(activityEvents);
  if (!extent) {
    return {
      kind: "separate_tracks",
      reason:
        activityEvents.length === 0
          ? "No ContextDesk activity has been recorded for this view yet."
          : "Some ContextDesk activity was captured in order or elapsed time only, so it has no calendar position to align against this evidence.",
      label: "Approximate — ordered by cause, not by clock",
    };
  }
  return {
    kind: "shared_wall_clock",
    domain: {
      startMs: Math.min(clientClock.tsMinMs!, extent.startMs),
      endMs: Math.max(clientClock.tsMaxMs!, extent.endMs),
    },
    label: "Shared wall clock — both lanes carry calendar time",
  };
}

/**
 * Position of one wall-clock instant within a shared domain, as 0..1.
 *
 * Returns null for a domain of zero width (one instant, or every event at
 * the same millisecond) rather than dividing by zero and rendering NaN.
 */
export function fractionWithinDomain(
  atMs: number,
  domain: { startMs: number; endMs: number },
): number | null {
  const span = domain.endMs - domain.startMs;
  if (!Number.isFinite(span) || span <= 0) return null;
  const raw = (atMs - domain.startMs) / span;
  return Math.min(1, Math.max(0, raw));
}
