import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXTERNAL_RUN_IMPORT_REQUEST_SCHEMA_ID,
  SOURCE_CREATE_REQUEST_SCHEMA_ID,
  SOURCE_RETIRE_REQUEST_SCHEMA_ID,
  parseCase,
  parseExternalRun,
  parseExternalRunImportRefused,
  parseExternalRunImportSuccess,
  parseSource,
  parseSourceList,
  parseSourceMutationSuccess,
  parseTimeline,
  type ExternalRunImportRequestV1,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import {
  FilesystemEvidenceStore,
  abandonWriteBatchForCrashTest,
  sha256Hex,
  type EvidenceFinalizeOptions,
  type EvidenceStage,
  type EvidenceStore,
} from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { MapAuthAdapter } from "../auth/index.js";
import {
  createAuthLog,
  createRateLimiter,
  MemorySessionStore,
  defaultSessionPolicy,
} from "../auth/index.js";
import { MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { CatalogService } from "../catalog/index.js";
import {
  CaseService,
  CaseStoreCommitOutcomeUnknownError,
  MemoryCaseStore,
  runWithCaseQueryable,
} from "../cases/index.js";
import { ImportService, MemoryRunStore, PgRunStore } from "./index.js";
import { initialCorroborationState } from "./model.js";
import type { ExternalRunImportSuccessIntent, FrozenRunRow } from "./store.js";

const ALICE = "fixture-alice-secret";
const TRANSCRIPT = "The mailer pool is exhausted; workers time out after 30s.";
const PROMPT = "What is failing in the mailer?";
const INJECT = '<script>alert("xss")</script>';

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

async function pendingJournalNames(root: string): Promise<string[]> {
  return (await readdir(join(root, ".pending")).catch(() => [] as string[]))
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function stageOnlyEvidence(store: FilesystemEvidenceStore): EvidenceStore & {
  events: string[];
} {
  const events: string[] = [];
  const originalStage = store.stage.bind(store);
  return {
    events,
    get writeCoordination() {
      return store.writeCoordination;
    },
    put: store.put.bind(store),
    stage: async (bytes, options) => {
      const stage = await originalStage(bytes, options);
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
}

const roleMap =
  "cn=viewers,ou=groups,dc=example,dc=test=viewer;cn=contributors,ou=groups,dc=example,dc=test=contributor;cn=admins,ou=groups,dc=example,dc=test=admin";

function users() {
  return new Map([
    [
      "alice",
      {
        password: ALICE,
        identity: {
          id: "uid=alice,ou=people,dc=example,dc=test",
          username: "alice",
          displayName: "alice",
        },
        groups: ["cn=contributors,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "dave",
      {
        password: "fixture-dave-secret",
        identity: {
          id: "uid=dave,ou=people,dc=example,dc=test",
          username: "dave",
          displayName: "dave",
        },
        groups: ["cn=admins,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "bob",
      {
        password: "fixture-bob-secret",
        identity: {
          id: "uid=bob,ou=people,dc=example,dc=test",
          username: "bob",
          displayName: "bob",
        },
        groups: ["cn=contributors,ou=groups,dc=example,dc=test"],
      },
    ],
  ]);
}

async function withApp(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    audit: MemoryAuditStore;
    store: FilesystemEvidenceStore;
    caseStore: MemoryCaseStore;
    runs: MemoryRunStore;
    catalog: CatalogService;
    imports: ImportService;
  }) => Promise<void>,
  options: { caseStore?: MemoryCaseStore } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-import-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const caseStore = options.caseStore ?? new MemoryCaseStore();
  const runs = new MemoryRunStore();
  const domain = new CaseService(store, audit, caseStore, catalog);
  const imports = new ImportService({
    evidence: store,
    audit,
    cases: domain,
    catalog,
    runs,
  });
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(roleMap));
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root }),
    pool: null,
    store,
    domain,
    catalog,
    imports,
    security: {
      auth: {
        adapter: new MapAuthAdapter(users()),
        sessions: new MemorySessionStore(),
        policy: defaultSessionPolicy,
        roles,
        audit,
        log: createAuthLog(),
        limiter: createRateLimiter({ maxFails: 20, windowMs: 60_000 }),
        cookieSecure: false,
      },
      roles,
      audit,
    },
  });
  try {
    await fn({ app, audit, store, caseStore, runs, catalog, imports });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

function strictImportRequest(
  caseId: string,
  sourceId: string,
  overrides: Partial<ExternalRunImportRequestV1> = {},
): ExternalRunImportRequestV1 {
  return {
    schemaId: EXTERNAL_RUN_IMPORT_REQUEST_SCHEMA_ID,
    importMode: "manual",
    caseId,
    sourceId,
    expectedSourceRevision: 1,
    outputText: "strict imported output",
    promptText: "strict imported prompt",
    promptCompleteness: "exact",
    outputCompleteness: "exact",
    workflowCompleteness: "partial",
    evidenceVisibility: "unknown",
    evidenceArtifactIds: [],
    snapshotBinding: null,
    visibilityNote: null,
    operator: null,
    provider: "example-assistant",
    model: "fixture-model",
    version: "1",
    claimedTraces: [],
    uncertainty: null,
    timing: null,
    cost: null,
    redacted: false,
    privacyClass: "owner_only",
    idempotencyKey: "strict-import-0001",
    ...overrides,
  };
}

async function createVersionedSource(
  app: Awaited<ReturnType<typeof buildApp>>,
  adminCookie: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/catalog/sources",
    headers: { cookie: adminCookie },
    payload: {
      schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
      name: "Strict external assistant",
      kind: "external-tool",
      description: null,
      identityId: null,
      expectedRevision: 0,
      idempotencyKey: "strict-source-0001",
      ...overrides,
    },
  });
  expect(response.statusCode).toBe(201);
  return parseSourceMutationSuccess(JSON.parse(response.body)).applied;
}

function cookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? (value.split(";")[0] ?? "") : "";
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, username: string, password: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  return cookie(res);
}

