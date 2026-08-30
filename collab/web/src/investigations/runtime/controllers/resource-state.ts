import type { RuntimeFailure } from "../errors.js";
import type { ResourceState } from "../types.js";

/** Resource state paired with the identity whose value it may publish. */
export interface KeyedResourceState<TKey, TValue> {
  readonly key: TKey | null;
  readonly state: ResourceState<TValue>;
}

export function createResourceState<TKey, TValue>(): KeyedResourceState<TKey, TValue> {
  return { key: null, state: { status: "idle" } };
}

function publishedValue<T>(state: ResourceState<T>): T | undefined {
  switch (state.status) {
    case "ready":
      return state.value;
    case "loading":
    case "failed":
      return state.previous;
    case "idle":
      return undefined;
  }
}

/** Begin loading a key, preserving a published value only for that exact key. */
export function beginResourceLoad<TKey, TValue>(
  current: KeyedResourceState<TKey, TValue>,
  key: TKey,
): KeyedResourceState<TKey, TValue> {
  const previous = current.key === key ? publishedValue(current.state) : undefined;
  return previous === undefined
    ? { key, state: { status: "loading" } }
    : { key, state: { status: "loading", previous } };
}

/** Publish success only if it belongs to the active resource identity. */
export function succeedResourceLoad<TKey, TValue>(
  current: KeyedResourceState<TKey, TValue>,
  key: TKey,
  value: TValue,
): KeyedResourceState<TKey, TValue> {
  return current.key === key
    ? { key, state: { status: "ready", value } }
    : current;
}

/** Publish failure only for the active identity, retaining its own prior value. */
export function failResourceLoad<TKey, TValue>(
  current: KeyedResourceState<TKey, TValue>,
  key: TKey,
  error: RuntimeFailure,
): KeyedResourceState<TKey, TValue> {
  if (current.key !== key) return current;
  // A concealed 404 can mean that live case membership was revoked. Never
  // keep publishing bytes whose authority has just been denied. Auth loss is
  // terminal for the same reason, even though the shell will also tear down.
  if (error.kind === "not_found" || error.kind === "auth_lost") {
    return { key, state: { status: "failed", error } };
  }
  const previous = publishedValue(current.state);
  return previous === undefined
    ? { key, state: { status: "failed", error } }
    : { key, state: { status: "failed", error, previous } };
}

export function resetResource<TKey, TValue>(): KeyedResourceState<TKey, TValue> {
  return createResourceState<TKey, TValue>();
}
