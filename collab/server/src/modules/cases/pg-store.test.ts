import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORPUS_INTAKE_COMMIT_SCHEMA_ID,
  ContractViolation,
  SNAPSHOT_SCHEMA_ID,
  parseCorpusIntakeBatch,
  snapshotFingerprint,
  type SnapshotEvidenceV1,
  type SnapshotV1,
} from "@cd-collab/contracts";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { FilesystemEvidenceStore, abandonWriteBatchForCrashTest } from "../../evidence/store.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { MemoryAuditStore, PgAuditStore, type AuditStore } from "../audit/index.js";
import { CatalogService, PgCatalogStore } from "../catalog/index.js";
import { corpusIntakeRequestDigest } from "../corpus-intake/index.js";
import { CaseService, ContributionConflictError } from "./service.js";
import {
  MemoryCaseStore,
  PgCaseStore,
  type ArtifactRow,
  type CaseRow,
  type SnapshotRow,
} from "./store.js";

const CASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SNAPSHOT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MISSING_CONTRIBUTION_ID = "20000000-0000-4000-8000-000000000002";
const CREATED_AT = "2026-08-20T00:00:00.000Z";

function caseRow(id = CASE_ID): CaseRow {
  return {
    id,
    title: "fixture",
    problemStatement: "",
    affectedParties: "",
    impact: "",
    scope: "",
    openQuestions: [],
    situationVersion: 0,
    severity: "low",
    status: "open",
    legalHold: false,
    retentionClass: "standard",
    createdAt: CREATED_AT,
    createdBy: "alice",
    createdByUsername: "alice",
    participants: [],
  };
}

function pgCaseRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CASE_ID,
    title: "fixture",
    problem_statement: "",
    affected_parties: "",
    impact: "",
    situation_scope: "",
    open_questions: [],
    situation_version: 1,
    severity: "low",
    status: "open",
    legal_hold: false,
    retention_class: "standard",
    created_at: CREATED_AT,
    created_by: "alice",
    created_by_username: "alice",
    participants: [],
    ...overrides,
  };
}

function evidencePair(): SnapshotEvidenceV1[] {
  return [
    {
      evidenceId: "artifact-b",
      ordinal: 1,
      contentHash: "b".repeat(64),
      expectedHash: null,
      verificationStatus: "verified",
      privacyClass: "owner_only",
    },
    {
      evidenceId: "artifact-a",
      ordinal: 0,
      contentHash: null,
      expectedHash: "a".repeat(64),
      verificationStatus: "unverified",
      privacyClass: "share_safe",
    },
  ];
}

function validSnapshot(overrides: Partial<SnapshotV1> = {}): SnapshotV1 {
  const evidence = overrides.evidence ?? evidencePair();
  const parentSnapshotId =
    overrides.parentSnapshotId === undefined ? null : overrides.parentSnapshotId;
  const visibility = overrides.visibility ?? "owner_only";
  const protocolVersion = overrides.protocolVersion ?? "triage-v1";
  const fingerprint =
    overrides.fingerprint ??
    snapshotFingerprint({
      parentSnapshotId,
      evidence,
      visibility,
      protocolVersion,
    });
  return {
    schemaId: SNAPSHOT_SCHEMA_ID,
    id: overrides.id ?? SNAPSHOT_ID,
    caseId: overrides.caseId ?? CASE_ID,
    fingerprint,
    parentSnapshotId,
    evidence,
    visibility,
    protocolVersion,
    fairnessClass: overrides.fairnessClass ?? "same_snapshot",
    status: overrides.status ?? "frozen",
    createdAt: overrides.createdAt ?? CREATED_AT,
    createdBy: overrides.createdBy ?? "alice",
  };
}

function storedSnapshots(store: MemoryCaseStore): Map<string, unknown> {
  return (store as unknown as { snapshots: Map<string, unknown> }).snapshots;
}

function identityOf(snapshot: SnapshotV1): Pick<
  SnapshotV1,
  | "fingerprint"
  | "parentSnapshotId"
  | "visibility"
  | "fairnessClass"
  | "status"
  | "createdAt"
  | "createdBy"
> & { evidenceIds: string[]; ordinals: number[] } {
  return {
    fingerprint: snapshot.fingerprint,
    parentSnapshotId: snapshot.parentSnapshotId,
    visibility: snapshot.visibility,
    fairnessClass: snapshot.fairnessClass,
    status: snapshot.status,
    createdAt: snapshot.createdAt,
    createdBy: snapshot.createdBy,
    evidenceIds: snapshot.evidence.map((item) => item.evidenceId),
    ordinals: snapshot.evidence.map((item) => item.ordinal),
  };
}

async function expectRoundTrip(
  store: MemoryCaseStore | PgCaseStore,
  snapshot: SnapshotV1,
): Promise<void> {
  await store.insertSnapshot(snapshot);
  const got = await store.getSnapshot(snapshot.id);
  expect(got).toEqual(snapshot);
  expect(identityOf(got as SnapshotV1)).toEqual(identityOf(snapshot));
  const listed = await store.listSnapshotsByCase(snapshot.caseId);
  expect(listed).toEqual([snapshot]);
}

