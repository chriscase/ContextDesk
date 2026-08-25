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

class InjectedFailureStore extends MemoryCaseStore {
  failTimelineKind: string | null = null;
  override async appendTimeline(
    caseId: string,
    event: Parameters<MemoryCaseStore["appendTimeline"]>[1],
  ): Promise<Awaited<ReturnType<MemoryCaseStore["appendTimeline"]>>> {
    if (this.failTimelineKind && event.kind === this.failTimelineKind) {
      throw new Error(`injected timeline failure:${event.kind}`);
    }
    return super.appendTimeline(caseId, event);
  }
}

class InjectedFailureAudit extends MemoryAuditStore {
  failAction: string | null = null;
  override async append(
    record: Parameters<MemoryAuditStore["append"]>[0],
  ): ReturnType<MemoryAuditStore["append"]> {
    if (this.failAction && record.action === this.failAction) {
      throw new Error(`injected audit failure:${record.action}`);
    }
    return super.append(record);
  }
}

async function withService(
  fn: (ctx: {
    service: CaseService;
    evidence: FilesystemEvidenceStore;
    store: MemoryCaseStore;
    audit: MemoryAuditStore;
  }) => Promise<void>,
  store: MemoryCaseStore = new MemoryCaseStore(),
  audit: MemoryAuditStore = new MemoryAuditStore(),
) {
  const root = await mkdtemp(join(tmpdir(), "contextdesk-integrity-"));
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const service = new CaseService(
    evidence,
    audit,
    store,
    new CatalogService(),
  );
  try {
    await fn({ service, evidence, store, audit });
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

  it("refuses a mismatched expectedHash before any held evidence, timeline, or audit row", async () => {
    await withService(async ({ service, evidence, audit }) => {
      const created = await service.createCase(actor, { title: "Hash mismatch fixture" }, "test");
      const bytes = new TextEncoder().encode("synthetic held log bytes\n");
      await expect(
        service.addEvidence(
          created.id,
          actor,
          {
            kind: "log",
            filename: "held.log",
            mediaType: "text/plain",
            bytes,
            expectedHash: "b".repeat(64),
            summary: "Must not land when the digest disagrees.",
          },
          "test",
        ),
      ).rejects.toThrow(/held evidence hash mismatch/);
      expect(await service.listArtifacts(created.id, actor, false)).toEqual([]);
      expect(await service.listContributions(created.id, actor, false)).toEqual([]);
      const timeline = await service.listTimeline(created.id);
      expect(timeline.some((event) => event.kind === "evidence_registered")).toBe(false);
      expect(timeline.some((event) => event.kind === "contribution_created")).toBe(false);
      expect(await audit.list({ action: "evidence_register" })).toEqual([]);
      expect(await evidence.head(sha256Hex(bytes))).toBeNull();
    });
  });

  it("accepts a matching expectedHash and marks held evidence verified", async () => {
    await withService(async ({ service }) => {
      const created = await service.createCase(actor, { title: "Hash match fixture" }, "test");
      const bytes = new TextEncoder().encode("synthetic held log bytes\n");
      const uploaded = await service.addEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "held.log",
          mediaType: "text/plain",
          bytes,
          expectedHash: sha256Hex(bytes),
          summary: "Digest matches the held bytes.",
        },
        "test",
      );
      expect(uploaded.artifact.verificationStatus).toBe("verified");
      expect(uploaded.artifact.contentHash).toBe(sha256Hex(bytes));
      expect(uploaded.artifact.expectedHash).toBe(sha256Hex(bytes));
    });
  });

  it("rolls snapshot, hypothesis, and tombstone writes back from each injected failure point", async () => {
    const failures = [
      {
        title: "Snapshot freeze",
        timelineKind: "snapshot_frozen",
        auditAction: "snapshot_freeze",
        setup: async (service: CaseService) => {
          const created = await service.createCase(actor, { title: "Atomic snapshot fixture" }, "test");
          const uploaded = await service.addEvidence(
            created.id,
            actor,
            {
              kind: "log",
              filename: "checkout.log",
              mediaType: "text/plain",
              bytes: new TextEncoder().encode("checkout timed out"),
              summary: "Checkout timed out.",
            },
            "test",
          );
          return { created, uploaded };
        },
        mutate: async (
          service: CaseService,
          ctx: { created: { id: string }; uploaded: { artifact: { id: string } } },
        ) =>
          service.createSnapshot(
            ctx.created.id,
            actor,
            { evidenceIds: [ctx.uploaded.artifact.id] },
            "test",
          ),
        assertRolledBack: async (
          service: CaseService,
          audit: MemoryAuditStore,
          ctx: { created: { id: string } },
        ) => {
          expect(await service.listSnapshots(ctx.created.id, actor, false)).toEqual([]);
          expect(
            (await service.listTimeline(ctx.created.id)).some((event) => event.kind === "snapshot_frozen"),
          ).toBe(false);
          expect(await audit.list({ action: "snapshot_freeze" })).toEqual([]);
        },
      },
      {
        title: "Hypothesis status",
        timelineKind: "hypothesis_status",
        auditAction: "hypothesis_status",
        setup: async (service: CaseService) => {
          const created = await service.createCase(actor, { title: "Atomic hypothesis fixture" }, "test");
          const hypothesis = await service.addContribution(
            created.id,
            actor,
            { kind: "hypothesis", body: "Timeout is in the mailer." },
            "test",
          );
          return { created, hypothesis };
        },
        mutate: async (
          service: CaseService,
          ctx: { created: { id: string }; hypothesis: { id: string } },
        ) =>
          service.setHypothesisStatus(
            ctx.created.id,
            ctx.hypothesis.id,
            actor,
            "superseded",
            [],
            "test",
          ),
        assertRolledBack: async (
          service: CaseService,
          audit: MemoryAuditStore,
          ctx: { created: { id: string }; hypothesis: { id: string } },
        ) => {
          const listed = await service.listContributions(ctx.created.id, actor, false);
          const current = listed.find((row) => row.id === ctx.hypothesis.id);
          expect(current?.revision).toBe(1);
          expect(
            (await service.listTimeline(ctx.created.id)).some((event) => event.kind === "hypothesis_status"),
          ).toBe(false);
          expect(await audit.list({ action: "hypothesis_status" })).toEqual([]);
        },
      },
      {
        title: "Contribution tombstone",
        timelineKind: "contribution_tombstoned",
        auditAction: "contribution_tombstone",
        setup: async (service: CaseService) => {
          const created = await service.createCase(actor, { title: "Atomic tombstone fixture" }, "test");
          const note = await service.addContribution(
            created.id,
            actor,
            { kind: "note", body: "Synthetic observation." },
            "test",
          );
          return { created, note };
        },
        mutate: async (
          service: CaseService,
          ctx: { created: { id: string }; note: { id: string } },
        ) => service.tombstoneContribution(ctx.created.id, ctx.note.id, actor, "test"),
        assertRolledBack: async (
          service: CaseService,
          audit: MemoryAuditStore,
          ctx: { created: { id: string }; note: { id: string } },
        ) => {
          const listed = await service.listContributions(ctx.created.id, actor, false);
          const current = listed.find((row) => row.id === ctx.note.id);
          expect(current?.tombstoned).toBe(false);
          expect(current?.revision).toBe(1);
          expect(
            (await service.listTimeline(ctx.created.id)).some((event) => event.kind === "contribution_tombstoned"),
          ).toBe(false);
          expect(await audit.list({ action: "contribution_tombstone" })).toEqual([]);
        },
      },
    ] as const;

    for (const failure of failures) {
      const timelineStore = new InjectedFailureStore();
      const timelineAudit = new MemoryAuditStore();
      await withService(async ({ service, audit }) => {
        const ctx = await failure.setup(service);
        timelineStore.failTimelineKind = failure.timelineKind;
        await expect(failure.mutate(service, ctx as never)).rejects.toThrow(/injected timeline failure/);
        await failure.assertRolledBack(service, audit, ctx as never);
      }, timelineStore, timelineAudit);

      const auditStore = new MemoryCaseStore();
      const boomAudit = new InjectedFailureAudit();
      await withService(async ({ service, audit }) => {
        const ctx = await failure.setup(service);
        boomAudit.failAction = failure.auditAction;
        await expect(failure.mutate(service, ctx as never)).rejects.toThrow(/injected audit failure/);
        await failure.assertRolledBack(service, audit, ctx as never);
      }, auditStore, boomAudit);
    }
  });

  it("replays identical snapshot fingerprints and hypothesis/tombstone retries without forking history", async () => {
    await withService(async ({ service }) => {
      const created = await service.createCase(actor, { title: "Idempotent freeze fixture" }, "test");
      const uploaded = await service.addEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "checkout.log",
          mediaType: "text/plain",
          bytes: new TextEncoder().encode("checkout timed out"),
          summary: "Checkout timed out.",
        },
        "test",
      );
      const first = await service.createSnapshot(
        created.id,
        actor,
        { evidenceIds: [uploaded.artifact.id] },
        "test",
      );
      const replay = await service.createSnapshot(
        created.id,
        actor,
        { evidenceIds: [uploaded.artifact.id], protocolVersion: first.protocolVersion },
        "test",
      );
      expect(replay.id).not.toBe(first.id);
      expect(replay.parentSnapshotId).toBe(first.id);

      const hypothesis = await service.addContribution(
        created.id,
        actor,
        { kind: "hypothesis", body: "Mailer retries exhausted." },
        "test",
      );
      const status = await service.setHypothesisStatus(
        created.id,
        hypothesis.id,
        actor,
        "proposed",
        [],
        "test",
      );
      const statusReplay = await service.setHypothesisStatus(
        created.id,
        hypothesis.id,
        actor,
        "proposed",
        [],
        "test",
      );
      expect(statusReplay.revision).toBe(status.revision);
      expect(statusReplay.id).toBe(hypothesis.id);

      const note = await service.addContribution(
        created.id,
        actor,
        { kind: "note", body: "Keep the original note." },
        "test",
      );
      const tombstoned = await service.tombstoneContribution(created.id, note.id, actor, "test");
      const tombstoneReplay = await service.tombstoneContribution(created.id, note.id, actor, "test");
      expect(tombstoneReplay.revision).toBe(tombstoned.revision);
      expect(tombstoneReplay.tombstoned).toBe(true);
      expect((await service.provenance(created.id, note.id)).filter((row) => row.tombstoned)).toHaveLength(1);
    });
  });
});
