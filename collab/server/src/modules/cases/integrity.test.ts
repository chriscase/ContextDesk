import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemEvidenceStore, sha256Hex } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { CatalogService } from "../catalog/index.js";
import { ContributionConflictError, CaseService, MemoryCaseStore } from "./index.js";

const actor = { id: "alice", username: "alice" };

class BoomArtifactStore extends MemoryCaseStore {
  boom = false;
  override async insertArtifact(
    row: Parameters<MemoryCaseStore["insertArtifact"]>[0],
  ): Promise<void> {
    if (this.boom) throw new Error("artifact store failed");
    return super.insertArtifact(row);
  }
}

async function withService(
  fn: (ctx: {
    service: CaseService;
    evidence: FilesystemEvidenceStore;
    store: MemoryCaseStore;
  }) => Promise<void>,
  store: MemoryCaseStore = new MemoryCaseStore(),
) {
  const root = await mkdtemp(join(tmpdir(), "contextdesk-integrity-"));
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const service = new CaseService(
    evidence,
    new MemoryAuditStore(),
    store,
    new CatalogService(),
  );
  try {
    await fn({ service, evidence, store });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("case write integrity", () => {
  it("replays identical authorized contribution writes and rejects digest mismatch", async () => {
    await withService(async ({ service }) => {
      const created = await service.createCase(actor, { title: "Idempotent write fixture" }, "test");
      const first = await service.addContribution(
        created.id,
        actor,
        {
          kind: "note",
          body: "Synthetic queue depth observation.",
          idempotencyKey: "msg-syn-0001",
        },
        "test",
      );
      const replay = await service.addContribution(
        created.id,
        actor,
        {
          kind: "note",
          body: "Synthetic queue depth observation.",
          idempotencyKey: "msg-syn-0001",
        },
        "test",
      );
      expect(replay.id).toBe(first.id);
      expect(replay.revision).toBe(1);
      expect(replay.authorId).toBe(actor.id);
      const listed = await service.listContributions(created.id, actor, false);
      expect(listed.filter((row) => row.body === "Synthetic queue depth observation.")).toHaveLength(1);

      await expect(
        service.addContribution(
          created.id,
          actor,
          {
            kind: "note",
            body: "A different authorized body must not reuse the key.",
            idempotencyKey: "msg-syn-0001",
          },
          "test",
        ),
      ).rejects.toBeInstanceOf(ContributionConflictError);

      const legacyA = await service.addContribution(
        created.id,
        actor,
        { kind: "note", body: "Legacy unkeyed write." },
        "test",
      );
      const legacyB = await service.addContribution(
        created.id,
        actor,
        { kind: "note", body: "Legacy unkeyed write." },
        "test",
      );
      expect(legacyB.id).not.toBe(legacyA.id);
    });
  });

  it("fails closed on stale contribution revisions and does not fork history", async () => {
    await withService(async ({ service }) => {
      const created = await service.createCase(actor, { title: "Revision CAS fixture" }, "test");
      const note = await service.addContribution(
        created.id,
        actor,
        { kind: "note", body: "revision 1" },
        "test",
      );
      const results = await Promise.allSettled([
        service.reviseContribution(created.id, note.id, actor, "lane-a", "test", 1),
        service.reviseContribution(created.id, note.id, actor, "lane-b", "test", 1),
      ]);
      const fulfilled = results.filter((row) => row.status === "fulfilled");
      const conflicts = results.filter(
        (row) => row.status === "rejected" && row.reason instanceof ContributionConflictError,
      );
      expect(fulfilled).toHaveLength(1);
      expect(conflicts).toHaveLength(1);
      if (conflicts[0]?.status === "rejected") {
        expect((conflicts[0].reason as ContributionConflictError).currentRevision).toBe(2);
      }
      const chain = await service.provenance(created.id, note.id);
      expect(chain).toHaveLength(2);
      expect(chain.map((row) => row.revision)).toEqual([1, 2]);
      expect(new Set(chain.map((row) => row.revision)).size).toBe(2);

      await expect(
        service.reviseContribution(created.id, note.id, actor, "stale", "test", 1),
      ).rejects.toBeInstanceOf(ContributionConflictError);
    });
  });

  it("rolls back ordinary evidence metadata and staged bytes when artifact insert fails", async () => {
    const boom = new BoomArtifactStore();
    boom.boom = true;
    await withService(async ({ service, evidence }) => {
      const created = await service.createCase(actor, { title: "Evidence atomic fixture" }, "test");
      const bytes = new TextEncoder().encode("synthetic mailer timeout log\n");
      await expect(
        service.addEvidence(
          created.id,
          actor,
          {
            kind: "log",
            filename: "mailer.log",
            mediaType: "text/plain",
            bytes,
            summary: "Synthetic mailer timeout.",
          },
          "test",
        ),
      ).rejects.toThrow(/artifact store failed/);
      expect(await service.listContributions(created.id, actor, false)).toEqual([]);
      const timeline = await service.listTimeline(created.id);
      expect(timeline.some((event) => event.kind === "evidence_registered")).toBe(false);
      expect(timeline.some((event) => event.kind === "contribution_created")).toBe(false);
      expect(await evidence.head(sha256Hex(bytes))).toBeNull();
    }, boom);
  });

  it("projects accepted decisions only from the selected snapshot fingerprint", async () => {
    await withService(async ({ service }) => {
      const created = await service.createCase(actor, { title: "Board isolation fixture" }, "test");
      const uploaded = await service.addEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "checkout.log",
          mediaType: "text/plain",
          bytes: new TextEncoder().encode("checkout timed out"),
          summary: "Checkout timed out.",
          privacyClass: "share_safe",
        },
        "test",
      );
      const first = await service.createSnapshot(
        created.id,
        actor,
        { evidenceIds: [uploaded.artifact.id], visibility: "share_safe" },
        "test",
      );
      const second = await service.createSnapshot(
        created.id,
        actor,
        { evidenceIds: [uploaded.artifact.id], visibility: "share_safe" },
        "test",
      );
      const board = await service.getCaseBoard(created.id, actor, false, first.id, [
        {
          id: "decision-first",
          statement: "Selected freeze conclusion.",
          evidenceRefs: [uploaded.artifact.id],
          snapshotFingerprint: `snap-${first.fingerprint}`,
        },
        {
          id: "decision-second",
          statement: "Later freeze conclusion must not bleed.",
          evidenceRefs: [uploaded.artifact.id],
          snapshotFingerprint: second.fingerprint,
        },
      ]);
      const concluded = board?.findings.filter((finding) => finding.bucket === "newly_concluded") ?? [];
      expect(concluded.map((finding) => finding.statement)).toEqual(["Selected freeze conclusion."]);
    });
  });
});
