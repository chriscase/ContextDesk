import { createHash } from "node:crypto";
import type { ContentHash } from "@cd-collab/contracts";
import type { EvidenceReadHandle, EvidenceStore } from "./store.js";

/** A catalog-addressed evidence blob failed the strict bounded-read contract. */
export class BoundedEvidenceReadError extends Error {
  constructor(message = "evidence blob failed verification") {
    super(message);
    this.name = "BoundedEvidenceReadError";
  }
}

export interface BoundedEvidenceReadInput {
  evidence: EvidenceStore;
  hash: ContentHash;
  /** Authoritative length from the artifact catalog. */
  expectedLength: number;
  /** Caller-owned materialization limit. */
  maxBytes: number;
  signal?: AbortSignal;
}

function fail(): BoundedEvidenceReadError {
  return new BoundedEvidenceReadError();
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BoundedEvidenceReadError(`${label} must be a safe nonnegative integer`);
  }
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error("evidence read aborted");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal) return;
  if (typeof signal.throwIfAborted === "function") {
    signal.throwIfAborted();
    return;
  }
  if (signal.aborted) throw abortReason(signal);
}

async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<T>> {
  throwIfAborted(signal);
  if (!signal) return iterator.next();
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    let pending: Promise<IteratorResult<T>>;
    try {
      pending = Promise.resolve(iterator.next());
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    void pending.then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

function releaseIterator(iterator: AsyncIterator<Uint8Array>): void {
  if (typeof iterator.return !== "function") return;
  try {
    void Promise.resolve(iterator.return()).catch(() => undefined);
  } catch {
    // Cleanup must not replace or delay the bounded-read failure.
  }
}

async function openIterator(handle: EvidenceReadHandle): Promise<AsyncIterator<Uint8Array>> {
  const source: unknown = await Promise.resolve(handle.bytes());
  if (!source || typeof source !== "object") throw fail();
  const record = source as {
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
    [Symbol.iterator]?: () => Iterator<Uint8Array>;
    next?: AsyncIterator<Uint8Array>["next"];
  };
  const asyncIterator = record[Symbol.asyncIterator];
  if (typeof asyncIterator === "function") {
    return asyncIterator.call(record);
  }
  const syncIterator = record[Symbol.iterator];
  if (typeof syncIterator === "function") {
    const iterator = syncIterator.call(record);
    return {
      next: async () => iterator.next(),
      return: async () => {
        if (typeof iterator.return === "function") iterator.return();
        return { done: true, value: undefined };
      },
    };
  }
  if (typeof record.next === "function") return record as AsyncIterator<Uint8Array>;
  throw fail();
}

/**
 * Read one full content-addressed blob without ever allocating beyond the
 * caller's cap. Missing metadata is reported as null; every integrity mismatch
 * fails closed.
 */
export async function collectBoundedEvidenceBytes(
  input: BoundedEvidenceReadInput,
): Promise<Uint8Array | null> {
  assertSafeNonNegativeInteger(input.expectedLength, "expectedLength");
  assertSafeNonNegativeInteger(input.maxBytes, "maxBytes");
  throwIfAborted(input.signal);
  if (input.expectedLength > input.maxBytes) throw fail();

  const meta = await input.evidence.head(input.hash, input.signal);
  if (!meta) return null;
  if (meta.hash !== input.hash || meta.byteLength !== input.expectedLength) throw fail();
  if (meta.byteLength > input.maxBytes) throw fail();

  throwIfAborted(input.signal);
  const handle = await input.evidence.openRead(input.hash, undefined, input.signal);
  if (
    handle.meta.hash !== input.hash
    || handle.meta.byteLength !== input.expectedLength
    || handle.meta.byteLength > input.maxBytes
    || handle.range !== null
    || handle.byteLength !== input.expectedLength
    || handle.byteLength > input.maxBytes
  ) {
    throw fail();
  }

  const iterator = await openIterator(handle);
  const hasher = createHash("sha256");
  const output = new Uint8Array(input.expectedLength);
  let received = 0;
  try {
    for (;;) {
      const next = await nextWithAbort(iterator, input.signal);
      if (next.done) break;
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array)) throw fail();
      if (chunk.byteLength === 0) continue;
      if (
        chunk.byteLength > input.expectedLength - received
        || chunk.byteLength > input.maxBytes - received
      ) {
        throw fail();
      }
      output.set(chunk, received);
      hasher.update(output.subarray(received, received + chunk.byteLength));
      received += chunk.byteLength;
    }
  } catch (error) {
    releaseIterator(iterator);
    throw error;
  }

  const digest = hasher.digest("hex");
  if (received !== input.expectedLength || digest !== input.hash) {
    releaseIterator(iterator);
    throw fail();
  }
  try {
    throwIfAborted(input.signal);
  } catch (error) {
    releaseIterator(iterator);
    throw error;
  }
  return output;
}
