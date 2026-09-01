import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORPUS_INTAKE_COMMIT_SCHEMA_ID } from "@cd-collab/contracts";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  FilesystemEvidenceStore,
  sha256Hex,
  type EvidenceFinalizeOptions,
  type EvidenceStage,
  type EvidenceStore,
  type EvidenceStreamStage,
  type EvidenceWriteBatch,
} from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { CatalogService } from "../catalog/index.js";
import { corpusIntakeRequestDigest } from "../corpus-intake/index.js";
import { CaseService, MemoryCaseStore } from "./index.js";
import {
  CaseStoreCommitOutcomeUnknownError,
  PgCaseStore,
  withPgTransactionForTests,
} from "./store.js";

const actor = { id: "alice", username: "alice" };

class UnknownCommitStore extends MemoryCaseStore {
  unknownCommit = false;
  override async withAtomic<T>(
    operation: () => Promise<T>,
    audit?: Parameters<MemoryCaseStore["withAtomic"]>[1],
  ): Promise<T> {
    const result = await super.withAtomic(operation, audit);
    if (this.unknownCommit) throw new CaseStoreCommitOutcomeUnknownError();
    return result;
  }
}

class BoomArtifactStore extends MemoryCaseStore {
  override async insertArtifact(
    _row: Parameters<MemoryCaseStore["insertArtifact"]>[0],
  ): Promise<void> {
    throw new Error("artifact store failed");
  }
}

class UnknownPathCatalog extends CatalogService {
  rollbackCalls = 0;

  override async rollbackCaseInserts(): Promise<void> {
    this.rollbackCalls += 1;
    throw new Error("catalog rollback must not run after an unknown commit");
  }
}

class ThrowingRollbackCatalog extends CatalogService {
  override async rollbackCaseInserts(): Promise<void> {
    throw new Error("synthetic catalog cleanup failure");
  }
}

