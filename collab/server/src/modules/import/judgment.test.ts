import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXTERNAL_RUN_JUDGMENT_REQUEST_SCHEMA_ID,
  parseCase,
  parseExternalRun,
  parseExternalRunJudgmentConflict,
  parseExternalRunJudgmentList,
  parseExternalRunJudgmentRefused,
  parseExternalRunJudgmentSuccess,
  type ExternalRunJudgmentRequestV1,
} from "@cd-collab/contracts";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import {
  createAuthLog,
  createRateLimiter,
  defaultSessionPolicy,
  MapAuthAdapter,
  MemorySessionStore,
} from "../auth/index.js";
import { MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { CatalogService } from "../catalog/index.js";
import {
  CaseService,
  CaseStoreCommitOutcomeUnknownError,
  MemoryCaseStore,
  type Actor,
} from "../cases/index.js";
import { ImportService, MemoryRunStore } from "./index.js";
import {
  EXTERNAL_RUN_JUDGMENT_SERVER_LIMIT,
} from "./service.js";
import type {
  ExternalRunJudgmentRow,
  ExternalRunJudgmentSuccessIntent,
  FrozenRunRow,
} from "./store.js";

const ALICE: Actor = { id: "uid=alice,ou=people,dc=example,dc=test", username: "alice" };
const BOB: Actor = { id: "uid=bob,ou=people,dc=example,dc=test", username: "bob" };
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const MISSING_RUN_ID = "44444444-4444-4444-8444-444444444444";
const SOURCE_ID = "00000000-0000-0000-0000-000000000001";

const roleMap = [
  "cn=viewers,ou=groups,dc=example,dc=test=viewer",
  "cn=contributors,ou=groups,dc=example,dc=test=contributor",
  "cn=temporary-viewers,ou=groups,dc=example,dc=test=viewer",
].join(";");

function users() {
  return new Map([
    ["alice", {
      password: "fixture-alice-secret",
      identity: { ...ALICE, displayName: "Alice" },
      groups: ["cn=contributors,ou=groups,dc=example,dc=test"],
    }],
    ["bob", {
      password: "fixture-bob-secret",
      identity: { ...BOB, displayName: "Bob" },
      groups: ["cn=contributors,ou=groups,dc=example,dc=test"],
    }],
    ["viewer", {
      password: "fixture-viewer-secret",
      identity: {
        id: "uid=viewer,ou=people,dc=example,dc=test",
        username: "viewer",
        displayName: "Viewer",
      },
      groups: ["cn=viewers,ou=groups,dc=example,dc=test"],
    }],
    ["none", {
      password: "fixture-none-secret",
      identity: {
        id: "uid=none,ou=people,dc=example,dc=test",
        username: "none",
        displayName: "No grants",
      },
      groups: ["cn=temporary-viewers,ou=groups,dc=example,dc=test"],
    }],
  ]);
}

class UnknownOnceAfterCommitCaseStore extends MemoryCaseStore {
  unknown = false;

  override async withAtomic<T>(
    operation: () => Promise<T>,
    audit?: Parameters<MemoryCaseStore["withAtomic"]>[1],
  ): Promise<T> {
    const result = await super.withAtomic(operation, audit);
    if (this.unknown) {
      this.unknown = false;
      throw new CaseStoreCommitOutcomeUnknownError();
    }
    return result;
  }
}

class FailingJudgmentIntentStore extends MemoryRunStore {
  override async insertJudgmentSuccessIntent(
    _row: ExternalRunJudgmentSuccessIntent,
  ): Promise<void> {
    throw new Error("injected judgment intent failure");
  }
}

async function withApp(
  fn: (context: {
    app: Awaited<ReturnType<typeof buildApp>>;
    audit: MemoryAuditStore;
    cases: CaseService;
    caseStore: MemoryCaseStore;
    runs: MemoryRunStore;
    alice: string;
    bob: string;
    viewer: string;
    none: string;
  }) => Promise<void>,
  options: { caseStore?: MemoryCaseStore; runs?: MemoryRunStore } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-run-judgment-"));
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const caseStore = options.caseStore ?? new MemoryCaseStore();
  const runs = options.runs ?? new MemoryRunStore();
  const cases = new CaseService(evidence, audit, caseStore, catalog);
  const imports = new ImportService({ evidence, audit, cases, catalog, runs });
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(roleMap));
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root }),
    pool: null,
    store: evidence,
    domain: cases,
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
    const alice = await login(app, "alice", "fixture-alice-secret");
    const bob = await login(app, "bob", "fixture-bob-secret");
    const viewer = await login(app, "viewer", "fixture-viewer-secret");
    const none = await login(app, "none", "fixture-none-secret");
    roles.delete("cn=temporary-viewers,ou=groups,dc=example,dc=test");
    await fn({ app, audit, cases, caseStore, runs, alice, bob, viewer, none });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

function cookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? (value.split(";")[0] ?? "") : "";
}

async function login(
  app: Awaited<ReturnType<typeof buildApp>>,
  username: string,
  password: string,
): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  expect(response.statusCode, response.body).toBe(200);
  return cookie(response);
}

function storedRun(caseId: string, overrides: Partial<FrozenRunRow> = {}): FrozenRunRow {
  return {
    id: RUN_ID,
    caseId,
    contributionId: "22222222-2222-4222-8222-222222222222",
    sourceId: SOURCE_ID,
    outputHash: "a".repeat(64),
    outputText: "stored external output",
    promptHash: null,
    promptText: null,
    promptCompleteness: "unknown",
    outputCompleteness: "exact",
    workflowCompleteness: "unknown",
    evidenceVisibility: "unknown",
    snapshotBinding: null,
    visibilityNote: null,
    importerId: ALICE.id,
    importerUsername: ALICE.username,
    operatorId: ALICE.id,
    operatorUsername: ALICE.username,
    provider: null,
    model: null,
    version: null,
    claimedTraces: [],
    uncertainty: null,
    timing: null,
    cost: null,
    redacted: false,
    privacyClass: "share_safe",
    createdAt: "2026-09-09T12:00:00.000Z",
    ...overrides,
  };
}

function judgmentRequest(
  caseId: string,
  overrides: Partial<ExternalRunJudgmentRequestV1> = {},
): ExternalRunJudgmentRequestV1 {
  return {
    schemaId: EXTERNAL_RUN_JUDGMENT_REQUEST_SCHEMA_ID,
    caseId,
    runId: RUN_ID,
    expectedSequence: 0,
    idempotencyKey: "judgment-key-0001",
    judgment: "insufficient_evidence",
    links: [],
    rationale: "The imported output needs a human check.",
    ...overrides,
  };
}

async function seedCaseAndRun(context: {
  app: Awaited<ReturnType<typeof buildApp>>;
  cases: CaseService;
  caseStore: MemoryCaseStore;
  runs: MemoryRunStore;
  alice: string;
}, overrides: Partial<FrozenRunRow> = {}) {
  const created = parseCase(JSON.parse((await context.app.inject({
    method: "POST",
    url: "/api/cases",
    headers: { cookie: context.alice },
    payload: { title: "External judgment fixture" },
  })).body));
  const createdEvent = (await context.caseStore.listTimeline(created.id)).find(
    (event) => event.kind === "case_created",
  );
  if (!createdEvent) throw new Error("case creation did not record its authenticated actor");
  await context.runs.insert(storedRun(created.id, {
    ...overrides,
    importerId: overrides.importerId ?? createdEvent.actorId,
    importerUsername: overrides.importerUsername ?? createdEvent.actorUsername,
  }));
  return created;
}

function postJudgment(
  app: Awaited<ReturnType<typeof buildApp>>,
  session: string,
  caseId: string,
  payload: ExternalRunJudgmentRequestV1 | Record<string, unknown>,
  runId = RUN_ID,
) {
  return app.inject({
    method: "POST",
    url: `/api/cases/${caseId}/runs/${runId}/judgments`,
    headers: { cookie: session },
    payload,
  });
}

