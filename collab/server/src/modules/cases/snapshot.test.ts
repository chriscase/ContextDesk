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
      expect(first.evidence[0]?.evidenceId).toBe(uploaded.artifact.id);
      expect(second.parentSnapshotId).toBe(first.id);
      expect(second.fingerprint).not.toBe(first.fingerprint);
      const board = await service.getCaseBoard(created.id, actor, false, first.id);
      expect(board?.snapshotId).toBe(first.id);
      expect(board?.findings.some((finding) => finding.bucket === "known")).toBe(true);
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
});
