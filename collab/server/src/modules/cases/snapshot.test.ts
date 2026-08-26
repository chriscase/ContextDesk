import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CatalogService } from "../catalog/index.js";
import { MemoryAuditStore } from "../audit/index.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { CaseService, MemoryCaseStore } from "./index.js";

describe("case snapshots", () => {
  it("freezes evidence identities, links lineage, and derives a board", async () => {
    const root = await mkdtemp(join(tmpdir(), "contextdesk-snapshot-test-"));
    try {
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const service = new CaseService(
        evidence,
        new MemoryAuditStore(),
        new MemoryCaseStore(),
        new CatalogService(),
      );
      const actor = { id: "alice", username: "alice" };
      const created = await service.createCase(actor, { title: "Snapshot test" }, "test");
      const uploaded = await service.addEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "checkout.log",
          mediaType: "text/plain",
          bytes: new TextEncoder().encode("checkout timed out"),
          summary: "Checkout timed out.",
          privacyClass: "owner_only",
        },
        "test",
      );
      const first = await service.createSnapshot(
        created.id,
        actor,
        { evidenceIds: [uploaded.artifact.id], visibility: "owner_only" },
        "test",
      );
      const second = await service.createSnapshot(
        created.id,
        actor,
        { evidenceIds: [], visibility: "owner_only" },
        "test",
      );
      expect(first.status).toBe("frozen");
      expect(first.fairnessClass).toBe("same_snapshot");
      expect(first.evidence[0]?.evidenceId).toBe(uploaded.artifact.id);
      expect(second.parentSnapshotId).toBe(first.id);
      expect(second.fingerprint).not.toBe(first.fingerprint);
      expect(second.fairnessClass).toBe("same_snapshot");

      const unhashed = await service.addEvidence(
        created.id,
        actor,
        {
          kind: "file_server_ref",
          uri: "s3://example.invalid/unhashed.log",
          summary: "Reference has no recorded content or expected hash.",
          privacyClass: "owner_only",
        },
        "test",
      );
      const unknownFairness = await service.createSnapshot(
        created.id,
        actor,
        { evidenceIds: [unhashed.artifact.id], visibility: "owner_only" },
        "test",
      );
      expect(unknownFairness.evidence[0]?.contentHash).toBeNull();
      expect(unknownFairness.evidence[0]?.expectedHash).toBeNull();
      expect(unknownFairness.fairnessClass).toBe("unknown");
      const board = await service.getCaseBoard(created.id, actor, false, first.id);
      expect(board?.snapshotId).toBe(first.id);
      expect(board?.findings.some((finding) => finding.bucket === "known")).toBe(false);
      expect(board?.findings).toEqual([]);
      await expect(
        service.createSnapshot(
          created.id,
          actor,
          { evidenceIds: ["missing"], visibility: "owner_only" },
          "test",
        ),
      ).rejects.toThrow(/evidence not found/);
      await expect(
        service.createSnapshot(
          created.id,
          actor,
          { evidenceIds: [uploaded.artifact.id, uploaded.artifact.id] },
          "test",
        ),
      ).rejects.toThrow("unique");
      await expect(
        service.createSnapshot(
          created.id,
          actor,
          { evidenceIds: [uploaded.artifact.id], visibility: "share_safe" },
          "test",
        ),
      ).rejects.toThrow("owner-only");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds freeze to the live log-time corpus revision and does not mutate later", async () => {
    const root = await mkdtemp(join(tmpdir(), "contextdesk-snapshot-revision-"));
    try {
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const service = new CaseService(
        evidence,
        new MemoryAuditStore(),
        new MemoryCaseStore(),
        new CatalogService(),
      );
      let liveRevision: number | null = 3;
      service.bindNormalizationRevision(async () => liveRevision);
      const actor = { id: "alice", username: "alice" };
      const created = await service.createCase(actor, { title: "Revision bind" }, "test");
      const uploaded = await service.addEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "checkout.log",
          mediaType: "text/plain",
          bytes: new TextEncoder().encode("checkout timed out"),
          summary: "Checkout timed out.",
          privacyClass: "owner_only",
        },
        "test",
      );
      const frozen = await service.createSnapshot(
        created.id,
        actor,
        { evidenceIds: [uploaded.artifact.id], visibility: "owner_only" },
        "test",
      );
      expect(frozen.normalizationRevision).toBe(3);
      liveRevision = 4;
      const listed = await service.listSnapshots(created.id, actor, true);
      const still = listed.find((row) => row.id === frozen.id);
      expect(still?.normalizationRevision).toBe(3);
      const later = await service.createSnapshot(
        created.id,
        actor,
        { evidenceIds: [uploaded.artifact.id], visibility: "owner_only" },
        "test",
      );
      expect(later.id).not.toBe(frozen.id);
      expect(later.normalizationRevision).toBe(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
