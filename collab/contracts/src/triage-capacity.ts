/**
 * The one canonical arithmetic for what a triage run may be admitted to do.
 *
 * Two separate bounds used to govern one run: an advertised candidate ceiling
 * and a fixed progress-event ceiling. They were written independently and did
 * not agree. Because a lane emits an admission event and a settlement event,
 * a run of nine or more lanes overran the fixed sixteen-event ceiling and the
 * host killed a run it had already advertised as acceptable and accepted.
 *
 * Every bound below is therefore derived from one formula rather than being
 * written down twice, and the capability surface reports the derived value so
 * an operator is never offered a lane count the host cannot execute.
 *
 * Deliberately dependency-free: the web bundle imports this directly, so the
 * launcher's advertised limits and the server's admission gate are decided by
 * the same rule without dragging the schema machinery into the browser.
 */

/**
 * Durable progress events one lane can emit over its whole life: one admission
 * ("this lane has started") and one settlement ("this lane reached an
 * outcome"). Both are host-validated and each is rejected as a duplicate if
 * repeated, so this is a hard per-lane count, not an estimate.
 */
export const TRIAGE_PROGRESS_EVENTS_PER_LANE = 2;

/** Smallest run the host will accept at all. */
export const TRIAGE_MIN_CANDIDATES = 1;

/**
 * Largest run the host will accept — and, because the progress budget below is
 * derived from it rather than fixed independently, the largest run the host can
 * actually execute.
 */
export const TRIAGE_MAX_CANDIDATES = 16;

/** A gateway comparison needs at least two lanes to compare anything. */
export const TRIAGE_MIN_GATEWAY_CANDIDATES = 2;

/** Per-item and whole-run evidence ceilings for a gateway run, in bytes. */
export const TRIAGE_MAX_EVIDENCE_ITEM_BYTES = 4 * 1024 * 1024;
export const TRIAGE_MAX_EVIDENCE_AGGREGATE_BYTES = 8 * 1024 * 1024;

/**
 * The canonical formula. Every progress-event bound in the system is this
 * function of the accepted lane count; nothing may hard-code a second ceiling.
 */
export function triageProgressEventBudget(laneCount: number): number {
  const lanes = Number.isSafeInteger(laneCount) && laneCount > 0 ? laneCount : 0;
  return lanes * TRIAGE_PROGRESS_EVENTS_PER_LANE;
}

/**
 * The inverse: how many lanes a given progress-event ceiling can actually
 * carry. A capability surface that advertises more than this is lying.
 */
export function triageExecutableCandidateCeiling(progressEventCeiling: number): number {
  if (!Number.isSafeInteger(progressEventCeiling) || progressEventCeiling <= 0) return 0;
  return Math.floor(progressEventCeiling / TRIAGE_PROGRESS_EVENTS_PER_LANE);
}

/** The progress-event ceiling for the largest run the host advertises. */
export const TRIAGE_MAX_PROGRESS_EVENTS = triageProgressEventBudget(TRIAGE_MAX_CANDIDATES);

/**
 * The largest lane count that is both advertised and executable.
 *
 * Derived, never written down: if the two ever disagreed again this would fall
 * to the executable number, so the host under-promises instead of accepting a
 * run it will later kill.
 */
export const TRIAGE_EXECUTABLE_MAX_CANDIDATES = Math.min(
  TRIAGE_MAX_CANDIDATES,
  triageExecutableCandidateCeiling(TRIAGE_MAX_PROGRESS_EVENTS),
);

export type TriageCapacityRefusalCode =
  | "candidate_count_out_of_range"
  | "gateway_minimum_candidates"
  | "progress_budget_exceeded";

export interface TriageCapacityDecision {
  admitted: boolean;
  /** Progress events this run is permitted to emit, by the canonical formula. */
  progressEventBudget: number;
  code: TriageCapacityRefusalCode | null;
  /** Bounded, provider-free refusal text safe to show an operator. */
  message: string | null;
}

/**
 * The single admission gate for a run's lane count.
 *
 * Callers must run this before any side effect — no job row, no timeline
 * entry, no audit record, and certainly no provider work — so a run the host
 * cannot execute is refused at the door rather than killed halfway through.
 */