type Corruption = {
  name: string;
  document: Record<string, unknown>;
};

function corruptionId(n: number): string {
  return `dddddddd-dddd-4ddd-8ddd-${n.toString(16).padStart(12, "0")}`;
}

function dummyFingerprint(nibble: string): string {
  return nibble.repeat(64);
}

function corruptions(): Corruption[] {
  const first = evidencePair()[0]!;
  const second = evidencePair()[1]!;
  return [
    {
      name: "wrong fingerprint",
      document: { ...validSnapshot({ id: corruptionId(1) }), fingerprint: dummyFingerprint("f") },
    },
    {
      name: "duplicate evidence IDs",
      document: {
        ...validSnapshot({ id: corruptionId(2) }),
        fingerprint: dummyFingerprint("1"),
        evidence: [first, { ...first, ordinal: 99 }],
      },
    },
    {
      name: "duplicate ordinals",
      document: {
        ...validSnapshot({ id: corruptionId(3) }),
        fingerprint: dummyFingerprint("2"),
        evidence: [first, { ...second, ordinal: first.ordinal }],
      },
    },
    {
      name: "invalid hashes",
      document: {
        ...validSnapshot({ id: corruptionId(4) }),
        fingerprint: dummyFingerprint("3"),
        evidence: [{ ...first, contentHash: "not-a-hash" }, second],
      },
    },
    {
      name: "self-parent",
      document: {
        ...validSnapshot({ id: corruptionId(5) }),
        fingerprint: dummyFingerprint("4"),
        parentSnapshotId: corruptionId(5),
      },
    },
    {
      name: "malformed timestamp",
      document: { ...validSnapshot({ id: corruptionId(6) }), createdAt: "not-a-timestamp" },
    },
    {
      name: "invalid status",
      document: {
        ...validSnapshot({ id: corruptionId(7) }),
        fingerprint: dummyFingerprint("5"),
        status: "draft",
      },
    },
    {
      name: "invalid fairness",
      document: {
        ...validSnapshot({ id: corruptionId(8) }),
        fingerprint: dummyFingerprint("6"),
        fairnessClass: "gold",
      },
    },
    {
      name: "invalid privacy",
      document: {
        ...validSnapshot({ id: corruptionId(9) }),
        fingerprint: dummyFingerprint("7"),
        visibility: "public",
      },
    },
    {
      name: "owner-only evidence inside share_safe",
      document: validSnapshot({
        id: corruptionId(10),
        visibility: "share_safe",
        evidence: evidencePair(),
      }),
    },
    {
      name: "unknown nested fields",
      document: {
        ...validSnapshot({ id: corruptionId(11) }),
        fingerprint: dummyFingerprint("8"),
        evidence: [{ ...first, leak: true }, second],
      },
    },
    {
      name: "malformed scalar types",
      document: {
        ...validSnapshot({ id: corruptionId(12) }),
        fingerprint: 123,
        protocolVersion: 1,
        createdBy: false,
      },
    },
  ];
}