async function pendingJournalNames(root: string): Promise<string[]> {
  return (await readdir(join(root, ".pending")).catch(() => [] as string[]))
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function typedUnknown(error: unknown): asserts error is CaseStoreCommitOutcomeUnknownError {
  expect(error).toBeInstanceOf(CaseStoreCommitOutcomeUnknownError);
  expect(error).toMatchObject({
    name: "CaseStoreCommitOutcomeUnknownError",
    message: "case-store transaction commit outcome is unknown",
  });
  expect(String((error as Error).message)).not.toMatch(
    /postgres|password|connectionString|synthetic interrupted|sql/i,
  );
}

function instrumentBatch(store: FilesystemEvidenceStore): {
  events: string[];
  batch: () => EvidenceWriteBatch | null;
} {
  const events: string[] = [];
  let captured: EvidenceWriteBatch | null = null;
  const original = store.beginWriteBatch.bind(store);
  store.beginWriteBatch = async () => {
    const batch = await original();
    captured = batch;
    const promote = batch.promote.bind(batch);
    const rollback = batch.rollback.bind(batch);
    const finalize = batch.finalize.bind(batch);
    batch.promote = async () => {
      events.push("promote");
      return promote();
    };
    batch.rollback = async () => {
      events.push("rollback");
      return rollback();
    };
    batch.finalize = async (options?: EvidenceFinalizeOptions) => {
      events.push(options?.retainPendingJournal ? "finalize:retain" : "finalize");
      return finalize(options);
    };
    return batch;
  };
  return { events, batch: () => captured };
}

function failBatchFinalizeAfterCleanup(
  store: FilesystemEvidenceStore,
  failureMode: "once" | "always",
): string[] {
  const events: string[] = [];
  const original = store.beginWriteBatch.bind(store);
  store.beginWriteBatch = async () => {
    const batch = await original();
    const promote = batch.promote.bind(batch);
    const rollback = batch.rollback.bind(batch);
    const finalize = batch.finalize.bind(batch);
    let finalizeCalls = 0;
    batch.promote = async () => {
      events.push("promote");
      await promote();
    };
    batch.rollback = async () => {
      events.push("rollback");
      await rollback();
    };
    batch.finalize = async (options?: EvidenceFinalizeOptions) => {
      events.push(options?.retainPendingJournal ? "finalize:retain" : "finalize");
      finalizeCalls += 1;
      await finalize(options);
      if (failureMode === "always" || finalizeCalls === 1) {
        throw new Error("synthetic post-COMMIT finalize cleanup failure");
      }
    };
    return batch;
  };
  return events;
}

function instrumentStream(store: FilesystemEvidenceStore): {
  events: string[];
  stage: () => EvidenceStreamStage | null;
} {
  const events: string[] = [];
  let captured: EvidenceStreamStage | null = null;
  const original = store.stageStream.bind(store);
  store.stageStream = async (source, opts) => {
    const stage = await original(source, opts);
    captured = stage;
    const promote = stage.promote.bind(stage);
    const rollback = stage.rollback.bind(stage);
    const finalize = stage.finalize.bind(stage);
    stage.promote = async () => {
      events.push("promote");
      return promote();
    };
    stage.rollback = async () => {
      events.push("rollback");
      return rollback();
    };
    stage.finalize = async (options?: EvidenceFinalizeOptions) => {
      events.push(options?.retainPendingJournal ? "finalize:retain" : "finalize");
      return finalize(options);
    };
    return stage;
  };
  return { events, stage: () => captured };
}

async function* bytesSource(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

function stageOnlyEvidence(store: FilesystemEvidenceStore): EvidenceStore & {
  events: string[];
} {
  const events: string[] = [];
  const originalStage = store.stage.bind(store);
  const wrapped: EvidenceStore & { events: string[] } = {
    events,
    get writeCoordination() {
      return store.writeCoordination;
    },
    put: store.put.bind(store),
    stage: async (bytes, opts) => {
      const stage = await originalStage(bytes, opts);
      const tracked: EvidenceStage = {
        meta: stage.meta,
        commit: async () => {
          events.push("commit");
          await stage.commit();
        },
        rollback: async () => {
          events.push("rollback");
          await stage.rollback();
        },
        release: () => {
          events.push("release");
          stage.release();
        },
      };
      return tracked;
    },
    get: store.get.bind(store),
    head: store.head.bind(store),
    stageStream: store.stageStream.bind(store),
    openRead: store.openRead.bind(store),
    verify: store.verify.bind(store),
    putFileServerReference: store.putFileServerReference.bind(store),
    getFileServerReference: store.getFileServerReference.bind(store),
    verifyFileServerReference: store.verifyFileServerReference.bind(store),
    abandonFileServerReference: store.abandonFileServerReference.bind(store),
    restoreFileServerReference: store.restoreFileServerReference.bind(store),
    ping: store.ping.bind(store),
  };
  return wrapped;
}

function poolWithQuery(
  queryImpl: (sql: string) => Promise<{ rows: unknown[]; rowCount: number }>,
): {
  pool: Pool;
  statements: string[];
  releases: Array<Error | boolean | undefined>;
} {
  const statements: string[] = [];
  const releases: Array<Error | boolean | undefined> = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql.replace(/\s+/g, " ").trim());
      return queryImpl(sql);
    },
    release(err?: Error | boolean) {
      releases.push(err);
    },
  };
  const pool = Object.assign(Object.create(Pool.prototype), {
    connect: async () => client,
    query: client.query.bind(client),
  }) as Pool;
  return { pool, statements, releases };
}

