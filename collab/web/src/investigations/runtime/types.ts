import type { RuntimeFailure } from "./errors.js";

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
