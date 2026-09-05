import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PERMANENT_UNKNOWN_SOURCE_ID,
  SOURCE_CATALOG_IDEMPOTENCY,
  SOURCE_CREATE_REQUEST_SCHEMA_ID,
  SOURCE_KINDS,
  SOURCE_RESTORE_REQUEST_SCHEMA_ID,
  SOURCE_RETIRE_REQUEST_SCHEMA_ID,
  parseSource,
  parseSourceList,
  parseSourceMutationRefused,
  parseSourceMutationSuccess,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { testConfig } from "../../config.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { MapAuthAdapter } from "../auth/index.js";
import {
  createAuthLog,
  createRateLimiter,
  MemorySessionStore,
  defaultSessionPolicy,
} from "../auth/index.js";
import { MutableGroupRoleMap, parseGroupRoleMap } from "../authz/index.js";
import { CaseService } from "../cases/index.js";
import { MemoryLocalGrantStore, MemoryUserProfileStore } from "../people/index.js";
import {
  CatalogCommitOutcomeUnknownError,
  CatalogMutationRefusedError,
  CatalogPermanentUnknownError,
  CatalogService,
  CatalogVersionedSourceError,
} from "./service.js";
import { CatalogIdentityBoundError, MemoryCatalogStore } from "./store.js";

const roleMap =
  "cn=viewers,ou=groups,dc=example,dc=test=viewer;cn=contributors,ou=groups,dc=example,dc=test=contributor;cn=admins,ou=groups,dc=example,dc=test=admin";

