import type { RuntimeFailure } from "./errors.js";

export const MAX_EVIDENCE_UPLOAD_BYTES = 1_000_000;

export type CommandIgnoredReason = "busy" | "stale" | "not_ready";

/** The bounded result of a controller command. */
export type CommandOutcome<T> =
  | { status: "succeeded"; value: T }
  | { status: "failed"; error: RuntimeFailure }
  | { status: "ignored"; reason: CommandIgnoredReason };

/**
 * The complete public state of one runtime read.
 *
 * A refresh never discards a value that was already published. `previous`
 * lets selectors keep rendering that value while also reporting that it is
 * stale or that its refresh failed.
 */
export type ResourceState<T> =
  | { status: "idle" }
  | { status: "loading"; previous?: T }
  | { status: "ready"; value: T }
  | { status: "failed"; error: RuntimeFailure; previous?: T };

/** The public progress of one mutation, with no transport object attached. */
export type MutationState<TResult = void> =
  | { status: "idle" }
  | { status: "running" }
  | { status: "succeeded"; value: TResult }
  | { status: "failed"; error: RuntimeFailure };
