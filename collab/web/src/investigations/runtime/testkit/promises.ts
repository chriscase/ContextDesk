/** A manually settled promise for deterministic stale-request tests. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: Deferred<T>["resolve"];
  let rejectPromise!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

/**
 * Models a transport that finishes after cancellation. The signal is observed
 * for assertions but intentionally does not settle or reject the promise.
 */
export interface AbortIgnoringDeferred<T> extends Deferred<T> {
  readonly signal: AbortSignal;
  wasAborted(): boolean;
}

export function createAbortIgnoringDeferred<T>(
  signal: AbortSignal,
): AbortIgnoringDeferred<T> {
  const deferred = createDeferred<T>();
  return {
    ...deferred,
    signal,
    wasAborted: () => signal.aborted,
  };
}