function users() {
  return new Map([
    [
      "alice",
      {
        password: "fixture-alice-secret",
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
      "carol",
      {
        password: "fixture-carol-secret",
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

async function withApp(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    catalog: CatalogService;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-catalog-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(undefined, audit);
  const domain = new CaseService(store, audit, undefined, catalog);
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(roleMap));
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root }),
    pool: null,
    store,
    domain,
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
      audit,
    },
  });
  try {
    await fn({ app, catalog });
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

describe("source catalog", () => {
  it("covers all five kinds, refuses kind mutation, and preserves retired attributions", async () => {
    await withApp(async ({ app }) => {
      const dave = cookie(
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "dave", password: "fixture-dave-secret" },
        }),
      );
      const createdIds: string[] = [];
      for (const kind of SOURCE_KINDS) {
        const res = await app.inject({
          method: "POST",
          url: "/api/catalog/sources",
          headers: { cookie: dave },
          payload: { name: `src-${kind}`, kind, description: `fixture ${kind}` },
        });
        expect(res.statusCode).toBe(200);
        const source = parseSource(JSON.parse(res.body));
        expect(source.kind).toBe(kind);
        expect(source.lifecycle).toBe("active");
        createdIds.push(source.id);
      }
      const listed = parseSourceList(
        JSON.parse(
          (await app.inject({ method: "GET", url: "/api/catalog/sources", headers: { cookie: dave } }))
            .body,
        ),
      );
      const kinds = new Set(listed.sources.map((s) => s.kind));
      for (const kind of SOURCE_KINDS) expect(kinds.has(kind)).toBe(true);

      const unknown = listed.sources.find((s) => s.name === "src-unknown");
      expect(unknown?.kind).toBe("unknown");
      const mutateKind = await app.inject({
        method: "POST",
        url: `/api/catalog/sources/${unknown?.id}`,
        headers: { cookie: dave },
        payload: { name: "still-unknown", kind: "human" },
      });
      expect(mutateKind.statusCode).toBe(200);
      const after = parseSource(JSON.parse(mutateKind.body));
      expect(after.kind).toBe("unknown");
      expect(after.name).toBe("still-unknown");

      const alice = cookie(
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "alice", password: "fixture-alice-secret" },
        }),
      );
      const forbidden = await app.inject({
        method: "POST",
        url: "/api/catalog/sources",
        headers: { cookie: alice },
        payload: { name: "nope", kind: "human" },
      });
      expect(forbidden.statusCode).toBe(403);

      const caseRes = await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Catalog fixture" },
      });
      const caseId = (JSON.parse(caseRes.body) as { id: string }).id;
      const note = JSON.parse(
        (
          await app.inject({
            method: "POST",
            url: `/api/cases/${caseId}/contributions`,
            headers: { cookie: alice },
            payload: { kind: "note", body: "attributed note", sourceId: createdIds[0] },
          })
        ).body,
      ) as { sourceId: string };
      expect(note.sourceId).toBe(createdIds[0]);
      const retired = parseSource(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/catalog/sources/${createdIds[0]}/retire`,
              headers: { cookie: dave },
            })
          ).body,
        ),
      );
      expect(retired.lifecycle).toBe("retired");
      const sourcesAfter = parseSourceList(
        JSON.parse(
          (await app.inject({ method: "GET", url: "/api/catalog/sources", headers: { cookie: alice } }))
            .body,
        ),
      );
      expect(sourcesAfter.sources.find((s) => s.id === note.sourceId)?.lifecycle).toBe("retired");
      expect(note.sourceId).toBe(createdIds[0]);
    });
  });

  it("hides raw directory identities from unauthorized catalog readers", async () => {
    await withApp(async ({ app }) => {
      const dave = cookie(
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "dave", password: "fixture-dave-secret" },
        }),
      );
      const alice = cookie(
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "alice", password: "fixture-alice-secret" },
        }),
      );
      const carol = cookie(
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "carol", password: "fixture-carol-secret" },
        }),
      );
      const created = await app.inject({
        method: "POST",
        url: "/api/cases",
        headers: { cookie: alice },
        payload: { title: "Catalog identity fixture" },
      });
      expect(created.statusCode).toBe(200);
      const caseId = (JSON.parse(created.body) as { id: string }).id;
      const note = await app.inject({
        method: "POST",
        url: `/api/cases/${caseId}/contributions`,
        headers: { cookie: alice },
        payload: { kind: "note", body: "binds alice as a human source" },
      });
      expect(note.statusCode).toBe(200);

      const adminList = parseSourceList(
        JSON.parse(
          (await app.inject({ method: "GET", url: "/api/catalog/sources", headers: { cookie: dave } }))
            .body,
        ),
      );
      const human = adminList.sources.find((s) => s.kind === "human" && s.identityId);
      expect(human).toBeDefined();
      expect(human?.identityId).toMatch(/^usr-[a-f0-9]{32}$/);
      expect(human?.createdBy).toBe(human?.identityId);
      expect(human?.name).toBe("alice");
      expect(human?.revision).toBe(1);
      const assistant = parseSource(
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

      const viewerBody = (
        await app.inject({ method: "GET", url: "/api/catalog/sources", headers: { cookie: carol } })
      ).body;
      expect(viewerBody).not.toContain("uid=alice,ou=people,dc=example,dc=test");
      expect(viewerBody).not.toContain("uid=dave,ou=people,dc=example,dc=test");
      const viewerList = parseSourceList(JSON.parse(viewerBody));
      const projected = viewerList.sources.find((s) => s.id === human?.id);
      expect(projected?.id).toBe(human?.id);
      expect(projected?.kind).toBe("human");
      expect(projected?.identityId).toBeNull();
      expect(projected?.name).toBe(human?.id);
      expect(projected?.createdBy).toMatch(/^attr:[0-9a-f]{64}$/);
      expect(projected?.createdBy).not.toContain("uid=");
      const viewerAssistant = viewerList.sources.find((s) => s.id === assistant.id);
      expect(viewerAssistant?.name).toBe("Web assistant");
      expect(viewerAssistant?.kind).toBe("external-tool");
      expect(viewerAssistant?.createdBy).toMatch(/^attr:[0-9a-f]{64}$/);
      expect(viewerList.sources.some((source) => source.revision === 1)).toBe(true);
      expect(viewerAssistant).not.toHaveProperty("revision");
    });
  });
});
const mutationRoleMap =
  "cn=viewers,ou=groups,dc=example,dc=test=viewer;cn=contributors,ou=groups,dc=example,dc=test=contributor;cn=leads,ou=groups,dc=example,dc=test=case-lead;cn=admins,ou=groups,dc=example,dc=test=admin";

function mutationUsers() {
  return new Map([
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
      "lead",
      {
        password: "fixture-lead-secret",
        identity: {
          id: "uid=lead,ou=people,dc=example,dc=test",
          username: "lead",
          displayName: "lead",
        },
        groups: ["cn=leads,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "alice",
      {
        password: "fixture-alice-secret",
        identity: {
          id: "uid=alice,ou=people,dc=example,dc=test",
          username: "alice",
          displayName: "alice",
        },
        groups: ["cn=contributors,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "carol",
      {
        password: "fixture-carol-secret",
        identity: {
          id: "uid=carol,ou=people,dc=example,dc=test",
          username: "carol",
          displayName: "carol",
        },
        groups: ["cn=viewers,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "granted",
      {
        password: "fixture-granted-secret",
        identity: {
          id: "uid=granted,ou=people,dc=example,dc=test",
          username: "granted",
          displayName: "granted",
        },
        groups: ["cn=viewers,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "runner",
      {
        password: "fixture-runner-secret",
        identity: {
          id: "uid=runner,ou=people,dc=example,dc=test",
          username: "runner",
          displayName: "runner",
        },
        groups: ["cn=viewers,ou=groups,dc=example,dc=test"],
      },
    ],
    [
      "peopleadmin",
      {
        password: "fixture-people-secret",
        identity: {
          id: "uid=peopleadmin,ou=people,dc=example,dc=test",
          username: "peopleadmin",
          displayName: "peopleadmin",
        },
        groups: ["cn=viewers,ou=groups,dc=example,dc=test"],
      },
    ],
  ]);
}

async function withMutationApp(
  fn: (ctx: {
    app: Awaited<ReturnType<typeof buildApp>>;
    catalog: CatalogService;
    audit: MemoryAuditStore;
    grants: MemoryLocalGrantStore;
    profiles: MemoryUserProfileStore;
  }) => Promise<void>,
  catalogStore?: MemoryCatalogStore,
) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-catalog-cas-"));
  const store = new FilesystemEvidenceStore({ rootDir: root });
  const audit = new MemoryAuditStore();
  const catalog = new CatalogService(catalogStore ?? new MemoryCatalogStore(), audit);
  const domain = new CaseService(store, audit, undefined, catalog);
  const roles = new MutableGroupRoleMap(parseGroupRoleMap(mutationRoleMap));
  const grants = new MemoryLocalGrantStore();
  const profiles = new MemoryUserProfileStore();
  const app = await buildApp({
    config: testConfig({ evidenceRoot: root }),
    pool: null,
    store,
    domain,
    catalog,
    grants,
    profiles,
    security: {
      auth: {
        adapter: new MapAuthAdapter(mutationUsers()),
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
    await fn({ app, catalog, audit, grants, profiles });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function loginCookie(
  app: Awaited<ReturnType<typeof buildApp>>,
  username: string,
  password: string,
): Promise<string> {
  return cookie(
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username, password },
    }),
  );
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
    name: "Web assistant",
    kind: "external-tool",
    description: null,
    identityId: null,
    expectedRevision: 0,
    idempotencyKey: "src-create-0001",
    ...overrides,
  };
}

describe("source catalog strict mutations", () => {
  it("creates at revision 1, replays the original success, and freezes uncertain-outcome retry instructions", async () => {
    expect(SOURCE_CATALOG_IDEMPOTENCY.excludesFromIntent).toEqual(["expectedRevision"]);
    expect(SOURCE_CATALOG_IDEMPOTENCY.uncertainOutcome).toBe(
      "freeze_exact_payload_and_idempotency_key_before_retry",
    );
    await withMutationApp(async ({ app, audit }) => {
      const dave = await loginCookie(app, "dave", "fixture-dave-secret");
      const payload = createBody({ idempotencyKey: "src-create-replay" });
      const created = await app.inject({
        method: "POST",
        url: "/api/catalog/sources",
        headers: { cookie: dave },
        payload,
      });
      expect(created.statusCode).toBe(201);
      const first = parseSourceMutationSuccess(JSON.parse(created.body));
      expect(first.replayed).toBe(false);
      expect(first.applied.revision).toBe(1);
      expect(first.appliedRevision).toBe(1);
      const retry = await app.inject({
        method: "POST",
        url: "/api/catalog/sources",
        headers: { cookie: dave },
        payload: { ...payload, expectedRevision: 0 },
      });
      expect(retry.statusCode).toBe(200);
      const replayed = parseSourceMutationSuccess(JSON.parse(retry.body));
      expect(replayed.replayed).toBe(true);
      expect(replayed.sourceId).toBe(first.sourceId);
      expect(replayed.applied).toEqual(first.applied);
      expect((await audit.list({ action: "catalog_create" })).filter((row) => row.outcome === "success")).toHaveLength(1);
      const listed = parseSourceList(
        JSON.parse(
          (await app.inject({ method: "GET", url: "/api/catalog/sources", headers: { cookie: dave } })).body,
        ),
      );
      expect(listed.sources.filter((source) => source.id === first.sourceId)).toHaveLength(1);
    });
  });

  it("refuses a changed action or intent on the same idempotency key", async () => {
    await withMutationApp(async ({ app }) => {
      const dave = await loginCookie(app, "dave", "fixture-dave-secret");
      const created = parseSourceMutationSuccess(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: "/api/catalog/sources",
              headers: { cookie: dave },
              payload: createBody({ idempotencyKey: "src-shared-key" }),
            })
          ).body,
        ),
      );
      const mismatch = await app.inject({
        method: "POST",
        url: "/api/catalog/sources",
        headers: { cookie: dave },
        payload: createBody({
          idempotencyKey: "src-shared-key",
          name: "Different tool",
        }),
      });
      expect(mismatch.statusCode).toBe(409);
      const mismatched = parseSourceMutationRefused(JSON.parse(mismatch.body));
      expect(mismatched.reason).toBe("idempotency_intent_mismatch");
      expect(mismatched.current).toBeNull();
      const retireMismatch = await app.inject({
        method: "POST",
        url: `/api/catalog/sources/${created.sourceId}/retire`,
        headers: { cookie: dave },
        payload: {
          schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
          sourceId: created.sourceId,
          expectedRevision: 1,
          idempotencyKey: "src-shared-key",
        },
      });
      expect(retireMismatch.statusCode).toBe(409);
      const retireRefused = parseSourceMutationRefused(JSON.parse(retireMismatch.body));
      expect(retireRefused.reason).toBe("idempotency_intent_mismatch");
      expect(retireRefused.current).toBeNull();
    });
  });

  it("authorizes case-lead, admin, and additive catalog:write, and denies everyone else before parse", async () => {
    await withMutationApp(async ({ app, audit, grants, profiles }) => {
      const dave = await loginCookie(app, "dave", "fixture-dave-secret");
      const lead = await loginCookie(app, "lead", "fixture-lead-secret");
      const alice = await loginCookie(app, "alice", "fixture-alice-secret");
      const carol = await loginCookie(app, "carol", "fixture-carol-secret");
      const granted = await loginCookie(app, "granted", "fixture-granted-secret");
      const runner = await loginCookie(app, "runner", "fixture-runner-secret");
      const peopleadmin = await loginCookie(app, "peopleadmin", "fixture-people-secret");
      await grants.grant("uid=granted,ou=people,dc=example,dc=test", "catalog:write", "uid=dave,ou=people,dc=example,dc=test");
      await grants.grant("uid=runner,ou=people,dc=example,dc=test", "run:strategies", "uid=dave,ou=people,dc=example,dc=test");
      await grants.grant("uid=peopleadmin,ou=people,dc=example,dc=test", "admin:users", "uid=dave,ou=people,dc=example,dc=test");

      const malformed = {
        schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
        name: "",
        kind: "external-tool",
        description: null,
        identityId: null,
        expectedRevision: 0,
        idempotencyKey: "src-denied-parse",
      };
      for (const [session, username] of [
        [alice, "alice"],
        [carol, "carol"],
        [runner, "runner"],
        [peopleadmin, "peopleadmin"],
      ] as const) {
        const denied = await app.inject({
          method: "POST",
          url: "/api/catalog/sources",
          headers: { cookie: session },
          payload: malformed,
        });
        expect(denied.statusCode, username).toBe(403);
        expect(JSON.parse(denied.body).error).toBe("forbidden");
        expect(denied.body).not.toContain("Web assistant");
        expect(denied.body).not.toContain("src-denied-parse");
      }
      const deniedAudit = (await audit.list({ action: "catalog_create" })).filter(
        (row) => row.outcome === "denied",
      );
      expect(deniedAudit.length).toBeGreaterThanOrEqual(4);
      expect(deniedAudit.every((row) => row.target === "forbidden")).toBe(true);
      expect(deniedAudit.every((row) => !row.target || !row.target.includes("src-"))).toBe(true);

      const unknownSchema = await app.inject({
        method: "POST",
        url: "/api/catalog/sources",
        headers: { cookie: alice },
        payload: { schemaId: "cd-collab.source_create_request.v2", name: "nope" },
      });
      expect(unknownSchema.statusCode).toBe(403);
      const retireDenied = await app.inject({
        method: "POST",
        url: "/api/catalog/sources/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/retire",
        headers: { cookie: alice },
        payload: {
          schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
          sourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          expectedRevision: 1,
          idempotencyKey: "src-denied-retire",
        },
      });
      expect(retireDenied.statusCode).toBe(403);
      expect(retireDenied.body).not.toContain("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      expect(retireDenied.body).not.toContain("src-denied-retire");
      const restoreDenied = await app.inject({
        method: "POST",
        url: "/api/catalog/sources/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/restore",
        headers: { cookie: alice },
        payload: {
          schemaId: SOURCE_RESTORE_REQUEST_SCHEMA_ID,
          sourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          expectedRevision: 1,
          idempotencyKey: "src-denied-restore",
        },
      });
      expect(restoreDenied.statusCode).toBe(403);
      expect(restoreDenied.body).not.toContain("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      const restoreAudit = (await audit.list({ action: "catalog_restore" })).filter(
        (row) => row.outcome === "denied",
      );
      expect(restoreAudit).toHaveLength(1);
      expect(restoreAudit[0]?.target).toBe("forbidden");

      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/catalog/sources",
            headers: { cookie: dave },
            payload: createBody({ idempotencyKey: "src-admin-ok" }),
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/catalog/sources",
            headers: { cookie: lead },
            payload: createBody({ idempotencyKey: "src-lead-ok", name: "Lead tool" }),
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/catalog/sources",
            headers: { cookie: granted },
            payload: createBody({ idempotencyKey: "src-grant-ok", name: "Granted tool" }),
          })
        ).statusCode,
      ).toBe(201);

      const adminUnknown = await app.inject({
        method: "POST",
        url: "/api/catalog/sources",
        headers: { cookie: dave },
        payload: { schemaId: "cd-collab.source_create_request.v2", name: "nope" },
      });
      expect(adminUnknown.statusCode).toBe(400);
      expect(JSON.parse(adminUnknown.body)).toEqual({ error: "invalid" });
      const adminMalformed = await app.inject({
        method: "POST",
        url: "/api/catalog/sources",
        headers: { cookie: dave },
        payload: malformed,
      });
      expect(adminMalformed.statusCode).toBe(400);
      expect(JSON.parse(adminMalformed.body)).toEqual({ error: "invalid" });

      const carolProfile = await profiles.getById("uid=carol,ou=people,dc=example,dc=test");
      expect(carolProfile).not.toBeNull();
      await profiles.setStatus("uid=carol,ou=people,dc=example,dc=test", "suspended", carolProfile!.revision);
      const inactive = await app.inject({
        method: "POST",
        url: "/api/catalog/sources",
        headers: { cookie: carol },
        payload: createBody({ idempotencyKey: "src-inactive" }),
      });
      expect(inactive.statusCode).toBe(401);
      expect(inactive.body).not.toContain("src-inactive");
      expect(inactive.body).not.toContain("Web assistant");
    });
  });

  it("projects directory identities from strict mutation successes, replays, and refusals", async () => {
    await withMutationApp(async ({ app, catalog, grants }) => {
      const dave = await loginCookie(app, "dave", "fixture-dave-secret");
      const lead = await loginCookie(app, "lead", "fixture-lead-secret");
      const granted = await loginCookie(app, "granted", "fixture-granted-secret");
      await grants.grant(
        "uid=granted,ou=people,dc=example,dc=test",
        "catalog:write",
        "uid=dave,ou=people,dc=example,dc=test",
      );

      const leadIdentity = "uid=lead,ou=people,dc=example,dc=test";
      const createPayload = createBody({
        idempotencyKey: "src-projection-lead",
        name: "lead",
        kind: "human",
        identityId: leadIdentity,
      });
      const createdResponse = await app.inject({
        method: "POST",
        url: "/api/catalog/sources",
        headers: { cookie: lead },
        payload: createPayload,
      });
      expect(createdResponse.statusCode).toBe(201);
      expect(createdResponse.body).not.toContain("uid=");
      const created = parseSourceMutationSuccess(JSON.parse(createdResponse.body));
      expect(created.applied.identityId).toMatch(/^attr:[0-9a-f]{64}$/);
      expect(created.applied.createdBy).toMatch(/^attr:[0-9a-f]{64}$/);
      expect(created.applied.name).toBe(created.sourceId);

      const replayResponse = await app.inject({
        method: "POST",
        url: "/api/catalog/sources",
        headers: { cookie: lead },
        payload: createPayload,
      });
      expect(replayResponse.statusCode).toBe(200);
      expect(replayResponse.body).not.toContain("uid=");
      const replay = parseSourceMutationSuccess(JSON.parse(replayResponse.body));
      expect(replay.replayed).toBe(true);
      expect(replay.applied).toEqual(created.applied);

      const staleResponse = await app.inject({
        method: "POST",
        url: `/api/catalog/sources/${created.sourceId}/retire`,
        headers: { cookie: lead },
        payload: {
          schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
          sourceId: created.sourceId,
          expectedRevision: 9,
          idempotencyKey: "src-projection-stale",
        },
      });
      expect(staleResponse.statusCode).toBe(409);
      expect(staleResponse.body).not.toContain("uid=");
      const stale = parseSourceMutationRefused(JSON.parse(staleResponse.body));
      expect(stale.current?.identityId).toBe(created.applied.identityId);

      const collisionResponse = await app.inject({
        method: "POST",
        url: "/api/catalog/sources",
        headers: { cookie: granted },
        payload: createBody({
          idempotencyKey: "src-projection-collision",
          name: "Duplicate lead",
          kind: "human",
          identityId: leadIdentity,
        }),
      });
      expect(collisionResponse.statusCode).toBe(409);
      expect(collisionResponse.body).not.toContain("uid=");
      const collision = parseSourceMutationRefused(JSON.parse(collisionResponse.body));
      expect(collision.reason).toBe("identity_already_bound");
      expect(collision.current?.identityId).toBe(created.applied.identityId);

      const retiredResponse = await app.inject({
        method: "POST",
        url: `/api/catalog/sources/${created.sourceId}/retire`,
        headers: { cookie: lead },
        payload: {
          schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
          sourceId: created.sourceId,
          expectedRevision: 1,
          idempotencyKey: "src-projection-retire",
        },
      });
      expect(retiredResponse.statusCode).toBe(200);
      expect(retiredResponse.body).not.toContain("uid=");
      const retired = parseSourceMutationSuccess(JSON.parse(retiredResponse.body));
      expect(retired.applied.identityId).toBe(created.applied.identityId);

      const restoredResponse = await app.inject({
        method: "POST",
        url: `/api/catalog/sources/${created.sourceId}/restore`,
        headers: { cookie: lead },
        payload: {
          schemaId: SOURCE_RESTORE_REQUEST_SCHEMA_ID,
          sourceId: created.sourceId,
          expectedRevision: 2,
          idempotencyKey: "src-projection-restore",
        },
      });
      expect(restoredResponse.statusCode).toBe(200);
      expect(restoredResponse.body).not.toContain("uid=");
      const restored = parseSourceMutationSuccess(JSON.parse(restoredResponse.body));
      expect(restored.applied.identityId).toBe(created.applied.identityId);

      const stored = (await catalog.list()).find((source) => source.id === created.sourceId);
      expect(stored?.identityId).toBe(leadIdentity);
      expect(stored?.createdBy).toBe(leadIdentity);
      expect(stored?.name).toBe("lead");

      const adminIdentity = "uid=dave,ou=people,dc=example,dc=test";
      const adminResponse = await app.inject({
        method: "POST",
        url: "/api/catalog/sources",
        headers: { cookie: dave },
        payload: createBody({
          idempotencyKey: "src-projection-admin",
          name: "dave",
          kind: "human",
          identityId: adminIdentity,
        }),
      });
      expect(adminResponse.statusCode).toBe(201);
      const adminCreated = parseSourceMutationSuccess(JSON.parse(adminResponse.body));
      expect(adminCreated.applied.identityId).toMatch(/^usr-[a-f0-9]{32}$/);
      expect(adminCreated.applied.createdBy).toBe(adminCreated.applied.identityId);
      expect(adminCreated.applied.name).toBe("dave");
    });
  });

  it("retires and restores with CAS and every contract refusal", async () => {
    await withMutationApp(async ({ app, catalog }) => {
      const dave = await loginCookie(app, "dave", "fixture-dave-secret");
      const created = parseSourceMutationSuccess(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: "/api/catalog/sources",
              headers: { cookie: dave },
              payload: createBody({ idempotencyKey: "src-cas-create" }),
            })
          ).body,
        ),
      );
      const missing = await app.inject({
        method: "POST",
        url: "/api/catalog/sources/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/retire",
        headers: { cookie: dave },
        payload: {
          schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
          sourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          expectedRevision: 1,
          idempotencyKey: "src-cas-missing",
        },
      });
      expect(missing.statusCode).toBe(409);
      expect(parseSourceMutationRefused(JSON.parse(missing.body)).reason).toBe("source_not_found");

      const unknown = await app.inject({
        method: "POST",
        url: `/api/catalog/sources/${PERMANENT_UNKNOWN_SOURCE_ID}/retire`,
        headers: { cookie: dave },
        payload: {
          schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
          sourceId: PERMANENT_UNKNOWN_SOURCE_ID,
          expectedRevision: 1,
          idempotencyKey: "src-cas-unknown",
        },
      });
      expect(unknown.statusCode).toBe(409);
      expect(parseSourceMutationRefused(JSON.parse(unknown.body)).reason).toBe(
        "permanent_unknown_protected",
      );

      const stale = await app.inject({
        method: "POST",
        url: `/api/catalog/sources/${created.sourceId}/retire`,
        headers: { cookie: dave },
        payload: {
          schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
          sourceId: created.sourceId,
          expectedRevision: 9,
          idempotencyKey: "src-cas-stale",
        },
      });
      expect(stale.statusCode).toBe(409);
      expect(parseSourceMutationRefused(JSON.parse(stale.body)).reason).toBe(
        "expected_revision_mismatch",
      );

      const mismatchedId = await app.inject({
        method: "POST",
        url: `/api/catalog/sources/${created.sourceId}/retire`,
        headers: { cookie: dave },
        payload: {
          schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
          sourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          expectedRevision: 1,
          idempotencyKey: "src-cas-id-mismatch",
        },
      });
      expect(mismatchedId.statusCode).toBe(400);

      const retired = parseSourceMutationSuccess(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/catalog/sources/${created.sourceId}/retire`,
              headers: { cookie: dave },
              payload: {
                schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
                sourceId: created.sourceId,
                expectedRevision: 1,
                idempotencyKey: "src-cas-retire",
              },
            })
          ).body,
        ),
      );
      expect(retired.applied.lifecycle).toBe("retired");
      expect(retired.appliedRevision).toBe(2);
      expect(retired.applied.kind).toBe("external-tool");
      expect(retired.applied.createdBy).toBe(created.applied.createdBy);

      const already = await app.inject({
        method: "POST",
        url: `/api/catalog/sources/${created.sourceId}/retire`,
        headers: { cookie: dave },
        payload: {
          schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
          sourceId: created.sourceId,
          expectedRevision: 2,
          idempotencyKey: "src-cas-already",
        },
      });
      expect(already.statusCode).toBe(409);
      expect(parseSourceMutationRefused(JSON.parse(already.body)).reason).toBe("already_retired");

      const restored = parseSourceMutationSuccess(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/catalog/sources/${created.sourceId}/restore`,
              headers: { cookie: dave },
              payload: {
                schemaId: SOURCE_RESTORE_REQUEST_SCHEMA_ID,
                sourceId: created.sourceId,
                expectedRevision: 2,
                idempotencyKey: "src-cas-restore",
              },
            })
          ).body,
        ),
      );
      expect(restored.applied.lifecycle).toBe("active");
      expect(restored.appliedRevision).toBe(3);

      const notRetired = await app.inject({
        method: "POST",
        url: `/api/catalog/sources/${created.sourceId}/restore`,
        headers: { cookie: dave },
        payload: {
          schemaId: SOURCE_RESTORE_REQUEST_SCHEMA_ID,
          sourceId: created.sourceId,
          expectedRevision: 3,
          idempotencyKey: "src-cas-not-retired",
        },
      });
      expect(notRetired.statusCode).toBe(409);
      expect(parseSourceMutationRefused(JSON.parse(notRetired.body)).reason).toBe("not_retired");

      const legacy = await catalog.create(
        { id: "uid=dave,ou=people,dc=example,dc=test", username: "dave" },
        { name: "legacy-mailer", kind: "internal-system" },
        "test",
      );
      expect(legacy).not.toHaveProperty("revision");
      const unavailable = await app.inject({
        method: "POST",
        url: `/api/catalog/sources/${legacy.id}/retire`,
        headers: { cookie: dave },
        payload: {
          schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
          sourceId: legacy.id,
          expectedRevision: 1,
          idempotencyKey: "src-cas-unversioned",
        },
      });
      expect(unavailable.statusCode).toBe(409);
      expect(parseSourceMutationRefused(JSON.parse(unavailable.body)).reason).toBe(
        "source_revision_unavailable",
      );
    });
  });

  it("preserves legacy create/retire/update only for unversioned rows", async () => {
    await withMutationApp(async ({ app }) => {
      const dave = await loginCookie(app, "dave", "fixture-dave-secret");
      const legacy = parseSource(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: "/api/catalog/sources",
              headers: { cookie: dave },
              payload: { name: "legacy-ui", kind: "internal-system" },
            })
          ).body,
        ),
      );
      expect(legacy).not.toHaveProperty("revision");
      const renamed = parseSource(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/catalog/sources/${legacy.id}`,
              headers: { cookie: dave },
              payload: { name: "legacy-ui-renamed" },
            })
          ).body,
        ),
      );
      expect(renamed.name).toBe("legacy-ui-renamed");
      expect(renamed).not.toHaveProperty("revision");
      const retired = parseSource(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: `/api/catalog/sources/${legacy.id}/retire`,
              headers: { cookie: dave },
            })
          ).body,
        ),
      );
      expect(retired.lifecycle).toBe("retired");

      const versioned = parseSourceMutationSuccess(
        JSON.parse(
          (
            await app.inject({
              method: "POST",
              url: "/api/catalog/sources",
              headers: { cookie: dave },
              payload: createBody({ idempotencyKey: "src-legacy-bypass", name: "strict-row" }),
            })
          ).body,
        ),
      );
      const bypassUpdate = await app.inject({
        method: "POST",
        url: `/api/catalog/sources/${versioned.sourceId}`,
        headers: { cookie: dave },
        payload: { name: "should-not-rename" },
      });
      expect(bypassUpdate.statusCode).toBe(409);
      expect(JSON.parse(bypassUpdate.body)).toEqual({ error: "versioned_source" });
      const bypassRetire = await app.inject({
        method: "POST",
        url: `/api/catalog/sources/${versioned.sourceId}/retire`,
        headers: { cookie: dave },
      });
      expect(bypassRetire.statusCode).toBe(409);
      expect(JSON.parse(bypassRetire.body)).toEqual({ error: "versioned_source" });
      expect((await app.inject({
        method: "GET",
        url: "/api/catalog/sources",
        headers: { cookie: dave },
      })).body).toContain("strict-row");

      const unknownUpdate = await app.inject({
        method: "POST",
        url: `/api/catalog/sources/${PERMANENT_UNKNOWN_SOURCE_ID}`,
        headers: { cookie: dave },
        payload: { name: "should-not-rename-unknown" },
      });
      expect(unknownUpdate.statusCode).toBe(409);
      expect(JSON.parse(unknownUpdate.body)).toEqual({ error: "permanent_unknown_protected" });
      const unknownRetire = await app.inject({
        method: "POST",
        url: `/api/catalog/sources/${PERMANENT_UNKNOWN_SOURCE_ID}/retire`,
        headers: { cookie: dave },
      });
      expect(unknownRetire.statusCode).toBe(409);
      expect(JSON.parse(unknownRetire.body)).toEqual({ error: "permanent_unknown_protected" });
    });
  });

  it("maps unexpected store errors to sanitized HTTP 500 and unknown COMMIT to 503", async () => {
    const boom = new MemoryCatalogStore();
    boom.insert = async () => {
      throw new Error("injected catalog store failure");
    };
    await withMutationApp(async ({ app }) => {
      const dave = await loginCookie(app, "dave", "fixture-dave-secret");
      const failed = await app.inject({
        method: "POST",
        url: "/api/catalog/sources",
        headers: { cookie: dave },
        payload: createBody({ idempotencyKey: "src-internal-500" }),
      });
      expect(failed.statusCode).toBe(500);
      expect(JSON.parse(failed.body)).toEqual({ error: "internal" });
      expect(failed.body).not.toContain("injected catalog store failure");
    }, boom);

    const unknown = new MemoryCatalogStore();
    unknown.withAtomic = async () => {
      throw new CatalogCommitOutcomeUnknownError();
    };
    await withMutationApp(async ({ app }) => {
      const dave = await loginCookie(app, "dave", "fixture-dave-secret");
      const response = await app.inject({
        method: "POST",
        url: "/api/catalog/sources",
        headers: { cookie: dave },
        payload: createBody({ idempotencyKey: "src-unknown-503" }),
      });
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body)).toEqual({ error: "commit_outcome_unknown" });
      expect(response.body).not.toContain("catalog transaction commit");
    }, unknown);
  });
});

