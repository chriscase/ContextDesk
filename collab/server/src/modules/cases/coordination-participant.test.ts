import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTH_ERROR_SCHEMA_ID,
  INVESTIGATION_COORDINATION_ACTION_REQUEST_SCHEMA_ID,
  parseCase,
  parseInvestigationCoordinationActionRefused,
  parseInvestigationCoordinationActionSuccess,
  parseInvestigationCoordinationChanged,
  type InvestigationCoordinationAction,
  type InvestigationCoordinationActionRequestV1,
} from "@cd-collab/contracts";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import {
  createAuthLog,
  createRateLimiter,
  MapAuthAdapter,
  MemorySessionStore,
  defaultSessionPolicy,
} from "../auth/index.js";
import { MemoryGroupRoleStore, MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { CatalogService } from "../catalog/index.js";
import { MemoryLocalGrantStore } from "../people/index.js";
import {
  CaseService,
  CaseStoreCommitOutcomeUnknownError,
  InvestigationCoordinationChangedError,
  type Actor,
} from "./service.js";
import { MemoryCaseStore } from "./store.js";

const ALICE_PASSWORD = "fixture-alice-secret";
const ERIN_PASSWORD = "fixture-erin-secret";
const CAROL_PASSWORD = "fixture-carol-secret";
const MISSING_CASE_ID = "30000000-0000-4000-8000-000000000003";
const MISSING_IDENTITY_ID = "uid=missing,ou=people,dc=example,dc=test";

const aliceActor: Actor = {
  id: "uid=alice,ou=people,dc=example,dc=test",
  username: "alice",
};
const erinActor: Actor = {
  id: "uid=erin,ou=people,dc=example,dc=test",
  username: "erin",
};
const eveActor: Actor = {
  id: "uid=eve,ou=people,dc=example,dc=test",
  username: "eve",
};

function asParticipant(actor: Actor): { identityId: string; username: string } {
  return { identityId: actor.id, username: actor.username };
}

function users() {
  return new Map([
    [
      "alice",
      {
        password: ALICE_PASSWORD,
        identity: {
          id: aliceActor.id,
          username: "alice",
          displayName: "alice",
        },
        groups: ["cn=contributors,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "erin",
      {
        password: ERIN_PASSWORD,
        identity: {
          id: erinActor.id,
          username: "erin",
          displayName: "erin",
        },
        groups: ["cn=case-leads,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "eve",
      {
        password: "fixture-eve-secret",
        identity: {
          id: eveActor.id,
          username: "eve",
          displayName: "eve",
        },
        groups: ["cn=contributors,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "carol",
      {
        password: CAROL_PASSWORD,
        identity: {
          id: "uid=carol,ou=people,dc=example,dc=test",
          username: "carol",
          displayName: "carol",
        },
        groups: ["cn=viewers,ou=groups,dc=example,dc=test"],
      },
    ],
  ]);
}

const roleMap = [
  "cn=viewers,ou=groups,dc=example,dc=test=viewer",
  "cn=contributors,ou=groups,dc=example,dc=test=contributor",
  "cn=case-leads,ou=groups,dc=example,dc=test=case-lead",
].join(";");

function request(
  investigationId: string,
  action: InvestigationCoordinationAction,
  idempotencyKey: string,
  expectedRevision: number,
  targetIdentityId?: string,
): InvestigationCoordinationActionRequestV1 {
  return {
    schemaId: INVESTIGATION_COORDINATION_ACTION_REQUEST_SCHEMA_ID,
    investigationId,
    action,
    ...(targetIdentityId ? { targetIdentityId } : {}),
    expectedRevision,
    idempotencyKey,
  };
}

function parseSuccess(raw: string) {
  return parseInvestigationCoordinationActionSuccess(JSON.parse(raw));
}

function participantIds(row: { participants: { identityId: string }[] }): string[] {
  return row.participants.map((participant) => participant.identityId).sort();
}

async function expectUnchangedCase(
  caseStore: MemoryCaseStore,
  caseId: string,
  before: {
    status: string;
    legalHold: boolean;
    participants: string[];
    coordination: unknown;
    timeline: number;
  },
) {
  const row = await caseStore.getCase(caseId);
  expect(row).toMatchObject({ status: before.status, legalHold: before.legalHold });
  expect(participantIds(row!)).toEqual(before.participants);
  expect(await caseStore.getInvestigationCoordination(caseId)).toEqual(before.coordination);
  expect((await caseStore.listTimeline(caseId)).filter(
    (event) => event.kind === "investigation_coordination_changed",
  )).toHaveLength(before.timeline);
}

class UnknownOnceAfterCommitCaseStore extends MemoryCaseStore {
  failAfterNextCommit = false;
  atomicCalls = 0;

  override async withAtomic<T>(
    operation: () => Promise<T>,
    audit?: Parameters<MemoryCaseStore["withAtomic"]>[1],
  ): Promise<T> {
    this.atomicCalls += 1;
    const result = await super.withAtomic(operation, audit);
    if (this.failAfterNextCommit) {
      this.failAfterNextCommit = false;
      throw new CaseStoreCommitOutcomeUnknownError();
    }
    return result;
  }
}

class OrderRecordingCaseStore extends MemoryCaseStore {
  readonly order: string[] = [];

  override async withAtomic<T>(
    operation: () => Promise<T>,
    audit?: Parameters<MemoryCaseStore["withAtomic"]>[1],
  ): Promise<T> {
    this.order.push("withAtomic");
    return super.withAtomic(operation, audit);
  }

  override async lockCase(id: string) {
    this.order.push("lockCase");
    return super.lockCase(id);
  }

  override async getInvestigationCoordination(caseId: string) {
    this.order.push("getInvestigationCoordination");
    return super.getInvestigationCoordination(caseId);
  }

  override async getInvestigationCoordinationSuccessIntent(
    caseId: string,
    actorId: string,
    key: string,
  ) {
    this.order.push("getInvestigationCoordinationSuccessIntent");
    return super.getInvestigationCoordinationSuccessIntent(caseId, actorId, key);
  }

  override async saveInvestigationCoordination(
    row: Parameters<MemoryCaseStore["saveInvestigationCoordination"]>[0],
  ) {
    this.order.push("saveInvestigationCoordination");
    return super.saveInvestigationCoordination(row);
  }

  override async appendTimeline(
    caseId: string,
    event: Parameters<MemoryCaseStore["appendTimeline"]>[1],
  ) {
    this.order.push("appendTimeline");
    return super.appendTimeline(caseId, event);
  }

  override async insertInvestigationCoordinationSuccessIntent(
    row: Parameters<MemoryCaseStore["insertInvestigationCoordinationSuccessIntent"]>[0],
  ) {
    this.order.push("insertInvestigationCoordinationSuccessIntent");
    return super.insertInvestigationCoordinationSuccessIntent(row);
  }
}

async function withService(
  fn: (ctx: {
    domain: CaseService;
    caseStore: MemoryCaseStore;
    audit: MemoryAuditStore;
  }) => Promise<void>,
  caseStore: MemoryCaseStore = new MemoryCaseStore(),
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-coord-participant-"));
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const domain = new CaseService(
    evidence,
    audit,
    caseStore,
    new CatalogService(undefined, audit),
  );
  try {
    await fn({ domain, caseStore, audit });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function seedMembers(domain: CaseService) {
  const created = await domain.createCase(
    aliceActor,
    { title: "Privileged participant coordination" },
    "test",
  );
  await domain.addParticipant(created.id, aliceActor, asParticipant(erinActor), "test");
  await domain.addParticipant(created.id, aliceActor, asParticipant(eveActor), "test");
  return created;
}

async function withApp(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    domain: CaseService;
    caseStore: MemoryCaseStore;
    grants: MemoryLocalGrantStore;
    roleStore: MemoryGroupRoleStore;
    audit: MemoryAuditStore;
  }) => Promise<void>,
  caseStore: MemoryCaseStore = new MemoryCaseStore(),
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-coord-participant-http-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const grants = new MemoryLocalGrantStore();
  const domain = new CaseService(store, audit, caseStore, catalog);
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(roleMap));
  const roleStore = new MemoryGroupRoleStore(roles);
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root }),
    pool: null,
    store,
    domain,
    grants,
    catalog,
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
      roleStore,
      audit,
    },
  });
  try {
    await fn({ app, domain, caseStore, grants, roleStore, audit });
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
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  return cookie(res);
}

async function seedHttpCase(
  app: Awaited<ReturnType<typeof buildApp>>,
  domain: CaseService,
) {
  const alice = await login(app, "alice", ALICE_PASSWORD);
  const erin = await login(app, "erin", ERIN_PASSWORD);
  const created = parseCase(JSON.parse((await app.inject({
    method: "POST",
    url: "/api/cases",
    headers: { cookie: alice },
    payload: { title: "Privileged participant coordination" },
  })).body));
  await domain.addParticipant(created.id, aliceActor, asParticipant(erinActor), "test");
  await domain.addParticipant(created.id, aliceActor, asParticipant(eveActor), "test");
  return { alice, erin, created };
}

function postCoordination(
  app: Awaited<ReturnType<typeof buildApp>>,
  session: string,
  caseId: string,
  payload: InvestigationCoordinationActionRequestV1 | Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: `/api/cases/${caseId}/coordination`,
    headers: { cookie: session },
    payload,
  });
}