describe("case-store commit outcome fencing", () => {
  it("throws a typed unknown result and skips ROLLBACK after COMMIT is attempted", async () => {
    const statements: string[] = [];
    const db = {
      query: async (sql: string) => {
        const text = sql.replace(/\s+/g, " ").trim();
        statements.push(text);
        if (text === "COMMIT") {
          throw new Error("synthetic interrupted COMMIT response");
        }
        return { rows: [], rowCount: 1 };
      },
    };
    const thrown = await withPgTransactionForTests(db, async () => "applied").then(
      () => {
        throw new Error("expected unknown commit outcome");
      },
      (error: unknown) => error,
    );
    typedUnknown(thrown);
    expect(statements).toEqual(["BEGIN", "COMMIT"]);
    expect(statements).not.toContain("ROLLBACK");
  });

  it("discards a PoolClient after an unknown COMMIT without issuing ROLLBACK", async () => {
    const { pool, statements, releases } = poolWithQuery(async (sql) => {
      if (sql.replace(/\s+/g, " ").trim() === "COMMIT") {
        throw new Error("synthetic interrupted COMMIT response");
      }
      return { rows: [], rowCount: 1 };
    });
    const store = new PgCaseStore(pool);
    const thrown = await store.withAtomic(async () => "applied").then(
      () => {
        throw new Error("expected unknown commit outcome");
      },
      (error: unknown) => error,
    );
    typedUnknown(thrown);
    expect(statements).toEqual(["BEGIN", "COMMIT"]);
    expect(statements).not.toContain("ROLLBACK");
    expect(releases).toHaveLength(1);
    expect(releases[0]).toBeInstanceOf(Error);
    expect((releases[0] as Error).message).toBe("case-store transaction commit outcome is unknown");
  });

  it("rolls back a pre-COMMIT failure and returns the original error", async () => {
    const { pool, statements, releases } = poolWithQuery(async () => ({ rows: [], rowCount: 1 }));
    const store = new PgCaseStore(pool);
    await expect(
      store.withAtomic(async () => {
        throw new Error("synthetic pre-commit mutation failure");
      }),
    ).rejects.toThrow("synthetic pre-commit mutation failure");
    expect(statements).toEqual(["BEGIN", "ROLLBACK"]);
    expect(releases).toEqual([undefined]);
  });

  it("releases a PoolClient cleanly after a successful COMMIT", async () => {
    const { pool, statements, releases } = poolWithQuery(async () => ({ rows: [], rowCount: 1 }));
    const store = new PgCaseStore(pool);
    await expect(store.withAtomic(async () => "ok")).resolves.toBe("ok");
    expect(statements).toEqual(["BEGIN", "COMMIT"]);
    expect(statements).not.toContain("ROLLBACK");
    expect(releases).toEqual([undefined]);
  });

  it("finalizes with a retained journal and never rolls evidence back on unknown COMMIT", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-commit-outcome-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const cases = new UnknownCommitStore();
    const instrument = instrumentBatch(evidence);
    const service = new CaseService(evidence, new MemoryAuditStore(), cases, new CatalogService());
    try {
      const created = await service.createCase(actor, { title: "Unknown commit batch fixture" }, "test");
      cases.unknownCommit = true;
      const bytes = new TextEncoder().encode("unknown-commit-batch\n");
      const thrown = await service.addEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "unknown-commit-batch.log",
          mediaType: "text/plain",
          bytes,
          summary: "Synthetic unknown commit batch.",
          privacyClass: "share_safe",
        },
        "test",
      ).then(
        () => {
          throw new Error("expected unknown commit outcome");
        },
        (error: unknown) => error,
      );
      typedUnknown(thrown);
      expect(instrument.events).toEqual(["promote", "finalize:retain"]);
      expect(instrument.events).not.toContain("rollback");
      expect(await evidence.verify(sha256Hex(bytes))).toBe(true);
      expect(await pendingJournalNames(root)).not.toEqual([]);
      const batch = instrument.batch();
      expect(batch).not.toBeNull();
      await batch?.finalize({ retainPendingJournal: true });
      await batch?.rollback();
      expect(await evidence.verify(sha256Hex(bytes))).toBe(true);
      expect(await pendingJournalNames(root)).not.toEqual([]);
      const next = await evidence.beginWriteBatch();
      await next.rollback();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let catalog cleanup replace an unknown COMMIT outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-commit-outcome-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const cases = new UnknownCommitStore();
    const catalog = new UnknownPathCatalog();
    const service = new CaseService(evidence, new MemoryAuditStore(), cases, catalog);
    try {
      const created = await service.createCase(actor, { title: "Unknown catalog cleanup fixture" }, "test");
      cases.unknownCommit = true;
      const bytes = new TextEncoder().encode("unknown-catalog-cleanup\n");
      await expect(
        service.addEvidence(
          created.id,
          actor,
          {
            kind: "log",
            filename: "unknown-catalog-cleanup.log",
            mediaType: "text/plain",
            bytes,
            summary: "Synthetic unknown catalog cleanup.",
          },
          "test",
        ),
      ).rejects.toBeInstanceOf(CaseStoreCommitOutcomeUnknownError);
      expect(catalog.rollbackCalls).toBe(0);
      expect(await catalog.findByIdentity(actor.id)).not.toBeNull();
      expect(await evidence.verify(sha256Hex(bytes))).toBe(true);
      expect(await pendingJournalNames(root)).not.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains a file-server reference after an unknown COMMIT outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-commit-outcome-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const cases = new UnknownCommitStore();
    const service = new CaseService(
      evidence,
      new MemoryAuditStore(),
      cases,
      new CatalogService(),
    );
    try {
      const created = await service.createCase(actor, { title: "Unknown reference fixture" }, "test");
      cases.unknownCommit = true;
      await expect(
        service.addEvidence(
          created.id,
          actor,
          {
            kind: "file_server_ref",
            filename: "remote.log",
            uri: "file:///srv/triage/remote.log",
            summary: "Synthetic file-server reference unknown commit.",
          },
          "test",
        ),
      ).rejects.toBeInstanceOf(CaseStoreCommitOutcomeUnknownError);
      const [artifact] = await cases.listArtifactsByCase(created.id);
      expect(artifact?.refId).toBeTruthy();
      expect(await evidence.getFileServerReference(artifact?.refId ?? "missing")).not.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls evidence back for a definite pre-COMMIT failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-commit-outcome-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const instrument = instrumentBatch(evidence);
    const service = new CaseService(
      evidence,
      new MemoryAuditStore(),
      new BoomArtifactStore(),
      new CatalogService(),
    );
    try {
      const created = await service.createCase(actor, { title: "Pre-commit rollback fixture" }, "test");
      const bytes = new TextEncoder().encode("pre-commit-rollback\n");
      await expect(
        service.addEvidence(
          created.id,
          actor,
          {
            kind: "log",
            filename: "pre-commit.log",
            mediaType: "text/plain",
            bytes,
            summary: "Synthetic pre-commit rollback.",
          },
          "test",
        ),
      ).rejects.toThrow("artifact store failed");
      expect(instrument.events).toEqual(["rollback"]);
      expect(instrument.events).not.toContain("finalize:retain");
      expect(await evidence.head(sha256Hex(bytes))).toBeNull();
      expect(await pendingJournalNames(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the original definite failure when catalog cleanup also fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-commit-outcome-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const service = new CaseService(
      evidence,
      new MemoryAuditStore(),
      new BoomArtifactStore(),
      new ThrowingRollbackCatalog(),
    );
    try {
      const created = await service.createCase(actor, { title: "Cleanup failure fixture" }, "test");
      await expect(
        service.addEvidence(
          created.id,
          actor,
          {
            kind: "log",
            filename: "cleanup-failure.log",
            mediaType: "text/plain",
            bytes: new TextEncoder().encode("cleanup-failure\n"),
            summary: "Synthetic cleanup failure.",
          },
          "test",
        ),
      ).rejects.toThrow("artifact store failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses ordinary finalize after a successful evidence commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-commit-outcome-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const instrument = instrumentBatch(evidence);
    const service = new CaseService(
      evidence,
      new MemoryAuditStore(),
      new MemoryCaseStore(),
      new CatalogService(),
    );
    try {
      const created = await service.createCase(actor, { title: "Normal finalize fixture" }, "test");
      const bytes = new TextEncoder().encode("normal-finalize\n");
      const uploaded = await service.addEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "normal-finalize.log",
          mediaType: "text/plain",
          bytes,
          summary: "Synthetic normal finalize.",
          privacyClass: "share_safe",
        },
        "test",
      );
      expect(instrument.events).toEqual(["promote", "finalize"]);
      expect(await evidence.verify(uploaded.artifact.contentHash ?? "")).toBe(true);
      expect(await pendingJournalNames(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries transient post-COMMIT batch cleanup without rolling committed evidence back", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-commit-outcome-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const events = failBatchFinalizeAfterCleanup(evidence, "once");
    const cases = new MemoryCaseStore();
    const service = new CaseService(evidence, new MemoryAuditStore(), cases, new CatalogService());
    try {
      const created = await service.createCase(actor, { title: "Batch cleanup retry" }, "test");
      const bytes = new TextEncoder().encode("batch-cleanup-retry\n");
      const uploaded = await service.addEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "batch-cleanup-retry.log",
          mediaType: "text/plain",
          bytes,
          summary: "Synthetic transient batch cleanup failure.",
          privacyClass: "share_safe",
        },
        "test",
      );
      expect(events).toEqual(["promote", "finalize", "finalize"]);
      expect(events).not.toContain("rollback");
      expect(await cases.getArtifact(uploaded.artifact.id)).not.toBeNull();
      expect(await evidence.verify(uploaded.artifact.contentHash ?? "")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a committed corpus batch when post-COMMIT cleanup keeps failing", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-commit-outcome-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const events = failBatchFinalizeAfterCleanup(evidence, "always");
    const cases = new MemoryCaseStore();
    const service = new CaseService(evidence, new MemoryAuditStore(), cases, new CatalogService());
    try {
      const created = await service.createCase(actor, { title: "Corpus cleanup recovery" }, "test");
      const bytes = new TextEncoder().encode("persistent-corpus-cleanup\n");
      const files = [{ relativePath: "mailer/persistent.log", mediaType: "text/plain", bytes }];
      const result = await service.commitCorpusIntake(
        created.id,
        actor,
        {
          schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
          origin: "files",
          sourceLabel: "persistent cleanup corpus",
          privacyClass: "owner_only",
          idempotencyKey: "batch-syn-persistent-cleanup-1",
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
            sourceLabel: "persistent cleanup corpus",
            privacyClass: "owner_only",
            idempotencyKey: "batch-syn-persistent-cleanup-1",
            files,
            archive: null,
          }),
        },
        "test",
      );
      expect(events).toEqual(["promote", "finalize", "finalize"]);
      expect(events).not.toContain("rollback");
      expect(await service.getCorpusIntakeBatch(created.id, result.id)).toMatchObject({ id: result.id });
      expect(await evidence.verify(sha256Hex(bytes))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("releases fallback stages without deleting canonical bytes on unknown COMMIT", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-commit-outcome-"));
    const files = new FilesystemEvidenceStore({ rootDir: root });
    const evidence = stageOnlyEvidence(files);
    const cases = new UnknownCommitStore();
    const service = new CaseService(evidence, new MemoryAuditStore(), cases, new CatalogService());
    try {
      const created = await service.createCase(actor, { title: "Unknown commit stage fixture" }, "test");
      cases.unknownCommit = true;
      const bytes = new TextEncoder().encode("unknown-commit-stage\n");
      const thrown = await service.addEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "unknown-commit-stage.log",
          mediaType: "text/plain",
          bytes,
          summary: "Synthetic unknown commit stage.",
          privacyClass: "share_safe",
        },
        "test",
      ).then(
        () => {
          throw new Error("expected unknown commit outcome");
        },
        (error: unknown) => error,
      );
      typedUnknown(thrown);
      expect(evidence.events.filter((event) => event === "rollback")).toEqual([]);
      expect(evidence.events.filter((event) => event === "commit")).toEqual(["commit"]);
      expect(evidence.events.filter((event) => event === "release")).toEqual(["release"]);
      expect(await files.verify(sha256Hex(bytes))).toBe(true);
      const later = await files.stage(bytes, { contentType: "text/plain" });
      later.release();
      later.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("protects corpus intake the same way as addEvidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-commit-outcome-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const cases = new UnknownCommitStore();
    const instrument = instrumentBatch(evidence);
    const service = new CaseService(evidence, new MemoryAuditStore(), cases, new CatalogService());
    try {
      const created = await service.createCase(actor, { title: "Unknown commit corpus fixture" }, "test");
      cases.unknownCommit = true;
      const bytes = new TextEncoder().encode("unknown-commit-corpus\n");
      const files = [{ relativePath: "mailer/unknown-commit-corpus.log", mediaType: "text/plain", bytes }];
      const thrown = await service.commitCorpusIntake(
        created.id,
        actor,
        {
          schemaId: CORPUS_INTAKE_COMMIT_SCHEMA_ID,
          origin: "files",
          sourceLabel: "synthetic unknown commit corpus",
          privacyClass: "owner_only",
          idempotencyKey: "batch-syn-unknown-commit-corpus-1",
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
            sourceLabel: "synthetic unknown commit corpus",
            privacyClass: "owner_only",
            idempotencyKey: "batch-syn-unknown-commit-corpus-1",
            files,
            archive: null,
          }),
        },
        "test",
      ).then(
        () => {
          throw new Error("expected unknown commit outcome");
        },
        (error: unknown) => error,
      );
      typedUnknown(thrown);
      expect(instrument.events).toEqual(["promote", "finalize:retain"]);
      expect(instrument.events).not.toContain("rollback");
      expect(await evidence.verify(sha256Hex(bytes))).toBe(true);
      expect(await pendingJournalNames(root)).not.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains a streamed journal and never rolls back on unknown COMMIT after promote", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-commit-outcome-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const cases = new UnknownCommitStore();
    const instrument = instrumentStream(evidence);
    const beginWriteBatch = evidence.beginWriteBatch.bind(evidence);
    const batchCalls: number[] = [];
    evidence.beginWriteBatch = async () => {
      batchCalls.push(1);
      return beginWriteBatch();
    };
    const service = new CaseService(evidence, new MemoryAuditStore(), cases, new CatalogService());
    try {
      const created = await service.createCase(actor, { title: "Unknown stream commit fixture" }, "test");
      cases.unknownCommit = true;
      const bytes = new TextEncoder().encode("unknown-commit-stream\n");
      const thrown = await service.addStreamedEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "unknown-commit-stream.log",
          mediaType: "text/plain",
          source: bytesSource(bytes),
          summary: "Synthetic unknown stream commit.",
          privacyClass: "share_safe",
          maxBytes: bytes.byteLength,
        },
        "test",
      ).then(
        () => {
          throw new Error("expected unknown commit outcome");
        },
        (error: unknown) => error,
      );
      typedUnknown(thrown);
      expect(batchCalls).toEqual([]);
      expect(instrument.events).toEqual(["promote", "finalize:retain"]);
      expect(instrument.events).not.toContain("rollback");
      expect(await evidence.verify(sha256Hex(bytes))).toBe(true);
      expect(await pendingJournalNames(root)).not.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries post-COMMIT streamed cleanup without rollback or an ambiguous failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-commit-outcome-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const events: string[] = [];
    const originalStage = evidence.stageStream.bind(evidence);
    evidence.stageStream = async (source, options) => {
      const stage = await originalStage(source, options);
      const promote = stage.promote.bind(stage);
      const rollback = stage.rollback.bind(stage);
      const finalize = stage.finalize.bind(stage);
      let finalizeCalls = 0;
      stage.promote = async () => {
        events.push("promote");
        await promote();
      };
      stage.rollback = async () => {
        events.push("rollback");
        await rollback();
      };
      stage.finalize = async (finalizeOptions?: EvidenceFinalizeOptions) => {
        events.push("finalize");
        finalizeCalls += 1;
        if (finalizeCalls === 1) throw new Error("synthetic transient finalize cleanup failure");
        await finalize(finalizeOptions);
      };
      return stage;
    };
    const service = new CaseService(
      evidence,
      new MemoryAuditStore(),
      new MemoryCaseStore(),
      new CatalogService(),
    );
    try {
      const created = await service.createCase(actor, { title: "Stream cleanup retry" }, "test");
      const bytes = new TextEncoder().encode("stream-cleanup-retry\n");
      const uploaded = await service.addStreamedEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "stream-cleanup-retry.log",
          mediaType: "text/plain",
          source: bytesSource(bytes),
          summary: "Synthetic transient cleanup failure.",
          privacyClass: "share_safe",
          maxBytes: bytes.byteLength,
        },
        "test",
      );
      expect(events).toEqual(["promote", "finalize", "finalize"]);
      expect(events).not.toContain("rollback");
      expect(await evidence.verify(uploaded.artifact.contentHash ?? "")).toBe(true);
      expect(await pendingJournalNames(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns committed streamed evidence when provider cleanup remains recoverable", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-commit-outcome-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const events: string[] = [];
    const originalStage = evidence.stageStream.bind(evidence);
    evidence.stageStream = async (source, options) => {
      const stage = await originalStage(source, options);
      const promote = stage.promote.bind(stage);
      const rollback = stage.rollback.bind(stage);
      stage.promote = async () => {
        events.push("promote");
        await promote();
      };
      stage.rollback = async () => {
        events.push("rollback");
        await rollback();
      };
      stage.finalize = async () => {
        events.push("finalize");
        throw new Error("synthetic persistent finalize cleanup failure");
      };
      return stage;
    };
    const service = new CaseService(
      evidence,
      new MemoryAuditStore(),
      new MemoryCaseStore(),
      new CatalogService(),
    );
    try {
      const created = await service.createCase(actor, { title: "Recoverable stream cleanup" }, "test");
      const bytes = new TextEncoder().encode("recoverable-stream-cleanup\n");
      const uploaded = await service.addStreamedEvidence(
        created.id,
        actor,
        {
          kind: "log",
          filename: "recoverable-stream-cleanup.log",
          mediaType: "text/plain",
          source: bytesSource(bytes),
          summary: "Synthetic persistent cleanup failure.",
          privacyClass: "share_safe",
          maxBytes: bytes.byteLength,
        },
        "test",
      );
      expect(events).toEqual(["promote", "finalize", "finalize"]);
      expect(events).not.toContain("rollback");
      expect(await evidence.verify(uploaded.artifact.contentHash ?? "")).toBe(true);
      expect(await pendingJournalNames(root)).not.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls streamed evidence back for a definite pre-COMMIT failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-commit-outcome-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const instrument = instrumentStream(evidence);
    const service = new CaseService(
      evidence,
      new MemoryAuditStore(),
      new BoomArtifactStore(),
      new CatalogService(),
    );
    try {
      const created = await service.createCase(actor, { title: "Stream pre-commit rollback fixture" }, "test");
      const bytes = new TextEncoder().encode("stream-pre-commit-rollback\n");
      await expect(
        service.addStreamedEvidence(
          created.id,
          actor,
          {
            kind: "log",
            filename: "stream-pre-commit.log",
            mediaType: "text/plain",
            source: bytesSource(bytes),
            summary: "Synthetic stream pre-commit rollback.",
            maxBytes: bytes.byteLength,
          },
          "test",
        ),
      ).rejects.toThrow("artifact store failed");
      expect(instrument.events).toEqual(["rollback"]);
      expect(instrument.events).not.toContain("finalize:retain");
      expect(instrument.events).not.toContain("promote");
      expect(await evidence.head(sha256Hex(bytes))).toBeNull();
      expect(await pendingJournalNames(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls streamed evidence back on expected hash mismatch before promotion", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-commit-outcome-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const instrument = instrumentStream(evidence);
    const service = new CaseService(
      evidence,
      new MemoryAuditStore(),
      new MemoryCaseStore(),
      new CatalogService(),
    );
    try {
      const created = await service.createCase(actor, { title: "Stream hash mismatch fixture" }, "test");
      const bytes = new TextEncoder().encode("stream-hash-mismatch\n");
      await expect(
        service.addStreamedEvidence(
          created.id,
          actor,
          {
            kind: "attachment",
            filename: "mismatch.bin",
            mediaType: "application/octet-stream",
            source: bytesSource(bytes),
            expectedHash: "0".repeat(64),
            summary: "Synthetic stream hash mismatch.",
            maxBytes: bytes.byteLength,
          },
          "test",
        ),
      ).rejects.toThrow("held evidence hash mismatch");
      expect(instrument.events).toEqual(["rollback"]);
      expect(instrument.events).not.toContain("promote");
      expect(await evidence.head(sha256Hex(bytes))).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