export function checkTriageCandidateCapacity(input: {
  laneCount: number;
  gateway: boolean;
}): TriageCapacityDecision {
  const { laneCount, gateway } = input;
  const budget = triageProgressEventBudget(laneCount);
  const refuse = (code: TriageCapacityRefusalCode, message: string): TriageCapacityDecision => ({
    admitted: false,
    progressEventBudget: budget,
    code,
    message,
  });
  if (
    !Number.isSafeInteger(laneCount)
    || laneCount < TRIAGE_MIN_CANDIDATES
    || laneCount > TRIAGE_EXECUTABLE_MAX_CANDIDATES
  ) {
    return refuse(
      "candidate_count_out_of_range",
      `candidate count must be between ${TRIAGE_MIN_CANDIDATES} and ${TRIAGE_EXECUTABLE_MAX_CANDIDATES}`,
    );
  }
  if (gateway && laneCount < TRIAGE_MIN_GATEWAY_CANDIDATES) {
    return refuse(
      "gateway_minimum_candidates",
      `gateway comparisons require at least ${TRIAGE_MIN_GATEWAY_CANDIDATES} candidate lanes`,
    );
  }
  if (budget > TRIAGE_MAX_PROGRESS_EVENTS) {
    // Unreachable while the ceiling is derived from the same formula. Kept as a
    // standing assertion so a future hand-written ceiling fails admission
    // instead of failing a run that is already spending on a provider.
    return refuse(
      "progress_budget_exceeded",
      `this run needs ${budget} progress events and the host can carry ${TRIAGE_MAX_PROGRESS_EVENTS}`,
    );
  }
  return { admitted: true, progressEventBudget: budget, code: null, message: null };
}

export const TRIAGE_EVIDENCE_BUDGET_ERROR_CODE = "evidence_budget_exceeded" as const;

export type TriageEvidenceBudgetScope = "item" | "aggregate";

/**
 * What the host refused, in numbers the operator can act on.
 *
 * This used to collapse into a generic runner error, which told a reader only
 * that "something broke in the runner" for a condition that is neither a
 * provider fault nor a transient one: no amount of retrying shrinks the
 * evidence. Naming the bound and the actual size is what makes the next step
 * — trim the snapshot — obvious.
 */
export interface TriageEvidenceBudgetFailureV1 {
  code: typeof TRIAGE_EVIDENCE_BUDGET_ERROR_CODE;
  scope: TriageEvidenceBudgetScope;
  allowedBytes: number;
  actualBytes: number;
}

function mebibytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  const rounded = Math.round(mib * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(2)} MiB`;
}

/**
 * Concise operator-facing explanation of an evidence-budget refusal.
 *
 * Sizes and the scope only. No filename, no evidence id, no snapshot content,
 * no provider or host text — the numbers are the whole actionable content, and
 * anything else here would be a way for run content to reach a shared view.
 */
export function triageEvidenceBudgetExplanation(
  failure: TriageEvidenceBudgetFailureV1,
): string {
  const over = Math.max(0, failure.actualBytes - failure.allowedBytes);
  const subject = failure.scope === "item"
    ? "One evidence item"
    : "The frozen evidence for this run";
  return `${subject} is ${mebibytes(failure.actualBytes)}, over the ${mebibytes(failure.allowedBytes)} limit by ${mebibytes(over)}. Nothing was sent to a provider. Remove or trim evidence and start a new run; retrying this one will refuse again.`;
}

/** Checks a candidate size against the scope's bound without reading content. */
export function checkTriageEvidenceBudget(input: {
  scope: TriageEvidenceBudgetScope;
  actualBytes: number;
}): TriageEvidenceBudgetFailureV1 | null {
  const allowedBytes = input.scope === "item"
    ? TRIAGE_MAX_EVIDENCE_ITEM_BYTES
    : TRIAGE_MAX_EVIDENCE_AGGREGATE_BYTES;
  if (input.actualBytes <= allowedBytes) return null;
  return {
    code: TRIAGE_EVIDENCE_BUDGET_ERROR_CODE,
    scope: input.scope,
    allowedBytes,
    actualBytes: input.actualBytes,
  };
}