describe("privileged participant coordination service", () => {
  it("assigns a recorded participant and keeps a single coordinator", async () => {
    await withService(async ({ domain, caseStore }) => {
      const created = await seedMembers(domain);
      const before = await caseStore.getCase(created.id);
      const success = parseSuccess(await domain.coordinateInvestigation(
        created.id,
        erinActor,
        false,
        request(created.id, "assign_participant", "coord-assign-01", 0, eveActor.id),
        "test",
      ));
      expect(success).toMatchObject({
        action: "assign_participant",
        targetIdentityId: eveActor.id,
        previousRevision: 0,
        previousCoordinator: null,
        applied: {
          investigationId: created.id,
          coordinator: { identityId: eveActor.id, username: "eve" },
          revision: 1,
          archived: false,
        },
      });
      expect(success.applied.updatedBy).toEqual({
        identityId: erinActor.id,
        username: "erin",
      });
      const stored = await caseStore.getInvestigationCoordination(created.id);
      expect(stored).toMatchObject({
        caseId: created.id,
        coordinator: { identityId: eveActor.id, username: "eve" },
        revision: 1,
      });
      const after = await caseStore.getCase(created.id);
      expect(after?.status).toBe(before?.status);
      expect(after?.legalHold).toBe(before?.legalHold);
      expect(participantIds(after!)).toEqual(participantIds(before!));
    });
  });

  it("releases the named holder without changing membership or status", async () => {
    await withService(async ({ domain, caseStore }) => {
      const created = await seedMembers(domain);
      await domain.coordinateInvestigation(
        created.id,
        erinActor,
        false,
        request(created.id, "assign_participant", "coord-assign-02", 0, eveActor.id),
        "test",
      );
      const before = await caseStore.getCase(created.id);
      const success = parseSuccess(await domain.coordinateInvestigation(
        created.id,
        erinActor,
        false,
        request(created.id, "release_participant", "coord-release-01", 1, eveActor.id),
        "test",
      ));
      expect(success).toMatchObject({
        action: "release_participant",
        targetIdentityId: eveActor.id,
        previousCoordinator: { identityId: eveActor.id, username: "eve" },
        applied: { coordinator: null, revision: 2, archived: false },
      });
      expect(await caseStore.getInvestigationCoordination(created.id)).toMatchObject({
        coordinator: null,
        revision: 2,
      });
      const after = await caseStore.getCase(created.id);
      expect(after?.status).toBe(before?.status);
      expect(participantIds(after!)).toEqual(participantIds(before!));
    });
  });

  it("refuses a second active assignment of the current holder", async () => {
    await withService(async ({ domain, caseStore }) => {
      const created = await seedMembers(domain);
      await domain.coordinateInvestigation(
        created.id,
        erinActor,
        false,
        request(created.id, "assign_participant", "coord-assign-03", 0, eveActor.id),
        "test",
      );
      const before = {
        status: (await caseStore.getCase(created.id))!.status,
        legalHold: (await caseStore.getCase(created.id))!.legalHold,
        participants: participantIds((await caseStore.getCase(created.id))!),
        coordination: await caseStore.getInvestigationCoordination(created.id),
        timeline: (await caseStore.listTimeline(created.id)).filter(
          (event) => event.kind === "investigation_coordination_changed",
        ).length,
      };
      await expect(domain.coordinateInvestigation(
        created.id,
        erinActor,
        false,
        request(created.id, "assign_participant", "coord-assign-again", 99, eveActor.id),
        "test",
      )).rejects.toMatchObject({
        name: "InvestigationCoordinationRefusedError",
        refusal: expect.objectContaining({ reason: "already_coordinator" }),
      });
      await expectUnchangedCase(caseStore, created.id, before);
      expect(await caseStore.getInvestigationCoordinationSuccessIntent(
        created.id,
        erinActor.id,
        "coord-assign-again",
      )).toBeNull();
    });
  });

  it("refuses a target that is not a recorded participant", async () => {
    await withService(async ({ domain, caseStore }) => {
      const created = await seedMembers(domain);
      const before = {
        status: (await caseStore.getCase(created.id))!.status,
        legalHold: (await caseStore.getCase(created.id))!.legalHold,
        participants: participantIds((await caseStore.getCase(created.id))!),
        coordination: await caseStore.getInvestigationCoordination(created.id),
        timeline: (await caseStore.listTimeline(created.id)).filter(
          (event) => event.kind === "investigation_coordination_changed",
        ).length,
      };
      await expect(domain.coordinateInvestigation(
        created.id,
        erinActor,
        false,
        request(created.id, "assign_participant", "coord-missing", 0, MISSING_IDENTITY_ID),
        "test",
      )).rejects.toMatchObject({
        name: "InvestigationCoordinationRefusedError",
        refusal: expect.objectContaining({ reason: "target_not_eligible" }),
      });
      await expectUnchangedCase(caseStore, created.id, before);
    });
  });

  it("applies archive, holder, then CAS in evaluator order", async () => {
    await withService(async ({ domain, caseStore }) => {
      const created = await seedMembers(domain);
      await domain.coordinateInvestigation(
        created.id,
        erinActor,
        false,
        request(created.id, "assign_participant", "coord-assign-04", 0, eveActor.id),
        "test",
      );

      await caseStore.updateCaseMeta({ id: created.id, status: "archived" });
      await expect(domain.coordinateInvestigation(
        created.id,
        erinActor,
        false,
        request(created.id, "assign_participant", "coord-archived", 99, aliceActor.id),
        "test",
      )).rejects.toMatchObject({
        name: "InvestigationCoordinationRefusedError",
        refusal: expect.objectContaining({ reason: "investigation_archived" }),
      });
      await caseStore.updateCaseMeta({ id: created.id, status: "open" });

      const captured = caseStore.capture() as {
        cases: [string, { participants: { identityId: string; username: string }[] }][];
      };
      const capturedCase = captured.cases.find(([id]) => id === created.id)?.[1];
      expect(capturedCase).toBeDefined();
      capturedCase!.participants = capturedCase!.participants.filter(
        (participant) => participant.identityId !== eveActor.id,
      );
      caseStore.restore(captured);

      await expect(domain.coordinateInvestigation(
        created.id,
        erinActor,
        false,
        request(created.id, "assign_participant", "coord-holder", 99, eveActor.id),
        "test",
      )).rejects.toMatchObject({
        name: "InvestigationCoordinationRefusedError",
        refusal: expect.objectContaining({ reason: "already_coordinator" }),
      });
      await expect(domain.coordinateInvestigation(
        created.id,
        erinActor,
        false,
        request(created.id, "release_participant", "coord-wrong-holder", 99, aliceActor.id),
        "test",
      )).rejects.toMatchObject({
        name: "InvestigationCoordinationRefusedError",
        refusal: expect.objectContaining({ reason: "target_not_coordinator" }),
      });

      await expect(domain.coordinateInvestigation(
        created.id,
        erinActor,
        false,
        request(created.id, "release_participant", "coord-stale", 0, eveActor.id),
        "test",
      )).rejects.toBeInstanceOf(InvestigationCoordinationChangedError);
    });
  });

  it("returns a changed envelope for a stale expectedRevision", async () => {
    await withService(async ({ domain }) => {
      const created = await seedMembers(domain);
      await domain.coordinateInvestigation(
        created.id,
        erinActor,
        false,
        request(created.id, "assign_participant", "coord-assign-05", 0, eveActor.id),
        "test",
      );
      try {
        await domain.coordinateInvestigation(
          created.id,
          erinActor,
          false,
          request(created.id, "release_participant", "coord-cas", 0, eveActor.id),
          "test",
        );
        expect.fail("expected coordination_changed");
      } catch (error) {
        expect(error).toBeInstanceOf(InvestigationCoordinationChangedError);
        if (error instanceof InvestigationCoordinationChangedError) {
          expect(error.conflict).toMatchObject({
            error: "coordination_changed",
            action: "release_participant",
            targetIdentityId: eveActor.id,
            current: { revision: 1, coordinator: { identityId: eveActor.id } },
          });
        }
      }
    });
  });

  it("replays an exact success and refuses an intent mismatch", async () => {
    await withService(async ({ domain }) => {
      const created = await seedMembers(domain);
      const payload = request(
        created.id,
        "assign_participant",
        "coord-idempotent",
        0,
        eveActor.id,
      );
      const first = await domain.coordinateInvestigation(
        created.id,
        erinActor,
        false,
        payload,
        "test",
      );
      const replay = await domain.coordinateInvestigation(
        created.id,
        erinActor,
        false,
        { ...payload, expectedRevision: 44, clientTime: "2026-09-04T10:00:00-04:00" },
        "test",
      );
      expect(replay).toBe(first);
      await expect(domain.coordinateInvestigation(
        created.id,
        erinActor,
        false,
        request(created.id, "release_participant", "coord-idempotent", 1, eveActor.id),
        "test",
      )).rejects.toMatchObject({
        name: "InvestigationCoordinationRefusedError",
        refusal: expect.objectContaining({ reason: "idempotency_intent_mismatch" }),
      });
      await expect(domain.coordinateInvestigation(
        created.id,
        erinActor,
        false,
        request(created.id, "assign_participant", "coord-idempotent", 1, aliceActor.id),
        "test",
      )).rejects.toMatchObject({
        name: "InvestigationCoordinationRefusedError",
        refusal: expect.objectContaining({ reason: "idempotency_intent_mismatch" }),
      });
    });
  });

  it("maps an unknown commit outcome to a frozen retry of the same key", async () => {
    const caseStore = new UnknownOnceAfterCommitCaseStore();
    await withService(async ({ domain }) => {
      const created = await seedMembers(domain);
      caseStore.failAfterNextCommit = true;
      const callsBefore = caseStore.atomicCalls;
      const payload = request(
        created.id,
        "assign_participant",
        "coord-unknown",
        0,
        eveActor.id,
      );
      await expect(domain.coordinateInvestigation(
        created.id,
        erinActor,
        false,
        payload,
        "test",
      )).rejects.toBeInstanceOf(CaseStoreCommitOutcomeUnknownError);
      expect(caseStore.atomicCalls - callsBefore).toBe(1);

      const retried = parseSuccess(await domain.coordinateInvestigation(
        created.id,
        erinActor,
        false,
        payload,
        "test",
      ));
      expect(retried.applied).toMatchObject({
        coordinator: { identityId: eveActor.id },
        revision: 1,
      });
      expect((await caseStore.listTimeline(created.id)).filter(
        (event) => event.kind === "investigation_coordination_changed",
      )).toHaveLength(1);
    }, caseStore);
  });

  it("locks, re-reads, evaluates, derives the target, then writes", async () => {
    const caseStore = new OrderRecordingCaseStore();
    await withService(async ({ domain }) => {
      const created = await seedMembers(domain);
      caseStore.order.length = 0;
      const success = parseSuccess(await domain.coordinateInvestigation(
        created.id,
        erinActor,
        false,
        request(created.id, "assign_participant", "coord-order", 0, eveActor.id),
        "test",
      ));
      expect(success.applied.coordinator).toEqual({
        identityId: eveActor.id,
        username: "eve",
      });
      expect(caseStore.order).toEqual([
        "withAtomic",
        "lockCase",
        "getInvestigationCoordinationSuccessIntent",
        "getInvestigationCoordination",
        "saveInvestigationCoordination",
        "appendTimeline",
        "insertInvestigationCoordinationSuccessIntent",
      ]);
    }, caseStore);
  });

  it("still allows the recorded holder to self-release", async () => {
    await withService(async ({ domain }) => {
      const created = await seedMembers(domain);
      await domain.coordinateInvestigation(
        created.id,
        erinActor,
        false,
        request(created.id, "assign_participant", "coord-assign-self", 0, aliceActor.id),
        "test",
      );
      const released = parseSuccess(await domain.coordinateInvestigation(
        created.id,
        aliceActor,
        false,
        request(created.id, "release_self", "coord-self-release", 1),
        "test",
      ));
      expect(released.applied.coordinator).toBeNull();
    });
  });
});