function storedRun(overrides: Partial<FrozenRunRow> = {}): FrozenRunRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    caseId: "11111111-1111-4111-8111-111111111111",
    contributionId: "22222222-2222-4222-8222-222222222222",
    sourceId: "00000000-0000-0000-0000-000000000001",
    outputHash: "a".repeat(64),
    outputText: "stored output",
    promptHash: null,
    promptText: null,
    promptCompleteness: "unknown",
    outputCompleteness: "exact",
    workflowCompleteness: "unknown",
    evidenceVisibility: "unknown",
    snapshotBinding: null,
    visibilityNote: null,
    importerId: "local:alice",
    importerUsername: "alice",
    operatorId: "local:alice",
    operatorUsername: "alice",
    provider: null,
    model: null,
    version: null,
    claimedTraces: [],
    uncertainty: null,
    timing: null,
    cost: null,
    redacted: false,
    privacyClass: "owner_only",
    createdAt: "2026-09-05T12:00:00.000Z",
    ...overrides,
  };
}

function storedIntent(overrides: Partial<ExternalRunImportSuccessIntent> = {}): ExternalRunImportSuccessIntent {
  return {
    caseId: "11111111-1111-4111-8111-111111111111",
    actorId: "local:alice",
    idempotencyKey: "import-memory-01",
    requestDigest: "b".repeat(64),
    runId: "33333333-3333-4333-8333-333333333333",
    successJson: "{\"schemaId\":\"cd-collab.external_run_import_success.v1\"}",
    createdAt: "2026-09-05T12:00:00.000Z",
    ...overrides,
  };
}

function storedDbRun(evidenceArtifactIds: unknown[]): Record<string, unknown> {
  const row = storedRun({
    importMode: "manual",
    sourceRevision: 1,
    evidenceArtifactIds: evidenceArtifactIds as string[],
  });
  return {
    id: row.id,
    case_id: row.caseId,
    contribution_id: row.contributionId,
    source_id: row.sourceId,
    output_hash: row.outputHash,
    output_text: row.outputText,
    prompt_hash: row.promptHash,
    prompt_text: row.promptText,
    prompt_completeness: row.promptCompleteness,
    output_completeness: row.outputCompleteness,
    workflow_completeness: row.workflowCompleteness,
    evidence_visibility: row.evidenceVisibility,
    snapshot_binding: row.snapshotBinding,
    visibility_note: row.visibilityNote,
    importer_id: row.importerId,
    importer_username: row.importerUsername,
    operator_id: row.operatorId,
    operator_username: row.operatorUsername,
    provider: row.provider,
    model: row.model,
    version: row.version,
    claimed_traces: row.claimedTraces,
    uncertainty: row.uncertainty,
    timing: row.timing,
    cost: row.cost,
    redacted: row.redacted,
    privacy_class: row.privacyClass,
    created_at: row.createdAt,
    import_mode: row.importMode,
    source_revision: row.sourceRevision,
    evidence_artifact_ids: evidenceArtifactIds,
  };
}

