import { describe, expect, it, vi } from "vitest";
import {
  BoundedEvidenceReadError,
  collectBoundedEvidenceBytes,
} from "./bounded-read.js";
import { sha256Hex, type EvidenceReadHandle, type EvidenceStore } from "./store.js";

const BYTES = new TextEncoder().encode("bounded evidence");
const HASH = sha256Hex(BYTES);

function handle(
  source: AsyncIterable<Uint8Array>,
  overrides: Partial<EvidenceReadHandle> = {},
): EvidenceReadHandle {
  return {
    meta: { hash: HASH, byteLength: BYTES.byteLength, contentType: null },
    range: null,
    byteLength: BYTES.byteLength,
    bytes: () => source,
    ...overrides,
  };
}

function storeFor(read: EvidenceReadHandle, head = read.meta) {
  const calls = { get: 0, head: 0, openRead: 0 };
  const evidence = {
    get: async () => {
      calls.get += 1;
      throw new Error("bounded paths must not call get");
    },
    head: async () => {
      calls.head += 1;
      return head;
    },
    openRead: async () => {
      calls.openRead += 1;
      return read;
    },
  } as unknown as EvidenceStore;
  return { evidence, calls };
}

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield value;
}

describe("collectBoundedEvidenceBytes", () => {
  it("returns exact bytes without calling get or hostile return on success", async () => {
    const returnSpy = vi.fn(() => new Promise<IteratorResult<Uint8Array>>(() => undefined));
    let index = 0;
    const source = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => {
        if (index++ === 0) return { done: false as const, value: BYTES.subarray(0, 7) };
        if (index++ === 2) return { done: false as const, value: BYTES.subarray(7) };
        return { done: true as const, value: undefined };
      },
      return: returnSpy,
    };
    const { evidence, calls } = storeFor(handle(source));

    await expect(collectBoundedEvidenceBytes({
      evidence,
      hash: HASH,
      expectedLength: BYTES.byteLength,
      maxBytes: BYTES.byteLength,
    })).resolves.toEqual(BYTES);
    expect(calls).toEqual({ get: 0, head: 1, openRead: 1 });
    expect(returnSpy).not.toHaveBeenCalled();
  });

  it("returns null for missing metadata without opening a body", async () => {
    const { evidence, calls } = storeFor(handle(chunks(BYTES)), null);
    await expect(collectBoundedEvidenceBytes({
      evidence,
      hash: HASH,
      expectedLength: BYTES.byteLength,
      maxBytes: BYTES.byteLength,
    })).resolves.toBeNull();
    expect(calls).toEqual({ get: 0, head: 1, openRead: 0 });
  });

  it("rejects unsafe and over-cap catalog lengths before any storage call", async () => {
    const { evidence, calls } = storeFor(handle(chunks(BYTES)));
    await expect(collectBoundedEvidenceBytes({
      evidence,
      hash: HASH,
      expectedLength: BYTES.byteLength,
      maxBytes: BYTES.byteLength - 1,
    })).rejects.toBeInstanceOf(BoundedEvidenceReadError);
    await expect(collectBoundedEvidenceBytes({
      evidence,
      hash: HASH,
      expectedLength: Number.MAX_SAFE_INTEGER + 1,
      maxBytes: Number.MAX_SAFE_INTEGER,
    })).rejects.toBeInstanceOf(BoundedEvidenceReadError);
    expect(calls).toEqual({ get: 0, head: 0, openRead: 0 });
  });

  it("rejects head hash or length mismatches before opening", async () => {
    const other = sha256Hex(new Uint8Array([1]));
    for (const meta of [
      { hash: other, byteLength: BYTES.byteLength, contentType: null },
      { hash: HASH, byteLength: BYTES.byteLength - 1, contentType: null },
    ]) {
      const { evidence, calls } = storeFor(handle(chunks(BYTES)), meta);
      await expect(collectBoundedEvidenceBytes({
        evidence,
        hash: HASH,
        expectedLength: BYTES.byteLength,
        maxBytes: BYTES.byteLength,
      })).rejects.toBeInstanceOf(BoundedEvidenceReadError);
      expect(calls.openRead).toBe(0);
    }
  });

  it("rejects handle hash, length, and non-full-range mismatches", async () => {
    const other = sha256Hex(new Uint8Array([2]));
    const variants: EvidenceReadHandle[] = [
      handle(chunks(BYTES), {
        meta: { hash: other, byteLength: BYTES.byteLength, contentType: null },
      }),
      handle(chunks(BYTES), { byteLength: BYTES.byteLength - 1 }),
      handle(chunks(BYTES), { range: { start: 0, end: BYTES.byteLength - 1 } }),
    ];
    for (const read of variants) {
      const { evidence } = storeFor(read, {
        hash: HASH,
        byteLength: BYTES.byteLength,
        contentType: null,
      });
      await expect(collectBoundedEvidenceBytes({
        evidence,
        hash: HASH,
        expectedLength: BYTES.byteLength,
        maxBytes: BYTES.byteLength,
      })).rejects.toBeInstanceOf(BoundedEvidenceReadError);
    }
  });

  it("rejects short, long, and same-length hash-mismatched bodies", async () => {
    const bodies = [
      BYTES.subarray(0, BYTES.byteLength - 1),
      new Uint8Array(BYTES.byteLength + 1),
      new Uint8Array(BYTES.byteLength).fill(0x61),
    ];
    for (const body of bodies) {
      const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
      let sent = false;
      const source = {
        [Symbol.asyncIterator]() { return this; },
        next: async () => sent
          ? { done: true as const, value: undefined }
          : (sent = true, { done: false as const, value: body }),
        return: returned,
      };
      const { evidence } = storeFor(handle(source));
      await expect(collectBoundedEvidenceBytes({
        evidence,
        hash: HASH,
        expectedLength: BYTES.byteLength,
        maxBytes: BYTES.byteLength,
      })).rejects.toBeInstanceOf(BoundedEvidenceReadError);
      expect(returned).toHaveBeenCalledOnce();
    }
  });

  it("aborts a stalled next promptly without awaiting hostile return", async () => {
    const controller = new AbortController();
    const returned = vi.fn(() => new Promise<IteratorResult<Uint8Array>>(() => undefined));
    let markNextStarted!: () => void;
    const nextStarted = new Promise<void>((resolve) => { markNextStarted = resolve; });
    const source = {
      [Symbol.asyncIterator]() { return this; },
      next: () => {
        markNextStarted();
        return new Promise<IteratorResult<Uint8Array>>(() => undefined);
      },
      return: returned,
    };
    const { evidence } = storeFor(handle(source));
    const read = collectBoundedEvidenceBytes({
      evidence,
      hash: HASH,
      expectedLength: BYTES.byteLength,
      maxBytes: BYTES.byteLength,
      signal: controller.signal,
    });
    await nextStarted;
    controller.abort(new Error("stop now"));
    await expect(Promise.race([
      read,
      new Promise((_, reject) => setTimeout(() => reject(new Error("abort hung")), 250)),
    ])).rejects.toThrow("stop now");
    expect(returned).toHaveBeenCalledOnce();
  });

  it("does not await hostile return when a chunk overflows", async () => {
    const returned = vi.fn(() => new Promise<IteratorResult<Uint8Array>>(() => undefined));
    const source = {
      [Symbol.asyncIterator]() { return this; },
      next: async () => ({ done: false as const, value: new Uint8Array(BYTES.byteLength + 1) }),
      return: returned,
    };
    const { evidence } = storeFor(handle(source));
    await expect(Promise.race([
      collectBoundedEvidenceBytes({
        evidence,
        hash: HASH,
        expectedLength: BYTES.byteLength,
        maxBytes: BYTES.byteLength,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("overflow hung")), 250)),
    ])).rejects.toBeInstanceOf(BoundedEvidenceReadError);
    expect(returned).toHaveBeenCalledOnce();
  });
});
