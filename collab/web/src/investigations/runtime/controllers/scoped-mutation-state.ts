import type { MutationState } from "../types.js";

export interface ScopedMutationState<T> {
  readonly scopeKey: string | null;
  readonly state: MutationState<T>;
}

export function emptyScopedMutationState<T>(): ScopedMutationState<T> {
  return { scopeKey: null, state: { status: "idle" } };
}

export function scopedMutationState<T>(
  scopeKey: string,
  state: MutationState<T>,
): ScopedMutationState<T> {
  return { scopeKey, state };
}

/** Never expose one authority/case's mutation result during another render. */
export function visibleMutationState<T>(
  stored: ScopedMutationState<T>,
  currentScopeKey: string | null,
): MutationState<T> {
  return currentScopeKey !== null && stored.scopeKey === currentScopeKey
    ? stored.state
    : { status: "idle" };
}

export function mutationScopeKey(parts: readonly string[]): string {
  return JSON.stringify(parts);
}