describe("external-run durable store", () => {
  it("preserves legacy rows and isolates strict marker arrays", async () => {
    const store = new MemoryRunStore();
    await store.insert(storedRun());
    const evidenceArtifactIds = ["44444444-4444-4444-8444-444444444444"];
    await store.insert(storedRun({
      id: "55555555-5555-4555-8555-555555555555",
      importMode: "manual",
      sourceRevision: 7,
      evidenceArtifactIds,
    }));
    evidenceArtifactIds.push("66666666-6666-4666-8666-666666666666");

    expect(await store.get("33333333-3333-4333-8333-333333333333")).not.toHaveProperty(
      "importMode",
    );
    const strict = await store.get("55555555-5555-4555-8555-555555555555");
    expect(strict?.evidenceArtifactIds).toEqual([
      "44444444-4444-4444-8444-444444444444",
    ]);
    strict!.evidenceArtifactIds!.push("77777777-7777-4777-8777-777777777777");
    expect((await store.get(strict!.id))?.evidenceArtifactIds).toHaveLength(1);
  });

  it("rejects partial strict markers and duplicate replay intents", async () => {
    const store = new MemoryRunStore();
    await expect(store.insert(storedRun({ importMode: "manual" }))).rejects.toThrow(
      /markers must be present together/,
    );
    await expect(store.insert(storedRun({
      importMode: "manual",
      sourceRevision: 1,
      evidenceArtifactIds: Array.from({ length: 65 }, (_, index) => `artifact-${index}`),
    }))).rejects.toThrow(/evidence artifact ids/);
    const intent = storedIntent();
    await store.insertImportSuccessIntent(intent);
    await expect(store.insertImportSuccessIntent(intent)).rejects.toThrow(
      /success intent already exists/,
    );
  });

  it("rejects malformed, duplicate, and non-canonical strict evidence identities", async () => {
    const artifactA = "44444444-4444-4444-8444-444444444444";
    const artifactB = "55555555-5555-4555-8555-555555555555";
    const malformedLists: unknown[][] = [
      ["not-a-uuid"],
      [artifactA, artifactA],
      [artifactB, artifactA],
      ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"],
      [42],
    ];

    for (const evidenceArtifactIds of malformedLists) {
      const memory = new MemoryRunStore();
      await expect(memory.insert(storedRun({
        importMode: "manual",
        sourceRevision: 1,
        evidenceArtifactIds: evidenceArtifactIds as string[],
      }))).rejects.toThrow(/evidence artifact id/);

      const postgres = new PgRunStore({
        async query() {
          return { rows: [storedDbRun(evidenceArtifactIds)] };
        },
      } as never);
      await expect(postgres.get("33333333-3333-4333-8333-333333333333"))
        .rejects.toThrow(/evidence artifact id/);
    }
  });

  it("captures and restores strict rows and replay intents", async () => {
    const store = new MemoryRunStore();
    const run = storedRun({
      importMode: "manual",
      sourceRevision: 4,
      evidenceArtifactIds: [],
    });
    const intent = storedIntent();
    await store.insert(run);
    await store.insertImportSuccessIntent(intent);
    const snapshot = store.capture();
    await store.insert(storedRun({ id: "88888888-8888-4888-8888-888888888888" }));
    store.restore(snapshot);

    expect(await store.get(run.id)).toMatchObject({ importMode: "manual", sourceRevision: 4 });
    expect(await store.get("88888888-8888-4888-8888-888888888888")).toBeNull();
    expect(await store.lockImportSuccessIntent(
      intent.caseId,
      intent.actorId,
      intent.idempotencyKey,
    )).toEqual(intent);
  });

  it("requires the active case transaction for strict PostgreSQL writes and intent locks", async () => {
    const queries: string[] = [];
    const queryable = {
      async query(sql: string) {
        queries.push(sql);
        return { rows: [] };
      },
    };
    const store = new PgRunStore(queryable as never);
    const strict = storedRun({
      importMode: "manual",
      sourceRevision: 1,
      evidenceArtifactIds: [],
    });
    const intent = storedIntent();

    await expect(store.insert(strict)).rejects.toThrow(/atomic case boundary/);
    await expect(store.lockImportSuccessIntent(
      intent.caseId,
      intent.actorId,
      intent.idempotencyKey,
    )).rejects.toThrow(/atomic case boundary/);
    await expect(store.insertImportSuccessIntent(intent)).rejects.toThrow(/atomic case boundary/);
    expect(queries).toEqual([]);

    await runWithCaseQueryable(queryable as never, async () => {
      await store.insert(strict);
      expect(await store.lockImportSuccessIntent(
        intent.caseId,
        intent.actorId,
        intent.idempotencyKey,
      )).toBeNull();
      await store.insertImportSuccessIntent(intent);
    });
    expect(queries.some((sql) => sql.includes("INSERT INTO imported_runs"))).toBe(true);
    expect(queries.some((sql) => sql.includes("FOR UPDATE"))).toBe(true);
    expect(queries.some((sql) => sql.includes("external_run_import_success_intents"))).toBe(true);
  });
});

