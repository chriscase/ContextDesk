/**
 * Bounded, append-only ContextDesk activity log — pure state math in the
 * house style (`importFlowState.ts` precedent): plain data plus pure
 * functions, owned by whichever component holds it in `useState`.
 *
 * Bounded by design: a long session must not grow an unbounded array the UI
 * then has to virtualize its way out of. The cap drops the OLDEST entries and
 * counts them, so truncation is visible ("N earlier entries omitted"), never
 * silent.
 *
 * Text is bounded here too, at the store boundary rather than at render time:
 * a 2 MB detail string retained in memory is a retention problem even if a
 * component happens to clip it visually.
 */
import type { ActivityEvent, ActivityEventInput } from "./types";

export type ActivityLogState = {
  entries: ActivityEvent[];
  /** Oldest-entry drops due to the cap — surfaced, not silent. */
  omitted: number;
  cap: number;
  /** Monotonic id source; ids stay unique across drops. */
  nextId: number;
};

export const DEFAULT_ACTIVITY_CAP = 500;

/** Mirrors cd-core's MAX_ACTIVITY_LABEL_CHARS / MAX_ACTIVITY_DETAIL_CHARS. */
export const MAX_ACTIVITY_LABEL_CHARS = 200;
export const MAX_ACTIVITY_DETAIL_CHARS = 2_000;

function boundChars(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function createActivityLog(
  cap: number = DEFAULT_ACTIVITY_CAP,
): ActivityLogState {
  return { entries: [], omitted: 0, cap: Math.max(1, cap), nextId: 1 };
}

export function appendActivity(
  state: ActivityLogState,
  input: ActivityEventInput,
): ActivityLogState {
  const entry = {
    ...input,
    id: `act-${state.nextId}`,
    label: boundChars(input.label, MAX_ACTIVITY_LABEL_CHARS),
    detail:
      input.detail == null
        ? undefined
        : boundChars(input.detail, MAX_ACTIVITY_DETAIL_CHARS),
  } as ActivityEvent;
  const entries = [...state.entries, entry];
  const overflow = entries.length - state.cap;
  return {
    entries: overflow > 0 ? entries.slice(overflow) : entries,
    omitted: state.omitted + Math.max(0, overflow),
    cap: state.cap,
    nextId: state.nextId + 1,
  };
}

export function appendActivities(
  state: ActivityLogState,
  inputs: ActivityEventInput[],
): ActivityLogState {
  return inputs.reduce(appendActivity, state);
}
