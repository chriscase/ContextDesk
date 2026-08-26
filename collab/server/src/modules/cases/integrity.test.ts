import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORPUS_INTAKE_COMMIT_SCHEMA_ID } from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import {
  FilesystemEvidenceStore,
  abandonWriteBatchForCrashTest,
  sha256Hex,
} from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { CatalogService } from "../catalog/index.js";
import { corpusIntakeRequestDigest } from "../corpus-intake/index.js";
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

  it("abandons an unpaired file-server reference when artifact metadata rolls back", async () => {
    const boom = new BoomArtifactStore();
    boom.boom = true;
    await withService(async ({ service, evidence }) => {
      const created = await service.createCase(actor, { title: "File-server ref atomic fixture" }, "test");
      await expect(
        service.addEvidence(
          created.id,
          actor,
          {
            kind: "file_server_ref",
            uri: "https://files.example.test/incident/core.bin",
            expectedHash: sha256Hex(new TextEncoder().encode("remote-synthetic")),
            summary: "Synthetic core dump stays on the file server.",
          },
          "test",
        ),
      ).rejects.toThrow(/artifact store failed/);
      expect(await service.listContributions(created.id, actor, false)).toEqual([]);
      expect((await service.listTimeline(created.id)).some((event) => event.kind === "evidence_registered")).toBe(
        false,
      );
      const refs = await readdir(join(evidence.rootDir, "refs")).catch(() => [] as string[]);
      expect(refs).toEqual([]);
    }, boom);
  });

  it("restores the file-server reference when recheck timeline or audit fails", async () => {
    const boom = new InjectedFailureStore();
    boom.failTimelineKind = "evidence_recheck";
    await withService(async ({ service, evidence, audit, store }) => {
      const created = await service.createCase(actor, { title: "Recheck atomic fixture" }, "test");
      const uploaded = await service.addEvidence(
        created.id,
        actor,
        {
          kind: "file_server_ref",
          uri: "https://files.example.test/incident/core.bin",
          expectedHash: sha256Hex(new TextEncoder().encode("remote-synthetic")),
          summary: "Synthetic core dump stays on the file server.",
        },
        "test",
      );
      const row = await store.getArtifact(uploaded.artifact.id);
      const refId = row?.refId;
      expect(refId).toBeTruthy();
      const before = await evidence.getFileServerReference(refId!);
      expect(before?.verificationStatus).toBe("unverified");
      await expect(service.recheckReference(created.id, uploaded.artifact.id, actor, "test"))
        .rejects.toThrow(/injected timeline failure:evidence_recheck/);
      expect(await evidence.getFileServerReference(refId!)).toEqual(before);
      expect((await service.listTimeline(created.id)).some((event) => event.kind === "evidence_recheck")).toBe(
        false,
      );
      expect(await audit.list({ action: "evidence_recheck" })).toEqual([]);
    }, boom);
  });

  it("keeps concurrent notes and refuses a forked revision without leaking across cases", async () => {
    const bob = { id: "bob", username: "bob" };
    const eve = { id: "eve", username: "eve" };
    await withService(async ({ service }) => {
      const created = await service.createCase(actor, { title: "Concurrent notes fixture" }, "test");
      const other = await service.createCase(eve, { title: "Private synthetic investigation" }, "test");
      await service.addParticipant(created.id, actor, { identityId: bob.id, username: bob.username }, "test");
      const notes = await Promise.all([
        service.addContribution(created.id, actor, { kind: "note", body: "Alice saw the synthetic timeout." }, "test"),
        service.addContribution(created.id, bob, { kind: "note", body: "Bob saw the synthetic queue depth." }, "test"),
        service.addContribution(
          created.id,
          actor,
          { kind: "message", body: "Please inspect the synthetic worker trace." },
          "test",
        ),
      ]);
      expect(new Set(notes.map((row) => row.id)).size).toBe(3);
      const listed = await service.listContributions(created.id, actor, false);
      expect(listed.map((row) => row.body).sort()).toEqual([
        "Alice saw the synthetic timeout.",
        "Bob saw the synthetic queue depth.",
        "Please inspect the synthetic worker trace.",
      ]);
      const timeline = await service.listTimeline(created.id);
      expect(timeline.filter((event) => event.kind === "contribution_created")).toHaveLength(3);
      expect((await service.listContributions(other.id, eve, false)).map((row) => row.body)).toEqual([]);
      expect((await service.listTimeline(other.id)).some((event) => event.kind === "contribution_created")).toBe(
        false,
      );

      const target = notes[0]!;
      const revisions = await Promise.allSettled([
        service.reviseContribution(created.id, target.id, actor, "Alice revised the timeout note.", "test", 1),
        service.reviseContribution(created.id, target.id, bob, "Bob raced the same note revision.", "test", 1),
      ]);
      const fulfilled = revisions.filter((row) => row.status === "fulfilled");
      const conflicts = revisions.filter(
        (row) => row.status === "rejected" && row.reason instanceof ContributionConflictError,
      );
      expect(fulfilled).toHaveLength(1);
      expect(conflicts).toHaveLength(1);
      const chain = await service.provenance(created.id, target.id);
      expect(chain).toHaveLength(2);
      expect(chain[1]?.revision).toBe(2);
      expect(
        (await service.listTimeline(created.id)).filter((event) => event.kind === "contribution_revised"),
      ).toHaveLength(1);
    });
  });

  it("keeps a frozen snapshot immutable after later evidence intake", async () => {
    await withService(async ({ service }) => {
      const created = await service.createCase(actor, { title: "Frozen snapshot intake fixture" }, "test");
      const uploaded = await service.addEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "mailer.log",
          mediaType: "text/plain",
          bytes: new TextEncoder().encode("2026-08-25T00:00:00Z synthetic timeout\n"),
          summary: "Synthetic mailer timeout.",
          privacyClass: "share_safe",
        },
        "test",
      );
      const frozen = await service.createSnapshot(
        created.id,
        actor,
        { evidenceIds: [uploaded.artifact.id], visibility: "share_safe" },
        "test",
      );
      const frozenEvidence = frozen.evidence.map((item) => ({ ...item }));
      const later = await service.addEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "worker.log",
          mediaType: "text/plain",
          bytes: new TextEncoder().encode("2026-08-25T00:01:00Z synthetic worker stall\n"),
          summary: "Synthetic worker stall.",
          privacyClass: "share_safe",
        },
        "test",
      );
      const listed = await service.listSnapshots(created.id, actor, false);
      const reloaded = listed.find((row) => row.id === frozen.id);
      expect(reloaded?.status).toBe("frozen");
      expect(reloaded?.fingerprint).toBe(frozen.fingerprint);
      expect(reloaded?.evidence).toEqual(frozenEvidence);
      expect(reloaded?.evidence.some((item) => item.evidenceId === later.artifact.id)).toBe(false);
      const next = await service.createSnapshot(
        created.id,
        actor,
        { evidenceIds: [uploaded.artifact.id, later.artifact.id], visibility: "share_safe" },
        "test",
      );
      expect(next.id).not.toBe(frozen.id);
      expect(next.parentSnapshotId).toBe(frozen.id);
      expect(next.fingerprint).not.toBe(frozen.fingerprint);
      expect((await service.listTimeline(created.id)).filter((event) => event.kind === "snapshot_frozen")).toHaveLength(
        2,
      );
    });
  });

  it("rolls back promoted corpus blobs when the post-promote timeline write fails", async () => {
    const boom = new InjectedFailureStore();
    boom.failTimelineKind = "corpus_intake_committed";
    await withService(async ({ service, evidence, audit }) => {
      const created = await service.createCase(actor, { title: "Corpus promote atomic fixture" }, "test");
      const bytes = new TextEncoder().encode("2026-08-25T00:00:00Z synthetic mailer timeout\n");
      const files = [{ relativePath: "mailer/promote-rollback.log", mediaType: "text/plain", bytes }];
      const request = {
        schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
        origin: "files" as const,
        sourceLabel: "synthetic promote rollback source",
        privacyClass: "owner_only" as const,
        idempotencyKey: "batch-syn-promote-rollback-1",
        files: [{
          relativePath: files[0]!.relativePath,
          mediaType: files[0]!.mediaType,
          contentBase64: Buffer.from(bytes).toString("base64"),
        }],
        archiveBase64: null,
        previewToken: corpusIntakeRequestDigest({
          caseId: created.id,
          actorId: actor.id,
          origin: "files",
          sourceLabel: "synthetic promote rollback source",
          privacyClass: "owner_only",
          idempotencyKey: "batch-syn-promote-rollback-1",
          files,
          archive: null,
        }),
      };
      await expect(service.commitCorpusIntake(created.id, actor, request, "test"))
        .rejects.toThrow(/injected timeline failure:corpus_intake_committed/);
      expect(await service.listArtifacts(created.id, actor, false)).toEqual([]);
      expect((await service.listTimeline(created.id)).some((event) => event.kind === "evidence_registered")).toBe(
        false,
      );
      expect((await service.listTimeline(created.id)).some((event) => event.kind === "corpus_intake_committed")).toBe(
        false,
      );
      expect(await evidence.head(sha256Hex(bytes))).toBeNull();
      expect(await audit.list({ action: "corpus_intake_commit" })).toEqual([]);
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

  it("rolls back case create, status, membership, and legal-hold when timeline or audit fails", async () => {
    const timelineStore = new InjectedFailureStore();
    timelineStore.failTimelineKind = "case_created";
    await withService(async ({ service, audit }) => {
      await expect(
        service.createCase(actor, { title: "Synthetic case atomic fixture" }, "test"),
      ).rejects.toThrow(/injected timeline failure:case_created/);
      expect(await service.listCases(actor, true)).toEqual([]);
      expect(await audit.list({ action: "case_create" })).toEqual([]);
    }, timelineStore);

    await withService(async ({ service, audit, store }) => {
      const created = await service.createCase(actor, { title: "Synthetic status atomic fixture" }, "test");
      (store as InjectedFailureStore).failTimelineKind = "case_status";
      await expect(service.setStatus(created.id, actor, "closed", "test")).rejects.toThrow(
        /injected timeline failure:case_status/,
      );
      expect((await service.getCase(created.id, actor, true))?.status).toBe("open");
      expect((await service.listTimeline(created.id)).some((event) => event.kind === "case_status")).toBe(false);
      expect(await audit.list({ action: "case_status" })).toEqual([]);
    }, new InjectedFailureStore());

    await withService(async ({ service, audit, store }) => {
      const created = await service.createCase(actor, { title: "Synthetic membership atomic fixture" }, "test");
      (store as InjectedFailureStore).failTimelineKind = "membership";
      await expect(
        service.addParticipant(created.id, actor, { identityId: "bob", username: "bob" }, "test"),
      ).rejects.toThrow(/injected timeline failure:membership/);
      expect((await service.getCase(created.id, actor, true))?.participants.some((row) => row.identityId === "bob"))
        .toBe(false);
      expect((await service.listTimeline(created.id)).some((event) => event.kind === "membership")).toBe(false);
      expect(await audit.list({ action: "case_membership" })).toEqual([]);
    }, new InjectedFailureStore());

    const boomAudit = new InjectedFailureAudit();
    await withService(async ({ service, audit }) => {
      const created = await service.createCase(actor, { title: "Synthetic hold atomic fixture" }, "test");
      boomAudit.failAction = "legal_hold";
      await expect(service.setLegalHold(created.id, actor, true, "test")).rejects.toThrow(
        /injected audit failure:legal_hold/,
      );
      expect((await service.getCase(created.id, actor, true))?.legalHold).toBe(false);
      expect((await service.listTimeline(created.id)).some((event) => event.kind === "legal_hold")).toBe(false);
      expect(await audit.list({ action: "legal_hold" })).toEqual([]);
    }, new MemoryCaseStore(), boomAudit);
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

  it("reclaims promoted evidence bytes after a crash before commit and keeps referenced digests", async () => {
    await withService(async ({ service, evidence, store }) => {
      evidence.addReferencedContentHashSource(() => store.listReferencedContentHashes());
      const created = await service.createCase(actor, { title: "Promote crash recovery fixture" }, "test");
      const keptBytes = new TextEncoder().encode("2026-08-25T00:00:00Z synthetic kept worker stall\n");
      const kept = await service.addEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "kept-worker.log",
          mediaType: "text/plain",
          bytes: keptBytes,
          summary: "Synthetic kept worker stall.",
          privacyClass: "share_safe",
        },
        "test",
      );
      const crashedBytes = new TextEncoder().encode("2026-08-25T00:01:00Z synthetic crashed corpus\n");
      const batch = await evidence.beginWriteBatch();
      const crashedMeta = await batch.put(crashedBytes, { contentType: "text/plain" });
      await batch.promote();
      expect(await evidence.verify(crashedMeta.hash)).toBe(true);
      await abandonWriteBatchForCrashTest(batch);
      expect(await store.listArtifactsByCase(created.id)).toHaveLength(1);
      const recovered = await evidence.recoverUnreferencedWrites();
      expect(recovered.reclaimed).toEqual([crashedMeta.hash]);
      expect(await evidence.head(crashedMeta.hash)).toBeNull();
      expect(await evidence.verify(kept.artifact.contentHash ?? "")).toBe(true);
      expect((await service.listArtifacts(created.id, actor, false)).map((row) => row.id)).toEqual([
        kept.artifact.id,
      ]);
      expect(
        (await service.listTimeline(created.id)).filter((event) => event.kind === "evidence_registered"),
      ).toHaveLength(1);
    });
  });
});
