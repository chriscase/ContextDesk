import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_PENDING_WRITE_SCHEMA_ID,
  FilesystemEvidenceStore,
  abandonWriteBatchForCrashTest,
} from "./store.js";

async function pendingJournalNames(root: string): Promise<string[]> {
  try {
    return (await readdir(join(root, ".pending"))).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

describe("pending-write crash recovery", () => {
  async function withStore<T>(
    fn: (store: FilesystemEvidenceStore) => Promise<T>,
  ): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-pending-write-"));
    try {
      return await fn(new FilesystemEvidenceStore({ rootDir: root }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("reclaims unreferenced hashes after promote without commit and keeps referenced bytes", async () => {
    await withStore(async (store) => {
      const kept = new TextEncoder().encode("2026-08-25T00:00:00Z synthetic kept mailer timeout\n");
      const crashed = new TextEncoder().encode("2026-08-25T00:01:00Z synthetic crashed intake\n");
      const keptMeta = await store.put(kept, { contentType: "text/plain" });
      const batch = await store.beginWriteBatch();
      const crashedMeta = await batch.put(crashed, { contentType: "text/plain" });
      await batch.promote();
      expect(await pendingJournalNames(store.rootDir)).toHaveLength(1);
      expect(await store.verify(crashedMeta.hash)).toBe(true);
      await abandonWriteBatchForCrashTest(batch);
      const recovered = await store.recoverUnreferencedWrites(new Set([keptMeta.hash]));
      expect(recovered.journals).toBe(1);
      expect(recovered.reclaimed).toEqual([crashedMeta.hash]);
      expect(await store.head(crashedMeta.hash)).toBeNull();
      expect(await store.verify(keptMeta.hash)).toBe(true);
      expect(await pendingJournalNames(store.rootDir)).toEqual([]);
    });
  });

  it("keeps promoted bytes when a leftover journal matches a later durable reference", async () => {
    await withStore(async (store) => {
      const bytes = new TextEncoder().encode("2026-08-25T00:02:00Z synthetic committed leftover journal\n");
      const meta = await store.put(bytes, { contentType: "text/plain" });
      await mkdir(join(store.rootDir, ".pending"), { recursive: true });
      await writeFile(
        join(store.rootDir, ".pending", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json"),
        JSON.stringify({
          schemaId: EVIDENCE_PENDING_WRITE_SCHEMA_ID,
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          hashes: [meta.hash],
        }),
        "utf8",
      );
      const recovered = await store.recoverUnreferencedWrites(new Set([meta.hash]));
      expect(recovered.reclaimed).toEqual([]);
      expect(await store.verify(meta.hash)).toBe(true);
      expect(await pendingJournalNames(store.rootDir)).toEqual([]);
    });
  });

  it("ignores path-crafted journal hashes and malformed journals without deleting live blobs", async () => {
    await withStore(async (store) => {
      const live = new TextEncoder().encode("2026-08-25T00:03:00Z synthetic live blob\n");
      const orphan = new TextEncoder().encode("2026-08-25T00:04:00Z synthetic orphan blob\n");
      const liveMeta = await store.put(live, { contentType: "text/plain" });
      const orphanMeta = await store.put(orphan, { contentType: "text/plain" });
      await mkdir(join(store.rootDir, ".pending"), { recursive: true });
      await writeFile(
        join(store.rootDir, ".pending", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.json"),
        JSON.stringify({
          schemaId: EVIDENCE_PENDING_WRITE_SCHEMA_ID,
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          hashes: ["../secret", orphanMeta.hash],
        }),
        "utf8",
      );
      await writeFile(
        join(store.rootDir, ".pending", "not-a-uuid.json"),
        JSON.stringify({ hashes: [liveMeta.hash] }),
        "utf8",
      );
      await writeFile(join(store.rootDir, ".pending", "cccccccc-cccc-4ccc-8ccc-cccccccccccc.json"), "{", "utf8");
      const recovered = await store.recoverUnreferencedWrites(new Set([liveMeta.hash]));
      expect(recovered.reclaimed).toEqual([orphanMeta.hash]);
      expect(await store.verify(liveMeta.hash)).toBe(true);
      expect(await store.head(orphanMeta.hash)).toBeNull();
      expect(await pendingJournalNames(store.rootDir)).toEqual(["not-a-uuid.json"]);
    });
  });

  it("reclaims a crashed batch on the next exclusive write when reference sources are bound", async () => {
    await withStore(async (store) => {
      const referenced = new Set<string>();
      store.addReferencedContentHashSource(async () => referenced);
      const crashed = new TextEncoder().encode("2026-08-25T00:05:00Z synthetic auto-recover crash\n");
      const later = new TextEncoder().encode("2026-08-25T00:06:00Z synthetic later intake\n");
      const batch = await store.beginWriteBatch();
      const crashedMeta = await batch.put(crashed, { contentType: "text/plain" });
      await batch.promote();
      await abandonWriteBatchForCrashTest(batch);
      expect(await store.verify(crashedMeta.hash)).toBe(true);
      const next = await store.beginWriteBatch();
      const laterMeta = await next.put(later, { contentType: "text/plain" });
      await next.promote();
      await next.finalize();
      expect(await store.head(crashedMeta.hash)).toBeNull();
      expect(await store.verify(laterMeta.hash)).toBe(true);
    });
  });

  it("refuses recovery without a referenced-hash set or bound source", async () => {
    await withStore(async (store) => {
      await expect(store.recoverUnreferencedWrites()).rejects.toThrow(
        /referenced content hashes are required/,
      );
    });
  });
});
