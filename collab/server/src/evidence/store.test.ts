import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFileServerReference } from "@cd-collab/contracts";
import {
  FilesystemEvidenceStore,
  corruptBlobForTest,
  sha256Hex,
} from "./store.js";

describe("FilesystemEvidenceStore", () => {
  async function withStore<T>(
    fn: (store: FilesystemEvidenceStore) => Promise<T>,
  ): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-evidence-"));
    try {
      return await fn(new FilesystemEvidenceStore({ rootDir: root }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