describe("privileged participant coordination HTTP", () => {
  it("assigns a recorded participant through the existing coordination POST", async () => {
    await withApp(async ({ app, domain, caseStore }) => {
      const { erin, created } = await seedHttpCase(app, domain);
      const assigned = await postCoordination(
        app,
        erin,
        created.id,
        request(created.id, "assign_participant", "http-assign-01", 0, eveActor.id),
      );
      expect(assigned.statusCode).toBe(200);
      const body = parseInvestigationCoordinationActionSuccess(JSON.parse(assigned.body));
      const listed = parseCase(JSON.parse((await app.inject({
        method: "GET",
        url: `/api/cases/${created.id}`,
        headers: { cookie: erin },
      })).body));
      const eve = listed.participants.find((participant) => participant.username === "eve");
      expect(eve).toEqual({ identityId: expect.stringMatching(/^usr-[a-f0-9]{32}$/), username: "eve" });
      expect(body.applied.coordinator).toEqual(eve);
      expect(body.applied.revision).toBe(1);
      const row = await caseStore.getCase(created.id);
      expect(row?.status).toBe("open");
      expect(participantIds(row!)).toEqual(
        [aliceActor.id, erinActor.id, eveActor.id].sort(),
      );
      expect(await caseStore.getInvestigationCoordination(created.id)).toMatchObject({
        coordinator: { identityId: eveActor.id },
        revision: 1,
      });
    });
  });

  it("releases the named participant coordinator", async () => {
    await withApp(async ({ app, domain }) => {
      const { erin, created } = await seedHttpCase(app, domain);
      expect((await postCoordination(
        app,
        erin,
        created.id,
        request(created.id, "assign_participant", "http-assign-02", 0, eveActor.id),
      )).statusCode).toBe(200);
      const released = await postCoordination(
        app,
        erin,
        created.id,
        request(created.id, "release_participant", "http-release-01", 1, eveActor.id),
      );
      expect(released.statusCode).toBe(200);
      expect(parseInvestigationCoordinationActionSuccess(JSON.parse(released.body)).applied)
        .toMatchObject({ coordinator: null, revision: 2 });
    });
  });

  it("refuses a second active assignment of the current holder", async () => {
    await withApp(async ({ app, domain, caseStore }) => {
      const { erin, created } = await seedHttpCase(app, domain);
      await postCoordination(
        app,
        erin,
        created.id,
        request(created.id, "assign_participant", "http-assign-03", 0, eveActor.id),
      );
      const refused = await postCoordination(
        app,
        erin,
        created.id,
        request(created.id, "assign_participant", "http-assign-again", 1, eveActor.id),
      );
      expect(refused.statusCode).toBe(409);
      expect(parseInvestigationCoordinationActionRefused(JSON.parse(refused.body)).reason)
        .toBe("already_coordinator");
      expect(await caseStore.getInvestigationCoordination(created.id)).toMatchObject({
        coordinator: { identityId: eveActor.id },
        revision: 1,
      });
    });
  });

  it("refuses a nonparticipant target without writing", async () => {
    await withApp(async ({ app, domain, caseStore }) => {
      const { erin, created } = await seedHttpCase(app, domain);
      const refused = await postCoordination(
        app,
        erin,
        created.id,
        request(created.id, "assign_participant", "http-missing", 0, MISSING_IDENTITY_ID),
      );
      expect(refused.statusCode).toBe(409);
      expect(parseInvestigationCoordinationActionRefused(JSON.parse(refused.body)).reason)
        .toBe("target_not_eligible");
      expect(await caseStore.getInvestigationCoordination(created.id)).toBeNull();
      expect(await caseStore.getInvestigationCoordinationSuccessIntent(
        created.id,
        erinActor.id,
        "http-missing",
      )).toBeNull();
      expect((await caseStore.listTimeline(created.id)).filter(
        (event) => event.kind === "investigation_coordination_changed",
      )).toHaveLength(0);
    });
  });

  it("refuses archive and holder states before a stale revision", async () => {
    await withApp(async ({ app, domain, caseStore }) => {
      const { erin, created } = await seedHttpCase(app, domain);
      await postCoordination(
        app,
        erin,
        created.id,
        request(created.id, "assign_participant", "http-assign-04", 0, eveActor.id),
      );

      await caseStore.updateCaseMeta({ id: created.id, status: "archived" });
      const archived = await postCoordination(
        app,
        erin,
        created.id,
        request(created.id, "release_participant", "http-archived", 99, eveActor.id),
      );
      expect(archived.statusCode).toBe(409);
      expect(parseInvestigationCoordinationActionRefused(JSON.parse(archived.body)).reason)
        .toBe("investigation_archived");
      await caseStore.updateCaseMeta({ id: created.id, status: "open" });

      const holder = await postCoordination(
        app,
        erin,
        created.id,
        request(created.id, "assign_participant", "http-holder", 99, eveActor.id),
      );
      expect(parseInvestigationCoordinationActionRefused(JSON.parse(holder.body)).reason)
        .toBe("already_coordinator");
      const wrongHolder = await postCoordination(
        app,
        erin,
        created.id,
        request(created.id, "release_participant", "http-wrong-holder", 99, aliceActor.id),
      );
      expect(parseInvestigationCoordinationActionRefused(JSON.parse(wrongHolder.body)).reason)
        .toBe("target_not_coordinator");
    });
  });

  it("returns 409 coordination_changed for a stale expectedRevision", async () => {
    await withApp(async ({ app, domain }) => {
      const { erin, created } = await seedHttpCase(app, domain);
      await postCoordination(
        app,
        erin,
        created.id,
        request(created.id, "assign_participant", "http-assign-05", 0, eveActor.id),
      );
      const changed = await postCoordination(
        app,
        erin,
        created.id,
        request(created.id, "release_participant", "http-stale", 0, eveActor.id),
      );
      expect(changed.statusCode).toBe(409);
      expect(parseInvestigationCoordinationChanged(JSON.parse(changed.body))).toMatchObject({
        error: "coordination_changed",
        action: "release_participant",
        current: { revision: 1 },
      });
    });
  });

  it("replays the exact success body and refuses an intent mismatch", async () => {
    await withApp(async ({ app, domain }) => {
      const { erin, created } = await seedHttpCase(app, domain);
      const payload = request(
        created.id,
        "assign_participant",
        "http-idempotent",
        0,
        eveActor.id,
      );
      const first = await postCoordination(app, erin, created.id, payload);
      expect(first.statusCode).toBe(200);
      const replay = await postCoordination(
        app,
        erin,
        created.id,
        { ...payload, expectedRevision: 77, clientTime: "2026-09-04T10:00:00-04:00" },
      );
      expect(replay.statusCode).toBe(200);
      expect(replay.body).toBe(first.body);
      const mismatch = await postCoordination(
        app,
        erin,
        created.id,
        request(created.id, "release_participant", "http-idempotent", 1, eveActor.id),
      );
      expect(mismatch.statusCode).toBe(409);
      expect(parseInvestigationCoordinationActionRefused(JSON.parse(mismatch.body)).reason)
        .toBe("idempotency_intent_mismatch");
    });
  });

  it("returns 503 for an unknown outcome and retries the frozen payload and key", async () => {
    const caseStore = new UnknownOnceAfterCommitCaseStore();
    await withApp(async ({ app, domain }) => {
      const { erin, created } = await seedHttpCase(app, domain);
      caseStore.failAfterNextCommit = true;
      const callsBefore = caseStore.atomicCalls;
      const payload = request(
        created.id,
        "assign_participant",
        "http-unknown",
        0,
        eveActor.id,
      );
      const unknown = await postCoordination(app, erin, created.id, payload);
      expect(unknown.statusCode).toBe(503);
      expect(JSON.parse(unknown.body)).toEqual({ error: "commit_outcome_unknown" });
      expect(caseStore.atomicCalls - callsBefore).toBe(1);

      const retry = await postCoordination(app, erin, created.id, payload);
      expect(retry.statusCode).toBe(200);
      expect(parseInvestigationCoordinationActionSuccess(JSON.parse(retry.body)).applied.revision)
        .toBe(1);
      expect((await caseStore.listTimeline(created.id)).filter(
        (event) => event.kind === "investigation_coordination_changed",
      )).toHaveLength(1);
      const secondRetry = await postCoordination(app, erin, created.id, payload);
      expect(secondRetry.body).toBe(retry.body);
    }, caseStore);
  });

  it("conceals unauthenticated, forbidden, and missing investigations without a write", async () => {
    await withApp(async ({ app, domain, caseStore }) => {
      const { alice, created } = await seedHttpCase(app, domain);
      const carol = await login(app, "carol", CAROL_PASSWORD);
      const getCase = vi.spyOn(caseStore, "getCase");
      const lockCase = vi.spyOn(caseStore, "lockCase");
      const withAtomic = vi.spyOn(caseStore, "withAtomic");
      const save = vi.spyOn(caseStore, "saveInvestigationCoordination");
      const expectNoWrite = () => {
        expect(lockCase).not.toHaveBeenCalled();
        expect(withAtomic).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
      };

      const unauthenticated = await app.inject({
        method: "POST",
        url: `/api/cases/${created.id}/coordination`,
        payload: request(created.id, "assign_participant", "http-unauth", 0, eveActor.id),
      });
      expect(unauthenticated.statusCode).toBe(401);
      expect(JSON.parse(unauthenticated.body)).toEqual({
        schemaId: AUTH_ERROR_SCHEMA_ID,
        error: "unauthenticated",
      });
      expect(getCase).not.toHaveBeenCalled();
      expectNoWrite();

      const memberWithoutCoordinate = await postCoordination(
        app,
        alice,
        created.id,
        request(created.id, "assign_participant", "http-alice-assign", 0, eveActor.id),
      );
      expect(memberWithoutCoordinate.statusCode).toBe(403);
      expect(JSON.parse(memberWithoutCoordinate.body)).toEqual({
        schemaId: AUTH_ERROR_SCHEMA_ID,
        error: "forbidden",
      });
      expect(getCase).not.toHaveBeenCalled();
      expectNoWrite();

      const viewer = await postCoordination(
        app,
        carol,
        created.id,
        request(created.id, "assign_participant", "http-carol-assign", 0, eveActor.id),
      );
      expect(viewer.statusCode).toBe(403);
      expect(getCase).not.toHaveBeenCalled();
      expectNoWrite();

      getCase.mockClear();
      const erin = await login(app, "erin", ERIN_PASSWORD);
      const missing = await postCoordination(
        app,
        erin,
        MISSING_CASE_ID,
        request(MISSING_CASE_ID, "assign_participant", "http-missing-case", 0, eveActor.id),
      );
      expect(missing.statusCode).toBe(404);
      expect(JSON.parse(missing.body)).toEqual({ error: "not_found" });
      expect(lockCase).not.toHaveBeenCalled();
      expect(withAtomic).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();

      const outsiderCase = parseCase(JSON.parse((await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Concealed privileged case" },
      })).body));
      const concealedMember = await postCoordination(
        app,
        erin,
        outsiderCase.id,
        request(outsiderCase.id, "assign_participant", "http-outsider", 0, aliceActor.id),
      );
      expect(concealedMember.statusCode).toBe(404);
      expect(JSON.parse(concealedMember.body)).toEqual({ error: "not_found" });
      expect(await caseStore.getInvestigationCoordination(outsiderCase.id)).toBeNull();
    });
  });

  it("does not mutate coordination, membership, or status on refusal", async () => {
    await withApp(async ({ app, domain, caseStore, audit }) => {
      const { erin, created } = await seedHttpCase(app, domain);
      const beforeParticipants = participantIds((await caseStore.getCase(created.id))!);
      const refused = await postCoordination(
        app,
        erin,
        created.id,
        request(created.id, "assign_participant", "http-no-write", 0, MISSING_IDENTITY_ID),
      );
      expect(parseInvestigationCoordinationActionRefused(JSON.parse(refused.body)).reason)
        .toBe("target_not_eligible");
      expect(await caseStore.getInvestigationCoordination(created.id)).toBeNull();
      expect((await caseStore.getCase(created.id))?.status).toBe("open");
      expect(participantIds((await caseStore.getCase(created.id))!)).toEqual(beforeParticipants);
      expect((await caseStore.listTimeline(created.id)).filter(
        (event) => event.kind === "investigation_coordination_changed",
      )).toHaveLength(0);
      expect((await audit.list()).filter(
        (event) => event.action === "investigation_coordination_changed"
          && event.outcome === "success",
      )).toHaveLength(0);
    });
  });

  it("re-authorizes privileged replay after membership and capability loss", async () => {
    await withApp(async ({ app, domain, caseStore, roleStore }) => {
      const { erin, created } = await seedHttpCase(app, domain);
      const payload = request(
        created.id,
        "assign_participant",
        "http-replay-auth",
        0,
        eveActor.id,
      );
      const success = await postCoordination(app, erin, created.id, payload);
      expect(success.statusCode).toBe(200);

      const captured = caseStore.capture() as {
        cases: [string, { participants: { identityId: string; username: string }[] }][];
      };
      const capturedCase = captured.cases.find(([id]) => id === created.id)?.[1];
      expect(capturedCase).toBeDefined();
      capturedCase!.participants = capturedCase!.participants.filter(
        (participant) => participant.identityId !== erinActor.id,
      );
      caseStore.restore(captured);

      const afterMembershipLoss = await postCoordination(
        app,
        erin,
        created.id,
        { ...payload, expectedRevision: 99 },
      );
      expect(afterMembershipLoss.statusCode).toBe(404);

      await roleStore.delete("cn=case-leads,ou=groups,dc=example,dc=test");
      const getCase = vi.spyOn(caseStore, "getCase");
      const afterCapabilityLoss = await postCoordination(
        app,
        erin,
        created.id,
        { ...payload, expectedRevision: 100 },
      );
      expect(afterCapabilityLoss.statusCode).toBe(403);
      expect(getCase).not.toHaveBeenCalled();
    });
  });
});