describe("source catalog store CAS", () => {
  it("fails closed before a strict mutation when no audit store is configured", async () => {
    const store = new MemoryCatalogStore();
    const catalog = new CatalogService(store);

    await expect(
      catalog.applyCreate(
        { id: "alice", username: "alice" },
        {
          schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
          name: "Unaudited",
          kind: "external-tool",
          description: null,
          identityId: null,
          expectedRevision: 0,
          idempotencyKey: "src-no-audit-1",
        },
        "test",
      ),
    ).rejects.toThrow(/requires an audit store/);
    expect((await store.list()).some((source) => source.name === "Unaudited")).toBe(false);
    expect(await store.getSuccessIntent("alice", "src-no-audit-1")).toBeNull();
  });

  it("enforces non-null identity uniqueness and concurrent same-key replay", async () => {
    const audit = new MemoryAuditStore();
    const catalog = new CatalogService(undefined, audit);
    const actor = { id: "alice", username: "alice" };
    const request = {
      schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
      name: "Bound human",
      kind: "human" as const,
      description: null,
      identityId: "alice",
      expectedRevision: 0 as const,
      idempotencyKey: "src-identity-1",
    };
    const first = await catalog.applyCreate(actor, request, "test");
    expect(first.applied.revision).toBe(1);
    await expect(
      catalog.applyCreate(actor, { ...request, idempotencyKey: "src-identity-2" }, "test"),
    ).rejects.toBeInstanceOf(CatalogMutationRefusedError);
    try {
      await catalog.applyCreate(actor, { ...request, idempotencyKey: "src-identity-2" }, "test");
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogMutationRefusedError);
      expect((error as CatalogMutationRefusedError).body.reason).toBe("identity_already_bound");
      expect((error as CatalogMutationRefusedError).body.current?.id).toBe(first.sourceId);
    }

    const [left, right] = await Promise.all([
      catalog.applyCreate(actor, { ...request, identityId: null, name: "Concurrent", idempotencyKey: "src-same-key" }, "test"),
      catalog.applyCreate(actor, { ...request, identityId: null, name: "Concurrent", idempotencyKey: "src-same-key" }, "test"),
    ]);
    const replayed = [left, right].filter((row) => row.replayed);
    const applied = [left, right].filter((row) => !row.replayed);
    expect(applied).toHaveLength(1);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.sourceId).toBe(applied[0]?.sourceId);
    expect((await catalog.list()).filter((source) => source.name === "Concurrent")).toHaveLength(1);
    expect((await audit.list({ action: "catalog_create" })).filter((row) => row.target === applied[0]?.sourceId)).toHaveLength(1);
  });

  it("rolls catalog state and audit back on pre-commit failure", async () => {
    const audit = new MemoryAuditStore();
    const store = new MemoryCatalogStore();
    store.insertSuccessIntent = async () => {
      throw new Error("injected intent failure");
    };
    const catalog = new CatalogService(store, audit);
    await expect(
      catalog.applyCreate(
        { id: "alice", username: "alice" },
        {
          schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
          name: "Boom",
          kind: "external-tool",
          description: null,
          identityId: null,
          expectedRevision: 0,
          idempotencyKey: "src-rollback-1",
        },
        "test",
      ),
    ).rejects.toThrow(/injected intent failure/);
    expect((await catalog.list()).some((source) => source.name === "Boom")).toBe(false);
    expect(await store.getSuccessIntent("alice", "src-rollback-1")).toBeNull();
    expect(await audit.list({ action: "catalog_create" })).toEqual([]);
  });

  it("refuses legacy mutation of a versioned row at the service boundary", async () => {
    const catalog = new CatalogService(undefined, new MemoryAuditStore());
    const actor = { id: "alice", username: "alice" };
    const created = await catalog.applyCreate(
      actor,
      {
        schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
        name: "Versioned",
        kind: "external-tool",
        description: null,
        identityId: null,
        expectedRevision: 0,
        idempotencyKey: "src-versioned-legacy",
      },
      "test",
    );
    await expect(catalog.update(actor, created.sourceId, { name: "Nope" }, "test")).rejects.toBeInstanceOf(
      CatalogVersionedSourceError,
    );
    await expect(catalog.retire(actor, created.sourceId, "test")).rejects.toBeInstanceOf(
      CatalogVersionedSourceError,
    );
    await expect(
      catalog.update(actor, PERMANENT_UNKNOWN_SOURCE_ID, { name: "Nope" }, "test"),
    ).rejects.toBeInstanceOf(CatalogPermanentUnknownError);
    await expect(catalog.retire(actor, PERMANENT_UNKNOWN_SOURCE_ID, "test")).rejects.toBeInstanceOf(
      CatalogPermanentUnknownError,
    );
  });

  it("mints a locked attribution source through the catalog mutex", async () => {
    const catalog = new CatalogService(undefined, new MemoryAuditStore());
    const created = await catalog.applyCreate(
      { id: "alice", username: "alice" },
      {
        schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
        name: "Importer",
        kind: "external-tool",
        description: null,
        identityId: null,
        expectedRevision: 0,
        idempotencyKey: "src-lock-attr",
      },
      "test",
    );
    const locked = await catalog.lockSourceForAttribution(created.sourceId, async (source) => source);
    expect(locked.id).toBe(created.sourceId);
    expect(locked.lifecycle).toBe("active");
    await catalog.applyRetire(
      { id: "alice", username: "alice" },
      {
        schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
        sourceId: created.sourceId,
        expectedRevision: 1,
        idempotencyKey: "src-lock-retire",
      },
      "test",
    );
    await expect(
      catalog.lockSourceForAttribution(created.sourceId, async (source) => source),
    ).rejects.toThrow(/retired/);
  });

  it("fails closed on a corrupt or incoherent stored success intent instead of replaying it", async () => {
    const store = new MemoryCatalogStore();
    const catalog = new CatalogService(store, new MemoryAuditStore());
    const actor = { id: "alice", username: "alice" };
    const request = {
      schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
      name: "Corruptible",
      kind: "external-tool" as const,
      description: null,
      identityId: null,
      expectedRevision: 0 as const,
      idempotencyKey: "src-corrupt-intent",
    };
    const created = await catalog.applyCreate(actor, request, "test");
    const snapshot = store.capture() as {
      rows: [string, unknown][];
      intents: [string, { successJson: string; action: string; sourceId: string }][];
    };
    snapshot.intents[0]![1]!.successJson = "{}";
    store.restore(snapshot);
    await expect(catalog.applyCreate(actor, request, "test")).rejects.toThrow(
      /source catalog success intent is corrupt/,
    );

    snapshot.intents[0]![1]!.successJson = JSON.stringify({
      schemaId: "cd-collab.source_mutation_success.v1",
      action: "retire",
      sourceId: created.sourceId,
      expectedRevision: 1,
      previousRevision: 1,
      appliedRevision: 2,
      replayed: false,
      applied: { ...created.applied, lifecycle: "retired", revision: 2 },
    });
    store.restore(snapshot);
    await expect(catalog.applyCreate(actor, request, "test")).rejects.toThrow(
      /source catalog success intent is incoherent/,
    );
  });

  it("translates in-memory duplicate identity inserts to a typed error", async () => {
    const store = new MemoryCatalogStore();
    await store.insert({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Alice",
      kind: "human",
      description: null,
      lifecycle: "active",
      identityId: "alice",
      createdAt: "2026-09-05T00:00:00.000Z",
      createdBy: "alice",
      revision: 1,
    });
    await expect(
      store.insert({
        id: "22222222-2222-4222-8222-222222222222",
        name: "Also Alice",
        kind: "human",
        description: null,
        lifecycle: "active",
        identityId: "alice",
        createdAt: "2026-09-05T00:00:00.000Z",
        createdBy: "bob",
        revision: 1,
      }),
    ).rejects.toBeInstanceOf(CatalogIdentityBoundError);
  });

  it("refuses legacy store mutation of versioned and permanent unknown rows", async () => {
    const store = new MemoryCatalogStore();
    await store.insert({
      id: "33333333-3333-4333-8333-333333333333",
      name: "Versioned",
      kind: "external-tool",
      description: null,
      lifecycle: "active",
      identityId: null,
      createdAt: "2026-09-05T00:00:00.000Z",
      createdBy: "alice",
      revision: 1,
    });
    await expect(
      store.updateMeta("33333333-3333-4333-8333-333333333333", { name: "Nope", description: null }),
    ).rejects.toThrow("versioned_source");
    await expect(store.setLifecycle("33333333-3333-4333-8333-333333333333", "retired")).rejects.toThrow(
      "versioned_source",
    );
    await expect(
      store.updateMeta(PERMANENT_UNKNOWN_SOURCE_ID, { name: "Nope", description: null }),
    ).rejects.toThrow("permanent_unknown_protected");
    await expect(store.setLifecycle(PERMANENT_UNKNOWN_SOURCE_ID, "retired")).rejects.toThrow(
      "permanent_unknown_protected",
    );
  });
});