async function insertSqlSnapshot(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  document: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO snapshots (
       id, case_id, fingerprint, parent_snapshot_id, evidence, visibility,
       protocol_version, fairness_class, status, created_at, created_by
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)`,
    [
      document.id,
      document.caseId,
      document.fingerprint,
      document.parentSnapshotId,
      JSON.stringify(document.evidence ?? null),
      document.visibility,
      document.protocolVersion,
      document.fairnessClass,
      document.status,
      document.createdAt,
      document.createdBy,
    ],
  );
}

describe.skipIf(!adminUrl())("pg-backed case memory", () => {
  it("serializes concurrent corpus idempotency and commits one batch, artifact, and audit", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-corpus-"));
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(pool);
      const catalog = new CatalogService(new PgCatalogStore(pool), audit);
      const cases = new CaseService(evidence, audit, new PgCaseStore(pool), catalog);
      const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
      try {
        const created = await cases.createCase(actor, { title: "Concurrent corpus fixture" }, "test");
        const bytes = new TextEncoder().encode("2026-08-24T00:00:00Z synthetic timeout\n");
        const files = [{ relativePath: "mailer/concurrent.log", mediaType: "text/plain", bytes }];
        const seed = {
          schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
          origin: "files" as const,
          sourceLabel: "synthetic concurrent source",
          privacyClass: "owner_only" as const,
          idempotencyKey: "batch-synthetic-concurrent-1",
          files: [{
            relativePath: files[0]!.relativePath,
            mediaType: files[0]!.mediaType,
            contentBase64: Buffer.from(bytes).toString("base64"),
          }],
          archiveBase64: null,
        };
        const request = {
          ...seed,
          previewToken: corpusIntakeRequestDigest({
            caseId: created.id,
            actorId: actor.id,
            origin: seed.origin,
            sourceLabel: seed.sourceLabel,
            privacyClass: seed.privacyClass,
            idempotencyKey: seed.idempotencyKey,
            files,
            archive: null,
          }),
        };
        const batches = await Promise.all([
          cases.commitCorpusIntake(created.id, actor, request, "test"),
          cases.commitCorpusIntake(created.id, actor, request, "test"),
        ]);
        expect(batches.map((batch) => parseCorpusIntakeBatch(batch).replayed).sort()).toEqual([
          false,
          true,
        ]);
        expect(new Set(batches.map((batch) => batch.id)).size).toBe(1);
        expect(new Set(batches.map((batch) => batch.items[0]?.artifactId)).size).toBe(1);
        expect((await pool.query("SELECT id FROM evidence_intake_batches")).rows).toHaveLength(1);
        expect((await pool.query("SELECT id FROM evidence_artifacts")).rows).toHaveLength(1);
        expect(await audit.list({ action: "corpus_intake_commit" })).toHaveLength(1);

        const changedSource = "changed synthetic concurrent source";
        const changed = {
          ...seed,
          sourceLabel: changedSource,
          previewToken: corpusIntakeRequestDigest({
            caseId: created.id,
            actorId: actor.id,
            origin: seed.origin,
            sourceLabel: changedSource,
            privacyClass: seed.privacyClass,
            idempotencyKey: seed.idempotencyKey,
            files,
            archive: null,
          }),
        };
        await expect(cases.commitCorpusIntake(created.id, actor, changed, "test"))
          .rejects.toThrow(/idempotency key already belongs/);
      } finally {
        await pool.end();
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("classifies concurrent distinct-key corpus commits sharing a digest after the digest lock", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-corpus-digest-"));
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(pool);
      const catalog = new CatalogService(new PgCatalogStore(pool), audit);
      const cases = new CaseService(evidence, audit, new PgCaseStore(pool), catalog);
      const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
      try {
        const created = await cases.createCase(actor, { title: "Concurrent digest fixture" }, "test");
        const bytes = new TextEncoder().encode("2026-08-25T00:00:00Z synthetic digest race\n");
        const makeRequest = (key: string, relativePath: string) => {
          const files = [{ relativePath, mediaType: "text/plain", bytes }];
          return {
            schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
            origin: "files" as const,
            sourceLabel: "synthetic concurrent digest source",
            privacyClass: "owner_only" as const,
            idempotencyKey: key,
            files: [{
              relativePath,
              mediaType: "text/plain",
              contentBase64: Buffer.from(bytes).toString("base64"),
            }],
            archiveBase64: null,
            previewToken: corpusIntakeRequestDigest({
              caseId: created.id,
              actorId: actor.id,
              origin: "files",
              sourceLabel: "synthetic concurrent digest source",
              privacyClass: "owner_only",
              idempotencyKey: key,
              files,
              archive: null,
            }),
          };
        };
        const batches = await Promise.all([
          cases.commitCorpusIntake(
            created.id,
            actor,
            makeRequest("batch-synthetic-digest-alice", "mailer/alice.log"),
            "test",
          ),
          cases.commitCorpusIntake(
            created.id,
            actor,
            makeRequest("batch-synthetic-digest-bob", "mailer/bob.log"),
            "test",
          ),
        ]);
        expect(
          batches.map((batch) => parseCorpusIntakeBatch(batch).items[0]?.duplicateDigest).sort(),
        ).toEqual([false, true]);
        expect((await pool.query("SELECT id FROM evidence_intake_batches")).rows).toHaveLength(2);
        expect((await pool.query("SELECT id FROM evidence_artifacts")).rows).toHaveLength(2);
        expect((await pool.query("SELECT DISTINCT content_hash FROM evidence_artifacts")).rows).toHaveLength(1);
      } finally {
        await pool.end();
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("reclaims unreferenced PostgreSQL promote residue after a crash before COMMIT", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-pending-write-"));
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const caseStore = new PgCaseStore(pool);
      evidence.addReferencedContentHashSource(() => caseStore.listReferencedContentHashes());
      const audit = new PgAuditStore(pool);
      const catalog = new CatalogService(new PgCatalogStore(pool), audit);
      const cases = new CaseService(evidence, audit, caseStore, catalog);
      const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
      try {
        const created = await cases.createCase(actor, { title: "PG promote crash fixture" }, "test");
        const keptBytes = new TextEncoder().encode("2026-08-25T00:00:00Z synthetic pg kept stall\n");
        const kept = await cases.addEvidence(
          created.id,
          actor,
          {
            kind: "log",
            filename: "kept-pg.log",
            mediaType: "text/plain",
            bytes: keptBytes,
            summary: "Synthetic PostgreSQL kept stall.",
            privacyClass: "share_safe",
          },
          "test",
        );
        const crashedBytes = new TextEncoder().encode("2026-08-25T00:01:00Z synthetic pg crash residue\n");
        const batch = await evidence.beginWriteBatch();
        const crashedMeta = await batch.put(crashedBytes, { contentType: "text/plain" });
        await batch.promote();
        await abandonWriteBatchForCrashTest(batch);
        expect((await pool.query("SELECT id FROM evidence_artifacts")).rows).toHaveLength(1);
        const recovered = await evidence.recoverUnreferencedWrites();
        expect(recovered.reclaimed).toEqual([crashedMeta.hash]);
        expect(await evidence.head(crashedMeta.hash)).toBeNull();
        expect(await evidence.verify(kept.artifact.contentHash ?? "")).toBe(true);
        expect(await caseStore.listReferencedContentHashes()).toEqual(
          new Set([kept.artifact.contentHash]),
        );
      } finally {
        await pool.end();
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("survives a new CaseService on the same database", async () => {
    await withDisposableDb(async (client) => {
      await migrateUp(client);
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-cases-"));
      const store = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(client);
      const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
      const catalog = new CatalogService(new PgCatalogStore(client), audit);
      try {
        const first = new CaseService(store, audit, new PgCaseStore(client), catalog);
        const created = await first.createCase(actor, {
          title: "Durable fixture",
          problemStatement: "Synthetic workers stop accepting queued tasks.",
          affectedParties: "Fixture operators",
          impact: "Synthetic tasks remain queued.",
          scope: "One fixture worker group.",
          openQuestions: ["Did queue pressure begin before the timeout?"],
        }, "test");
        const note = await first.addContribution(
          created.id,
          actor,
          { kind: "note", body: "revision 1" },
          "test",
        );
        await first.reviseContribution(created.id, note.id, actor, "revision 2", "test", 1);

        const second = new CaseService(store, audit, new PgCaseStore(client), catalog);
        const reloaded = await second.getCase(created.id, actor, false);
        expect(reloaded?.title).toBe("Durable fixture");
        expect(reloaded?.problemStatement).toBe("Synthetic workers stop accepting queued tasks.");
        expect(reloaded?.openQuestions).toEqual(["Did queue pressure begin before the timeout?"]);
        const chain = await second.provenance(created.id, note.id);
        expect(chain).toHaveLength(2);
        expect(chain[0]?.body).toBe("revision 1");
        expect(chain[1]?.body).toBe("revision 2");
        expect(chain[1]?.predecessorRevision).toBe(1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("rejects invalid-shaped hypothesis link ids before PostgreSQL lookup", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 2 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-hypothesis-links-"));
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(pool);
      const catalog = new CatalogService(new PgCatalogStore(pool), audit);
      const cases = new CaseService(evidence, audit, new PgCaseStore(pool), catalog);
      const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
      try {
        const primary = await cases.createCase(actor, { title: "Primary PG link fixture" }, "test");
        const secondary = await cases.createCase(actor, { title: "Secondary PG link fixture" }, "test");
        const crossCaseNote = await cases.addContribution(
          secondary.id,
          actor,
          { kind: "note", body: "Secondary case note" },
          "test",
        );
        const baselineTimeline = await cases.listTimeline(primary.id);
        const baselineAudits = await audit.list({ action: "contribution_create" });

        const rejectedLink = async (id: string): Promise<ContractViolation> => {
          try {
            await cases.addContribution(
              primary.id,
              actor,
              {
                kind: "hypothesis",
                body: "Must not persist",
                hypothesisLinks: [{ kind: "contribution", id }],
              },
              "test",
            );
          } catch (error) {
            expect(error).toBeInstanceOf(ContractViolation);
            return error as ContractViolation;
          }
          throw new Error("expected hypothesis link rejection");
        };

        const malformed = await rejectedLink("not-a-postgresql-uuid");
        const missing = await rejectedLink(MISSING_CONTRIBUTION_ID);
        const crossCase = await rejectedLink(crossCaseNote.id);
        expect(malformed.detail).toBe(missing.detail);
        expect(missing.detail).toBe(crossCase.detail);
        expect(await cases.listTimeline(primary.id)).toEqual(baselineTimeline);
        expect(await audit.list({ action: "contribution_create" })).toEqual(baselineAudits);
        expect((await pool.query(
          "SELECT id FROM contributions WHERE case_id = $1",
          [primary.id],
        )).rows).toEqual([]);
      } finally {
        await pool.end();
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("replays identical contribution writes and fails closed on stale revisions", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-contrib-"));
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(pool);
      const catalog = new CatalogService(new PgCatalogStore(pool), audit);
      const cases = new CaseService(evidence, audit, new PgCaseStore(pool), catalog);
      const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
      try {
        const created = await cases.createCase(actor, { title: "PG contribution integrity" }, "test");
        const first = await cases.addContribution(
          created.id,
          actor,
          { kind: "note", body: "Durable retry body.", idempotencyKey: "msg-syn-pg01" },
          "test",
        );
        const replay = await cases.addContribution(
          created.id,
          actor,
          { kind: "note", body: "Durable retry body.", idempotencyKey: "msg-syn-pg01" },
          "test",
        );
        expect(replay.id).toBe(first.id);
        await expect(
          cases.addContribution(
            created.id,
            actor,
            { kind: "note", body: "Different durable body.", idempotencyKey: "msg-syn-pg01" },
            "test",
          ),
        ).rejects.toBeInstanceOf(ContributionConflictError);

        const note = await cases.addContribution(
          created.id,
          actor,
          { kind: "note", body: "cas-1" },
          "test",
        );
        const results = await Promise.allSettled([
          cases.reviseContribution(created.id, note.id, actor, "cas-a", "test", 1),
          cases.reviseContribution(created.id, note.id, actor, "cas-b", "test", 1),
        ]);
        expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
        expect(results.filter(
          (row) => row.status === "rejected" && row.reason instanceof ContributionConflictError,
        )).toHaveLength(1);
        expect(await cases.provenance(created.id, note.id)).toHaveLength(2);
      } finally {
        await pool.end();
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("atomically commits or rolls back Situation state, timeline, and audit", async () => {
    await withDisposableDb(async (client) => {
      await migrateUp(client);
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-situation-"));
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(client);
      const catalog = new CatalogService(new PgCatalogStore(client), audit);
      const cases = new CaseService(evidence, audit, new PgCaseStore(client), catalog);
      const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
      try {
        const created = await cases.createCase(actor, { title: "Atomic situation fixture" }, "test");
        const updated = await cases.updateSituation(created.id, actor, {
          problemStatement: "The first durable statement.",
        }, 0, "test", "2026-08-24T12:00:00-05:00");
        expect(updated.situationVersion).toBe(1);
        expect((await cases.listTimeline(created.id)).at(-1)?.clientTime)
          .toBe("2026-08-24T17:00:00.000Z");
        expect(await audit.list({ action: "case_situation_update" })).toHaveLength(1);

        await client.query(`
          CREATE OR REPLACE FUNCTION reject_situation_audit() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.action = 'case_situation_update' THEN
              RAISE EXCEPTION 'synthetic situation audit failure';
            END IF;
            RETURN NEW;
          END;
          $$;
          CREATE TRIGGER reject_situation_audit_insert
            BEFORE INSERT ON audit_events
            FOR EACH ROW EXECUTE FUNCTION reject_situation_audit();
        `);
        await expect(cases.updateSituation(created.id, actor, {
          impact: "This must roll back with the failed audit.",
        }, 1, "test")).rejects.toThrow(/synthetic situation audit failure/);

        const afterFailure = await cases.getCase(created.id, actor, false);
        expect(afterFailure?.impact).toBe("");
        expect(afterFailure?.situationVersion).toBe(1);
        expect(await cases.listTimeline(created.id)).toHaveLength(2);
        expect(await audit.list({ action: "case_situation_update" })).toHaveLength(1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("enforces string-only open_questions in the PostgreSQL schema", async () => {
    await withDisposableDb(async (client) => {
      await migrateUp(client);
      const store = new PgCaseStore(client);
      await store.insertCase(caseRow());
      await expect(client.query(
        `UPDATE cases SET open_questions = $2::jsonb WHERE id = $1`,
        [CASE_ID, JSON.stringify(["valid", 7])],
      )).rejects.toThrow(/cases_open_questions_array_check/);
      expect((await store.getCase(CASE_ID))?.openQuestions).toEqual([]);
    });
  });
});

describe("memory snapshot persistence", () => {
  it("enforces intake-batch case ownership like PostgreSQL", async () => {
    const store = new MemoryCaseStore();
    const otherCaseId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const batchId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await store.insertCase(caseRow());
    await store.insertCase(caseRow(otherCaseId));
    await store.insertIntakeBatch({
      id: batchId,
      caseId: CASE_ID,
      idempotencyKey: "batch-synthetic-memory-fk",
      requestDigest: "a".repeat(64),
      origin: "files",
      sourceLabel: "synthetic source",
      privacyClass: "owner_only",
      createdAt: CREATED_AT,
      createdBy: "synthetic-actor",
      payloadJson: "{}",
    });
    const artifact: ArtifactRow = {
      id: "99999999-9999-4999-8999-999999999999",
      caseId: otherCaseId,
      kind: "log",
      filename: "synthetic.log",
      uri: null,
      mediaType: "text/plain",
      byteLength: 10,
      contentHash: "b".repeat(64),
      expectedHash: "b".repeat(64),
      verificationStatus: "verified",
      refId: null,
      privacyClass: "owner_only",
      summaryContributionId: null,
      uploaderId: "synthetic-actor",
      uploaderUsername: "synthetic-actor",
      sourceId: "00000000-0000-0000-0000-000000000001",
      relativePath: "synthetic.log",
      intakeBatchId: batchId,
    };
    await expect(store.insertArtifact(artifact)).rejects.toThrow(/does not belong/);
    await store.insertArtifact({ ...artifact, caseId: CASE_ID });
    expect((await store.getArtifact(artifact.id))?.intakeBatchId).toBe(batchId);
  });

  it("normalizes Situation fields missing from a legacy memory or SQLite case", async () => {
    const store = new MemoryCaseStore();
    const legacy = { ...caseRow() } as unknown as Record<string, unknown>;
    delete legacy.problemStatement;
    delete legacy.affectedParties;
    delete legacy.impact;
    delete legacy.scope;
    delete legacy.openQuestions;
    (store as unknown as { cases: Map<string, unknown> }).cases.set(CASE_ID, legacy);

    const restored = await store.getCase(CASE_ID);
    expect(restored?.problemStatement).toBe("");
    expect(restored?.affectedParties).toBe("");
    expect(restored?.impact).toBe("");
    expect(restored?.scope).toBe("");
    expect(restored?.openQuestions).toEqual([]);
  });

  it("round-trips fingerprint, lineage, privacy, fairness, status, timestamp, creator, and evidence", async () => {
    const store = new MemoryCaseStore();
    const snapshot = validSnapshot();
    await expectRoundTrip(store, snapshot);
  });

  it("accepts empty evidence and does not invent hashes or rewrite fairnessClass", async () => {
    const store = new MemoryCaseStore();
    const empty = validSnapshot({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      evidence: [],
      fairnessClass: "same_snapshot",
    });
    await store.insertSnapshot(empty);
    expect(await store.getSnapshot(empty.id)).toEqual(empty);

    const unknown = validSnapshot({
      id: "dddddddd-dddd-4ddd-8ddd-000000000001",
      evidence: [
        {
          evidenceId: "ev-missing",
          ordinal: 0,
          contentHash: null,
          expectedHash: null,
          verificationStatus: null,
          privacyClass: "owner_only",
        },
      ],
      fairnessClass: "unknown",
    });
    await store.insertSnapshot(unknown);
    expect((await store.getSnapshot(unknown.id))?.fairnessClass).toBe("unknown");

    const preserved = validSnapshot({
      id: "dddddddd-dddd-4ddd-8ddd-000000000002",
      protocolVersion: "triage-v1-preserved",
      evidence: unknown.evidence,
      fairnessClass: "same_snapshot",
    });
    await store.insertSnapshot(preserved);
    expect((await store.getSnapshot(preserved.id))?.fairnessClass).toBe("same_snapshot");
    expect((await store.getSnapshot(preserved.id))?.evidence[0]?.contentHash).toBeNull();
    expect((await store.getSnapshot(preserved.id))?.evidence[0]?.expectedHash).toBeNull();
  });

  it("rejects malformed inserts and injected stored documents", async () => {
    const store = new MemoryCaseStore();
    for (const { name, document } of corruptions()) {
      await expect(store.insertSnapshot(document as SnapshotRow), name).rejects.toThrow();
      storedSnapshots(store).set(String(document.id), structuredClone(document));
      await expect(store.getSnapshot(String(document.id)), `get ${name}`).rejects.toThrow();
      await expect(store.listSnapshotsByCase(CASE_ID), `list ${name}`).rejects.toThrow();
      storedSnapshots(store).delete(String(document.id));
    }
  });

  it("does not let retrieved-object mutation change stored state", async () => {
    const store = new MemoryCaseStore();
    const snapshot = validSnapshot();
    await store.insertSnapshot(snapshot);
    const got = (await store.getSnapshot(snapshot.id)) as SnapshotV1;
    got.createdBy = "eve";
    got.fairnessClass = "unknown";
    got.evidence[0]!.evidenceId = "mutated";
    got.evidence.push({
      evidenceId: "extra",
      ordinal: 9,
      contentHash: null,
      expectedHash: null,
      verificationStatus: null,
      privacyClass: "owner_only",
    });
    const listed = await store.listSnapshotsByCase(snapshot.caseId);
    listed[0]!.createdBy = "mallory";
    const again = await store.getSnapshot(snapshot.id);
    expect(again).toEqual(snapshot);
    expect(again).not.toBe(got);
  });
});

describe("atomic memory Situation updates", () => {
  it("allows one writer for a version and reports the other as a conflict", async () => {
    const store = new MemoryCaseStore();
    const audit = new MemoryAuditStore();
    await store.insertCase(caseRow());
    const mutation = (field: "problemStatement" | "impact", value: string) => ({
      id: CASE_ID,
      expectedVersion: 0,
      situation: {
        problemStatement: field === "problemStatement" ? value : "",
        affectedParties: "",
        impact: field === "impact" ? value : "",
        scope: "",
        openQuestions: [],
        investigationContext: null,
      },
      changedFields: [field],
      timeline: {
        kind: "case_situation_updated",
        actor: { id: "alice", username: "alice" },
        targetId: CASE_ID,
        clientTime: null,
        payload: { changedFields: [field] },
      },
      audit: {
        identity: "alice",
        action: "case_situation_update",
        target: CASE_ID,
        origin: "test",
        outcome: "success" as const,
      },
    });

    const results = await Promise.all([
      store.updateSituationAtomic(mutation("problemStatement", "writer one"), audit),
      store.updateSituationAtomic(mutation("impact", "writer two"), audit),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["conflict", "updated"]);
    expect((await store.getCase(CASE_ID))?.situationVersion).toBe(1);
    expect(await store.listTimeline(CASE_ID)).toHaveLength(1);
    expect(await audit.list({ action: "case_situation_update" })).toHaveLength(1);
  });

  it("rolls state and timeline back when audit persistence fails", async () => {
    const store = new MemoryCaseStore();
    await store.insertCase(caseRow());
    const failingAudit: AuditStore = {
      append: async () => {
        throw new Error("synthetic audit failure");
      },
      list: async () => [],
    };
    await expect(store.updateSituationAtomic({
      id: CASE_ID,
      expectedVersion: 0,
      situation: {
        problemStatement: "must roll back",
        affectedParties: "",
        impact: "",
        scope: "",
        openQuestions: [],
        investigationContext: null,
      },
      changedFields: ["problemStatement"],
      timeline: {
        kind: "case_situation_updated",
        actor: { id: "alice", username: "alice" },
        targetId: CASE_ID,
        clientTime: null,
        payload: { changedFields: ["problemStatement"] },
      },
      audit: {
        identity: "alice",
        action: "case_situation_update",
        target: CASE_ID,
        origin: "test",
        outcome: "success",
      },
    }, failingAudit)).rejects.toThrow("synthetic audit failure");
    expect((await store.getCase(CASE_ID))?.problemStatement).toBe("");
    expect((await store.getCase(CASE_ID))?.situationVersion).toBe(0);
    expect(await store.listTimeline(CASE_ID)).toEqual([]);
  });

  it("fails closed on malformed stored open-question elements", async () => {
    const store = new MemoryCaseStore();
    const malformed = { ...caseRow(), openQuestions: ["valid", 7] };
    (store as unknown as { cases: Map<string, unknown> }).cases.set(CASE_ID, malformed);
    await expect(store.getCase(CASE_ID)).rejects.toThrow(/array of strings/);
    await expect(store.listCases()).rejects.toThrow(/array of strings/);
  });
});

describe("PostgreSQL Situation SQL boundary", () => {
  it("locks and version-checks the case and commits state, timeline, and audit together", async () => {
    const statements: string[] = [];
    const db = {
      query: async (sql: string) => {
        statements.push(sql.replace(/\s+/g, " ").trim());
        if (sql.includes("SELECT situation_version")) {
          return { rows: [{ situation_version: 0 }], rowCount: 1 };
        }
        if (sql.includes("UPDATE cases") && sql.includes("situation_version = situation_version + 1")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("RETURNING last_seq")) {
          return { rows: [{ last_seq: 1 }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO audit_events")) {
          return {
            rows: [{
              id: 1,
              at: new Date(CREATED_AT),
              identity: "alice",
              action: "case_situation_update",
              target: CASE_ID,
              origin: "test",
              outcome: "success",
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM cases c")) {
          return { rows: [pgCaseRecord()], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    };
    const store = new PgCaseStore(db as never);
    const audit = new PgAuditStore(db as never);
    const result = await store.updateSituationAtomic({
      id: CASE_ID,
      expectedVersion: 0,
      situation: {
        problemStatement: "updated",
        affectedParties: "",
        impact: "",
        scope: "",
        openQuestions: ["What changed?"],
        investigationContext: null,
      },
      changedFields: ["problemStatement", "openQuestions"],
      timeline: {
        kind: "case_situation_updated",
        actor: { id: "alice", username: "alice" },
        targetId: CASE_ID,
        clientTime: "2026-08-24T17:00:00.000Z",
        payload: { changedFields: ["problemStatement", "openQuestions"] },
      },
      audit: {
        identity: "alice",
        action: "case_situation_update",
        target: CASE_ID,
        origin: "test",
        outcome: "success",
      },
    }, audit);

    expect(result.status).toBe("updated");
    expect(statements[0]).toBe("BEGIN");
    expect(statements.some((sql) => sql.includes("FOR UPDATE"))).toBe(true);
    expect(statements.some((sql) => sql.includes("WHERE id = $1 AND situation_version = $8")))
      .toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT INTO timeline_events"))).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT INTO audit_events"))).toBe(true);
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("rolls the PostgreSQL transaction back when audit insertion fails", async () => {
    const statements: string[] = [];
    const db = {
      query: async (sql: string) => {
        statements.push(sql.replace(/\s+/g, " ").trim());
        if (sql.includes("SELECT situation_version")) {
          return { rows: [{ situation_version: 0 }], rowCount: 1 };
        }
        if (sql.includes("RETURNING last_seq")) {
          return { rows: [{ last_seq: 1 }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO audit_events")) throw new Error("synthetic audit failure");
        return { rows: [], rowCount: 1 };
      },
    };
    const store = new PgCaseStore(db as never);
    const audit = new PgAuditStore(db as never);
    await expect(store.updateSituationAtomic({
      id: CASE_ID,
      expectedVersion: 0,
      situation: {
        problemStatement: "updated",
        affectedParties: "",
        impact: "",
        scope: "",
        openQuestions: [],
        investigationContext: null,
      },
      changedFields: ["problemStatement"],
      timeline: {
        kind: "case_situation_updated",
        actor: { id: "alice", username: "alice" },
        targetId: CASE_ID,
        clientTime: null,
        payload: {},
      },
      audit: {
        identity: "alice",
        action: "case_situation_update",
        target: CASE_ID,
        origin: "test",
        outcome: "success",
      },
    }, audit)).rejects.toThrow("synthetic audit failure");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("fails closed instead of coercing malformed PostgreSQL open-question elements", async () => {
    const db = {
      query: async () => ({ rows: [pgCaseRecord({ open_questions: ["valid", 7] })] }),
    };
    const store = new PgCaseStore(db as never);
    await expect(store.getCase(CASE_ID)).rejects.toThrow(/array of strings/);
    await expect(store.listCases()).rejects.toThrow(/array of strings/);
  });
});

describe.skipIf(!adminUrl())("postgres snapshot persistence", () => {
  it("round-trips a valid snapshot including empty evidence", async () => {
    await withDisposableDb(async (client) => {
      await migrateUp(client);
      const store = new PgCaseStore(client);
      await store.insertCase(caseRow());
      const snapshot = validSnapshot();
      await expectRoundTrip(store, snapshot);
      const empty = validSnapshot({
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        evidence: [],
      });
      await store.insertSnapshot(empty);
      expect(await store.getSnapshot(empty.id)).toEqual(empty);
    });
  });

  /**
   * The normalization revision distinguishes "this freeze observed corpus
   * revision N" from "this freeze had no corpus to observe". Both backends
   * must round-trip the same document, or an exported or portable snapshot
   * would differ by which store happened to serve it.
   */
  it("round-trips an observed corpus revision and an absent one identically to memory", async () => {
    await withDisposableDb(async (client) => {
      await migrateUp(client);
      const pg = new PgCaseStore(client);
      const memory = new MemoryCaseStore();
      await pg.insertCase(caseRow());

      const evidence = evidencePair();
      // `validSnapshot` only carries the fields it knows about, so the
      // observed-revision case is assembled here with a fingerprint that
      // actually covers the revision.
      const observed: SnapshotV1 = {
        ...validSnapshot({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", evidence }),
        normalizationRevision: 4,
        fingerprint: snapshotFingerprint({
          parentSnapshotId: null,
          evidence,
          visibility: "owner_only",
          protocolVersion: "triage-v1",
          normalizationRevision: 4,
        }),
      };
      await pg.insertSnapshot(observed);
      await memory.insertSnapshot(observed);
      expect(await pg.getSnapshot(observed.id)).toEqual(observed);
      expect(await pg.getSnapshot(observed.id)).toEqual(await memory.getSnapshot(observed.id));

      const unknown = validSnapshot({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
      expect("normalizationRevision" in unknown).toBe(false);
      await pg.insertSnapshot(unknown);
      await memory.insertSnapshot(unknown);
      const fromPg = await pg.getSnapshot(unknown.id);
      expect(fromPg).toEqual(unknown);
      expect(fromPg).toEqual(await memory.getSnapshot(unknown.id));
      expect("normalizationRevision" in (fromPg as object)).toBe(false);
    });
  });

  it("preserves stored fairnessClass and does not invent hashes", async () => {
    await withDisposableDb(async (client) => {
      await migrateUp(client);
      const store = new PgCaseStore(client);
      await store.insertCase(caseRow());
      const preserved = validSnapshot({
        evidence: [
          {
            evidenceId: "ev-missing",
            ordinal: 0,
            contentHash: null,
            expectedHash: null,
            verificationStatus: null,
            privacyClass: "owner_only",
          },
        ],
        fairnessClass: "same_snapshot",
      });
      await store.insertSnapshot(preserved);
      const got = await store.getSnapshot(preserved.id);
      expect(got?.fairnessClass).toBe("same_snapshot");
      expect(got?.evidence[0]?.contentHash).toBeNull();
      expect(got?.evidence[0]?.expectedHash).toBeNull();
    });
  });

  it("fails closed on SQL-injected corrupt rows", async () => {
    await withDisposableDb(async (client) => {
      await migrateUp(client);
      const store = new PgCaseStore(client);
      await store.insertCase(caseRow());
      for (const { name, document } of corruptions()) {
        let stored = false;
        try {
          await insertSqlSnapshot(client, document);
          stored = true;
        } catch {
          stored = false;
        }
        if (stored) {
          await expect(store.getSnapshot(String(document.id)), `get ${name}`).rejects.toThrow();
          await expect(store.listSnapshotsByCase(CASE_ID), `list ${name}`).rejects.toThrow();
        }
      }
    });
  });

  it("does not let retrieved-object mutation change stored postgres state", async () => {
    await withDisposableDb(async (client) => {
      await migrateUp(client);
      const store = new PgCaseStore(client);
      await store.insertCase(caseRow());
      const snapshot = validSnapshot();
      await store.insertSnapshot(snapshot);
      const got = (await store.getSnapshot(snapshot.id)) as SnapshotV1;
      got.createdBy = "eve";
      got.evidence[0]!.evidenceId = "mutated";
      const again = await store.getSnapshot(snapshot.id);
      expect(again).toEqual(snapshot);
    });
  });
});
