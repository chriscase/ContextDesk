import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseFileServerReference } from "@cd-collab/contracts";
import {
  FilesystemEvidenceStore,
  corruptBlobForTest,
  sha256Hex,
} from "./store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

describe("FilesystemEvidenceStore", () => {
  async function withStore<T>(
    fn: (store: FilesystemEvidenceStore, root: string) => Promise<T>,
  ): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-evidence-"));
    try {
      return await fn(new FilesystemEvidenceStore({ rootDir: root }), root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  function storedPaths(root: string, hash: string): { blob: string; meta: string } {
    const directory = join(root, "blobs", hash.slice(0, 2));
    return {
      blob: join(directory, hash),
      meta: join(directory, `${hash}.meta.json`),
    };
  }

  it("round-trips bytes content-addressed", async () => {
    await withStore(async (store) => {
      const bytes = new TextEncoder().encode("synthetic-log-line\n");
      const meta = await store.put(bytes, { contentType: "text/plain" });
      expect(meta.hash).toBe(sha256Hex(bytes));
      expect(meta.byteLength).toBe(bytes.byteLength);
      const again = await store.put(bytes);
      expect(again.hash).toBe(meta.hash);
      const got = await store.get(meta.hash);
      expect(got).not.toBeNull();
      expect(Buffer.from(got ?? []).equals(Buffer.from(bytes))).toBe(true);
      const head = await store.head(meta.hash);
      expect(head?.hash).toBe(meta.hash);
      expect(await store.verify(meta.hash)).toBe(true);
    });
  });

  it("keeps staged bytes invisible and removes a committed stage on rollback", async () => {
    await withStore(async (store) => {
      const bytes = new TextEncoder().encode("staged-synthetic-line\n");
      const stage = await store.stage(bytes, { contentType: "text/plain" });
      try {
        expect(await store.head(stage.meta.hash)).toBeNull();
        await stage.commit();
        expect(await store.verify(stage.meta.hash)).toBe(true);
        await stage.rollback();
        expect(await store.head(stage.meta.hash)).toBeNull();
      } finally {
        stage.release();
      }
    });
  });

  it("does not remove pre-existing deduplicated bytes when a later stage rolls back", async () => {
    await withStore(async (store) => {
      const bytes = new TextEncoder().encode("shared-synthetic-line\n");
      const first = await store.put(bytes, { contentType: "text/plain" });
      const stage = await store.stage(bytes, { contentType: "text/x-log" });
      try {
        await stage.commit();
        await stage.rollback();
      } finally {
        stage.release();
      }
      expect(await store.verify(first.hash)).toBe(true);
    });
  });

  it("detects a mutated blob and fails closed", async () => {
    await withStore(async (store) => {
      const bytes = new TextEncoder().encode("original-bytes");
      const { hash } = await store.put(bytes);
      await corruptBlobForTest(
        store,
        hash,
        new TextEncoder().encode("mutated-bytes"),
      );
      expect(await store.verify(hash)).toBe(false);
      const got = await store.get(hash);
      expect(got).not.toBeNull();
      expect(sha256Hex(got ?? new Uint8Array())).not.toBe(hash);
    });
  });

  it("verifies canonical files incrementally without calling get", async () => {
    await withStore(async (store) => {
      const bytes = new Uint8Array(256 * 1024 + 17).fill(0x5a);
      const meta = await store.put(bytes);
      store.get = async () => {
        throw new Error("verify must not materialize through get");
      };
      expect(await store.verify(meta.hash)).toBe(true);
    });
  });

  it("fails verification for truncated, expanded, and same-length mutations", async () => {
    await withStore(async (store) => {
      const fixtures = [
        new TextEncoder().encode("truncate-fixture"),
        new TextEncoder().encode("expand-fixture"),
        new TextEncoder().encode("same-length-fixture"),
      ];
      const [truncated, expanded, sameLength] = await Promise.all(
        fixtures.map((bytes) => store.put(bytes)),
      );
      await corruptBlobForTest(store, truncated.hash, fixtures[0]!.subarray(0, 3));
      await corruptBlobForTest(
        store,
        expanded.hash,
        Uint8Array.from([...fixtures[1]!, 0x21]),
      );
      const replacement = Uint8Array.from(fixtures[2]!);
      replacement[0] = replacement[0] === 0 ? 1 : replacement[0]! - 1;
      await corruptBlobForTest(store, sameLength.hash, replacement);

      expect(await store.verify(truncated.hash)).toBe(false);
      expect(await store.verify(expanded.hash)).toBe(false);
      expect(await store.verify(sameLength.hash)).toBe(false);
    });
  });

  it("heads only strict sidecar metadata and never synthesizes it from blob bytes", async () => {
    await withStore(async (store, root) => {
      const canonical = await store.put(new TextEncoder().encode("stat-only-head"));
      const canonicalPaths = storedPaths(root, canonical.hash);
      const readFileMock = vi.mocked(readFile);
      readFileMock.mockClear();
      expect(await store.head(canonical.hash)).toEqual(canonical);
      expect(readFileMock).toHaveBeenCalledTimes(1);
      expect(readFileMock.mock.calls[0]?.[0]).toBe(canonicalPaths.meta);

      const missingBlob = await store.put(new TextEncoder().encode("missing-blob"));
      await rm(storedPaths(root, missingBlob.hash).blob);
      expect(await store.head(missingBlob.hash)).toBeNull();
      expect(await store.verify(missingBlob.hash)).toBe(false);

      const missingMeta = await store.put(new TextEncoder().encode("missing-meta"));
      await rm(storedPaths(root, missingMeta.hash).meta);
      expect(await store.head(missingMeta.hash)).toBeNull();
      expect(await store.verify(missingMeta.hash)).toBe(false);

      const malformed = await store.put(new TextEncoder().encode("malformed-meta"));
      const malformedPaths = storedPaths(root, malformed.hash);
      await writeFile(malformedPaths.meta, "{", "utf8");
      store.get = async () => {
        throw new Error("head must not fall back to get");
      };
      await expect(store.head(malformed.hash)).rejects.toThrow(/metadata is corrupt/);
      expect(await store.verify(malformed.hash)).toBe(false);
      expect(new Uint8Array(await readFile(malformedPaths.blob))).toHaveLength(
        malformed.byteLength,
      );
    });
  });

  it("fails closed for wrong sidecar hash or length and non-file blobs", async () => {
    await withStore(async (store, root) => {
      const wrongHash = await store.put(new TextEncoder().encode("wrong-hash-meta"));
      const wrongHashPaths = storedPaths(root, wrongHash.hash);
      await writeFile(
        wrongHashPaths.meta,
        JSON.stringify({ ...wrongHash, hash: "0".repeat(64) }),
        "utf8",
      );
      await expect(store.head(wrongHash.hash)).rejects.toThrow(/hash mismatch/);
      expect(await store.verify(wrongHash.hash)).toBe(false);

      const wrongLength = await store.put(new TextEncoder().encode("wrong-length-meta"));
      const wrongLengthPaths = storedPaths(root, wrongLength.hash);
      await writeFile(
        wrongLengthPaths.meta,
        JSON.stringify({ ...wrongLength, byteLength: wrongLength.byteLength + 1 }),
        "utf8",
      );
      await expect(store.head(wrongLength.hash)).rejects.toThrow(/size does not match/);
      expect(await store.verify(wrongLength.hash)).toBe(false);

      const nonFile = await store.put(new TextEncoder().encode("non-file-blob"));
      const nonFilePaths = storedPaths(root, nonFile.hash);
      await rm(nonFilePaths.blob);
      await mkdir(nonFilePaths.blob);
      await expect(store.head(nonFile.hash)).rejects.toThrow(/not a regular file/);
      expect(await store.verify(nonFile.hash)).toBe(false);
    });
  });

  it("preserves head aborts before and during sidecar reads", async () => {
    await withStore(async (store) => {
      const meta = await store.put(new TextEncoder().encode("abort-head"));
      const controller = new AbortController();
      const reason = new Error("stop-head");
      controller.abort(reason);
      await expect(store.head(meta.hash, controller.signal)).rejects.toBe(reason);
      await expect(
        store.head("0".repeat(64) as typeof meta.hash, controller.signal),
      ).rejects.toBe(reason);

      const pendingController = new AbortController();
      const pendingReason = new Error("stop-pending-head");
      const readFileMock = vi.mocked(readFile);
      readFileMock.mockClear();
      readFileMock.mockImplementationOnce(((_path: unknown, options: unknown) =>
        new Promise<never>((_resolve, reject) => {
          const signal = (options as { signal: AbortSignal }).signal;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        })) as never);
      const pendingHead = store.head(meta.hash, pendingController.signal);
      await vi.waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(1));
      pendingController.abort(pendingReason);
      await expect(pendingHead).rejects.toBe(pendingReason);
    });
  });

  it("batch verification is incremental and duplicate puts cannot mask mutation", async () => {
    await withStore(async (store, root) => {
      const batch = await store.beginWriteBatch();
      try {
        const bytes = new TextEncoder().encode("batch-duplicate-fixture");
        const first = await batch.put(bytes);
        const duplicate = await batch.put(bytes);
        expect(duplicate).toEqual(first);
        batch.get = async () => {
          throw new Error("batch verify must not materialize through get");
        };
        expect(await batch.verify(first.hash)).toBe(true);

        const stageNames = await readdir(join(root, ".staging"));
        expect(stageNames).toHaveLength(1);
        const stagedBlob = join(
          root,
          ".staging",
          stageNames[0]!,
          "blobs",
          first.hash.slice(0, 2),
          first.hash,
        );
        const mutation = Uint8Array.from(bytes);
        mutation[0] = mutation[0]! ^ 0xff;
        await writeFile(stagedBlob, mutation);
        expect(await batch.verify(first.hash)).toBe(false);
        expect(await batch.put(bytes)).toEqual(first);
        expect(await batch.verify(first.hash)).toBe(false);
      } finally {
        await batch.rollback();
      }
    });
  });

  it("round-trips a file-server reference with uri, hash, and status", async () => {
    await withStore(async (store) => {
      const expectedHash = sha256Hex(new TextEncoder().encode("remote"));
      const created = await store.putFileServerReference({
        uri: "https://files.example.test/incident/app.log",
        expectedHash,
        verificationStatus: "unverified",
      });
      const parsed = parseFileServerReference(created);
      expect(parsed.uri).toBe("https://files.example.test/incident/app.log");
      expect(parsed.expectedHash).toBe(expectedHash);
      expect(parsed.verificationStatus).toBe("unverified");
      const loaded = await store.getFileServerReference(created.id);
      expect(loaded).toEqual(created);
      const verified = await store.verifyFileServerReference(
        created.id,
        new TextEncoder().encode("remote"),
      );
      expect(verified.verificationStatus).toBe("verified");
    });
  });

  it("abandons a file-server reference and refuses path-crafted ids", async () => {
    await withStore(async (store) => {
      const created = await store.putFileServerReference({
        uri: "https://files.example.test/incident/core.bin",
        expectedHash: sha256Hex(new TextEncoder().encode("remote-synthetic")),
      });
      await store.abandonFileServerReference(created.id);
      expect(await store.getFileServerReference(created.id)).toBeNull();
      await expect(store.abandonFileServerReference("../secret")).rejects.toThrow(/invalid file-server reference id/);
      const restored = await store.putFileServerReference({
        uri: "https://files.example.test/incident/core.bin",
        expectedHash: sha256Hex(new TextEncoder().encode("remote-synthetic")),
      });
      const snapshot = { ...restored, verificationStatus: "unreachable" as const };
      await store.restoreFileServerReference(snapshot);
      expect(await store.getFileServerReference(restored.id)).toEqual(snapshot);
      await expect(store.restoreFileServerReference({ ...snapshot, id: "../secret" }))
        .rejects.toThrow(/invalid file-server reference id/);
    });
  });

  it("represents a never-hashed reference as visibly unverifiable", async () => {
    await withStore(async (store) => {
      await expect(
        store.putFileServerReference({
          uri: "https://files.example.test/never-hashed.bin",
          expectedHash: null,
          verificationStatus: "verified",
        }),
      ).rejects.toThrow(/expected hash/);
      const created = await store.putFileServerReference({
        uri: "https://files.example.test/never-hashed.bin",
      });
      expect(created.expectedHash).toBeNull();
      expect(created.verificationStatus).toBe("unverified");
      const afterBytes = await store.verifyFileServerReference(
        created.id,
        new TextEncoder().encode("whatever"),
      );
      expect(afterBytes.verificationStatus).toBe("unverified");
      expect(afterBytes.expectedHash).toBeNull();
      const unreachable = await store.verifyFileServerReference(created.id);
      expect(unreachable.verificationStatus).toBe("unreachable");
      expect(unreachable.expectedHash).toBeNull();
    });
  });
});