describe("external-run import", () => {
  it("atomically creates one strict import and replays the frozen intent without duplicate effects", async () => {
    await withApp(async ({ app, audit, runs }) => {
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", "fixture-dave-secret");
      const source = await createVersionedSource(app, dave);
      const created = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Strict import replay" },
      })).body));
      const payload = strictImportRequest(created.id, source.id);

      const freshResponse = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/imports`,
        headers: { cookie: alice },
        payload,
      });
      expect(freshResponse.statusCode).toBe(201);
      const fresh = parseExternalRunImportSuccess(JSON.parse(freshResponse.body));
      expect(fresh.replayed).toBe(false);
      expect(fresh.applied.importMode).toBe("manual");
      expect(fresh.applied.sourceRevision).toBe(source.revision);
      expect(fresh.applied.evidenceArtifactIds).toEqual([]);
      expect(fresh.contribution.caseId).toBe(created.id);

      const replayResponse = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/imports`,
        headers: { cookie: alice },
        payload: {
          ...payload,
          expectedSourceRevision: source.revision + 99,
          clientTime: "2026-09-05T12:00:00.000Z",
        },
      });
      expect(replayResponse.statusCode).toBe(200);
      const replay = parseExternalRunImportSuccess(JSON.parse(replayResponse.body));
      expect(replay.replayed).toBe(true);
      expect(replay.applied).toEqual(fresh.applied);
      expect(replay.contribution).toEqual(fresh.contribution);
      expect(await runs.listByCase(created.id)).toHaveLength(1);

      const changedResponse = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/imports`,
        headers: { cookie: alice },
        payload: { ...payload, outputText: "different strict intent" },
      });
      expect(changedResponse.statusCode).toBe(409);
      const changed = parseExternalRunImportRefused(JSON.parse(changedResponse.body));
      expect(changed.reason).toBe("idempotency_intent_mismatch");
      expect(changed.current).toBeNull();

      const timeline = parseTimeline(JSON.parse((await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/timeline`,
        headers: { cookie: alice },
      })).body));
      expect(timeline.events.filter((event) => event.kind === "external_run_imported")).toHaveLength(1);
      expect((await audit.list({ action: "external_run_import" })).filter(
        (event) => event.outcome === "success",
      )).toHaveLength(1);
    });
  });

  it("replays before mutable archive/source checks and returns typed strict refusals", async () => {
    await withApp(async ({ app, caseStore }) => {
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", "fixture-dave-secret");
      const source = await createVersionedSource(app, dave, {
        idempotencyKey: "strict-source-refusals",
      });
      const created = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Strict import refusal ordering" },
      })).body));
      const payload = strictImportRequest(created.id, source.id, {
        idempotencyKey: "strict-import-before-archive",
      });
      const first = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/imports`,
        headers: { cookie: alice },
        payload,
      });
      expect(first.statusCode).toBe(201);
      await caseStore.updateCaseMeta({ id: created.id, status: "archived" });

      const replay = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/imports`,
        headers: { cookie: alice },
        payload,
      });
      expect(replay.statusCode).toBe(200);
      expect(parseExternalRunImportSuccess(JSON.parse(replay.body)).replayed).toBe(true);

      const archived = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/imports`,
        headers: { cookie: alice },
        payload: { ...payload, idempotencyKey: "strict-import-after-archive" },
      });
      expect(archived.statusCode).toBe(409);
      expect(parseExternalRunImportRefused(JSON.parse(archived.body)).reason).toBe("case_archived");
    });
  });

  it("returns typed source revision, lifecycle, kind, and legacy-version refusals", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", "fixture-dave-secret");
      const created = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Strict source refusals" },
      })).body));
      const active = await createVersionedSource(app, dave, {
        idempotencyKey: "strict-source-active",
      });
      const request = strictImportRequest(created.id, active.id, {
        expectedSourceRevision: active.revision + 1,
        idempotencyKey: "strict-import-source-cas",
      });
      const mismatchResponse = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/imports`,
        headers: { cookie: alice },
        payload: request,
      });
      expect(mismatchResponse.statusCode).toBe(409);
      const mismatch = parseExternalRunImportRefused(JSON.parse(mismatchResponse.body));
      expect(mismatch.reason).toBe("source_revision_mismatch");
      expect(mismatch.current?.revision).toBe(active.revision);

      const retireResponse = await app.inject({
        method: "POST",
        url: `/api/catalog/sources/${active.id}/retire`,
        headers: { cookie: dave },
        payload: {
          schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
          sourceId: active.id,
          expectedRevision: active.revision,
          idempotencyKey: "strict-source-retire",
        },
      });
      expect(retireResponse.statusCode).toBe(200);
      const retiredRequest = strictImportRequest(created.id, active.id, {
        expectedSourceRevision: active.revision + 1,
        idempotencyKey: "strict-import-source-retired",
      });
      const retiredResponse = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/imports`,
        headers: { cookie: alice },
        payload: retiredRequest,
      });
      expect(retiredResponse.statusCode).toBe(409);
      expect(parseExternalRunImportRefused(JSON.parse(retiredResponse.body)).reason).toBe(
        "source_retired",
      );

      const human = await createVersionedSource(app, dave, {
        name: "Human observer",
        kind: "human",
        identityId: "uid=observer,ou=people,dc=example,dc=test",
        idempotencyKey: "strict-source-human",
      });
      const kindResponse = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/imports`,
        headers: { cookie: alice },
        payload: strictImportRequest(created.id, human.id, {
          idempotencyKey: "strict-import-source-human",
        }),
      });
      expect(kindResponse.statusCode).toBe(409);
      expect(parseExternalRunImportRefused(JSON.parse(kindResponse.body)).reason).toBe(
        "source_kind_not_importable",
      );

      const legacy = parseSource(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/catalog/sources",
        headers: { cookie: dave },
        payload: { name: "Legacy source", kind: "external-tool" },
      })).body));
      const legacyResponse = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/imports`,
        headers: { cookie: alice },
        payload: strictImportRequest(created.id, legacy.id, {
          idempotencyKey: "strict-import-source-legacy",
        }),
      });
      expect(legacyResponse.statusCode).toBe(409);
      expect(parseExternalRunImportRefused(JSON.parse(legacyResponse.body)).reason).toBe(
        "source_not_versioned",
      );
    });
  });

  it("conceals cross-case evidence and sanitizes strict request failures", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", "fixture-dave-secret");
      const source = await createVersionedSource(app, dave, {
        idempotencyKey: "strict-source-concealment",
      });
      const first = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Strict import evidence target" },
      })).body));
      const second = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Strict import other case" },
      })).body));
      const evidenceResponse = await app.inject({
        method: "POST",
        url: `/api/cases/${second.id}/evidence`,
        headers: { cookie: alice },
        payload: {
          kind: "attachment",
          filename: "other-case.txt",
          mediaType: "text/plain",
          contentBase64: Buffer.from("cross case evidence").toString("base64"),
          summary: "Cross-case strict import evidence",
        },
      });
      expect(evidenceResponse.statusCode).toBe(200);
      const artifactId = (JSON.parse(evidenceResponse.body) as { artifact: { id: string } }).artifact.id;
      const payload = strictImportRequest(first.id, source.id, {
        evidenceArtifactIds: [artifactId],
        evidenceVisibility: "importer_described",
        visibilityNote: "Explicitly cited evidence package.",
      });

      const concealed = await app.inject({
        method: "POST",
        url: `/api/cases/${first.id}/imports`,
        headers: { cookie: alice },
        payload,
      });
      expect(concealed.statusCode).toBe(404);
      expect(JSON.parse(concealed.body)).toEqual({ error: "not_found" });

      const wrongPath = await app.inject({
        method: "POST",
        url: `/api/cases/${second.id}/imports`,
        headers: { cookie: alice },
        payload: { ...payload, evidenceArtifactIds: [] },
      });
      expect(wrongPath.statusCode).toBe(400);
      expect(JSON.parse(wrongPath.body)).toEqual({ error: "invalid" });

      const malformed = await app.inject({
        method: "POST",
        url: `/api/cases/${first.id}/imports`,
        headers: { cookie: alice },
        payload: { schemaId: EXTERNAL_RUN_IMPORT_REQUEST_SCHEMA_ID, caseId: first.id },
      });
      expect(malformed.statusCode).toBe(400);
      expect(JSON.parse(malformed.body)).toEqual({ error: "invalid" });

      const oversized = await app.inject({
        method: "POST",
        url: `/api/cases/${first.id}/imports`,
        headers: { cookie: alice },
        payload: { ...strictImportRequest(first.id, source.id), outputText: "x".repeat(1_000_001) },
      });
      expect(oversized.statusCode).toBe(413);
      expect(JSON.parse(oversized.body)).toEqual({ error: "payload_too_large" });
    });
  });

  it("returns an exact unknown-outcome response and resolves a frozen retry from durable intent", async () => {
    const unknownStore = new UnknownCommitStore();
    await withApp(async ({ app, runs }) => {
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", "fixture-dave-secret");
      const source = await createVersionedSource(app, dave, {
        idempotencyKey: "strict-source-unknown",
      });
      const created = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Strict unknown commit" },
      })).body));
      const payload = strictImportRequest(created.id, source.id, {
        idempotencyKey: "strict-import-unknown",
      });
      unknownStore.unknownCommit = true;
      const uncertain = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/imports`,
        headers: { cookie: alice },
        payload,
      });
      expect(uncertain.statusCode).toBe(503);
      expect(JSON.parse(uncertain.body)).toEqual({ error: "commit_outcome_unknown" });
      expect(await runs.listByCase(created.id)).toHaveLength(1);

      unknownStore.unknownCommit = false;
      const retry = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/imports`,
        headers: { cookie: alice },
        payload,
      });
      expect(retry.statusCode).toBe(200);
      expect(parseExternalRunImportSuccess(JSON.parse(retry.body)).replayed).toBe(true);
      expect(await runs.listByCase(created.id)).toHaveLength(1);
    }, { caseStore: unknownStore });
  });

  it("imports a pasted transcript with hash round-trip, unknown fields, and distinct identities", async () => {
    await withApp(async ({ app, audit, store }) => {
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", "fixture-dave-secret");
      const bob = await login(app, "bob", "fixture-bob-secret");
      const tool = parseSource(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: "/api/catalog/sources",
              headers: { cookie: dave },
              payload: { name: "Web assistant", kind: "external-tool" },
            })
          ).body,
        ),
      );
      const created = parseCase(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: "/api/cases",
              headers: { cookie: alice },
              payload: { title: "Import fixture" },
            })
          ).body,
        ),
      );
      const membership = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/participants`,
        headers: { cookie: dave },
        payload: {
          identityId: "uid=bob,ou=people,dc=example,dc=test",
          username: "bob",
        },
      });
      expect(membership.statusCode).toBe(200);

      const imported = parseExternalRun(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${created.id}/imports`,
              headers: { cookie: alice },
              payload: {
                outputText: TRANSCRIPT,
                promptText: PROMPT,
                sourceId: tool.id,
                operatorId: "uid=operator,ou=people,dc=example,dc=test",
                operatorUsername: "operator",
                promptCompleteness: "exact",
                outputCompleteness: "exact",
                workflowCompleteness: "unknown",
                evidenceVisibility: "unknown",
                snapshotBinding: null,
                provider: "example-assistant",
                model: null,
                version: null,
                claimedTraces: ["mailer-pool"],
                uncertainty: "I am not sure about retries.",
              },
            })
          ).body,
        ),
      );
      expect(imported.outputHash).toBe(sha256Hex(new TextEncoder().encode(TRANSCRIPT)));
      expect(await store.verify(imported.outputHash)).toBe(true);
      expect(imported.outputText).toBe(TRANSCRIPT);
      expect(imported.promptText).toBe(PROMPT);
      expect(imported.workflowCompleteness).toBe("unknown");
      expect(imported.model).toBeNull();
      expect(imported.version).toBeNull();
      expect(imported.evidenceVisibility).toBe("unknown");
      expect(imported.snapshotBinding).toBeNull();
      expect(imported.importerUsername).toBe("alice");
      expect(imported.operatorUsername).toBe("operator");
      expect(imported.importerId).not.toBe(imported.operatorId);
      expect(imported.corroborationState).toBe("unverified");
      expect(imported.corroborationState).toBe(initialCorroborationState());
      expect(imported.privacyClass).toBe("owner_only");
      const bobList = await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/imports`,
        headers: { cookie: bob },
      });
      expect(bobList.statusCode).toBe(200);
      expect((JSON.parse(bobList.body) as { runs?: unknown[] }).runs).toHaveLength(0);
      const bobDetail = await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/imports/${imported.id}`,
        headers: { cookie: bob },
      });
      expect(bobDetail.statusCode).toBe(404);

      const described = parseExternalRun(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${created.id}/imports`,
              headers: { cookie: alice },
              payload: {
                outputText: "importer described visibility only",
                sourceId: tool.id,
                evidenceVisibility: "importer_described",
                visibilityNote: "Saw the on-call paste, no package.",
              },
            })
          ).body,
        ),
      );
      expect(described.evidenceVisibility).toBe("importer_described");
      expect(described.snapshotBinding).toBeNull();
      expect(described.promptText).toBeNull();
      expect(described.promptHash).toBeNull();
      expect(described.promptCompleteness).toBe("unknown");
      expect(described.operatorUsername).toBe("alice");
      expect(described.operatorId).toBe(described.importerId);

      for (const partialIdentity of [
        { operatorId: "uid=operator,ou=people,dc=example,dc=test" },
        { operatorUsername: "operator" },
      ]) {
        const rejected = await app.inject({
          method: "POST",
          url: `/api/cases/${created.id}/imports`,
          headers: { cookie: alice },
          payload: {
            outputText: "partial operator identity must fail closed",
            sourceId: tool.id,
            ...partialIdentity,
          },
        });
        expect(rejected.statusCode).toBe(400);
        expect(JSON.parse(rejected.body)).toEqual({
          error: "operatorId and operatorUsername must be provided together",
        });
      }

      const outputOnly = parseExternalRun(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${created.id}/imports`,
              headers: { cookie: alice },
              payload: {
                outputText: "output only",
                sourceId: tool.id,
                operatorId: "uid=operator,ou=people,dc=example,dc=test",
                operatorUsername: "operator",
                promptCompleteness: "unknown",
                outputCompleteness: "partial",
                workflowCompleteness: "unknown",
              },
            })
          ).body,
        ),
      );
      expect(outputOnly.promptText).toBeNull();
      expect(outputOnly.promptCompleteness).toBe("unknown");
      expect(outputOnly.outputCompleteness).toBe("partial");

      const rejectExactPrompt = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/imports`,
        headers: { cookie: alice },
        payload: {
          outputText: "x",
          sourceId: tool.id,
          operatorId: "op",
          operatorUsername: "op",
          promptCompleteness: "exact",
        },
      });
      expect(rejectExactPrompt.statusCode).toBe(400);

      const inject = parseExternalRun(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${created.id}/imports`,
              headers: { cookie: alice },
              payload: {
                outputText: INJECT,
                sourceId: tool.id,
                operatorId: "op",
                operatorUsername: "op",
              },
            })
          ).body,
        ),
      );
      expect(inject.outputText).toBe(INJECT);

      const note = JSON.parse(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${created.id}/contributions`,
            headers: { cookie: alice },
            payload: { kind: "note", body: "Log line matches the imported claim." },
          })
        ).body,
      ) as { id: string };

      const corroborated = parseExternalRun(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${created.id}/imports/${imported.id}/corroborate`,
              headers: { cookie: alice },
              payload: {
                state: "corroborated",
                links: [{ kind: "contribution", id: note.id }],
              },
            })
          ).body,
        ),
      );
      expect(corroborated.corroborationState).toBe("corroborated");
      expect(corroborated.outputHash).toBe(imported.outputHash);
      expect(corroborated.promptHash).toBe(imported.promptHash);
      expect(corroborated.snapshotBinding).toBe(imported.snapshotBinding);
      expect(corroborated.outputText).toBe(TRANSCRIPT);
      expect(corroborated.promptText).toBe(PROMPT);

      const contradicted = parseExternalRun(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${created.id}/imports/${described.id}/corroborate`,
              headers: { cookie: alice },
              payload: {
                state: "contradicted",
                links: [{ kind: "contribution", id: note.id }],
              },
            })
          ).body,
        ),
      );
      expect(contradicted.corroborationState).toBe("contradicted");

      await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/status`,
        headers: { cookie: dave },
        payload: { status: "resolved" },
      });
      const afterResolve = parseExternalRun(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/cases/${created.id}/imports/${imported.id}`,
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      expect(afterResolve.outputHash).toBe(imported.outputHash);
      expect(afterResolve.promptHash).toBe(imported.promptHash);
      expect(afterResolve.snapshotBinding).toBeNull();
      expect(afterResolve.outputText).toBe(TRANSCRIPT);

      const timeline = parseTimeline(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: `/api/cases/${created.id}/timeline`,
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      expect(timeline.events.some((e) => e.kind === "external_run_imported")).toBe(true);
      expect(timeline.events.some((e) => e.kind === "run_corroboration")).toBe(true);

      const audits = await audit.list();
      expect(audits.some((a) => a.action === "external_run_import")).toBe(true);
      expect(audits.some((a) => a.action === "run_corroboration")).toBe(true);
      expect(audits.every((a) => a.action !== "auto_verify_import")).toBe(true);
    });
  });

  it("rejects imports from a retired source while keeping it listed for attribution", async () => {
    await withApp(async ({ app }) => {
      const alice = await login(app, "alice", ALICE);
      const dave = await login(app, "dave", "fixture-dave-secret");
      const legacyTool = parseSource(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: "/api/catalog/sources",
              headers: { cookie: dave },
              payload: { name: "Legacy assistant", kind: "external-tool" },
            })
          ).body,
        ),
      );
      const activeTool = parseSource(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: "/api/catalog/sources",
              headers: { cookie: dave },
              payload: { name: "Current assistant", kind: "external-tool" },
            })
          ).body,
        ),
      );
      const created = parseCase(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: "/api/cases",
              headers: { cookie: alice },
              payload: { title: "Retired source fixture" },
            })
          ).body,
        ),
      );

      const retired = parseSource(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/catalog/sources/${legacyTool.id}/retire`,
              headers: { cookie: dave },
            })
          ).body,
        ),
      );
      expect(retired.id).toBe(legacyTool.id);
      expect(retired.lifecycle).toBe("retired");

      const listed = parseSourceList(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: "/api/catalog/sources",
              headers: { cookie: alice },
            })
          ).body,
        ),
      );
      const stillListed = listed.sources.find((s) => s.id === legacyTool.id);
      expect(stillListed?.lifecycle).toBe("retired");

      const rejected = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/imports`,
        headers: { cookie: alice },
        payload: {
          outputText: "output attributed to a retired tool",
          sourceId: legacyTool.id,
          operatorId: "op",
          operatorUsername: "op",
        },
      });
      expect(rejected.statusCode).toBe(400);
      expect(JSON.parse(rejected.body)).toEqual({ error: "source is retired" });

      const accepted = parseExternalRun(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/cases/${created.id}/imports`,
              headers: { cookie: alice },
              payload: {
                outputText: "output attributed to an active tool",
                sourceId: activeTool.id,
                operatorId: "op",
                operatorUsername: "op",
              },
            })
          ).body,
        ),
      );
      expect(accepted.sourceId).toBe(activeTool.id);

      const runs = JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/cases/${created.id}/imports`,
            headers: { cookie: alice },
          })
        ).body,
      ) as { runs: { id: string }[] };
      expect(runs.runs).toHaveLength(1);
      expect(runs.runs[0]?.id).toBe(accepted.id);
    });
  });

  it("never starts an imported run as corroborated or verified evidence", () => {
    expect(initialCorroborationState()).toBe("unverified");
    const src = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/corroborationState:\s*"corroborated"/);
    expect(src).not.toMatch(/corroborationState:\s*"verified"/);
    expect(src.includes("initialCorroborationState()")).toBe(true);
  });

  it("rolls back corroboration when timeline projection fails", async () => {
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
    const root = await mkdtemp(join(tmpdir(), "cd-collab-corroborate-boom-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const audit = new MemoryAuditStore();
    const catalog = new CatalogService(undefined, audit);
    const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
    const store = new InjectedFailureStore();
    const cases = new CaseService(evidence, audit, store, catalog);
    const runs = new MemoryRunStore();
    const imports = new ImportService({
      evidence,
      audit,
      cases,
      catalog,
      runs,
    });
    try {
      const created = await cases.createCase(actor, { title: "Corroboration atomic fixture" }, "test");
      const source = await catalog.ensureHumanSource(actor);
      const imported = await imports.importRun(
        created.id,
        actor,
        {
          outputText: "synthetic imported timeout transcript",
          sourceId: source.id,
          operatorId: "uid=operator,ou=people,dc=example,dc=test",
          operatorUsername: "operator",
        },
        "test",
        false,
      );
      const note = await cases.addContribution(
        created.id,
        actor,
        { kind: "note", body: "Synthetic corroborating observation." },
        "test",
      );
      store.failTimelineKind = "run_corroboration";
      await expect(
        imports.corroborate(
          created.id,
          imported.id,
          actor,
          { state: "corroborated", links: [{ kind: "contribution", id: note.id }] },
          "test",
          false,
        ),
      ).rejects.toThrow(/injected timeline failure:run_corroboration/);
      expect(await runs.listCorroborations(imported.id)).toEqual([]);
      expect((await cases.listTimeline(created.id)).some((event) => event.kind === "run_corroboration")).toBe(false);
      expect(await audit.list({ action: "run_corroboration" })).toEqual([]);
      expect((await imports.getRun(created.id, imported.id, actor, false))?.corroborationState).toBe("unverified");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back the contribution and staged bytes when run insert fails", async () => {
    class BoomRunStore extends MemoryRunStore {
      override async insert(): Promise<void> {
        throw new Error("run insert failed");
      }
    }
    const root = await mkdtemp(join(tmpdir(), "cd-collab-import-boom-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const audit = new MemoryAuditStore();
    const catalog = new CatalogService(undefined, audit);
    const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
    const cases = new CaseService(evidence, audit, new MemoryCaseStore(), catalog);
    const imports = new ImportService({
      evidence,
      audit,
      cases,
      catalog,
      runs: new BoomRunStore(),
    });
    try {
      const created = await cases.createCase(actor, { title: "Import rollback fixture" }, "test");
      const source = await catalog.ensureHumanSource(actor);
      const outputText = "synthetic imported timeout transcript";
      await expect(
        imports.importRun(
          created.id,
          actor,
          {
            outputText,
            sourceId: source.id,
            operatorId: "uid=operator,ou=people,dc=example,dc=test",
            operatorUsername: "operator",
          },
          "test",
          false,
        ),
      ).rejects.toThrow(/run insert failed/);
      expect(await cases.listContributions(created.id, actor, false)).toEqual([]);
      expect(await imports.listRuns(created.id, actor, false)).toEqual([]);
      expect(await evidence.head(sha256Hex(new TextEncoder().encode(outputText)))).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries transient post-COMMIT import cleanup without rolling bytes back", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-import-finalize-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const events = failBatchFinalizeAfterCleanup(evidence, "once");
    const audit = new MemoryAuditStore();
    const catalog = new CatalogService(undefined, audit);
    const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
    const caseStore = new MemoryCaseStore();
    const runs = new MemoryRunStore();
    const cases = new CaseService(evidence, audit, caseStore, catalog);
    const imports = new ImportService({ evidence, audit, cases, catalog, runs });
    try {
      const created = await cases.createCase(actor, { title: "Import cleanup retry" }, "test");
      const source = await catalog.ensureHumanSource(actor);
      const outputText = "synthetic import transient finalize failure";
      const imported = await imports.importRun(
        created.id,
        actor,
        {
          outputText,
          sourceId: source.id,
          operatorId: actor.id,
          operatorUsername: actor.username,
        },
        "test",
        false,
      );
      expect(events).toEqual(["promote", "finalize", "finalize"]);
      expect(events).not.toContain("rollback");
      expect(await runs.get(imported.id)).not.toBeNull();
      expect(await evidence.verify(imported.outputHash)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a committed import when post-COMMIT cleanup keeps failing", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-import-finalize-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const events = failBatchFinalizeAfterCleanup(evidence, "always");
    const audit = new MemoryAuditStore();
    const catalog = new CatalogService(undefined, audit);
    const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
    const caseStore = new MemoryCaseStore();
    const runs = new MemoryRunStore();
    const cases = new CaseService(evidence, audit, caseStore, catalog);
    const imports = new ImportService({ evidence, audit, cases, catalog, runs });
    try {
      const created = await cases.createCase(actor, { title: "Import cleanup recovery" }, "test");
      const source = await catalog.ensureHumanSource(actor);
      const outputText = "synthetic import persistent finalize failure";
      const imported = await imports.importRun(
        created.id,
        actor,
        {
          outputText,
          sourceId: source.id,
          operatorId: actor.id,
          operatorUsername: actor.username,
        },
        "test",
        false,
      );
      expect(events).toEqual(["promote", "finalize", "finalize"]);
      expect(events).not.toContain("rollback");
      expect(await runs.get(imported.id)).not.toBeNull();
      expect(await evidence.verify(imported.outputHash)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains promoted import bytes and the recovery journal on an unknown COMMIT", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-import-unknown-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const events = failBatchFinalizeAfterCleanup(evidence, "always");
    const audit = new MemoryAuditStore();
    const catalog = new CatalogService(undefined, audit);
    const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
    const caseStore = new UnknownCommitStore();
    const runs = new MemoryRunStore();
    const cases = new CaseService(evidence, audit, caseStore, catalog);
    const imports = new ImportService({ evidence, audit, cases, catalog, runs });
    try {
      const created = await cases.createCase(actor, { title: "Unknown import commit" }, "test");
      const source = await catalog.ensureHumanSource(actor);
      const outputText = "synthetic import unknown commit";
      const outputHash = sha256Hex(new TextEncoder().encode(outputText));
      caseStore.unknownCommit = true;
      await expect(
        imports.importRun(
          created.id,
          actor,
          {
            outputText,
            sourceId: source.id,
            operatorId: actor.id,
            operatorUsername: actor.username,
          },
          "test",
          false,
        ),
      ).rejects.toBeInstanceOf(CaseStoreCommitOutcomeUnknownError);
      expect(events).toEqual(["promote", "finalize:retain"]);
      expect(events).not.toContain("rollback");
      expect(await runs.listByCase(created.id)).toHaveLength(1);
      expect(await evidence.verify(outputHash)).toBe(true);
      expect(await pendingJournalNames(root)).not.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("releases stage-only import bytes without rollback on an unknown COMMIT", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-import-unknown-stage-"));
    const files = new FilesystemEvidenceStore({ rootDir: root });
    const evidence = stageOnlyEvidence(files);
    const audit = new MemoryAuditStore();
    const catalog = new CatalogService(undefined, audit);
    const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
    const caseStore = new UnknownCommitStore();
    const runs = new MemoryRunStore();
    const cases = new CaseService(evidence, audit, caseStore, catalog);
    const imports = new ImportService({ evidence, audit, cases, catalog, runs });
    try {
      const created = await cases.createCase(actor, { title: "Unknown stage import commit" }, "test");
      const source = await catalog.ensureHumanSource(actor);
      const outputText = "synthetic stage-only import unknown commit";
      const outputHash = sha256Hex(new TextEncoder().encode(outputText));
      caseStore.unknownCommit = true;
      await expect(
        imports.importRun(
          created.id,
          actor,
          {
            outputText,
            sourceId: source.id,
            operatorId: actor.id,
            operatorUsername: actor.username,
          },
          "test",
          false,
        ),
      ).rejects.toBeInstanceOf(CaseStoreCommitOutcomeUnknownError);
      expect(evidence.events).toEqual(["commit", "release"]);
      expect(evidence.events).not.toContain("rollback");
      expect(await runs.listByCase(created.id)).toHaveLength(1);
      expect(await files.verify(outputHash)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps imported run bytes when recovering unreferenced promote residue", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-import-pending-write-"));
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const audit = new MemoryAuditStore();
    const catalog = new CatalogService(undefined, audit);
    const actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
    const caseStore = new MemoryCaseStore();
    const runs = new MemoryRunStore();
    evidence.addReferencedContentHashSource(() => caseStore.listReferencedContentHashes());
    evidence.addReferencedContentHashSource(() => runs.listReferencedContentHashes());
    const cases = new CaseService(evidence, audit, caseStore, catalog);
    const imports = new ImportService({
      evidence,
      audit,
      cases,
      catalog,
      runs,
    });
    try {
      const created = await cases.createCase(actor, { title: "Import hash recovery fixture" }, "test");
      const source = await catalog.ensureHumanSource(actor);
      const outputText = "synthetic imported mailer timeout transcript";
      const imported = await imports.importRun(
        created.id,
        actor,
        {
          outputText,
          sourceId: source.id,
          operatorId: "uid=operator,ou=people,dc=example,dc=test",
          operatorUsername: "operator",
        },
        "test",
        false,
      );
      const crashedBytes = new TextEncoder().encode("2026-08-25T00:01:00Z synthetic import crash residue\n");
      const batch = await evidence.beginWriteBatch();
      const crashedMeta = await batch.put(crashedBytes, { contentType: "text/plain" });
      await batch.promote();
      await abandonWriteBatchForCrashTest(batch);
      const recovered = await evidence.recoverUnreferencedWrites();
      expect(recovered.reclaimed).toEqual([crashedMeta.hash]);
      expect(await evidence.head(crashedMeta.hash)).toBeNull();
      expect(await evidence.verify(imported.outputHash)).toBe(true);
      expect(await runs.listReferencedContentHashes()).toEqual(new Set([imported.outputHash]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
