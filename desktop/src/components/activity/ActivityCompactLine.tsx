/**
 * Compact mode: one subtle per-turn line, rendered inline in the message
 * footer next to "Response details" rather than as a parallel summary system.
 *
 * Plain language only (requirement 7). Anything the host did not report is
 * simply omitted from the sentence — the line never pads itself out with
 * "0" or "—" to look complete.
 */
import type { ActivityTurn } from "../../lib/activity/types";

export function ActivityCompactLine({
  turn,
  onOpenDetails,
}: {
  turn: ActivityTurn;
  onOpenDetails: () => void;
}) {
  const parts: string[] = [];
  if (turn.summary.modelRounds != null) {
    parts.push(
      `${turn.summary.modelRounds} model request${turn.summary.modelRounds === 1 ? "" : "s"}`,
    );
  }
  if (turn.summary.toolCalls != null && turn.summary.toolCalls > 0) {
    parts.push(
      `${turn.summary.toolCalls} tool call${turn.summary.toolCalls === 1 ? "" : "s"}`,
    );
  }
  if (turn.citations.length > 0) {
    parts.push(
      `${turn.citations.length} source${turn.citations.length === 1 ? "" : "s"} cited`,
    );
  }
  if (turn.summary.grounded === false) parts.push("no sources cited");
  if (turn.summary.status === "withheld") parts.push("answer withheld");

  const text =
    parts.length > 0
      ? parts.join(" · ")
      : turn.liveRecord
        ? "No recorded activity for this turn"
        : "Activity was not recorded for this turn";

  return (
    <div
      className="activity-compact-line"
      role="status"
      data-testid="activity-compact-line"
    >
      <span className="activity-compact-line__text">{text}</span>
      <button
        type="button"
        className="activity-compact-line__details"
        onClick={onOpenDetails}
        aria-label={`Activity details for ${turn.label}`}
      >
        Details ›
      </button>
    </div>
  );
}