function getJudgments(
  app: Awaited<ReturnType<typeof buildApp>>,
  session: string,
  caseId: string,
  runId = RUN_ID,
) {
  return app.inject({
    method: "GET",
    url: `/api/cases/${caseId}/runs/${runId}/judgments`,
    headers: { cookie: session },
  });
}

describe("external run human judgment HTTP and memory core", () => {
  it("returns an empty versioned list, appends in order, and never changes legacy corroboration", async () => {
    await withApp(async (context) => {
      const created = await seedCaseAndRun(context);
      const empty = await getJudgments(context.app, context.alice, created.id);
      expect(empty.statusCode).toBe(200);
      expect(parseExternalRunJudgmentList(JSON.parse(empty.body)).judgments).toEqual([]);

      const firstResponse = await postJudgment(
        context.app,
        context.alice,
        created.id,
        judgmentRequest(created.id),
      );
      expect(firstResponse.statusCode).toBe(201);
      const first = parseExternalRunJudgmentSuccess(JSON.parse(firstResponse.body));
      expect(first).toMatchObject({
        replayed: false,
        applied: { seq: 1, actor: { username: ALICE.username } },
      });
      expect(first.applied.actor.id).toMatch(/^usr-/);
      expect(Object.keys(first.run).sort()).toEqual(["caseId", "createdAt", "id", "sourceId"]);

      const secondResponse = await postJudgment(
        context.app,
        context.alice,
        created.id,
        judgmentRequest(created.id, {
          expectedSequence: 1,
          idempotencyKey: "judgment-key-0002",
          rationale: null,
        }),
      );
      expect(secondResponse.statusCode).toBe(201);
      const list = parseExternalRunJudgmentList(JSON.parse((await getJudgments(
        context.app,
        context.alice,
        created.id,
      )).body));
      expect(list.judgments.map((row) => row.seq)).toEqual([1, 2]);
      const judgmentTimeline = (await context.caseStore.listTimeline(created.id)).filter(
        (row) => row.kind === "external_run_judgment_recorded",
      );
      expect(judgmentTimeline.map((row) => JSON.parse(row.payload))).toEqual([
        { sequence: 1, linkCount: 0 },
        { sequence: 2, linkCount: 0 },
      ]);
      expect(JSON.stringify(judgmentTimeline)).not.toMatch(/corroborates|contradicts/);
      expect((await context.runs.listCorroborations(RUN_ID))).toEqual([]);
      const run = parseExternalRun(JSON.parse((await context.app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/imports/${RUN_ID}`,
        headers: { cookie: context.alice },
      })).body));
      expect(run.corroborationState).toBe("unverified");
    });
  });

  it("binds replay to the actor and intent without duplicate timeline or audit effects", async () => {
    await withApp(async (context) => {
      const created = await seedCaseAndRun(context);
      await context.cases.addParticipant(created.id, ALICE, { identityId: BOB.id, username: BOB.username }, "test");
      const payload = judgmentRequest(created.id);
      expect((await postJudgment(context.app, context.alice, created.id, payload)).statusCode).toBe(201);
      const replayResponse = await postJudgment(context.app, context.alice, created.id, {
        ...payload,
        expectedSequence: 99,
      });
      expect(replayResponse.statusCode).toBe(200);
      expect(parseExternalRunJudgmentSuccess(JSON.parse(replayResponse.body)).replayed).toBe(true);

      const mismatch = await postJudgment(context.app, context.alice, created.id, {
        ...payload,
        rationale: "Different intent",
      });
      expect(mismatch.statusCode).toBe(409);
      expect(parseExternalRunJudgmentRefused(JSON.parse(mismatch.body)).reason)
        .toBe("idempotency_intent_mismatch");

      const bob = await postJudgment(context.app, context.bob, created.id, {
        ...payload,
        expectedSequence: 1,
      });
      expect(bob.statusCode).toBe(201);
      expect(parseExternalRunJudgmentSuccess(JSON.parse(bob.body)).applied.actor)
        .toMatchObject({ username: BOB.username });
      expect(await context.runs.listJudgments(RUN_ID)).toHaveLength(2);
      expect((await context.caseStore.listTimeline(created.id)).filter(
        (row) => row.kind === "external_run_judgment_recorded",
      )).toHaveLength(2);
      expect((await context.audit.list({ action: "external_run_judgment_recorded" })).filter(
        (row) => row.outcome === "success",
      )).toHaveLength(2);
    });
  });

  it("returns typed CAS, archived, links, privacy, and identity refusals without writes", async () => {
    await withApp(async (context) => {
      const created = await seedCaseAndRun(context);
      const malformed = await postJudgment(context.app, context.alice, created.id, {
        ...judgmentRequest(created.id),
        schemaId: "cd-collab.external_run_judgment_request.v999",
      });
      expect(malformed.statusCode).toBe(400);
      expect(JSON.parse(malformed.body)).toEqual({ error: "invalid" });
      expect(await context.runs.listJudgments(RUN_ID)).toEqual([]);
      const stale = await postJudgment(context.app, context.alice, created.id, judgmentRequest(created.id, {
        expectedSequence: 2,
      }));
      expect(stale.statusCode).toBe(409);
      expect(parseExternalRunJudgmentConflict(JSON.parse(stale.body))).toMatchObject({
        expectedSequence: 2,
        currentSequence: 0,
      });

      const links = await postJudgment(context.app, context.alice, created.id, judgmentRequest(created.id, {
        judgment: "corroborates",
        rationale: null,
      }));
      expect(links.statusCode).toBe(409);
      expect(parseExternalRunJudgmentRefused(JSON.parse(links.body)).reason).toBe("links_required");
      const emptyContradicts = await postJudgment(
        context.app,
        context.alice,
        created.id,
        judgmentRequest(created.id, {
          judgment: "contradicts",
          idempotencyKey: "judgment-empty-contradicts-01",
          rationale: null,
        }),
      );
      expect(emptyContradicts.statusCode).toBe(409);
      expect(parseExternalRunJudgmentRefused(JSON.parse(emptyContradicts.body)).reason)
        .toBe("links_required");

      const missingLink = await postJudgment(context.app, context.alice, created.id, judgmentRequest(created.id, {
        links: [{ kind: "contribution", id: "55555555-5555-4555-8555-555555555555" }],
      }));
      expect(missingLink.statusCode).toBe(404);

      const ownerOnly = await context.cases.addContribution(created.id, ALICE, {
        kind: "note",
        body: "Owner-only note",
        privacyClass: "owner_only",
      }, "test");
      const privacy = await postJudgment(context.app, context.alice, created.id, judgmentRequest(created.id, {
        links: [{ kind: "contribution", id: ownerOnly.id }],
      }));
      expect(privacy.statusCode).toBe(409);
      expect(parseExternalRunJudgmentRefused(JSON.parse(privacy.body)).reason).toBe("privacy_mismatch");

      await context.caseStore.updateCaseMeta({ id: created.id, legalHold: true });
      const held = await postJudgment(context.app, context.alice, created.id, judgmentRequest(created.id, {
        idempotencyKey: "judgment-held-0001",
      }));
      expect(held.statusCode).toBe(201);
      await context.caseStore.updateCaseMeta({ id: created.id, status: "archived" });
      const replay = await postJudgment(context.app, context.alice, created.id, judgmentRequest(created.id, {
        idempotencyKey: "judgment-held-0001",
        expectedSequence: 91,
      }));
      expect(replay.statusCode).toBe(200);
      const archived = await postJudgment(context.app, context.alice, created.id, judgmentRequest(created.id, {
        idempotencyKey: "judgment-archived-0001",
        expectedSequence: 1,
      }));
      expect(archived.statusCode).toBe(409);
      expect(parseExternalRunJudgmentRefused(JSON.parse(archived.body)).reason).toBe("case_archived");
      expect(await context.runs.listJudgments(RUN_ID)).toHaveLength(1);
    });
  });

  it("accepts visible share-safe artifact, contribution, and snapshot links", async () => {
    await withApp(async (context) => {
      const created = await seedCaseAndRun(context);
      const evidence = await context.cases.addEvidence(created.id, ALICE, {
        kind: "log",
        filename: "synthetic-run.log",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode("synthetic external run evidence\n"),
        summary: "Synthetic external run evidence",
        privacyClass: "share_safe",
      }, "test");
      const contribution = await context.cases.addContribution(created.id, ALICE, {
        kind: "note",
        body: "Synthetic human comparison note.",
        privacyClass: "share_safe",
      }, "test");
      const snapshot = await context.cases.createSnapshot(created.id, ALICE, {
        evidenceIds: [evidence.artifact.id],
        visibility: "share_safe",
      }, "test");
      const links = [
        { kind: "artifact" as const, id: evidence.artifact.id },
        { kind: "contribution" as const, id: contribution.id },
        { kind: "snapshot" as const, id: snapshot.id },
      ];
      const response = await postJudgment(
        context.app,
        context.alice,
        created.id,
        judgmentRequest(created.id, {
          judgment: "corroborates",
          links,
          idempotencyKey: "judgment-all-links-01",
        }),
      );
      expect(response.statusCode).toBe(201);
      expect(parseExternalRunJudgmentSuccess(JSON.parse(response.body)).applied.links)
        .toEqual(links);
      const timeline = (await context.caseStore.listTimeline(created.id)).filter(
        (event) => event.kind === "external_run_judgment_recorded",
      );
      expect(timeline.map((event) => JSON.parse(event.payload))).toEqual([
        { sequence: 1, linkCount: 3 },
      ]);
      const timelineJson = JSON.stringify(timeline);
      expect(timelineJson).not.toMatch(/corroborates|contradicts|insufficient_evidence|rationale/);
      for (const link of links) expect(timelineJson).not.toContain(link.id);
    });
  });

  it("enforces route identity, concealment, authentication, capability-before-read, and the list cap", async () => {
    await withApp(async (context) => {
      const created = await seedCaseAndRun(context, { privacyClass: "owner_only" });
      const createdEvent = (await context.caseStore.listTimeline(created.id)).find(
        (event) => event.kind === "case_created",
      );
      expect(createdEvent?.actorId).toBe(ALICE.id);
      expect(createdEvent?.actorId).not.toMatch(/^usr-/);
      const getSpy = vi.spyOn(context.runs, "get");
      const listSpy = vi.spyOn(context.runs, "listJudgments");
      const ownerGet = await getJudgments(context.app, context.alice, created.id);
      expect(ownerGet.statusCode).toBe(200);
      const ownerPost = await postJudgment(
        context.app,
        context.alice,
        created.id,
        judgmentRequest(created.id, { idempotencyKey: "judgment-owner-positive-01" }),
      );
      expect(ownerPost.statusCode).toBe(201);
      getSpy.mockClear();
      listSpy.mockClear();
      const forbiddenGet = await getJudgments(context.app, context.none, created.id);
      const forbiddenPost = await postJudgment(
        context.app,
        context.viewer,
        created.id,
        judgmentRequest(created.id),
      );
      expect(forbiddenGet.statusCode).toBe(403);
      expect(forbiddenPost.statusCode).toBe(403);
      expect(getSpy).not.toHaveBeenCalled();
      expect(listSpy).not.toHaveBeenCalled();

      const unauthenticated = await context.app.inject({
        method: "GET",
        url: `/api/cases/${created.id}/runs/${RUN_ID}/judgments`,
      });
      expect(unauthenticated.statusCode).toBe(401);
      const mismatched = await postJudgment(context.app, context.alice, created.id, {
        ...judgmentRequest(created.id),
        runId: MISSING_RUN_ID,
      });
      expect(mismatched.statusCode).toBe(400);
      expect(JSON.parse(mismatched.body)).toEqual({ error: "invalid" });
      expect((await getJudgments(context.app, context.alice, created.id, MISSING_RUN_ID)).statusCode)
        .toBe(404);
      expect((await getJudgments(context.app, context.bob, created.id)).statusCode).toBe(404);
      await context.cases.addParticipant(
        created.id,
        ALICE,
        { identityId: BOB.id, username: BOB.username },
        "test",
      );
      expect((await getJudgments(context.app, context.bob, created.id)).statusCode).toBe(404);
      expect((await postJudgment(
        context.app,
        context.bob,
        created.id,
        judgmentRequest(created.id),
      )).statusCode).toBe(404);

      const otherCase = parseCase(JSON.parse((await context.app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: context.alice },
        payload: { title: "Cross-case concealment fixture" },
      })).body));
      expect((await getJudgments(context.app, context.alice, otherCase.id, RUN_ID)).statusCode)
        .toBe(404);
      expect((await postJudgment(
        context.app,
        context.alice,
        otherCase.id,
        { ...judgmentRequest(otherCase.id), caseId: otherCase.id },
      )).statusCode).toBe(404);
    });
  });

  it("rejects a 1,025th judgment without changing the share-safe run history", async () => {
    await withApp(async (context) => {
      const created = await seedCaseAndRun(context);
      for (let index = 1; index <= EXTERNAL_RUN_JUDGMENT_SERVER_LIMIT; index += 1) {
        await context.runs.appendJudgment(judgmentRow(created.id, index));
      }
      const capped = await postJudgment(context.app, context.alice, created.id, judgmentRequest(created.id, {
        expectedSequence: EXTERNAL_RUN_JUDGMENT_SERVER_LIMIT,
        idempotencyKey: "judgment-at-cap-0001",
      }));
      expect(capped.statusCode).toBe(413);
      expect(JSON.parse(capped.body)).toEqual({ error: "judgment_limit_reached" });
      expect(await context.runs.listJudgments(RUN_ID)).toHaveLength(
        EXTERNAL_RUN_JUDGMENT_SERVER_LIMIT,
      );
    });
  });

  it("rolls back judgment, timeline, audit, and intent together on failure", async () => {
    const runs = new FailingJudgmentIntentStore();
    await withApp(async (context) => {
      const created = await seedCaseAndRun(context);
      const response = await postJudgment(
        context.app,
        context.alice,
        created.id,
        judgmentRequest(created.id),
      );
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body)).toEqual({ error: "internal" });
      expect(await context.runs.listJudgments(RUN_ID)).toEqual([]);
      expect((await context.caseStore.listTimeline(created.id)).filter(
        (row) => row.kind === "external_run_judgment_recorded",
      )).toEqual([]);
      expect((await context.audit.list({ action: "external_run_judgment_recorded" })).filter(
        (row) => row.outcome === "success",
      )).toEqual([]);
    }, { runs });
  });

  it("maps an unknown commit to 503 and resolves an exact retry from durable intent", async () => {
    const caseStore = new UnknownOnceAfterCommitCaseStore();
    await withApp(async (context) => {
      const created = await seedCaseAndRun(context);
      caseStore.unknown = true;
      const payload = judgmentRequest(created.id);
      const uncertain = await postJudgment(context.app, context.alice, created.id, payload);
      expect(uncertain.statusCode).toBe(503);
      expect(JSON.parse(uncertain.body)).toEqual({ error: "commit_outcome_unknown" });
      expect(await context.runs.listJudgments(RUN_ID)).toHaveLength(1);
      const retry = await postJudgment(context.app, context.alice, created.id, payload);
      expect(retry.statusCode).toBe(200);
      expect(parseExternalRunJudgmentSuccess(JSON.parse(retry.body)).replayed).toBe(true);
      expect(await context.runs.listJudgments(RUN_ID)).toHaveLength(1);
      expect((await context.caseStore.listTimeline(created.id)).filter(
        (row) => row.kind === "external_run_judgment_recorded",
      )).toHaveLength(1);
      expect((await context.audit.list({ action: "external_run_judgment_recorded" })).filter(
        (row) => row.outcome === "success",
      )).toHaveLength(1);
    }, { caseStore });
  });
});

function judgmentRow(caseId: string, seq: number): ExternalRunJudgmentRow {
  return {
    caseId,
    runId: RUN_ID,
    seq,
    judgment: "insufficient_evidence",
    actorId: ALICE.id,
    actorUsername: ALICE.username,
    links: [],
    rationale: null,
    recordedAt: new Date(1_780_000_000_000 + seq).toISOString(),
  };
}
