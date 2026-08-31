import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContentHash } from "@cd-collab/contracts";
import {
  FilesystemEvidenceStore,
  corruptBlobForTest,
  sha256Hex,
} from "./store.js";

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-evidence-stream-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function collectChunks(
  source: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    parts.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function listScratchEntries(root: string): Promise<string[]> {
  try {
    return (await readdir(join(root, ".stream-staging"))).sort();
  } catch {
    return [];
  }
}

async function listPendingEntries(root: string): Promise<string[]> {
  try {
    return (await readdir(join(root, ".pending")))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

async function* asAsyncChunks(
  chunks: readonly Uint8Array[],
): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function createLeaseTracker(): {
  acquires: number;
  releases: number;
  held: number;
  acquireWriteLease: () => Promise<() => void | Promise<void>>;
} {
  const tracker = {
    acquires: 0,
    releases: 0,
    held: 0,
    acquireWriteLease: async () => {
      tracker.acquires += 1;
      tracker.held += 1;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        tracker.releases += 1;
        tracker.held -= 1;
      };
    },
  };
  return tracker;
}

describe("FilesystemEvidenceStore stageStream/openRead", () => {
  it("stages multi-chunk bytes with exact meta, stays invisible until promote, then reads fully", async () => {
    await withTempRoot(async (root) => {
      const store = new FilesystemEvidenceStore({ rootDir: root });
      const chunks = [
        new TextEncoder().encode("alpha|"),
        new TextEncoder().encode("bravo|"),
        new TextEncoder().encode("charlie"),
      ];
      const bytes = concatBytes(chunks);
      const stage = await store.stageStream(asAsyncChunks(chunks), {
        maxBytes: bytes.byteLength,
        expectedLength: bytes.byteLength,
        contentType: "text/plain",
      });

      expect(stage.meta.hash).toBe(sha256Hex(bytes));
      expect(stage.meta.byteLength).toBe(bytes.byteLength);
      expect(stage.meta.contentType).toBe("text/plain");
      expect(Object.isFrozen(stage.meta)).toBe(true);
      expect(await store.head(stage.meta.hash)).toBeNull();
      expect(await listScratchEntries(root)).not.toEqual([]);

      await stage.promote();
      expect(await store.head(stage.meta.hash)).toEqual(stage.meta);

      const handle = await store.openRead(stage.meta.hash);
      expect(handle.range).toBeNull();
      expect(handle.byteLength).toBe(bytes.byteLength);
      expect(handle.meta).toEqual(stage.meta);
      const read = await collectChunks(handle.bytes());
      expect(Buffer.from(read).equals(Buffer.from(bytes))).toBe(true);

      await stage.finalize();
      expect(await listScratchEntries(root)).toEqual([]);
      expect(await listPendingEntries(root)).toEqual([]);
    });
  });

  it("acquires the injected write lease only on promote and releases it on finalize", async () => {
    await withTempRoot(async (root) => {
      const lease = createLeaseTracker();
      const store = new FilesystemEvidenceStore({
        rootDir: root,
        acquireWriteLease: lease.acquireWriteLease,
      });

      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let sawMidStream!: () => void;
      const midStream = new Promise<void>((resolve) => {
        sawMidStream = resolve;
      });

      async function* delayedSource(): AsyncIterable<Uint8Array> {
        yield new TextEncoder().encode("lease-one|");
        sawMidStream();
        await gate;
        yield new TextEncoder().encode("lease-two");
      }

      const staging = store.stageStream(delayedSource(), {
        maxBytes: 64,
        contentType: "application/octet-stream",
      });
      await midStream;
      expect(lease.acquires).toBe(0);
      expect(lease.held).toBe(0);
      releaseGate();

      const stage = await staging;
      expect(lease.acquires).toBe(0);
      expect(lease.held).toBe(0);

      await stage.promote();
      expect(lease.acquires).toBe(1);
      expect(lease.held).toBe(1);
      expect(lease.releases).toBe(0);

      await stage.promote();
      expect(lease.acquires).toBe(1);
      expect(lease.held).toBe(1);

      await stage.finalize();
      expect(lease.held).toBe(0);
      expect(lease.releases).toBe(1);

      await stage.finalize();
      expect(lease.acquires).toBe(1);
      expect(lease.releases).toBe(1);
      expect(lease.held).toBe(0);
      await expect(stage.promote()).rejects.toThrow(/already settled/);
    });
  });

  it("serializes rollback behind an in-flight promotion and makes promotion reject", async () => {
    await withTempRoot(async (root) => {
      let releaseAcquire!: () => void;
      const acquireGate = new Promise<void>((resolve) => {
        releaseAcquire = resolve;
      });
      let acquisitionStarted!: () => void;
      const acquisitionStart = new Promise<void>((resolve) => {
        acquisitionStarted = resolve;
      });
      let releases = 0;
      const store = new FilesystemEvidenceStore({
        rootDir: root,
        acquireWriteLease: async () => {
          acquisitionStarted();
          await acquireGate;
          return () => {
            releases += 1;
          };
        },
      });
      const bytes = new TextEncoder().encode("promote-rollback-overlap\n");
      const stage = await store.stageStream(asAsyncChunks([bytes]), {
        maxBytes: bytes.byteLength,
      });

      const promoting = stage.promote();
      await acquisitionStart;
      const rollingBack = stage.rollback();
      releaseAcquire();

      await expect(promoting).rejects.toThrow(/rollback.*in flight/);
      await rollingBack;
      expect(await store.head(stage.meta.hash)).toBeNull();
      expect(await listScratchEntries(root)).toEqual([]);
      expect(await listPendingEntries(root)).toEqual([]);
      expect(releases).toBe(1);
      await stage.rollback();
      await expect(stage.promote()).rejects.toThrow(/already settled/);
    });
  });

  it("rejects finalize while promotion is in flight without poisoning later finalize", async () => {
    await withTempRoot(async (root) => {
      let releaseAcquire!: () => void;
      const acquireGate = new Promise<void>((resolve) => {
        releaseAcquire = resolve;
      });
      let acquisitionStarted!: () => void;
      const acquisitionStart = new Promise<void>((resolve) => {
        acquisitionStarted = resolve;
      });
      let releases = 0;
      const store = new FilesystemEvidenceStore({
        rootDir: root,
        acquireWriteLease: async () => {
          acquisitionStarted();
          await acquireGate;
          return () => {
            releases += 1;
          };
        },
      });
      const bytes = new TextEncoder().encode("promote-finalize-overlap\n");
      const stage = await store.stageStream(asAsyncChunks([bytes]), {
        maxBytes: bytes.byteLength,
      });

      const promoting = stage.promote();
      await acquisitionStart;
      await expect(stage.finalize()).rejects.toThrow(/must complete before finalize/);
      releaseAcquire();
      await promoting;
      await stage.finalize();

      expect(await store.head(stage.meta.hash)).toEqual(stage.meta);
      expect(await listPendingEntries(root)).toEqual([]);
      expect(releases).toBe(1);
    });
  });

  it("rollback before promote clears opaque stream staging and stays idempotent", async () => {
    await withTempRoot(async (root) => {
      const store = new FilesystemEvidenceStore({ rootDir: root });
      const bytes = new TextEncoder().encode("rollback-before-promote\n");
      const stage = await store.stageStream(asAsyncChunks([bytes]), {
        maxBytes: bytes.byteLength,
      });
      expect(await listScratchEntries(root)).not.toEqual([]);
      expect(await store.head(stage.meta.hash)).toBeNull();

      await stage.rollback();
      expect(await listScratchEntries(root)).toEqual([]);
      await expect(stage.promote()).rejects.toThrow(/already settled/);
      expect(await store.head(stage.meta.hash)).toBeNull();

      await stage.rollback();
      expect(await listScratchEntries(root)).toEqual([]);
    });
  });

  it("rejects a conflicting settlement mode while keeping the winner idempotent", async () => {
    await withTempRoot(async (root) => {
      const store = new FilesystemEvidenceStore({ rootDir: root });
      const bytes = new TextEncoder().encode("settlement-mode");
      const stage = await store.stageStream(asAsyncChunks([bytes]), {
        maxBytes: bytes.byteLength,
      });
      const rollback = stage.rollback();
      await expect(stage.finalize()).rejects.toThrow(/settling via rollback/);
      await rollback;
      await stage.rollback();
      expect(await listScratchEntries(root)).toEqual([]);
    });
  });

  it("rollback after promote removes only this stage's content, journal, and lease", async () => {
    await withTempRoot(async (root) => {
      const lease = createLeaseTracker();
      const store = new FilesystemEvidenceStore({
        rootDir: root,
        acquireWriteLease: lease.acquireWriteLease,
      });
      const kept = new TextEncoder().encode("preexisting-kept-bytes\n");
      const keptMeta = await store.put(kept, { contentType: "text/plain" });

      const bytes = new TextEncoder().encode("rollback-after-promote\n");
      const stage = await store.stageStream(asAsyncChunks([bytes]), {
        maxBytes: bytes.byteLength,
        contentType: "text/plain",
      });
      await stage.promote();
      expect(await listPendingEntries(root)).toHaveLength(1);
      expect(lease.held).toBe(1);
      expect(await store.verify(stage.meta.hash)).toBe(true);

      await stage.rollback();
      expect(await store.head(stage.meta.hash)).toBeNull();
      expect(await listPendingEntries(root)).toEqual([]);
      expect(await listScratchEntries(root)).toEqual([]);
      expect(lease.held).toBe(0);
      expect(await store.verify(keptMeta.hash)).toBe(true);

      await stage.rollback();
      expect(await store.head(stage.meta.hash)).toBeNull();
      expect(lease.held).toBe(0);
      expect(await store.verify(keptMeta.hash)).toBe(true);
    });
  });

  it("retains the lease when rollback cleanup fails and releases only after a safe retry", async () => {
    await withTempRoot(async (root) => {
      const lease = createLeaseTracker();
      const store = new FilesystemEvidenceStore({
        rootDir: root,
        acquireWriteLease: lease.acquireWriteLease,
      });
      const bytes = new TextEncoder().encode("retry-failed-rollback-cleanup\n");
      const stage = await store.stageStream(asAsyncChunks([bytes]), {
        maxBytes: bytes.byteLength,
      });
      const scratchBlobName = (await listScratchEntries(root)).find(
        (name) => !name.endsWith(".meta.json"),
      );
      expect(scratchBlobName).toBeDefined();

      await stage.promote();
      const blockingScratch = join(root, ".stream-staging", scratchBlobName!);
      await mkdir(blockingScratch);
      await expect(stage.rollback()).rejects.toThrow();

      expect(lease.held).toBe(1);
      expect(lease.releases).toBe(0);
      expect(await store.head(stage.meta.hash)).toEqual(stage.meta);

      await rm(blockingScratch, { recursive: true, force: true });
      await stage.rollback();
      expect(lease.held).toBe(0);
      expect(lease.releases).toBe(1);
      expect(await store.head(stage.meta.hash)).toBeNull();
      expect(await listPendingEntries(root)).toEqual([]);
    });
  });

  it("rejects conflicting finalize journal options instead of silently joining", async () => {
    await withTempRoot(async (root) => {
      const store = new FilesystemEvidenceStore({ rootDir: root });
      const bytes = new TextEncoder().encode("finalize-option-conflict\n");
      const stage = await store.stageStream(asAsyncChunks([bytes]), {
        maxBytes: bytes.byteLength,
      });
      await stage.promote();

      const retaining = stage.finalize({ retainPendingJournal: true });
      await expect(stage.finalize()).rejects.toThrow(/options conflict/);
      await retaining;
      await stage.finalize({ retainPendingJournal: true });
      await expect(stage.finalize()).rejects.toThrow(/options conflict/);
      expect(await listPendingEntries(root)).toHaveLength(1);
    });
  });

  it("lets a preexisting duplicate survive streamed promote+rollback", async () => {
    await withTempRoot(async (root) => {
      const lease = createLeaseTracker();
      const store = new FilesystemEvidenceStore({
        rootDir: root,
        acquireWriteLease: lease.acquireWriteLease,
      });
      const bytes = new TextEncoder().encode("shared-stream-duplicate\n");
      const first = await store.put(bytes, { contentType: "text/plain" });
      expect(lease.held).toBe(0);
      const stage = await store.stageStream(asAsyncChunks([bytes]), {
        maxBytes: bytes.byteLength,
        contentType: "text/x-log",
      });
      expect(stage.meta.hash).toBe(first.hash);

      await stage.promote();
      expect(await store.verify(first.hash)).toBe(true);
      expect(await listPendingEntries(root)).toEqual([]);
      expect(lease.held).toBe(1);

      await stage.rollback();
      expect(await store.verify(first.hash)).toBe(true);
      expect(await listScratchEntries(root)).toEqual([]);
      expect(lease.held).toBe(0);
      await stage.rollback();
    });
  });

  it("fails promote for a corrupt duplicate without overwriting it", async () => {
    await withTempRoot(async (root) => {
      const store = new FilesystemEvidenceStore({ rootDir: root });
      const bytes = new TextEncoder().encode("corrupt-duplicate-original");
      const meta = await store.put(bytes, { contentType: "text/plain" });
      const mutated = new TextEncoder().encode("corrupt-duplicate-MUTATED!");
      expect(mutated.byteLength).toBe(bytes.byteLength);
      await corruptBlobForTest(store, meta.hash, mutated);
      const before = await store.get(meta.hash);

      const stage = await store.stageStream(asAsyncChunks([bytes]), {
        maxBytes: bytes.byteLength,
        contentType: "text/plain",
      });
      await expect(stage.promote()).rejects.toThrow(/verification|corrupt|changed|mismatch|size/i);

      const after = await store.get(meta.hash);
      expect(after).not.toBeNull();
      expect(Buffer.from(after ?? []).equals(Buffer.from(mutated))).toBe(true);
      expect(Buffer.from(before ?? []).equals(Buffer.from(after ?? []))).toBe(true);

      await stage.rollback();
      expect(await listScratchEntries(root)).toEqual([]);
    });
  });

  it("rehashes opaque scratch under the promotion lock before publishing", async () => {
    await withTempRoot(async (root) => {
      const store = new FilesystemEvidenceStore({ rootDir: root });
      const bytes = new TextEncoder().encode("scratch-integrity-before-promote");
      const stage = await store.stageStream(asAsyncChunks([bytes]), {
        maxBytes: bytes.byteLength,
      });
      const scratchBlob = (await listScratchEntries(root)).find(
        (name) => !name.includes(".meta.json"),
      );
      expect(scratchBlob).toBeDefined();
      const mutated = Uint8Array.from(bytes, (value) => value ^ 0xff);
      await writeFile(join(root, ".stream-staging", scratchBlob ?? ""), mutated);

      await expect(stage.promote()).rejects.toThrow(/verification/);
      expect(await store.head(stage.meta.hash)).toBeNull();
      expect(await listPendingEntries(root)).toEqual([]);
      await stage.rollback();
      expect(await listScratchEntries(root)).toEqual([]);
    });
  });

  it("rejects abort before and while awaiting the next source chunk and cleans scratch", async () => {
    await withTempRoot(async (root) => {
      const store = new FilesystemEvidenceStore({ rootDir: root });

      const before = new AbortController();
      before.abort(new Error("already-aborted"));
      await expect(
        store.stageStream(asAsyncChunks([new Uint8Array([1])]), {
          maxBytes: 8,
          signal: before.signal,
        }),
      ).rejects.toThrow(/already-aborted/);
      expect(await listScratchEntries(root)).toEqual([]);

      const pending = new AbortController();
      let enterWait!: () => void;
      const enteredWait = new Promise<void>((resolve) => {
        enterWait = resolve;
      });
      async function* hanging(): AsyncIterable<Uint8Array> {
        yield new Uint8Array([9, 9, 9]);
        enterWait();
        await new Promise<never>(() => {
          // Intentionally pending until abort races iterator.next().
        });
      }

      const staging = store.stageStream(hanging(), {
        maxBytes: 64,
        signal: pending.signal,
      });
      await enteredWait;
      pending.abort(new Error("pending-abort"));
      await expect(
        Promise.race([
          staging,
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error("abort did not reject promptly")),
              100,
            );
          }),
        ]),
      ).rejects.toThrow(/pending-abort/);
      expect(await listScratchEntries(root)).toEqual([]);
    });
  });

  it("cleans scratch for maxBytes, expectedLength, non-Uint8Array, and invalid bounds/contentType", async () => {
    await withTempRoot(async (root) => {
      const store = new FilesystemEvidenceStore({ rootDir: root });

      await expect(
        store.stageStream(asAsyncChunks([new Uint8Array(8)]), { maxBytes: 4 }),
      ).rejects.toThrow(/maxBytes/);
      expect(await listScratchEntries(root)).toEqual([]);

      await expect(
        store.stageStream(asAsyncChunks([new Uint8Array(3)]), {
          maxBytes: 16,
          expectedLength: 5,
        }),
      ).rejects.toThrow(/expectedLength/);
      expect(await listScratchEntries(root)).toEqual([]);

      await expect(
        store.stageStream(asAsyncChunks([new Uint8Array(3)]), {
          maxBytes: 2,
          expectedLength: 3,
        }),
      ).rejects.toThrow(/expectedLength.*maxBytes/);
      expect(await listScratchEntries(root)).toEqual([]);

      await expect(
        store.stageStream(asAsyncChunks([new Uint8Array(0)]), { maxBytes: 0 }),
      ).rejects.toThrow(/must not be empty/);
      expect(await listScratchEntries(root)).toEqual([]);

      async function* badChunk(): AsyncIterable<Uint8Array> {
        yield "not-bytes" as unknown as Uint8Array;
      }
      await expect(
        store.stageStream(badChunk(), { maxBytes: 16 }),
      ).rejects.toThrow(/Uint8Array/);
      expect(await listScratchEntries(root)).toEqual([]);

      await expect(
        store.stageStream(asAsyncChunks([new Uint8Array([1])]), {
          maxBytes: -1,
        }),
      ).rejects.toThrow(/maxBytes/);
      expect(await listScratchEntries(root)).toEqual([]);

      await expect(
        store.stageStream(asAsyncChunks([new Uint8Array([1])]), {
          maxBytes: 1.5,
        }),
      ).rejects.toThrow(/maxBytes/);
      expect(await listScratchEntries(root)).toEqual([]);

      await expect(
        store.stageStream(asAsyncChunks([new Uint8Array([1])]), {
          maxBytes: 8,
          contentType: 123 as unknown as string,
        }),
      ).rejects.toThrow(/contentType/);
      expect(await listScratchEntries(root)).toEqual([]);
    });
  });

  it("cleans scratch when a hostile iterator return throws synchronously", async () => {
    await withTempRoot(async (root) => {
      const store = new FilesystemEvidenceStore({ rootDir: root });
      const source: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          let yielded = false;
          return {
            next: async () => {
              if (!yielded) {
                yielded = true;
                return { done: false, value: new Uint8Array(4) };
              }
              return new Promise<IteratorResult<Uint8Array>>(() => undefined);
            },
            return: () => {
              throw new Error("hostile-return");
            },
          };
        },
      };
      const controller = new AbortController();
      const staging = store.stageStream(source, {
        maxBytes: 8,
        signal: controller.signal,
      });
      while ((await listScratchEntries(root)).length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      controller.abort(new Error("abort-hostile-source"));
      await expect(staging).rejects.toThrow(/abort-hostile-source/);
      expect(await listScratchEntries(root)).toEqual([]);
    });
  });

  it("cleans scratch when iterator construction or next throws synchronously", async () => {
    await withTempRoot(async (root) => {
      const store = new FilesystemEvidenceStore({ rootDir: root });
      const constructionFailure: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          throw new Error("iterator-construction-failed");
        },
      };
      await expect(
        store.stageStream(constructionFailure, { maxBytes: 8 }),
      ).rejects.toThrow(/iterator-construction-failed/);
      expect(await listScratchEntries(root)).toEqual([]);

      const nextFailure: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
          return {
            next: () => {
              throw new Error("iterator-next-failed");
            },
          };
        },
      };
      await expect(
        store.stageStream(nextFailure, { maxBytes: 8 }),
      ).rejects.toThrow(/iterator-next-failed/);
      expect(await listScratchEntries(root)).toEqual([]);
    });
  });

  it("reclaims stale local scratch without deleting a live lock-free stream", async () => {
    await withTempRoot(async (root) => {
      const store = new FilesystemEvidenceStore({ rootDir: root });
      const scratchDir = join(root, ".stream-staging");
      await mkdir(scratchDir, { recursive: true });
      const staleId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      await writeFile(join(scratchDir, staleId), new Uint8Array([1]));
      await writeFile(join(scratchDir, `${staleId}.meta.json`), "{}");

      let continueSource!: () => void;
      let sourceWaiting!: () => void;
      const waiting = new Promise<void>((resolve) => {
        sourceWaiting = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        continueSource = resolve;
      });
      async function* liveSource(): AsyncIterable<Uint8Array> {
        yield new Uint8Array([2]);
        sourceWaiting();
        await gate;
        yield new Uint8Array([3]);
      }
      const staging = store.stageStream(liveSource(), { maxBytes: 2 });
      await waiting;

      await store.recoverUnreferencedWrites(new Set());
      const duringRecovery = await listScratchEntries(root);
      expect(duringRecovery).not.toContain(staleId);
      expect(duringRecovery).not.toContain(`${staleId}.meta.json`);
      expect(duringRecovery).toHaveLength(1);

      continueSource();
      const stage = await staging;
      expect(await listScratchEntries(root)).toHaveLength(2);
      await stage.rollback();
      expect(await listScratchEntries(root)).toEqual([]);
    });
  });

  it("accepts a zero-byte stream and rejects an explicit range on it", async () => {
    await withTempRoot(async (root) => {
      const store = new FilesystemEvidenceStore({ rootDir: root });
      async function* empty(): AsyncIterable<Uint8Array> {
        // no chunks
      }

      const stage = await store.stageStream(empty(), { maxBytes: 0 });
      expect(stage.meta.hash).toBe(sha256Hex(new Uint8Array()));
      expect(stage.meta.byteLength).toBe(0);
      expect(stage.meta.contentType).toBeNull();

      await stage.promote();
      const handle = await store.openRead(stage.meta.hash);
      expect(handle.range).toBeNull();
      expect(handle.byteLength).toBe(0);
      expect(handle.meta).toEqual(stage.meta);
      expect(await collectChunks(handle.bytes())).toEqual(new Uint8Array());

      await expect(
        store.openRead(stage.meta.hash, { start: 0, end: 0 }),
      ).rejects.toThrow(/out of bounds/);

      await stage.finalize();
    });
  });

  it("openRead returns exact bytes for full and inclusive first/middle/tail ranges", async () => {
    await withTempRoot(async (root) => {
      const store = new FilesystemEvidenceStore({ rootDir: root });
      const bytes = new TextEncoder().encode("0123456789");
      const stage = await store.stageStream(asAsyncChunks([bytes]), {
        maxBytes: bytes.byteLength,
        contentType: "text/plain",
      });
      await stage.promote();

      const full = await store.openRead(stage.meta.hash);
      expect(full.range).toBeNull();
      expect(full.byteLength).toBe(10);
      expect(full.meta).toEqual(stage.meta);
      expect(Object.isFrozen(full.meta)).toBe(true);
      expect(Buffer.from(await collectChunks(full.bytes())).equals(Buffer.from(bytes))).toBe(true);

      const first = await store.openRead(stage.meta.hash, { start: 0, end: 2 });
      expect(first.range).toEqual({ start: 0, end: 2 });
      expect(Object.isFrozen(first.range)).toBe(true);
      expect(first.byteLength).toBe(3);
      expect(first.meta).toEqual(stage.meta);
      expect(Buffer.from(await collectChunks(first.bytes())).toString()).toBe("012");

      const middle = await store.openRead(stage.meta.hash, { start: 3, end: 6 });
      expect(middle.range).toEqual({ start: 3, end: 6 });
      expect(middle.byteLength).toBe(4);
      expect(middle.meta).toEqual(stage.meta);
      expect(Buffer.from(await collectChunks(middle.bytes())).toString()).toBe("3456");

      const tail = await store.openRead(stage.meta.hash, { start: 7, end: 9 });
      expect(tail.range).toEqual({ start: 7, end: 9 });
      expect(tail.byteLength).toBe(3);
      expect(tail.meta).toEqual(stage.meta);
      expect(Buffer.from(await collectChunks(tail.bytes())).toString()).toBe("789");

      await stage.finalize();
    });
  });

  it("rejects invalid hashes and negative/fractional/reversed/overflow/unsatisfiable ranges", async () => {
    await withTempRoot(async (root) => {
      const store = new FilesystemEvidenceStore({ rootDir: root });
      const bytes = new TextEncoder().encode("range-rejection-fixture");
      const stage = await store.stageStream(asAsyncChunks([bytes]), {
        maxBytes: bytes.byteLength,
      });
      await stage.promote();

      await expect(
        store.openRead("not-a-content-hash" as ContentHash),
      ).rejects.toThrow(/invalid content hash/);

      await expect(
        store.openRead(stage.meta.hash, { start: -1, end: 1 }),
      ).rejects.toThrow(/range\.start/);
      await expect(
        store.openRead(stage.meta.hash, { start: 1.5, end: 2 }),
      ).rejects.toThrow(/range\.start/);
      await expect(
        store.openRead(stage.meta.hash, {
          start: 0,
          end: Number.MAX_SAFE_INTEGER + 1,
        }),
      ).rejects.toThrow(/range\.end/);
      await expect(
        store.openRead(stage.meta.hash, { start: 2, end: 1 }),
      ).rejects.toThrow(/range\.end must be greater than or equal to range\.start/);
      await expect(
        store.openRead(stage.meta.hash, {
          start: 0,
          end: bytes.byteLength,
        }),
      ).rejects.toThrow(/out of bounds/);
      await expect(
        store.openRead(stage.meta.hash, {
          start: bytes.byteLength,
          end: bytes.byteLength,
        }),
      ).rejects.toThrow(/out of bounds/);
      await expect(
        store.openRead(stage.meta.hash, {
          start: bytes.byteLength + 1,
          end: bytes.byteLength + 2,
        }),
      ).rejects.toThrow(/out of bounds/);

      await stage.finalize();
    });
  });

  it("detects corruption before openRead and same-size mutation after handle creation and during full iteration", async () => {
    await withTempRoot(async (root) => {
      const store = new FilesystemEvidenceStore({ rootDir: root });

      const small = new TextEncoder().encode("pre-open-corruption-bytes");
      const smallStage = await store.stageStream(asAsyncChunks([small]), {
        maxBytes: small.byteLength,
      });
      await smallStage.promote();
      const smallMutation = Uint8Array.from(small, (value) => value ^ 0xff);
      await corruptBlobForTest(
        store,
        smallStage.meta.hash,
        smallMutation,
      );
      await expect(store.openRead(smallStage.meta.hash)).rejects.toThrow(
        /verification|corrupt|changed|mismatch|size/i,
      );
      await smallStage.finalize();

      const afterCreate = new TextEncoder().encode("after-handle-mutation!!!!");
      const afterStage = await store.stageStream(asAsyncChunks([afterCreate]), {
        maxBytes: afterCreate.byteLength,
      });
      await afterStage.promote();
      const afterHandle = await store.openRead(afterStage.meta.hash);
      const afterMutated = new TextEncoder().encode("after-handle-MUTATED!!!!!");
      expect(afterMutated.byteLength).toBe(afterCreate.byteLength);
      await corruptBlobForTest(store, afterStage.meta.hash, afterMutated);
      await expect(collectChunks(afterHandle.bytes())).rejects.toThrow(
        /verification|changed|mismatch|size/i,
      );
      await afterStage.finalize();

      const size = 70 * 1024;
      const large = new Uint8Array(size);
      large.fill(7);
      const largeStage = await store.stageStream(asAsyncChunks([large]), {
        maxBytes: size,
      });
      await largeStage.promote();
      const largeHandle = await store.openRead(largeStage.meta.hash);
      const iterator = largeHandle.bytes()[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect((first.value as Uint8Array).byteLength).toBeGreaterThan(0);

      const mutatedLarge = new Uint8Array(size);
      mutatedLarge.fill(8);
      await corruptBlobForTest(store, largeStage.meta.hash, mutatedLarge);
      await expect(
        (async () => {
          for (;;) {
            const step = await iterator.next();
            if (step.done) return;
          }
        })(),
      ).rejects.toThrow(/changed|verification|mismatch|size|truncated/i);

      await largeStage.finalize();

      const rangedBytes = new Uint8Array(size);
      rangedBytes.fill(9);
      const rangedStage = await store.stageStream(asAsyncChunks([rangedBytes]), {
        maxBytes: size,
      });
      await rangedStage.promote();
      const rangedHandle = await store.openRead(rangedStage.meta.hash, {
        start: 1_024,
        end: size - 1_025,
      });
      const rangedIterator = rangedHandle.bytes()[Symbol.asyncIterator]();
      expect((await rangedIterator.next()).done).toBe(false);
      const rangedMutation = new Uint8Array(size);
      rangedMutation.fill(10);
      await corruptBlobForTest(store, rangedStage.meta.hash, rangedMutation);
      await expect(
        (async () => {
          while (!(await rangedIterator.next()).done) {
            // Drain until the post-range whole-file verification rejects.
          }
        })(),
      ).rejects.toThrow(/changed|verification|mismatch|size|truncated/i);
      await rangedStage.finalize();

      const earlyBytes = new Uint8Array(size);
      earlyBytes.fill(11);
      const earlyStage = await store.stageStream(asAsyncChunks([earlyBytes]), {
        maxBytes: size,
      });
      await earlyStage.promote();
      const earlyIterator = (await store.openRead(earlyStage.meta.hash))
        .bytes()[Symbol.asyncIterator]();
      expect((await earlyIterator.next()).done).toBe(false);
      const earlyMutation = new Uint8Array(size);
      earlyMutation.fill(12);
      await corruptBlobForTest(store, earlyStage.meta.hash, earlyMutation);
      expect(earlyIterator.return).toBeDefined();
      await expect(earlyIterator.return?.()).rejects.toThrow(
        /changed|verification|mismatch|size|truncated/i,
      );
      await earlyStage.finalize();
    });
  });

  it("writes a pending journal on promote; finalize and retained recovery behave correctly", async () => {
    await withTempRoot(async (root) => {
      const lease = createLeaseTracker();
      const store = new FilesystemEvidenceStore({
        rootDir: root,
        acquireWriteLease: lease.acquireWriteLease,
      });

      const firstBytes = new TextEncoder().encode("journal-finalize-delete\n");
      const first = await store.stageStream(asAsyncChunks([firstBytes]), {
        maxBytes: firstBytes.byteLength,
      });
      await first.promote();
      expect(await listPendingEntries(root)).toHaveLength(1);
      expect(lease.held).toBe(1);
      await first.finalize();
      expect(await listPendingEntries(root)).toEqual([]);
      expect(lease.held).toBe(0);
      expect(await store.verify(first.meta.hash)).toBe(true);

      const reclaimBytes = new TextEncoder().encode("journal-retain-reclaim\n");
      const reclaim = await store.stageStream(asAsyncChunks([reclaimBytes]), {
        maxBytes: reclaimBytes.byteLength,
      });
      await reclaim.promote();
      expect(await listPendingEntries(root)).toHaveLength(1);
      await reclaim.finalize({ retainPendingJournal: true });
      expect(await listPendingEntries(root)).toHaveLength(1);
      expect(lease.held).toBe(0);

      const reclaimed = await store.recoverUnreferencedWrites(new Set());
      expect(reclaimed.reclaimed).toEqual([reclaim.meta.hash]);
      expect(reclaimed.journals).toBe(1);
      expect(await store.head(reclaim.meta.hash)).toBeNull();
      expect(await listPendingEntries(root)).toEqual([]);

      const keepBytes = new TextEncoder().encode("journal-retain-referenced\n");
      const keep = await store.stageStream(asAsyncChunks([keepBytes]), {
        maxBytes: keepBytes.byteLength,
      });
      await keep.promote();
      await keep.finalize({ retainPendingJournal: true });
      expect(await listPendingEntries(root)).toHaveLength(1);

      const kept = await store.recoverUnreferencedWrites(new Set([keep.meta.hash]));
      expect(kept.reclaimed).toEqual([]);
      expect(await store.verify(keep.meta.hash)).toBe(true);
      expect(await listPendingEntries(root)).toEqual([]);
    });
  });
});
